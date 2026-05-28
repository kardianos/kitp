/**
 * activity.select / comment.insert / comment.update API specs — the reads +
 * writes backing the Task-detail comments + activity feed (#35).
 *
 * Declared up front and registered via `api.define`, addressed by the
 * declarative data layer (and the controls' `callByName`) through their
 * `endpoint.action` string keys. They target the REAL `/api/v1/batch` wire and
 * match the Go handlers' input/output shapes verbatim:
 *
 *   - activity.select  (db/schema/functions/activity_select_batch.sql)
 *       in : { card_id, limit?, before_activity_id? }   (snake_case; ids→string)
 *       out: { rows: [{ id, card_id, kind, attribute_name?, value_old?,
 *                       value_new?, comment_body?, actor_id, created_at }] }
 *            — card-mode rows come ASCENDING (chronological) from the server;
 *              we sort newest-first in the feed. comment rows hydrate
 *              `comment_body`; comment_edit rows carry `value_new.activity_id`
 *              (the edited comment's id, as a string) + `value_new.new_body`.
 *   - comment.insert  (db/schema/functions/comment_insert_batch.sql)
 *       in : { card_id, body }
 *       out: { ok, activity_id, comment_body_id }
 *   - comment.update  (db/schema/functions/comment_update_batch.sql)
 *       in : { activity_id, body }                       (author-gated server-side)
 *       out: { ok, edit_activity_id }
 *
 * The dispatcher revives every id-shaped key (`*_id`, `id`) to bigint — this
 * recurses INTO `value_old`/`value_new`, so e.g. `value_new.comment_body_id` and
 * `value_new.activity_id` (stored TEXT but a digit string on the wire) arrive as
 * bigint. The decoders below normalise the rows into the camelCase web model and
 * stay defensive about either string or bigint id forms.
 */

import type { Api } from '../core/api.js';

/* -------------------------------------------------------------------------- */
/* Spec keys (addressed by the controls' callByName).                          */
/* -------------------------------------------------------------------------- */

export const ACTIVITY_SELECT_SPEC = 'activity.select';
export const COMMENT_INSERT_SPEC = 'comment.insert';
export const COMMENT_UPDATE_SPEC = 'comment.update';

/** Default activity rows pulled per page — matches the Svelte screen's batch. */
export const ACTIVITY_LIMIT = 50;

/* -------------------------------------------------------------------------- */
/* Input/output types (the camelCase surface the controls assemble / consume). */
/* -------------------------------------------------------------------------- */

export interface ActivitySelectInput {
  /** The focal card whose activity stream is read. Omit (or 0) for cross-card /
   *  project-scoped mode (the standalone Activity page). */
  cardId?: bigint;
  /** Project scope: only activity for cards within this project (the project or
   *  a descendant). Used by the Activity page; omit for a single-card feed. */
  projectId?: bigint;
  /** Optional row cap; the server defaults to 200 and caps at 999. */
  limit?: number;
  /** Cursor: only return rows with id < this (older page). */
  beforeActivityId?: bigint;
  /** Inclusive lower bound on created_at, ISO date `YYYY-MM-DD`. */
  fromDate?: string;
  /** Inclusive upper bound on created_at, ISO date `YYYY-MM-DD`. */
  toDate?: string;
}

/** One activity row in the web model (decoded from the wire). */
export interface ActivityRow {
  id: bigint;
  cardId: bigint;
  kind: string;
  attributeName?: string;
  valueOld?: unknown;
  valueNew?: unknown;
  /** Hydrated comment body when kind === 'comment'. */
  commentBody?: string;
  actorId: bigint;
  /** ISO-8601 UTC timestamp string. */
  createdAt: string;
}

export interface ActivitySelectOutput {
  rows: ActivityRow[];
}

export interface CommentInsertInput {
  cardId: bigint;
  body: string;
}
export interface CommentInsertOutput {
  ok: boolean;
  activityId: bigint;
  commentBodyId: bigint;
}

export interface CommentUpdateInput {
  activityId: bigint;
  body: string;
}
export interface CommentUpdateOutput {
  ok: boolean;
  editActivityId: bigint;
}

/* -------------------------------------------------------------------------- */
/* Decode helpers (defensive, no exceptions on missing fields).                */
/* -------------------------------------------------------------------------- */

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
/** Coerce a wire id (bigint after revival, or number/string) to bigint. */
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

function decodeActivityRow(j: Record<string, unknown>): ActivityRow {
  const out: ActivityRow = {
    id: asId(j['id']),
    cardId: asId(j['card_id']),
    kind: asStr(j['kind']),
    actorId: asId(j['actor_id']),
    createdAt: asStr(j['created_at']),
  };
  if (typeof j['attribute_name'] === 'string') out.attributeName = j['attribute_name'];
  if (j['value_old'] !== undefined && j['value_old'] !== null) out.valueOld = j['value_old'];
  if (j['value_new'] !== undefined && j['value_new'] !== null) out.valueNew = j['value_new'];
  if (typeof j['comment_body'] === 'string') out.commentBody = j['comment_body'];
  return out;
}

/* -------------------------------------------------------------------------- */
/* Registration.                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Register the activity.select / comment.insert / comment.update specs against
 * `api`. Call once at boot, BEFORE the TaskDetail mounts the comments + activity
 * controls. Idempotent-by-presence: `api.define` throws on a duplicate key, so
 * each define is guarded (a test harness may have registered them first).
 */
export function registerCommentSpecs(api: Api): void {
  if (!api.registry.has({ endpoint: 'activity', action: 'select' })) {
    api.define<ActivitySelectInput, ActivitySelectOutput>({
      endpoint: 'activity',
      action: 'select',
      encode: (i) => {
        const m: Record<string, unknown> = {};
        if (i.cardId !== undefined) m['card_id'] = i.cardId;
        if (i.projectId !== undefined) m['project_id'] = i.projectId;
        if (i.limit !== undefined) m['limit'] = i.limit;
        if (i.beforeActivityId !== undefined) m['before_activity_id'] = i.beforeActivityId;
        if (i.fromDate !== undefined && i.fromDate !== '') m['from_date'] = i.fromDate;
        if (i.toDate !== undefined && i.toDate !== '') m['to_date'] = i.toDate;
        return m;
      },
      decode: (raw): ActivitySelectOutput => ({
        rows: asArray(asObj(raw)['rows']).map((r) => decodeActivityRow(asObj(r))),
      }),
    });
  }

  if (!api.registry.has({ endpoint: 'comment', action: 'insert' })) {
    api.define<CommentInsertInput, CommentInsertOutput>({
      endpoint: 'comment',
      action: 'insert',
      encode: (i) => ({ card_id: i.cardId, body: i.body }),
      decode: (raw): CommentInsertOutput => {
        const j = asObj(raw);
        return {
          ok: j['ok'] === true,
          activityId: asId(j['activity_id']),
          commentBodyId: asId(j['comment_body_id']),
        };
      },
    });
  }

  if (!api.registry.has({ endpoint: 'comment', action: 'update' })) {
    api.define<CommentUpdateInput, CommentUpdateOutput>({
      endpoint: 'comment',
      action: 'update',
      encode: (i) => ({ activity_id: i.activityId, body: i.body }),
      decode: (raw): CommentUpdateOutput => {
        const j = asObj(raw);
        return {
          ok: j['ok'] === true,
          editActivityId: asId(j['edit_activity_id']),
        };
      },
    });
  }
}
