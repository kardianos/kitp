<script lang="ts">
  import type { Snippet } from 'svelte';
  import Button from './Button.svelte';

  interface Props {
    title: string;
    description?: string;
    action?: { label: string; onClick: () => void };
    icon?: Snippet;
  }

  let { title, description, action, icon }: Props = $props();
</script>

<div
  class="mx-auto flex max-w-md flex-col items-center justify-center gap-3 px-6 py-12 text-center"
>
  {#if icon}
    <div class="text-muted">
      {@render icon()}
    </div>
  {/if}
  <h2 class="text-base font-semibold text-fg">{title}</h2>
  {#if description}
    <p class="text-sm text-muted">{description}</p>
  {/if}
  {#if action}
    <Button variant="primary" size="md" onclick={action.onClick}>
      {#snippet children()}{action.label}{/snippet}
    </Button>
  {/if}
</div>
