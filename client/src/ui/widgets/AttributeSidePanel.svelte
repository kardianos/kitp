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

  import ValueInput from '../../filter/ValueInput.svelte';
  import type { FilterAttribute } from '../../filter/attribute_schema.svelte.js';
  import { getDispatcher } from '../../dispatch/context.js';
  import { attributeUpdate } from '../../reg/handlers.js';
  import { cx } from '../../util/class_names.js';

  interface Props {
    cardId: number;
    /** Current attribute values keyed by attribute name. */
    attributes: Record<string, unknown>;
    /** Filterable / editable attribute schema (driven by attribute_def.select). */
    schema: FilterAttribute[];
    /** Pre-resolved options for ref / enum attrs — keyed by attribute name. */
    refOptions?: Record<string, { value: unknown; label: string }[]>;
    /** Called after a successful attribute.update commit. */
    onChanged?: (attrName: string, newValue: unknown) => void;
    class?: string;
  }

  let {
    cardId,
    attributes,
    schema,
    refOptions,
    onChanged,
    class: klass = '',
  }: Props = $props();

  const dispatcher = getDispatcher();

  /** Per-attribute pending state (true while the request is in flight). */
  let pending = $state<Record<string, boolean>>({});
  /** Per-attribute error message (cleared on successful commit). */
  let errors = $state<Record<string, string>>({});

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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors = { ...errors, [name]: msg };
    } finally {
      const nextPending = { ...pending };
      delete nextPending[name];
      pending = nextPending;
    }
  }
</script>

<aside
  class={cx(
    'flex w-full flex-col gap-1 rounded-md border border-border bg-bg p-3',
    klass,
  )}
  aria-label="Attributes"
>
  <h2 class="mb-1 text-sm font-semibold text-fg">Attributes</h2>
  {#if schema.length === 0}
    <p class="text-xs text-muted">No attributes available.</p>
  {/if}
  {#each schema as attr (attr.name)}
    {@const value = attributes[attr.name]}
    {@const summary = displayValue(attr, value)}
    {@const isPending = pending[attr.name] === true}
    {@const error = errors[attr.name]}
    <details class="group rounded-md border border-border/60 px-2 py-1.5">
      <summary
        class={cx(
          'flex cursor-pointer items-center justify-between gap-2 rounded text-sm',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        )}
      >
        <span class="flex min-w-0 flex-1 items-baseline gap-2">
          <span class="text-xs font-medium text-muted">{attr.label}</span>
          <span class="truncate text-sm text-fg">{summary}</span>
        </span>
        {#if isPending}
          <span class="text-xs text-muted" aria-live="polite">saving…</span>
        {/if}
      </summary>
      <div class="mt-2">
        <ValueInput
          attribute={attributeFor(attr)}
          value={value}
          onchange={(v) => {
            void commit(attr, v);
          }}
        />
        {#if error !== undefined && error !== ''}
          <p class="mt-1 text-xs text-danger" role="alert">{error}</p>
        {/if}
      </div>
    </details>
  {/each}
</aside>
