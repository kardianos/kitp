/**
 * Pointer-events based drag/drop primitives.
 *
 * Why not native HTML5 DnD:
 *  - We need a visually-fat drop placeholder that grows when the pointer is
 *    within ~24 px of a drop zone (locks visual feedback before the pointer
 *    enters the literal gap between cards).
 *  - We need a custom-styled drag preview (HTML5 DnD's drag image is opaque).
 *  - We need a single code path for touch + mouse.
 *  - We need auto-scroll near viewport edges.
 *
 * Public surface:
 *  - `dnd`            global rune store; exposes `active` and `zones`.
 *  - `dragHandle`     Svelte 5 action that turns a node into a drag source.
 *  - `dropZone`       Svelte 5 action that registers a node as a drop target.
 */

import type { Action } from 'svelte/action';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface ActiveDrag<P = unknown> {
  payload: P;
  pointerX: number;
  pointerY: number;
  /** id of the currently highlighted DropZone (null if none) */
  hoverZoneId: string | null;
  /** screen-x/y of pointerdown, used to compute movement before commit */
  startX: number;
  startY: number;
  /** true once threshold passed (4 px) */
  committed: boolean;
  /** optional label rendered inside the drag preview */
  previewLabel?: string;
}

export interface ZoneRegistration {
  id: string;
  rect: () => DOMRect;
  /** hit-zone inflation in px on top + bottom (default 24) */
  padding: number;
  accepts: (payload: unknown) => boolean;
  onDrop: (payload: unknown) => void;
  /** registry calls this when hoverZoneId flips for this zone */
  setHover: (hovered: boolean) => void;
}

export interface DragHandleOptions<P = unknown> {
  payload: P;
  /** label rendered in the floating preview while dragging */
  previewLabel?: string;
}

export interface DropZoneOptions<P = unknown> {
  id: string;
  onDrop: (payload: P) => void;
  accepts?: (payload: P) => boolean;
  /** hit-zone inflation in px (default 24) */
  padding?: number;
  /**
   * Optional callback invoked when this zone's hovered state changes. The
   * `<DropZone>` component wires this to a `$state` boolean so the placeholder
   * can grow/shrink. If omitted, the action falls back to dispatching
   * `dnd:hover` / `dnd:unhover` `CustomEvent`s on the node.
   */
  setHover?: (hovered: boolean) => void;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Pointer must move this many pixels before a drag is committed. */
export const COMMIT_THRESHOLD_PX = 4;
/** Default hit-zone inflation. */
export const DEFAULT_PADDING_PX = 24;
/** Auto-scroll band near viewport top/bottom. */
export const AUTOSCROLL_BAND_PX = 50;
/** Auto-scroll velocity per animation frame. */
export const AUTOSCROLL_VELOCITY_PX = 10;

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The store carries all live drag state.
 *
 * REACTIVITY CONTRACT (FE-H1): `active` and `zones` are plain class
 * fields, NOT `$state`. Mutating them triggers NO Svelte reactivity.
 * This is intentional — the store is consumed exclusively through the
 * imperative `setHover` callback path (`DropZone` wires `setHover` to
 * its own local `$state` boolean; `onDrop` is a direct call). Do NOT
 * write `$effect(() => x = dnd.active?.hoverZoneId)` expecting it to
 * re-run on hover changes: it will read the value once and then go
 * stale silently. If a future consumer genuinely needs a reactive read
 * of drag state, promote the specific field to `$state` here first —
 * don't rely on a subscription this store does not provide.
 *
 * (Keeping these non-rune also lets the module import cleanly into the
 * plain-`.ts` `dnd` unit tests.)
 */
class DndStore {
  active: ActiveDrag | null = null;
  zones: Map<string, ZoneRegistration> = new Map();

  reset(): void {
    if (this.active) {
      // clear hover on every zone
      for (const z of this.zones.values()) {
        try {
          z.setHover(false);
        } catch {
          // ignore zone bookkeeping errors during teardown
        }
      }
    }
    this.active = null;
  }
}

export const dnd: DndStore = new DndStore();

/* -------------------------------------------------------------------------- */
/* Drag preview                                                               */
/* -------------------------------------------------------------------------- */

let previewEl: HTMLElement | null = null;

function ensurePreview(label: string | undefined): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  if (previewEl) {
    previewEl.textContent = label ?? '';
    return previewEl;
  }
  const el = document.createElement('div');
  el.className = 'dnd-drag-preview';
  el.style.position = 'fixed';
  el.style.left = '0';
  el.style.top = '0';
  el.style.pointerEvents = 'none';
  el.style.zIndex = '9999';
  el.style.transform = 'translate(-9999px,-9999px)';
  el.textContent = label ?? '';
  document.body.appendChild(el);
  previewEl = el;
  return el;
}

function moveArrowPreview(x: number, y: number): void {
  if (!previewEl) return;
  // Offset slightly so preview sits below+right of the cursor.
  previewEl.style.transform = `translate(${x + 12}px,${y + 12}px)`;
}

function destroyPreview(): void {
  if (previewEl && previewEl.parentNode) {
    previewEl.parentNode.removeChild(previewEl);
  }
  previewEl = null;
}

/* -------------------------------------------------------------------------- */
/* Hit testing + auto-scroll                                                  */
/* -------------------------------------------------------------------------- */

/** Test if (x,y) is inside `rect` inflated by `pad` on top + bottom. */
function pointInInflatedRect(x: number, y: number, rect: DOMRect, pad: number): boolean {
  return (
    x >= rect.left &&
    x <= rect.right &&
    y >= rect.top - pad &&
    y <= rect.bottom + pad
  );
}

/** Pick the first zone whose inflated rect contains the point AND accepts the payload. */
function pickZone(x: number, y: number, payload: unknown): ZoneRegistration | null {
  for (const z of dnd.zones.values()) {
    if (!z.accepts(payload)) continue;
    const r = z.rect();
    if (pointInInflatedRect(x, y, r, z.padding)) return z;
  }
  return null;
}

let autoscrollHandle: number | null = null;

function maybeAutoscroll(y: number): void {
  if (typeof window === 'undefined') return;
  const top = y < AUTOSCROLL_BAND_PX;
  const bottom = y > window.innerHeight - AUTOSCROLL_BAND_PX;
  if (!top && !bottom) {
    if (autoscrollHandle !== null) {
      cancelAnimationFrame(autoscrollHandle);
      autoscrollHandle = null;
    }
    return;
  }
  if (autoscrollHandle !== null) return; // already scheduled
  const tick = (): void => {
    if (!dnd.active) {
      autoscrollHandle = null;
      return;
    }
    const py = dnd.active.pointerY;
    const dt = py < AUTOSCROLL_BAND_PX
      ? -AUTOSCROLL_VELOCITY_PX
      : py > window.innerHeight - AUTOSCROLL_BAND_PX
        ? AUTOSCROLL_VELOCITY_PX
        : 0;
    if (dt === 0) {
      autoscrollHandle = null;
      return;
    }
    window.scrollBy(0, dt);
    autoscrollHandle = requestAnimationFrame(tick);
  };
  autoscrollHandle = requestAnimationFrame(tick);
}

function stopAutoscroll(): void {
  if (autoscrollHandle !== null) {
    cancelAnimationFrame(autoscrollHandle);
    autoscrollHandle = null;
  }
}

/* -------------------------------------------------------------------------- */
/* Global pointer/keydown listeners                                           */
/* -------------------------------------------------------------------------- */

let listenersAttached = false;

function attachGlobalListeners(): void {
  if (listenersAttached) return;
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  document.addEventListener('pointermove', onPointerMove, { passive: false });
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerCancel, true);
  window.addEventListener('keydown', onKeyDown, true);
  listenersAttached = true;
}

function detachGlobalListeners(): void {
  if (!listenersAttached) return;
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    listenersAttached = false;
    return;
  }
  document.removeEventListener('pointermove', onPointerMove);
  document.removeEventListener('pointerup', onPointerUp, true);
  document.removeEventListener('pointercancel', onPointerCancel, true);
  window.removeEventListener('keydown', onKeyDown, true);
  listenersAttached = false;
}

function setHoverZone(nextId: string | null): void {
  const a = dnd.active;
  if (!a) return;
  const prevId = a.hoverZoneId;
  if (prevId === nextId) return;
  if (prevId !== null) {
    const prev = dnd.zones.get(prevId);
    prev?.setHover(false);
  }
  if (nextId !== null) {
    const next = dnd.zones.get(nextId);
    next?.setHover(true);
  }
  a.hoverZoneId = nextId;
}

function onPointerMove(ev: PointerEvent): void {
  const a = dnd.active;
  if (!a) return;

  a.pointerX = ev.clientX;
  a.pointerY = ev.clientY;

  if (!a.committed) {
    const dx = ev.clientX - a.startX;
    const dy = ev.clientY - a.startY;
    if (dx * dx + dy * dy < COMMIT_THRESHOLD_PX * COMMIT_THRESHOLD_PX) {
      return;
    }
    a.committed = true;
    ensurePreview(a.previewLabel);
  }

  moveArrowPreview(ev.clientX, ev.clientY);

  const z = pickZone(ev.clientX, ev.clientY, a.payload);
  setHoverZone(z?.id ?? null);

  maybeAutoscroll(ev.clientY);
}

function onPointerUp(_ev: PointerEvent): void {
  const a = dnd.active;
  if (!a) return;
  const wasCommitted = a.committed;
  const hoverId = a.hoverZoneId;
  // Snapshot before clearing so the consumer's onDrop sees a clean store.
  const payload = a.payload;
  finishDrag();
  if (!wasCommitted) return;
  if (hoverId === null) return;
  const z = dnd.zones.get(hoverId);
  if (!z) return;
  if (!z.accepts(payload)) return;
  z.onDrop(payload);
}

function onPointerCancel(_ev: PointerEvent): void {
  finishDrag();
}

function onKeyDown(ev: KeyboardEvent): void {
  if (!dnd.active) return;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    finishDrag();
  }
}

function finishDrag(): void {
  stopAutoscroll();
  destroyPreview();
  // Clear hover on whichever zone is highlighted.
  if (dnd.active?.hoverZoneId !== null && dnd.active?.hoverZoneId !== undefined) {
    const z = dnd.zones.get(dnd.active.hoverZoneId);
    z?.setHover(false);
  }
  dnd.active = null;
  // We could detach listeners here, but keeping them attached is cheap and
  // simpler. They no-op when `dnd.active` is null. Detach only if no zones
  // remain (e.g. teardown).
  if (dnd.zones.size === 0) detachGlobalListeners();
}

/* -------------------------------------------------------------------------- */
/* dragHandle action                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Attach a drag handle. The action accepts either a raw payload (legacy form,
 * `use:dragHandle={payload}`) or an options bag with `payload` + optional
 * `previewLabel` (`use:dragHandle={{ payload, previewLabel: 'Card 7' }}`).
 */
export const dragHandle: Action<HTMLElement, unknown> = (node, param) => {
  let current = parseHandleParam(param);

  function onPointerDown(ev: PointerEvent): void {
    // Only primary button (mouse=0); touch/pen always pass.
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    // If a drag is already in flight, ignore.
    if (dnd.active) return;
    attachGlobalListeners();
    try {
      node.setPointerCapture(ev.pointerId);
    } catch {
      // some environments (jsdom) don't implement pointer capture
    }
    dnd.active = {
      payload: current.payload,
      pointerX: ev.clientX,
      pointerY: ev.clientY,
      startX: ev.clientX,
      startY: ev.clientY,
      hoverZoneId: null,
      committed: false,
      ...(current.previewLabel !== undefined ? { previewLabel: current.previewLabel } : {}),
    };
  }

  node.addEventListener('pointerdown', onPointerDown);

  return {
    update(next: unknown) {
      current = parseHandleParam(next);
    },
    destroy() {
      node.removeEventListener('pointerdown', onPointerDown);
    },
  };
};

interface ParsedHandle {
  payload: unknown;
  previewLabel?: string;
}

function parseHandleParam(param: unknown): ParsedHandle {
  if (
    param !== null &&
    typeof param === 'object' &&
    'payload' in (param as Record<string, unknown>)
  ) {
    const o = param as { payload: unknown; previewLabel?: unknown };
    const out: ParsedHandle = { payload: o.payload };
    if (typeof o.previewLabel === 'string') out.previewLabel = o.previewLabel;
    return out;
  }
  return { payload: param };
}

/* -------------------------------------------------------------------------- */
/* dropZone action                                                            */
/* -------------------------------------------------------------------------- */

export const dropZone: Action<HTMLElement, DropZoneOptions> = (node, opts) => {
  let current: DropZoneOptions = opts;
  // Track the live id so update() can re-register the zone when keyed reuse
  // shifts a component's slot index (kanban: card insertion changes the id of
  // every trailing DropZone). The registry indexes by id, so we must move the
  // entry instead of leaking the old key.
  let registeredId = opts.id;

  const reg: ZoneRegistration = {
    id: registeredId,
    rect: () => node.getBoundingClientRect(),
    padding: opts.padding ?? DEFAULT_PADDING_PX,
    accepts: (p) => (current.accepts ? current.accepts(p as never) : true),
    onDrop: (p) => current.onDrop(p as never),
    setHover: (hovered) => {
      if (current.setHover) {
        current.setHover(hovered);
        return;
      }
      // Fallback: dispatch a CustomEvent so non-component consumers can wire
      // via a plain DOM listener.
      const evType = hovered ? 'dnd:hover' : 'dnd:unhover';
      try {
        node.dispatchEvent(new CustomEvent(evType, { bubbles: false }));
      } catch {
        // ignore environments without CustomEvent
      }
    },
  };

  function register(id: string): void {
    const existing = dnd.zones.get(id);
    if (existing !== undefined && existing !== reg) {
      // Genuine collision: two distinct nodes claim the same id. Warn so it
      // surfaces during development, then replace.
      if (typeof console !== 'undefined') {
        console.warn(`[dnd] dropZone id "${id}" already registered; replacing.`);
      }
    }
    dnd.zones.set(id, reg);
    registeredId = id;
    reg.id = id;
  }

  register(registeredId);
  attachGlobalListeners();

  return {
    update(next: DropZoneOptions) {
      current = next;
      reg.padding = next.padding ?? DEFAULT_PADDING_PX;
      if (next.id !== registeredId) {
        // Move the registration without warning: keyed reuse legitimately
        // re-targets the zone when neighbours shift.
        if (dnd.zones.get(registeredId) === reg) {
          dnd.zones.delete(registeredId);
        }
        register(next.id);
      }
    },
    destroy() {
      if (dnd.zones.get(registeredId) === reg) {
        dnd.zones.delete(registeredId);
      }
      if (dnd.zones.size === 0 && !dnd.active) detachGlobalListeners();
    },
  };
};

/* -------------------------------------------------------------------------- */
/* Test-only helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Internal hooks exported for unit tests. Not part of the public API.
 * Components should never call these.
 */
export const __test = {
  pickZone,
  pointInInflatedRect,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onKeyDown,
  finishDrag,
  attachGlobalListeners,
  detachGlobalListeners,
  ensurePreview,
  destroyPreview,
};
