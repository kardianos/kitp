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
}

export interface CardInsertOutput {
  id: ID;
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
}

export interface CardWithAttrs {
  id: ID;
  card_type_id: ID;
  card_type_name: string;
  parent_card_id?: ID;
  /**
   * Structural flag: true when this value-card represents a terminal /
   * closed state for any ref attribute pointing at it (e.g. a status
   * card 'Done' or 'Cancelled'). Drives the notTerminal filter +
   * action-button discovery.
   */
  is_terminal?: boolean;
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
  person_card_id: ID;
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
