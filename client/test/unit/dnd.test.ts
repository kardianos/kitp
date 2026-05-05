/**
 * dnd primitives unit tests.
 *
 * Runs in Vitest's default Node environment. Node 20 provides `EventTarget`
 * and `Event`, but not `document`, `window`, `HTMLElement`, or `PointerEvent`.
 * Because installing jsdom would require a `package.json` change (out of
 * scope for this task), we install a minimal DOM shim before importing the
 * module under test. The shim is just enough to:
 *   - register/dispatch pointer events
 *   - simulate `getBoundingClientRect`
 *   - back the document-level `pointermove`/`pointerup` listeners that
 *     `use_dnd.svelte.ts` attaches to the global document
 *   - mount/unmount the drag preview node on `document.body`.
 *
 * Tests cover the six behaviors enumerated in §5.8 of the migration plan:
 *   1. dragHandle emits no drag below 4 px movement.
 *   2. Once committed, pointermove inside an inflated zone sets hoverZoneId.
 *   3. accepts(false) skips a zone.
 *   4. pointerup over a hovered zone fires onDrop with the payload.
 *   5. Esc cancels: no onDrop fired.
 *   6. Multiple zones: first matching zone wins; switching zones flips
 *      setHover from old to new.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/* -------------------------------------------------------------------------- */
/* Minimal DOM shim                                                           */
/* -------------------------------------------------------------------------- */

interface ShimDocument extends EventTarget {
  body: ShimElement;
  createElement(_tag: string): ShimElement;
}

class ShimElement extends EventTarget {
  parentNode: ShimElement | null = null;
  children: ShimElement[] = [];
  style: Record<string, string> = {};
  className = '';
  textContent: string | null = null;
  rect: DOMRect = makeRect(0, 0, 0, 0);

  appendChild(child: ShimElement): ShimElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: ShimElement): ShimElement {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  getBoundingClientRect(): DOMRect {
    return this.rect;
  }
  setPointerCapture(_id: number): void {
    // no-op
  }
}

function makeRect(left: number, top: number, right: number, bottom: number): DOMRect {
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({ left, top, right, bottom }),
  } as DOMRect;
}

class ShimPointerEvent extends Event {
  pointerId: number;
  pointerType: string;
  button: number;
  clientX: number;
  clientY: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, { bubbles: true, cancelable: true, ...init });
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
    this.button = init.button ?? 0;
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
  }
}

class ShimKeyboardEvent extends Event {
  key: string;
  constructor(type: string, init: KeyboardEventInit = {}) {
    super(type, { bubbles: true, cancelable: true, ...init });
    this.key = init.key ?? '';
  }
}

class ShimCustomEvent<T> extends Event {
  detail: T | undefined;
  constructor(type: string, init: CustomEventInit<T> = {}) {
    super(type, { bubbles: false, cancelable: false, ...init });
    this.detail = init.detail;
  }
}

let shimDocument: ShimDocument;
let shimWindow: EventTarget & {
  innerHeight: number;
  scrollBy: (x: number, y: number) => void;
  scrolledBy: number;
};

beforeAll(() => {
  shimDocument = Object.assign(new EventTarget() as ShimDocument, {
    body: new ShimElement(),
    createElement: (_tag: string) => new ShimElement(),
  });

  shimWindow = Object.assign(new EventTarget(), {
    innerHeight: 800,
    scrolledBy: 0,
    scrollBy(_x: number, y: number) {
      this.scrolledBy += y;
    },
  });

  // Install globals.
  (globalThis as unknown as { document: ShimDocument }).document = shimDocument;
  (globalThis as unknown as { window: typeof shimWindow }).window = shimWindow;
  (globalThis as unknown as { HTMLElement: typeof ShimElement }).HTMLElement = ShimElement;
  (globalThis as unknown as { PointerEvent: typeof ShimPointerEvent }).PointerEvent =
    ShimPointerEvent;
  (globalThis as unknown as { KeyboardEvent: typeof ShimKeyboardEvent }).KeyboardEvent =
    ShimKeyboardEvent;
  (globalThis as unknown as { CustomEvent: typeof ShimCustomEvent }).CustomEvent =
    ShimCustomEvent;
  (globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame =
    (cb) => {
      // Run synchronously; tests don't need real raf.
      // Return a sentinel id; cancellation is a no-op.
      void cb;
      return 0;
    };
  (globalThis as unknown as { cancelAnimationFrame: (id: number) => void }).cancelAnimationFrame =
    () => {
      // no-op
    };
});

/* -------------------------------------------------------------------------- */
/* Module under test (imported AFTER the shim is installed)                   */
/* -------------------------------------------------------------------------- */

// eslint-disable-next-line import/first
const mod = await import('../../src/dnd/use_dnd.svelte');
const { dnd, dragHandle, dropZone, __test } = mod;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function newNode(rect?: DOMRect): ShimElement {
  const n = new ShimElement();
  if (rect) n.rect = rect;
  return n;
}

function pdown(node: EventTarget, x: number, y: number, pointerId = 1): void {
  node.dispatchEvent(
    new ShimPointerEvent('pointerdown', {
      pointerId,
      clientX: x,
      clientY: y,
      pointerType: 'mouse',
      button: 0,
    }),
  );
}

function pmove(x: number, y: number, pointerId = 1): void {
  shimDocument.dispatchEvent(
    new ShimPointerEvent('pointermove', {
      pointerId,
      clientX: x,
      clientY: y,
      pointerType: 'mouse',
    }),
  );
}

function pup(x: number, y: number, pointerId = 1): void {
  shimDocument.dispatchEvent(
    new ShimPointerEvent('pointerup', {
      pointerId,
      clientX: x,
      clientY: y,
      pointerType: 'mouse',
    }),
  );
}

function escape(): void {
  shimWindow.dispatchEvent(new ShimKeyboardEvent('keydown', { key: 'Escape' }));
}

function pcancel(pointerId = 1): void {
  shimDocument.dispatchEvent(
    new ShimPointerEvent('pointercancel', {
      pointerId,
      pointerType: 'mouse',
    }),
  );
}

beforeEach(() => {
  // Reset store + listeners between tests.
  __test.finishDrag();
  dnd.zones.clear();
  dnd.active = null;
  __test.detachGlobalListeners();
});

afterEach(() => {
  __test.finishDrag();
  dnd.zones.clear();
  dnd.active = null;
  __test.detachGlobalListeners();
});

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('dragHandle', () => {
  it('emits no drag below the 4px movement threshold', () => {
    const handleNode = newNode();
    const action = dragHandle(handleNode as unknown as HTMLElement, { id: 'a' });

    pdown(handleNode, 100, 100);
    expect(dnd.active).not.toBeNull();
    expect(dnd.active!.committed).toBe(false);

    // Move 3px diagonally (sqrt(2*3^2) ~ 4.24, but per-axis 3+3 stays under
    // threshold by squared-distance: 9+9=18 < 16? No: 18 > 16. Use 2px.)
    pmove(102, 102);
    expect(dnd.active!.committed).toBe(false);

    // Now exceed threshold.
    pmove(110, 110);
    expect(dnd.active!.committed).toBe(true);

    action?.destroy?.();
  });

  it('does not start a drag if no payload arrives (defensive)', () => {
    // Without a dragHandle action attached, a pointerdown on a stray node is
    // just an event — no `dnd.active`.
    const stray = newNode();
    pdown(stray, 0, 0);
    expect(dnd.active).toBeNull();
  });
});

describe('dropZone hit-testing', () => {
  it('committed pointermove inside an inflated zone sets hoverZoneId', () => {
    const zoneNode = newNode(makeRect(100, 200, 300, 250)); // 200x50 strip
    const onDrop = vi.fn();
    const setHover = vi.fn();
    dropZone(zoneNode as unknown as HTMLElement, { id: 'z1', onDrop, setHover });

    const handleNode = newNode();
    dragHandle(handleNode as unknown as HTMLElement, { id: 'card-7' });

    // Start drag well above the zone (no padding overlap).
    pdown(handleNode, 100, 100);
    pmove(110, 110); // commit
    expect(dnd.active!.committed).toBe(true);
    expect(dnd.active!.hoverZoneId).toBeNull();
    expect(setHover).not.toHaveBeenCalled();

    // Move to within the inflated band (zone.top - padding(24) = 176).
    pmove(150, 180);
    expect(dnd.active!.hoverZoneId).toBe('z1');
    expect(setHover).toHaveBeenCalledWith(true);

    // Move clearly outside (50 px above the inflated band).
    pmove(150, 100);
    expect(dnd.active!.hoverZoneId).toBeNull();
    expect(setHover).toHaveBeenCalledWith(false);
  });

  it('respects accepts(false) — zone is skipped during hit-test', () => {
    const zoneNode = newNode(makeRect(0, 0, 200, 200));
    const onDrop = vi.fn();
    const setHover = vi.fn();
    dropZone(zoneNode as unknown as HTMLElement, {
      id: 'z-no',
      onDrop,
      accepts: () => false,
      setHover,
    });

    const handleNode = newNode();
    dragHandle(handleNode as unknown as HTMLElement, 'payload');

    pdown(handleNode, 50, 50);
    pmove(60, 60); // commit
    pmove(100, 100); // squarely inside zone
    expect(dnd.active!.hoverZoneId).toBeNull();
    expect(setHover).not.toHaveBeenCalled();

    pup(100, 100);
    expect(onDrop).not.toHaveBeenCalled();
  });
});

describe('drop completion', () => {
  it('pointerup over a hovered zone fires onDrop with the payload', () => {
    const zoneNode = newNode(makeRect(100, 100, 300, 200));
    const onDrop = vi.fn();
    dropZone(zoneNode as unknown as HTMLElement, { id: 'inbox-row-3', onDrop });

    const handleNode = newNode();
    const payload = { card_id: 'task-42' };
    dragHandle(handleNode as unknown as HTMLElement, payload);

    pdown(handleNode, 0, 0);
    pmove(10, 10); // commit
    pmove(150, 150); // hover
    expect(dnd.active!.hoverZoneId).toBe('inbox-row-3');

    pup(150, 150);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(payload);
    expect(dnd.active).toBeNull();
  });

  it('Esc cancels the drag — no onDrop fires', () => {
    const zoneNode = newNode(makeRect(0, 0, 400, 400));
    const onDrop = vi.fn();
    const setHover = vi.fn();
    dropZone(zoneNode as unknown as HTMLElement, { id: 'z-esc', onDrop, setHover });

    const handleNode = newNode();
    dragHandle(handleNode as unknown as HTMLElement, 'p');

    pdown(handleNode, 50, 50);
    pmove(60, 60); // commit
    pmove(200, 200); // hover
    expect(dnd.active!.hoverZoneId).toBe('z-esc');
    expect(setHover).toHaveBeenLastCalledWith(true);

    escape();
    expect(dnd.active).toBeNull();
    expect(onDrop).not.toHaveBeenCalled();
    // setHover(false) should be called on cancel cleanup.
    expect(setHover).toHaveBeenLastCalledWith(false);
  });

  it('pointercancel cancels the drag like Esc', () => {
    const zoneNode = newNode(makeRect(0, 0, 400, 400));
    const onDrop = vi.fn();
    dropZone(zoneNode as unknown as HTMLElement, { id: 'z-cancel', onDrop });

    const handleNode = newNode();
    dragHandle(handleNode as unknown as HTMLElement, 'p');

    pdown(handleNode, 0, 0);
    pmove(10, 10);
    pmove(100, 100);
    expect(dnd.active!.hoverZoneId).toBe('z-cancel');

    pcancel();
    expect(dnd.active).toBeNull();
    expect(onDrop).not.toHaveBeenCalled();
  });
});

describe('multiple zones', () => {
  it('first matching zone wins; switching zones flips setHover old→new', () => {
    // Two non-overlapping zones, registered in order.
    const aNode = newNode(makeRect(0, 0, 200, 100));
    const bNode = newNode(makeRect(0, 300, 200, 400));
    const aHover = vi.fn();
    const bHover = vi.fn();
    const aDrop = vi.fn();
    const bDrop = vi.fn();
    dropZone(aNode as unknown as HTMLElement, { id: 'A', onDrop: aDrop, setHover: aHover });
    dropZone(bNode as unknown as HTMLElement, { id: 'B', onDrop: bDrop, setHover: bHover });

    const handleNode = newNode();
    dragHandle(handleNode as unknown as HTMLElement, 'p');

    pdown(handleNode, 0, 200);
    pmove(10, 210); // commit (no overlap with either: A.bottom+24=124, B.top-24=276)
    expect(dnd.active!.hoverZoneId).toBeNull();

    // Move into A's inflated band.
    pmove(100, 50);
    expect(dnd.active!.hoverZoneId).toBe('A');
    expect(aHover).toHaveBeenLastCalledWith(true);
    expect(bHover).not.toHaveBeenCalled();

    // Cross to B's band — A flips off, B flips on.
    pmove(100, 350);
    expect(dnd.active!.hoverZoneId).toBe('B');
    expect(aHover).toHaveBeenLastCalledWith(false);
    expect(bHover).toHaveBeenLastCalledWith(true);

    // Drop on B.
    pup(100, 350);
    expect(bDrop).toHaveBeenCalledWith('p');
    expect(aDrop).not.toHaveBeenCalled();
  });

  it('with two overlapping zones the first inserted wins', () => {
    // Both zones cover the same band.
    const a = newNode(makeRect(0, 0, 400, 100));
    const b = newNode(makeRect(0, 0, 400, 100));
    const aHover = vi.fn();
    const bHover = vi.fn();
    dropZone(a as unknown as HTMLElement, { id: 'first', onDrop: vi.fn(), setHover: aHover });
    dropZone(b as unknown as HTMLElement, { id: 'second', onDrop: vi.fn(), setHover: bHover });

    const h = newNode();
    dragHandle(h as unknown as HTMLElement, 'p');
    pdown(h, 0, 0);
    pmove(10, 10);
    pmove(50, 50);

    expect(dnd.active!.hoverZoneId).toBe('first');
    expect(aHover).toHaveBeenLastCalledWith(true);
    expect(bHover).not.toHaveBeenCalled();
  });
});
