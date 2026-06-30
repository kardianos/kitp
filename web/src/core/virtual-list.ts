/**
 * Recycling virtual list — a windowed renderer that NEVER scrolls rows.
 *
 * Owner directive: "All lists should use a virtual grid control that doesn't
 * scroll rows but swaps the content from a fixed number of rows — this prevents
 * flashing." So this is a RECYCLING list, not a create/destroy reconciler:
 *
 *   - A sizing SPACER (height = total × rowHeight) drives the native scrollbar.
 *   - A FIXED POOL of `ceil(viewportH/rowHeight) + overscan` row elements is
 *     created ONCE. On scroll the pool is REPOSITIONED via `transform:
 *     translateY(...)` and its CONTENT is swapped (`update(el, item, index)`).
 *     The same DOM nodes are reused for every window — no node is created or
 *     destroyed per scroll, so there is no flash. Node count is constant
 *     regardless of list length.
 *
 * Contrast with `keyed-list.ts`, which creates/moves/destroys one node per item
 * (focus-preserving reconciliation, the `{#each (key)}` equivalent). This
 * primitive mirrors that factory's SHAPE so a parent can swap one for the other
 * in the integration pass (see the INTEGRATION CONTRACT note at the bottom).
 *
 * Cascade-safety (the whole point of the signal core): the single effect reads
 * ONLY `data()` and writes ONLY DOM — it never writes a tracked signal, so it
 * can't re-trigger itself. The scroll handler is a plain DOM listener that also
 * only touches DOM. See `signal.ts` for the cascade rules this obeys.
 *
 * v1 assumes a FIXED `rowHeight` (px). Variable-height rows are a future
 * extension: replace `computeWindow`'s arithmetic with a prefix-sum / measured
 * offset table and have the spacer/translate read measured offsets instead of
 * `index * rowHeight`. The DOM recycling layer below is otherwise unchanged.
 */

import { effect } from './signal.js';

/* -------------------------------------------------------------------------- */
/* Pure windowing math — unit-tested directly, no DOM.                        */
/* -------------------------------------------------------------------------- */

export interface WindowInput {
  /** Current viewport scroll offset, px. */
  scrollTop: number;
  /** Visible viewport height, px. */
  viewportHeight: number;
  /** Fixed row height, px (> 0). */
  rowHeight: number;
  /** Total item count. */
  total: number;
  /** Extra rows rendered above+below the viewport to mask scroll latency. */
  overscan: number;
}

export interface WindowResult {
  /** Index of the first item to render (clamped to [0, total)). */
  firstIndex: number;
  /** How many items to render (clamped so firstIndex+renderCount ≤ total). */
  renderCount: number;
  /** Pixel offset of the first rendered row from the top of the content. */
  offsetTop: number;
  /** Total scrollable content height (drives the spacer / scrollbar). */
  spacerHeight: number;
}

/**
 * Compute the visible window from the scroll position. PURE — the recycling DOM
 * layer binds this, and it's unit-tested in isolation.
 *
 * `renderCount` is the count of items the window covers for THIS total; it is
 * NOT the pool size. The pool is sized once to the worst case
 * (`poolSize(viewportHeight, rowHeight, overscan)`) and the DOM layer hides the
 * tail when `renderCount` is smaller (short list / near the end).
 */
export function computeWindow(input: WindowInput): WindowResult {
  const { scrollTop, viewportHeight, rowHeight, total, overscan } = input;

  // Degenerate inputs: nothing to show, nothing to scroll.
  if (rowHeight <= 0 || total <= 0) {
    return { firstIndex: 0, renderCount: 0, offsetTop: 0, spacerHeight: 0 };
  }

  const spacerHeight = total * rowHeight;

  // Clamp scrollTop into the legal range so an over-scroll (rubber-band, or a
  // shrink that left scrollTop past the new end) never produces a negative or
  // out-of-range first index.
  const maxScroll = Math.max(0, spacerHeight - viewportHeight);
  const clampedScroll = Math.min(Math.max(scrollTop, 0), maxScroll);

  // First item whose top edge is at/above the viewport top, minus overscan.
  const rawFirst = Math.floor(clampedScroll / rowHeight) - overscan;
  const firstIndex = Math.max(0, Math.min(rawFirst, total - 1));

  // Rows needed to cover the viewport, plus overscan on BOTH sides.
  const visibleRows = Math.ceil(viewportHeight / rowHeight);
  const want = visibleRows + overscan * 2;

  // Don't render past the end.
  const renderCount = Math.max(0, Math.min(want, total - firstIndex));

  const offsetTop = firstIndex * rowHeight;

  return { firstIndex, renderCount, offsetTop, spacerHeight };
}

/**
 * Pool size: the maximum rows the viewport can ever need at once. Sized once
 * (and on resize), independent of total length or scroll position. Matches the
 * worst-case `renderCount` from `computeWindow` (full viewport + overscan both
 * sides) plus one guard row for sub-pixel/partial-row coverage.
 */
export function poolSize(viewportHeight: number, rowHeight: number, overscan: number): number {
  if (rowHeight <= 0) return 0;
  return Math.ceil(viewportHeight / rowHeight) + overscan * 2 + 1;
}

/* -------------------------------------------------------------------------- */
/* The recycling DOM layer.                                                   */
/* -------------------------------------------------------------------------- */

export interface VirtualListOptions<Item> {
  /** The scroll viewport element. Must be a positioned, overflow-y:auto box. */
  container: HTMLElement;
  /** Fixed row height in px (v1). */
  rowHeight: number;
  /** Reactive item list (reads a signal / tree leaf). */
  data: () => Item[];
  /**
   * Build a pooled row's DOM ONCE. Optional — default creates a bare <div>.
   * Called exactly `poolSize` times (and again only if a resize grows the pool).
   * Do NOT put item-specific content here; that goes in `update`.
   */
  create?: (el: HTMLElement) => void;
  /** Swap content into a recycled row for the item now at `index`. */
  update: (el: HTMLElement, item: Item, index: number) => void;
  /**
   * Optional stable key per item+index. When provided, `update` is skipped for
   * a pooled slot whose key is unchanged since its last render — the cheap path
   * for a pure scroll where the same item stays in the same physical slot.
   */
  key?: (item: Item, index: number) => string;
  /** Extra rows above+below the viewport. Default 4. */
  overscan?: number;
  /** Debug name for the underlying effect. */
  name?: string;
}

export interface VirtualListHandle {
  /** Tear down: remove the scroll listener, ResizeObserver, and the effect. */
  dispose(): void;
  /** Force a re-window + re-render of the current data (e.g. after a resize). */
  refresh(): void;
}

interface Slot {
  el: HTMLElement;
  /** Index this slot currently shows, or -1 when parked/hidden. */
  index: number;
  /** Last key rendered into this slot (for the key-skip fast path). */
  key: string | null;
}

const DEFAULT_OVERSCAN = 4;

/** Minimal structural type for the ResizeObserver we optionally use. */
interface ResizeObserverLike {
  observe(target: Element): void;
  disconnect(): void;
}

export function virtualList<Item>(opts: VirtualListOptions<Item>): VirtualListHandle {
  const overscan = opts.overscan ?? DEFAULT_OVERSCAN;
  const rowHeight = opts.rowHeight;
  const name = opts.name ?? 'virtualList';

  const { container } = opts;
  // The viewport scrolls; the spacer sizes the scrollable content; rows live in
  // a content layer translated to sit at the window's offset.
  container.style.position = container.style.position || 'relative';
  container.style.overflowY = container.style.overflowY || 'auto';

  const spacer = document.createElement('div');
  spacer.dataset.role = 'vlist-spacer';
  spacer.style.position = 'relative';
  spacer.style.width = '100%';

  const content = document.createElement('div');
  content.dataset.role = 'vlist-content';
  content.style.position = 'absolute';
  content.style.top = '0';
  content.style.left = '0';
  content.style.right = '0';
  // No `will-change: transform` here: permanently promoting the content layer
  // rasterizes the row text into a GPU backing texture that, at fractional
  // display scaling, gets resampled and reads as blurry at rest. The translate
  // still works composited-on-demand; the recycling pool repaints content on
  // every scroll anyway, so pre-promotion bought little.

  spacer.append(content);
  container.append(spacer);

  /** The fixed recycling pool. Grown only on resize, never shrunk per scroll. */
  const pool: Slot[] = [];

  function viewportHeight(): number {
    // clientHeight is the content box height of the scroll viewport.
    return container.clientHeight || 0;
  }

  function makeSlot(): Slot {
    const el = document.createElement('div');
    el.dataset.role = 'vlist-row';
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.right = '0';
    el.style.height = `${rowHeight}px`;
    // Start hidden: a freshly-grown slot the current window doesn't use must
    // not flash on screen until a render assigns it an item.
    el.style.display = 'none';
    if (opts.create) opts.create(el);
    content.append(el);
    return { el, index: -1, key: null };
  }

  /** Ensure the pool holds at least `n` slots. Never removes slots. */
  function ensurePool(n: number): void {
    while (pool.length < n) pool.push(makeSlot());
  }

  /** Park a slot: hide it and forget what it showed (recycle on next render). */
  function parkSlot(slot: Slot): void {
    if (slot.el.style.display === 'none' && slot.index === -1) return;
    slot.el.style.display = 'none';
    slot.index = -1;
    slot.key = null;
  }

  /**
   * The render pass: compute the window for the current scroll + data, size the
   * spacer, then position + content-swap pooled rows. Reuses slot DOM nodes —
   * no node is created or destroyed here (creation only happens in ensurePool,
   * which is driven by resize / initial sizing, not by scroll).
   */
  function render(items: Item[]): void {
    const total = items.length;
    const win = computeWindow({
      scrollTop: container.scrollTop || 0,
      viewportHeight: viewportHeight(),
      rowHeight,
      total,
      overscan,
    });

    // Size the spacer so the native scrollbar reflects the full list length.
    spacer.style.height = `${win.spacerHeight}px`;
    // Translate the content layer so the rendered window sits at its offset.
    content.style.transform = `translateY(${win.offsetTop}px)`;

    // The pool must cover the window. Worst case is bounded by poolSize(); a
    // window can never exceed it, but ensurePool is idempotent and cheap.
    ensurePool(win.renderCount);

    // Fill the first `renderCount` slots with the windowed items; park the rest.
    for (let i = 0; i < pool.length; i++) {
      const slot = pool[i]!;
      if (i >= win.renderCount) {
        parkSlot(slot);
        continue;
      }
      const index = win.firstIndex + i;
      const item = items[index]!;
      const k = opts.key ? opts.key(item, index) : null;

      // Position the row at its slot-local offset within the content layer.
      // (content is already translated to offsetTop, so row i sits at i*rowH.)
      slot.el.style.transform = `translateY(${i * rowHeight}px)`;
      if (slot.el.style.display === 'none') slot.el.style.display = '';

      // Key-skip fast path: same item in the same physical slot → no content
      // churn. Falls through to update() whenever index OR key changed.
      const sameSlotItem = slot.index === index && k !== null && slot.key === k;
      if (!sameSlotItem) {
        opts.update(slot.el, item, index);
        slot.index = index;
        slot.key = k;
      }
    }
  }

  /** Re-read data and render. Called by the effect, scroll, and resize. */
  function rerender(): void {
    render(currentItems);
  }

  // The reactive item snapshot, kept so scroll/resize can re-window WITHOUT
  // re-reading (and re-subscribing to) the data signal. Only the effect reads
  // data() and thus owns the subscription.
  let currentItems: Item[] = [];

  /* ---- the single cascade-safe effect: reads data(), writes only DOM ---- */
  const disposeEffect = effect(() => {
    currentItems = opts.data() ?? [];
    rerender();
  }, name);

  /* ---- scroll: a plain DOM listener, never a signal write ---- */
  const onScroll = (): void => {
    rerender();
  };
  container.addEventListener('scroll', onScroll, { passive: true });

  /* ---- resize: recompute pool size, then re-window ---- */
  let ro: ResizeObserverLike | null = null;
  const onResize = (): void => {
    ensurePool(poolSize(viewportHeight(), rowHeight, overscan));
    rerender();
  };
  // ResizeObserver may be absent (older env / test shim without it); the
  // initial sizing below still establishes the pool, and scroll keeps it fresh.
  const ROCtor = (globalThis as { ResizeObserver?: new (cb: () => void) => ResizeObserverLike })
    .ResizeObserver;
  if (typeof ROCtor === 'function') {
    ro = new ROCtor(() => onResize());
    ro.observe(container);
  }

  // Initial sizing: build the pool to the current viewport, then first render.
  ensurePool(poolSize(viewportHeight(), rowHeight, overscan));
  // (the effect already ran once synchronously in the Effect ctor and rendered
  // against currentItems = data(); ensurePool above only grows the pool if the
  // viewport needs more than the window did, so a final rerender keeps DOM and
  // the just-grown pool consistent.)
  rerender();

  return {
    dispose(): void {
      disposeEffect();
      container.removeEventListener('scroll', onScroll);
      if (ro) ro.disconnect();
      ro = null;
      spacer.remove();
      pool.length = 0;
    },
    refresh(): void {
      onResize();
    },
  };
}
