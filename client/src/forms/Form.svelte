<!--
  Form — establishes a data environment for descendant controls.

  Usage:
    <Form
      spec="activity_sink.set"
      initial={{ sinkKind: 'msgraph_teams' }}
      onSaved={(out) => refresh()}
    >
      <TextInput path="name" />
      <TextInput path="msgraphTenantId" />
      <PasswordInput path="msgraphClientSecret" />
      <Textarea path="activityFilter" />
      <SubmitButton>Save</SubmitButton>
    </Form>

  What it owns:
    - A reactive draft (Svelte $state proxy), seeded from `initial`
      plus schema-derived defaults for required fields.
    - Per-field errors map and a form-level error string.
    - dirty + submitting flags.
    - submit(): validates draft against the schema; on clean,
      dispatches via the registered HandlerSpec; on server error,
      captures HandlerError into `formError` (or per-field errors
      when the server returns a structured field error).

  Children never see events. Controls read draft via getFormContext()
  and write back through ctx.set(path, value).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { getDispatcher } from '../dispatch/context';
  import { SubRequestError } from '../dispatch/errors';
  import { schemaStore } from '../schema/store.svelte';
  import { validateDraft } from './validate';
  import { setFormContext, walkSchema, type FormContext } from './context';
  import { registerForm, unregisterForm } from './registry.svelte';

  interface Props {
    /** "endpoint.action" — looked up in schemaStore + dispatcher. */
    spec: string;
    /** Partial initial draft. Schema defaults fill in the rest. */
    initial?: Record<string, unknown>;
    /** Called with the decoded handler output on a successful submit. */
    onSaved?: (out: unknown) => void;
    /** Called when the user explicitly cancels — Form doesn't render
     *  a cancel button itself; SubmitButton has a sibling, or callers
     *  can wire one in their layout. */
    onCancelled?: () => void;
    /**
     * Pre-submit transform. Runs after validation, before dispatch.
     * Use when the wire payload needs values shaped differently from
     * how controls bind them — classic case is "password '' → null"
     * so an empty password field preserves the stored secret instead
     * of overwriting it. Receives a shallow-copied draft; mutate in
     * place or return a new object.
     */
    transform?: (draft: Record<string, unknown>) => Record<string, unknown>;
    /**
     * Partial mode. When true, the kernel only seeds the REQUIRED
     * fields into the draft — optional fields stay absent until the
     * user (or `initial`) populates them. The wire payload then omits
     * untouched optional fields, letting the server's `omitempty`
     * rules apply ("undefined = keep stored value" semantics common
     * to update endpoints).
     */
    partial?: boolean;
    /**
     * Optional id for cross-DOM SubmitButton placement. When set, the
     * form registers itself in a process-local map; <SubmitButton
     * formId="x"> can then trigger this form's submit even when the
     * button is rendered in a sibling DOM subtree (e.g. a Modal's
     * footer snippet outside the form's children).
     */
    id?: string;
    /** Outer wrapper class. */
    class?: string;
    children: Snippet;
  }

  let {
    spec,
    initial = {},
    onSaved,
    onCancelled,
    transform,
    partial = false,
    id,
    class: klass,
    children,
  }: Props = $props();

  const dispatcher = getDispatcher();

  // Parse "endpoint.action". The split is greedy on the LAST dot so
  // endpoints with dots in them (none today, but harmless) work.
  // Derived so `spec` swaps re-resolve cleanly — though a swap is
  // rare and would also reset the draft (intentionally).
  const endpoint = $derived.by(() => {
    const i = spec.lastIndexOf('.');
    return i > 0 ? spec.slice(0, i) : spec;
  });
  const action = $derived.by(() => {
    const i = spec.lastIndexOf('.');
    return i > 0 ? spec.slice(i + 1) : '';
  });

  // Resolve schema lazily on each render so a late-arriving catalogue
  // load (the rare race where a Form mounts before main.ts's await
  // resolves) becomes available without remounting.
  const schema = $derived(schemaStore.inputSchema(endpoint, action));

  // Build the draft ONCE at mount — re-renders shouldn't reset user
  // input. The Svelte warning about referencing `initial` once is the
  // intent here; seeding from the prop is a deliberate one-shot.
  // svelte-ignore state_referenced_locally
  const draft = $state<Record<string, unknown>>(buildInitialDraft(initial, endpoint, action));

  function buildInitialDraft(
    seed: Record<string, unknown>,
    ep: string,
    ac: string,
  ): Record<string, unknown> {
    const d: Record<string, unknown> = { ...seed };
    const s = schemaStore.inputSchema(ep, ac);
    if (s?.properties) {
      // In partial mode we only seed REQUIRED fields. Optional fields
      // stay absent so the wire payload omits them — matches the
      // server's `omitempty` "undefined = keep stored value" rule.
      const requiredKeys = partial ? new Set(s.required ?? []) : null;
      for (const [key, propSchema] of Object.entries(s.properties)) {
        if (d[key] !== undefined) continue;
        if (requiredKeys && !requiredKeys.has(key)) continue;
        d[key] = defaultFor(propSchema.type);
      }
    }
    return d;
  }

  function defaultFor(type: string | undefined): unknown {
    switch (type) {
      case 'string': return '';
      case 'integer':
      case 'number': return 0;
      case 'boolean': return false;
      case 'array': return [];
      case 'object': return {};
      default: return undefined;
    }
  }

  let errors = $state<Record<string, string>>({});
  let formError = $state<string | null>(null);
  let dirty = $state(false);
  let submitting = $state(false);

  // Walk a dotted path into the draft. "foo" stays flat (the common
  // case); "resolution.persons" navigates into nested objects. Used
  // by controls bound to nested handler-input shapes (ImportWizard's
  // resolution step is the motivating case).
  function walk(obj: Record<string, unknown>, segments: string[]): Record<string, unknown> | undefined {
    let cur: unknown = obj;
    for (const seg of segments) {
      if (cur === undefined || cur === null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
    return (cur as Record<string, unknown>) ?? undefined;
  }

  function get(path: string): unknown {
    if (!path.includes('.')) return draft[path];
    const segs = path.split('.');
    const leaf = segs.pop()!;
    const parent = walk(draft, segs);
    return parent?.[leaf];
  }

  function set(path: string, value: unknown): void {
    if (!path.includes('.')) {
      draft[path] = value;
    } else {
      const segs = path.split('.');
      const leaf = segs.pop()!;
      // Walk-and-create intermediate objects so a brand-new nested
      // path (resolution.persons when resolution isn't seeded) lands
      // cleanly without callers pre-populating shells.
      let cur: Record<string, unknown> = draft;
      for (const seg of segs) {
        if (typeof cur[seg] !== 'object' || cur[seg] === null) cur[seg] = {};
        cur = cur[seg] as Record<string, unknown>;
      }
      cur[leaf] = value;
    }
    dirty = true;
    // Clear the per-field error as soon as the user edits — the next
    // submit re-validates from scratch, so stale errors only confuse.
    if (errors[path] !== undefined) {
      const next = { ...errors };
      delete next[path];
      errors = next;
    }
    if (formError !== null) formError = null;
  }

  function setError(path: string, msg: string | null): void {
    const next = { ...errors };
    if (msg === null) delete next[path];
    else next[path] = msg;
    errors = next;
  }

  async function submit(): Promise<void> {
    if (submitting) return;
    formError = null;
    const validation = validateDraft(schema, draft);
    if (Object.keys(validation).length > 0) {
      errors = validation;
      return;
    }
    errors = {};
    submitting = true;
    try {
      // requestRaw bypasses the HandlerRegistry's encode step — the
      // draft is already in wire shape (snake_case keys matching the
      // schema). bigint fields are serialised via the dispatcher's
      // standard JSON.stringify replacer.
      const payload = transform ? transform({ ...draft }) : draft;
      const out = await dispatcher.requestRaw({
        endpoint,
        action,
        data: payload,
      });
      onSaved?.(out);
    } catch (e) {
      // Try to route HandlerError code into a per-field error when
      // possible (the server's HandlerError carries a Code but not a
      // field path; for now we surface as form-level error and let
      // the screen author add field-specific routing as needed).
      if (e instanceof SubRequestError) {
        formError = e.message || e.code;
      } else {
        formError = e instanceof Error ? e.message : String(e);
      }
    } finally {
      submitting = false;
    }
  }

  // Build a stable context value once. The properties it exposes
  // (draft, errors, etc.) are themselves $state, so descendants
  // re-render when those change without the ctx object being
  // re-created. endpoint/action expose getters so a `spec` swap
  // reflects without recreating context.
  const ctx: FormContext = {
    get endpoint() { return endpoint; },
    get action() { return action; },
    get schema() { return schema; },
    draft,
    get errors() { return errors; },
    get formError() { return formError; },
    get dirty() { return dirty; },
    get submitting() { return submitting; },
    submit,
    setError,
    get,
    set,
    fieldSchema: (path: string) => walkSchema(schema, path),
    isRequired: (path: string) => {
      // Walk to the parent schema and ask if `leaf` is in its required.
      if (!path.includes('.')) return schema?.required?.includes(path) ?? false;
      const segs = path.split('.');
      const leaf = segs.pop()!;
      const parent = walkSchema(schema, segs.join('.'));
      return parent?.required?.includes(leaf) ?? false;
    },
  };

  setFormContext(ctx);

  // Cross-DOM submit registration. When the form opts into an `id`,
  // expose itself in the registry so a SubmitButton outside the
  // children tree can find it; clean up on unmount.
  $effect(() => {
    if (id) {
      registerForm(id, ctx);
      return () => unregisterForm(id);
    }
    return undefined;
  });

  // Expose for callers that need to call cancel from outside (e.g.
  // a SlideOver close button) without binding to internal state.
  export function cancel(): void {
    onCancelled?.();
  }
</script>

<div class={klass} data-form-spec={spec}>
  {@render children()}
</div>
