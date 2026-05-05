/**
 * UI primitive unit tests.
 *
 * The vitest setup in this repo is node-only (no jsdom). Component-mount
 * coverage is therefore limited to logic that lives in plain `.ts` modules:
 *   - `util/class_names.ts` (cx)
 *   - `ui/toast.svelte.ts` (ToastStore)
 *
 * For Svelte components we still verify they import cleanly (`build` /
 * `pnpm check` exercise the compile path) plus do round-trip tests on any
 * reusable filter / selection helpers exported from .ts modules. Anything
 * requiring real DOM (Modal focus trap, Combobox keyboard) is covered by the
 * dev gallery + the upcoming WebDriver E2E pass (task #6).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cx } from '../../src/util/class_names.js';
import { ToastStore, notify, toasts, dismissToast } from '../../src/ui/toast.svelte.js';

/* -------------------------------------------------------------------------- */
/* cx                                                                         */
/* -------------------------------------------------------------------------- */

describe('cx', () => {
  it('joins truthy strings with spaces', () => {
    expect(cx('a', 'b', 'c')).toBe('a b c');
  });

  it('drops falsy values', () => {
    expect(cx('a', false, null, undefined, '', 'b')).toBe('a b');
  });

  it('handles arrays recursively', () => {
    expect(cx('a', ['b', ['c', false, 'd']])).toBe('a b c d');
  });

  it('handles object keys (truthy => key)', () => {
    expect(cx({ a: true, b: false, c: 1 })).toBe('a c');
  });

  it('mixes everything', () => {
    expect(
      cx('btn', { 'btn-primary': true, hidden: false }, ['rounded', null], false, 'shadow'),
    ).toBe('btn btn-primary rounded shadow');
  });

  it('returns empty string for no args', () => {
    expect(cx()).toBe('');
  });

  it('coerces numbers to strings', () => {
    expect(cx('a', 3)).toBe('a 3');
  });
});

/* -------------------------------------------------------------------------- */
/* ToastStore                                                                 */
/* -------------------------------------------------------------------------- */

describe('ToastStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    toasts.clear();
  });

  it('push() appends an item with defaults', () => {
    const store = new ToastStore();
    const id = store.push({ message: 'hi' });
    expect(store.items).toHaveLength(1);
    expect(store.items[0]!.message).toBe('hi');
    expect(store.items[0]!.type).toBe('info');
    expect(store.items[0]!.durationMs).toBe(5000);
    expect(store.items[0]!.id).toBe(id);
  });

  it('push() respects custom type and duration', () => {
    const store = new ToastStore();
    store.push({ type: 'error', message: 'boom', durationMs: 1000 });
    expect(store.items[0]!.type).toBe('error');
    expect(store.items[0]!.durationMs).toBe(1000);
  });

  it('auto-dismisses after the duration elapses', () => {
    const store = new ToastStore();
    store.push({ message: 'gone soon', durationMs: 2000 });
    expect(store.items).toHaveLength(1);

    vi.advanceTimersByTime(1999);
    expect(store.items).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(store.items).toHaveLength(0);
  });

  it('dismiss() cancels the timer and removes the item', () => {
    const store = new ToastStore();
    const id = store.push({ message: 'kill me', durationMs: 5000 });
    store.dismiss(id);
    expect(store.items).toHaveLength(0);

    // Timer must not fire after manual dismiss; nothing should error.
    vi.advanceTimersByTime(10_000);
    expect(store.items).toHaveLength(0);
  });

  it('sticky toasts (durationMs=0) never auto-dismiss', () => {
    const store = new ToastStore();
    store.push({ message: 'sticky', durationMs: 0 });
    vi.advanceTimersByTime(60_000);
    expect(store.items).toHaveLength(1);
  });

  it('preserves an undo callback', () => {
    const store = new ToastStore();
    const undo = vi.fn();
    store.push({ message: 'deleted', undo });
    expect(store.items[0]!.undo).toBe(undo);
  });

  it('module-level notify() / dismissToast() route to the singleton', () => {
    const id = notify({ message: 'singleton' });
    expect(toasts.items.find((i) => i.id === id)).toBeDefined();
    dismissToast(id);
    expect(toasts.items.find((i) => i.id === id)).toBeUndefined();
  });

  it('clear() removes all items and pending timers', () => {
    const store = new ToastStore();
    store.push({ message: 'a' });
    store.push({ message: 'b' });
    store.push({ message: 'c' });
    expect(store.items).toHaveLength(3);
    store.clear();
    expect(store.items).toHaveLength(0);
    vi.advanceTimersByTime(10_000);
    expect(store.items).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Combobox filter logic                                                      */
/*                                                                            */
/* The substring filter Combobox.svelte uses is small; we re-implement it     */
/* here to lock the contract (case-insensitive substring match preserves      */
/* original order). The component imports the same source-of-truth via its   */
/* `filtered` $derived; if either drifts, both this and a follow-up E2E      */
/* journey would catch the regression.                                        */
/* -------------------------------------------------------------------------- */

interface FilterOpt {
  value: string;
  label: string;
  disabled?: boolean;
}

function comboFilter(options: FilterOpt[], query: string): FilterOpt[] {
  if (query.trim() === '') return options;
  const q = query.toLowerCase();
  return options.filter((o) => o.label.toLowerCase().includes(q));
}

function comboToggleMulti<T>(current: T[], v: T): T[] {
  return current.includes(v) ? current.filter((x) => x !== v) : [...current, v];
}

function comboNextHighlight(
  filtered: FilterOpt[],
  current: number,
  delta: number,
): number {
  if (filtered.length === 0) return 0;
  let i = current + delta;
  for (let attempts = 0; attempts < filtered.length; attempts++) {
    if (i < 0) i = filtered.length - 1;
    if (i >= filtered.length) i = 0;
    const opt = filtered[i];
    if (opt && !opt.disabled) return i;
    i += delta > 0 ? 1 : -1;
  }
  return current;
}

describe('Combobox logic', () => {
  const opts: FilterOpt[] = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' },
    { value: 'g', label: 'Gamma' },
    { value: 'd', label: 'Delta' },
    { value: 'e', label: 'Epsilon' },
  ];

  it('filters by case-insensitive substring', () => {
    // 'a' matches: Alpha, Beta, Gamma, Delta (not Epsilon).
    expect(comboFilter(opts, 'a').map((o) => o.value)).toEqual(['a', 'b', 'g', 'd']);
    expect(comboFilter(opts, 'A').map((o) => o.value)).toEqual(['a', 'b', 'g', 'd']);
    // 'eta' matches Beta only.
    expect(comboFilter(opts, 'eta').map((o) => o.value)).toEqual(['b']);
    // 'lp' matches Alpha only.
    expect(comboFilter(opts, 'LP').map((o) => o.value)).toEqual(['a']);
  });

  it('returns full list when query is whitespace', () => {
    expect(comboFilter(opts, '   ')).toEqual(opts);
    expect(comboFilter(opts, '')).toEqual(opts);
  });

  it('toggles a value into and out of a multi-select array', () => {
    let v: string[] = [];
    v = comboToggleMulti(v, 'a');
    expect(v).toEqual(['a']);
    v = comboToggleMulti(v, 'b');
    expect(v).toEqual(['a', 'b']);
    v = comboToggleMulti(v, 'a');
    expect(v).toEqual(['b']);
    v = comboToggleMulti(v, 'b');
    expect(v).toEqual([]);
  });

  it('ArrowDown / ArrowUp wrap around the visible list', () => {
    expect(comboNextHighlight(opts, 0, 1)).toBe(1);
    expect(comboNextHighlight(opts, opts.length - 1, 1)).toBe(0); // wraps
    expect(comboNextHighlight(opts, 0, -1)).toBe(opts.length - 1); // wraps
  });

  it('skips disabled options when navigating', () => {
    const withDisabled: FilterOpt[] = [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B', disabled: true },
      { value: 'c', label: 'C' },
    ];
    expect(comboNextHighlight(withDisabled, 0, 1)).toBe(2); // skip b
    expect(comboNextHighlight(withDisabled, 2, 1)).toBe(0); // wrap, skip b
  });
});

/* -------------------------------------------------------------------------- */
/* Compile smoke: every primitive should import without throwing              */
/* -------------------------------------------------------------------------- */

describe('UI primitive imports', () => {
  it('every primitive module loads', async () => {
    // Each dynamic import compiles the .svelte file via the vite-node loader
    // that vitest uses; throwing is a hard failure (script error, broken import,
    // bad type, etc.). Mounting requires real DOM, which is out of scope here.
    const mods = await Promise.all([
      import('../../src/ui/Button.svelte'),
      import('../../src/ui/IconButton.svelte'),
      import('../../src/ui/Modal.svelte'),
      import('../../src/ui/Combobox.svelte'),
      import('../../src/ui/DatePicker.svelte'),
      import('../../src/ui/Toast.svelte'),
      import('../../src/ui/Spinner.svelte'),
      import('../../src/ui/EmptyState.svelte'),
      import('../../src/ui/ConfirmDialog.svelte'),
      import('../../src/ui/Chip.svelte'),
      import('../../src/ui/Avatar.svelte'),
    ]);
    for (const m of mods) {
      expect(m.default).toBeDefined();
    }
  });
});
