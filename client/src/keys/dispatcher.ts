import { shortcuts, type ShortcutEntry } from './registry.svelte';

/**
 * Re-evaluate the macOS check on every call so tests can stub
 * `navigator.platform` between cases. The `isMac` constant exported
 * from `./shortcut` is captured at module load and is suitable for
 * UI rendering, but the dispatcher needs the live value.
 */
function detectMac(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    /Mac|iPod|iPhone|iPad/.test(navigator.platform)
  );
}

/**
 * Structural shape of the parts of a `KeyboardEvent` we read. Tests
 * can pass a plain object with these fields rather than constructing a
 * full DOM `KeyboardEvent` (which is not available under Vitest's
 * default `node` environment).
 */
export interface KeyEventLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** Optional — used to gate fireInInputs. */
  target?: unknown;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

const NAMED_KEYS: Record<string, string> = {
  Enter: 'Enter',
  Escape: 'Esc',
  Esc: 'Esc',
  Tab: 'Tab',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ' ': 'Space',
  Spacebar: 'Space',
};

/**
 * Build a canonical single-step binding string from a key event:
 * `[Mod+][Shift+][Alt+]<key>`. `<key>` is lowercased for printable
 * keys, or one of the named keys (`Enter`, `Esc`, `Tab`, `ArrowUp`,
 * `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Space`, `?`, `/`).
 *
 * Mod = `metaKey` on Mac, `ctrlKey` elsewhere.
 */
export function canonicalKey(e: KeyEventLike): string {
  const mod = detectMac() ? e.metaKey : e.ctrlKey;
  const parts: string[] = [];
  if (mod) parts.push('Mod');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');

  let key = e.key;
  if (key in NAMED_KEYS) {
    key = NAMED_KEYS[key]!;
  } else if (key === '?' || key === '/') {
    // keep as-is
  } else if (key.length === 1) {
    key = key.toLowerCase();
  }
  parts.push(key);
  return parts.join('+');
}

/**
 * True when the canonical binding is a candidate for chord extension
 * (single printable letter, no modifiers, no shift). Bindings like
 * `'g'`, `'p'`, etc.
 */
function isChordStart(binding: string): boolean {
  return /^[a-z]$/.test(binding);
}

/**
 * True if the event target is an editable element (input, textarea,
 * or contenteditable) — bindings without `fireInInputs` skip these.
 */
function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const t = target as {
    tagName?: string;
    isContentEditable?: boolean;
    getAttribute?: (n: string) => string | null;
  };
  if (t.isContentEditable === true) return true;
  if (typeof t.tagName === 'string') {
    const tn = t.tagName.toUpperCase();
    if (tn === 'INPUT' || tn === 'TEXTAREA' || tn === 'SELECT') return true;
  }
  if (typeof t.getAttribute === 'function') {
    const ce = t.getAttribute('contenteditable');
    if (ce !== null && ce !== 'false') return true;
  }
  return false;
}

/**
 * Decide whether a registered entry should fire for this event,
 * applying the implicit defaults: `Esc` and `Mod+Enter` always fire
 * in inputs unless the entry sets `fireInInputs: false` explicitly.
 */
function shouldFireInInputs(entry: ShortcutEntry): boolean {
  if (entry.fireInInputs !== undefined) return entry.fireInInputs;
  if (entry.binding === 'Esc') return true;
  if (entry.binding === 'Mod+Enter') return true;
  return false;
}

const CHORD_TIMEOUT_MS = 1200;

interface ChordState {
  prefix: string;
  expiresAt: number;
}

/**
 * Internal dispatcher state. Exposed for tests (so they can reset
 * between cases). Production code should never read these fields.
 */
export const _state = {
  chord: null as ChordState | null,
  /** Function used to read "now" — overridden in tests with fake timers. */
  now: () => Date.now(),
};

/** Reset chord buffer + clock. Test-only. */
export function _resetDispatcherState(): void {
  _state.chord = null;
  _state.now = () => Date.now();
}

/**
 * True if any registered scope has a chord binding starting with this
 * prefix (e.g. `'g'` when bindings include `'g p'`, `'g i'`, …).
 */
function hasChordWithPrefix(prefix: string): boolean {
  // `e !== undefined` guards the Svelte 5 reactive-array splice quirk
  // that the registry's unregister calls out — a concurrent splice can
  // surface an undefined index mid-iteration through the proxy.
  // `all` folds in the dynamic (data-driven) chord sources alongside
  // the imperatively-registered entries.
  for (const e of shortcuts.all) {
    if (e === undefined) continue;
    if (!scopeIsActive(e.scope)) continue;
    if (e.binding.startsWith(prefix + ' ')) return true;
  }
  return false;
}

/**
 * True when [scope] currently participates in shortcut dispatch.
 * Three tiers: `overlay` (always on; absorbs input while any
 * overlay is registered), the active scope, and `global`. Anything
 * else is dormant.
 */
function scopeIsActive(scope: string): boolean {
  return (
    scope === 'overlay' ||
    scope === 'global' ||
    scope === shortcuts.activeScope
  );
}

/**
 * Effective ordering rank for [entry]. The dispatcher picks the
 * highest-rank match. Base ranks per tier are spaced so a custom
 * `priority` set by an entry stays inside its tier (no overlay
 * with priority -1 can lose to an active-scope binding):
 *
 *   overlay     : 2_000 + priority
 *   active scope: 1_000 + priority
 *   global      :     0 + priority
 */
function entryRank(entry: ShortcutEntry): number {
  const pri = entry.priority ?? 0;
  if (entry.scope === 'overlay') return 2000 + pri;
  if (entry.scope === shortcuts.activeScope) return 1000 + pri;
  return pri;
}

/**
 * Match an entry whose binding equals `binding` and whose scope is
 * either the active scope or `'global'`. The active-scope binding wins
 * over a colliding global one (so a screen can override defaults like
 * `Esc` without having to unregister the global handler first).
 */
function findMatch(binding: string): ShortcutEntry | undefined {
  // Pick the highest-ranked entry whose scope is currently active.
  // `entryRank` encodes the tier precedence (overlay > active >
  // global) plus the optional `priority` override. Ties resolve to
  // the most recently registered entry (later index in `entries`),
  // matching the "last in wins" semantics callers expect when they
  // register a temporary overlay binding on top of a long-lived
  // one (e.g. a nested confirm dialog).
  // See `hasChordWithPrefix` for the undefined-guard rationale.
  let best: ShortcutEntry | undefined;
  let bestRank = -Infinity;
  for (const e of shortcuts.all) {
    if (e === undefined) continue;
    if (e.binding !== binding) continue;
    if (!scopeIsActive(e.scope)) continue;
    const r = entryRank(e);
    if (r >= bestRank) {
      best = e;
      bestRank = r;
    }
  }
  return best;
}

/**
 * Process a single key event against the registry. Returns true if a
 * handler was invoked. Exposed for unit tests; production code goes
 * through `installGlobalKeydown`.
 */
export function handleKey(event: KeyEventLike): boolean {
  const single = canonicalKey(event);
  const now = _state.now();

  // Expire stale chord prefix.
  if (_state.chord && _state.chord.expiresAt <= now) {
    _state.chord = null;
  }

  // Try chord match: <prefix> <single>.
  if (_state.chord) {
    const combined = `${_state.chord.prefix} ${single}`;
    const chordEntry = findMatch(combined);
    _state.chord = null; // a key after a prefix always closes it
    if (chordEntry) {
      if (!shouldFireInInputs(chordEntry) && isEditableTarget(event.target)) {
        return false;
      }
      event.preventDefault?.();
      event.stopPropagation?.();
      try {
        chordEntry.handler();
      } catch (err) {
        console.error('[shortcut] handler threw', err);
      }
      return true;
    }
    // Fall through: try the single key as a fresh binding.
  }

  // Try single-key match against overlay + active + global.
  const single_match = findMatch(single);
  if (single_match) {
    if (!shouldFireInInputs(single_match) && isEditableTarget(event.target)) {
      return false;
    }
    event.preventDefault?.();
    event.stopPropagation?.();
    try {
      single_match.handler();
    } catch (err) {
      console.error('[shortcut] handler threw', err);
    }
    return true;
  }

  // No direct match — maybe this is a chord prefix.
  if (isChordStart(single) && hasChordWithPrefix(single)) {
    if (isEditableTarget(event.target)) return false;
    _state.chord = { prefix: single, expiresAt: now + CHORD_TIMEOUT_MS };
    event.preventDefault?.();
    event.stopPropagation?.();
    return true;
  }

  return false;
}

/** Module-init flag so help shortcuts only register once. */
let helpInstalled = false;

/**
 * Register the always-on help shortcuts:
 *   - `Mod+/` and `?` toggle the help overlay
 *
 * Closing the overlay with Esc is owned by ShortcutHelp itself,
 * which registers an `overlay`-tier binding while it's open. The
 * overlay tier out-ranks active-scope bindings (e.g.
 * task_detail's "back to list" Esc) so the close fires reliably.
 */
function installHelpShortcuts(): void {
  if (helpInstalled) return;
  helpInstalled = true;
  const toggle = (): void => {
    shortcuts.helpOpen = !shortcuts.helpOpen;
  };
  shortcuts.register({
    scope: 'global',
    binding: 'Mod+/',
    handler: toggle,
    label: 'Show keyboard shortcuts',
  });
  shortcuts.register({
    scope: 'global',
    binding: '?',
    handler: toggle,
    label: 'Show keyboard shortcuts',
  });
}

/**
 * Install the global keydown listener. Returns a disposer that
 * removes the listener (does NOT remove the help shortcuts). Safe to
 * call from a non-browser environment — it falls back to a no-op
 * disposer when no target is available.
 */
export function installGlobalKeydown(target?: EventTarget): () => void {
  installHelpShortcuts();

  const t: EventTarget | undefined =
    target ?? (typeof window !== 'undefined' ? window : undefined);
  if (!t) return () => {};

  const listener = (ev: Event): void => {
    handleKey(ev as unknown as KeyEventLike);
  };
  t.addEventListener('keydown', listener);
  return () => {
    t.removeEventListener('keydown', listener);
  };
}
