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
 *                        recipients[], approval?: { id, action, from, to },
 *                        replies: [{ id, to, from, from_name,
 *                        from_address, author_id, subject, body_text,
 *                        delivery_status, created_at,
 *                        attachments: [{ id, filename, mime_type, size_bytes,
 *                                        kind, on_thread }],
 *                        attachments_left_off,
 *                        relay?: { id, to, delivery_status,
 *                                  attachments_left_off } }] }] }
 *   - comm.create         in : { task_id, channel_id, subject?, initial_message?,
 *                                recipient_person_ids? }
 *       out: { comm_id, thread_id }
 *   - comm.set_recipients in : { comm_id, recipient_person_ids }  out: { count }
 *   - reply.post          in : { comm_id, body, attachment_ids? } out: { reply_id }
 *   - comm.attachment_to_task in : { comm_id, attachment_id }
 *       out: { attachment_id, task_id } — "Add to task": a file that came by
 *       email moves from the thread onto its task
 *       (docs/MAIL_INTAKE_AND_CALENDARS.md, "Files from email").
 */

import type { Api } from '../core/api.js';
import type { AttachmentKind } from './attachment-specs.js';

export const COMM_LIST_FOR_TASK_SPEC = 'comm.list_for_task';
export const COMM_CREATE_SPEC = 'comm.create';
export const COMM_SET_RECIPIENTS_SPEC = 'comm.set_recipients';
export const COMM_SET_ACK_SPEC = 'comm.set_ack';
/** Move a thread onto a task, or back into its project (docs/CONVERSATIONS.md). */
export const COMM_ATTACH_SPEC = 'comm.attach';
/** Move a file that came by email from the thread onto its task. */
export const COMM_ATTACHMENT_TO_TASK_SPEC = 'comm.attachment_to_task';
export const REPLY_POST_SPEC = 'reply.post';
export const COMM_UNSEEN_COUNT_SPEC = 'comm.unseen_count';

/** comm.unseen_count — cheap "how many new received comms?" probe for the
 *  header notification bell. */
export interface CommUnseenCountInput {
  sinceActivityId?: bigint | string;
}
export interface CommUnseenCountOutput {
  latestActivityId: bigint;
  unseenCount: number;
}

/* ------------------------------- web model -------------------------------- */

export interface ReplyRow {
  id: bigint;
  to: string;
  /** Raw From: envelope (outbound: the channel's from_address). */
  from: string;
  /** Who the message is from: the kitp author for messages written here, else
   *  the person whose email matches the sender, else the header's display
   *  name; '' when unknown. */
  fromName: string;
  /** Bare sender address from the envelope ('' when none). */
  fromAddress: string;
  /** user_account that wrote it in kitp; 0n for received mail. */
  authorId: bigint;
  subject: string;
  bodyText: string;
  deliveryStatus: string;
  createdAt: string;
  /** The message's files. A file that came by email is the thread's
   *  (onThread) until someone adds it to the task; the message keeps it. */
  attachments: MessageFile[];
  /** Files on the incoming mail an account that drops them didn't keep. */
  attachmentsLeftOff: number;
  /** The copy kitp sent on to the rest of the thread, or null. */
  relay: MessageRelay | null;
}

/** One file on a message. */
export interface MessageFile {
  id: bigint;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** What the viewer can show: image / pdf / markdown, or other. */
  kind: AttachmentKind;
  onThread: boolean;
}

/** The copy of an emailed reply kitp sent on to the thread's other people. */
export interface MessageRelay {
  id: bigint;
  /** Who it went to, comma-separated. */
  to: string;
  /** pending / sent / bounced / failed. */
  deliveryStatus: string;
  /** Files too large to send on with it. */
  attachmentsLeftOff: number;
}

export interface CommRow {
  id: bigint;
  title: string;
  threadId: string;
  channelId: bigint;
  commStatus: bigint;
  recipients: bigint[];
  replies: ReplyRow[];
  /** Per-thread "handled" flag. false ⇒ a received message awaits an ACK.
   *  Defaults true (no inbound yet ⇒ nothing to handle). */
  acked: boolean;
  /** The vote request that started this thread (asked with email), or null. */
  approval: CommApproval | null;
}

/** The vote request a thread was started for: its status step. */
export interface CommApproval {
  id: bigint;
  action: string;
  from: string;
  to: string;
}

/** A task's threads, or (commId) one thread wherever it sits — a thread's
 *  own page loads a thread that isn't on a task this way. */
export type CommListForTaskInput = { taskId: bigint } | { commId: bigint };

/** comm.attach — taskId 0n detaches the thread back into its project. */
export interface CommAttachInput {
  commId: bigint;
  /** The task to attach to; 0n detaches back into the project. */
  taskId: bigint;
  /** With taskId 0n: make a task with this title in the thread's project
   *  and attach to it, in one transaction ("Make a task"). */
  newTaskTitle?: string;
}
export interface CommAttachOutput {
  commId: bigint;
  parentId: bigint;
  taskId: bigint;
}
export interface CommListForTaskOutput {
  rows: CommRow[];
}

/** comm.attachment_to_task — "Add to task". */
export interface CommAttachmentToTaskInput {
  commId: bigint;
  attachmentId: bigint;
}
export interface CommAttachmentToTaskOutput {
  /** The task's file: the moved one, or the task's own copy of the bytes. */
  attachmentId: bigint;
  taskId: bigint;
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

export interface CommSetAckInput {
  commId: bigint;
  acked: boolean;
}
export interface CommSetAckOutput {
  acked: boolean;
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
    fromName: asStr(j['from_name']),
    fromAddress: asStr(j['from_address']),
    authorId: asId(j['author_id']),
    subject: asStr(j['subject']),
    bodyText: asStr(j['body_text']),
    deliveryStatus: asStr(j['delivery_status']),
    createdAt: asStr(j['created_at']),
    attachments: asArray(j['attachments']).map((a) => decodeMessageFile(asObj(a))),
    attachmentsLeftOff: asCount(j['attachments_left_off']),
    relay: decodeRelay(j['relay']),
  };
}

function asKind(v: unknown): AttachmentKind {
  return v === 'image' || v === 'pdf' || v === 'markdown' ? v : 'other';
}

function asCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function decodeMessageFile(j: Record<string, unknown>): MessageFile {
  return {
    id: asId(j['id']),
    filename: asStr(j['filename']),
    mimeType: asStr(j['mime_type']),
    sizeBytes: asCount(j['size_bytes']),
    kind: asKind(j['kind']),
    onThread: j['on_thread'] === true,
  };
}

function decodeRelay(v: unknown): MessageRelay | null {
  if (!v || typeof v !== 'object') return null;
  const j = asObj(v);
  return {
    id: asId(j['id']),
    to: asStr(j['to']),
    deliveryStatus: asStr(j['delivery_status']),
    attachmentsLeftOff: asCount(j['attachments_left_off']),
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
    // Default true when absent (older server) — only an explicit false marks
    // the thread as needing an ACK.
    acked: j['acked'] !== false,
    approval: decodeCommApproval(j['approval']),
  };
}

function decodeCommApproval(v: unknown): CommApproval | null {
  if (!v || typeof v !== 'object') return null;
  const j = asObj(v);
  return { id: asId(j['id']), action: asStr(j['action']), from: asStr(j['from']), to: asStr(j['to']) };
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
      encode: (i) => ('commId' in i ? { comm_id: i.commId } : { task_id: i.taskId }),
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
  if (!api.registry.has({ endpoint: 'comm', action: 'unseen_count' })) {
    api.define<CommUnseenCountInput, CommUnseenCountOutput>({
      endpoint: 'comm',
      action: 'unseen_count',
      encode: (i) => {
        const m: Record<string, unknown> = {};
        if (i.sinceActivityId !== undefined) m['since_activity_id'] = i.sinceActivityId;
        return m;
      },
      decode: (raw): CommUnseenCountOutput => {
        const j = asObj(raw);
        return {
          latestActivityId: asId(j['latest_activity_id']),
          unseenCount: typeof j['unseen_count'] === 'number' ? j['unseen_count'] : Number(j['unseen_count'] ?? 0),
        };
      },
    });
  }
  if (!api.registry.has({ endpoint: 'comm', action: 'set_ack' })) {
    api.define<CommSetAckInput, CommSetAckOutput>({
      endpoint: 'comm',
      action: 'set_ack',
      encode: (i) => ({ comm_id: i.commId, acked: i.acked }),
      decode: (raw): CommSetAckOutput => ({ acked: asObj(raw)['acked'] === true }),
    });
  }
  if (!api.registry.has({ endpoint: 'comm', action: 'attach' })) {
    api.define<CommAttachInput, CommAttachOutput>({
      endpoint: 'comm',
      action: 'attach',
      encode: (i) => ({
        comm_id: i.commId,
        task_id: i.taskId,
        ...(i.newTaskTitle !== undefined ? { new_task_title: i.newTaskTitle } : {}),
      }),
      decode: (raw): CommAttachOutput => {
        const j = asObj(raw);
        return { commId: asId(j['comm_id']), parentId: asId(j['parent_id']), taskId: asId(j['task_id']) };
      },
    });
  }
  if (!api.registry.has({ endpoint: 'comm', action: 'attachment_to_task' })) {
    api.define<CommAttachmentToTaskInput, CommAttachmentToTaskOutput>({
      endpoint: 'comm',
      action: 'attachment_to_task',
      encode: (i) => ({ comm_id: i.commId, attachment_id: i.attachmentId }),
      decode: (raw): CommAttachmentToTaskOutput => {
        const j = asObj(raw);
        return { attachmentId: asId(j['attachment_id']), taskId: asId(j['task_id']) };
      },
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
