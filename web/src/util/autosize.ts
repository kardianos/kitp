/**
 * Auto-grow a `<textarea>` to fit its content, capped at a max height.
 *
 * Pure DOM helper (no listener bookkeeping) — call it once after mount and from
 * an `input` listener the host control wires via `this.listen`, so cleanup stays
 * with the control. The cap defaults to ~45% of the viewport so a long body
 * scrolls internally instead of pushing the page; below the cap there is no
 * scrollbar and the field grows line-by-line with the number of newlines/wrap.
 */

/** The value length each textarea was last fitted at (see the fast path). */
const fittedLength = new WeakMap<HTMLTextAreaElement, number>();

export function fitTextarea(ta: HTMLTextAreaElement, maxPx?: number): void {
  const vh = typeof globalThis !== 'undefined' && typeof globalThis.innerHeight === 'number'
    ? globalThis.innerHeight
    : 800;
  const max = maxPx ?? Math.round(vh * 0.45);
  const len = ta.value.length;
  const prev = fittedLength.get(ta);
  fittedLength.set(ta, len);

  // Fast path while the text only grows (typing): more text never makes the
  // content shorter, so there's no need to collapse the box and re-measure —
  // which laid out the whole text twice per keystroke. At the cap it already
  // scrolls; below it, grow only when the content overflows. (A paste that
  // replaces a selection with longer but fewer lines can leave the box a line
  // taller than needed until the next deletion re-fits it.)
  if (prev !== undefined && len >= prev) {
    if (ta.style.overflowY === 'auto') return;
    const content = ta.scrollHeight;
    if (content <= ta.clientHeight) return;
    ta.style.height = `${Math.min(content, max)}px`;
    ta.style.overflowY = content > max ? 'auto' : 'hidden';
    return;
  }

  // Reset so scrollHeight reflects content height, not the previous height.
  ta.style.height = 'auto';
  const next = Math.min(ta.scrollHeight, max);
  ta.style.height = `${next}px`;
  ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
}
