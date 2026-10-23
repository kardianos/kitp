/**
 * The approval badge task rows carry (Inbox list, Grid title, Kanban card):
 * how the task's open approval requests stand — ✓ 2/2 all approved, ✕ when
 * anyone rejected, … 1/3 while votes are outstanding. From the row's
 * `approvals` summary (card.select_with_attributes `with_approvals`); a task
 * with no open request gets no badge. Settled requests (the task reached
 * the status they were about) aren't counted, so the badge drops off.
 */

import { icon } from './icons.js';

export interface ApprovalSummary {
  asked: number;
  approved: number;
  rejected: number;
}

/** The badge for [s], or null when there's nothing open. */
export function approvalBadge(s: ApprovalSummary | undefined): HTMLElement | null {
  if (s === undefined || s.asked <= 0) return null;
  const tone = s.rejected > 0 ? 'danger' : s.approved >= s.asked ? 'success' : 'pending';
  const el = document.createElement('span');
  el.className = 'approval-badge';
  el.dataset.approvalBadge = tone;
  el.append(icon(tone === 'danger' ? 'x' : tone === 'success' ? 'check' : 'ellipsis', 12));
  const text = document.createElement('span');
  text.textContent = `${s.approved}/${s.asked}`;
  el.append(text);
  const parts = [`${s.approved} of ${s.asked} approved`];
  if (s.rejected > 0) parts.push(`${s.rejected} rejected`);
  el.title = `Approvals: ${parts.join(', ')}`;
  return el;
}
