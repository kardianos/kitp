/**
 * Focus management for modal overlays (#29) — trap Tab within an open overlay
 * and restore focus to the opener on close.
 *
 * `trapFocus(container)` wires a capture-phase keydown that wraps Tab /
 * Shift+Tab at the container's focusable boundary (and pulls stray focus back
 * in); it returns a disposer. `captureFocus()` snapshots the active element so
 * the caller can restore it after closing. Both are no-ops without a DOM, so
 * controls can call them unconditionally.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(container: HTMLElement): HTMLElement[] {
  // Skip own-hidden elements (the overlays collapse sections via `hidden` /
  // inline display:none). We avoid offsetParent/getComputedStyle so this works
  // under jsdom (no layout engine) as well as the real DOM.
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.hasAttribute('hidden')) return false;
    const style = el.style as { display?: string } | undefined;
    return style?.display !== 'none';
  });
}

/** Trap Tab focus within `container`. Returns a disposer that removes the trap. */
export function trapFocus(container: HTMLElement): () => void {
  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    const items = focusables(container);
    if (items.length === 0) return;
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (!container.contains(active as Node)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  container.addEventListener('keydown', onKeydown, true);
  return () => container.removeEventListener('keydown', onKeydown, true);
}

/** Snapshot the focused element; the returned fn restores focus to it. */
export function captureFocus(): () => void {
  const prev = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null;
  return () => prev?.focus?.();
}
