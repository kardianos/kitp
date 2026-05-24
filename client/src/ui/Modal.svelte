<script lang="ts">
  import type { Snippet } from 'svelte';
  import { tick } from 'svelte';
  import { shortcuts } from '../keys/registry.svelte.js';
  import { cx } from '../util/class_names.js';

  interface Props {
    open: boolean;
    title?: string;
    onClose?: () => void;
    size?: 'sm' | 'md' | 'lg';
    dismissable?: boolean;
    children?: Snippet;
    footer?: Snippet;
  }

  let {
    open = $bindable(),
    title,
    onClose,
    size = 'md',
    dismissable = true,
    children,
    footer,
  }: Props = $props();

  /** A Svelte action that re-parents its node to `document.body` for the lifetime
   *  of the action. The placeholder remains in the original tree so layout is
   *  unaffected. On destroy, the node is removed from body. */
  function portal(node: HTMLElement) {
    const body = typeof document !== 'undefined' ? document.body : null;
    if (body) body.appendChild(node);
    return {
      destroy() {
        if (node.parentNode) node.parentNode.removeChild(node);
      },
    };
  }

  let lastFocused: HTMLElement | null = null;
  let dialogEl: HTMLDivElement | null = $state(null);

  const sizeClass = $derived.by(() => {
    switch (size) {
      case 'sm':
        return 'max-w-sm';
      case 'lg':
        return 'max-w-3xl';
      default:
        return 'max-w-lg';
    }
  });

  function focusableInside(root: HTMLElement): HTMLElement[] {
    const sel =
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter(
      (el) => !el.hasAttribute('inert') && el.offsetParent !== null,
    );
  }

  function close() {
    if (!dismissable) return;
    open = false;
    onClose?.();
  }

  /**
   * Tab-trap only — Esc is handled via the shortcut registry's
   * overlay tier (see the $effect below) so it wins cleanly over
   * any active-scope Esc binding (e.g. TaskDetail's "back" chord)
   * instead of relying on listener-order races.
   */
  function onKeydown(e: KeyboardEvent) {
    if (!open || !dialogEl) return;
    if (e.key !== 'Tab') return;
    const focusables = focusableInside(dialogEl);
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === first || !dialogEl.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  // Register Esc on the overlay tier while open. The overlay tier
  // out-ranks active-scope bindings in the dispatcher's findMatch,
  // so an open dialog reliably absorbs Esc no matter what screen
  // owns the active scope underneath.
  $effect(() => {
    if (!open || !dismissable) return;
    const id = shortcuts.register({
      scope: 'overlay',
      binding: 'Esc',
      handler: close,
      label: title ? `Close ${title}` : 'Close dialog',
    });
    return () => shortcuts.unregister(id);
  });

  $effect(() => {
    if (open) {
      lastFocused = (document.activeElement as HTMLElement | null) ?? null;
      void tick().then(() => {
        if (!dialogEl) return;
        const focusables = focusableInside(dialogEl);
        const target = focusables[0] ?? dialogEl;
        target.focus();
      });
    } else if (lastFocused) {
      const el = lastFocused;
      lastFocused = null;
      // Restore focus next microtask so DOM has settled.
      queueMicrotask(() => el.focus?.());
    }
  });
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <div use:portal class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <button
      type="button"
      class="absolute inset-0 bg-black/40"
      aria-label="Close"
      tabindex="-1"
      onclick={close}
    ></button>
    <div
      bind:this={dialogEl}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabindex="-1"
      class={cx(
        'relative z-10 flex max-h-[90vh] w-full flex-col rounded-lg border border-border bg-bg text-fg shadow-2xl',
        sizeClass,
      )}
    >
      {#if title}
        <header class="border-b border-border px-5 py-3">
          <h2 class="text-base font-semibold">{title}</h2>
        </header>
      {/if}
      <div class="flex-1 overflow-auto px-5 py-4">
        {#if children}
          {@render children()}
        {/if}
      </div>
      {#if footer}
        <footer class="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          {@render footer()}
        </footer>
      {/if}
    </div>
  </div>
{/if}
