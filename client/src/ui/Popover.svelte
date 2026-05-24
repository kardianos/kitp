<!--
  Popover — floating panel anchored to a trigger element.

  Wraps @floating-ui/dom's autoUpdate + computePosition so screens
  don't reinvent the dance every time (previously QuickFilterDropdown
  and FilterBar's edit popover both hand-rolled this with subtle
  divergence in the click-outside logic).

  API:
    <Popover bind:open anchor={triggerEl} placement="bottom-start">
      {#snippet children()}
        ...popover content...
      {/snippet}
    </Popover>

  The caller owns:
    - the trigger button (so it can carry its own styling / ARIA)
    - `open` state (so the trigger can toggle it)
    - the `anchor` ref (bind:this on the trigger)

  Popover owns:
    - floating-ui positioning + autoUpdate teardown
    - pointerdown-outside closes (skipping clicks inside the anchor)
    - Escape closes
    - visibility-hidden until first positioned (no flash at 0,0)
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { tick } from 'svelte';
  import { autoUpdate, computePosition, flip, offset, type Placement } from '@floating-ui/dom';
  import { cx } from '../util/class_names.js';

  interface Props {
    /** Two-way open state — bind from the caller. */
    open: boolean;
    /** The trigger element to anchor against; pass via bind:this on the button. */
    anchor: HTMLElement | null;
    /** Floating-ui placement; default 'bottom-start'. */
    placement?: Placement | undefined;
    /** Pixel offset between trigger and panel; default 4. */
    offsetPx?: number | undefined;
    /** Width preset: defaults to 'auto' (sized to content). 'trigger' matches anchor width. */
    width?: 'auto' | 'trigger' | string | undefined;
    /** Fires when the popover closes itself (click-outside or Escape). */
    onClose?: () => void;
    /** ARIA label for the panel container. */
    'aria-label'?: string | undefined;
    /** ARIA role for the panel; default 'dialog'. Use 'listbox' / 'menu' as fits. */
    role?: string | undefined;
    /** Outer class added after the canonical panel theme classes. */
    class?: string | undefined;
    /** testid for the panel root. */
    testid?: string | undefined;
    children: Snippet;
  }

  let {
    open = $bindable(),
    anchor,
    placement = 'bottom-start',
    offsetPx = 4,
    width = 'auto',
    onClose,
    'aria-label': ariaLabel,
    role = 'dialog',
    class: klass = '',
    testid,
    children,
  }: Props = $props();

  let panelEl: HTMLDivElement | null = $state(null);
  let cleanupFloat: (() => void) | null = null;

  async function setupFloating() {
    if (!anchor || !panelEl) return;
    cleanupFloat?.();
    if (width === 'trigger' && anchor) {
      panelEl.style.width = `${anchor.getBoundingClientRect().width}px`;
    } else if (typeof width === 'string' && width !== 'auto') {
      panelEl.style.width = width;
    }
    const a = anchor;
    const p = panelEl;
    cleanupFloat = autoUpdate(a, p, () => {
      void computePosition(a, p, {
        placement: placement!,
        middleware: [offset(offsetPx!), flip()],
      }).then(({ x, y }) => {
        Object.assign(p.style, {
          left: `${x}px`,
          top: `${y}px`,
          visibility: 'visible',
        });
      });
    });
  }

  function close() {
    open = false;
    cleanupFloat?.();
    cleanupFloat = null;
    onClose?.();
  }

  function onDocPointerDown(e: PointerEvent) {
    if (!open) return;
    const t = e.target as Node | null;
    if (!t) return;
    if (panelEl?.contains(t)) return;
    if (anchor?.contains(t)) return;
    close();
  }

  function onKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }

  // (Re)position when open flips true.
  $effect(() => {
    if (open) {
      void tick().then(setupFloating);
      document.addEventListener('pointerdown', onDocPointerDown, true);
      return () => {
        document.removeEventListener('pointerdown', onDocPointerDown, true);
      };
    }
    return undefined;
  });

  // Tear down on unmount even if we missed an open→close.
  $effect(() => {
    return () => {
      cleanupFloat?.();
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <div
    bind:this={panelEl}
    {role}
    aria-label={ariaLabel}
    data-testid={testid}
    class={cx(
      'kf-float-anchor z-50 rounded-md border border-border bg-bg text-fg shadow-lg',
      klass,
    )}
  >
    {@render children()}
  </div>
{/if}
