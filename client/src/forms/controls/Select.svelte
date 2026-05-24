<!--
  Select — single-choice picker, data-bound to a Form path.

  Generic over the option value type so the same primitive handles
  string-keyed enums and bigint-keyed IDs. The draft slot at `path`
  holds the chosen option's value verbatim (or null when cleared).

  Wraps the existing <Combobox> for the actual rendering — Combobox
  already has the floating-ui menu, search-as-you-type, ARIA shape.
  This primitive just hooks it into form context so screens don't
  re-roll the value-binding glue.
-->
<script lang="ts" generics="T">
  import Combobox from '../../ui/Combobox.svelte';
  import { getFormContext } from '../context';

  interface Option {
    value: T;
    label: string;
    disabled?: boolean;
  }

  interface Props {
    path: string;
    options: Option[];
    label?: string | undefined;
    caption?: string | undefined;
    placeholder?: string | undefined;
    disabled?: boolean | undefined;
    /** Whether the menu shows a search input. Default true. */
    searchable?: boolean | undefined;
    /** Value treated as "absent" in the draft. When the user clears
     *  (or picks an option with this value), the draft slot receives
     *  this value — useful for keeping the wire payload's "no choice"
     *  representation consistent (e.g. 0n for "no intake status"). */
    nullValue?: T | undefined;
    'aria-label'?: string | undefined;
  }

  let {
    path,
    options,
    label,
    caption,
    placeholder,
    disabled = false,
    searchable = true,
    nullValue,
    'aria-label': ariaLabel,
  }: Props = $props();

  const form = getFormContext();
  const fieldSchema = $derived(form.fieldSchema(path));
  const required = $derived(form.isRequired(path));
  const resolvedLabel = $derived(label ?? fieldSchema?.description ?? humanize(path));
  const currentValue = $derived(form.get(path) as T | null | undefined);
  const error = $derived(form.errors[path]);

  function humanize(k: string): string {
    const spaced = k.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  function handleChange(v: T | T[] | null): void {
    if (Array.isArray(v)) {
      form.set(path, v[0] ?? nullValue ?? null);
      return;
    }
    if (v === null) {
      form.set(path, nullValue !== undefined ? nullValue : null);
      return;
    }
    form.set(path, v);
  }
</script>

<label
  class="is-label-wrap"
  data-control="select"
  data-required={required ? 'true' : null}
  data-invalid={error ? 'true' : null}
>
  <span class="kf-label">
    {resolvedLabel}{#if required}<span class="kf-required" aria-hidden="true">*</span>{/if}
  </span>
  {#if placeholder !== undefined}
    <Combobox
      aria-label={ariaLabel ?? resolvedLabel}
      {options}
      {searchable}
      {placeholder}
      {disabled}
      value={currentValue ?? null}
      onchange={handleChange}
    />
  {:else}
    <Combobox
      aria-label={ariaLabel ?? resolvedLabel}
      {options}
      {searchable}
      {disabled}
      value={currentValue ?? null}
      onchange={handleChange}
    />
  {/if}
  {#if error}
    <p class="kf-error" role="alert">{error}</p>
  {:else if caption}
    <p class="kf-caption">{caption}</p>
  {/if}
</label>
