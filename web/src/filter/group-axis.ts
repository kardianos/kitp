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
