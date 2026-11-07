/**
 * Pointer drag snapped to whole days, for the Calendar and Timeline
 * (docs/TIMELINE_AND_CALENDAR.md T3). The view says how a point on screen
 * maps to a day (`dayAt`) and what a drop does; this owns the gesture:
 *
 *   - a drag starts once the pointer moves past a few pixels, so a plain click
 *     still opens the task (the click after a real drag is swallowed);
 *   - a ghost of the dragged element follows the pointer (optional), and a
 *     tooltip names the day(s) it would land on ("Tue Nov 18 → Thu Nov 20");
 *   - Esc, or a release off any day, cancels — nothing is written;
 *   - every listener is removed when the gesture ends.
 *
 * Mouse / pen / touch alike through Pointer Events; only the primary button
 * starts a drag, so a middle-click still opens the link in a new tab.
 */

/** Movement (px) before a press becomes a drag. */
export const DRAG_THRESHOLD_PX = 4;

export interface DayDragOptions {
  /** The pointerdown that may start the drag. */
  event: PointerEvent;
  /** The element pressed (cloned for the ghost). */
  source: HTMLElement;
  /** The day under a viewport point, or null outside the drop area. */
  dayAt: (clientX: number, clientY: number) => string | null;
  /** The tooltip text for the day under the pointer. */
  describe: (day: string) => string;
  /** Show a ghost of `source` under the pointer. Default true. */
  ghost?: boolean;
  /** Called once the press becomes a drag. */
  onStart?: () => void;
  /** Called as the hovered day changes (null = off the drop area). */
  onHover?: (day: string | null) => void;
  /** Release over a day. */
  onDrop: (day: string) => void;
  /** Esc, a release off any day, or a lost pointer. */
  onCancel?: () => void;
}

/** Whether a press is one the drag should take (primary button, no modifier). */
export function isDragPress(ev: PointerEvent): boolean {
  return ev.button === 0 && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey;
}

/**
 * Track one press. Call from the source's `pointerdown`; returns at once and
 * reports through the callbacks. A press that never moves past the threshold
 * does nothing here (the element's own click handler opens the task).
 */
export function startDayDrag(opts: DayDragOptions): void {
  if (!isDragPress(opts.event)) return;
  const x0 = opts.event.clientX;
  const y0 = opts.event.clientY;
  const pointerId = opts.event.pointerId;
  let active = false;
  let ghost: HTMLElement | null = null;
  let tip: HTMLElement | null = null;
  let hovered: string | null = null;
  let offsetX = 0;
  let offsetY = 0;

  const place = (x: number, y: number): void => {
    if (ghost !== null) {
      ghost.style.left = `${x - offsetX}px`;
      ghost.style.top = `${y - offsetY}px`;
    }
    if (tip !== null) {
      tip.style.left = `${x + 14}px`;
      tip.style.top = `${y + 18}px`;
    }
  };

  const begin = (x: number, y: number): void => {
    active = true;
    const rect = opts.source.getBoundingClientRect?.();
    if (opts.ghost !== false && rect !== undefined) {
      offsetX = x0 - rect.left;
      offsetY = y0 - rect.top;
      ghost = opts.source.cloneNode(true) as HTMLElement;
      ghost.classList.add('day-drag__ghost');
      ghost.removeAttribute('id');
      // Inline, so the source's own position / grid placement can't win.
      ghost.style.position = 'fixed';
      ghost.style.gridColumn = '';
      ghost.style.gridRow = '';
      ghost.style.pointerEvents = 'none';
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      document.body?.append(ghost);
    }
    tip = document.createElement('div');
    tip.className = 'day-drag__tip';
    tip.setAttribute('role', 'status');
    document.body?.append(tip);
    document.documentElement.classList.add('day-dragging');
    opts.onStart?.();
    place(x, y);
  };

  const hover = (x: number, y: number): void => {
    const day = opts.dayAt(x, y);
    if (tip !== null) {
      tip.textContent = day !== null ? opts.describe(day) : 'Release to cancel';
      tip.classList.toggle('day-drag__tip--off', day === null);
    }
    if (day !== hovered) {
      hovered = day;
      opts.onHover?.(day);
    }
  };

  const cleanup = (): void => {
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('pointercancel', onCancel, true);
    document.removeEventListener('keydown', onKey, true);
    ghost?.remove();
    tip?.remove();
    ghost = null;
    tip = null;
    document.documentElement.classList.remove('day-dragging');
    if (active) swallowNextClick();
  };

  const onMove = (ev: Event): void => {
    const e = ev as PointerEvent;
    if (e.pointerId !== pointerId) return;
    if (!active) {
      if (Math.abs(e.clientX - x0) < DRAG_THRESHOLD_PX && Math.abs(e.clientY - y0) < DRAG_THRESHOLD_PX) return;
      begin(e.clientX, e.clientY);
    }
    e.preventDefault();
    place(e.clientX, e.clientY);
    hover(e.clientX, e.clientY);
  };

  const onUp = (ev: Event): void => {
    const e = ev as PointerEvent;
    if (e.pointerId !== pointerId) return;
    const wasActive = active;
    const day = wasActive ? opts.dayAt(e.clientX, e.clientY) : null;
    cleanup();
    if (!wasActive) return;
    if (day !== null) opts.onDrop(day);
    else opts.onCancel?.();
  };

  const onCancel = (ev: Event): void => {
    if ((ev as PointerEvent).pointerId !== pointerId) return;
    const wasActive = active;
    cleanup();
    if (wasActive) opts.onCancel?.();
  };

  const onKey = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    const wasActive = active;
    cleanup();
    if (wasActive) opts.onCancel?.();
  };

  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', onCancel, true);
  document.addEventListener('keydown', onKey, true);
}

/** The click a browser fires after a drag's release must not open the task. */
function swallowNextClick(): void {
  if (typeof window === 'undefined') return;
  const swallow = (ev: Event): void => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  window.addEventListener('click', swallow, true);
  setTimeout(() => window.removeEventListener('click', swallow, true), 0);
}
