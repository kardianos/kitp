/**
 * Shared row types for the handler registry. Each interface mirrors a
 * struct in `server/internal/dom/**`.
 *
 * Conventions:
 *   - Field names match the server's JSON exactly (snake_case for outputs,
 *     camelCase for inputs the encoders convert before sending).
 *   - Optional fields are typed `T | undefined` (with `?:`); they are
 *     OMITTED — not set to null — by the encoders in `handlers.ts`.
 *   - ID fields use the `ID = bigint` alias. The server emits ids as JSON
 *     numbers (int64); the dispatcher's bigint-aware JSON parser preserves
 *     full int64 precision through to the client by converting any integer
 *     that exceeds Number.MAX_SAFE_INTEGER into a BigInt at parse time.
 *     The decoders in handlers.ts accept either bigint or number for an
 *     id field and normalise to bigint.
 *   - Non-id numeric fields (ordering, sort_order, size_bytes, limit,
 *     offset, usage_count, …) use `number` because they don't need int64
 *     precision and arithmetic on them stays ergonomic in JS.
 */

/**
 * ID alias — every id field on every domain row, server-side int64.
 * Treat as opaque: don't do arithmetic on it, don't index plain objects
 * with it (use `.toString()` if you need a Map / Record key).
 */
export type ID = bigint;

/**
 * Compare two id-shaped values for equality, robust to a number /
 * bigint / string mix (FE-H3). The dispatcher revives id-shaped wire
 * fields to `bigint`, but card_ref *attribute* values only revive once
 * the schema preload has primed `CARD_REF_ATTR_KEYS` — before that (a
 * cold test, the MCP CLI, or an admin-added card_ref attr not yet in
 * the catalog) the value arrives as a raw JSON `number`, and `123 ===
 * 123n` is `false` in JS. That silently rendered a picker as "unset".
 *
 * Comparing via a canonical decimal string sidesteps the boot-ordering
 * dependency entirely: `42`, `42n`, and `"42"` all canonicalize to
 * `"42"`. `null`/`undefined` only equal each other. Non-integral or
 * non-id values (objects, floats, arbitrary strings) fall back to a
 * direct `===` so this stays safe to use on heterogeneous option values.
 */
export function sameId(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const ca = canonId(a);
  const cb = canonId(b);
  if (ca === null || cb === null) return false;
  return ca === cb;
}

/** Canonical decimal string for an id-shaped scalar, or null when the
 *  value isn't id-shaped (so `sameId` can fall back to `===`). */
function canonId(v: unknown): string | null {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : null;
  if (typeof v === 'string') return /^-?\d+$/.test(v) ? v : null;
  return null;
}

// ============================================================================
// echo.ping
// ============================================================================

export interface EchoPingInput {
  x: number;
  message: string;
}

export interface EchoPingOutput {
  x: number;
  message: string;
}

// ============================================================================
// card_type.select
// ============================================================================

export interface CardTypeSelectInput {
  // Empty input shape; kept as a named type for symmetry with the Dart code.
  _empty?: never;
}

export interface CardTypeRow {
  id: ID;
  name: string;
  parent_card_type_id?: ID;
  allow_self_parent: boolean;
  is_built_in: boolean;
}

export interface CardTypeSelectOutput {
  rows: CardTypeRow[];
}

// ============================================================================
// card.insert
// ============================================================================

export interface CardInsertInput {
  cardTypeName: string;
  parentCardId?: ID;
  title: string;
  /**
   * Optional initial attribute writes. Values must be JSON-encodable.
   * Forwarded to the server's `data.attributes` jsonb field unchanged.
   */
  attributes?: Record<string, unknown>;
  /**
   * Optional initial value for the structural `phase` column. Omit to
   * keep the server default (`triage`); set to land a value-card on a
   * specific phase in a single round-trip (e.g. seeding a "Cancelled"
   * status as `terminal`).
   */
  phase?: 'triage' | 'active' | 'terminal';
}

export interface CardInsertOutput {
  id: ID;
}

// ============================================================================
// card.set_phase
// ============================================================================

export interface CardSetPhaseInput {
  cardId: ID;
  phase: 'triage' | 'active' | 'terminal';
}

export interface CardSetPhaseOutput {
  ok: boolean;
  activity_id: ID;
}

// ============================================================================
// card.select
// ============================================================================

export interface CardSelectInput {
  parentCardId?: ID;
  cardTypeName?: string;
}

export interface CardRow {
  id: ID;
  card_type_id: ID;
  card_type_name: string;
  parent_card_id?: ID;
  title?: string;
}

export interface CardSelectOutput {
  rows: CardRow[];
}

// ============================================================================
// card.select_with_attributes
// ============================================================================

/**
 * Single-condition leaf or compound-AND predicate. Mirrors the Dart
 * `CardWherePredicate`; pass it through {@link encodeCardWherePredicate}.
 */
export interface CardWherePredicate {
  attr?: string;
  op?: string;
  value?: unknown;
  values?: unknown[];
  /** When set, all sub-predicates AND together; the leaf fields are ignored. */
  and?: CardWherePredicate[];
}

export interface CardOrderClause {
  field: string;
  direction?: string;
}

/**
 * Recursive predicate-tree wire shape sent in the `tree` field.
 * The UI layer in `src/filter/predicate.ts` is responsible for the AST;
 * here we accept any JSON-shaped record so the wire layer stays decoupled.
 */
export type CardWhereTree = Record<string, unknown>;

export interface CardSelectWithAttributesInput {
  parentCardId?: ID;
  cardTypeName?: string;
  where?: CardWherePredicate[];
  /** Recursive predicate tree; takes precedence over `where` when present. */
  tree?: CardWhereTree;
  order?: CardOrderClause[];
  limit?: number;
  offset?: number;
  includeDeleted?: boolean;
  /**
   * When true, the server LEFT JOINs `user_card_sort` for the calling
   * actor and exposes `personal_sort_order` on each row; the `order`
   * field then accepts `'personal_sort_order'` (NULLS LAST). Inbox uses
   * this to render the per-user drag-drop ordering without a separate
   * handler.
   */
  withPersonalSort?: boolean;
  /**
   * Agent-perspective inbox filter (#50). When true, the result is
   * INNER JOINed against `user_card_agent` and filtered to rows where
   * `agent_user_id = actor AND user_id = actor.parent_user_id` — i.e.
   * what the calling agent's parent has routed to it. Non-agent callers
   * see zero rows.
   */
  routedToMe?: boolean;
}

export interface CardWithAttrs {
  id: ID;
  card_type_id: ID;
  card_type_name: string;
  parent_card_id?: ID;
  /**
   * Three-valued phase tag on value-cards bound to a flow:
   * `'triage'` (needs categorisation, e.g. "New idea", "Inbox"),
   * `'active'` (in-flight work, e.g. "Todo", "Doing"), or
   * `'terminal'` (final state, e.g. "Done", "Cancelled"). Drives
   * the notTerminal / has_phase filters and TransitionBar action
   * buckets. Always present (column NOT NULL); meaningful only on
   * cards used as ref-attribute values.
   */
  phase: 'triage' | 'active' | 'terminal';
  attributes: Record<string, unknown>;
  /**
   * Card row's created_at (NOT an attribute). Surfaced so list
   * screens can render and sort by creation time without a follow-up
   * read. ISO 8601 string. Optional on the type because in-memory
   * test fixtures often skip it; the server always populates it on
   * the wire.
   */
  created_at?: string;
  /**
   * Virtual: MAX(activity.created_at) for this card. Undefined when
   * the card has no activity rows yet. ISO 8601 string when present.
   */
  last_activity_at?: string;
  deleted_at?: string;
  /**
   * Populated when the request set `withPersonalSort:true`. Null /
   * undefined means the calling actor has never reordered this card.
   */
  personal_sort_order?: number;
}

export interface CardSelectWithAttributesOutput {
  rows: CardWithAttrs[];
}

// ============================================================================
// card.search — typeahead read for ref:* picker dropdowns.
// ============================================================================

export interface CardSearchInput {
  cardTypeName: string;
  query?: string;
  ids?: ID[];
  limit?: number;
  /** Restrict to cards whose parent_card_id equals this; used by
   *  ref:* picker dropdowns to keep typeahead in the same project as
   *  the editing task. */
  parentCardId?: ID;
}

export interface CardSearchHit {
  id: ID;
  title: string;
}

export interface CardSearchOutput {
  rows: CardSearchHit[];
}

// ============================================================================
// card.delete
// ============================================================================

export interface CardDeleteInput {
  cardId: ID;
}

export interface CardDeleteOutput {
  ok: boolean;
  activity_id: ID;
}

// ============================================================================
// file.create / attachment.list / attachment.delete / attachment.create —
// JSON sides of the chunked-attachments API.
//
// Upload flow:
//   1. Client slices the file into ~1 MB chunks.
//   2. POST each chunk to /api/v1/cas/chunk (HTTP, multipart). The
//      server returns {address, size_bytes}.
//   3. Client calls file.create with the chunk list — server inserts
//      the `file` row and the ordered chunk list, returns file id.
//   4. Client calls attachment.create with {card_id, file_id} — server
//      inserts the attachment row and an attachment_create activity.
//
// Download is /api/v1/attachment/{id}/download (binary stream).
// ============================================================================

export interface FileCreateChunk {
  address: string;
  size_bytes: number;
}

export interface FileCreateInput {
  filename: string;
  mimeType?: string;
  chunks: FileCreateChunk[];
}

export interface FileCreateOutput {
  id: ID;
  filename: string;
  mime_type: string;
  size_bytes: number;
}

export interface AttachmentListInput {
  cardId: ID;
}

export interface AttachmentRow {
  id: ID;
  card_id: ID;
  file_id: ID;
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  /** 0n when no thumb is available (non-image attachment, or thumb gen failed). */
  thumb_file_id: ID;
  /** Display bucket the server has classified this attachment into. */
  kind: AttachmentKind;
}

export type AttachmentKind = 'image' | 'pdf' | 'other';

export interface AttachmentListOutput {
  rows: AttachmentRow[];
}

export interface AttachmentDeleteInput {
  id: ID;
}

export interface AttachmentDeleteOutput {
  ok: boolean;
}

export interface AttachmentCreateInput {
  cardId: ID;
  fileId: ID;
}

export interface AttachmentCreateOutput {
  id: ID;
  card_id: ID;
  file_id: ID;
  filename: string;
  mime_type: string;
  size_bytes: number;
  thumb_file_id: ID;
  kind: AttachmentKind;
}

// ============================================================================
// cas.missing_chunks — pre-flight before chunk upload. Client sends every
// chunk's address; server returns the subset it doesn't already have, so
// we skip the network bytes for any chunk that's already on disk.
// ============================================================================

export interface MissingChunksInput {
  addresses: string[];
}

export interface MissingChunksOutput {
  missing: string[];
}

// ============================================================================
// config.get — server-driven configuration values the client needs to know
// about up front (e.g. the attachment size cap so the UI can refuse oversize
// files before sending bytes).
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ConfigGetInput {}

export interface ServerConfig {
  attachment_max_bytes: number;
  chunk_max_bytes: number;
}

export interface ConfigGetOutput {
  config: ServerConfig;
}

// ============================================================================
// attribute.update
// ============================================================================

export interface AttributeUpdateInput {
  cardId: ID;
  attributeName: string;
  /** JSON-encodable value (string / number / bool / null / list / map). */
  value: unknown;
}

export interface AttributeUpdateOutput {
  ok: boolean;
  activity_id: ID;
  prev_value?: unknown;
}

// ============================================================================
// flow_step.list_for_card
// ============================================================================

/**
 * One transition the caller may attempt to fire from the given card,
 * pre-joined with from/to value-card metadata (title + phase), the
 * optional requires_role name, and a per-actor `allowed` bit.
 *
 * Mirrors `server/internal/dom/flow/flow.go::AvailableTransition`. The
 * server emits this row both from `flow_step.list_for_card` and inside
 * the V13 rejection envelope's `available[]` for failed
 * `attribute.update` writes — same shape, two call sites.
 *
 * The TransitionBar component buckets these rows by
 * `(from_phase, to_phase)` and renders each bucket per the table in
 * §"<TransitionBar> replaces TerminalActionButton" of
 * FLOW_AND_SCREEN_KERNEL.md.
 */
export type TransitionPhase = 'triage' | 'active' | 'terminal';

export interface TransitionRow {
  /** flow_step id. */
  id: ID;
  flow_id: ID;
  flow_name: string;
  attribute_def_id: ID;
  /** Typically `'status'` — the attribute_def the parent flow is bound to. */
  attribute_def_name: string;
  from_card_id: ID;
  from_label: string;
  from_phase: TransitionPhase;
  to_card_id: ID;
  to_label: string;
  to_phase: TransitionPhase;
  /** Transition button label authored on the flow_step row. */
  label: string;
  /** 0n means no role gate. */
  requires_role_id?: ID;
  /** Empty string when no role gate. */
  requires_role_name: string;
  /** Display order within UI bucket. */
  sort_order: number;
  /** True if the calling actor's roles satisfy `requires_role_id`. */
  allowed: boolean;
}

export interface FlowStepListForCardInput {
  cardId: ID;
}

export interface FlowStepListForCardOutput {
  rows: TransitionRow[];
}

// ============================================================================
// flow.list / flow.set / flow.delete / flow.preview_delete  (admin)
// ============================================================================

/**
 * One flow row joined to its bound attribute_def's name. Mirrors
 * `server/internal/dom/flow/flow.go::ListRow`.
 */
export interface FlowRow {
  id: ID;
  name: string;
  /** Optional human-readable description. Empty when unset on the server. */
  doc: string;
  attribute_def_id: ID;
  attribute_def_name: string;
  scope_card_id: ID;
  /** 0n means no default; the new-task path will not preselect a status. */
  default_create_status_id: ID;
  /** RFC3339 timestamp. */
  created_at: string;
}

export interface FlowListInput {
  /** Optional filter on project (scope) card id. */
  scopeCardId?: ID;
  /** Optional filter on bound attribute_def id. */
  attributeDefId?: ID;
}

export interface FlowListOutput {
  rows: FlowRow[];
}

export interface FlowSetInput {
  /** Omit / 0n to insert. Pass an existing id to update by id. */
  id?: ID;
  name: string;
  doc?: string;
  attributeDefId: ID;
  scopeCardId: ID;
  /** Optional default status value-card; 0n / undefined clears the default. */
  defaultCreateStatusId?: ID;
}

export interface FlowSetOutput {
  id: ID;
}

export interface FlowDeleteInput {
  flowId: ID;
}

export interface FlowDeleteOutput {
  ok: boolean;
  deleted: number;
}

export interface FlowPreviewDeleteInput {
  flowId: ID;
}

/** Per-phase bucketing for `tasks_currently_in_flow_states`. */
export interface FlowPhaseCounts {
  triage: number;
  active: number;
  terminal: number;
}

/** V16 preview shape — admin sees affected-task counts before delete. */
export interface FlowPreviewDeleteOutput {
  flow_id: ID;
  flow_name: string;
  step_count: number;
  tasks_currently_in_flow_states: number;
  tasks_by_phase: FlowPhaseCounts;
  sample_step_labels: string[];
}

// ============================================================================
// flow_step.list / flow_step.set / flow_step.delete  (admin)
// ============================================================================

/**
 * One flow_step row joined to its optional requires_role's name. Mirrors
 * `server/internal/dom/flow/flow.go::StepListRow`.
 */
export interface FlowStepRow {
  id: ID;
  flow_id: ID;
  from_card_id: ID;
  to_card_id: ID;
  label: string;
  /** 0n means no role gate. */
  requires_role_id: ID;
  /** Empty string when no role gate. */
  requires_role_name: string;
  sort_order: number;
}

export interface FlowStepListInput {
  flowId: ID;
}

export interface FlowStepListOutput {
  rows: FlowStepRow[];
}

export interface FlowStepSetInput {
  /** Omit / 0n to insert. */
  id?: ID;
  flowId: ID;
  fromCardId: ID;
  toCardId: ID;
  label: string;
  /** 0n / undefined = no role gate (any authenticated user may fire). */
  requiresRoleId?: ID;
  sortOrder?: number;
}

export interface FlowStepSetOutput {
  id: ID;
}

export interface FlowStepDeleteInput {
  flowStepId: ID;
}

export interface FlowStepDeleteOutput {
  ok: boolean;
  deleted: number;
}

/**
 * One row in the `blocked_by` detail attached to a `value_referenced_by_flow`
 * rejection envelope (Gate 10's `card.delete` V8 check). Surfaces enough
 * metadata for the admin UI to render an actionable "delete these flow_steps
 * first" callout.
 */
export interface FlowStepBlocker {
  flow_step_id: ID;
  flow_id: ID;
  flow_name: string;
  /** Which side of the step the deleted card sits on: `'from'` or `'to'`. */
  role: 'from' | 'to' | string;
  from_label: string;
  to_label: string;
  step_label: string;
}

/**
 * Structured detail payload server attaches to a `value_referenced_by_flow`
 * rejection on `card.delete`. The screen reads `error.detail` and walks
 * `blocked_by[]` to render a friendly "delete those transitions first"
 * dialog.
 */
export interface ValueReferencedByFlowDetail {
  card_id: ID;
  blocked_by: FlowStepBlocker[];
}

// ============================================================================
// attribute_def.select / attribute_def.insert
// ============================================================================

export interface AttributeDefSelectInput {
  _empty?: never;
}

export interface AttributeDefBoundCardType {
  card_type_id: ID;
  card_type_name: string;
  is_required: boolean;
  is_built_in: boolean;
  ordering: number;
}

export interface AttributeDefRow {
  id: ID;
  name: string;
  value_type: string;
  /** For card_ref / card_ref[] value_types, the name of the card_type
   *  whose cards are valid values (status / milestone / person / …).
   *  Empty for primitive types. */
  target_card_type_name?: string;
  is_built_in: boolean;
  bound_to: AttributeDefBoundCardType[];
}

export interface AttributeDefSelectOutput {
  rows: AttributeDefRow[];
}

/** One initial edge to seed alongside an `attribute_def.insert`. */
export interface AttributeDefBindEntry {
  cardTypeId: ID;
  isRequired?: boolean;
  ordering?: number;
}

export interface AttributeDefInsertInput {
  name: string;
  valueType: string;
  bindTo?: AttributeDefBindEntry[];
}

export interface AttributeDefInsertOutput {
  id: ID;
}

// ============================================================================
// edge.insert / edge.delete
// ============================================================================

export interface EdgeInsertInput {
  attributeDefId: ID;
  cardTypeId: ID;
  isRequired?: boolean;
  ordering?: number;
}

export interface EdgeInsertOutput {
  ok: boolean;
}

export interface EdgeDeleteInput {
  attributeDefId: ID;
  cardTypeId: ID;
}

export interface EdgeDeleteOutput {
  ok: boolean;
  usage_count: number;
}

// ============================================================================
// activity.select
// ============================================================================

export interface ActivitySelectInput {
  /** Optional; omit for cross-card mode used by the global activity view. */
  cardId?: ID;
  limit?: number;
  beforeActivityId?: ID;
}

export interface ActivityRow {
  id: ID;
  /** Always populated; per-card responses also carry it for uniform routing. */
  card_id: ID;
  kind: string;
  attribute_name?: string;
  value_old?: unknown;
  value_new?: unknown;
  comment_body?: string;
  actor_id: ID;
  created_at: string;
}

export interface ActivitySelectOutput {
  rows: ActivityRow[];
}

// ============================================================================
// comment.insert
// ============================================================================

export interface CommentInsertInput {
  cardId: ID;
  body: string;
}

export interface CommentInsertOutput {
  ok: boolean;
  activity_id: ID;
  comment_body_id: ID;
}

export interface CommentUpdateInput {
  /** Id of the kind='comment' activity row whose body is being edited. */
  activityId: ID;
  /** New comment body text — replaces the linked comment_body row in place. */
  body: string;
}

export interface CommentUpdateOutput {
  ok: boolean;
  /** Id of the audit activity row of kind='comment_edit' inserted by the server. */
  edit_activity_id: ID;
}

// ============================================================================
// user.select
// ============================================================================

export interface UserSelectInput {
  /** Optional filter on a specific set of user_account ids. */
  ids?: ID[];
  /** Optional filter on parent_user_id. Used by the Admin Agents screen
   *  to pull only the calling user's own agents. */
  parentUserId?: ID;
  /** Optional filter on is_agent. */
  isAgent?: boolean;
}

export interface UserRow {
  id: ID;
  display_name: string;
  /** Present when filtered or otherwise surfaced by the server. */
  parent_user_id?: ID;
  is_agent?: boolean;
}

export interface UserSelectOutput {
  rows: UserRow[];
}

// ============================================================================
// tag.apply / tag.remove
// ============================================================================

export interface TagApplyInput {
  targetCardId: ID;
  tagCardId: ID;
}

export interface TagApplyOutput {
  ok: boolean;
  activity_id: ID;
  removed_tag_ids: ID[];
}

export interface TagRemoveInput {
  targetCardId: ID;
  tagCardId: ID;
}

export interface TagRemoveOutput {
  ok: boolean;
  activity_id: ID;
}


// ============================================================================
// project.stamp — Gate 10/12 of FLOW_AND_SCREEN_KERNEL. Given a template
// project id, the server graph-copies the template's value cards / flow /
// flow_steps / screens / filters with ID remapping and emits a fresh
// project rooted at the supplied `name`. Authz: manager / admin (V26).
// ============================================================================

export interface ProjectStampInput {
  templateProjectId: ID;
  name: string;
}

export interface ProjectStampOutput {
  /** Id of the freshly stamped project card. */
  new_project_id: ID;
  /** Non-fatal advisories from the server (e.g. "template_empty"). */
  warnings?: string[];
}

// ============================================================================
// user_card_sort.set
// ============================================================================

export interface UserCardSortSetInput {
  cardId: ID;
  sortOrder: number;
}

export interface UserCardSortSetOutput {
  ok: boolean;
}

// ============================================================================
// comm.create / comm.list_for_task / reply.post — Comm Gate 8 client surface.
//
// Mirrors `server/internal/dom/comm/comm.go`:
//   - comm.create          { task_id, channel_id, subject?, initial_message?,
//                            recipient_person_ids? }
//                          → { comm_id, thread_id }
//   - comm.list_for_task   { task_id } → { rows: CommRow[] }
//   - comm.set_recipients  { comm_id, recipient_person_ids } → { count }
//   - reply.post           { comm_id, body } → { reply_id }
//   - person.upsert_by_email { email, display_name?, kind? }
//                            → { person_id, created }
// ============================================================================

export interface CommCreateInput {
  taskId: ID;
  channelId: ID;
  subject?: string;
  initialMessage?: string;
  /**
   * Initial participants. Each id must reference a `person` card.
   * Persisted on the comm's `comm_recipients` attribute and used as
   * the To: list when an operator authors a reply.
   */
  recipientPersonIds?: ID[];
}

export interface CommCreateOutput {
  comm_id: ID;
  thread_id: string;
}

export interface CommListForTaskInput {
  taskId: ID;
}

/**
 * One reply_body row materialised on the comms screen.
 *
 * `delivery_status` is a closed set:
 *   `pending` / `sent` / `bounced` / `failed` / `received`.
 *
 * `to` and `subject` are snapshots captured at write time — they
 * reflect what was sent / received, not the current comm.recipients
 * or task title (those may evolve after the reply lands).
 */
export interface ReplyRow {
  id: ID;
  to: string;
  from: string;
  subject: string;
  body_text: string;
  delivery_status: string;
  created_at: string;
}

/**
 * One comm card with its replies hydrated. `comm_status` is the value-card
 * id (not the status title); callers resolve titles through a status map
 * loaded separately. `recipients` is the current thread-level participant
 * list (person card ids); the SMTP sender resolves them to email
 * addresses at send time.
 */
export interface CommRow {
  id: ID;
  title: string;
  thread_id: string;
  channel_id: ID;
  comm_status: ID;
  recipients: ID[];
  replies: ReplyRow[];
}

export interface CommListForTaskOutput {
  rows: CommRow[];
}

export interface CommSetRecipientsInput {
  commId: ID;
  /** Replaces the entire participant list. Pass [] to clear. */
  recipientPersonIds: ID[];
}

export interface CommSetRecipientsOutput {
  count: number;
}

export interface ReplyPostInput {
  commId: ID;
  body: string;
  /**
   * Existing attachment ids on the comm's parent task to attach to
   * the outgoing reply. Optional — empty means a body-only reply
   * (the pre-V2 behaviour). The server validates that every id
   * belongs to the parent task before persisting the link.
   */
  attachmentIds?: ID[];
}

export interface ReplyPostOutput {
  reply_id: ID;
}

/**
 * task.move — bump a task to a different project and (optionally)
 * re-classify it in the destination. Per-project attributes
 * (status / milestone_ref / component_ref / tags) on the moved task
 * are cleared in the same tx; the picked replacements land in the
 * destination project. Sub-task strategy controls whether descendants
 * ride along (cascade, default) or stay behind with parent_task
 * cleared (break).
 *
 * Attachments come along automatically — they're keyed on card_id,
 * not project, so nothing to specify here.
 */
export interface TaskMoveInput {
  /** Task card id to move. */
  cardId: ID;
  /** Destination project id. */
  newProjectId: ID;
  /** Optional status in the destination. Omit / 0n to let the server
   *  pick the destination project's first intake-style status. */
  newStatusId?: ID;
  /** Optional milestone in the destination. Omit / 0n to leave unset. */
  newMilestoneId?: ID;
  /** Optional component in the destination. Omit / 0n to leave unset. */
  newComponentId?: ID;
  /** Optional tags in the destination. */
  newTagIds?: ID[];
  /** 'cascade' (default) carries every parent_task descendant;
   *  'break' leaves children behind and clears their parent_task. */
  subtaskStrategy?: 'cascade' | 'break';
}

/**
 * task.purge — permanently delete a task and its dependent rows
 * (attribute_value, activity, attachment, child comms + reply
 * bodies). The UI must gate this behind a strong confirm; the
 * server refuses on live sub-tasks or flow_step references.
 */
export interface TaskPurgeInput {
  cardId: ID;
}

export interface TaskPurgeOutput {
  ok: boolean;
  /** Every card id removed — the task plus any cascaded comms and
   *  reply_body cards. */
  purgedCardIds: ID[];
  /** Reply_body card ids removed because their parent comm was
   *  cascaded. */
  purgedReplyBodyIds: ID[];
}

export interface TaskMoveOutput {
  /** Every card whose parent_card_id changed (the task plus any
   *  cascaded descendants). */
  movedCardIds: ID[];
  /** Direct children whose parent_task was cleared (break mode only). */
  brokenChildIds: ID[];
  /** The status the server applied — useful when the caller let the
   *  server choose the intake default. */
  resolvedStatusId: ID;
}

export interface PersonUpsertByEmailInput {
  email: string;
  /** Used as the title when a new person card is created. */
  displayName?: string;
  /** One of `'member'` | `'contact'`; default `'contact'`. */
  kind?: 'member' | 'contact';
}

export interface PersonUpsertByEmailOutput {
  person_id: ID;
  /** True when a new person card was inserted; false on existing match. */
  created: boolean;
}

export interface PersonCreateInput {
  title: string;
  email?: string;
  /** One of 'contact' | 'assignee' | 'user'. Email is required for 'user'. */
  tier: 'contact' | 'assignee' | 'user';
}

export interface PersonCreateOutput {
  person_card_id: ID;
  /** Newly inserted user_account id when tier='user'; absent otherwise. */
  user_account_id?: ID;
}

// ============================================================================
// comm_channel.set / comm_channel.list / comm_log.list — Comm Gate 9 admin
// surface for the /admin/comm-channels + /admin/comm-log screens.
//
// Mirrors `server/internal/dom/comm/comm.go`:
//   - comm_channel.set  { id?, project_id, name, channel_type,
//                         imap_host?, imap_port?, imap_username?,
//                         imap_password?,
//                         smtp_host?, smtp_port?, smtp_username?,
//                         smtp_password?,
//                         from_address?, intake_status_id? }
//                       → { channel_id }
//   - comm_channel.list { project_id } → { rows: ChannelRow[] }
//   - comm_log.list     { project_id, kind?, since?, limit? }
//                       → { rows: CommLogRow[] }
//
// Password fields are write-only: ChannelRow surfaces
// has_imap_password / has_smtp_password booleans so the GUI can show
// "configured" without exposing the encrypted bytes. Leaving a password
// field undefined on the set wire shape leaves the stored value
// unchanged (omit-on-update semantics); supplying an empty string would
// clear it (the server's pgcrypto code passes the empty value through).
// ============================================================================

/** One closed kind value emitted by the IMAP poller + SMTP sender. */
export type CommLogKind =
  | 'poll'
  | 'send_ok'
  | 'send_bounce'
  | 'send_fail'
  | 'imap_auth_fail'
  | 'parse_error'
  | 'unmatched_thread'
  | 'attachment_too_large';

/** Every CommLogKind value in display order — used by the chip filter. */
export const COMM_LOG_KINDS: readonly CommLogKind[] = [
  'poll',
  'send_ok',
  'send_bounce',
  'send_fail',
  'imap_auth_fail',
  'parse_error',
  'unmatched_thread',
  'attachment_too_large',
] as const;

export interface ChannelSetInput {
  /** Existing channel card id; 0 / undefined inserts a new channel. */
  id?: ID;
  projectId: ID;
  name: string;
  channelType: string;
  imapHost?: string;
  imapPort?: number;
  imapUsername?: string;
  /** Omit to leave the stored password unchanged on update. */
  imapPassword?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUsername?: string;
  /** Omit to leave the stored password unchanged on update. */
  smtpPassword?: string;
  fromAddress?: string;
  intakeStatusId?: ID;
  /**
   * Tri-state enable/disable. Leave undefined to preserve the stored
   * value (the typical case when an admin edits other fields). Set
   * explicitly to 'enabled' to clear a fault, or 'disabled-admin' to
   * pause the channel. The runtime owns 'disabled-fault' — the admin
   * UI never writes that value directly.
   */
  channelStatus?: ChannelStatus;
}

/**
 * The three values comm_channel.channel_status accepts. Kept in sync
 * with the server constants in server/internal/dom/comm/channel_status.go.
 */
export type ChannelStatus = 'enabled' | 'disabled-admin' | 'disabled-fault';

export interface ChannelSetOutput {
  channel_id: ID;
}

export interface ChannelListInput {
  projectId: ID;
}

/**
 * One comm_channel card, joined with its comm_secret row. Password
 * fields are intentionally absent — the wire-shape surfaces only
 * boolean has_*_password flags so the GUI can show "configured"
 * without revealing the encrypted bytes.
 */
export interface ChannelRow {
  id: ID;
  name: string;
  channel_type: string;
  imap_host: string;
  imap_port: number;
  imap_username: string;
  smtp_host: string;
  smtp_port: number;
  smtp_username: string;
  from_address: string;
  intake_status_id: ID;
  /**
   * Tri-state status. Missing / unknown server values surface as
   * 'enabled' so legacy rows keep working without a re-seed.
   */
  channel_status: ChannelStatus;
  /**
   * Set by the runtime when channel_status='disabled-fault'; empty
   * otherwise. Free-form prose (e.g. "IMAP dial failed: …") suitable
   * for surfacing inline next to the status pill.
   */
  channel_fault_reason: string;
  has_imap_password: boolean;
  has_smtp_password: boolean;
  created_at: string;
}

export interface ChannelListOutput {
  rows: ChannelRow[];
}

// ============================================================================
// proc.search — handler-catalogue introspection. The form kernel fetches
// every registered handler at app boot via `{all: true}` and caches the
// JSON Schemas to drive data-bound controls. Each control declares a
// path; the kernel reads the field's type / required / format from the
// schema and validates against it on submit.
// ============================================================================

export interface ProcSearchInput {
  query?: string;
  endpoint?: string;
  action?: string;
  all?: boolean;
  includeUnavailable?: boolean;
}

/** Minimal subset of JSON Schema 2020-12 the kernel consumes — mirrors
 *  the server's mcp.Schema struct (see server/internal/mcp/schema.go). */
export interface JSONSchema {
  type?: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: string[];
  additionalProperties?: boolean;
  format?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
}

export interface HandlerDescriptor {
  name: string;
  endpoint: string;
  action: string;
  doc?: string;
  allowed_roles?: string[];
  input_schema?: JSONSchema;
  output_schema?: JSONSchema;
}

export interface ProcSearchOutput {
  handlers: HandlerDescriptor[];
}

// ============================================================================
// Activity sink: admin-only authoring + visibility surface for
// activity_sink cards. Mirrors the comm_channel shape — a per-project
// card with a client_secret stored encrypted via pgcrypto, status
// gates that reuse the channel_status / channel_fault_reason
// attributes from the comm subsystem, and a runtime pump that pushes
// matching activity rows to an external destination (MS Graph → Teams
// in v1). The state row (last_activity_id pointer + last_pushed_at +
// last_error) is surfaced via SinkRow so the admin can see how far the
// pump has advanced and whether the last tick failed.
// ============================================================================

export interface SinkSetInput {
  /** Existing sink card id; 0 / undefined inserts a new sink. */
  id?: ID;
  projectId: ID;
  name: string;
  /** v1: 'msgraph_teams'. */
  sinkKind: string;
  msgraphTenantId?: string;
  msgraphClientId?: string;
  /** Omit to leave the stored secret unchanged on update. */
  msgraphClientSecret?: string;
  msgraphTeamId?: string;
  msgraphChannelId?: string;
  /** JSON predicate. Empty string clears the stored filter. */
  activityFilter?: string;
  /** Tri-state status. Same semantics as ChannelStatus on a comm_channel. */
  channelStatus?: ChannelStatus;
}

export interface SinkSetOutput {
  sink_id: ID;
}

export interface SinkListInput {
  projectId: ID;
}

export interface SinkRow {
  id: ID;
  name: string;
  sink_kind: string;
  msgraph_tenant_id: string;
  msgraph_client_id: string;
  msgraph_team_id: string;
  msgraph_channel_id: string;
  activity_filter: string;
  channel_status: ChannelStatus;
  channel_fault_reason: string;
  has_client_secret: boolean;
  /** Largest activity.id this sink has pushed; 0 when never pushed. */
  last_activity_id: ID;
  /** RFC3339 timestamp of the most recent successful push; empty when never pushed. */
  last_pushed_at: string;
  /** Cumulative number of rows the pump has pushed downstream. */
  last_pushed_count: ID;
  /** Most recent push error from the pump; cleared on next success. */
  last_error: string;
  created_at: string;
}

export interface SinkListOutput {
  rows: SinkRow[];
}

export interface CommLogListInput {
  projectId: ID;
  /** One of the eight CommLogKind values; empty / undefined = no filter. */
  kind?: string;
  /** ISO timestamp; rows older than this are excluded; empty = 24h. */
  since?: string;
  /** Max rows; default 200 (server clamps to 1000). */
  limit?: number;
}

/**
 * One comm_log row. `channel_id` is 0 for pre-identification events
 * (e.g. IMAP auth failures before the channel could be resolved);
 * `channel_name` is empty in that case or when the channel card has
 * been deleted.
 */
export interface CommLogRow {
  id: ID;
  channel_id: ID;
  channel_name: string;
  kind: string;
  detail?: unknown;
  at: string;
}

export interface CommLogListOutput {
  rows: CommLogRow[];
}

// ============================================================================
// user.list_with_roles  (admin)
// ============================================================================

export interface UserListWithRolesInput {
  _empty?: never;
}

export interface RoleAssignmentRow {
  role_name: string;
  scope_project_id?: ID;
  scope_project_title?: string;
}

export interface UserListWithRolesRow {
  id: ID;
  display_name: string;
  email?: string;
  oidc_sub?: string;
  /**
   * Linked person card id when this user_account is associated with
   * a person card (the "User" tier). Absent for login-only accounts
   * and for agents (agents never carry a person link by design).
   */
  person_card_id?: ID;
  roles: RoleAssignmentRow[];
}

export interface UserUnlinkPersonInput {
  /** user_account row whose user_account_person link to delete. */
  userAccountId: ID;
}

export interface UserUnlinkPersonOutput {
  /** True when a row was removed; false when the link was already absent. */
  deleted: boolean;
}

export interface UserListWithRolesOutput {
  rows: UserListWithRolesRow[];
}

// ============================================================================
// role.list  (admin)
// ============================================================================

export interface RoleListInput {
  _empty?: never;
}

export interface RoleGrantRow {
  card_type: string;
  process: string;
}

export interface RoleRow {
  id: ID;
  name: string;
  doc: string;
  grants: RoleGrantRow[];
}

export interface RoleListOutput {
  rows: RoleRow[];
}

// ============================================================================
// user_role.set / user_role.revoke  (admin)
// ============================================================================

export interface UserRoleSetInput {
  userId: ID;
  roleName: string;
  scopeProjectId?: ID;
}

export interface UserRoleSetOutput {
  ok: boolean;
  user_role_id: ID;
}

export interface UserRoleRevokeInput {
  userId: ID;
  roleName: string;
  scopeProjectId?: ID;
}

export interface UserRoleRevokeOutput {
  ok: boolean;
  deleted: number;
}

export interface UserRoleListInput {
  userId: ID;
}

export interface UserRoleListRow {
  role_name: string;
  scope_project_id?: ID;
}

export interface UserRoleListOutput {
  rows: UserRoleListRow[];
}

// ============================================================================
// role_mapping.*  (admin)
// ============================================================================

export interface RoleMappingListInput {
  _empty?: never;
}

export interface RoleMappingListRow {
  claim_value: string;
  role_id: ID;
  role_name: string;
}

export interface RoleMappingListOutput {
  rows: RoleMappingListRow[];
}

export interface RoleMappingSetInput {
  claimValue: string;
  roleName: string;
}

export interface RoleMappingSetOutput {
  ok: boolean;
}

export interface RoleMappingDeleteInput {
  claimValue: string;
}

export interface RoleMappingDeleteOutput {
  ok: boolean;
  deleted: number;
}

// ============================================================================
// agent.create / agent.delete
// ============================================================================

export interface AgentCreateInput {
  displayName: string;
}

export interface AgentCreateOutput {
  user_id: ID;
}

export interface AgentDeleteInput {
  userId: ID;
}

export interface AgentDeleteOutput {
  ok: boolean;
  deleted: number;
}

// ============================================================================
// user_token.create / list / revoke
// ============================================================================

export interface UserTokenCreateInput {
  userId: ID;
  label: string;
  /** Optional RFC3339 timestamp. */
  expiresAt?: string;
}

export interface UserTokenCreateOutput {
  /** Secret bearer value — shown ONCE; the server cannot recover it later. */
  token: string;
  label: string;
}

export interface UserTokenListInput {
  userId: ID;
}

export interface UserTokenListRow {
  label: string;
  created_at: string;
  last_used_at: string;
  expires_at?: string;
  revoked_at?: string;
}

export interface UserTokenListOutput {
  rows: UserTokenListRow[];
}

export interface UserTokenRevokeInput {
  userId: ID;
  label: string;
}

export interface UserTokenRevokeOutput {
  ok: boolean;
  deleted: number;
}

// ============================================================================
// help.get_topic / get_screen
// ============================================================================

export interface HelpGetTopicInput {
  topic: string;
}

export interface HelpGetTopicOutput {
  title: string;
  markdown: string;
}

export interface HelpGetScreenInput {
  screenCardId: ID;
}

export interface HelpGetScreenOutput {
  title: string;
  markdown: string;
}

// ============================================================================
// user_card_agent.set / clear / list
// ============================================================================

export interface UserCardAgentSetInput {
  cardId: ID;
  agentUserId: ID;
}

export interface UserCardAgentSetOutput {
  ok: boolean;
}

export interface UserCardAgentClearInput {
  cardId: ID;
}

export interface UserCardAgentClearOutput {
  ok: boolean;
  deleted: number;
}

export interface UserCardAgentListInput {
  parentCardId?: ID;
}

export interface UserCardAgentListRow {
  card_id: ID;
  agent_user_id: ID;
  created_at: string;
}

export interface UserCardAgentListOutput {
  rows: UserCardAgentListRow[];
}
