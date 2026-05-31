/**
 * GROUP-axis seam — the single mapping from the GROUP picker's human vocabulary
 * (`screen.group`: 'milestone' / 'status' / 'component' / 'assignee') to the
 * stored card attribute it buckets on AND the label-lookup map NAME whose
 * `{id:label}` resolves a card_ref group key to a display label.
 *
 * Both the Grid (row grouping → `group_by_attr`) and the Kanban board (column
 * re-keying) read the same picker leaf and need the same translation, so this
 * lives in `filter/` as the shared seam rather than in either screen's helper
 * module. `grid-helpers.ts` re-exports it for backwards compatibility (so the
 * Grid's existing import path keeps working without a code change).
 *
 *   - `attr`   — the `attributes.<attr>` key the rows carry (and the server
 *     orders on); also the suffix of the wire `order.field`.
 *   - `lookup` — the `<screen>.lookups.<name>` map name (persons / statuses /
 *     milestones / components), or null for a scalar group attr whose value is
 *     its own label.
 *
 * Returns null for an absent / unknown / empty group value — the caller treats
 * that as "no grouping" (Grid → flat list; Kanban → fall back to its default
 * milestone axis).
 */

export interface GroupAttr {
  attr: string;
  lookup: string | null;
  /**
   * When set, this axis groups by a mutually-exclusive TAG PREFIX (the named
   * `root_exclusive_at` segment, e.g. 'priority') rather than the raw value of
   * `attr`. `attr` is then 'tags' and `lookup` is 'tags'; consumers bucket each
   * card by the single tag it carries under this root. See filter/tag-prefix.ts.
   */
  tagPrefix?: string;
}

export function groupAttrFromGroupValue(value: string | null | undefined): GroupAttr | null {
  switch (value) {
    case 'milestone':
      return { attr: 'milestone_ref', lookup: 'milestones' };
    case 'component':
      return { attr: 'component_ref', lookup: 'components' };
    case 'status':
      return { attr: 'status', lookup: 'statuses' };
    case 'assignee':
      return { attr: 'assignee', lookup: 'persons' };
    default:
      return null;
  }
}

/**
 * Target card_type name → the (plural) lookup-map name each screen stores that
 * type's `{id:label}` value-cards under (`grid.lookups.<name>` /
 * `kanban.axis.<name>`). This is the ONLY residual naming convention; the axis
 * SET itself is data-driven (see filter/vocabulary.ts). An unmapped target
 * falls back to its own name, so a custom ref attr still resolves a lookup key
 * (its labels just won't be pre-loaded by the built-in grid/kanban queries).
 */
const CARD_TYPE_TO_LOOKUP: Readonly<Record<string, string>> = {
  person: 'persons',
  status: 'statuses',
  milestone: 'milestones',
  component: 'components',
  tag: 'tags',
};

/** The lookup-map name for a target card_type (see {@link CARD_TYPE_TO_LOOKUP}). */
export function lookupNameForCardType(targetCardType: string): string {
  return CARD_TYPE_TO_LOOKUP[targetCardType] ?? targetCardType;
}

/**
 * Resolve a {@link GroupAttr} for a group axis identified by its ATTRIBUTE NAME
 * (the data-driven group-picker value) plus the attribute's target card_type.
 * Replaces the hardcoded {@link groupAttrFromGroupValue} switch on the
 * data-driven path: the ScreenFilterBar resolves this from the loaded schema
 * and publishes it at `screen.groupAxis` for the Grid / Kanban to consume.
 * Returns null for an empty attr (→ no grouping).
 */
export function groupAxisForAttr(
  attr: string | null | undefined,
  targetCardType: string | null | undefined,
): GroupAttr | null {
  if (attr === null || attr === undefined || attr === '') return null;
  return { attr, lookup: targetCardType ? lookupNameForCardType(targetCardType) : null };
}

/* -------------------------------------------------------------------------- */
/* Grouped item sequence — the flat header+row model the recycling virtualList */
/* renders. Shared by the Grid (row grouping) and the Inbox (list grouping):   */
/* both walk server-ordered rows into the same `[{group}, {row}, …]` shape.    */
/* -------------------------------------------------------------------------- */

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
 * the group field to the wire `order[]`, and the Inbox's client sort clusters
 * by it), so the walk is O(n) and never re-buckets.
 *
 * `attrName === null` → the rows pass through as a flat row-only sequence (the
 * no-group case, identical to the ungrouped behaviour).
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
