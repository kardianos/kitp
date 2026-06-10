/**
 * Full-row "open in a new tab" link.
 *
 * {@link rowLink} returns a real <a> that the owner stretches to cover its whole
 * row / card (CSS: `position:absolute; inset:0`). Because it is a real anchor,
 * ⌘/Ctrl-click, middle-click and right-click → "Open in new tab/window" all work
 * NATIVELY, anywhere on the row — the behaviour the browser already gives links.
 *
 * A plain left-click is handled in-place instead: `preventDefault` kills the
 * same-tab navigation and the event keeps bubbling to the row's own click
 * handler (the existing SPA open, which also publishes the prev/next nav list).
 * A modified / middle click is left to the browser, with `stopPropagation` so
 * the row does not ALSO open in-place.
 *
 * The overlay sits UNDER the row's interactive controls — checkboxes, selects,
 * drag grips — which the owner lifts above it with `z-index` so they still get
 * their own clicks. The href is set per fill via {@link setRowLinkHref} (pooled
 * rows recycle through many cards, so it can never be captured once).
 *
 * The link is `tabIndex=-1` + `aria-hidden`: the row itself is the labelled,
 * focusable target (Enter / `o` opens it in-place) — an extra focus stop per row
 * in a virtualised list of hundreds would wreck keyboard flow. It is also
 * `draggable=false` so a click-drag never starts a native link-drag that would
 * fight a row/card drag-to-reorder grip or the kanban card's native DnD.
 */

import { taskUrl } from './router.js';

export function rowLink(): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'row-link';
  a.tabIndex = -1;
  a.draggable = false;
  a.setAttribute('aria-hidden', 'true');
  a.addEventListener('click', (ev) => {
    const e = ev as MouseEvent;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      ev.stopPropagation(); // browser opens a new tab/window; don't open in-place too
      return;
    }
    ev.preventDefault(); // plain click → fall through to the row's in-place SPA open
  });
  return a;
}

/** Point a row link at a card. Re-set every fill — rows recycle. Uses
 *  setAttribute (not the `.href` property) so the href reflects to the attribute
 *  in the lightweight test DOM shim too. */
export function setRowLinkHref(a: HTMLAnchorElement, id: bigint | string): void {
  a.setAttribute('href', taskUrl(id));
}
