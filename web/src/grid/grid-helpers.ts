/**
 * Framework-agnostic Grid (table) helpers — LIFTED from the Svelte client's
 * `client/src/screens/grid_helpers.ts` and re-expressed against the `web/`
 * card model (bigint ids, attributes record). NOTHING here imports from
 * `client/` or touches the DOM / signals — pure functions exercised directly
 * by `node --test`.
 *
 * Surface (parity with the Svelte helpers, trimmed to what v1 needs):
 *   - {@link cycleSort}          header-click sort cycling (asc → desc → off).
 *   - {@link buildOrderClauses}  project SortState(s) onto the wire `order[]`.
 *   - {@link effectiveSort}      a header-click sort overrides the filter sort.
 *   - {@link sortStatesFromFilter} map a filter card's persisted sort to
 *     SortStates.
 *   - {@link GRID_COLUMNS} + {@link ColumnDef} — the column descriptors and the
 *     sort-field mapping (which column is sortable and what wire field it
 *     orders on).
 *
 * Grouping (group_by_attr): {@link walkGrouped} flattens the (server-ordered)
 * rows into a `[{kind:'group'}, {kind:'row'}, …]` sequence the grid feeds to the
 * recycling virtualList, and {@link groupAttrFromGroupValue} maps the GROUP
 * picker's value (`screen.group`: 'milestone' / 'status' / …) to the matching
 * card attribute + label-lookup name. The server prepends the group attr to the
 * wire `order[]` so rows arrive bucketed; the walk just emits a header on each
 * run boundary.
 *
 * Deferred (the Svelte helper carried these; v1 of the web slice omits them but
 * the shape is preserved so they slot in later — see grid.ts TODOs):
 *   - tag-prefix synthetic columns (`tag_prefix:<prefix>` sort fields,
 *     pickTagForPrefix / stripTagPrefix / compareTagPrefixValue),
 *   - array-group row expansion (one synthetic row per element of a card_ref[]
 *     group attr like `tags`) — scalar grouping is wired here.
 *   - extra_columns / per-column filter state.
 */

import type { RefAxis } from '../filter/vocabulary.js';
import { friendlyLabel, type AttrSchema } from '../filter/attribute-schema.js';
import { lookupNameForCardType } from '../filter/group-axis.js';

/* -------------------------------------------------------------------------- */
/* SortState.                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The grid's active sort. `field` is the wire field name passed to the server
 * in `card.select_with_attributes` `order[].field` (e.g. `attributes.title`,
 * `created_at`); `direction` mirrors the server's `ASC`/`DESC` convention but
 * is stored as the lower-case discriminator.
 */
export interface SortState {
  field: string;
  direction: 'asc' | 'desc';
}

/** One wire `order` clause (the shape `card.select_with_attributes` accepts). */
export interface OrderClause {
  field: string;
  direction: 'ASC' | 'DESC';
}

/* -------------------------------------------------------------------------- */
/* cycleSort.                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Header-click sort cycling.
 *
 *   - `current === null`            → asc on [field]
 *   - `current.field === field`     → asc → desc, desc → null (off)
 *   - `current.field !== field`     → asc on [field] (switch column)
 *
 * `null` means no sort is active and the caller should send an empty
 * `order: []` (server falls back to its default `ORDER BY c.id`).
 */
export function cycleSort(current: SortState | null, field: string): SortState | null {
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
/* buildOrderClauses.                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Project one or more {@link SortState}s onto the wire `order` array. Returns
 * an empty array (not undefined) so callers can branch on `.length`; the
 * encoder drops empty arrays. `null` and `[]` both mean "no order — let the
 * server fall back to its default". The server expects `direction: 'ASC' |
 * 'DESC'`; we upper-case here.
 */
export function buildOrderClauses(sort: SortState | SortState[] | null): OrderClause[] {
  if (sort === null) return [];
  const list = Array.isArray(sort) ? sort : [sort];
  return list.map((s) => ({
    field: s.field,
    direction: s.direction === 'asc' ? 'ASC' : 'DESC',
  }));
}

/* -------------------------------------------------------------------------- */
/* sortStatesFromFilter + effectiveSort.                                       */
/* -------------------------------------------------------------------------- */

/** A persisted filter-card sort entry (attribute name + direction). */
export interface FilterSortEntry {
  attr: string;
  dir: 'asc' | 'desc';
}

/**
 * Map a filter card's persisted sort list to the {@link SortState}s the grid
 * hands to {@link buildOrderClauses}. Attribute names go through as
 * `attributes.<name>` because that's the field path the server's
 * `card.select_with_attributes` expects for attribute-valued ordering.
 */
export function sortStatesFromFilter(predicates: readonly FilterSortEntry[]): SortState[] {
  return predicates.map((p) => ({ field: `attributes.${p.attr}`, direction: p.dir }));
}

/**
 * Pick the effective sort: a single header-click sort overrides the filter's
 * persisted sort entirely. When the user clears their click (cycle off), the
 * persisted sort comes back. Returns `[]` when neither is set — server default
 * kicks in.
 */
export function effectiveSort(
  headerSort: SortState | null,
  filterSort: readonly SortState[],
): SortState[] {
  if (headerSort !== null) return [headerSort];
  return [...filterSort];
}

/* -------------------------------------------------------------------------- */
/* Column descriptors.                                                         */
/* -------------------------------------------------------------------------- */

/**
 * How a cell renders + how it resolves its label. `kind` tags the renderer;
 * the polymorphic id/ref kinds resolve their value through a lookup table the
 * grid maintains (person names / card titles / tag paths).
 */
export type ColumnKind =
  | 'id'
  | 'title'
  | 'ref' // a single card_ref attribute → label resolved via a lookup map
  | 'tag_prefix' // synthetic: the tag whose path starts `<prefix>/`
  | 'tags' // the catch-all tag chips
  | 'date' // a date-typed attribute
  | 'attr' // a scalar text/number attribute (rendered as its string value)
  | 'created'
  | 'last_activity';

/**
 * A grid column descriptor.
 *
 *   - `field` is the wire `order.field` value the server understands
 *     (`attributes.title`, `created_at`); `null` means the column is not
 *     sortable (the catch-all Tags column, whose value is a JSONB array).
 *   - `attrName` is the matching attribute name (used later for per-column
 *     filter Pickers — deferred in v1); `null` means no filter dropdown.
 *   - `key` is a stable per-column key for the keyed-list / `data-grid-col`.
 */
export interface ColumnDef {
  kind: ColumnKind;
  /** Stable per-column key (`data-grid-col` value, header `data-sort-field`). */
  key: string;
  label: string;
  field: string | null;
  attrName: string | null;
  /** For `ref`: the lookup-map name (`grid.lookups.<lookup>`) the value resolves through. */
  lookup?: string | null;
  /** For `ref`: the target card_type — where per-column filter options live
   *  (`screen.predicateOptions[targetCardType]`). */
  targetCardType?: string;
  /** For `tag_prefix`: the tag path prefix (no trailing slash). */
  prefix?: string;
}

/**
 * Build the Grid column set DATA-DRIVEN from the project's schema + the screen
 * config (replacing the old hardcoded list). In render order:
 *
 *   ID · Title · <one `ref` column per single card_ref axis> ·
 *   <one `tag_prefix` column per screen `tag_prefix_columns`> · Tags ·
 *   <one column per screen `extra_columns` attr (date vs scalar by schema)> ·
 *   Created · Last activity
 *
 *   - Ref columns come from `refAxes` (the same card_ref vocab axes the group
 *     picker / quick chips use); the multi-ref `tags` axis is skipped (it's the
 *     catch-all Tags column). Each resolves its label via the target type's
 *     lookup map (`lookupNameForCardType`).
 *   - `tagPrefixColumns` (e.g. `["priority"]`) → synthetic columns showing the
 *     tag value after `<prefix>/` (this is where the old hardcoded Priority
 *     column now comes from).
 *   - `extraColumns` (e.g. `["due_date"]`) → extra attribute columns, typed
 *     `date` vs `attr` from the schema; ones already shown as a ref are skipped.
 *
 * Empty inputs yield the minimal base (ID · Title · Tags · Created · Last
 * activity) — the cold/standalone fallback before the schema + screen config land.
 */
export function buildGridColumns(
  refAxes: readonly RefAxis[],
  schema: readonly AttrSchema[],
  extraColumns: readonly string[],
  tagPrefixColumns: readonly string[],
): ColumnDef[] {
  const cols: ColumnDef[] = [
    { kind: 'id', key: 'id', label: 'ID', field: null, attrName: null },
    { kind: 'title', key: 'title', label: 'Title', field: 'attributes.title', attrName: null },
  ];
  for (const ax of refAxes) {
    if (ax.multi) continue; // the multi-ref tags axis is the catch-all Tags column
    cols.push({
      kind: 'ref',
      key: ax.attr,
      label: ax.label,
      field: `attributes.${ax.attr}`,
      attrName: ax.attr,
      lookup: lookupNameForCardType(ax.targetCardType),
      targetCardType: ax.targetCardType,
    });
  }
  for (const prefix of tagPrefixColumns) {
    cols.push({
      kind: 'tag_prefix',
      key: `tag:${prefix}`,
      label: friendlyLabel(prefix),
      field: null,
      attrName: null,
      prefix,
    });
  }
  cols.push({ kind: 'tags', key: 'tags', label: 'Tags', field: null, attrName: null });
  const shown = new Set(cols.map((c) => c.attrName).filter((n): n is string => n !== null));
  for (const name of extraColumns) {
    if (shown.has(name)) continue;
    const sch = schema.find((a) => a.name === name);
    cols.push({
      kind: sch?.valueType === 'date' ? 'date' : 'attr',
      key: name,
      label: sch ? sch.label : friendlyLabel(name),
      field: `attributes.${name}`,
      attrName: name,
    });
    shown.add(name);
  }
  cols.push({ kind: 'created', key: 'created', label: 'Created', field: 'created_at', attrName: null });
  cols.push({ kind: 'last_activity', key: 'last_activity', label: 'Last activity', field: 'last_activity_at', attrName: null });
  return cols;
}

/**
 * The tag value for a `tag_prefix` column: the segment after `<prefix>/` in the
 * first matching resolved tag path, or null when no tag carries that prefix.
 */
export function tagPrefixValue(paths: readonly string[], prefix: string): string | null {
  const pre = `${prefix}/`;
  for (const p of paths) {
    if (p.startsWith(pre)) return p.slice(pre.length);
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Tag-path → chip segments (LIFTED from client/src/ui/widgets/TagChip.svelte  */
/* + grid_helpers `stripTagPrefix`).                                           */
/* -------------------------------------------------------------------------- */

/**
 * Split a tag `path` (`area/frontend/ui`) into its `/`-separated segments,
 * dropping empties. The TagChip renders the leaf as the chip label and keeps
 * the parent segments for a tooltip / future breadcrumb. Pure so the chip's
 * logic is unit-testable without the DOM.
 */
export function tagPathSegments(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

/** The chip's display label — the LEAF segment of a tag path (`ui`), or the
 *  whole path when it has no `/`. Empty paths fall back to the raw string. */
export function tagPathLeaf(path: string): string {
  const segs = tagPathSegments(path);
  return segs.length > 0 ? (segs[segs.length - 1] as string) : path;
}

/* -------------------------------------------------------------------------- */
/* Grouping — group_by_attr (LIFTED from client/src/screens/grid_helpers.ts    */
/* `walkGrouped` / `GroupItem`, re-expressed against the web card model).      */
/* -------------------------------------------------------------------------- */

/**
 * The GROUP-axis seam (`groupAttrFromGroupValue` + `GroupAttr`) now lives in the
 * shared `filter/group-axis.ts` module — both the Grid (row grouping) and the
 * Kanban board (column re-keying) read the same `screen.group` picker leaf and
 * need the same translation. Re-exported here so the Grid's existing import
 * path (`./grid-helpers.js`) keeps working unchanged.
 */
export { groupAttrFromGroupValue, type GroupAttr } from '../filter/group-axis.js';

/**
 * One entry in the flat sequence the recycling virtualList renders when a
 * group-by attr is active: either a section HEADER (one per consecutive run of
 * the same group-key value) or a data ROW. Headers don't consume a row index;
 * each row carries its position in the rows-only sequence as `idx`.
 */
export type GroupItem<T> =
  | { kind: 'group'; label: string; count: number; key: string }
  | { kind: 'row'; row: T; idx: number };

/** Sentinel group key for rows whose group attribute is unset / null / "". */
export const GROUP_EMPTY_KEY = '__empty__';

/**
 * Walk pre-ordered `rows` and emit a HEADER whenever `attrName`'s value changes
 * from the previous row, followed by that bucket's rows — a FLAT
 * `[{kind:'group'}, {kind:'row'}, …]` list the virtualList renders without
 * losing recycling (every entry is one fixed-height slot). Relies on the caller
 * having pre-ordered rows by the group key (the server does this by prepending
 * the group field to the wire `order[]`), so the walk is O(n) and never
 * re-buckets.
 *
 * `attrName === null` → the rows pass through as a flat row-only sequence (the
 * no-group case, identical to today's behaviour).
 *
 * Each header carries the bucket `count` (the run length) so the rendered label
 * can read `Doing · 4`. Empty / null / "" values cluster into a single
 * `(unset)` bucket. `labelOf` resolves a card_ref group value (bigint id) to a
 * display title; it is NOT called for the unset bucket.
 */
export function walkGrouped<T extends { attributes: Record<string, unknown> }>(
  rows: readonly T[],
  attrName: string | null,
  labelOf: (key: unknown) => string,
): GroupItem<T>[] {
  if (attrName === null) {
    return rows.map((row, idx) => ({ kind: 'row', row, idx }) as GroupItem<T>);
  }
  const out: GroupItem<T>[] = [];
  // Track the most recent header so we can stamp its run length once the run
  // ends (we don't know a bucket's size until we hit the next key boundary).
  let header: { kind: 'group'; label: string; count: number; key: string } | null = null;
  let prevKey: string | undefined;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const v = row.attributes[attrName];
    const isEmpty = v === undefined || v === null || v === '';
    const key = isEmpty ? GROUP_EMPTY_KEY : String(v);
    if (key !== prevKey) {
      header = { kind: 'group', label: isEmpty ? '(unset)' : labelOf(v), count: 0, key };
      out.push(header);
      prevKey = key;
    }
    if (header !== null) header.count += 1;
    out.push({ kind: 'row', row, idx: i });
  }
  return out;
}
