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
//   - comm.create    { task_id, channel_id, subject?, initial_message? }
//                    → { comm_id, thread_id }
//   - comm.list_for_task { task_id } → { rows: CommRow[] }
//   - reply.post     { comm_id, to, subject?, body } → { reply_id }
// ============================================================================

export interface CommCreateInput {
  taskId: ID;
  channelId: ID;
  subject?: string;
  initialMessage?: string;
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
 * loaded separately.
 */
export interface CommRow {
  id: ID;
  title: string;
  thread_id: string;
  channel_id: ID;
  comm_status: ID;
  replies: ReplyRow[];
}

export interface CommListForTaskOutput {
  rows: CommRow[];
}

export interface ReplyPostInput {
  commId: ID;
  to: string;
  subject?: string;
  body: string;
}

export interface ReplyPostOutput {
  reply_id: ID;
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
}

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
  has_imap_password: boolean;
  has_smtp_password: boolean;
  created_at: string;
}

export interface ChannelListOutput {
  rows: ChannelRow[];
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
  roles: RoleAssignmentRow[];
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
