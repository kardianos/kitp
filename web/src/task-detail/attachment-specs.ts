/**
 * Attachment + tags API specs — the reads + writes backing the Task-detail
 * attachments control (#36) and the tags editor (#36).
 *
 * Declared up front and registered via `api.define`, addressed by the
 * declarative data layer (and the controls' `callByName`) through their
 * `endpoint.action` string keys. They target the REAL `/api/v1/batch` wire and
 * match the Go handlers' input/output shapes verbatim:
 *
 *   - cas.missing_chunks  (db/schema/functions/cas_missing_chunks_batch.sql)
 *       in : { addresses: string[] }
 *       out: { missing: string[] }
 *   - file.create  (db/schema/functions/file_create_batch.sql)
 *       in : { filename, mime_type, chunks: [{ address, size_bytes }] }
 *       out: { id, filename, mime_type, size_bytes }
 *   - attachment.create  (db/schema/functions/attachment_create_batch.sql)
 *       in : { card_id, file_id }
 *       out: { id, card_id, file_id, filename, mime_type, size_bytes,
 *              thumb_file_id, kind }
 *   - attachment.list  (db/schema/functions/attachment_list_batch.sql)
 *       in : { card_id }
 *       out: { rows: [{ id, card_id, file_id, filename, mime_type, size_bytes,
 *                       created_at, thumb_file_id, kind }] }
 *   - attachment.delete  (db/schema/functions/attachment_delete_batch.sql)
 *       in : { id }
 *       out: { ok }
 *   - tag.apply  (db/schema/functions/tag_apply_batch.sql)
 *       in : { target_card_id, tag_card_id }
 *       out: { ok, activity_id, removed_tag_ids?: string[] }
 *   - tag.remove  (db/schema/functions/tag_remove_batch.sql)
 *       in : { target_card_id, tag_card_id }
 *       out: { ok, activity_id }
 *
 * Every id field is a JSON string on the wire; the dispatcher revives the
 * id-shaped keys (`*_id`, `id`) to bigint — for `cas.missing_chunks` the
 * `addresses` / `missing` arrays are sha256 HEX strings (NOT digit strings) so
 * they pass through untouched. The encoders take the camelCase surface the
 * controls assemble and emit the server's snake_case keys; the decoders
 * normalise rows into the camelCase web model and stay defensive about either
 * string or bigint id forms.
 */

import type { Api } from '../core/api.js';
import { registerCardRefAttr } from '../core/dispatch.js';

/* -------------------------------------------------------------------------- */
/* Spec keys (addressed by the controls' callByName).                          */
/* -------------------------------------------------------------------------- */

export const CAS_MISSING_CHUNKS_SPEC = 'cas.missing_chunks';
export const FILE_CREATE_SPEC = 'file.create';
export const ATTACHMENT_CREATE_SPEC = 'attachment.create';
export const ATTACHMENT_LIST_SPEC = 'attachment.list';
export const ATTACHMENT_DELETE_SPEC = 'attachment.delete';
export const TAG_APPLY_SPEC = 'tag.apply';
export const TAG_REMOVE_SPEC = 'tag.remove';

/* -------------------------------------------------------------------------- */
/* Input/output types (the camelCase surface the controls assemble / consume). */
/* -------------------------------------------------------------------------- */

export interface MissingChunksInput {
  /** SHA-256 hex addresses to ask the server about (deduped client-side). */
  addresses: string[];
}
export interface MissingChunksOutput {
  /** The subset of `addresses` the server does NOT already hold. */
  missing: string[];
}

/** One chunk reference for a file's committed chunk list. */
export interface FileChunkRef {
  address: string;
  sizeBytes: number;
}
export interface FileCreateInput {
  filename: string;
  mimeType: string;
  chunks: FileChunkRef[];
}
export interface FileCreateOutput {
  id: bigint;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface AttachmentCreateInput {
  cardId: bigint;
  fileId: bigint;
}

/** The display bucket the server derives from mime_type. */
export type AttachmentKind = 'image' | 'pdf' | 'other';

/** One attachment row in the web model (decoded from the wire). */
export interface AttachmentRow {
  id: bigint;
  cardId: bigint;
  fileId: bigint;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** ISO-8601 UTC timestamp string (absent on create). */
  createdAt?: string;
  /** The thumbnail file id, or 0n when none has been generated. */
  thumbFileId: bigint;
  kind: AttachmentKind;
}

export interface AttachmentListInput {
  cardId: bigint;
}
export interface AttachmentListOutput {
  rows: AttachmentRow[];
}

export interface AttachmentDeleteInput {
  id: bigint;
}
export interface AttachmentDeleteOutput {
  ok: boolean;
}

export interface TagApplyInput {
  targetCardId: bigint;
  tagCardId: bigint;
}
export interface TagApplyOutput {
  ok: boolean;
  activityId: bigint;
  /** Tag ids dropped by the mutual-exclusion rule (absent when none). */
  removedTagIds: bigint[];
}

export interface TagRemoveInput {
  targetCardId: bigint;
  tagCardId: bigint;
}
export interface TagRemoveOutput {
  ok: boolean;
  activityId: bigint;
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
function asNum(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  if (typeof v === 'bigint') return Number(v);
  return 0;
}
function asKind(v: unknown): AttachmentKind {
  return v === 'image' || v === 'pdf' ? v : 'other';
}

function decodeAttachmentRow(j: Record<string, unknown>): AttachmentRow {
  const out: AttachmentRow = {
    id: asId(j['id']),
    cardId: asId(j['card_id']),
    fileId: asId(j['file_id']),
    filename: asStr(j['filename']),
    mimeType: asStr(j['mime_type']),
    sizeBytes: asNum(j['size_bytes']),
    thumbFileId: asId(j['thumb_file_id']),
    kind: asKind(j['kind']),
  };
  if (typeof j['created_at'] === 'string') out.createdAt = j['created_at'];
  return out;
}

/* -------------------------------------------------------------------------- */
/* Registration.                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Register the attachment + tag specs against `api`. Call once at boot, BEFORE
 * the TaskDetail mounts the attachments / tags controls. Idempotent-by-presence:
 * `api.define` throws on a duplicate key, so each define is guarded (a test
 * harness may have registered them first).
 */
export function registerAttachmentSpecs(api: Api): void {
  // The RelatedTasksPanel keys on the `parent_task` card_ref attribute (a single
  // bigint id on the wire) and the TagsEditor on `tags` (a card_ref[]). Prime
  // both so their attribute values revive to bigint regardless of boot ordering.
  // registerCardRefAttr is Set-backed + idempotent (registerGridCardRefAttrs may
  // have already primed `tags`).
  registerCardRefAttr('parent_task', false);
  registerCardRefAttr('tags', true);

  if (!api.registry.has({ endpoint: 'cas', action: 'missing_chunks' })) {
    api.define<MissingChunksInput, MissingChunksOutput>({
      endpoint: 'cas',
      action: 'missing_chunks',
      encode: (i) => ({ addresses: i.addresses }),
      decode: (raw): MissingChunksOutput => {
        const m = asArray(asObj(raw)['missing']).map((a) => asStr(a));
        return { missing: m };
      },
    });
  }

  if (!api.registry.has({ endpoint: 'file', action: 'create' })) {
    api.define<FileCreateInput, FileCreateOutput>({
      endpoint: 'file',
      action: 'create',
      encode: (i) => ({
        filename: i.filename,
        mime_type: i.mimeType,
        chunks: i.chunks.map((c) => ({ address: c.address, size_bytes: c.sizeBytes })),
      }),
      decode: (raw): FileCreateOutput => {
        const j = asObj(raw);
        return {
          id: asId(j['id']),
          filename: asStr(j['filename']),
          mimeType: asStr(j['mime_type']),
          sizeBytes: asNum(j['size_bytes']),
        };
      },
    });
  }

  if (!api.registry.has({ endpoint: 'attachment', action: 'create' })) {
    api.define<AttachmentCreateInput, AttachmentRow>({
      endpoint: 'attachment',
      action: 'create',
      encode: (i) => ({ card_id: i.cardId, file_id: i.fileId }),
      decode: (raw): AttachmentRow => decodeAttachmentRow(asObj(raw)),
    });
  }

  if (!api.registry.has({ endpoint: 'attachment', action: 'list' })) {
    api.define<AttachmentListInput, AttachmentListOutput>({
      endpoint: 'attachment',
      action: 'list',
      encode: (i) => ({ card_id: i.cardId }),
      decode: (raw): AttachmentListOutput => ({
        rows: asArray(asObj(raw)['rows']).map((r) => decodeAttachmentRow(asObj(r))),
      }),
    });
  }

  if (!api.registry.has({ endpoint: 'attachment', action: 'delete' })) {
    api.define<AttachmentDeleteInput, AttachmentDeleteOutput>({
      endpoint: 'attachment',
      action: 'delete',
      encode: (i) => ({ id: i.id }),
      decode: (raw): AttachmentDeleteOutput => ({ ok: asObj(raw)['ok'] === true }),
    });
  }

  if (!api.registry.has({ endpoint: 'tag', action: 'apply' })) {
    api.define<TagApplyInput, TagApplyOutput>({
      endpoint: 'tag',
      action: 'apply',
      encode: (i) => ({ target_card_id: i.targetCardId, tag_card_id: i.tagCardId }),
      decode: (raw): TagApplyOutput => {
        const j = asObj(raw);
        return {
          ok: j['ok'] === true,
          activityId: asId(j['activity_id']),
          removedTagIds: asArray(j['removed_tag_ids']).map((v) => asId(v)),
        };
      },
    });
  }

  if (!api.registry.has({ endpoint: 'tag', action: 'remove' })) {
    api.define<TagRemoveInput, TagRemoveOutput>({
      endpoint: 'tag',
      action: 'remove',
      encode: (i) => ({ target_card_id: i.targetCardId, tag_card_id: i.tagCardId }),
      decode: (raw): TagRemoveOutput => {
        const j = asObj(raw);
        return { ok: j['ok'] === true, activityId: asId(j['activity_id']) };
      },
    });
  }
}
