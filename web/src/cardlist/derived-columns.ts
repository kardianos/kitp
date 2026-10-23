/**
 * Derived task columns — values the server computes from a task's related
 * cards instead of storing them as attributes (today: its open approval
 * requests). A screen asks for one by naming it in `extra_columns`, the
 * same list that adds attribute columns; the Grid (a column), list rows and
 * Kanban cards (a chip) render it from this table, so none of them branch
 * on which column it is.
 */

import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import { approvalAsked, approvalBadge } from '../ui/approval-badge.js';

export interface DerivedColumn {
  /** The card_type whose rows carry it (what the admin Columns editor offers). */
  cardType: string;
  label: string;
  /** card.select_with_attributes order field (the Grid's header sort). */
  sortField: string;
  /** The row query has to ask for `with_approvals`. */
  withApprovals: boolean;
  /** The cell / chip content; null when the task has no value. */
  render: (row: CardWithAttrs) => HTMLElement | null;
}

export const DERIVED_COLUMNS: Readonly<Record<string, DerivedColumn>> = {
  approvals: {
    cardType: 'task',
    label: 'Approvals',
    sortField: 'approval_state',
    withApprovals: true,
    render: (row) => approvalBadge(row.approvals),
  },
  approval_asked_at: {
    cardType: 'task',
    label: 'Approval asked',
    sortField: 'approval_asked_at',
    withApprovals: true,
    render: (row) => approvalAsked(row.approvals),
  },
};

/** The derived column named [name], or undefined for an attribute column. */
export function derivedColumn(name: string): DerivedColumn | undefined {
  return Object.hasOwn(DERIVED_COLUMNS, name) ? DERIVED_COLUMNS[name] : undefined;
}

/** The derived columns [cardType]'s rows offer, as [name, column] pairs. */
export function derivedColumnsFor(cardType: string): Array<[string, DerivedColumn]> {
  return Object.entries(DERIVED_COLUMNS).filter(([, c]) => c.cardType === cardType);
}

/** Whether a screen showing [columns] needs `with_approvals` on its rows. */
export function columnsNeedApprovals(columns: readonly string[]): boolean {
  return columns.some((c) => derivedColumn(c)?.withApprovals === true);
}

/** The rendered derived columns among [columns] for [row], in order — what a
 *  list row or Kanban card shows as chips (attribute columns stay Grid-only). */
export function derivedParts(columns: readonly string[], row: CardWithAttrs): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const name of columns) {
    const el = derivedColumn(name)?.render(row) ?? null;
    if (el !== null) out.push(el);
  }
  return out;
}
