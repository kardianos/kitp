/**
 * Screen-card resolution + saved-filter loading — the data backbone behind the
 * view system.
 *
 * A project owns N `screen` cards (`card_type_name='screen'`, parent=project);
 * each screen owns N `filter` cards (`card_type_name='filter'`, parent=screen).
 * The screen card's `layout` attribute drives the ScreenHost body; its
 * `default_filter` (card_ref → filter) picks the preset applied on first visit.
 *
 * Port of the Svelte `client/src/filter/screen_preset.svelte.ts` accessors +
 * `loadScreenAndFilters`, re-expressed against the `web/` framework: the
 * card model uses bigint ids + a plain attributes record, and the loader uses
 * the ZERO-PROMISE `api.call(spec, data, onOk)` surface (callback, no await)
 * rather than the Svelte dispatcher's awaited `request`.
 *
 * NOTHING here touches the DOM or spawns controls — it is the pure resolution
 * layer the ScreenHost + ScreenFilterBar consume. The accessor helpers are
 * exercised directly by `node --test`; the two-step loader is driven through
 * the mock transport.
 *
 * Slug — not layout — is the unique identifier: a project may have several
 * screens of the same layout (Inbox / Ideas / Archive are all `list`) and the
 * URL carries the slug, so matching on layout would collapse them. An unknown
 * slug (no screen card) falls back to the static slug→layout map so a
 * fresh / unseeded project still renders a sane body (graceful degradation).
 */

import type { Api } from '../core/api.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import {
  type Predicate,
  type WireNode,
  type Phase,
  PHASES,
  fromWire,
} from './predicate.js';

/* -------------------------------------------------------------------------- */
/* Tree paths — resolved screens land keyed by (project, slug).                */
/* -------------------------------------------------------------------------- */

/**
 * Where a resolved screen's state lands in the data tree, keyed by
 * (projectId, slug). The ScreenHost writes it; the ScreenFilterBar reads the
 * filters list + active-filter id from the SAME key so back-nav restores the
 * active preset without a refetch.
 *
 *   screens.<projectId>.<slug>.screenId   — the resolved screen card's bigint id
 *   screens.<projectId>.<slug>.layout      — the resolved layout (or fallback)
 *   screens.<projectId>.<slug>.filters     — the saved filter cards (CardWithAttrs[])
 *   screens.<projectId>.<slug>.defaultFilterId — screen.default_filter (id|null)
 *   screens.<projectId>.<slug>.activeFilterId  — the (slug,project) cache: the
 *                                               currently-applied preset id, so
 *                                               re-nav restores it.
 *   screens.<projectId>.<slug>.applied     — guard: the default has been applied
 *                                            once for this key (first-visit).
 */
export function screenStatePath(projectId: bigint | null, slug: string): string[] {
  return ['screens', projectId === null ? 'none' : projectId.toString(), slug];
}

/* There is intentionally NO static slug→layout map. Every screen — Inbox, Grid,
 * Kanban included — is just a `screen` card; its `layout` attribute is the only
 * source of truth (the LAYOUTS themselves are the built-ins, not the slugs). The
 * ScreenHost resolves the card and dispatches on its layout; until it resolves it
 * shows a neutral loading body. No slug is privileged. */

/* -------------------------------------------------------------------------- */
/* Group-axis defaults (keep the filter bar's GROUP picker in sync with a      */
/* board that REQUIRES a grouping axis — the Kanban).                          */
/* -------------------------------------------------------------------------- */

/** The Kanban's default group/column axis. Shared so the board's fallback axis
 *  and the filter bar's default GROUP value can't drift apart (the bug where
 *  the picker said "No group" while the board grouped by milestone). The Kanban
 *  imports this as its `DEFAULT_AXIS_ATTR`. */
export const KANBAN_DEFAULT_GROUP_ATTR = 'milestone_ref';

/** Layouts that REQUIRE a grouping axis: a board has columns, so it can't be
 *  "ungrouped". Only the Kanban — the Grid / Inbox render a flat list and keep
 *  the "No group" option. Drives the filter bar's `requireGroup`. */
export function layoutRequiresGroup(layout: string): boolean {
  return layout === 'kanban';
}

/** The default GROUP-by attribute the filter bar seeds for a layout. A board
 *  layout (Kanban) seeds its default axis so the picker shows the real grouping
 *  from the first paint; a flat layout seeds '' (No group). */
export function defaultGroupForLayout(layout: string): string {
  return layout === 'kanban' ? KANBAN_DEFAULT_GROUP_ATTR : '';
}

/**
 * The screen-specific view-action controls a layout registers on the filter
 * bar's "View" row (right-aligned, via the ScreenFilterBar `viewActions` seam):
 * the Inbox (list layout) → its "Mine only" / "Routed to me" toggles; the Grid
 * → its "Columns" chooser (show/hide + reorder is a view concern). This is a
 * data-driven config table kept OUT of ScreenHost so the host stays generic —
 * adding a screen's view actions is an entry here, never a branch inside the
 * control's render.
 */
export function viewActionsForLayout(layout: string): Array<{ type: string }> {
  switch (layout) {
    case 'list':
      return [{ type: 'NewTaskButton' }, { type: 'InboxViewToggles' }];
    case 'grid':
      return [{ type: 'NewTaskButton' }, { type: 'GridColumns' }];
    default:
      return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Attribute accessors (parity with screen_preset.svelte.ts).                  */
/* -------------------------------------------------------------------------- */

/** Read a card's `slug` attribute (or null when absent / non-string / empty). */
export function readSlug(card: CardWithAttrs): string | null {
  const v = card.attributes['slug'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Read a screen card's `layout` attribute (or null when absent). */
export function readLayout(card: CardWithAttrs): string | null {
  const v = card.attributes['layout'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Read a card's `title` attribute, falling back to `#id`. */
export function readTitle(card: CardWithAttrs): string {
  const v = card.attributes['title'];
  return typeof v === 'string' && v.length > 0 ? v : `#${card.id.toString()}`;
}

/**
 * Read the screen's `default_filter` (card_ref → filter id) as bigint, or null.
 * The wire ships card_ref ids as JSON strings; this is tolerant of bigint /
 * number / digits-string depending on which decode path the row took.
 */
export function readDefaultFilterID(screen: CardWithAttrs): bigint | null {
  return toId(screen.attributes['default_filter']);
}

/** Read a filter card's `group_by_attr` (the universal partition axis), or null. */
export function readGroupByAttr(filter: CardWithAttrs): string | null {
  const v = filter.attributes['group_by_attr'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Read a filter card's `column_attr` (the kanban primary column axis), or null. */
export function readColumnAttr(filter: CardWithAttrs): string | null {
  const v = filter.attributes['column_attr'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Read a filter card's `sort` (a JSON `{ attr, dir }[]`, the FilterSortEntry
 * shape the grid + the predicate builder use). Tolerates a JSON string or an
 * already-parsed array; drops attr-less / malformed entries (incl. older
 * string-array `sort` values). Returns `[]` when absent so the view falls back
 * to the server default order.
 */
export function readSortBy(filter: CardWithAttrs): Array<{ attr: string; dir: 'asc' | 'desc' }> {
  const v = filter.attributes['sort'];
  let arr: unknown = v;
  if (typeof v === 'string') {
    if (v.trim() === '') return [];
    try {
      arr = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out: Array<{ attr: string; dir: 'asc' | 'desc' }> = [];
  for (const e of arr) {
    if (e !== null && typeof e === 'object') {
      const o = e as Record<string, unknown>;
      const attr = typeof o['attr'] === 'string' ? o['attr'] : '';
      if (attr !== '') out.push({ attr, dir: o['dir'] === 'desc' ? 'desc' : 'asc' });
    }
  }
  return out;
}

/**
 * Parse a JSON string-array screen/filter attribute (the convention `predicate`
 * / `sort` / `extra_columns` / `tag_prefix_columns` share). Tolerates a bare
 * JSON string (older seed rows stored a single value unwrapped) and drops
 * non-string / empty entries. Returns `[]` on missing / malformed input so
 * callers can fold without guarding. Ports the Svelte `screen_preset` readers.
 */
function readStringList(card: CardWithAttrs, name: string): string[] {
  const raw = card.attributes[name];
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr: unknown[] = Array.isArray(parsed) ? parsed : typeof parsed === 'string' ? [parsed] : [];
  const out: string[] = [];
  for (const e of arr) {
    if (typeof e !== 'string') continue;
    const trimmed = e.trim();
    if (trimmed !== '') out.push(trimmed);
  }
  return out;
}

/**
 * Read a screen card's `extra_columns` — additional attribute / virtual-field
 * names to surface as Grid columns (e.g. `["due_date"]`). Each entry is an
 * attribute_def name the Grid renders by its value_type.
 */
export function readExtraColumns(screen: CardWithAttrs): string[] {
  return readStringList(screen, 'extra_columns');
}

/**
 * Read a screen card's `tag_prefix_columns` — tag-path prefixes (e.g.
 * `["priority"]`) the Grid materialises as one synthetic column each: a task's
 * tags are scanned for a path beginning `<prefix>/` and shown with the prefix
 * stripped. Trailing slashes are normalised away.
 */
export function readTagPrefixColumns(screen: CardWithAttrs): string[] {
  return readStringList(screen, 'tag_prefix_columns').map((p) => p.replace(/\/+$/, '')).filter((p) => p !== '');
}

/** One phase toggle in a screen's `phase_scope` toggle group. */
export interface PhaseToggle {
  /** UI label (e.g. "Active", "Closed"). */
  label: string;
  /** The phase this toggle scopes to. */
  phase: Phase;
  /** Whether it's ON by default (the seed's `default_on`). */
  defaultOn: boolean;
}

/**
 * Read a screen card's `phase_scope` toggle group from its `toggle_groups`
 * attribute (a JSON spec — see the seed). Each item is a `status has_phase
 * [<phase>]` predicate with a label + `default_on`; we surface them as
 * {@link PhaseToggle}s the ScreenFilterBar renders. The bar composes the
 * selected phases into ONE top-level `status has_phase [phases]` leaf
 * (OR-semantics), hiding non-selected phases (terminal is off by default).
 *
 * Malformed / absent `toggle_groups` → no phase toggles (the screen shows every
 * phase). We never throw on a half-written value.
 */
export function readPhaseToggles(screen: CardWithAttrs): PhaseToggle[] {
  const raw = screen.attributes['toggle_groups'];
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const group = parsed.find(
    (g): g is { items?: unknown } => g !== null && typeof g === 'object' && (g as { name?: unknown }).name === 'phase_scope',
  );
  const items = group && Array.isArray((group as { items?: unknown }).items) ? (group as { items: unknown[] }).items : [];
  const out: PhaseToggle[] = [];
  for (const it of items) {
    if (it === null || typeof it !== 'object') continue;
    const item = it as { label?: unknown; default_on?: unknown; predicate?: { op?: unknown; values?: unknown } };
    const pred = item.predicate;
    if (!pred || typeof pred !== 'object' || pred.op !== 'has_phase') continue;
    const ph = Array.isArray(pred.values) ? String(pred.values[0] ?? '') : '';
    if (!(PHASES as readonly string[]).includes(ph)) continue;
    out.push({
      label: typeof item.label === 'string' && item.label !== '' ? item.label : ph,
      phase: ph as Phase,
      defaultOn: item.default_on === true,
    });
  }
  return out;
}

/**
 * Decode a filter card's `predicate` attribute into a typed {@link Predicate},
 * or null. Stored as a JSON-encoded STRING (the shape the Svelte client's
 * `predicateToJson` / our {@link toWire}+JSON.stringify produce); a missing /
 * empty / malformed value means "no filter" — we never throw on a half-written
 * value, the screen just falls through to its no-filter path.
 *
 * The wire ships card_ref leaf values as JSON strings; this revives digits-only
 * strings on the known card_ref leaf attrs so the ref-picker option matcher
 * (whose option values are stringified ids) and the Grid/Kanban query compare
 * cleanly. We keep the values as STRINGS (not bigint) because the existing
 * predicate→where[] path forwards them verbatim and the mock/Go handler accept
 * the string form — matching how the ScreenFilterBar already feeds the query.
 */
export function readPredicate(filter: CardWithAttrs): Predicate | null {
  const raw = filter.attributes['predicate'];
  if (typeof raw !== 'string' || raw.trim() === '') {
    // Tolerate an already-parsed object (some decode paths revive JSON).
    if (raw !== null && typeof raw === 'object') {
      try {
        return fromWire(raw as WireNode);
      } catch {
        return null;
      }
    }
    return null;
  }
  try {
    return fromWire(JSON.parse(raw) as WireNode);
  } catch {
    return null;
  }
}

/** Coerce a wire id value (bigint / number / digits-string) to bigint, else null. */
function toId(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v === 0n ? null : v;
  if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) {
    try {
      const n = BigInt(v);
      return n === 0n ? null : n;
    } catch {
      return null;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* The two-step loader (screen card → its filter cards).                       */
/* -------------------------------------------------------------------------- */

/** Result handed to {@link loadScreenAndFilters}'s callback. */
export interface ScreenPresetSet {
  /** The screen card for (project, slug), or null when the project has none. */
  screen: CardWithAttrs | null;
  /** Filter cards parented to that screen (server order). */
  filters: CardWithAttrs[];
  /** The filter `screen.default_filter` points at (when set + present), else null. */
  defaultFilter: CardWithAttrs | null;
}

/** The spec key the loader addresses (the shared card read). */
const SELECT_WITH_ATTRS = 'card.select_with_attributes';

/**
 * Issue the two batched reads a screen needs to materialise its presets:
 *
 *   1. card.select_with_attributes { cardTypeName:'screen', parentCardId:project }
 *      → pick the one whose `slug` matches.
 *   2. card.select_with_attributes { cardTypeName:'filter', parentCardId:screen }
 *      → the saved filter cards for that screen.
 *
 * Step 2 fires only after step 1 returns AND finds a matching screen card; a
 * project with no screen row for the slug short-circuits with an empty result.
 * ZERO-PROMISE: the dispatcher coalesces both reads into a batch when issued in
 * the same tick, but we issue step 2 from step 1's onOk callback (it needs the
 * resolved screen id), so they land as two sequential batches — same posture as
 * the Svelte `loadScreenAndFilters`.
 *
 * `onResult` is called exactly once with the resolved set. Failures funnel
 * through the centralized fault registry (no per-call try/catch); on a step-1
 * failure `onResult` is NOT called (the host keeps its fallback). `alive` lets
 * the caller drop a late delivery after it's torn down.
 */
export function loadScreenAndFilters(
  api: Api,
  projectId: bigint,
  slug: string,
  onResult: (set: ScreenPresetSet) => void,
  alive?: () => boolean,
): void {
  api.callByName(
    SELECT_WITH_ATTRS,
    { cardTypeName: 'screen', parentCardId: projectId },
    (out) => {
      const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
      const screen = rows.find((r) => readSlug(r) === slug) ?? null;
      if (screen === null) {
        onResult({ screen: null, filters: [], defaultFilter: null });
        return;
      }
      api.callByName(
        SELECT_WITH_ATTRS,
        { cardTypeName: 'filter', parentCardId: screen.id },
        (filterOut) => {
          const filters = ((filterOut ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
          const defaultId = readDefaultFilterID(screen);
          const defaultFilter =
            defaultId === null ? null : (filters.find((f) => f.id === defaultId) ?? null);
          onResult({ screen, filters, defaultFilter });
        },
        alive ? { alive } : {},
      );
    },
    alive ? { alive } : {},
  );
}
