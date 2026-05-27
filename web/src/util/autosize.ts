/**
 * Auto-grow a `<textarea>` to fit its content, capped at a max height.
 *
 * Pure DOM helper (no listener bookkeeping) — call it once after mount and from
 * an `input` listener the host control wires via `this.listen`, so cleanup stays
 * with the control. The cap defaults to ~45% of the viewport so a long body
 * scrolls internally instead of pushing the page; below the cap there is no
 * scrollbar and the field grows line-by-line with the number of newlines/wrap.
 */
export function fitTextarea(ta: HTMLTextAreaElement, maxPx?: number): void {
  const vh = typeof globalThis !== 'undefined' && typeof globalThis.innerHeight === 'number'
    ? globalThis.innerHeight
    : 800;
  const max = maxPx ?? Math.round(vh * 0.45);
  // Reset so scrollHeight reflects content height, not the previous height.
  ta.style.height = 'auto';
  const next = Math.min(ta.scrollHeight, max);
  ta.style.height = `${next}px`;
  ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
}
