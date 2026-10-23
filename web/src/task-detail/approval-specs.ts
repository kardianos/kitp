/**
 * approval.* API specs — task approval requests and votes.
 *
 * Approvals are a record, never a gate: nothing blocks or moves a task. A
 * vote belongs to an EDGE — the task moving from one specific status to
 * another ("Approve: Review → Done") — and a request asks named people to
 * vote on one. An edge's votes run in rounds: once the task reaches the
 * edge's target they're settled (off the task's Approvals column, kept on
 * the task). What waits on whom is a task property read through
 * card.select_with_attributes (with_approvals + the approval_* filters), not
 * an approval.* endpoint.
 *
 * Wire shapes (snake_case; ids ship as JSON strings and revive to bigint):
 *
 *   - approval.list   in : { task_id }
 *       out: { status?, actions: [{ from, to, label }],
 *              requests: [{ id, from, to, action, note, requested_by_id,
 *                           requested_by, requested_at, reached_at?,
 *                           approvers: [{ person_id, name }],
 *                           comm?: { id, subject, messages } }],
 *              decisions: [{ id, by_id, by, person_id, decision, from_id,
 *                            to_id, action, status?, reason, at, settled,
 *                            stale }] }          — decisions newest first
 *   - approval.set    in : { id?, task_id, from_status_id?, to_status_id?,
 *                            approver_ids?, note?,
 *                            email?: { channel_id, subject? } }  — email: create
 *                            only; also starts an email thread to the people
 *                            asked, the note as its message
 *       out: { approval_id, created, changed, comm_id? }
 *   - approval.remove in : { id }   out: { removed }
 *   - approval.decide in : { task_id, approval_id? | from_status_id +
 *                            to_status_id, decision, reason? }
 *       out: { decision_id, changed }
 */

import type { Api } from '../core/api.js';

export const APPROVAL_LIST_SPEC = 'approval.list';
export const APPROVAL_SET_SPEC = 'approval.set';
export const APPROVAL_REMOVE_SPEC = 'approval.remove';
export const APPROVAL_DECIDE_SPEC = 'approval.decide';

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
  /** The email thread the request started (a comm on the task), or null. */
  comm: RequestComm | null;
}

/** An email thread a vote request started. */
export interface RequestComm {
  id: bigint;
  subject: string;
  /** Messages in the thread, sent and received. */
  messages: number;
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
  /** Create only: also email the people asked through this channel, the note
   *  as the message (then required). */
  email?: { channelId: bigint; subject?: string };
}
export interface ApprovalSetOutput {
  approvalId: bigint;
  created: boolean;
  changed: boolean;
  /** The email thread started; 0n when none. */
  commId: bigint;
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

export function decodeStatusRef(v: unknown): StatusRef {
  const j = asObj(v);
  return { id: asId(j['id']), label: asStr(j['label']), phase: asStr(j['phase']) };
}
function decodeStatusOrNull(v: unknown): StatusRef | null {
  return v && typeof v === 'object' ? decodeStatusRef(v) : null;
}
function decodeRequestComm(v: unknown): RequestComm | null {
  if (!v || typeof v !== 'object') return null;
  const j = asObj(v);
  const n = j['messages'];
  return { id: asId(j['id']), subject: asStr(j['subject']), messages: typeof n === 'number' ? n : 0 };
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
        comm: decodeRequestComm(j['comm']),
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

/* ------------------------------- registration ----------------------------- */

/**
 * Register the approval specs against `api`. Call once at boot, before the
 * TaskDetail mounts its approval control. Idempotent-by-presence
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
        if (i.email !== undefined) {
          m['email'] = {
            channel_id: i.email.channelId,
            ...(i.email.subject !== undefined && i.email.subject !== '' ? { subject: i.email.subject } : {}),
          };
        }
        return m;
      },
      decode: (raw): ApprovalSetOutput => {
        const j = asObj(raw);
        return {
          approvalId: asId(j['approval_id']),
          created: j['created'] === true,
          changed: j['changed'] === true,
          commId: asId(j['comm_id']),
        };
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
}
