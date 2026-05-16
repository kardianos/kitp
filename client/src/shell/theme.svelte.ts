/**
 * App theme — light / dark — persisted to localStorage.
 *
 * The CSS tokens in `src/app.css` already do the heavy lifting: the
 * dark palette is defined under `[data-theme="dark"]`, so flipping the
 * attribute on `<html>` recolours the whole tree. This store just owns
 * the mode state and the persistence side-effect.
 *
 * Initial read is intentionally cheap: a small inline script in
 * `index.html` stamps `data-theme` before the bundle loads, which
 * avoids a flash of light theme on dark-mode reloads. This module
 * mirrors that on import for callers that build the bundle without
 * the inline script (tests, SSR-like contexts).
 *
 * No tri-state (light / dark / system) yet — keep the surface small.
 * Add a `mode: 'system'` value plus a `matchMedia` listener when a
 * user asks for it.
 */

export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'kitp.theme';

function readInitial(): ThemeMode {
  // SSR / test environments without `window` default to light. The DOM
  // application code is also guarded so it's a no-op there.
  if (typeof window === 'undefined') return 'light';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'dark') return 'dark';
    if (raw === 'light') return 'light';
  } catch {
    // localStorage can throw in private windows / restricted contexts;
    // fall through to the system-preference branch.
  }
  // No saved choice: honour the OS preference on first paint.
  if (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  ) {
    return 'dark';
  }
  return 'light';
}

function apply(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  // Light is the default — represented by the *absence* of the
  // attribute. Removing it (vs setting "light") keeps the inline boot
  // script and CSS in sync: the `:root` block in app.css is the light
  // palette, not a separate `[data-theme="light"]` selector.
  if (mode === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

function persist(mode: ThemeMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Storage write blocked (private mode, quota); accept the loss —
    // the in-memory state still drives the current session.
  }
}

class ThemeStore {
  mode = $state<ThemeMode>(readInitial());

  constructor() {
    // Mirror the initial value to the DOM (idempotent with the inline
    // boot script) so callers that import the module before the
    // bundle's first render still get the right palette.
    apply(this.mode);
  }

  setMode(next: ThemeMode): void {
    if (this.mode === next) return;
    this.mode = next;
    apply(next);
    persist(next);
  }

  toggle(): void {
    this.setMode(this.mode === 'dark' ? 'light' : 'dark');
  }
}

export const themeStore = new ThemeStore();
