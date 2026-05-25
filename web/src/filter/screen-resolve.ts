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

/* -------------------------------------------------------------------------- */
/* Static slug → layout fallback (the seam #29 replaced; kept as a fallback).  */
/* -------------------------------------------------------------------------- */

/**
 * The static slug→layout fallback used when a project has no `screen` card for
 * a slug. Mirrors the original router `SLUG_TO_LAYOUT` table; the router now
 * delegates here so the mapping lives in one place. An unknown slug returns
 * 'unknown' (→ the ScreenHost's NotFound placeholder).
 */
const SLUG_TO_LAYOUT: Readonly<Record<string, string>> = {
  kanban: 'kanban',
  grid: 'grid',
  inbox: 'list',
  project: 'project',
};

export function fallbackLayoutForSlug(slug: string): string {
  return SLUG_TO_LAYOUT[slug] ?? 'unknown';
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
