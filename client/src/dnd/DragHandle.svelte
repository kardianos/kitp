<script lang="ts">
  import type { Snippet } from 'svelte';
  import { dragHandle } from './use_dnd.svelte';

  interface Props {
    payload: unknown;
    /** label rendered inside the floating drag preview */
    previewLabel?: string;
    children?: Snippet;
    class?: string;
  }

  let { payload, previewLabel, children, class: cls = '' }: Props = $props();

  // Build an opts object only when previewLabel is set so the action sees
  // either a raw payload or { payload, previewLabel }.
  let opts = $derived(
    previewLabel === undefined ? payload : { payload, previewLabel },
  );
</script>

<div use:dragHandle={opts} class="dnd-handle {cls}">
  {@render children?.()}
</div>

<style>
  .dnd-handle {
    user-select: none;
    -webkit-user-select: none;
    touch-action: none;
  }
</style>
