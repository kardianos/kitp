<!--
  TextInput — single-line text control, data-bound to a Form path.

  Reads `form.get(path)`, writes back on input. Looks up label /
  required / placeholder from the schema if not overridden. No events
  leave this component — the Form context owns the data flow.

  All visual styling lives in app.css under [data-control="text-input"].
  This component ships effectively zero CSS bytes; the global rules
  are parsed once at startup.
-->
<script lang="ts">
  import { getFormContext } from '../context';

  interface Props {
    /** Required: field key in the form's draft. */
    path: string;
    /** Optional label override. Defaults to schema description, then humanized path. */
    label?: string | undefined;
    /** Optional caption override. Defaults to nothing (the schema's description
     *  becomes the label by default; use caption for secondary help text). */
    caption?: string | undefined;
    /** Override the input type if you need email/url/search/tel rather than text. */
    type?: 'text' | 'email' | 'url' | 'search' | 'tel';
    placeholder?: string | undefined;
    disabled?: boolean | undefined;
    autocomplete?: HTMLInputElement['autocomplete'] | undefined;
  }

  let { path, label, caption, type = 'text', placeholder, disabled = false, autocomplete }: Props = $props();

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
  {#if resolvedLabel !== ''}
    <span class="kf-label">
      {resolvedLabel}{#if required}<span class="kf-required" aria-hidden="true">*</span>{/if}
    </span>
  {/if}
  <!-- When the label row is suppressed (label="") we still want the
       required marker visible — without this branch the asterisk
       either lives on its own row (the original bug) or disappears
       entirely. Floating it inside the input's right edge keeps it
       on the same visual row as the field. -->
  <div class="relative">
    <input
      {type}
      {placeholder}
      {disabled}
      {autocomplete}
      aria-invalid={error ? 'true' : undefined}
      value={value}
      oninput={(e) => form.set(path, (e.currentTarget as HTMLInputElement).value)}
    />
    {#if required && resolvedLabel === ''}
      <span
        class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-sm text-danger"
        aria-hidden="true"
        title="Required"
      >*</span>
    {/if}
  </div>
  {#if error}
    <p class="kf-error" role="alert">{error}</p>
  {:else if caption}
    <p class="kf-caption">{caption}</p>
  {/if}
</label>
