<script lang="ts">
  /**
   * Right-rail attribute editor for the task-detail screen.
   *
   * Renders one collapsible `<details>` per attribute in `schema`. Each
   * section shows the current resolved value and a `<ValueInput>` for
   * editing. On commit we dispatch `attribute.update` ourselves and notify
   * the parent via `onChanged`; failures surface inline next to the input.
   *
   * Reference attributes (`ref:<card_type>`) and enums let the caller
   * pre-resolve options via `refOptions[attr.name]`. Without resolved
   * options the Combobox renders an empty list and the user can still
   * clear the value, but cannot pick a new one — same posture as the
   * Dart side panel.
   */

  import { tick } from 'svelte';
  import ValueInput from '../../filter/ValueInput.svelte';
  import type { FilterAttribute } from '../../filter/attribute_schema.svelte.js';
  import { getDispatcher } from '../../dispatch/context.js';
  import { attributeUpdate } from '../../reg/handlers.js';
  import type { ID } from '../../reg/types.js';
  import { cx } from '../../util/class_names.js';

  interface Props {
    cardId: ID;
    /** Current attribute values keyed by attribute name. */
    attributes: Record<string, unknown>;
    /** Filterable / editable attribute schema (driven by attribute_def.select). */
    schema: FilterAttribute[];
    /** Pre-resolved options for ref / enum attrs — keyed by attribute name.
     *  When a ref attribute also has a `refLoader`, these entries still drive
     *  the trigger button's label rendering for the currently-set value
     *  (the loader handles the dropdown's option list separately). */
    refOptions?: Record<string, { value: unknown; label: string }[]>;
    /**
     * Async option loaders for ref:* attributes — keyed by attribute name.
     * When set, the Combobox switches to async mode: it consults the loader
     * on open and per keystroke instead of using a preloaded list. Use this
     * for ref types whose card_type may have too many cards to preload (and
     * for any custom `ref:<card_type>` the screen doesn't otherwise know
     * how to populate up front).
     */
    refLoaders?: Record<string, (query: string) => Promise<{ value: unknown; label: string }[]>>;
    /** Called after a successful attribute.update commit. */
    onChanged?: (attrName: string, newValue: unknown) => void;
    class?: string;
  }

  let {
    cardId,
    attributes,
    schema,
    refOptions,
    refLoaders,
    onChanged,
    class: klass = '',
  }: Props = $props();

  const dispatcher = getDispatcher();

  /** Per-attribute pending state (true while the request is in flight). */
  let pending = $state<Record<string, boolean>>({});
  /** Per-attribute error message (cleared on successful commit). */
  let errors = $state<Record<string, string>>({});
  /**
   * Per-attribute in-flight draft. ValueInput's text/number variants emit on
   * every keystroke; we hold the latest value here and only commit on blur or
   * Enter so we don't fire one attribute.update per keystroke. Combobox / date /
   * bool variants commit eagerly because their change events are coarse-grained.
   */
  let drafts = $state<Record<string, unknown>>({});

  /** Returns true when the attribute commits eagerly on any value change. */
  function isInstantCommitType(attr: FilterAttribute): boolean {
    const t = attr.valueType;
    return t.startsWith('ref:') || t === 'bool' || t === 'date';
  }

  /** Returns true when the editor is a Combobox dropdown we can auto-open. */
  function isComboboxType(attr: FilterAttribute): boolean {
    return attr.valueType.startsWith('ref:');
  }

  /** Returns true for editor types whose primary affordance is a popover
   *  the user expects to see on first click of the row. Drives the
   *  auto-click in `toggleRow` so the user doesn't need to click twice
   *  (once to expand the row, once to open the picker). */
  function isPopoverType(attr: FilterAttribute): boolean {
    return isComboboxType(attr) || attr.valueType === 'date';
  }

  /**
   * Resolve a value to a printed label. Uses `refOptions` when the attribute
   * is an enum or `ref:*` so the panel shows "alice" rather than "2".
   */
  function displayValue(attr: FilterAttribute, v: unknown): string {
    if (v === null || v === undefined) return '—';
    const opts = (refOptions ?? {})[attr.name] ?? attr.options ?? [];
    if (Array.isArray(v)) {
      if (v.length === 0) return '—';
      return v
        .map((vv) => {
          const f = opts.find((o) => o.value === vv);
          return f?.label ?? String(vv);
        })
        .join(', ');
    }
    const f = opts.find((o) => o.value === v);
    if (f !== undefined) return f.label;
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return String(v);
  }

  /**
   * Build a per-section FilterAttribute view that injects `refOptions[name]`
   * (when present) into the attribute's option list, so ValueInput renders a
   * useful Combobox without us having to fork that component.
   */
  function attributeFor(attr: FilterAttribute): FilterAttribute {
    const injected = (refOptions ?? {})[attr.name];
    if (injected !== undefined && injected.length > 0) {
      return { ...attr, options: injected };
    }
    return attr;
  }

  async function commit(attr: FilterAttribute, newValue: unknown): Promise<void> {
    const name = attr.name;
    pending = { ...pending, [name]: true };
    // Clear any previous error on retry.
    {
      const next = { ...errors };
      delete next[name];
      errors = next;
    }
    try {
      await dispatcher.request({
        endpoint: attributeUpdate.endpoint,
        action: attributeUpdate.action,
        data: { cardId, attributeName: name, value: newValue },
      });
      onChanged?.(name, newValue);
      // Collapse the inline editor on a successful commit so the side rail
      // returns to its compact summary state. We let the parent commit run
      // first (so the saved-toast lands while the row is still highlighted)
      // before clearing the open flag.
      const next = { ...openRows };
      delete next[name];
      openRows = next;
      // Clear the buffered draft now that the canonical value flowed back
      // through the parent's `attributes` prop.
      if (drafts[name] !== undefined) {
        const nd = { ...drafts };
        delete nd[name];
        drafts = nd;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors = { ...errors, [name]: msg };
    } finally {
      const nextPending = { ...pending };
      delete nextPending[name];
      pending = nextPending;
    }
  }

  /**
   * Per-attribute "is the editor row expanded" map. We drive the
   * `<details>` element's `open` attribute from this state so we can collapse
   * a row programmatically after a successful commit (the native `open`
   * attribute alone is user-only).
   */
  let openRows = $state<Record<string, boolean>>({});

  async function toggleRow(
    name: string,
    nextOpen: boolean,
    detailsEl: HTMLDetailsElement,
    attr: FilterAttribute,
  ) {
    if (nextOpen) {
      openRows = { ...openRows, [name]: true };
      // Auto-pop the popover for picker-style attributes (Combobox /
      // DatePicker) so a single click on the row reveals the picker —
      // no second click on the trigger needed. Combobox triggers carry
      // `role="combobox"`; DatePicker triggers carry
      // `aria-haspopup="dialog"`.
      if (isPopoverType(attr)) {
        await tick();
        const trigger = detailsEl.querySelector<HTMLButtonElement>(
          'button[role="combobox"], button[aria-haspopup="dialog"]',
        );
        trigger?.click();
      }
    } else {
      const next = { ...openRows };
      delete next[name];
      openRows = next;
    }
  }
</script>

<aside
  class={cx(
    'flex w-full flex-col border border-section bg-bg',
    klass,
  )}
  aria-label="Attributes"
>
  <h2
    class="border-b border-fg/40 bg-surface/40 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg"
  >
    Attributes
  </h2>
  {#if schema.length === 0}
    <p class="px-2 py-1.5 text-xs text-muted">No attributes available.</p>
  {/if}
  <div class="divide-y divide-fg/15">
    {#each schema as attr (attr.name)}
      {@const value = attributes[attr.name]}
      {@const summary = displayValue(attr, value)}
      {@const isPending = pending[attr.name] === true}
      {@const error = errors[attr.name]}
      {@const isOpen = openRows[attr.name] === true}
      {@const draftValue = drafts[attr.name] !== undefined ? drafts[attr.name] : value}
      {@const instant = isInstantCommitType(attr)}
      <details
        class="group"
        open={isOpen}
        ontoggle={(e) => {
          const el = e.currentTarget as HTMLDetailsElement;
          void toggleRow(attr.name, el.open, el, attr);
        }}
      >
        <summary
          class={cx(
            'flex cursor-pointer items-center justify-between gap-2 px-2 py-1 text-sm',
            'hover:bg-surface/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent',
          )}
        >
          <span class="flex min-w-0 flex-1 items-baseline gap-2">
            <span class="w-24 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted">{attr.label}</span>
            <span class="truncate text-sm text-fg">{summary}</span>
          </span>
          {#if isPending}
            <span class="text-xs text-muted" aria-live="polite">saving…</span>
          {/if}
        </summary>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="border-t border-fg/15 bg-surface/20 px-2 py-2"
          onkeydown={(e) => {
            // Enter on a text/number field commits the in-flight draft. Combobox
            // already swallows Enter for option selection, so this only fires
            // for free-form inputs — exactly what we want.
            if (instant) return;
            if (e.key !== 'Enter') return;
            const tag = (e.target as HTMLElement | null)?.tagName.toLowerCase();
            if (tag !== 'input') return;
            e.preventDefault();
            const draft = drafts[attr.name];
            if (draft !== undefined) void commit(attr, draft);
          }}
          onfocusout={(e) => {
            // Commit a buffered text/number draft when focus leaves the editor
            // body (clicking elsewhere). Skip if focus is moving within the
            // same details element (e.g. into the Save button if we ever add
            // one) so the user doesn't get a double commit.
            if (instant) return;
            const next = e.relatedTarget as HTMLElement | null;
            const root = e.currentTarget as HTMLElement;
            if (next !== null && root.contains(next)) return;
            const draft = drafts[attr.name];
            if (draft === undefined) return;
            void commit(attr, draft);
          }}
        >
          <ValueInput
            attribute={attributeFor(attr)}
            value={draftValue}
            loadOptions={(refLoaders ?? {})[attr.name]}
            onchange={(v) => {
              if (instant) {
                void commit(attr, v);
              } else {
                drafts = { ...drafts, [attr.name]: v };
              }
            }}
          />
          {#if error !== undefined && error !== ''}
            <p class="mt-1 text-xs text-danger" role="alert">{error}</p>
          {/if}
        </div>
      </details>
    {/each}
  </div>
</aside>
