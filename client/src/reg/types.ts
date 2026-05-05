/**
 * Shared row types for the handler registry. Each interface mirrors a Dart
 * data class from `client/lib/reg/handlers.dart` and `handlers_admin.dart`.
 *
 * Conventions:
 *   - Field names match the server's JSON exactly (snake_case).
 *   - Optional fields are typed `T | undefined` (with `?:`); they are
 *     OMITTED — not set to null — by the encoders in `handlers.ts`.
 *   - Numeric ID fields use `number`. The encoders/decoders use
 *     `Number(j.x)` (not bitwise tricks) so values up to 2^53-1 round-trip.
 */

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
  id: number;
  name: string;
  parent_card_type_id?: number;
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
  parentCardId?: number;
  title: string;
  /**
   * Optional initial attribute writes. Values must be JSON-encodable.
   * Forwarded to the server's `data.attributes` jsonb field unchanged.
   */
  attributes?: Record<string, unknown>;
}

export interface CardInsertOutput {
  id: number;
}

// ============================================================================
// card.select
// ============================================================================

export interface CardSelectInput {
  parentCardId?: number;
  cardTypeName?: string;
}

export interface CardRow {
  id: number;
  card_type_id: number;
  card_type_name: string;
  parent_card_id?: number;
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
  parentCardId?: number;
  cardTypeName?: string;
  where?: CardWherePredicate[];
  /** Recursive predicate tree; takes precedence over `where` when present. */
  tree?: CardWhereTree;
  order?: CardOrderClause[];
  limit?: number;
  offset?: number;
  includeDeleted?: boolean;
}

export interface CardWithAttrs {
  id: number;
  card_type_id: number;
  card_type_name: string;
  parent_card_id?: number;
  attributes: Record<string, unknown>;
  deleted_at?: string;
}

export interface CardSelectWithAttributesOutput {
  rows: CardWithAttrs[];
}

// ============================================================================
// card.delete
// ============================================================================

export interface CardDeleteInput {
  cardId: number;
}

export interface CardDeleteOutput {
  ok: boolean;
  activity_id: number;
}

// ============================================================================
// attribute.update
// ============================================================================

export interface AttributeUpdateInput {
  cardId: number;
  attributeName: string;
  /** JSON-encodable value (string / number / bool / null / list / map). */
  value: unknown;
}

export interface AttributeUpdateOutput {
  ok: boolean;
  activity_id: number;
  prev_value?: unknown;
}

// ============================================================================
// attribute_def.select / attribute_def.insert
// ============================================================================

export interface AttributeDefSelectInput {
  _empty?: never;
}

export interface AttributeDefBoundCardType {
  card_type_id: number;
  card_type_name: string;
  is_required: boolean;
  is_built_in: boolean;
  ordering: number;
}

/**
 * One value of an enum-typed attribute_def. Server emits this with
 * migration 0012 + the attributedef.go enum extension.
 */
export interface AttributeDefOptionRow {
  value: string;
  label: string;
  ordering: number;
}

export interface AttributeDefRow {
  id: number;
  name: string;
  value_type: string;
  is_built_in: boolean;
  bound_to: AttributeDefBoundCardType[];
  /** Forward-compat (migration 0012); decoders treat absent as []. */
  options?: AttributeDefOptionRow[];
}

export interface AttributeDefSelectOutput {
  rows: AttributeDefRow[];
}

/** One initial edge to seed alongside an `attribute_def.insert`. */
export interface AttributeDefBindEntry {
  cardTypeId: number;
  isRequired?: boolean;
  ordering?: number;
}

export interface AttributeDefInsertInput {
  name: string;
  valueType: string;
  bindTo?: AttributeDefBindEntry[];
}

export interface AttributeDefInsertOutput {
  id: number;
}

// ============================================================================
// edge.insert / edge.delete
// ============================================================================

export interface EdgeInsertInput {
  attributeDefId: number;
  cardTypeId: number;
  isRequired?: boolean;
  ordering?: number;
}

export interface EdgeInsertOutput {
  ok: boolean;
}

export interface EdgeDeleteInput {
  attributeDefId: number;
  cardTypeId: number;
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
  cardId?: number;
  limit?: number;
  beforeActivityId?: number;
}

export interface ActivityRow {
  id: number;
  /** Always populated; per-card responses also carry it for uniform routing. */
  card_id: number;
  kind: string;
  attribute_name?: string;
  value_old?: unknown;
  value_new?: unknown;
  comment_body?: string;
  actor_id: number;
  created_at: string;
}

export interface ActivitySelectOutput {
  rows: ActivityRow[];
}

// ============================================================================
// comment.insert
// ============================================================================

export interface CommentInsertInput {
  cardId: number;
  body: string;
}

export interface CommentInsertOutput {
  ok: boolean;
  activity_id: number;
  comment_body_id: number;
}

// ============================================================================
// user.select
// ============================================================================

export interface UserSelectInput {
  _empty?: never;
}

export interface UserRow {
  id: number;
  display_name: string;
}

export interface UserSelectOutput {
  rows: UserRow[];
}

// ============================================================================
// tag.apply / tag.remove
// ============================================================================

export interface TagApplyInput {
  targetCardId: number;
  tagCardId: number;
}

export interface TagApplyOutput {
  ok: boolean;
  activity_id: number;
  removed_tag_ids: number[];
}

export interface TagRemoveInput {
  targetCardId: number;
  tagCardId: number;
}

export interface TagRemoveOutput {
  ok: boolean;
  activity_id: number;
}

// ============================================================================
// inbox.select
// ============================================================================

export interface InboxSelectInput {
  /** In dev mode the server refuses any value other than the actor's user_id. */
  userId?: number;
  /** v2 predicate-tree, AND-joined onto the built-in inbox predicate. */
  tree?: CardWhereTree;
  limit?: number;
  offset?: number;
}

export interface InboxRow {
  id: number;
  card_type_id: number;
  parent_card_id?: number;
  attributes: Record<string, unknown>;
  /** Null on the wire when the row has never been reordered. */
  personal_sort_order?: number;
}

export interface InboxSelectOutput {
  rows: InboxRow[];
}

// ============================================================================
// user_card_sort.set
// ============================================================================

export interface UserCardSortSetInput {
  cardId: number;
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
  scope_project_id?: number;
  scope_project_title?: string;
}

export interface UserListWithRolesRow {
  id: number;
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
  id: number;
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
  userId: number;
  roleName: string;
  scopeProjectId?: number;
}

export interface UserRoleSetOutput {
  ok: boolean;
  user_role_id: number;
}

export interface UserRoleRevokeInput {
  userId: number;
  roleName: string;
  scopeProjectId?: number;
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
  role_id: number;
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
