/**
 * Per-(project, slug) view persistence — keeps a screen's customized view across
 * a COLD reload (the session-only `screen.*` leaves are lost on reload to a bare
 * URL). Stores the predicate / group axis / lane axis / column config in
 * `localStorage` keyed by the (project, slug) the ScreenFilterBar already keys
 * its preset state under. Search is intentionally NOT persisted (transient).
 *
 * The bar restores on mount (taking precedence over default-filter-on-first-
 * visit) and re-saves whenever those leaves change.
 */

const PREFIX = 'kitp.view.';

/** The localStorage key for a `screenStatePath` (`['screens', <project>, <slug>]`). */
function keyFor(screenStatePath: readonly string[]): string | null {
  if (screenStatePath.length < 3) return null;
  return PREFIX + screenStatePath.slice(1).join('.');
}

export interface PersistedView {
  /** screen.predicate (null = no filter). card_ref values are stringified ids. */
  predicate?: unknown;
  /** screen.group (active group-axis attr name, '' = none). */
  group?: string;
  /** screen.laneGroup (active lane-axis attr name, '' = none). */
  laneGroup?: string;
  /** screen.columnConfig ({ hidden, order, widths }). */
  columnConfig?: unknown;
}

/** bigint → string so JSON.stringify never throws on a card_ref id value. */
function bigintSafe(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

export function loadView(screenStatePath: readonly string[]): PersistedView | null {
  const key = keyFor(screenStatePath);
  if (key === null) return null;
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw === null || raw === undefined || raw === '') return null;
    const v = JSON.parse(raw) as unknown;
    return v !== null && typeof v === 'object' ? (v as PersistedView) : null;
  } catch {
    return null;
  }
}

export function saveView(screenStatePath: readonly string[], view: PersistedView): void {
  const key = keyFor(screenStatePath);
  if (key === null) return;
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(view, bigintSafe));
  } catch {
    // localStorage unavailable (private mode / SSR / quota) — persistence is
    // best-effort; the in-session leaves still work.
  }
}
