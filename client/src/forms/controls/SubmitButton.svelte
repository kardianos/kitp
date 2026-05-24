<!--
  SubmitButton — calls form.submit() and reflects form.submitting.
  Renders as a primary Button; pass children to override the label
  (defaults to "Save").

  Two routing modes:
    - No formId   → uses Svelte context to find the enclosing Form
                    (the default; works when the button is inside
                    the Form's children tree).
    - formId="x"  → looks up Form by id in the registry. Lets you
                    place the button in a Modal/SlideOver footer
                    snippet (a DOM sibling of the children tree, so
                    context wouldn't reach).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Button from '../../ui/Button.svelte';
  import { tryFormContext, type FormContext } from '../context';
  import { lookupForm } from '../registry.svelte';

  interface Props {
    variant?: 'primary' | 'danger';
    size?: 'sm' | 'md' | 'lg';
    /** Label override; defaults to "Save". */
    children?: Snippet;
    disabled?: boolean;
    /** Routes to the Form registered with this id (cross-DOM mode). */
    formId?: string;
  }

  let { variant = 'primary', size = 'md', children, disabled = false, formId }: Props = $props();

  // Resolve the target form: explicit formId takes precedence; fall
  // back to context. Re-evaluated reactively so a SubmitButton
  // mounted before its Form (rare but possible in odd dialog flows)
  // picks up the registration when it lands.
  const ctxForm = tryFormContext();
  const form = $derived<FormContext | null>(formId ? lookupForm(formId) ?? null : ctxForm);
  const submitting = $derived(form?.submitting ?? false);
</script>

<Button
  {variant}
  {size}
  disabled={disabled || submitting || form === null}
  loading={submitting}
  onclick={() => { if (form) void form.submit(); }}
>
  {#snippet children()}
    {#if children}{@render children()}{:else}Save{/if}
  {/snippet}
</Button>
