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
