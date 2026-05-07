<script lang="ts" generics="T">
  import { tick } from 'svelte';
  import { autoUpdate, computePosition, flip, offset, size as flSize } from '@floating-ui/dom';
  import { cx } from '../util/class_names.js';
  import Chip from './Chip.svelte';

  interface Option {
    value: T;
    label: string;
    disabled?: boolean;
  }

  interface Props {
    value: T | T[] | null;
    options: Option[];
    multiple?: boolean;
    searchable?: boolean;
    placeholder?: string;
    disabled?: boolean;
    onchange?: (v: T | T[] | null) => void;
    /**
     * Async loader. When set the dropdown switches to async mode: the
     * server is consulted on open (with `''`) and on every keystroke
     * (debounced). The local substring filter is bypassed — the loader
     * is the single source of truth for visible options. `options` is
     * still consulted for the trigger's label rendering, so callers
     * should pass at least the entries needed to label the current
     * value(s).
     */
    loadOptions?: ((query: string) => Promise<Option[]>) | undefined;
    class?: string;
    id?: string;
    'aria-label'?: string;
  }

  let {
    value = $bindable(),
    options,
    multiple = false,
    searchable = true,
    placeholder = 'Select…',
    disabled = false,
    onchange,
    loadOptions,
    class: klass = '',
    id,
    'aria-label': ariaLabel,
  }: Props = $props();

  const isAsync = $derived(loadOptions !== undefined);

  /** Async-mode: the most recent server result. Cleared on close. */
  let asyncOptions = $state<Option[]>([]);
  /** Async-mode: true while a load is in flight. */
  let asyncLoading = $state(false);
  /** Monotonic load-request counter so stale responses can be discarded. */
  let loadSeq = 0;
  /** Debounce timer for keystroke-driven loads. */
  let debounceHandle: ReturnType<typeof setTimeout> | null = null;

  let open = $state(false);
  let query = $state('');
  let highlightIdx = $state(0);
  let triggerEl: HTMLButtonElement | null = $state(null);
  let popupEl: HTMLDivElement | null = $state(null);
  let searchEl: HTMLInputElement | null = $state(null);
  let cleanupFloat: (() => void) | null = null;

  const baseId = $derived(id ?? `cb-${Math.random().toString(36).slice(2, 8)}`);

  /** Single-mode getters/setters */
  const selectedSingle = $derived.by((): T | null => {
    if (multiple) return null;
    return (value as T | null) ?? null;
  });

  /** Multi-mode array */
  const selectedMulti = $derived.by((): T[] => {
    if (!multiple) return [];
    return Array.isArray(value) ? (value as T[]) : [];
  });

  function isSelected(opt: Option): boolean {
    if (multiple) return selectedMulti.includes(opt.value);
    return selectedSingle !== null && selectedSingle === opt.value;
  }

  const filtered = $derived.by((): Option[] => {
    // Async mode: the server is the source of truth — render whatever
    // the loader returned, no client-side narrowing.
    if (isAsync) return asyncOptions;
    if (!searchable || query.trim() === '') return options;
    const q = query.toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q));
  });

  const visibleIds = $derived.by(() => filtered.map((_, i) => `${baseId}-opt-${i}`));

  /** Trigger label for single-select, or fall back to placeholder. */
  const singleLabel = $derived.by(() => {
    if (selectedSingle === null) return '';
    const found = options.find((o) => o.value === selectedSingle);
    return found?.label ?? '';
  });

  function emit(v: T | T[] | null) {
    value = v;
    onchange?.(v);
  }

  function selectOption(opt: Option) {
    if (opt.disabled) return;
    if (multiple) {
      const cur = selectedMulti;
      const next = cur.includes(opt.value)
        ? cur.filter((v) => v !== opt.value)
        : [...cur, opt.value];
      emit(next);
      // Keep open for multi.
      void tick().then(() => searchEl?.focus());
    } else {
      // Close before emitting. The onchange handler can synchronously kick
      // off a re-render storm (FilterBar mutates the editor; ProjectSelector
      // refetches list screens) — running closeMenu first guarantees the
      // listbox hides regardless of how the parent reorganises its tree.
      closeMenu();
      const t = triggerEl;
      emit(opt.value);
      t?.focus();
    }
  }

  function removeMulti(v: T) {
    if (!multiple) return;
    emit(selectedMulti.filter((x) => x !== v));
  }

  async function openMenu() {
    if (disabled) return;
    open = true;
    highlightIdx = 0;
    query = '';
    if (isAsync) {
      // Don't carry stale results across opens — the empty-query reload
      // below will repopulate. We still want the spinner to show
      // immediately, so flip the flag here rather than waiting for the
      // $effect to schedule the call.
      asyncOptions = [];
      asyncLoading = true;
    }
    await tick();
    if (searchable) searchEl?.focus();
    setupFloating();
  }
  function closeMenu() {
    open = false;
    cleanupFloat?.();
    cleanupFloat = null;
    if (debounceHandle !== null) {
      clearTimeout(debounceHandle);
      debounceHandle = null;
    }
    // Bump the sequence so any in-flight load resolves into a no-op.
    loadSeq++;
    asyncLoading = false;
  }

  /**
   * Dispatch one async load. Guarded by `loadSeq` so a slower previous
   * request can't clobber a fresher result. Errors are swallowed (the
   * loader's caller is expected to surface them via toast / its own UI).
   */
  async function runLoad(q: string): Promise<void> {
    if (loadOptions === undefined) return;
    const seq = ++loadSeq;
    asyncLoading = true;
    try {
      const r = await loadOptions(q);
      if (seq !== loadSeq) return;
      asyncOptions = r;
    } catch {
      if (seq !== loadSeq) return;
      asyncOptions = [];
    } finally {
      if (seq === loadSeq) asyncLoading = false;
    }
  }

  // Drive async loads from `query`. Empty query (the just-opened state)
  // fires immediately; non-empty (the user typed) debounces 180ms.
  $effect(() => {
    if (!isAsync) return;
    if (!open) return;
    const q = query;
    if (debounceHandle !== null) clearTimeout(debounceHandle);
    const delay = q === '' ? 0 : 180;
    debounceHandle = setTimeout(() => {
      debounceHandle = null;
      void runLoad(q);
    }, delay);
  });

  function setupFloating() {
    if (!triggerEl || !popupEl) return;
    cleanupFloat?.();
    cleanupFloat = autoUpdate(triggerEl, popupEl, () => {
      if (!triggerEl || !popupEl) return;
      void computePosition(triggerEl, popupEl, {
        placement: 'bottom-start',
        middleware: [
          offset(4),
          flip(),
          flSize({
            apply({ rects, elements, availableHeight }) {
              Object.assign(elements.floating.style, {
                minWidth: `${rects.reference.width}px`,
                maxHeight: `${Math.max(140, availableHeight - 8)}px`,
              });
            },
          }),
        ],
      }).then(({ x, y }) => {
        if (!popupEl) return;
        // Reveal the popup only after the first position resolves —
        // otherwise it briefly renders at the (0,0) initial style and
        // the user sees a flash to the top-left of the screen. We use
        // opacity (not `visibility: hidden`) because the latter makes the
        // search input non-focusable, which would silently break the
        // openMenu auto-focus on `searchEl`.
        Object.assign(popupEl.style, {
          left: `${x}px`,
          top: `${y}px`,
          opacity: '1',
          pointerEvents: 'auto',
        });
      });
    });
  }

  function moveHighlight(delta: number) {
    if (filtered.length === 0) return;
    let i = highlightIdx + delta;
    // Skip disabled
    for (let attempts = 0; attempts < filtered.length; attempts++) {
      if (i < 0) i = filtered.length - 1;
      if (i >= filtered.length) i = 0;
      const opt = filtered[i];
      if (opt && !opt.disabled) {
        highlightIdx = i;
        return;
      }
      i += delta > 0 ? 1 : -1;
    }
  }

  function onTriggerKeydown(e: KeyboardEvent) {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void openMenu();
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        closeMenu();
      }
    }
  }

  function onMenuKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveHighlight(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveHighlight(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = filtered[highlightIdx];
      if (opt) selectOption(opt);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
      triggerEl?.focus();
    } else if (e.key === 'Tab') {
      closeMenu();
    } else if (e.key === 'Home') {
      e.preventDefault();
      highlightIdx = 0;
    } else if (e.key === 'End') {
      e.preventDefault();
      highlightIdx = Math.max(0, filtered.length - 1);
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
      return () => {
        document.removeEventListener('pointerdown', onDocPointerDown, true);
      };
    }
    return undefined;
  });

  $effect(() => {
    // Reset highlight when filter changes.
    void filtered;
    if (highlightIdx >= filtered.length) highlightIdx = 0;
  });

  $effect(() => {
    return () => {
      cleanupFloat?.();
    };
  });

  const activeDescendant = $derived(open ? visibleIds[highlightIdx] : undefined);
</script>

<div class={cx('relative inline-block w-full', klass)}>
  <button
    bind:this={triggerEl}
    type="button"
    role="combobox"
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls="{baseId}-listbox"
    aria-activedescendant={activeDescendant}
    aria-label={ariaLabel}
    {disabled}
    class={cx(
      'flex w-full items-center justify-between gap-2 rounded-md border border-border bg-bg px-2 py-1.5 text-left text-sm text-fg',
      'min-h-[2.25rem] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      disabled && 'cursor-not-allowed opacity-50',
    )}
    onclick={() => (open ? closeMenu() : openMenu())}
    onkeydown={onTriggerKeydown}
  >
    <span class="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      {#if multiple}
        {#if selectedMulti.length === 0}
          <span class="text-muted">{placeholder}</span>
        {:else}
          {#each selectedMulti as v (v)}
            {@const opt = options.find((o) => o.value === v)}
            <Chip
              label={opt?.label ?? String(v)}
              removable
              onRemove={() => removeMulti(v)}
            />
          {/each}
        {/if}
      {:else if selectedSingle !== null && singleLabel !== ''}
        <span class="truncate">{singleLabel}</span>
      {:else if selectedSingle !== null}
        <!-- A value is set but its label hasn't been resolved (typical
             for async ref:* loaders before the dropdown has opened). Show
             a stable id-style fallback so the row reads as "set" rather
             than "empty". -->
        <span class="truncate text-muted">#{String(selectedSingle)}</span>
      {:else}
        <span class="text-muted">{placeholder}</span>
      {/if}
    </span>
    <svg viewBox="0 0 12 12" class="h-3 w-3 shrink-0 text-muted" aria-hidden="true">
      <path
        d="M2 4 L6 8 L10 4"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        fill="none"
      />
    </svg>
  </button>

  {#if open}
    <div
      bind:this={popupEl}
      class="z-50 flex flex-col overflow-hidden rounded-md border border-border bg-bg shadow-lg"
      style="position: fixed; left: 0; top: 0; opacity: 0; pointer-events: none;"
    >
      {#if searchable}
        <div class="border-b border-border p-1.5">
          <input
            bind:this={searchEl}
            bind:value={query}
            type="text"
            placeholder="Search…"
            class="w-full rounded border border-border bg-bg px-2 py-1 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onkeydown={onMenuKeydown}
          />
        </div>
      {/if}
      <ul
        id="{baseId}-listbox"
        role="listbox"
        aria-multiselectable={multiple}
        class="flex-1 overflow-auto py-1 text-sm"
        onkeydown={onMenuKeydown}
        tabindex={searchable ? -1 : 0}
      >
        {#if filtered.length === 0}
          <li class="px-3 py-2 text-muted">
            {#if isAsync && asyncLoading}
              Loading…
            {:else}
              No matches
            {/if}
          </li>
        {:else}
          {#each filtered as opt, i (opt.value)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <li
              id={visibleIds[i]}
              role="option"
              aria-selected={isSelected(opt)}
              aria-disabled={opt.disabled || undefined}
              class={cx(
                'flex cursor-pointer items-center gap-2 px-3 py-1.5',
                i === highlightIdx ? 'bg-surface' : '',
                isSelected(opt) ? 'font-medium text-accent' : 'text-fg',
                opt.disabled && 'cursor-not-allowed opacity-50',
              )}
              onpointerenter={() => (highlightIdx = i)}
              onclick={() => selectOption(opt)}
            >
              {#if multiple}
                <span
                  class={cx(
                    'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                    isSelected(opt)
                      ? 'border-accent bg-accent text-accent-fg'
                      : 'border-border bg-bg',
                  )}
                  aria-hidden="true"
                >
                  {#if isSelected(opt)}
                    <svg viewBox="0 0 10 10" class="h-2.5 w-2.5">
                      <path
                        d="M2 5 L4 7 L8 3"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        fill="none"
                      />
                    </svg>
                  {/if}
                </span>
              {/if}
              <span class="truncate">{opt.label}</span>
            </li>
          {/each}
        {/if}
      </ul>
    </div>
  {/if}
</div>
