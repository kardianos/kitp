<script lang="ts">
  import { cx } from '../util/class_names.js';
  import { toasts, type ToastItem } from './toast.svelte.js';

  function bgFor(t: ToastItem['type']): string {
    switch (t) {
      case 'success':
        return 'border-green-600/40 bg-surface';
      case 'error':
        return 'border-danger bg-surface';
      default:
        return 'border-border bg-surface';
    }
  }

  function dotFor(t: ToastItem['type']): string {
    switch (t) {
      case 'success':
        return 'bg-green-500';
      case 'error':
        return 'bg-danger';
      default:
        return 'bg-accent';
    }
  }

  function onItemKeydown(e: KeyboardEvent, id: string) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      toasts.dismiss(id);
    }
  }
</script>

<div
  class="pointer-events-none fixed right-4 top-4 z-[60] flex w-80 flex-col gap-2"
  aria-live="polite"
  aria-atomic="false"
>
  {#each toasts.items as item (item.id)}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      role="status"
      tabindex="0"
      class={cx(
        'pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 text-sm text-fg shadow-lg',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        bgFor(item.type),
      )}
      onkeydown={(e) => onItemKeydown(e, item.id)}
    >
      <span class={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', dotFor(item.type))}></span>
      <div class="min-w-0 flex-1">
        <p class="break-words leading-snug">{item.message}</p>
      </div>
      {#if item.undo}
        <button
          type="button"
          class="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-accent hover:bg-accent/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onclick={() => {
            item.undo?.();
            toasts.dismiss(item.id);
          }}
        >
          Undo
        </button>
      {/if}
      <button
        type="button"
        aria-label="Dismiss"
        class="-mr-1 shrink-0 rounded p-0.5 text-muted hover:bg-border/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onclick={() => toasts.dismiss(item.id)}
      >
        <svg viewBox="0 0 12 12" class="h-3 w-3" aria-hidden="true">
          <path
            d="M2 2 L10 10 M10 2 L2 10"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            fill="none"
          />
        </svg>
      </button>
    </div>
  {/each}
</div>
