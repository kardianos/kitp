<script lang="ts">
  import { tick } from 'svelte';
  import { autoUpdate, computePosition, flip, offset } from '@floating-ui/dom';
  import { cx } from '../util/class_names.js';

  interface Props {
    value: string | null;
    onchange?: (v: string | null) => void;
    min?: string;
    max?: string;
    placeholder?: string;
    disabled?: boolean;
    class?: string;
    'aria-label'?: string;
  }

  let {
    value = $bindable(),
    onchange,
    min,
    max,
    placeholder = 'Pick a date',
    disabled = false,
    class: klass = '',
    'aria-label': ariaLabel,
  }: Props = $props();

  let open = $state(false);
  let triggerEl: HTMLButtonElement | null = $state(null);
  let popupEl: HTMLDivElement | null = $state(null);
  let cleanupFloat: (() => void) | null = null;

  /** ISO yyyy-mm-dd → Date at local midnight; safe for our arithmetic. */
  function parseIso(s: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const [, y, mo, d] = m;
    const date = new Date(Number(y), Number(mo) - 1, Number(d));
    return isNaN(date.getTime()) ? null : date;
  }

  function toIso(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function fmt(d: Date): string {
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  /** True if the candidate date is within [min, max], inclusive. */
  function inRange(d: Date): boolean {
    if (min !== undefined) {
      const lo = parseIso(min);
      if (lo && d < lo) return false;
    }
    if (max !== undefined) {
      const hi = parseIso(max);
      if (hi && d > hi) return false;
    }
    return true;
  }

  function sameDay(a: Date, b: Date): boolean {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  /** The currently displayed month + the highlighted (focusable) day. */
  let cursor = $state(new Date());
  $effect(() => {
    if (open) {
      const init = (value && parseIso(value)) || new Date();
      cursor = new Date(init.getFullYear(), init.getMonth(), init.getDate());
    }
  });

  const monthGrid = $derived.by(() => {
    // 6 weeks x 7 cols, week starts on Sunday.
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const startDow = first.getDay();
    const start = new Date(first);
    start.setDate(start.getDate() - startDow);
    const days: Date[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      days.push(d);
    }
    return days;
  });

  const valueDate = $derived.by(() => (value ? parseIso(value) : null));
  const triggerLabel = $derived.by(() => (valueDate ? fmt(valueDate) : ''));

  function emit(v: string | null) {
    value = v;
    onchange?.(v);
  }

  function pick(d: Date) {
    if (!inRange(d)) return;
    emit(toIso(d));
    closeMenu();
    triggerEl?.focus();
  }

  function moveCursor(deltaDays: number) {
    const next = new Date(cursor);
    next.setDate(next.getDate() + deltaDays);
    cursor = next;
  }
  function moveMonth(delta: number) {
    const next = new Date(cursor);
    next.setMonth(next.getMonth() + delta);
    cursor = next;
  }

  async function openMenu() {
    if (disabled) return;
    open = true;
    await tick();
    setupFloating();
    void tick().then(() => popupEl?.querySelector<HTMLElement>('[data-cursor="true"]')?.focus());
  }
  function closeMenu() {
    open = false;
    cleanupFloat?.();
    cleanupFloat = null;
  }

  function setupFloating() {
    if (!triggerEl || !popupEl) return;
    cleanupFloat?.();
    cleanupFloat = autoUpdate(triggerEl, popupEl, () => {
      if (!triggerEl || !popupEl) return;
      void computePosition(triggerEl, popupEl, {
        placement: 'bottom-start',
        middleware: [offset(4), flip()],
      }).then(({ x, y }) => {
        if (!popupEl) return;
        Object.assign(popupEl.style, { left: `${x}px`, top: `${y}px` });
      });
    });
  }

  function onTriggerKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void openMenu();
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      closeMenu();
    }
  }

  function onGridKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      moveCursor(-1);
      void tick().then(() => popupEl?.querySelector<HTMLElement>('[data-cursor="true"]')?.focus());
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      moveCursor(1);
      void tick().then(() => popupEl?.querySelector<HTMLElement>('[data-cursor="true"]')?.focus());
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveCursor(-7);
      void tick().then(() => popupEl?.querySelector<HTMLElement>('[data-cursor="true"]')?.focus());
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveCursor(7);
      void tick().then(() => popupEl?.querySelector<HTMLElement>('[data-cursor="true"]')?.focus());
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      moveMonth(-1);
      void tick().then(() => popupEl?.querySelector<HTMLElement>('[data-cursor="true"]')?.focus());
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      moveMonth(1);
      void tick().then(() => popupEl?.querySelector<HTMLElement>('[data-cursor="true"]')?.focus());
    } else if (e.key === 'Home') {
      e.preventDefault();
      moveCursor(-cursor.getDay());
      void tick().then(() => popupEl?.querySelector<HTMLElement>('[data-cursor="true"]')?.focus());
    } else if (e.key === 'End') {
      e.preventDefault();
      moveCursor(6 - cursor.getDay());
      void tick().then(() => popupEl?.querySelector<HTMLElement>('[data-cursor="true"]')?.focus());
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(cursor);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
      triggerEl?.focus();
    }
  }

  function onDocPointerDown(e: PointerEvent) {
    if (!open) return;
    const t = e.target as Node | null;
    if (!t) return;
    if (popupEl?.contains(t)) return;
    if (triggerEl?.contains(t)) return;
    closeMenu();
  }

  $effect(() => {
    if (open) {
      document.addEventListener('pointerdown', onDocPointerDown, true);
      return () => document.removeEventListener('pointerdown', onDocPointerDown, true);
    }
    return undefined;
  });

  $effect(() => {
    return () => cleanupFloat?.();
  });

  const monthLabel = $derived.by(() =>
    cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
  );

  const weekdayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
</script>

<div class={cx('relative inline-block', klass)}>
  <button
    bind:this={triggerEl}
    type="button"
    {disabled}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label={ariaLabel}
    class={cx(
      'flex h-9 min-w-[10rem] items-center justify-between gap-2 rounded-md border border-border bg-bg px-2.5 text-sm text-fg',
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      disabled && 'cursor-not-allowed opacity-50',
    )}
    onclick={() => (open ? closeMenu() : openMenu())}
    onkeydown={onTriggerKeydown}
  >
    {#if triggerLabel}
      <span>{triggerLabel}</span>
    {:else}
      <span class="text-muted">{placeholder}</span>
    {/if}
    <svg viewBox="0 0 16 16" class="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true">
      <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none" />
      <path d="M2 6 H14" stroke="currentColor" stroke-width="1.2" />
      <path d="M5 2 V4 M11 2 V4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
    </svg>
  </button>

  {#if open}
    <div
      bind:this={popupEl}
      class="z-50 w-64 rounded-md border border-border bg-bg p-2 text-fg shadow-lg"
      style="position: fixed; left: 0; top: 0;"
      role="dialog"
      aria-label="Choose date"
    >
      <div class="mb-2 flex items-center justify-between">
        <button
          type="button"
          class="h-7 w-7 rounded text-fg hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="Previous month"
          onclick={() => moveMonth(-1)}
        >&lsaquo;</button>
        <span class="text-sm font-medium">{monthLabel}</span>
        <button
          type="button"
          class="h-7 w-7 rounded text-fg hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="Next month"
          onclick={() => moveMonth(1)}
        >&rsaquo;</button>
      </div>
      <div class="grid grid-cols-7 gap-0.5 text-center text-[10px] font-medium text-muted">
        {#each weekdayLabels as w, i (i)}
          <div>{w}</div>
        {/each}
      </div>
      <!-- svelte-ignore a11y_interactive_supports_focus -->
      <div
        class="mt-1 grid grid-cols-7 gap-0.5"
        role="grid"
        tabindex="-1"
        onkeydown={onGridKeydown}
      >
        {#each monthGrid as d, i (i)}
          {@const inMonth = d.getMonth() === cursor.getMonth()}
          {@const isCursor = sameDay(d, cursor)}
          {@const isSelected = valueDate !== null && sameDay(d, valueDate)}
          {@const allowed = inRange(d)}
          <button
            type="button"
            role="gridcell"
            class={cx(
              'h-7 rounded text-xs',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              !inMonth && 'text-muted/60',
              !allowed && 'cursor-not-allowed opacity-30',
              allowed && !isSelected && 'hover:bg-surface',
              isSelected && 'bg-accent text-accent-fg font-semibold',
            )}
            tabindex={isCursor ? 0 : -1}
            data-cursor={isCursor}
            aria-current={isCursor ? 'date' : undefined}
            aria-selected={isSelected}
            disabled={!allowed}
            onclick={() => pick(d)}
          >{d.getDate()}</button>
        {/each}
      </div>
      <div class="mt-2 flex items-center justify-between">
        <button
          type="button"
          class="text-xs text-muted hover:text-fg focus:outline-none focus-visible:underline"
          onclick={() => {
            emit(null);
            closeMenu();
            triggerEl?.focus();
          }}
        >Clear</button>
        <button
          type="button"
          class="text-xs text-accent hover:underline focus:outline-none focus-visible:underline"
          onclick={() => {
            const today = new Date();
            cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
            pick(cursor);
          }}
        >Today</button>
      </div>
    </div>
  {/if}
</div>
