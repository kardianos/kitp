<!--
  PasswordInput — type=password sibling of TextInput. Separate so
  autocomplete defaults right and call sites are grep-able.
-->
<script lang="ts">
  import { getFormContext } from '../context';

  interface Props {
    path: string;
    label?: string | undefined;
    caption?: string | undefined;
    placeholder?: string | undefined;
    disabled?: boolean | undefined;
    autocomplete?: 'new-password' | 'current-password' | 'off';
  }

  let { path, label, caption, placeholder, disabled = false, autocomplete = 'new-password' }: Props = $props();

  const form = getFormContext();
  const fieldSchema = $derived(form.fieldSchema(path));
  const required = $derived(form.isRequired(path));
  const resolvedLabel = $derived(label ?? fieldSchema?.description ?? humanize(path));
  const value = $derived(String(form.get(path) ?? ''));
  const error = $derived(form.errors[path]);

  function humanize(k: string): string {
    const spaced = k.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }
</script>

<label
  class="is-label-wrap"
  data-control="text-input"
  data-required={required ? 'true' : null}
  data-invalid={error ? 'true' : null}
>
  <span class="kf-label">
    {resolvedLabel}{#if required}<span class="kf-required" aria-hidden="true">*</span>{/if}
  </span>
  <input
    type="password"
    {placeholder}
    {disabled}
    {autocomplete}
    aria-invalid={error ? 'true' : undefined}
    value={value}
    oninput={(e) => form.set(path, (e.currentTarget as HTMLInputElement).value)}
  />
  {#if error}
    <p class="kf-error" role="alert">{error}</p>
  {:else if caption}
    <p class="kf-caption">{caption}</p>
  {/if}
</label>
