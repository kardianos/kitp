/**
 * Hand-written encode/decode functions for every (endpoint, action) the
 * client knows about. Mirrors `client/lib/reg/handlers.dart`.
 *
 * Conventions:
 *   - Field names match the server's JSON exactly (snake_case).
 *   - Optional fields are OMITTED from encode output when undefined — never
 *     set to `null`. The server's `pointer-or-nil` decoders rely on this.
 *   - Numeric ID fields use `Number(j.x)` (not `(x as number) | 0`) so values
 *     up to 2^53-1 survive the round-trip.
 *   - Decoders are total: they always produce a value (or default for
 *     missing optional fields). Hard type errors throw, mirroring the Dart
 *     `as` casts that throw on shape mismatch.
 */

import type { HandlerSpec } from './handler_registry.js';
import { HandlerRegistry } from './handler_registry.js';
import { registerAdminHandlers } from './handlers_admin.js';
import type {
  ActivityRow,
  ActivitySelectInput,
  ActivitySelectOutput,
  AttributeDefBindEntry,
  AttributeDefBoundCardType,
  AttributeDefInsertInput,
  AttributeDefInsertOutput,
  AttributeDefRow,
  AttributeDefSelectInput,
  AttributeDefSelectOutput,
  AttributeUpdateInput,
  AttributeUpdateOutput,
  CardDeleteInput,
  CardDeleteOutput,
  CardInsertInput,
  CardInsertOutput,
  CardOrderClause,
  AttachmentCreateInput,
  AttachmentCreateOutput,
  AttachmentDeleteInput,
  AttachmentDeleteOutput,
  AttachmentListInput,
  AttachmentListOutput,
  FileCreateInput,
  FileCreateOutput,
  MissingChunksInput,
  MissingChunksOutput,
  CardRow,
  CardSearchInput,
  CardSearchOutput,
  ConfigGetInput,
  ConfigGetOutput,
  CardSelectInput,
  CardSelectOutput,
  CardSelectWithAttributesInput,
  CardSelectWithAttributesOutput,
  CardTypeRow,
  CardTypeSelectInput,
  CardTypeSelectOutput,
  CardWherePredicate,
  CardWithAttrs,
  CommentInsertInput,
  CommentInsertOutput,
  EchoPingInput,
  EchoPingOutput,
  EdgeDeleteInput,
  EdgeDeleteOutput,
  EdgeInsertInput,
  EdgeInsertOutput,
  TagApplyInput,
  TagApplyOutput,
  TagRemoveInput,
  TagRemoveOutput,
  UserCardSortSetInput,
  UserCardSortSetOutput,
  UserRow,
  UserSelectInput,
  UserSelectOutput,
} from './types.js';

// ----------------------------------------------------------------------------
// Decode helpers
// ----------------------------------------------------------------------------

/** Coerce a value the server returned to a Record<string, unknown>. */
function asObj(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('decode_error: expected object');
  }
  return v as Record<string, unknown>;
}

/** Coerce to an array; null/undefined become an empty array (matches Dart). */
function asArray(v: unknown): unknown[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw new Error('decode_error: expected array');
  return v;
}

/** Coerce a JSON number to a JS number; throws on non-number. */
function asNum(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error('decode_error: expected number');
  }
  return v;
}

/** Optional number; returns undefined for null/undefined. */
function asNumOpt(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  return asNum(v);
}

/**
 * Coerce a JSON id value to a bigint. Accepts either a number (parsed
 * directly from JSON when the value fits within Number.MAX_SAFE_INTEGER)
 * or a bigint (already upgraded by the dispatcher's bigint-aware parser
 * when the value exceeded Number.MAX_SAFE_INTEGER). Throws on other types.
 */
function asId(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)) {
    return BigInt(v);
  }
  throw new Error('decode_error: expected id');
}

/** Optional id; null/undefined become undefined. */
function asIdOpt(v: unknown): bigint | undefined {
  if (v === null || v === undefined) return undefined;
  return asId(v);
}

/** Array of ids; null/undefined become an empty array. */
function asIdArray(v: unknown): bigint[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw new Error('decode_error: expected id array');
  return v.map(asId);
}

/** Id with default 0n; mirrors asNumOrZero for nullable id columns. */
function asIdOrZero(v: unknown): bigint {
  if (v === null || v === undefined) return 0n;
  return asId(v);
}

/** Coerce a JSON string to a JS string; throws on non-string. */
function asStr(v: unknown): string {
  if (typeof v !== 'string') {
    throw new Error('decode_error: expected string');
  }
  return v;
}

/** Optional string; null/undefined become undefined. */
function asStrOpt(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  return asStr(v);
}

/** String with default ''; mirrors `(j['x'] as String?) ?? ''` in Dart. */
function asStrOrEmpty(v: unknown): string {
  if (v === null || v === undefined) return '';
  return asStr(v);
}

/** Coerce to bool with default false; mirrors `(j['x'] as bool?) ?? false`. */
function asBoolOrFalse(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v !== 'boolean') throw new Error('decode_error: expected bool');
  return v;
}

/** Coerce to number with default 0; mirrors `(j['x'] as num?)?.toInt() ?? 0`. */
function asNumOrZero(v: unknown): number {
  if (v === null || v === undefined) return 0;
  return asNum(v);
}

/** Coerce to Record<string, unknown>; null/undefined become empty record. */
function asObjOrEmpty(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined) return {};
  return asObj(v);
}

// ----------------------------------------------------------------------------
// Predicate / order encode helpers (card.select_with_attributes)
// ----------------------------------------------------------------------------

function encodeCardWherePredicate(p: CardWherePredicate): Record<string, unknown> {
  if (p.and !== undefined) {
    return { and: p.and.map(encodeCardWherePredicate) };
  }
  const m: Record<string, unknown> = {
    attr: p.attr ?? '',
    op: p.op ?? '',
  };
  if (p.value !== undefined && p.value !== null) m.value = p.value;
  if (p.values !== undefined) m.values = p.values;
  return m;
}

function encodeCardOrderClause(o: CardOrderClause): Record<string, unknown> {
  const m: Record<string, unknown> = { field: o.field };
  if (o.direction !== undefined) m.direction = o.direction;
  return m;
}

// ============================================================================
// echo.ping
// ============================================================================

const echoPing: HandlerSpec<EchoPingInput, EchoPingOutput> = {
  endpoint: 'echo',
  action: 'ping',
  encode: (i) => ({ x: i.x, message: i.message }),
  decode: (raw) => {
    const j = asObj(raw);
    return {
      x: asNum(j.x),
      message: asStrOrEmpty(j.message),
    };
  },
};

// ============================================================================
// card_type.select
// ============================================================================

function decodeCardTypeRow(j: Record<string, unknown>): CardTypeRow {
  const out: CardTypeRow = {
    id: asId(j.id),
    name: asStr(j.name),
    allow_self_parent: asBoolOrFalse(j.allow_self_parent),
    is_built_in: asBoolOrFalse(j.is_built_in),
  };
  const parent = asIdOpt(j.parent_card_type_id);
  if (parent !== undefined) out.parent_card_type_id = parent;
  return out;
}

const cardTypeSelect: HandlerSpec<CardTypeSelectInput, CardTypeSelectOutput> = {
  endpoint: 'card_type',
  action: 'select',
  encode: () => ({}),
  decode: (raw) => {
    const j = asObj(raw);
    return {
      rows: asArray(j.rows).map((r) => decodeCardTypeRow(asObj(r))),
    };
  },
};

// ============================================================================
// card.insert
// ============================================================================

const cardInsert: HandlerSpec<CardInsertInput, CardInsertOutput> = {
  endpoint: 'card',
  action: 'insert',
  encode: (i) => {
    const m: Record<string, unknown> = {
      card_type_name: i.cardTypeName,
      title: i.title,
    };
    if (i.parentCardId !== undefined) m.parent_card_id = i.parentCardId;
    if (i.attributes !== undefined && Object.keys(i.attributes).length > 0) {
      m.attributes = i.attributes;
    }
    return m;
  },
  decode: (raw) => {
    const j = asObj(raw);
    return { id: asId(j.id) };
  },
};

// ============================================================================
// card.select
// ============================================================================

function decodeCardRow(j: Record<string, unknown>): CardRow {
  const out: CardRow = {
    id: asId(j.id),
    card_type_id: asId(j.card_type_id),
    card_type_name: asStr(j.card_type_name),
  };
  const parent = asIdOpt(j.parent_card_id);
  if (parent !== undefined) out.parent_card_id = parent;
  const title = asStrOpt(j.title);
  if (title !== undefined) out.title = title;
  return out;
}

const cardSelect: HandlerSpec<CardSelectInput, CardSelectOutput> = {
  endpoint: 'card',
  action: 'select',
  encode: (i) => {
    const m: Record<string, unknown> = {};
    if (i.parentCardId !== undefined) m.parent_card_id = i.parentCardId;
    if (i.cardTypeName !== undefined) m.card_type_name = i.cardTypeName;
    return m;
  },
  decode: (raw) => {
    const j = asObj(raw);
    return {
      rows: asArray(j.rows).map((r) => decodeCardRow(asObj(r))),
    };
  },
};

// ============================================================================
// card.select_with_attributes
// ============================================================================

function decodeCardWithAttrs(j: Record<string, unknown>): CardWithAttrs {
  const out: CardWithAttrs = {
    id: asId(j.id),
    card_type_id: asId(j.card_type_id),
    card_type_name: asStrOrEmpty(j.card_type_name),
    attributes: asObjOrEmpty(j.attributes),
  };
  const parent = asIdOpt(j.parent_card_id);
  if (parent !== undefined) out.parent_card_id = parent;
  if (typeof j.is_terminal === 'boolean') out.is_terminal = j.is_terminal;
  const deletedAt = asStrOpt(j.deleted_at);
  if (deletedAt !== undefined) out.deleted_at = deletedAt;
  const personalSort = asNumOpt(j.personal_sort_order);
  if (personalSort !== undefined) out.personal_sort_order = personalSort;
  return out;
}

const cardSelectWithAttributes: HandlerSpec<
  CardSelectWithAttributesInput,
  CardSelectWithAttributesOutput
> = {
  endpoint: 'card',
  action: 'select_with_attributes',
  encode: (i) => {
    const m: Record<string, unknown> = {};
    if (i.parentCardId !== undefined) m.parent_card_id = i.parentCardId;
    if (i.cardTypeName !== undefined) m.card_type_name = i.cardTypeName;
    if (i.where !== undefined && i.where.length > 0) {
      m.where = i.where.map(encodeCardWherePredicate);
    }
    if (i.tree !== undefined) m.tree = i.tree;
    if (i.order !== undefined && i.order.length > 0) {
      m.order = i.order.map(encodeCardOrderClause);
    }
    if (i.limit !== undefined) m.limit = i.limit;
    if (i.offset !== undefined) m.offset = i.offset;
    if (i.includeDeleted !== undefined) m.include_deleted = i.includeDeleted;
    if (i.withPersonalSort) m.with_personal_sort = true;
    if (i.routedToMe) m.routed_to_me = true;
    return m;
  },
  decode: (raw) => {
    const j = asObj(raw);
    return {
      rows: asArray(j.rows).map((r) => decodeCardWithAttrs(asObj(r))),
    };
  },
};

// ============================================================================
// card.search — typeahead read for ref:* picker dropdowns. Returns only
// (id, title) so it stays cheap as the picker fires per keystroke.
// ============================================================================

const cardSearch: HandlerSpec<CardSearchInput, CardSearchOutput> = {
  endpoint: 'card',
  action: 'search',
  encode: (i) => {
    const m: Record<string, unknown> = { card_type_name: i.cardTypeName };
    if (i.query !== undefined && i.query !== '') m.query = i.query;
    if (i.ids !== undefined && i.ids.length > 0) m.ids = i.ids;
    if (i.limit !== undefined) m.limit = i.limit;
    if (i.parentCardId !== undefined) m.parent_card_id = i.parentCardId;
    return m;
  },
  decode: (raw) => {
    const j = asObj(raw);
    return {
      rows: asArray(j.rows).map((r) => {
        const o = asObj(r);
        return { id: asIdOrZero(o.id), title: asStrOrEmpty(o.title) };
      }),
    };
  },
};

// ============================================================================
// config.get — fetch server-driven configuration knobs (e.g. attachment cap).
// ============================================================================

const configGet: HandlerSpec<ConfigGetInput, ConfigGetOutput> = {
  endpoint: 'config',
  action: 'get',
  encode: () => ({}),
  decode: (raw) => {
    const j = asObj(raw);
    const cfg = asObj(j.config);
    return {
      config: {
        attachment_max_bytes: asNumOrZero(cfg.attachment_max_bytes),
        chunk_max_bytes: asNumOrZero(cfg.chunk_max_bytes),
      },
    };
  },
};

const casMissingChunks: HandlerSpec<MissingChunksInput, MissingChunksOutput> = {
  endpoint: 'cas',
  action: 'missing_chunks',
  encode: (i) => ({ addresses: i.addresses }),
  decode: (raw) => {
    const j = asObj(raw);
    return {
      missing: asArray(j.missing).map((v) => (typeof v === 'string' ? v : '')),
    };
  },
};

const fileCreate: HandlerSpec<FileCreateInput, FileCreateOutput> = {
  endpoint: 'file',
  action: 'create',
  encode: (i) => {
    const m: Record<string, unknown> = {
      filename: i.filename,
      chunks: i.chunks,
    };
    if (i.mimeType !== undefined && i.mimeType !== '') m.mime_type = i.mimeType;
    return m;
  },
  decode: (raw) => {
    const j = asObj(raw);
    return {
      id: asIdOrZero(j.id),
      filename: asStrOrEmpty(j.filename),
      mime_type: asStrOrEmpty(j.mime_type),
      size_bytes: asNumOrZero(j.size_bytes),
    };
  },
};

// ============================================================================
// attachment.list / attachment.delete — JSON sides of the attachments API.
// Upload + download go through dedicated HTTP routes (see
// `client/src/attachments/upload.ts`).
// ============================================================================

/** Coerce the server's `kind` string into the AttachmentKind union with a
 *  defensive fallback to 'other'. The server is authoritative; this just
 *  guards against an old-schema response or a typo. */
function asAttachmentKind(v: unknown): 'image' | 'pdf' | 'other' {
  if (v === 'image' || v === 'pdf') return v;
  return 'other';
}

const attachmentList: HandlerSpec<AttachmentListInput, AttachmentListOutput> = {
  endpoint: 'attachment',
  action: 'list',
  encode: (i) => ({ card_id: i.cardId }),
  decode: (raw) => {
    const j = asObj(raw);
    return {
      rows: asArray(j.rows).map((r) => {
        const o = asObj(r);
        return {
          id: asIdOrZero(o.id),
          card_id: asIdOrZero(o.card_id),
          file_id: asIdOrZero(o.file_id),
          filename: asStrOrEmpty(o.filename),
          mime_type: asStrOrEmpty(o.mime_type),
          size_bytes: asNumOrZero(o.size_bytes),
          created_at: asStrOrEmpty(o.created_at),
          thumb_file_id: asIdOrZero(o.thumb_file_id),
          kind: asAttachmentKind(o.kind),
        };
      }),
    };
  },
};

const attachmentCreate: HandlerSpec<AttachmentCreateInput, AttachmentCreateOutput> = {
  endpoint: 'attachment',
  action: 'create',
  encode: (i) => ({ card_id: i.cardId, file_id: i.fileId }),
  decode: (raw) => {
    const j = asObj(raw);
    return {
      id: asIdOrZero(j.id),
      card_id: asIdOrZero(j.card_id),
      file_id: asIdOrZero(j.file_id),
      filename: asStrOrEmpty(j.filename),
      mime_type: asStrOrEmpty(j.mime_type),
      size_bytes: asNumOrZero(j.size_bytes),
      thumb_file_id: asIdOrZero(j.thumb_file_id),
      kind: asAttachmentKind(j.kind),
    };
  },
};

const attachmentDelete: HandlerSpec<AttachmentDeleteInput, AttachmentDeleteOutput> = {
  endpoint: 'attachment',
  action: 'delete',
  encode: (i) => ({ id: i.id }),
  decode: (raw) => {
    const j = asObj(raw);
    return { ok: asBoolOrFalse(j.ok) };
  },
};

// ============================================================================
// card.delete
// ============================================================================

const cardDelete: HandlerSpec<CardDeleteInput, CardDeleteOutput> = {
  endpoint: 'card',
  action: 'delete',
  encode: (i) => ({ card_id: i.cardId }),
  decode: (raw) => {
    const j = asObj(raw);
    return {
      ok: asBoolOrFalse(j.ok),
      activity_id: asIdOrZero(j.activity_id),
    };
  },
};

// ============================================================================
// attribute.update
// ============================================================================

const attributeUpdate: HandlerSpec<AttributeUpdateInput, AttributeUpdateOutput> = {
  endpoint: 'attribute',
  action: 'update',
  encode: (i) => ({
    card_id: i.cardId,
    attribute_name: i.attributeName,
    // Note: `value` is intentionally always present (even if `null`) — the
    // server distinguishes "missing key" (no-op) from "null" (clear-attr).
    value: i.value === undefined ? null : i.value,
  }),
  decode: (raw) => {
    const j = asObj(raw);
    const out: AttributeUpdateOutput = {
      ok: asBoolOrFalse(j.ok),
      activity_id: asIdOrZero(j.activity_id),
    };
    if (j.prev_value !== undefined && j.prev_value !== null) {
      out.prev_value = j.prev_value;
    }
    return out;
  },
};

// ============================================================================
// attribute_def.select
// ============================================================================

function decodeAttributeDefBoundCardType(
  j: Record<string, unknown>,
): AttributeDefBoundCardType {
  return {
    card_type_id: asId(j.card_type_id),
    card_type_name: asStrOrEmpty(j.card_type_name),
    is_required: asBoolOrFalse(j.is_required),
    is_built_in: asBoolOrFalse(j.is_built_in),
    ordering: asNumOrZero(j.ordering),
  };
}

function decodeAttributeDefRow(j: Record<string, unknown>): AttributeDefRow {
  const boundRaw = asArray(j.bound_to);
  const out: AttributeDefRow = {
    id: asId(j.id),
    name: asStr(j.name),
    value_type: asStrOrEmpty(j.value_type),
    is_built_in: asBoolOrFalse(j.is_built_in),
    bound_to: boundRaw.map((r) => decodeAttributeDefBoundCardType(asObj(r))),
  };
  const target = asStrOpt(j.target_card_type_name);
  if (target !== undefined && target !== '') out.target_card_type_name = target;
  return out;
}

const attributeDefSelect: HandlerSpec<
  AttributeDefSelectInput,
  AttributeDefSelectOutput
> = {
  endpoint: 'attribute_def',
  action: 'select',
  encode: () => ({}),
  decode: (raw) => {
    const j = asObj(raw);
    return {
      rows: asArray(j.rows).map((r) => decodeAttributeDefRow(asObj(r))),
    };
  },
};

// ============================================================================
// attribute_def.insert
// ============================================================================

function encodeAttributeDefBindEntry(
  b: AttributeDefBindEntry,
): Record<string, unknown> {
  const m: Record<string, unknown> = { card_type_id: b.cardTypeId };
  // Mirror Dart: only emit `is_required` / `ordering` when truthy. The Dart
  // code uses `if (isRequired) ...` and `if (ordering != 0) ...`.
  if (b.isRequired === true) m.is_required = true;
  if (b.ordering !== undefined && b.ordering !== 0) m.ordering = b.ordering;
  return m;
}

const attributeDefInsert: HandlerSpec<
  AttributeDefInsertInput,
  AttributeDefInsertOutput
> = {
  endpoint: 'attribute_def',
  action: 'insert',
  encode: (i) => {
    const m: Record<string, unknown> = {
      name: i.name,
      value_type: i.valueType,
    };
    if (i.bindTo !== undefined && i.bindTo.length > 0) {
      m.bind_to = i.bindTo.map(encodeAttributeDefBindEntry);
    }
    return m;
  },
  decode: (raw) => {
    const j = asObj(raw);
    return { id: asId(j.id) };
  },
};

// ============================================================================
// activity.select
// ============================================================================

function decodeActivityRow(j: Record<string, unknown>): ActivityRow {
  const out: ActivityRow = {
    id: asId(j.id),
    card_id: asIdOrZero(j.card_id),
    kind: asStr(j.kind),
    actor_id: asIdOrZero(j.actor_id),
    created_at: asStrOrEmpty(j.created_at),
  };
  const attrName = asStrOpt(j.attribute_name);
  if (attrName !== undefined) out.attribute_name = attrName;
  if (j.value_old !== undefined && j.value_old !== null) {
    out.value_old = j.value_old;
  }
  if (j.value_new !== undefined && j.value_new !== null) {
    out.value_new = j.value_new;
  }
  const commentBody = asStrOpt(j.comment_body);
  if (commentBody !== undefined) out.comment_body = commentBody;
  return out;
}

const activitySelect: HandlerSpec<ActivitySelectInput, ActivitySelectOutput> = {
  endpoint: 'activity',
  action: 'select',
  encode: (i) => {
    const m: Record<string, unknown> = {};
    if (i.cardId !== undefined) m.card_id = i.cardId;
    if (i.limit !== undefined) m.limit = i.limit;
    if (i.beforeActivityId !== undefined) m.before_activity_id = i.beforeActivityId;
    return m;
  },
  decode: (raw) => {
    const j = asObj(raw);
    return {
      rows: asArray(j.rows).map((r) => decodeActivityRow(asObj(r))),
    };
  },
};

// ============================================================================
// comment.insert
// ============================================================================

const commentInsert: HandlerSpec<CommentInsertInput, CommentInsertOutput> = {
  endpoint: 'comment',
  action: 'insert',
  encode: (i) => ({ card_id: i.cardId, body: i.body }),
  decode: (raw) => {
    const j = asObj(raw);
    return {
      ok: asBoolOrFalse(j.ok),
      activity_id: asIdOrZero(j.activity_id),
      comment_body_id: asIdOrZero(j.comment_body_id),
    };
  },
};

// ============================================================================
// user.select
// ============================================================================

function decodeUserRow(j: Record<string, unknown>): UserRow {
  const out: UserRow = {
    id: asId(j.id),
    display_name: asStr(j.display_name),
  };
  const parent = asIdOpt(j.parent_user_id);
  if (parent !== undefined) out.parent_user_id = parent;
  if (typeof j.is_agent === 'boolean') out.is_agent = j.is_agent;
  return out;
}

const userSelect: HandlerSpec<UserSelectInput, UserSelectOutput> = {
  endpoint: 'user',
  action: 'select',
  encode: (i) => {
    const m: Record<string, unknown> = {};
    if (i?.ids !== undefined && i.ids.length > 0) m.ids = i.ids;
    if (i?.parentUserId !== undefined) m.parent_user_id = i.parentUserId;
    if (i?.isAgent !== undefined) m.is_agent = i.isAgent;
    return m;
  },
  decode: (raw) => {
    const j = asObj(raw);
    return {
      rows: asArray(j.rows).map((r) => decodeUserRow(asObj(r))),
    };
  },
};

// ============================================================================
// tag.apply / tag.remove
// ============================================================================

const tagApply: HandlerSpec<TagApplyInput, TagApplyOutput> = {
  endpoint: 'tag',
  action: 'apply',
  encode: (i) => ({
    target_card_id: i.targetCardId,
    tag_card_id: i.tagCardId,
  }),
  decode: (raw) => {
    const j = asObj(raw);
    return {
      ok: asBoolOrFalse(j.ok),
      activity_id: asIdOrZero(j.activity_id),
      removed_tag_ids: asIdArray(j.removed_tag_ids),
    };
  },
};

const tagRemove: HandlerSpec<TagRemoveInput, TagRemoveOutput> = {
  endpoint: 'tag',
  action: 'remove',
  encode: (i) => ({
    target_card_id: i.targetCardId,
    tag_card_id: i.tagCardId,
  }),
  decode: (raw) => {
    const j = asObj(raw);
    return {
      ok: asBoolOrFalse(j.ok),
      activity_id: asIdOrZero(j.activity_id),
    };
  },
};

// ============================================================================
// user_card_sort.set
// ============================================================================

const userCardSortSet: HandlerSpec<UserCardSortSetInput, UserCardSortSetOutput> = {
  endpoint: 'user_card_sort',
  action: 'set',
  encode: (i) => ({ card_id: i.cardId, sort_order: i.sortOrder }),
  decode: (raw) => {
    const j = asObj(raw);
    return { ok: asBoolOrFalse(j.ok) };
  },
};

// ============================================================================
// edge.insert / edge.delete
// ============================================================================

const edgeInsert: HandlerSpec<EdgeInsertInput, EdgeInsertOutput> = {
  endpoint: 'edge',
  action: 'insert',
  encode: (i) => {
    const m: Record<string, unknown> = {
      attribute_def_id: i.attributeDefId,
      card_type_id: i.cardTypeId,
    };
    if (i.isRequired === true) m.is_required = true;
    if (i.ordering !== undefined && i.ordering !== 0) m.ordering = i.ordering;
    return m;
  },
  decode: (raw) => {
    const j = asObj(raw);
    return { ok: asBoolOrFalse(j.ok) };
  },
};

const edgeDelete: HandlerSpec<EdgeDeleteInput, EdgeDeleteOutput> = {
  endpoint: 'edge',
  action: 'delete',
  encode: (i) => ({
    attribute_def_id: i.attributeDefId,
    card_type_id: i.cardTypeId,
  }),
  decode: (raw) => {
    const j = asObj(raw);
    return {
      ok: asBoolOrFalse(j.ok),
      usage_count: asNumOrZero(j.usage_count),
    };
  },
};

// ============================================================================
// Re-exports for use by tests / dispatch / screens
// ============================================================================

export {
  // tiny helpers (intentionally exported so screens can build manual rows
  // without re-implementing the casts)
  asObj,
  asArray,
  asNum,
  asNumOpt,
  asId,
  asIdOpt,
  asIdArray,
  asIdOrZero,
  asStr,
  asStrOpt,
  asStrOrEmpty,
  asBoolOrFalse,
  asNumOrZero,
  asObjOrEmpty,
  encodeCardWherePredicate,
  encodeCardOrderClause,
  // specs
  echoPing,
  cardTypeSelect,
  cardInsert,
  cardSelect,
  cardSelectWithAttributes,
  cardSearch,
  cardDelete,
  configGet,
  casMissingChunks,
  fileCreate,
  attachmentList,
  attachmentCreate,
  attachmentDelete,
  attributeUpdate,
  attributeDefSelect,
  attributeDefInsert,
  activitySelect,
  commentInsert,
  userSelect,
  tagApply,
  tagRemove,
  userCardSortSet,
  edgeInsert,
  edgeDelete,
};

// ============================================================================
// Public registration helper
// ============================================================================

/**
 * Register every handler this client currently understands. Invoked once
 * at startup from `main.ts` and once per test setup.
 */
export function registerBuiltInHandlers(r: HandlerRegistry): void {
  r.register(echoPing);
  r.register(cardTypeSelect);
  r.register(cardInsert);
  r.register(cardSelect);
  r.register(cardSelectWithAttributes);
  r.register(cardSearch);
  r.register(cardDelete);
  r.register(configGet);
  r.register(casMissingChunks);
  r.register(fileCreate);
  r.register(attachmentList);
  r.register(attachmentCreate);
  r.register(attachmentDelete);
  r.register(attributeUpdate);
  r.register(attributeDefSelect);
  r.register(attributeDefInsert);
  r.register(activitySelect);
  r.register(commentInsert);
  r.register(userSelect);
  r.register(tagApply);
  r.register(tagRemove);
  r.register(userCardSortSet);
  r.register(edgeInsert);
  r.register(edgeDelete);
  registerAdminHandlers(r);
}
