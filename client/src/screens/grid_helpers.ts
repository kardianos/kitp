/**
 * Pure helpers for {@link GridScreen}. Extracted so the test suite can
 * exercise them under the node-only vitest runner without mounting a
 * Svelte component.
 *
 * Three responsibilities live here:
 *   - {@link cycleSort}: header-click sort cycling (asc → desc → off).
 *   - {@link buildOrderClauses}: project a {@link SortState} onto the
 *     `card.select_with_attributes` `order` payload shape.
 *   - {@link applyFilterToTree}: project the active predicate onto the
 *     `tree` payload shape, or pass through a caller-provided base tree.
 */

import { predicateToJson, type Predicate } from '../filter/predicate.js';
import type { SortPredicate } from '../filter/screen_preset.svelte.js';
import type { CardOrderClause } from '../reg/types.js';

/* -------------------------------------------------------------------------- */
/* SortState                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The grid's active sort. `field` is the wire field name passed to the
 * server in `card.select_with_attributes` `order[].field` (e.g.
 * `attributes.title`, `created_at`); `direction` mirrors the server's
 * `ASC`/`DESC` convention but stored as the lower-case discriminator.
 */
export interface SortState {
  field: string;
  direction: 'asc' | 'desc';
}

/* -------------------------------------------------------------------------- */
/* cycleSort                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Header-click sort cycling.
 *
 * Behaviour mirrors the Dart `_toggleSort` (with the addition of an
 * explicit "off" stop so users can return to the server's default
 * `ORDER BY c.id`):
 *
 *   - `current === null`            → asc on [field]
 *   - `current.field === field`     → asc → desc, desc → null (off)
 *   - `current.field !== field`     → asc on [field] (switch column)
 *
 * Returns the next state. `null` means no sort is active and the caller
 * should send an empty `order: []`.
 */
export function cycleSort(
  current: SortState | null,
  field: string,
): SortState | null {
  if (current === null || current.field !== field) {
    return { field, direction: 'asc' };
  }
  if (current.direction === 'asc') {
    return { field, direction: 'desc' };
  }
  // Already desc on this column — turn it off.
  return null;
}

/* -------------------------------------------------------------------------- */
/* buildOrderClauses                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Project one or more {@link SortState}s onto the wire `order` array.
 * Returns an empty array (not undefined) so callers can spread the
 * result without branching; the encoder in `handlers.ts` already drops
 * empty arrays.
 *
 * Accepts either a single state (header-click case) or a list (filter
 * sort case). `null` and `[]` both mean "no order — let the server fall
 * back to its default `ORDER BY c.id`". The server expects
 * `direction: 'ASC' | 'DESC'`; we upper-case here.
 */
export function buildOrderClauses(
  sort: SortState | SortState[] | null,
): CardOrderClause[] {
  if (sort === null) return [];
  const list = Array.isArray(sort) ? sort : [sort];
  return list.map((s) => ({
    field: s.field,
    direction: s.direction === 'asc' ? 'ASC' : 'DESC',
  }));
}

/**
 * Map a filter card's persisted {@link SortPredicate} list to the
 * {@link SortState}s the grid hands to {@link buildOrderClauses}.
 *
 * Attribute names go through as `attributes.<name>` because that's the
 * field path the server's `card.select_with_attributes` expects for
 * attribute-valued ordering. Future special-case columns (created_at,
 * personal_sort_order) can opt out of the prefix here.
 */
export function sortStatesFromFilter(
  predicates: readonly SortPredicate[],
): SortState[] {
  return predicates.map((p) => ({
    field: `attributes.${p.attr}`,
    direction: p.dir,
  }));
}

/**
 * Pick the effective sort: a single header-click sort overrides the
 * filter's persisted sort entirely. When the user clears their click
 * (cycle off), the persisted sort comes back. Returns `[]` when neither
 * is set — server default kicks in.
 */
export function effectiveSort(
  headerSort: SortState | null,
  filterSort: readonly SortState[],
): SortState[] {
  if (headerSort !== null) return [headerSort];
  return [...filterSort];
}

/* -------------------------------------------------------------------------- */
/* compareGroupKey                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Total-order comparator for two group-key values. Used by the
 * client-side resort that runs when grouping by an array attribute
 * (tags) — the server can't usefully order rows by the array value, so
 * the client expands one row per element and resorts the expansion.
 *
 * Empty (undefined / null / "") sorts LAST regardless of direction so
 * the "—" bucket consistently lands at the bottom. Bigints compare
 * directly, numbers numerically, everything else falls back to
 * localeCompare on String(v).
 */
export function compareGroupKey(a: unknown, b: unknown): number {
  const aEmpty = a === undefined || a === null || a === '';
  const bEmpty = b === undefined || b === null || b === '';
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  if (typeof a === 'bigint' && typeof b === 'bigint') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/* -------------------------------------------------------------------------- */
/* expandRowsForArrayGroup                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Expand each row to one entry per element of its [attrName] array.
 * A task tagged `[Pri/high, Area/ui]` becomes two synthetic rows —
 * one with `tags = Pri/high`, one with `tags = Area/ui` — so the
 * downstream walk emits the task under both bucket headers.
 *
 * The synthetic rows share the original's identity (id, other
 * attributes); only the group attribute is replaced with the scalar
 * element. Empty / missing arrays produce a single entry with the
 * attribute cleared, so the row still lands in the "—" bucket.
 *
 * The output is sorted by the (now-scalar) group key using
 * [compareGroupKey], respecting [groupDir]. Empty always lands last
 * regardless of direction.
 */
export function expandRowsForArrayGroup<
  T extends { attributes: Record<string, unknown> },
>(rows: readonly T[], attrName: string, groupDir: 'asc' | 'desc'): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const v = row.attributes[attrName];
    if (Array.isArray(v) && v.length > 0) {
      for (const elem of v) {
        out.push({
          ...row,
          attributes: { ...row.attributes, [attrName]: elem },
        });
      }
    } else {
      out.push({
        ...row,
        attributes: { ...row.attributes, [attrName]: null },
      });
    }
  }
  // Partition by emptiness first so the "—" bucket stays at the end
  // regardless of groupDir — flipping the comparator's sign would
  // otherwise send empties to the top on `desc`.
  const empty: T[] = [];
  const nonEmpty: T[] = [];
  for (const row of out) {
    const v = row.attributes[attrName];
    if (v === undefined || v === null || v === '') empty.push(row);
    else nonEmpty.push(row);
  }
  nonEmpty.sort((a, b) => {
    const cmp = compareGroupKey(a.attributes[attrName], b.attributes[attrName]);
    return groupDir === 'asc' ? cmp : -cmp;
  });
  return [...nonEmpty, ...empty];
}

/* -------------------------------------------------------------------------- */
/* walkGrouped                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One entry in the rendered group sequence: either a section header
 * (one per consecutive run of the same group-key value) or a data row.
 * Rows carry their position in the rows-only sequence as `idx` so the
 * grid's selectedIndex stays row-indexed (headers don't consume an
 * index).
 */
export type GroupItem<T> =
  | { kind: 'header'; label: string; key: string }
  | { kind: 'row'; row: T; idx: number };

/**
 * Walk [rows] in their input order and emit a header whenever the
 * value of [attrName] changes from the previous row. The grouping
 * therefore relies on the caller having pre-ordered rows by the group
 * key — under the unified ordering pipeline, that's the server's job
 * (the GridLayout prepends the group key to the wire `order` array).
 *
 * Why walk-and-emit instead of bucket-and-sort:
 *   - One ordering primitive end-to-end: server `order[]` decides
 *     everything (group direction, within-group sort, secondary
 *     sorts). No client-side bucket re-ordering that disagrees with
 *     the server.
 *   - Group direction comes for free — flipping the first sort key's
 *     direction reverses bucket order in the response, and the walk
 *     reflects it directly.
 *   - Cheaper than rebuilding a Map + sort on every render.
 *
 * Empty / null / "" values cluster into a single "—" header (the
 * server orders them with NULLs first or last depending on direction;
 * either way they form one contiguous run).
 *
 * Pass `labelOf` to resolve card_ref values (bigint id) to display
 * titles; it isn't called for the "—" empty bucket.
 */
export function walkGrouped<T extends { attributes: Record<string, unknown> }>(
  rows: readonly T[],
  attrName: string | null,
  labelOf: (key: unknown) => string,
): GroupItem<T>[] {
  if (attrName === null) {
    return rows.map((row, idx) => ({ kind: 'row', row, idx }));
  }
  const out: GroupItem<T>[] = [];
  const emptyKey = '__empty__';
  let prevKey: string | undefined;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const v = row.attributes[attrName];
    const isEmpty = v === undefined || v === null || v === '';
    const key = isEmpty ? emptyKey : String(v);
    if (key !== prevKey) {
      out.push({
        kind: 'header',
        label: isEmpty ? '—' : labelOf(v),
        key,
      });
      prevKey = key;
    }
    out.push({ kind: 'row', row, idx: i });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Tag-prefix columns                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Synthetic wire-field marker for a header click on a tag-prefix column.
 * Real wire fields look like `attributes.<name>` or top-level columns
 * (`created_at`); a `tag_prefix:<prefix>` field never reaches the server
 * because the value is derived from the tags array client-side.
 *
 * The grid splits the effective order into a server slice (real fields)
 * and a client slice (this marker) — the former drives the wire
 * `order[]` payload; the latter drives a client-side resort on the
 * loaded rows.
 */
export const TAG_PREFIX_SORT_PREFIX = 'tag_prefix:';

export function isTagPrefixSortField(field: string): boolean {
  return field.startsWith(TAG_PREFIX_SORT_PREFIX);
}

export function tagPrefixSortField(prefix: string): string {
  return `${TAG_PREFIX_SORT_PREFIX}${prefix}`;
}

export function tagPrefixFromSortField(field: string): string | null {
  if (!isTagPrefixSortField(field)) return null;
  return field.slice(TAG_PREFIX_SORT_PREFIX.length);
}

/**
 * Pick the first tag path beginning with `prefix/` from a tag-path map.
 * `tagPaths` is the lookup the grid already maintains (tag card id →
 * path text); `tagIds` is the row's `tags` attribute (bigint card_ref
 * array). Returns undefined when no tag matches.
 *
 * The match is `path === prefix` or `path startsWith prefix + '/'` so
 * a prefix `"priority"` catches `priority/high` but not the unrelated
 * `priorityX` that would slip past a bare `startsWith(prefix)`.
 */
export function pickTagForPrefix(
  tagIds: unknown,
  tagPaths: Readonly<Record<string, string>>,
  prefix: string,
): string | undefined {
  if (!Array.isArray(tagIds)) return undefined;
  const needle = `${prefix}/`;
  for (const id of tagIds) {
    if (typeof id !== 'bigint') continue;
    const p = tagPaths[id.toString()];
    if (typeof p !== 'string') continue;
    if (p === prefix || p.startsWith(needle)) return p;
  }
  return undefined;
}

/**
 * Strip the leading `<prefix>/` from a tag path so the column shows
 * `high` instead of `priority/high`. `prefix === ''` and a path that
 * doesn't begin with the expected prefix both pass through unchanged
 * — the caller is responsible for picking a matching path first.
 */
export function stripTagPrefix(path: string, prefix: string): string {
  const lead = `${prefix}/`;
  if (path.startsWith(lead)) return path.slice(lead.length);
  return path;
}

/**
 * Comparator for two tag paths under a client-side `tag_prefix:` sort.
 * Strips the prefix before comparing so the user sees alphabetical
 * order over the value-portion (`high` vs `low`, not the constant
 * `priority/` prefix). Missing values land last regardless of
 * direction; this mirrors the grouping comparator below.
 */
export function compareTagPrefixValue(
  a: string | undefined,
  b: string | undefined,
  prefix: string,
): number {
  const aEmpty = a === undefined || a === '';
  const bEmpty = b === undefined || b === '';
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  return stripTagPrefix(a as string, prefix).localeCompare(
    stripTagPrefix(b as string, prefix),
  );
}

/* -------------------------------------------------------------------------- */
/* applyFilterToTree                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Project the active filter predicate onto the wire `tree` field.
 *
 * - `predicate === null`               → return [currentTree] unchanged
 *   (so callers can pass a base tree like `parent_card_id` they want
 *   preserved when no extra filter is set).
 * - flat predicate (single leaf)       → wrap in a one-child AND group
 *   (the server's `CardWhereGroup` requires a `connective` at the root).
 * - already a group                    → emit verbatim via `predicateToJson`.
 *
 * Returns `undefined` only when both the predicate and the base tree are
 * absent (callers omit the field entirely so the server applies its
 * default).
 */
export function applyFilterToTree(
  predicate: Predicate | null,
  currentTree: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (predicate === null) return currentTree;
  if (predicate.kind === 'group') {
    return predicateToJson(predicate) as Record<string, unknown>;
  }
  // Bare leaf — wrap in a single-child AND so the wire is always a group.
  return {
    connective: 'and',
    children: [predicateToJson(predicate)],
  };
}
