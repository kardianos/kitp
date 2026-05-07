<script lang="ts">
  import type { Snippet } from 'svelte';
  import { tick } from 'svelte';
  import { cx } from '../util/class_names.js';

  interface Props {
    open: boolean;
    title?: string;
    onClose?: () => void;
    width?: 'sm' | 'md' | 'lg';
    children?: Snippet;
    footer?: Snippet;
  }

  let {
    open = $bindable(),
    title,
    onClose,
    width = 'md',
    children,
    footer,
  }: Props = $props();

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
  let panelEl: HTMLDivElement | null = $state(null);

  const widthClass = $derived.by(() => {
    switch (width) {
      case 'sm':
        return 'w-full max-w-sm';
      case 'lg':
        return 'w-full max-w-2xl';
      default:
        return 'w-full max-w-md';
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
    open = false;
    onClose?.();
  }

  function onKeydown(e: KeyboardEvent) {
    if (!open || !panelEl) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Tab') {
      const focusables = focusableInside(panelEl);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !panelEl.contains(active)) {
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
  }

  $effect(() => {
    if (open) {
      lastFocused = (document.activeElement as HTMLElement | null) ?? null;
      void tick().then(() => {
        if (!panelEl) return;
        const focusables = focusableInside(panelEl);
        const target = focusables[0] ?? panelEl;
        target.focus();
      });
    } else if (lastFocused) {
      const el = lastFocused;
      lastFocused = null;
      queueMicrotask(() => el.focus?.());
    }
  });
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <div use:portal class="fixed inset-0 z-50 flex justify-end">
    <button
      type="button"
      class="absolute inset-0 bg-black/40"
      aria-label="Close"
      tabindex="-1"
      onclick={close}
    ></button>
    <div
      bind:this={panelEl}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabindex="-1"
      class={cx(
        'relative z-10 flex h-full flex-col border-l border-border bg-bg text-fg shadow-2xl',
        widthClass,
      )}
    >
      <header class="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 class="truncate text-base font-semibold">{title ?? ''}</h2>
        <button
          type="button"
          class="rounded p-1 text-muted hover:bg-border/40"
          aria-label="Close"
          onclick={close}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <div class="flex-1 overflow-auto px-4 py-4">
        {#if children}
          {@render children()}
        {/if}
      </div>
      {#if footer}
        <footer class="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          {@render footer()}
        </footer>
      {/if}
    </div>
  </div>
{/if}
