/**
 * approval.* API specs — task approval requests and votes.
 *
 * Approvals are a record, never a gate: nothing blocks or moves a task. A
 * vote belongs to an EDGE — the task moving from one specific status to
 * another ("Approve: Review → Done") — and a request asks named people to
 * vote on one. An edge's votes run in rounds: once the task reaches the
 * edge's target they're settled (off list badges and the queue, kept on the
 * task).
 *
 * Wire shapes (snake_case; ids ship as JSON strings and revive to bigint):
 *
 *   - approval.list   in : { task_id }
 *       out: { status?, actions: [{ from, to, label }],
 *              requests: [{ id, from, to, action, note, requested_by_id,
 *                           requested_by, requested_at, reached_at?,
 *                           approvers: [{ person_id, name }] }],
 *              decisions: [{ id, by_id, by, person_id, decision, from_id,
 *                            to_id, action, status?, reason, at, settled,
 *                            stale }] }          — decisions newest first
 *   - approval.set    in : { id?, task_id, from_status_id?, to_status_id?,
 *                            approver_ids?, note? }
 *       out: { approval_id, created, changed }
 *   - approval.remove in : { id }   out: { removed }
 *   - approval.decide in : { task_id, approval_id? | from_status_id +
 *                            to_status_id, decision, reason? }
 *       out: { decision_id, changed }
 *   - approval.queue  in : { project_id? }
 *       out: { rows: [{ approval_id, task_id, task_title, project_id,
 *                       project_title, status?, from, to, action, note,
 *                       requested_by, requested_at, asked, approved,
 *                       rejected }] }
 */

import type { Api } from '../core/api.js';

export const APPROVAL_LIST_SPEC = 'approval.list';
export const APPROVAL_SET_SPEC = 'approval.set';
export const APPROVAL_REMOVE_SPEC = 'approval.remove';
export const APPROVAL_DECIDE_SPEC = 'approval.decide';
export const APPROVAL_QUEUE_SPEC = 'approval.queue';

/* ------------------------------- web model -------------------------------- */

export interface StatusRef {
  id: bigint;
  label: string;
  phase: string;
}

/** One step of the task's status flow. */
export interface ApprovalAction {
  from: StatusRef;
  to: StatusRef;
  label: string;
}

export interface ApprovalRequest {
  id: bigint;
  from: StatusRef;
  to: StatusRef;
  action: string;
  note: string;
  requestedById: bigint;
  requestedBy: string;
  requestedAt: string;
  /** When the task reached the edge's target after this request ('' while open). */
  reachedAt: string;
  approvers: Array<{ personId: bigint; name: string }>;
}

export type Verdict = 'approve' | 'reject';

export interface ApprovalVote {
  id: bigint;
  byId: bigint;
  /** Who voted; an agent is named with its owner ("claude (for Dana)"). */
  by: string;
  /** The voter's person card; 0n for an agent (whose vote answers no request). */
  personId: bigint;
  decision: Verdict;
  fromId: bigint;
  toId: bigint;
  action: string;
  status: StatusRef | null;
  reason: string;
  at: string;
  /** Cast before the task last reached the edge's target: a finished round. */
  settled: boolean;
  /** The task has since moved to a status other than the edge's target. */
  stale: boolean;
}

export interface ApprovalListInput {
  taskId: bigint;
}
export interface ApprovalListOutput {
  status: StatusRef | null;
  actions: ApprovalAction[];
  requests: ApprovalRequest[];
  decisions: ApprovalVote[];
}

export interface ApprovalSetInput {
  id?: bigint;
  taskId: bigint;
  fromStatusId?: bigint;
  toStatusId?: bigint;
  approverIds?: readonly bigint[];
  note?: string;
}
export interface ApprovalSetOutput {
  approvalId: bigint;
  created: boolean;
  changed: boolean;
}

export interface ApprovalRemoveInput {
  id: bigint;
}
export interface ApprovalRemoveOutput {
  removed: boolean;
}

export interface ApprovalDecideInput {
  taskId: bigint;
  approvalId?: bigint;
  fromStatusId?: bigint;
  toStatusId?: bigint;
  decision: Verdict;
  reason?: string;
}
export interface ApprovalDecideOutput {
  decisionId: bigint;
  changed: boolean;
}

export interface ApprovalQueueInput {
  projectId?: bigint;
}
export interface ApprovalQueueRow {
  approvalId: bigint;
  taskId: bigint;
  taskTitle: string;
  projectId: bigint;
  projectTitle: string;
  status: StatusRef | null;
  from: StatusRef;
  to: StatusRef;
  action: string;
  note: string;
  requestedBy: string;
  requestedAt: string;
  asked: number;
  approved: number;
  rejected: number;
}
export interface ApprovalQueueOutput {
  rows: ApprovalQueueRow[];
}

/* ------------------------------ decode helpers ---------------------------- */

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asId(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
}
function asStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (v === null || v === undefined) return '';
  return String(v);
}
function asNum(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0) || 0;
}

export function decodeStatusRef(v: unknown): StatusRef {
  const j = asObj(v);
  return { id: asId(j['id']), label: asStr(j['label']), phase: asStr(j['phase']) };
}
function decodeStatusOrNull(v: unknown): StatusRef | null {
  return v && typeof v === 'object' ? decodeStatusRef(v) : null;
}

export function decodeApprovalList(raw: unknown): ApprovalListOutput {
  const o = asObj(raw);
  return {
    status: decodeStatusOrNull(o['status']),
    actions: asArray(o['actions']).map((a) => {
      const j = asObj(a);
      return { from: decodeStatusRef(j['from']), to: decodeStatusRef(j['to']), label: asStr(j['label']) };
    }),
    requests: asArray(o['requests']).map((r) => {
      const j = asObj(r);
      return {
        id: asId(j['id']),
        from: decodeStatusRef(j['from']),
        to: decodeStatusRef(j['to']),
        action: asStr(j['action']),
        note: asStr(j['note']),
        requestedById: asId(j['requested_by_id']),
        requestedBy: asStr(j['requested_by']),
        requestedAt: asStr(j['requested_at']),
        reachedAt: asStr(j['reached_at']),
        approvers: asArray(j['approvers']).map((a) => {
          const p = asObj(a);
          return { personId: asId(p['person_id']), name: asStr(p['name']) };
        }),
      };
    }),
    decisions: asArray(o['decisions']).map((d) => {
      const j = asObj(d);
      return {
        id: asId(j['id']),
        byId: asId(j['by_id']),
        by: asStr(j['by']),
        personId: asId(j['person_id']),
        decision: j['decision'] === 'approve' ? 'approve' : 'reject',
        fromId: asId(j['from_id']),
        toId: asId(j['to_id']),
        action: asStr(j['action']),
        status: decodeStatusOrNull(j['status']),
        reason: asStr(j['reason']),
        at: asStr(j['at']),
        settled: j['settled'] === true,
        stale: j['stale'] === true,
      };
    }),
  };
}

export function decodeApprovalQueue(raw: unknown): ApprovalQueueOutput {
  return {
    rows: asArray(asObj(raw)['rows']).map((r) => {
      const j = asObj(r);
      return {
        approvalId: asId(j['approval_id']),
        taskId: asId(j['task_id']),
        taskTitle: asStr(j['task_title']),
        projectId: asId(j['project_id']),
        projectTitle: asStr(j['project_title']),
        status: decodeStatusOrNull(j['status']),
        from: decodeStatusRef(j['from']),
        to: decodeStatusRef(j['to']),
        action: asStr(j['action']),
        note: asStr(j['note']),
        requestedBy: asStr(j['requested_by']),
        requestedAt: asStr(j['requested_at']),
        asked: asNum(j['asked']),
        approved: asNum(j['approved']),
        rejected: asNum(j['rejected']),
      };
    }),
  };
}

/* ------------------------------- registration ----------------------------- */

/**
 * Register the approval specs against `api`. Call once at boot, before the
 * TaskDetail / Inbox mount their approval controls. Idempotent-by-presence
 * (`api.define` throws on a duplicate key, so each define is guarded).
 */
export function registerApprovalSpecs(api: Api): void {
  if (!api.registry.has({ endpoint: 'approval', action: 'list' })) {
    api.define<ApprovalListInput, ApprovalListOutput>({
      endpoint: 'approval',
      action: 'list',
      encode: (i) => ({ task_id: i.taskId }),
      decode: decodeApprovalList,
    });
  }
  if (!api.registry.has({ endpoint: 'approval', action: 'set' })) {
    api.define<ApprovalSetInput, ApprovalSetOutput>({
      endpoint: 'approval',
      action: 'set',
      encode: (i) => {
        const m: Record<string, unknown> = { task_id: i.taskId };
        if (i.id !== undefined) m['id'] = i.id;
        if (i.fromStatusId !== undefined) m['from_status_id'] = i.fromStatusId;
        if (i.toStatusId !== undefined) m['to_status_id'] = i.toStatusId;
        if (i.approverIds !== undefined) m['approver_ids'] = i.approverIds.map(String);
        if (i.note !== undefined) m['note'] = i.note;
        return m;
      },
      decode: (raw): ApprovalSetOutput => {
        const j = asObj(raw);
        return { approvalId: asId(j['approval_id']), created: j['created'] === true, changed: j['changed'] === true };
      },
    });
  }
  if (!api.registry.has({ endpoint: 'approval', action: 'remove' })) {
    api.define<ApprovalRemoveInput, ApprovalRemoveOutput>({
      endpoint: 'approval',
      action: 'remove',
      encode: (i) => ({ id: i.id }),
      decode: (raw): ApprovalRemoveOutput => ({ removed: asObj(raw)['removed'] === true }),
    });
  }
  if (!api.registry.has({ endpoint: 'approval', action: 'decide' })) {
    api.define<ApprovalDecideInput, ApprovalDecideOutput>({
      endpoint: 'approval',
      action: 'decide',
      encode: (i) => {
        const m: Record<string, unknown> = { task_id: i.taskId, decision: i.decision };
        if (i.approvalId !== undefined) m['approval_id'] = i.approvalId;
        if (i.fromStatusId !== undefined) m['from_status_id'] = i.fromStatusId;
        if (i.toStatusId !== undefined) m['to_status_id'] = i.toStatusId;
        if (i.reason !== undefined && i.reason.trim() !== '') m['reason'] = i.reason.trim();
        return m;
      },
      decode: (raw): ApprovalDecideOutput => {
        const j = asObj(raw);
        return { decisionId: asId(j['decision_id']), changed: j['changed'] === true };
      },
    });
  }
  if (!api.registry.has({ endpoint: 'approval', action: 'queue' })) {
    api.define<ApprovalQueueInput, ApprovalQueueOutput>({
      endpoint: 'approval',
      action: 'queue',
      encode: (i) => (i.projectId !== undefined ? { project_id: i.projectId } : {}),
      decode: decodeApprovalQueue,
    });
  }
}
