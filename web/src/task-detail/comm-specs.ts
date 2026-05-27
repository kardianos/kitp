/**
 * comm.list_for_task / comm.create / comm.set_recipients / reply.post API specs
 * — the reads + writes backing the Task-detail COMMS (email-thread) surface.
 *
 * Declared up front and registered via `api.define`, addressed through their
 * `endpoint.action` keys. Shapes match the Go handlers verbatim (snake_case on
 * the wire; ids ship as JSON strings and revive to bigint):
 *
 *   - comm.list_for_task  in : { task_id }
 *       out: { rows: [{ id, title, thread_id, channel_id, comm_status,
 *                        recipients[], replies: [{ id, to, from, subject,
 *                        body_text, delivery_status, created_at }] }] }
 *   - comm.create         in : { task_id, channel_id, subject?, initial_message?,
 *                                recipient_person_ids? }
 *       out: { comm_id, thread_id }
 *   - comm.set_recipients in : { comm_id, recipient_person_ids }  out: { count }
 *   - reply.post          in : { comm_id, body, attachment_ids? } out: { reply_id }
 */

import type { Api } from '../core/api.js';

export const COMM_LIST_FOR_TASK_SPEC = 'comm.list_for_task';
export const COMM_CREATE_SPEC = 'comm.create';
export const COMM_SET_RECIPIENTS_SPEC = 'comm.set_recipients';
export const REPLY_POST_SPEC = 'reply.post';

/* ------------------------------- web model -------------------------------- */

export interface ReplyRow {
  id: bigint;
  to: string;
  from: string;
  subject: string;
  bodyText: string;
  deliveryStatus: string;
  createdAt: string;
}

export interface CommRow {
  id: bigint;
  title: string;
  threadId: string;
  channelId: bigint;
  commStatus: bigint;
  recipients: bigint[];
  replies: ReplyRow[];
}

export interface CommListForTaskInput {
  taskId: bigint;
}
export interface CommListForTaskOutput {
  rows: CommRow[];
}

export interface CommCreateInput {
  taskId: bigint;
  channelId: bigint;
  subject?: string;
  initialMessage?: string;
  recipientPersonIds?: bigint[];
}
export interface CommCreateOutput {
  commId: bigint;
  threadId: string;
}

export interface CommSetRecipientsInput {
  commId: bigint;
  recipientPersonIds: bigint[];
}
export interface CommSetRecipientsOutput {
  count: number;
}

export interface ReplyPostInput {
  commId: bigint;
  body: string;
  attachmentIds?: bigint[];
}
export interface ReplyPostOutput {
  replyId: bigint;
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
function asIdList(v: unknown): bigint[] {
  return asArray(v)
    .map(asId)
    .filter((id) => id > 0n);
}

function decodeReply(j: Record<string, unknown>): ReplyRow {
  return {
    id: asId(j['id']),
    to: asStr(j['to']),
    from: asStr(j['from']),
    subject: asStr(j['subject']),
    bodyText: asStr(j['body_text']),
    deliveryStatus: asStr(j['delivery_status']),
    createdAt: asStr(j['created_at']),
  };
}

function decodeComm(j: Record<string, unknown>): CommRow {
  return {
    id: asId(j['id']),
    title: asStr(j['title']),
    threadId: asStr(j['thread_id']),
    channelId: asId(j['channel_id']),
    commStatus: asId(j['comm_status']),
    recipients: asIdList(j['recipients']),
    replies: asArray(j['replies']).map((r) => decodeReply(asObj(r))),
  };
}

/* ------------------------------- registration ----------------------------- */

/**
 * Register the comm-thread specs against `api`. Call once at boot, BEFORE the
 * TaskDetail mounts its COMMS control. Idempotent-by-presence (`api.define`
 * throws on a duplicate key, so each define is guarded).
 */
export function registerCommThreadSpecs(api: Api): void {
  if (!api.registry.has({ endpoint: 'comm', action: 'list_for_task' })) {
    api.define<CommListForTaskInput, CommListForTaskOutput>({
      endpoint: 'comm',
      action: 'list_for_task',
      encode: (i) => ({ task_id: i.taskId }),
      decode: (raw): CommListForTaskOutput => ({
        rows: asArray(asObj(raw)['rows']).map((r) => decodeComm(asObj(r))),
      }),
    });
  }
  if (!api.registry.has({ endpoint: 'comm', action: 'create' })) {
    api.define<CommCreateInput, CommCreateOutput>({
      endpoint: 'comm',
      action: 'create',
      encode: (i) => {
        const m: Record<string, unknown> = { task_id: i.taskId, channel_id: i.channelId };
        if (i.subject !== undefined && i.subject !== '') m['subject'] = i.subject;
        if (i.initialMessage !== undefined && i.initialMessage !== '') m['initial_message'] = i.initialMessage;
        if (i.recipientPersonIds !== undefined) m['recipient_person_ids'] = i.recipientPersonIds;
        return m;
      },
      decode: (raw): CommCreateOutput => {
        const j = asObj(raw);
        return { commId: asId(j['comm_id']), threadId: asStr(j['thread_id']) };
      },
    });
  }
  if (!api.registry.has({ endpoint: 'comm', action: 'set_recipients' })) {
    api.define<CommSetRecipientsInput, CommSetRecipientsOutput>({
      endpoint: 'comm',
      action: 'set_recipients',
      encode: (i) => ({ comm_id: i.commId, recipient_person_ids: i.recipientPersonIds }),
      decode: (raw): CommSetRecipientsOutput => ({
        count: typeof asObj(raw)['count'] === 'number' ? (asObj(raw)['count'] as number) : 0,
      }),
    });
  }
  if (!api.registry.has({ endpoint: 'reply', action: 'post' })) {
    api.define<ReplyPostInput, ReplyPostOutput>({
      endpoint: 'reply',
      action: 'post',
      encode: (i) => {
        const m: Record<string, unknown> = { comm_id: i.commId, body: i.body };
        if (i.attachmentIds !== undefined && i.attachmentIds.length > 0) m['attachment_ids'] = i.attachmentIds;
        return m;
      },
      decode: (raw): ReplyPostOutput => ({ replyId: asId(asObj(raw)['reply_id']) }),
    });
  }
}
