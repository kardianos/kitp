<script lang="ts">
  /**
   * Renders the right input control for a {@link FilterAttribute}, based
   * on the attribute's `valueType`:
   *
   *   - `text`              → free-text `<input type="text">`
   *   - `number`            → numeric `<input type="number">`
   *   - `bool`              → checkbox toggle
   *   - `date`              → `<DatePicker>`
   *   - `enum`              → `<Combobox>` populated from `attribute.options`
   *   - `ref:<card_type>`   → `<Combobox>` populated from `attribute.options`
   *                           (caller pre-loads via card.select_with_attributes)
   *   - anything else       → text fallback
   *
   * The `multiple` prop drives single vs. multi mode for combobox-backed
   * inputs (the predicate's op `in` / `not in` flips this on; `=` / `!=`
   * keeps it off).
   */

  import Combobox from '../ui/Combobox.svelte';
  import DatePicker from '../ui/DatePicker.svelte';
  import type { FilterAttribute } from './attribute_schema.svelte.js';

  interface Props {
    attribute: FilterAttribute;
    value: unknown;
    multiple?: boolean;
    onchange?: (v: unknown) => void;
    /**
     * Async loader for combobox-backed types. Defined for ref:* attrs whose
     * option lists are too large to preload — see card.search on the server.
     * Passed straight through to the Combobox; when set, the dropdown
     * consults the server on open and per keystroke instead of substring-
     * filtering a static `options` list.
     */
    loadOptions?:
      | ((query: string) => Promise<{ value: unknown; label: string }[]>)
      | undefined;
  }

  let {
    attribute,
    value = $bindable(),
    multiple = false,
    onchange,
    loadOptions,
  }: Props = $props();

  function emit(v: unknown) {
    value = v;
    onchange?.(v);
  }

  /** True when the attribute uses a Combobox (ref:*). */
  const isCombobox = $derived.by(
    () => attribute.valueType.startsWith('ref:'),
  );

  /** Stringify scalar values for `<input>` `value=` attribute. */
  function asInputString(v: unknown): string {
    if (v === null || v === undefined) return '';
    return String(v);
  }

  /** Coerce a `<DatePicker>`-shaped value (string | null) into our union. */
  const dateValue = $derived.by((): string | null => {
    if (typeof value === 'string') return value;
    return null;
  });

  /** Combobox value: array for multi, scalar for single, null when empty. */
  const comboValue = $derived.by((): unknown | unknown[] | null => {
    if (multiple) {
      if (Array.isArray(value)) return value;
      return [];
    }
    if (value === undefined || value === null) return null;
    return value;
  });

  const comboOptions = $derived.by(() => attribute.options ?? []);
</script>

{#if attribute.valueType === 'text'}
  <input
    type="text"
    aria-label={attribute.label}
    value={asInputString(value)}
    class="h-9 w-full rounded-md border border-border bg-bg px-2.5 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    oninput={(e) => emit((e.currentTarget as HTMLInputElement).value)}
  />
{:else if attribute.valueType === 'number'}
  <input
    type="number"
    aria-label={attribute.label}
    value={asInputString(value)}
    class="h-9 w-full rounded-md border border-border bg-bg px-2.5 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    oninput={(e) => {
      const raw = (e.currentTarget as HTMLInputElement).value;
      // Empty string → null; otherwise coerce via Number(). Avoid sneaking
      // NaN onto the wire.
      if (raw === '') {
        emit(null);
        return;
      }
      const n = Number(raw);
      emit(Number.isFinite(n) ? n : null);
    }}
  />
{:else if attribute.valueType === 'bool'}
  <label class="inline-flex items-center gap-2 text-sm text-fg">
    <input
      type="checkbox"
      aria-label={attribute.label}
      checked={value === true}
      class="h-4 w-4 rounded border-border text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      onchange={(e) => emit((e.currentTarget as HTMLInputElement).checked)}
    />
    <span>{attribute.label}</span>
  </label>
{:else if attribute.valueType === 'date'}
  <DatePicker
    aria-label={attribute.label}
    value={dateValue}
    onchange={(v) => emit(v)}
  />
{:else if isCombobox}
  <Combobox
    aria-label={attribute.label}
    options={comboOptions}
    value={comboValue}
    {multiple}
    {loadOptions}
    onchange={(v) => emit(v)}
  />
{:else}
  <!-- Unknown valueType — fall back to a text input so the row still edits. -->
  <input
    type="text"
    aria-label={attribute.label}
    value={asInputString(value)}
    class="h-9 w-full rounded-md border border-border bg-bg px-2.5 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    oninput={(e) => emit((e.currentTarget as HTMLInputElement).value)}
  />
{/if}
