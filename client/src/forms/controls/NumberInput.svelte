<!--
  NumberInput — type=number control, data-bound to a Form path.
  Coerces user input through Number() so the draft holds a real
  number; an empty input becomes 0 (use a separate optional flag
  to support null if a real use case demands it).
-->
<script lang="ts">
  import { getFormContext } from '../context';

  interface Props {
    path: string;
    label?: string | undefined;
    caption?: string | undefined;
    placeholder?: string | undefined;
    disabled?: boolean | undefined;
  }

  let { path, label, caption, placeholder, disabled = false }: Props = $props();

  const form = getFormContext();
  const fieldSchema = $derived(form.fieldSchema(path));
  const required = $derived(form.isRequired(path));
  const resolvedLabel = $derived(label ?? fieldSchema?.description ?? humanize(path));
  const value = $derived(form.get(path) as number | undefined);
  const error = $derived(form.errors[path]);
  const min = $derived(fieldSchema?.minimum);
  const max = $derived(fieldSchema?.maximum);

  function humanize(k: string): string {
    const spaced = k.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  function onInput(e: Event) {
    const raw = (e.currentTarget as HTMLInputElement).value;
    const n = raw === '' ? 0 : Number(raw);
    form.set(path, Number.isFinite(n) ? n : 0);
  }
</script>

<label
  class="is-label-wrap"
  data-control="number-input"
  data-required={required ? 'true' : null}
  data-invalid={error ? 'true' : null}
>
  <span class="kf-label">
    {resolvedLabel}{#if required}<span class="kf-required" aria-hidden="true">*</span>{/if}
  </span>
  <input
    type="number"
    {placeholder}
    {disabled}
    {min}
    {max}
    aria-invalid={error ? 'true' : undefined}
    value={value ?? ''}
    oninput={onInput}
  />
  {#if error}
    <p class="kf-error" role="alert">{error}</p>
  {:else if caption}
    <p class="kf-caption">{caption}</p>
  {/if}
</label>
