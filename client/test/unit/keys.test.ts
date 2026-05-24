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
    // Regression: when AppShell's per-project chord registration effect
    // ran its cleanup, the reactive-array proxy could surface an
    // undefined index mid-iteration inside `findIndex`. Without the
    // predicate's `e !== undefined` guard, `e.id` threw and the throw
    // bubbled out of Svelte's flush_sync, stranding every later
    // reactive update in the cycle (tasks never rendered).
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
});

describe('ShortcutRegistry: dynamic sources (FE-C2)', () => {
  it('folds a dynamic source into `all` and `visible` without mutating entries', () => {
    let chords = [
      {
        scope: 'global' as const,
        binding: 'g i',
        handler: () => {},
        label: 'Go to Inbox',
        id: -1,
      },
    ];
    const dispose = shortcuts.registerSource(() => chords);

    // The dynamic chord is visible to the dispatcher (via `all`) and the
    // help overlay (via `visible`), but `entries` stays empty — no
    // imperative push/splice, which is the whole point of the cascade
    // fix.
    expect(shortcuts.entries).toHaveLength(0);
    expect(shortcuts.all.map((e) => e.binding)).toContain('g i');
    expect(shortcuts.visible.map((e) => e.binding)).toContain('g i');

    // Swapping the source's output (what a project switch does to the
    // derived screen-chord list) is picked up on the next read.
    chords = [
      {
        scope: 'global' as const,
        binding: 'g k',
        handler: () => {},
        label: 'Go to Kanban',
        id: -1,
      },
    ];
    expect(shortcuts.all.map((e) => e.binding)).toContain('g k');
    expect(shortcuts.all.map((e) => e.binding)).not.toContain('g i');

    dispose();
    expect(shortcuts.all.map((e) => e.binding)).not.toContain('g k');
  });

  it("a dynamic 'g <hotkey>' chord fires through the dispatcher", () => {
    const handler = vi.fn();
    shortcuts.registerSource(() => [
      {
        scope: 'global',
        binding: 'g j',
        handler,
        label: 'Go to Journal',
        id: -1,
      },
    ]);

    // 'g' buffers as a chord prefix because a dynamic source advertises
    // a 'g …' chord; 'j' completes it.
    expect(dispatchKey({ key: 'g' })).toBe(true);
    expect(dispatchKey({ key: 'j' })).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
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

describe('scope tier precedence: overlay > active > global', () => {
  it('overlay-scope handler wins over both active-scope and global', () => {
    const globalH = vi.fn();
    const activeH = vi.fn();
    const overlayH = vi.fn();
    shortcuts.register({ scope: 'global', binding: 'Esc', handler: globalH, label: 'g' });
    shortcuts.register({ scope: 'inbox', binding: 'Esc', handler: activeH, label: 'a' });
    shortcuts.register({ scope: 'overlay', binding: 'Esc', handler: overlayH, label: 'o' });
    shortcuts.activeScope = 'inbox';

    expect(dispatchKey({ key: 'Esc' })).toBe(true);
    expect(overlayH).toHaveBeenCalledTimes(1);
    expect(activeH).not.toHaveBeenCalled();
    expect(globalH).not.toHaveBeenCalled();
  });

  it('after the overlay handler is unregistered the active-scope handler wins again', () => {
    const activeH = vi.fn();
    const overlayH = vi.fn();
    shortcuts.register({ scope: 'inbox', binding: 'Esc', handler: activeH, label: 'a' });
    const overlayId = shortcuts.register({
      scope: 'overlay', binding: 'Esc', handler: overlayH, label: 'o',
    });
    shortcuts.activeScope = 'inbox';

    dispatchKey({ key: 'Esc' });
    expect(overlayH).toHaveBeenCalledTimes(1);
    expect(activeH).not.toHaveBeenCalled();

    shortcuts.unregister(overlayId);
    dispatchKey({ key: 'Esc' });
    expect(overlayH).toHaveBeenCalledTimes(1);
    expect(activeH).toHaveBeenCalledTimes(1);
  });

  it('within a tier, higher priority wins; ties go to the most recent', () => {
    const low = vi.fn();
    const high = vi.fn();
    shortcuts.register({ scope: 'overlay', binding: 'Esc', handler: low, label: 'low', priority: 0 });
    shortcuts.register({ scope: 'overlay', binding: 'Esc', handler: high, label: 'high', priority: 5 });
    shortcuts.activeScope = 'global';

    dispatchKey({ key: 'Esc' });
    expect(high).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();
  });

  it('an overlay binding stays distinct from an active-scope binding using the same key', () => {
    // Regression for the original bug: TaskDetail's "Esc → goBack"
    // (active scope) shouldn't fire while a modal's "Esc → close"
    // (overlay) is registered.
    const goBack = vi.fn();
    const closeModal = vi.fn();
    shortcuts.register({ scope: 'task_detail', binding: 'Esc', handler: goBack, label: 'back' });
    shortcuts.activeScope = 'task_detail';

    dispatchKey({ key: 'Esc' });
    expect(goBack).toHaveBeenCalledTimes(1);
    expect(closeModal).not.toHaveBeenCalled();

    const overlayId = shortcuts.register({
      scope: 'overlay', binding: 'Esc', handler: closeModal, label: 'close',
    });
    dispatchKey({ key: 'Esc' });
    expect(goBack).toHaveBeenCalledTimes(1);
    expect(closeModal).toHaveBeenCalledTimes(1);

    shortcuts.unregister(overlayId);
    dispatchKey({ key: 'Esc' });
    expect(goBack).toHaveBeenCalledTimes(2);
    expect(closeModal).toHaveBeenCalledTimes(1);
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
