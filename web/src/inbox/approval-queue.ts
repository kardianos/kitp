/**
 * ApprovalQueue — "Waiting on you": the approval requests that ask the
 * signed-in person and that they haven't voted on yet, across every project
 * they can see (approval.queue). A screen panel (the Inbox's `panels`
 * attribute names it), shown between the filter bar and the list, and
 * hidden while nothing is waiting.
 *
 * Each row says what the person is asked: the task, the status it's in now,
 * the action and where it leads ("Approve → Done"), who asked and when, and
 * the tally so far — with Approve / Reject right there (approval.decide on
 * the request) and the task a click away. A vote is a record only; it moves
 * nothing.
 *
 * The count lands in the tree at `approvals.waiting` so the rail's badge
 * agrees with the band after a vote (AppShell's poll writes it too).
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { icon } from '../ui/icons.js';
import { localTimeEl } from '../util/datetime.js';
import { navigate, plainClick, taskUrl } from '../shell/router.js';
import {
  APPROVAL_QUEUE_SPEC,
  APPROVAL_DECIDE_SPEC,
  type ApprovalQueueOutput,
  type ApprovalQueueRow,
  type Verdict,
} from '../task-detail/approval-specs.js';

export interface ApprovalQueueConfig extends BaseControlConfig {
  type: 'ApprovalQueue';
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    ApprovalQueue: ApprovalQueueConfig;
  }
}

/** Tree leaf holding how many requests wait on the viewer (rail badge). */
export const APPROVALS_WAITING_PATH = ['approvals', 'waiting'] as const;

export class ApprovalQueue extends Control<ApprovalQueueConfig> {
  private rows: ApprovalQueueRow[] = [];
  private busy = false;
  private countEl!: HTMLElement;
  private listEl!: HTMLElement;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'approval-queue';
    el.dataset.control = 'ApprovalQueue';
    el.dataset.approvalQueue = '';
    el.setAttribute('aria-label', 'Approvals waiting on you');
    return el;
  }

  protected render(): void {
    const head = document.createElement('div');
    head.className = 'approval-queue__head';
    const title = document.createElement('span');
    title.className = 'approval-queue__title';
    title.textContent = 'Waiting on you';
    const count = document.createElement('span');
    count.className = 'approval-queue__count';
    count.dataset.approvalQueueCount = '';
    this.countEl = count;
    head.append(title, count);

    const list = document.createElement('ul');
    list.className = 'approval-queue__rows';
    this.listEl = list;
    this.el.append(head, list);
    this.paint();
    this.load();
  }

  /** Re-read the queue (after a vote, or a host refresh). */
  reload(): void {
    this.load();
  }

  private load(): void {
    this.ctx.api.callByName(
      APPROVAL_QUEUE_SPEC,
      {},
      (out) => {
        if (!this.isAlive()) return;
        this.rows = (out as ApprovalQueueOutput).rows ?? [];
        this.ctx.tree.at([...APPROVALS_WAITING_PATH]).set(this.rows.length);
        this.paint();
      },
      { alive: () => this.isAlive() },
    );
  }

  private paint(): void {
    this.el.style.display = this.rows.length === 0 ? 'none' : '';
    this.countEl.textContent = String(this.rows.length);
    this.listEl.replaceChildren(...this.rows.map((r) => this.renderRow(r)));
  }

  private renderRow(r: ApprovalQueueRow): HTMLElement {
    const li = document.createElement('li');
    li.className = 'approval-queue__row';
    li.dataset.approvalQueueRow = r.approvalId.toString();

    const main = document.createElement('div');
    main.className = 'approval-queue__main';

    const top = document.createElement('div');
    top.className = 'approval-queue__line';
    const link = document.createElement('a');
    link.className = 'approval-queue__task';
    link.href = taskUrl(r.taskId);
    const id = document.createElement('span');
    id.className = 'approval-queue__id muted';
    id.textContent = `#${r.taskId.toString()}`;
    link.append(id, ` ${r.taskTitle || 'Untitled'}`);
    this.listen(link, 'click', plainClick(() => navigate(taskUrl(r.taskId))));
    top.append(link);
    const pid = this.ctx.tree.at(['scope', 'projectId']).peek<bigint | null>() ?? null;
    if (pid === null || pid !== r.projectId) {
      const project = document.createElement('span');
      project.className = 'approval-queue__project muted';
      project.textContent = r.projectTitle;
      top.append(project);
    }

    // What's asked: the status it's in now, then the action and where it leads.
    const asked = document.createElement('div');
    asked.className = 'approval-queue__line approval-queue__asked';
    asked.dataset.approvalQueueAsked = '';
    const now = document.createElement('span');
    now.className = 'approval-queue__status';
    now.dataset.phase = r.status?.phase ?? '';
    now.textContent = r.status?.label ?? '—';
    const action = document.createElement('span');
    action.className = 'approval-queue__action';
    action.textContent = r.action;
    const to = document.createElement('span');
    to.className = 'approval-queue__status';
    to.dataset.phase = r.to.phase;
    to.textContent = r.to.label;
    asked.append(now, arrow(), action, arrow(), to);
    if (r.status !== null && r.status.id !== r.from.id) {
      const from = document.createElement('span');
      from.className = 'muted';
      from.textContent = `(asked at ${r.from.label})`;
      asked.append(from);
    }

    const meta = document.createElement('div');
    meta.className = 'approval-queue__line approval-queue__meta muted';
    meta.append(`asked by ${r.requestedBy || 'someone'} · `, localTimeEl(r.requestedAt, 'approval-queue__time'));
    if (r.asked > 1) meta.append(` · ${r.approved} of ${r.asked} approved${r.rejected > 0 ? `, ${r.rejected} rejected` : ''}`);
    if (r.note !== '') {
      const note = document.createElement('span');
      note.className = 'approval-queue__note';
      note.textContent = ` · “${r.note.length > 120 ? `${r.note.slice(0, 119)}…` : r.note}”`;
      meta.append(note);
    }
    main.append(top, asked, meta);

    const actions = document.createElement('div');
    actions.className = 'approval-queue__actions';
    actions.append(this.voteButton(r, 'approve'), this.voteButton(r, 'reject'));
    li.append(main, actions);
    return li;
  }

  private voteButton(r: ApprovalQueueRow, decision: Verdict): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn approval-queue__vote${decision === 'approve' ? ' btn-primary' : ''}`;
    b.dataset.approvalQueueVote = decision;
    b.append(icon(decision === 'approve' ? 'check' : 'x', 14), decision === 'approve' ? ' Approve' : ' Reject');
    this.listen(b, 'click', () => this.vote(r, decision));
    return b;
  }

  private vote(r: ApprovalQueueRow, decision: Verdict): void {
    if (this.busy) return;
    this.busy = true;
    this.ctx.api.callByName(
      APPROVAL_DECIDE_SPEC,
      { taskId: r.taskId, approvalId: r.approvalId, decision },
      () => {
        if (!this.isAlive()) return;
        this.busy = false;
        this.load();
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          this.busy = false;
        },
      },
    );
  }
}

function arrow(): HTMLElement {
  const a = document.createElement('span');
  a.className = 'approval-queue__arrow muted';
  a.setAttribute('aria-hidden', 'true');
  a.textContent = '→';
  return a;
}

export function registerApprovalQueue(): void {
  Control.register('ApprovalQueue', ApprovalQueue);
}
