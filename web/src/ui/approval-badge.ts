/**
 * How a task's open approval requests stand, for the Approvals column a
 * screen can ask for (Grid cell, list row chip, Kanban card): ✓ 2/2 all
 * approved, ✕ when anyone voted reject, … 1/3 while votes are missing, plus
 * "your vote" when one of them waits on the viewer. From the row's
 * `approvals` summary (card.select_with_attributes `with_approvals`); a task
 * with no open request shows nothing. Settled requests (the task reached the
 * status they were about) aren't counted, so the badge drops off.
 *
 * These are votes, never the status change itself, so the tooltip says so.
 */

import { icon, type IconName } from './icons.js';
import { formatRelativeTime } from '../task-detail/activity-text.js';
import { formatLocalDateTime } from '../util/datetime.js';

export type ApprovalState = 'open' | 'approved' | 'rejected';

export interface ApprovalSummary {
  state: ApprovalState;
  asked: number;
  approved: number;
  rejected: number;
  /** When the oldest open request was made (ISO). */
  askedAt: string;
  /** An open request asks the viewer and they haven't voted on its step. */
  waitingOnMe: boolean;
}

const TONE: Readonly<Record<ApprovalState, { tone: string; icon: IconName }>> = {
  open: { tone: 'pending', icon: 'ellipsis' },
  approved: { tone: 'success', icon: 'check' },
  rejected: { tone: 'danger', icon: 'x' },
};

/** The Approvals badge for [s], or null when there's nothing open. */
export function approvalBadge(s: ApprovalSummary | undefined): HTMLElement | null {
  if (s === undefined || s.asked <= 0) return null;
  const look = TONE[s.state] ?? TONE.open;
  const el = document.createElement('span');
  el.className = 'approval-badge';
  el.dataset.approvalBadge = look.tone;
  el.append(icon(look.icon, 12));
  const text = document.createElement('span');
  text.textContent = `${s.approved}/${s.asked}`;
  el.append(text);
  if (s.waitingOnMe) {
    el.dataset.approvalMine = '';
    const mine = document.createElement('span');
    mine.className = 'approval-badge__mine';
    mine.textContent = 'your vote';
    el.append(mine);
  }
  const parts = [`${s.approved} of ${s.asked} voted approve`];
  if (s.rejected > 0) parts.push(`${s.rejected} voted reject`);
  if (s.waitingOnMe) parts.push('your vote is needed');
  el.title = `Approval votes: ${parts.join(', ')}. Votes don't change the status.`;
  return el;
}

/** When [s]'s oldest open request was made ("asked 3d ago"), or null. */
export function approvalAsked(s: ApprovalSummary | undefined): HTMLElement | null {
  if (s === undefined || s.askedAt === '') return null;
  const el = document.createElement('time');
  el.className = 'approval-asked muted';
  el.dateTime = s.askedAt;
  el.textContent = `asked ${formatRelativeTime(s.askedAt)}`;
  el.title = `Approval asked ${formatLocalDateTime(s.askedAt)}`;
  return el;
}
