/**
 * DropPlaceholder + computeDropTarget (#1 / #5) — the shared animated drop
 * affordance for the Kanban columns and the Inbox list.
 *
 * A single gliding overlay bar shows WHERE a dragged card/row will land. It is
 * appended into a virtualList scroll VIEWPORT (a `position: relative;
 * overflow-y: auto` box) and positioned in that viewport's CONTENT coordinate
 * space: the list lays its pooled slots out so the item at absolute index N
 * sits at `y = N * rowHeight`, and the bar lives in the same space, so a
 * `transform: translateY(y)` drops it exactly into the gap between two items. A
 * CSS transition on `transform` makes the bar GLIDE between insertion points as
 * the pointer moves; dropping past the last item parks it at the end ("drag to
 * end").
 *
 * Why an overlay bar rather than a real opening gap: the virtualList pins each
 * pooled slot to a fixed `i * rowHeight` and swaps slot CONTENT in place on a
 * reorder (it never moves the slot nodes), so a true FLIP "the cards slide
 * apart" is not available without rewriting the core list. The gliding bar plus
 * a short drop-settle pulse on the landed item give the drag its spatial
 * feedback within that constraint.
 *
 * Shim-safe: every DOM mutation guards the method's presence, so the unit-test
 * FakeElement (no layout, no `style.setProperty`, no `remove`) degrades to a
 * graceful no-op.
 */

export interface DropTarget {
  /** Insertion slot among the NON-dragged items (0 … visibleCount). Matches the
   *  count the kanban/inbox drop logic uses, so callers can reuse it directly. */
  slot: number;
  /** Content-space y (px from the viewport's top) for the placeholder bar:
   *  the top edge of the insertion gap (or the bottom of the last item). */
  y: number;
}

export class DropPlaceholder {
  private readonly el: HTMLElement;
  private shown = false;
  private pulseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(viewport: HTMLElement, opts: { className?: string } = {}) {
    this.el = document.createElement('div');
    this.el.className = `drop-placeholder${opts.className ? ` ${opts.className}` : ''}`;
    this.el.dataset.dropPlaceholder = '';
    this.el.setAttribute('aria-hidden', 'true');
    setStyle(this.el, 'display', 'none');
    viewport.append?.(this.el);
  }

  /** Show the bar and glide it to content-space `y` (px from the viewport top). */
  showAtY(y: number): void {
    setStyle(this.el, 'display', 'block');
    setStyle(this.el, 'transform', `translateY(${Math.max(0, Math.round(y))}px)`);
    this.shown = true;
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    setStyle(this.el, 'display', 'none');
  }

  /** Brief "landed here" pulse, then hide. Safe to call on drop. */
  pulse(): void {
    const cl = this.el.classList as { add?(s: string): void; remove?(s: string): void } | undefined;
    cl?.add?.('drop-placeholder--drop');
    if (this.pulseTimer !== null) clearTimeout(this.pulseTimer);
    this.pulseTimer = setTimeout(() => {
      cl?.remove?.('drop-placeholder--drop');
      this.hide();
      this.pulseTimer = null;
    }, 240);
    // Don't keep a Node test process alive on the trailing timer (no-op in DOM).
    (this.pulseTimer as { unref?(): void }).unref?.();
  }

  destroy(): void {
    if (this.pulseTimer !== null) clearTimeout(this.pulseTimer);
    this.el.remove?.();
  }
}

/**
 * Resolve the insertion point for a pointer at `clientY` over a list viewport.
 * Iterates the VISIBLE item nodes (matching `itemSelector`, skipping the dragged
 * one and parked `display:none` pool slots), comparing the pointer to each
 * node's vertical midpoint. Returns the insertion slot plus the content-space y
 * for the placeholder bar — the top of the item the dragged one would land
 * before, or the bottom of the last item for an end drop. Geometric (uses
 * `getBoundingClientRect`), so it stays correct regardless of scroll position or
 * which window the virtualList currently renders. No layout (shim) →
 * `{ slot: 0, y: 0 }`.
 */
export function computeDropTarget(
  viewport: HTMLElement,
  clientY: number,
  draggedId: string,
  itemSelector: string,
  accept: (cardId: string) => boolean = () => true,
): DropTarget {
  const vrect = viewport.getBoundingClientRect?.();
  if (!vrect) return { slot: 0, y: 0 };
  const scrollTop = viewport.scrollTop || 0;
  const nodes = (viewport.querySelectorAll?.(itemSelector) ?? []) as unknown as HTMLElement[];
  let slot = 0;
  let lastBottomY = 0;
  for (const node of nodes) {
    if (node.style?.display === 'none') continue;
    if (node.dataset?.cardId === draggedId) continue;
    // Group-scoped drag (grouped inbox): only same-group rows count, so the slot
    // + bar clamp to the group's span — a drop never crosses a group boundary.
    if (!accept(node.dataset?.cardId ?? '')) continue;
    const rect = node.getBoundingClientRect?.();
    if (!rect || (rect.top === 0 && rect.bottom === 0)) continue;
    const topY = rect.top - vrect.top + scrollTop;
    lastBottomY = rect.bottom - vrect.top + scrollTop;
    const mid = rect.top + rect.height / 2;
    if (clientY < mid) return { slot, y: topY };
    slot += 1;
  }
  // Past every item → insert at the end.
  return { slot, y: lastBottomY };
}

/**
 * Replay a one-shot "settle" animation class on the card/row that just moved
 * (#candy). The virtualList content-swaps slots in place, so the dragged item
 * doesn't slide to its new home — this gives the eye a place to land: a quick
 * scale-settle keyframe on whichever pooled node now shows the moved item.
 *
 * `on` is true only for that item's fill; every other fill clears the class so a
 * recycled node never keeps a stale animation. When `on`, we force a reflow
 * between remove + add so the keyframes restart even on a node already in the
 * DOM (the Inbox reuses its pool; the Kanban rebuilds it — both work). Shim-safe.
 */
export function applySettle(el: HTMLElement, className: string, on: boolean): void {
  const cl = el.classList as { add?(s: string): void; remove?(s: string): void } | undefined;
  if (!cl?.add || !cl.remove) return;
  // Always clear first: a recycled node may carry a finished animation's class,
  // which would otherwise suppress the next settle. `on` is false for every fill
  // except the moved item's, so this is also the recycle cleanup.
  cl.remove(className);
  if (!on) return;
  // Reading a layout property flushes styles so re-adding the class restarts the
  // keyframes even on a node already in the DOM (no-op under the layout-less
  // shim, where there's no animation to restart).
  void (el as { offsetHeight?: number }).offsetHeight;
  cl.add(className);
  // Drop the class when the animation ends so the node starts clean next time
  // (the shim never fires animationend, so the class persists for assertions).
  if (typeof el.addEventListener === 'function') {
    el.addEventListener('animationend', () => cl.remove?.(className), { once: true });
  }
}

/**
 * FLIP slide for a recycling list (kanban columns / inbox rows). The list pins
 * each pooled slot with `transform: translateY(slotY)` and swaps slot CONTENT in
 * place on a reorder, so a card "teleports" to its new slot. This animates the
 * gap: `capture()` records each visible item's screen position (by
 * `data-card-id`) BEFORE the reorder; `play()` (next frame, after the re-render)
 * slides whichever node now shows each item from its old position to its new one
 * by composing the delta into the list's own `translateY` (so we never fight the
 * list's positioning) via the Web Animations API.
 *
 * Only NEAR-VERTICAL moves animate: a large horizontal delta means the item
 * changed column/list, whose slide would clip at the container edge — those keep
 * the settle ring instead. Shim-safe: no `getBoundingClientRect` / `animate`
 * (the test DOM) → a graceful no-op.
 */
export class FlipAnimator {
  private first: Map<string, { top: number; left: number }> | null = null;

  constructor(
    private readonly root: () => HTMLElement | null,
    private readonly selector: string,
  ) {}

  /** Record visible item positions before the reorder mutates the DOM. */
  capture(): void {
    const map = new Map<string, { top: number; left: number }>();
    const nodes = (this.root()?.querySelectorAll?.(this.selector) ?? []) as unknown as HTMLElement[];
    for (const n of nodes) {
      if (n.style?.display === 'none') continue;
      const id = n.dataset?.cardId;
      const rect = n.getBoundingClientRect?.();
      if (id !== undefined && id !== '' && rect) map.set(id, { top: rect.top, left: rect.left });
    }
    this.first = map;
  }

  /** Slide each item from its captured position to its new one. Call AFTER the
   *  re-render (e.g. from requestAnimationFrame). */
  play(): void {
    const first = this.first;
    this.first = null;
    if (first === null) return;
    const nodes = (this.root()?.querySelectorAll?.(this.selector) ?? []) as unknown as HTMLElement[];
    for (const n of nodes) {
      if (n.style?.display === 'none' || typeof n.animate !== 'function') continue;
      const id = n.dataset?.cardId;
      if (id === undefined) continue;
      const old = first.get(id);
      const rect = n.getBoundingClientRect?.();
      if (old === undefined || !rect) continue;
      const dy = old.top - rect.top;
      // Unchanged, or a column/list change (large horizontal delta) → don't slide.
      if (Math.abs(dy) < 1 || Math.abs(old.left - rect.left) > 4) continue;
      // Compose the slide into the list's own translateY so positioning holds.
      const m = /translateY\(([-0-9.]+)px\)/.exec(n.style?.transform ?? '');
      const baseY = m ? parseFloat(m[1]!) : 0;
      n.animate(
        [{ transform: `translateY(${baseY + dy}px)` }, { transform: `translateY(${baseY}px)` }],
        { duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
      );
    }
  }
}

/** Set one style property, guarding the test shim (no `setProperty`). */
function setStyle(el: HTMLElement, prop: string, value: string): void {
  const s = el.style as (CSSStyleDeclaration & { setProperty?: (p: string, v: string) => void }) | undefined;
  if (s && typeof s.setProperty === 'function') s.setProperty(prop, value);
  else if (s) (s as unknown as Record<string, string>)[styleKey(prop)] = value;
}
function styleKey(prop: string): string {
  return prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}
