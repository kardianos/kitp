/**
 * Per-project saved view presets.
 *
 * Each project owns N `screen` cards; each screen owns N `filter` card
 * children. The screen's `default_filter` (card_ref → filter) picks
 * which preset applies on first load.
 *
 * Gate 8 renamed the closed-set attribute from `screen_type` to
 * `layout`. The values are the renderer names the application
 * enforces. The wider screen-card schema also carries `slug`,
 * `hotkey`, `flow_ref`, etc; see docs/FLOW_AND_SCREEN_KERNEL.md. Gate
 * 13 dropped the legacy `SCREEN_TYPES` constant in favour of the
 * `LAYOUTS` slot list below — only the admin CRUD combobox needs the
 * closed set; ScreenHost dispatches on `layout` directly.
 *
 * This module owns the shared fetch + accessor helpers; the UI lives in
 * `FilterPresetSelector.svelte` and is wired into each screen.
 */

import type { Dispatcher } from '../dispatch/dispatcher';
import { cardSelectWithAttributes } from '../reg/handlers';
import type {
  CardSelectWithAttributesInput,
  CardSelectWithAttributesOutput,
  CardWithAttrs,
  ID,
} from '../reg/types';
import { predicateFromJson, type Predicate } from './predicate';

/**
 * Closed set of layouts (renderer names) the app knows about. A row in
 * the `screen` card table whose `layout` is outside this set is
 * silently ignored — the kernel stores text without validation, so the
 * application is the source of truth on what counts.
 */
export type Layout =
  | 'list'
  | 'grid'
  | 'kanban'
  | 'project';

export const LAYOUTS: readonly Layout[] = [
  'list',
  'grid',
  'kanban',
  'project',
] as const;

/** Result of {@link loadScreenAndFilters}. */
export interface ScreenPresetSet {
  /** The single screen card for (project, layout), or null when missing. */
  screen: CardWithAttrs | null;
  /** Filter cards parented to that screen, in `sort_order` (then id). */
  filters: CardWithAttrs[];
  /** Filter that `screen.default_filter` points at (when set + present). */
  defaultFilter: CardWithAttrs | null;
}

/**
 * Issue the two batched requests a screen needs to materialise its
 * presets:
 *   1. card.select_with_attributes: card_type='screen', parent=projectId
 *      → pick the one whose `slug` attribute matches.
 *   2. card.select_with_attributes: card_type='filter', parent=<that
 *      screen's id>.
 *
 * Step 2 only fires after step 1 returns; if the project has no screen
 * row for this slug we short-circuit with an empty result.
 *
 * Slug — not layout — is the unique identifier: a project can have
 * multiple screens of the same layout (Inbox / Ideas / Archive all
 * use `list`) and the URL carries the slug, so matching on layout
 * would collapse them onto the first one.
 */
export async function loadScreenAndFilters(
  dispatcher: Pick<Dispatcher, 'request'>,
  projectId: ID,
  slug: string,
): Promise<ScreenPresetSet> {
  const screenOut = await dispatcher.request<
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput
  >({
    endpoint: cardSelectWithAttributes.endpoint,
    action: cardSelectWithAttributes.action,
    data: { cardTypeName: 'screen', parentCardId: projectId },
  });

  const screen =
    screenOut.rows.find((r) => readSlug(r) === slug) ?? null;
  if (screen === null) {
    return { screen: null, filters: [], defaultFilter: null };
  }

  const filterOut = await dispatcher.request<
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput
  >({
    endpoint: cardSelectWithAttributes.endpoint,
    action: cardSelectWithAttributes.action,
    data: {
      cardTypeName: 'filter',
      parentCardId: screen.id,
      order: [{ field: 'attributes.sort_order', direction: 'ASC' }],
    },
  });

  const filters = filterOut.rows;
  const defaultID = readDefaultFilterID(screen);
  const defaultFilter =
    defaultID === null ? null : (filters.find((f) => f.id === defaultID) ?? null);
  return { screen, filters, defaultFilter };
}

/* -------------------------------------------------------------------------- */
/* Attribute accessors                                                        */
/*                                                                            */
/* Filter cards carry typed attributes; these helpers pull each one with the */
/* right narrowing so screen code doesn't sprinkle `typeof === 'string'`     */
/* checks everywhere.                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Read the `layout` attribute as a string (or null when absent / non-
 * string / empty). Gate 8 renamed the underlying attribute from
 * `screen_type` to `layout`; Gate 13 renamed the helper from
 * `readScreenType` to match.
 */
export function readLayout(card: CardWithAttrs): string | null {
  const v = card.attributes['layout'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Read the `slug` attribute as a string (or null when absent). */
export function readSlug(card: CardWithAttrs): string | null {
  const v = card.attributes['slug'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Read the `hotkey` attribute as a string (or null when absent). */
export function readHotkey(card: CardWithAttrs): string | null {
  const v = card.attributes['hotkey'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Read the `flow_ref` attribute (number → flow id) as a bigint, or null
 * when unset. Stored as a JSON number on the wire so deserialisers may
 * hand us either bigint, number, or a digits-only string depending on
 * the dispatcher path the row took.
 */
export function readFlowRef(card: CardWithAttrs): ID | null {
  const v = card.attributes['flow_ref'];
  if (typeof v === 'bigint') return v === 0n ? null : v;
  if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) {
    try {
      const n = BigInt(v);
      return n === 0n ? null : n;
    } catch {
      /* fall through */
    }
  }
  return null;
}

export function readTitle(card: CardWithAttrs): string {
  const v = card.attributes['title'];
  return typeof v === 'string' && v.length > 0 ? v : `#${card.id}`;
}

export function readDefaultFilterID(screen: CardWithAttrs): ID | null {
  const v = screen.attributes['default_filter'];
  return typeof v === 'bigint' ? v : null;
}

export function readColumnAttr(filter: CardWithAttrs): string | null {
  const v = filter.attributes['column_attr'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Attribute name to partition rows by. Universal across layouts:
 *   - List / Grid render one section per distinct value (section header
 *     + rows within).
 *   - Kanban renders one swimlane per distinct value (lane header + the
 *     full column set within).
 * Null = no partitioning. Within each partition the rows order by the
 * filter's `sort` predicates (or the layout's default fallback).
 *
 * This is the "row chooser" / "lane" / "group-by" axis — all the same
 * idea. Kanban additionally has `column_attr` for its primary axis,
 * which has no analogue on List / Grid.
 */
export function readGroupByAttr(filter: CardWithAttrs): string | null {
  const v = filter.attributes['group_by_attr'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** One row of a persisted sort: attribute name + direction. */
export interface SortPredicate {
  attr: string;
  dir: 'asc' | 'desc';
}

/**
 * Read the `sort` attribute as a typed list. Stored as a JSON-encoded
 * array on the wire (same shape readPredicate uses for `predicate`).
 *
 * Malformed entries are dropped silently so a half-written value never
 * crashes the screen — the renderer just sees a shorter list.
 */
export function readSort(filter: CardWithAttrs): SortPredicate[] {
  const raw = filter.attributes['sort'];
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: SortPredicate[] = [];
  for (const e of parsed) {
    if (e === null || typeof e !== 'object') continue;
    const o = e as { attr?: unknown; dir?: unknown };
    if (typeof o.attr !== 'string' || o.attr.length === 0) continue;
    if (o.dir !== 'asc' && o.dir !== 'desc') continue;
    out.push({ attr: o.attr, dir: o.dir });
  }
  return out;
}

/** JSON-encode a sort list for write back to the filter card. */
export function sortToJson(predicates: readonly SortPredicate[]): string {
  if (predicates.length === 0) return '';
  return JSON.stringify(predicates);
}

/**
 * Read the `tag_prefix_columns` attribute as a list of tag-path prefixes
 * (e.g. `["priority", "team"]`). Stored as a JSON array of strings in the
 * filter card's text-valued attribute, mirroring the convention used by
 * `predicate`, `sort`, and `toggle_groups`.
 *
 * GridLayout consumes this to materialize one column per prefix: each
 * task's tags-array is scanned for a path beginning with `<prefix>/`,
 * the matching value is shown with the prefix stripped, and the
 * remaining tags fall through to the catch-all Tags column.
 *
 * Returns `[]` on missing / malformed / empty input so callers can
 * fold over the result without guarding.
 */
export function readTagPrefixColumns(filter: CardWithAttrs): string[] {
  const raw = filter.attributes['tag_prefix_columns'];
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  // Tolerate two shapes — a JSON array of strings, or a bare JSON
  // string. The bare-string form covers older seed data that stored
  // the value as a quoted scalar instead of a single-element array.
  let arr: unknown[];
  if (Array.isArray(parsed)) arr = parsed;
  else if (typeof parsed === 'string') arr = [parsed];
  else return [];
  const out: string[] = [];
  for (const e of arr) {
    if (typeof e !== 'string') continue;
    const trimmed = e.replace(/\/+$/, '');
    if (trimmed === '') continue;
    out.push(trimmed);
  }
  return out;
}

/**
 * Read the `extra_columns` screen-level attribute as a list of
 * additional attribute / virtual-field names to surface as Grid
 * columns. Stored as a JSON array of strings (same convention as
 * `tag_prefix_columns`). Each entry is one of:
 *   - an attribute_def name (`due_date`, `milestone_ref`, …) — the
 *     Grid renders its value via the FilterAttribute label resolver;
 *   - a row-level virtual field (`created_at`, `last_activity_at`) —
 *     the Grid reads it directly off the row (these already have
 *     dedicated columns; listing them here is currently a no-op but
 *     reserved for future per-screen toggling).
 *
 * Returns `[]` on missing / malformed / empty input.
 */
export function readExtraColumns(screen: CardWithAttrs): string[] {
  const raw = screen.attributes['extra_columns'];
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  // Same lenient shape handling as readTagPrefixColumns: JSON array
  // OR bare JSON string (treat as one-element list).
  let arr: unknown[];
  if (Array.isArray(parsed)) arr = parsed;
  else if (typeof parsed === 'string') arr = [parsed];
  else return [];
  const out: string[] = [];
  for (const e of arr) {
    if (typeof e !== 'string') continue;
    const trimmed = e.trim();
    if (trimmed === '') continue;
    out.push(trimmed);
  }
  return out;
}

/**
 * Decode the filter card's `predicate` attribute into a typed
 * `Predicate | null`. Filter cards store the predicate as a
 * JSON-encoded string (the same shape `predicateToJson` produces on the
 * write side); a missing / empty attribute means "no filter".
 *
 * Invalid JSON or AST shape returns `null` so the screen falls through
 * to the no-filter path instead of throwing.
 *
 * Leaf values are revived for the known card_ref attributes
 * (assignee / milestone_ref / component_ref / tags): the wire encoder
 * (`stringifyBigInt`) ships bigint ids as JSON strings, so on the way
 * back in we restore them to bigints so the FilterBar chip matcher and
 * picker options compare cleanly (their option values are bigints too).
 */
export function readPredicate(filter: CardWithAttrs): Predicate | null {
  const raw = filter.attributes['predicate'];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const decoded = predicateFromJson(JSON.parse(raw));
    return reviveCardRefValues(decoded);
  } catch {
    return null;
  }
}

const CARD_REF_LEAF_ATTRS = new Set(['assignee', 'milestone_ref', 'component_ref']);
const CARD_REF_ARRAY_LEAF_ATTRS = new Set(['tags']);

function reviveCardRefValues(p: Predicate): Predicate {
  if (p.kind === 'group') {
    return { ...p, children: p.children.map(reviveCardRefValues) };
  }
  if (
    p.values !== undefined &&
    (CARD_REF_LEAF_ATTRS.has(p.attr) || CARD_REF_ARRAY_LEAF_ATTRS.has(p.attr))
  ) {
    return { ...p, values: p.values.map(toBigIntIfDigits) };
  }
  return p;
}

function toBigIntIfDigits(v: unknown): unknown {
  if (typeof v === 'string' && /^-?\d+$/.test(v)) {
    try {
      return BigInt(v);
    } catch {
      /* fall through */
    }
  }
  return v;
}
