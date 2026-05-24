<!--
  Checkbox — boolean control, data-bound to a Form path. Renders the
  checkbox inline with its label since that's the layout users
  expect for boolean fields.
-->
<script lang="ts">
  import { getFormContext } from '../context';

  interface Props {
    path: string;
    label?: string | undefined;
    caption?: string | undefined;
    disabled?: boolean | undefined;
  }

  let { path, label, caption, disabled = false }: Props = $props();

  const form = getFormContext();
  const fieldSchema = $derived(form.fieldSchema(path));
  const resolvedLabel = $derived(label ?? fieldSchema?.description ?? humanize(path));
  const checked = $derived(Boolean(form.get(path) ?? false));
  const error = $derived(form.errors[path]);

  function humanize(k: string): string {
    const spaced = k.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }
</script>

<label
  class="inline-flex items-center gap-2 text-sm text-fg select-none"
  data-control="checkbox"
  data-invalid={error ? 'true' : null}
>
  <input
    type="checkbox"
    {disabled}
    checked={checked}
    onchange={(e) => form.set(path, (e.currentTarget as HTMLInputElement).checked)}
  />
  <span>{resolvedLabel}</span>
  {#if error}
    <span class="ml-2 text-xs text-danger" role="alert">{error}</span>
  {:else if caption}
    <span class="ml-2 text-xs text-muted">{caption}</span>
  {/if}
</label>
