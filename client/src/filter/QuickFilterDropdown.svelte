<script lang="ts">
  /**
   * Per-attribute quick-filter dropdown.
   *
   * Renders as a compact pill button labelled with the attribute name
   * (and the active selection when one exists). Clicking opens a
   * multi-select checkbox list of the attribute's options; choices
   * write/replace a single `eq` / `in` leaf in the bound predicate.
   * Clearing all selections strips the leaf.
   *
   * Designed for the FilterBar quick-filter row — the chip-strip row
   * was replaced with these so each common attribute (Assignee /
   * Milestone / Component / Tag / Priority) has its own pinned picker
   * instead of forcing the user through "+ Add filter".
   */
  import { tick } from 'svelte';
  import {
    autoUpdate,
    computePosition,
    flip,
    offset,
  } from '@floating-ui/dom';
  import { cx } from '../util/class_names';
  import type { FilterAttribute } from './attribute_schema.svelte';
  import {
    eq,
    in_,
    isFlatAndOfLeaves,
    type Predicate,
    type PredicateLeaf,
  } from './predicate';

  interface Props {
    attribute: FilterAttribute;
    predicate: Predicate | null;
    onchange: (p: Predicate | null) => void;
  }

  let { attribute, predicate, onchange }: Props = $props();

  /* -------------------------------------------------- read current leaf --- */

  function findLeaf(p: Predicate | null, attr: string): PredicateLeaf | null {
    if (p === null) return null;
    if (p.kind === 'leaf') return p.attr === attr ? p : null;
    if (p.connective !== 'and') return null;
    for (const c of p.children) {
      if (c.kind === 'leaf' && c.attr === attr) return c;
    }
    return null;
  }

  const currentValues = $derived.by((): unknown[] => {
    const leaf = findLeaf(predicate, attribute.name);
    if (leaf === null) return [];
    if (leaf.op !== 'eq' && leaf.op !== 'in') return [];
    return leaf.values ?? [];
  });

  const selectedCount = $derived(currentValues.length);

  /**
   * Trigger label: attribute name when nothing picked, plus a colon +
   * value preview when 1 picked, plus a "+N" overflow when more.
   */
  const triggerLabel = $derived.by((): string => {
    if (selectedCount === 0) return attribute.label;
    const opts = attribute.options ?? [];
    const first = currentValues[0];
    const firstLabel = opts.find((o) => o.value === first)?.label ?? String(first);
    if (selectedCount === 1) return `${attribute.label}: ${firstLabel}`;
    return `${attribute.label}: ${firstLabel} +${selectedCount - 1}`;
  });

  /* ------------------------------------------------------ commit a leaf --- */

  function emit(next: Predicate | null): void {
    onchange(next);
  }

  function stripLeaf(p: Predicate | null, attr: string): Predicate | null {
    if (p === null) return null;
    if (p.kind === 'leaf') return p.attr === attr ? null : p;
    if (p.connective !== 'and') return p;
    const remaining = p.children.filter(
      (c) => !(c.kind === 'leaf' && c.attr === attr),
    );
    if (remaining.length === 0) return null;
    if (remaining.length === 1) return remaining[0] as Predicate;
    return { kind: 'group', connective: 'and', children: remaining };
  }

  function replaceLeaf(p: Predicate | null, leaf: PredicateLeaf): Predicate {
    if (p === null) return leaf;
    if (p.kind === 'leaf') {
      if (p.attr === leaf.attr) return leaf;
      return { kind: 'group', connective: 'and', children: [p, leaf] };
    }
    if (p.connective !== 'and') {
      // Non-flat trees fall through unchanged; the FilterBar still owns
      // the Advanced editor for those.
      return p;
    }
    const others = p.children.filter(
      (c) => !(c.kind === 'leaf' && c.attr === leaf.attr),
    );
    const next = [...others, leaf];
    if (next.length === 1) return next[0] as Predicate;
    return { kind: 'group', connective: 'and', children: next };
  }

  function commit(values: unknown[]): void {
    if (values.length === 0) {
      emit(stripLeaf(predicate, attribute.name));
      return;
    }
    const leaf: PredicateLeaf =
      values.length === 1
        ? eq(attribute.name, values[0])
        : in_(attribute.name, values);
    if (predicate !== null && !isFlatAndOfLeaves(predicate)) {
      // Don't mutate complex trees from here. The Advanced editor is the
      // right tool; we still emit so the parent can route. For safety,
      // bail with no change.
      return;
    }
    emit(replaceLeaf(predicate, leaf));
  }

  function toggle(v: unknown): void {
    const cur = currentValues.slice();
    const idx = cur.indexOf(v);
    if (idx >= 0) cur.splice(idx, 1);
    else cur.push(v);
    commit(cur);
  }

  function clearAll(): void {
    commit([]);
  }

  /* -------------------------------------------------------- popover UX --- */

  let open = $state(false);
  let query = $state('');
  let triggerEl: HTMLButtonElement | null = $state(null);
  let popupEl: HTMLDivElement | null = $state(null);
  let searchEl: HTMLInputElement | null = $state(null);
  let cleanupFloat: (() => void) | null = null;

  const options = $derived(attribute.options ?? []);
  const filteredOptions = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  });

  async function openMenu(): Promise<void> {
    open = true;
    query = '';
    await tick();
    if (!triggerEl || !popupEl) return;
    cleanupFloat?.();
    cleanupFloat = autoUpdate(triggerEl, popupEl, () => {
      if (!triggerEl || !popupEl) return;
      void computePosition(triggerEl, popupEl, {
        placement: 'bottom-start',
        middleware: [offset(4), flip()],
      }).then(({ x, y }) => {
        if (!popupEl) return;
        Object.assign(popupEl.style, {
          left: `${x}px`,
          top: `${y}px`,
          opacity: '1',
          pointerEvents: 'auto',
        });
      });
    });
    if (options.length > 8) searchEl?.focus();
  }

  function closeMenu(): void {
    open = false;
    cleanupFloat?.();
    cleanupFloat = null;
  }

  function onDocPointerDown(e: PointerEvent): void {
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
    return () => {
      cleanupFloat?.();
    };
  });

  function isChecked(v: unknown): boolean {
    return currentValues.includes(v);
  }
</script>

<div class="relative inline-block">
  <button
    bind:this={triggerEl}
    type="button"
    class={cx(
      'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium',
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      selectedCount > 0
        ? 'border-accent bg-accent/15 text-accent'
        : 'border-border bg-surface text-fg hover:bg-border/40',
    )}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label="Filter by {attribute.label}"
    data-testid="quick-filter-{attribute.name}"
    onclick={() => (open ? closeMenu() : void openMenu())}
  >
    <span class="truncate">{triggerLabel}</span>
    <svg viewBox="0 0 12 12" class="h-3 w-3 shrink-0" aria-hidden="true">
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
      class="z-50 flex w-64 flex-col overflow-hidden rounded-md border border-border bg-bg shadow-lg"
      style="position: fixed; left: 0; top: 0; opacity: 0; pointer-events: none;"
      role="dialog"
      aria-label="Filter {attribute.label}"
    >
      {#if options.length > 8}
        <div class="border-b border-border p-1.5">
          <input
            bind:this={searchEl}
            type="text"
            placeholder="Search…"
            bind:value={query}
            class="w-full rounded border border-border bg-bg px-2 py-1 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </div>
      {/if}

      <ul class="max-h-64 overflow-auto py-1 text-sm" role="listbox" aria-multiselectable="true">
        {#if filteredOptions.length === 0}
          <li class="px-3 py-2 text-muted">No options</li>
        {:else}
          {#each filteredOptions as opt (String(opt.value))}
            {@const checked = isChecked(opt.value)}
            <li>
              <button
                type="button"
                role="option"
                aria-selected={checked}
                class="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left hover:bg-surface focus:outline-none focus-visible:bg-surface"
                onclick={() => toggle(opt.value)}
              >
                <span
                  class={cx(
                    'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                    checked
                      ? 'border-accent bg-accent text-accent-fg'
                      : 'border-border bg-bg',
                  )}
                  aria-hidden="true"
                >
                  {#if checked}
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
                <span class="truncate">{opt.label}</span>
              </button>
            </li>
          {/each}
        {/if}
      </ul>

      {#if selectedCount > 0}
        <div class="border-t border-border p-1.5">
          <button
            type="button"
            class="w-full rounded px-2 py-1 text-xs text-muted hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onclick={clearAll}
          >Clear</button>
        </div>
      {/if}
    </div>
  {/if}
</div>
