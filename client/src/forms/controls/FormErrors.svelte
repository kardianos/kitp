<!--
  FormErrors — surfaces the Form's form-level error (the message from
  a failed submit that didn't route to a specific field). Per-field
  errors render inline on each control; this primitive handles the
  "the whole save failed" banner.
-->
<script lang="ts">
  import ErrorAlert from '../../ui/ErrorAlert.svelte';
  import { getFormContext } from '../context';

  const form = getFormContext();
</script>

{#if form.formError}
  <ErrorAlert message={form.formError} />
{/if}
