<script lang="ts">
  import type { Snippet } from 'svelte';
  import { dropZone } from './use_dnd.svelte';

  interface Props {
    id: string;
    onDrop: (payload: unknown) => void;
    accepts?: (payload: unknown) => boolean;
    padding?: number;
    children?: Snippet;
    class?: string;
  }

  let {
    id,
    onDrop,
    accepts,
    padding = 24,
    children,
    class: cls = '',
  }: Props = $props();

  let hovered = $state(false);

  function setHover(v: boolean): void {
    hovered = v;
  }

  // Build the action options without spreading `undefined` values — strict
  // `exactOptionalPropertyTypes` rejects `{ accepts: undefined }`.
  let zoneOpts = $derived(
    accepts === undefined
      ? { id, onDrop, padding, setHover }
      : { id, onDrop, accepts, padding, setHover },
  );
</script>

<div
  use:dropZone={zoneOpts}
  class="dnd-zone {cls}"
  class:dnd-zone--hover={hovered}
  style:--dnd-padding="{padding}px"
>
  {@render children?.()}
  <div class="dnd-placeholder" aria-hidden="true"></div>
</div>

<style>
  .dnd-zone {
    position: relative;
  }

  .dnd-placeholder {
    height: 0;
    overflow: hidden;
    transition:
      height 120ms ease-out,
      background-color 120ms ease-out;
    background-color: transparent;
    border-radius: 4px;
  }

  .dnd-zone--hover .dnd-placeholder {
    /* Doubles in height (idle 32 -> hover 64) per migration plan section 5.8 */
    height: 64px;
    background-color: rgba(99, 102, 241, 0.12);
    border: 1px dashed rgba(99, 102, 241, 0.6);
  }

  @media (prefers-reduced-motion: reduce) {
    .dnd-placeholder {
      transition: none;
    }
  }
</style>
