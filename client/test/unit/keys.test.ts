import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { shortcuts } from '../../src/keys/registry.svelte';
import {
  canonicalKey,
  handleKey,
  installGlobalKeydown,
  _state,
  _resetDispatcherState,
  type KeyEventLike,
} from '../../src/keys/dispatcher';

/**
 * Build a structurally-typed key event for `handleKey`. The dispatcher
 * only reads the fields exposed by `KeyEventLike`, so tests don't need
 * a real DOM `KeyboardEvent` (Vitest's default `node` environment has
 * no `KeyboardEvent` constructor).
 */
interface DispatchOptions {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  target?: unknown;
}

function makeEvent(opts: DispatchOptions): KeyEventLike & {
  defaultPrevented: boolean;
  propagationStopped: boolean;
} {
  const event = {
    key: opts.key,
    ctrlKey: opts.ctrl ?? false,
    metaKey: opts.meta ?? false,
    shiftKey: opts.shift ?? false,
    altKey: opts.alt ?? false,
    ...(opts.target !== undefined ? { target: opts.target } : {}),
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault(): void {
      this.defaultPrevented = true;
    },
    stopPropagation(): void {
      this.propagationStopped = true;
    },
  };
  return event;
}

/**
 * Drive a key through `handleKey` and report whether a registered
 * handler ran (i.e. the dispatcher claimed the event).
 */
function dispatchKey(opts: DispatchOptions): boolean {
  return handleKey(makeEvent(opts));
}

beforeEach(() => {
  shortcuts._reset();
  _resetDispatcherState();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ShortcutRegistry: register / unregister', () => {
  it('register returns a unique id and the entry becomes visible', () => {
    const handler = vi.fn();
    const id = shortcuts.register({
      scope: 'inbox',
      binding: 'n',
      handler,
      label: 'New task',
    });
    expect(typeof id).toBe('number');
    expect(shortcuts.entries).toHaveLength(1);
    expect(shortcuts.entries[0]?.id).toBe(id);
  });

  it('unregister removes by id', () => {
    const id1 = shortcuts.register({
      scope: 'inbox',
      binding: 'n',
      handler: () => {},
      label: 'A',
    });
    const id2 = shortcuts.register({
      scope: 'inbox',
      binding: 'j',
      handler: () => {},
      label: 'B',
    });
    expect(id1).not.toBe(id2);
    shortcuts.unregister(id1);
    expect(shortcuts.entries).toHaveLength(1);
    expect(shortcuts.entries[0]?.id).toBe(id2);
    shortcuts.unregister(id2);
    expect(shortcuts.entries).toHaveLength(0);
  });

  it('unregister with an unknown id is a no-op', () => {
    shortcuts.register({
      scope: 'inbox',
      binding: 'n',
      handler: () => {},
      label: 'A',
    });
    shortcuts.unregister(99999);
    expect(shortcuts.entries).toHaveLength(1);
  });

  it('handles a tight unregister loop without throwing', () => {
    // Regression: when the per-project chord registration effect (AppShell)
    // ran its cleanup, the in-place splice path could leave findIndex
    // reading past the shortening array's new end on the next iteration —
    // the callback's `e.id` then threw a TypeError. Filtering to a fresh
    // array sidesteps that.
    const ids: number[] = [];
    for (let i = 0; i < 8; i++) {
      ids.push(
        shortcuts.register({
          scope: 'global',
          binding: `g ${String.fromCharCode(97 + i)}`,
          handler: () => {},
          label: `Slot ${i}`,
        }),
      );
    }
    expect(shortcuts.entries).toHaveLength(8);
    expect(() => {
      for (const id of ids) shortcuts.unregister(id);
    }).not.toThrow();
    expect(shortcuts.entries).toHaveLength(0);
  });

  it('handles double-unregister without throwing', () => {
    const id = shortcuts.register({
      scope: 'global',
      binding: 'q',
      handler: () => {},
      label: 'Q',
    });
    shortcuts.unregister(id);
    expect(() => shortcuts.unregister(id)).not.toThrow();
    expect(shortcuts.entries).toHaveLength(0);
  });
});

describe('ShortcutRegistry: visible across active scope and global', () => {
  it('visible includes both active-scope and global entries', () => {
    shortcuts.register({
      scope: 'global',
      binding: 'Mod+k',
      handler: () => {},
      label: 'Palette',
    });
    shortcuts.register({
      scope: 'inbox',
      binding: 'n',
      handler: () => {},
      label: 'New',
    });
    shortcuts.register({
      scope: 'kanban',
      binding: 'n',
      handler: () => {},
      label: 'New (kanban)',
    });

    shortcuts.activeScope = 'inbox';
    const visibleInbox = shortcuts.visible.map((e) => e.binding).sort();
    expect(visibleInbox).toEqual(['Mod+k', 'n']);

    shortcuts.activeScope = 'kanban';
    const visibleKanban = shortcuts.visible.map((e) => e.binding).sort();
    expect(visibleKanban).toEqual(['Mod+k', 'n']);
    // Inbox-only entry should not appear under kanban.
    const labels = shortcuts.visible.map((e) => e.label);
    expect(labels).not.toContain('New');
    expect(labels).toContain('New (kanban)');
  });
});

describe('canonical binding parsing and chord buffer', () => {
  beforeEach(() => {
    // Hand-rolled clock so we don't rely on real timers.
    let now = 0;
    _state.now = () => now;
    (globalThis as unknown as { __advance?: (ms: number) => void }).__advance = (
      ms: number,
    ) => {
      now += ms;
    };
  });

  function advance(ms: number): void {
    (globalThis as unknown as { __advance: (ms: number) => void }).__advance(ms);
  }

  it("'g' then 'p' within 1200ms fires the 'g p' chord", () => {
    const handler = vi.fn();
    shortcuts.register({
      scope: 'global',
      binding: 'g p',
      handler,
      label: 'Go to projects',
    });

    // First 'g' is buffered (no direct match, but is a chord prefix).
    expect(dispatchKey({ key: 'g' })).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(_state.chord).not.toBeNull();

    advance(800);

    // 'p' inside the window completes the chord.
    expect(dispatchKey({ key: 'p' })).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(_state.chord).toBeNull();
  });

  it("'g' then >1200ms then 'p' does NOT fire the chord", () => {
    const handler = vi.fn();
    shortcuts.register({
      scope: 'global',
      binding: 'g p',
      handler,
      label: 'Go to projects',
    });

    expect(dispatchKey({ key: 'g' })).toBe(true);
    advance(2000);
    // Chord prefix has expired; 'p' alone has no binding.
    expect(dispatchKey({ key: 'p' })).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('canonicalKey lowercases printable letters and preserves named keys', () => {
    expect(canonicalKey({ key: 'A', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBe('a');
    expect(canonicalKey({ key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBe('Enter');
    expect(canonicalKey({ key: 'Escape', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBe('Esc');
    expect(canonicalKey({ key: 'ArrowUp', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBe('ArrowUp');
    expect(canonicalKey({ key: ' ', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBe('Space');
    expect(canonicalKey({ key: '?', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBe('?');
    expect(canonicalKey({ key: '/', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBe('/');
  });
});

describe('fireInInputs gating', () => {
  it('default bindings do NOT fire when target is an <input>', () => {
    const handler = vi.fn();
    shortcuts.register({
      scope: 'inbox',
      binding: 'n',
      handler,
      label: 'New',
    });
    shortcuts.activeScope = 'inbox';

    const input = { tagName: 'INPUT' };
    expect(dispatchKey({ key: 'n', target: input })).toBe(false);
    expect(handler).not.toHaveBeenCalled();

    // …but it does fire when the target is something else.
    expect(dispatchKey({ key: 'n', target: { tagName: 'DIV' } })).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('Esc fires inside inputs by default', () => {
    const handler = vi.fn();
    shortcuts.register({
      scope: 'global',
      binding: 'Esc',
      handler,
      label: 'Cancel',
    });

    const textarea = { tagName: 'TEXTAREA' };
    expect(dispatchKey({ key: 'Escape', target: textarea })).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('Mod+Enter fires inside inputs by default', () => {
    const handler = vi.fn();
    shortcuts.register({
      scope: 'global',
      binding: 'Mod+Enter',
      handler,
      label: 'Submit',
    });

    const input = { tagName: 'INPUT' };
    expect(dispatchKey({ key: 'Enter', ctrl: true, target: input })).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('contenteditable elements are treated as editable targets', () => {
    const handler = vi.fn();
    shortcuts.register({
      scope: 'inbox',
      binding: 'n',
      handler,
      label: 'New',
    });
    shortcuts.activeScope = 'inbox';

    const ce = { tagName: 'DIV', isContentEditable: true };
    expect(dispatchKey({ key: 'n', target: ce })).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('Mod resolution across platforms', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  function stubNavigator(platform: string): void {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { platform },
    });
  }

  function restoreNavigator(): void {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'navigator', originalDescriptor);
    } else {
      delete (globalThis as { navigator?: unknown }).navigator;
    }
  }

  afterEach(() => {
    restoreNavigator();
  });

  it('Mod = metaKey on macOS', () => {
    stubNavigator('MacIntel');
    expect(
      canonicalKey({
        key: '/',
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
      }),
    ).toBe('Mod+/');

    // ctrl on Mac is NOT Mod.
    expect(
      canonicalKey({
        key: '/',
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      }),
    ).toBe('/');
  });

  it('Mod = ctrlKey on Linux/Windows', () => {
    stubNavigator('Linux x86_64');
    expect(
      canonicalKey({
        key: '/',
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      }),
    ).toBe('Mod+/');

    // meta on Linux is NOT Mod.
    expect(
      canonicalKey({
        key: '/',
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
      }),
    ).toBe('/');
  });

  it('handler registered against "Mod+/" fires on both platforms', () => {
    const handler = vi.fn();
    shortcuts.register({
      scope: 'global',
      binding: 'Mod+/',
      handler,
      label: 'Help',
    });

    stubNavigator('MacIntel');
    expect(dispatchKey({ key: '/', meta: true })).toBe(true);

    stubNavigator('Linux x86_64');
    expect(dispatchKey({ key: '/', ctrl: true })).toBe(true);

    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('preventDefault and stopPropagation on match', () => {
  it('a matched event is preventDefault-ed and stopPropagation-ed', () => {
    shortcuts.register({
      scope: 'global',
      binding: 'n',
      handler: () => {},
      label: 'New',
    });
    const ev = makeEvent({ key: 'n' });
    expect(handleKey(ev)).toBe(true);
    expect(ev.defaultPrevented).toBe(true);
    expect(ev.propagationStopped).toBe(true);
  });

  it('an unmatched event is left alone', () => {
    const ev = makeEvent({ key: 'q' });
    expect(handleKey(ev)).toBe(false);
    expect(ev.defaultPrevented).toBe(false);
    expect(ev.propagationStopped).toBe(false);
  });
});

describe('installGlobalKeydown', () => {
  it('attaches and detaches a keydown listener on a provided EventTarget', () => {
    const handler = vi.fn();
    shortcuts.register({
      scope: 'global',
      binding: 'n',
      handler,
      label: 'New',
    });

    const target = new EventTarget();
    const dispose = installGlobalKeydown(target);

    // Dispatch a synthetic event with the fields handleKey reads.
    const ev = Object.assign(new Event('keydown'), {
      key: 'n',
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
    });
    target.dispatchEvent(ev);
    expect(handler).toHaveBeenCalledTimes(1);

    dispose();
    target.dispatchEvent(ev);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
