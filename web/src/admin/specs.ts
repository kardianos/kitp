/**
 * Admin API specs — declared up front and registered via `api.define`,
 * addressed by the declarative data layer through their `endpoint.action` key.
 * These target the REAL `/api/v1/batch` wire and match the Go handlers verbatim.
 *
 * Contacts (person cards) reuse the kanban specs (`card.select_with_attributes`
 * for the list + `attribute.update` for the editable detail fields) with NO new
 * backend wiring — so only the NON-CARD source (Users) needs specs here:
 *
 *   - user.list_with_roles  (server/internal/dom/user/user.go +
 *       db/schema/functions/user_list_with_roles_batch.sql)
 *       in : {} (no fields; admin-only, lists every non-agent user_account)
 *       out: { rows: [{ id, display_name, email?, oidc_sub?, parent_user_id?,
 *                       is_agent, person_card_id?,
 *                       roles: [{ role_name, scope_project_id?, scope_project_title? }] }] }
 *            — ids are JSON strings; we keep them as strings in the row
 *            (MasterDetail compares ids by canonical string form, so no bigint
 *            revival registration is required for this read).
 *   - user.select  (db/schema/functions/user_select_batch.sql)
 *       in : { display_name?, parent_user_id?, is_agent? }
 *       out: { rows: [{ id, display_name, parent_user_id?,
 *                       parent_user_name?, is_agent }] }
 *            — the lighter read, registered as a simpler fallback.
 *
 * The decoders pass the decoded rows through near-verbatim (the MasterDetail
 * field accessors read dotted paths off the raw row), only normalising the id
 * to a string and defaulting the roles array so the badges field never sees
 * undefined.
 */

import type { Api } from '../core/api.js';
import { encodeWire, decodeWire } from '../core/codec.js';

/* -------------------------------------------------------------------------- */
/* Spec keys (addressed by the declarative binding tables).                    */
/* -------------------------------------------------------------------------- */

export const ADMIN_SPEC = {
  userListWithRoles: 'user.list_with_roles',
  userSelect: 'user.select',
  attributeDefSelect: 'attribute_def.select',
  flowList: 'flow.list',
  roleList: 'role.list',
  commChannelList: 'comm_channel.list',
  activitySinkList: 'activity_sink.list',
  commLogList: 'comm_log.list',
  // Write specs the create/delete + Users role/person affordances issue.
  personCreate: 'person.create',
  personGrantAccount: 'person.grant_account',
  userRoleSet: 'user_role.set',
  userRoleRevoke: 'user_role.revoke',
  userUnlinkPerson: 'user.unlink_person',
  // Nested-editor specs (flow-step transitions, attribute edges, card_types).
  cardTypeSelect: 'card_type.select',
  flowStepList: 'flow_step.list',
  flowStepSet: 'flow_step.set',
  flowStepDelete: 'flow_step.delete',
  flowPreviewDelete: 'flow.preview_delete',
  flowDelete: 'flow.delete',
  edgeInsert: 'edge.insert',
  edgeDelete: 'edge.delete',
  attributeDefInsert: 'attribute_def.insert',
  // Comm-channel + activity-sink config writes (write-only secrets).
  commChannelSet: 'comm_channel.set',
  activitySinkSet: 'activity_sink.set',
  // Agent create / delete + their tokens (mint-once / list / revoke).
  agentCreate: 'agent.create',
  agentDelete: 'agent.delete',
  userTokenList: 'user_token.list',
  userTokenCreate: 'user_token.create',
  userTokenRevoke: 'user_token.revoke',
  // Role mappings (claim_value → role) — set / delete.
  roleMappingList: 'role_mapping.list',
  roleMappingSet: 'role_mapping.set',
  roleMappingDelete: 'role_mapping.delete',
  // Background jobs (workspace Jobs screen) — list + run-now.
  schedulerList: 'scheduler.list',
  schedulerRun: 'scheduler.run',
} as const;

/* -------------------------------------------------------------------------- */
/* Types (the camelCase surface; the wire is snake_case).                      */
/* -------------------------------------------------------------------------- */

export interface UserRoleAssignment {
  role_name: string;
  scope_project_id?: string;
  scope_project_title?: string;
}

export interface UserRow {
  id: string;
  display_name: string;
  email?: string;
  oidc_sub?: string;
  parent_user_id?: string;
  parent_user_name?: string;
  is_agent: boolean;
  person_card_id?: string;
  roles: UserRoleAssignment[];
}

export interface UserListOutput {
  rows: UserRow[];
}

/* ---- attribute_def.select (Attributes screen) ---------------------------- */

export interface AttributeDefBoundCardType {
  card_type_id: string;
  card_type_name: string;
  is_required?: boolean;
  is_built_in?: boolean;
  ordering?: number;
}

export interface AttributeDefRow {
  id: string;
  name: string;
  value_type: string;
  target_card_type_name?: string;
  is_built_in: boolean;
  /** True for card_ref attributes whose value-cards are editable on the Enums
   *  admin screen (milestone / component / tag). */
  enum_managed?: boolean;
  bound_to: AttributeDefBoundCardType[];
}

export interface AttributeDefListOutput {
  rows: AttributeDefRow[];
}

/* ---- flow.list (Workflows screen) ---------------------------------------- */

export interface FlowRow {
  id: string;
  name: string;
  doc?: string;
  attribute_def_id?: string;
  attribute_def_name?: string;
  scope_card_id?: string;
  /** Joined display name of the scope project card (its `title`). */
  scope_project_title?: string;
  default_create_status_id?: string;
  /** Joined display name of the default-create status card (its `title`). */
  default_create_status_name?: string;
  created_at?: string;
}

export interface FlowListOutput {
  rows: FlowRow[];
}

/* ---- role.list (Roles screen) -------------------------------------------- */

export interface RoleGrant {
  card_type: string;
  process: string;
}

export interface RoleRow {
  id: string;
  name: string;
  doc?: string;
  grants: RoleGrant[];
}

export interface RoleListOutput {
  rows: RoleRow[];
}

/* ---- comm_channel.list (Comm Channels screen) ---------------------------- */

/**
 * One comm_channel row, camelCase — decoded straight off the wire by the
 * generic codec (decodeWire), no field-by-field mapping. Keys mirror the Go
 * ChannelRow json tags with snake→camel applied.
 */
export interface CommChannel {
  id: string;
  name: string;
  channelType: string;
  imapHost?: string;
  imapPort?: number;
  imapUsername?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUsername?: string;
  fromAddress?: string;
  /** Status card id new intake tasks are created in; omitted/0 = use the
   *  project flow's default at intake time. */
  intakeStatusId?: string;
  channelStatus: string;
  channelFaultReason?: string;
  hasImapPassword: boolean;
  hasSmtpPassword: boolean;
  createdAt?: string;
}

export interface CommChannelListOutput {
  rows: CommChannel[];
}

/* ---- scheduler.list / scheduler.run (workspace Jobs screen) -------------- */

/** One background job: its static declaration + a live metrics snapshot.
 *  Durations arrive pre-formatted (e.g. "10m0s"); empty strings mean "unset"
 *  / "never run". */
export interface SchedulerJobInfo {
  name: string;
  description: string;
  interval: string;
  timeout: string;
  on_startup: boolean;
  offset: string;
  disabled: boolean;
  success: number;
  failure: number;
  last_run_at: string;
  last_duration: string;
  last_error: string;
}

export interface SchedulerListOutput {
  jobs: SchedulerJobInfo[];
}

/** The outcome of one "run now" trigger plus the refreshed metrics row. */
export interface SchedulerRunOutput {
  name: string;
  /** False when the job was already running; no new run launched. */
  started: boolean;
  /** True when the run executed AND the job returned no error. */
  ok: boolean;
  error: string;
  duration: string;
  ran_at: string;
  message: string;
  job: SchedulerJobInfo;
}

/* ---- activity_sink.list (Activity Sinks screen) -------------------------- */

export interface ActivitySinkRow {
  id: string;
  name: string;
  sink_kind: string;
  msgraph_tenant_id?: string;
  msgraph_team_id?: string;
  msgraph_channel_id?: string;
  channel_status: string;
  channel_fault_reason?: string;
  has_client_secret: boolean;
  last_error?: string;
  created_at?: string;
}

export interface ActivitySinkListOutput {
  rows: ActivitySinkRow[];
}

/* ---- comm_log.list (Comm Log screen) ------------------------------------- */

export interface CommLogRow {
  id: string;
  channel_id?: string;
  channel_name?: string;
  kind: string;
  detail?: unknown;
  at: string;
}

export interface CommLogListOutput {
  rows: CommLogRow[];
}

/* ---- person.create (Contacts create) ------------------------------------- */

/**
 * The Contacts create dialog tier axis. Maps to a `person_kind` server-side:
 *   - contact  → kind 'contact'  (inbound-only)
 *   - assignee → kind 'member'   (assignable, no login)
 *   - user     → kind 'member' + a provisioned `user_account` (email REQUIRED).
 */
export type PersonTier = 'contact' | 'assignee' | 'user';

export interface PersonCreateInput {
  title: string;
  email?: string;
  tier: PersonTier;
}

export interface PersonCreateOutput {
  /** The new person card id (wire string → bigint). */
  personCardId: bigint;
  /** The provisioned user_account id when tier='user', else 0n. */
  userAccountId: bigint;
}

/* ---- person.grant_account (promote an existing person to a user) --------- */

export interface PersonGrantAccountInput {
  personCardId: bigint | string;
  /** Email override; when blank the person's stored email is used (one required). */
  email?: string;
}
export interface PersonGrantAccountOutput {
  /** The linked (new or pre-existing) user_account id. */
  userAccountId: bigint;
}

/* ---- user_role.set / user_role.revoke (Users role assign/revoke) --------- */

export interface UserRoleSetInput {
  userId: bigint | string;
  roleName: string;
  /** Optional project scope; blank/omitted → a global grant. The admin form
   *  threads a string (the entered project card id) through the data layer. */
  scopeProjectId?: bigint | string;
}
export interface UserRoleSetOutput {
  ok: boolean;
  userRoleId: bigint;
}

export interface UserRoleRevokeInput {
  userId: bigint | string;
  roleName: string;
  scopeProjectId?: bigint | string;
}
export interface UserRoleRevokeOutput {
  ok: boolean;
  deleted: number;
}

/* ---- user.unlink_person (Users unlink) ----------------------------------- */

export interface UserUnlinkPersonInput {
  userAccountId: bigint | string;
}
export interface UserUnlinkPersonOutput {
  deleted: boolean;
}

/* ---- card_type.select (edge matrix axis) --------------------------------- */

export interface CardTypeRow {
  id: string;
  name: string;
  parent_card_type_id?: string;
  allow_self_parent: boolean;
  is_built_in: boolean;
}
export interface CardTypeListOutput {
  rows: CardTypeRow[];
}

/* ---- flow_step.list / set / delete (transition editor) ------------------- */

export interface FlowStepRow {
  id: string;
  flow_id: string;
  from_card_id: string;
  to_card_id: string;
  label: string;
  requires_role_id: string;
  requires_role_name: string;
  sort_order: number;
}
export interface FlowStepListInput {
  flowId: bigint | string;
}
export interface FlowStepListOutput {
  rows: FlowStepRow[];
}

export interface FlowStepSetInput {
  /** Omit / 0 to insert; >0 updates by id. */
  id?: bigint | string;
  flowId: bigint | string;
  fromCardId: bigint | string;
  toCardId: bigint | string;
  label: string;
  requiresRoleId?: bigint | string;
  sortOrder?: number;
}
export interface FlowStepSetOutput {
  id: string;
}

export interface FlowStepDeleteInput {
  flowStepId: bigint | string;
}
export interface FlowStepDeleteOutput {
  ok: boolean;
  deleted: number;
}

/* ---- flow.preview_delete / flow.delete (flow delete guard) --------------- */

export interface FlowPreviewDeleteInput {
  flowId: bigint | string;
}
export interface FlowPreviewDeleteOutput {
  flow_id: string;
  flow_name: string;
  step_count: number;
  tasks_currently_in_flow_states: number;
  tasks_by_phase: { triage: number; active: number; terminal: number };
  sample_step_labels: string[];
}

/** flow.set — upsert a flow row (id absent/0 inserts; id>0 updates/renames). */
export interface FlowSetInput {
  id?: bigint | string;
  name: string;
  doc?: string;
  attributeDefId: bigint | string;
  scopeCardId: bigint | string;
  defaultCreateStatusId?: bigint | string;
}
export interface FlowSetOutput {
  id: string;
}

export interface FlowDeleteInput {
  flowId: bigint | string;
}
export interface FlowStepBlocker {
  flow_step_id: string;
  label: string;
}
export interface FlowDeleteOutput {
  ok: boolean;
  deleted: number;
}

/* ---- edge.insert / edge.delete (attribute edge matrix) ------------------- */

export interface EdgeInsertInput {
  attributeDefId: bigint | string;
  cardTypeId: bigint | string;
  isRequired?: boolean;
  ordering?: number;
}
export interface EdgeInsertOutput {
  ok: boolean;
}
export interface EdgeDeleteInput {
  attributeDefId: bigint | string;
  cardTypeId: bigint | string;
}
export interface EdgeDeleteOutput {
  ok: boolean;
  /** >0 when the delete was soft-refused (attribute_value rows still in use). */
  usageCount?: number;
}

/* ---- attribute_def.insert (create attribute_def) ------------------------- */

export interface AttributeDefBindInput {
  cardTypeId: bigint | string;
  isRequired?: boolean;
  ordering?: number;
}
export interface AttributeDefInsertInput {
  name: string;
  valueType: string;
  /** For card_ref / card_ref[] value types: the target card_type NAME whose
   *  cards are the valid values (e.g. 'milestone'). Ignored for scalar types. */
  targetCardType?: string;
  bindTo?: AttributeDefBindInput[];
}
export interface AttributeDefInsertOutput {
  id: string;
}

/* ---- comm_channel.set (Comm Channels config + write-only passwords) ------ */

/**
 * The comm_channel.set wire payload. Secret fields use the OMIT-vs-CLEAR
 * distinction the server reads: a missing key preserves the stored cipher
 * (`imap_password === undefined` → omit), a present empty string clears it.
 * The screen only ever omits — passwords are never echoed back, so the form
 * field starts blank and a field is sent ONLY when the user typed a new value.
 */
export interface CommChannelSetInput {
  /** 0 / omitted → insert; >0 → update by id. */
  id?: bigint | string;
  projectId: bigint | string;
  name: string;
  channelType: string;
  imapHost?: string;
  imapPort?: number;
  imapUsername?: string;
  /** Write-only — omit to preserve the stored value (never echoed on list). */
  imapPassword?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUsername?: string;
  /** Write-only — omit to preserve the stored value. */
  smtpPassword?: string;
  fromAddress?: string;
  intakeStatusId?: bigint | string;
  channelStatus?: string;
}
export interface CommChannelSetOutput {
  channelId: string;
}

/* ---- activity_sink.set (Activity Sinks config + secret + filter) --------- */

export interface ActivitySinkSetInput {
  id?: bigint | string;
  projectId: bigint | string;
  name: string;
  sinkKind: string;
  msgraphTenantId?: string;
  msgraphClientId?: string;
  /** Write-only — omit to preserve the stored value (never echoed on list). */
  msgraphClientSecret?: string;
  msgraphTeamId?: string;
  msgraphChannelId?: string;
  /** The activity-filter predicate JSON string ('' → match every row). */
  activityFilter?: string;
  channelStatus?: string;
}
export interface ActivitySinkSetOutput {
  sinkId: string;
}

/* ---- agent.create / agent.delete (Agents) -------------------------------- */

export interface AgentCreateInput {
  displayName: string;
}
export interface AgentCreateOutput {
  userId: string;
}
export interface AgentDeleteInput {
  userId: bigint | string;
}
export interface AgentDeleteOutput {
  ok: boolean;
  deleted: number;
}

/* ---- user_token.list / create / revoke (Agent tokens) -------------------- */

export interface UserTokenRow {
  label: string;
  created_at: string;
  last_used_at: string;
  expires_at?: string;
  revoked_at?: string;
}
export interface UserTokenListInput {
  userId: bigint | string;
}
export interface UserTokenListOutput {
  rows: UserTokenRow[];
}
export interface UserTokenCreateInput {
  userId: bigint | string;
  label: string;
  expiresAt?: string;
}
export interface UserTokenCreateOutput {
  /** The opaque secret — surfaced ONCE on this call; the server can't recover it. */
  token: string;
  label: string;
}
export interface UserTokenRevokeInput {
  userId: bigint | string;
  label: string;
}
export interface UserTokenRevokeOutput {
  ok: boolean;
  deleted: number;
}

/* ---- role_mapping.list / set / delete (Roles claim→role mapping) --------- */

export interface RoleMappingRow {
  claim_value: string;
  role_id: string;
  role_name: string;
}
export interface RoleMappingListOutput {
  rows: RoleMappingRow[];
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

/* -------------------------------------------------------------------------- */
/* Decode helpers.                                                             */
/* -------------------------------------------------------------------------- */

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (v === null || v === undefined) return '';
  return String(v);
}
function asStrOpt(v: unknown): string | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  return asStr(v);
}
function asBool(v: unknown): boolean {
  return v === true;
}
/** Coerce a wire id (bigint after revival, or number/string) to bigint. */
function asId(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
}
function asNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v);
  return 0;
}
function asNumOpt(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function decodeRole(j: Record<string, unknown>): UserRoleAssignment {
  const out: UserRoleAssignment = { role_name: asStr(j['role_name']) };
  const sid = asStrOpt(j['scope_project_id']);
  if (sid !== undefined) out.scope_project_id = sid;
  const stitle = asStrOpt(j['scope_project_title']);
  if (stitle !== undefined) out.scope_project_title = stitle;
  return out;
}

function decodeUserRow(j: Record<string, unknown>): UserRow {
  const out: UserRow = {
    id: asStr(j['id']),
    display_name: asStr(j['display_name']),
    is_agent: j['is_agent'] === true,
    roles: asArray(j['roles']).map((r) => decodeRole(asObj(r))),
  };
  const email = asStrOpt(j['email']);
  if (email !== undefined) out.email = email;
  const oidc = asStrOpt(j['oidc_sub']);
  if (oidc !== undefined) out.oidc_sub = oidc;
  const parent = asStrOpt(j['parent_user_id']);
  if (parent !== undefined) out.parent_user_id = parent;
  const parentName = asStrOpt(j['parent_user_name']);
  if (parentName !== undefined) out.parent_user_name = parentName;
  const person = asStrOpt(j['person_card_id']);
  if (person !== undefined) out.person_card_id = person;
  return out;
}

function decodeAttributeDefBound(j: Record<string, unknown>): AttributeDefBoundCardType {
  const out: AttributeDefBoundCardType = {
    card_type_id: asStr(j['card_type_id']),
    card_type_name: asStr(j['card_type_name']),
  };
  if (j['is_required'] !== undefined) out.is_required = asBool(j['is_required']);
  if (j['is_built_in'] !== undefined) out.is_built_in = asBool(j['is_built_in']);
  const ord = asNumOpt(j['ordering']);
  if (ord !== undefined) out.ordering = ord;
  return out;
}

function decodeAttributeDefRow(j: Record<string, unknown>): AttributeDefRow {
  const out: AttributeDefRow = {
    id: asStr(j['id']),
    name: asStr(j['name']),
    value_type: asStr(j['value_type']),
    is_built_in: asBool(j['is_built_in']),
    enum_managed: asBool(j['enum_managed']),
    bound_to: asArray(j['bound_to']).map((b) => decodeAttributeDefBound(asObj(b))),
  };
  const tgt = asStrOpt(j['target_card_type_name']);
  if (tgt !== undefined) out.target_card_type_name = tgt;
  return out;
}

function decodeFlowRow(j: Record<string, unknown>): FlowRow {
  const out: FlowRow = { id: asStr(j['id']), name: asStr(j['name']) };
  const doc = asStrOpt(j['doc']);
  if (doc !== undefined) out.doc = doc;
  const adid = asStrOpt(j['attribute_def_id']);
  if (adid !== undefined) out.attribute_def_id = adid;
  const adn = asStrOpt(j['attribute_def_name']);
  if (adn !== undefined) out.attribute_def_name = adn;
  const scope = asStrOpt(j['scope_card_id']);
  if (scope !== undefined) out.scope_card_id = scope;
  const scopeTitle = asStrOpt(j['scope_project_title']);
  if (scopeTitle !== undefined) out.scope_project_title = scopeTitle;
  const dcs = asStrOpt(j['default_create_status_id']);
  if (dcs !== undefined) out.default_create_status_id = dcs;
  const dcsName = asStrOpt(j['default_create_status_name']);
  if (dcsName !== undefined) out.default_create_status_name = dcsName;
  const at = asStrOpt(j['created_at']);
  if (at !== undefined) out.created_at = at;
  return out;
}

function decodeRoleGrant(j: Record<string, unknown>): RoleGrant {
  return { card_type: asStr(j['card_type']), process: asStr(j['process']) };
}

function decodeRoleRow(j: Record<string, unknown>): RoleRow {
  const out: RoleRow = {
    id: asStr(j['id']),
    name: asStr(j['name']),
    grants: asArray(j['grants']).map((g) => decodeRoleGrant(asObj(g))),
  };
  const doc = asStrOpt(j['doc']);
  if (doc !== undefined) out.doc = doc;
  return out;
}

function decodeSchedulerJob(j: Record<string, unknown>): SchedulerJobInfo {
  return {
    name: asStr(j['name']),
    description: asStr(j['description']),
    interval: asStr(j['interval']),
    timeout: asStr(j['timeout']),
    on_startup: asBool(j['on_startup']),
    offset: asStr(j['offset']),
    disabled: asBool(j['disabled']),
    success: asNum(j['success']),
    failure: asNum(j['failure']),
    last_run_at: asStr(j['last_run_at']),
    last_duration: asStr(j['last_duration']),
    last_error: asStr(j['last_error']),
  };
}

function decodeActivitySinkRow(j: Record<string, unknown>): ActivitySinkRow {
  const out: ActivitySinkRow = {
    id: asStr(j['id']),
    name: asStr(j['name']),
    sink_kind: asStr(j['sink_kind']),
    channel_status: asStr(j['channel_status']),
    has_client_secret: asBool(j['has_client_secret']),
  };
  const tenant = asStrOpt(j['msgraph_tenant_id']);
  if (tenant !== undefined) out.msgraph_tenant_id = tenant;
  const team = asStrOpt(j['msgraph_team_id']);
  if (team !== undefined) out.msgraph_team_id = team;
  const chan = asStrOpt(j['msgraph_channel_id']);
  if (chan !== undefined) out.msgraph_channel_id = chan;
  const fr = asStrOpt(j['channel_fault_reason']);
  if (fr !== undefined) out.channel_fault_reason = fr;
  const le = asStrOpt(j['last_error']);
  if (le !== undefined) out.last_error = le;
  const at = asStrOpt(j['created_at']);
  if (at !== undefined) out.created_at = at;
  return out;
}

function decodeCommLogRow(j: Record<string, unknown>): CommLogRow {
  const out: CommLogRow = { id: asStr(j['id']), kind: asStr(j['kind']), at: asStr(j['at']) };
  const cid = asStrOpt(j['channel_id']);
  if (cid !== undefined) out.channel_id = cid;
  const cn = asStrOpt(j['channel_name']);
  if (cn !== undefined) out.channel_name = cn;
  if (j['detail'] !== undefined && j['detail'] !== null) out.detail = j['detail'];
  return out;
}

function decodeCardTypeRow(j: Record<string, unknown>): CardTypeRow {
  const out: CardTypeRow = {
    id: asStr(j['id']),
    name: asStr(j['name']),
    allow_self_parent: asBool(j['allow_self_parent']),
    is_built_in: asBool(j['is_built_in']),
  };
  const p = asStrOpt(j['parent_card_type_id']);
  if (p !== undefined) out.parent_card_type_id = p;
  return out;
}

function decodeUserTokenRow(j: Record<string, unknown>): UserTokenRow {
  const out: UserTokenRow = {
    label: asStr(j['label']),
    created_at: asStr(j['created_at']),
    last_used_at: asStr(j['last_used_at']),
  };
  const exp = asStrOpt(j['expires_at']);
  if (exp !== undefined) out.expires_at = exp;
  const rev = asStrOpt(j['revoked_at']);
  if (rev !== undefined) out.revoked_at = rev;
  return out;
}

function decodeRoleMappingRow(j: Record<string, unknown>): RoleMappingRow {
  return {
    claim_value: asStr(j['claim_value']),
    role_id: asStr(j['role_id']),
    role_name: asStr(j['role_name']),
  };
}

function decodeFlowStepRow(j: Record<string, unknown>): FlowStepRow {
  return {
    id: asStr(j['id']),
    flow_id: asStr(j['flow_id']),
    from_card_id: asStr(j['from_card_id']),
    to_card_id: asStr(j['to_card_id']),
    label: asStr(j['label']),
    requires_role_id: asStr(j['requires_role_id']),
    requires_role_name: asStr(j['requires_role_name']),
    sort_order: asNum(j['sort_order']),
  };
}

/* -------------------------------------------------------------------------- */
/* Registration.                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Register the admin (user) specs against `api`. Call once at boot, BEFORE any
 * control mounts. `api.define` throws on a duplicate key, matching the kanban
 * specs' contract.
 */
export function registerAdminSpecs(api: Api): void {
  api.define<Record<string, never>, UserListOutput>({
    endpoint: 'user',
    action: 'list_with_roles',
    // No input fields; the server lists every non-agent user_account.
    encode: () => ({}),
    decode: (raw): UserListOutput => ({
      rows: asArray(asObj(raw)['rows']).map((r) => decodeUserRow(asObj(r))),
    }),
  });

  api.define<{ displayName?: string; isAgent?: boolean; parentUserId?: bigint | string }, UserListOutput>({
    endpoint: 'user',
    action: 'select',
    encode: (i) => {
      const m: Record<string, unknown> = {};
      if (i.displayName !== undefined) m['display_name'] = i.displayName;
      if (i.isAgent !== undefined) m['is_agent'] = i.isAgent;
      // Scope to a parent user's agents (the Inbox delegate picker passes the
      // signed-in user's id; the server filters user_account.parent_user_id).
      if (i.parentUserId !== undefined && i.parentUserId !== null && String(i.parentUserId) !== '') {
        m['parent_user_id'] = i.parentUserId;
      }
      return m;
    },
    decode: (raw): UserListOutput => ({
      rows: asArray(asObj(raw)['rows']).map((r) => decodeUserRow(asObj(r))),
    }),
  });

  // attribute_def.select — Attributes screen. No required input (full global
  // snapshot of every attribute_def with its bound card_types).
  api.define<Record<string, never>, AttributeDefListOutput>({
    endpoint: 'attribute_def',
    action: 'select',
    encode: () => ({}),
    decode: (raw): AttributeDefListOutput => ({
      rows: asArray(asObj(raw)['rows']).map((r) => decodeAttributeDefRow(asObj(r))),
    }),
  });

  // flow.list — Workflows screen. Optional scope/attribute filters; absent →
  // the full list across projects (admin view).
  api.define<{ scopeCardId?: string; attributeDefId?: string }, FlowListOutput>({
    endpoint: 'flow',
    action: 'list',
    encode: (i) => {
      const m: Record<string, unknown> = {};
      if (i.scopeCardId !== undefined) m['scope_card_id'] = i.scopeCardId;
      if (i.attributeDefId !== undefined) m['attribute_def_id'] = i.attributeDefId;
      return m;
    },
    decode: (raw): FlowListOutput => ({
      rows: asArray(asObj(raw)['rows']).map((r) => decodeFlowRow(asObj(r))),
    }),
  });

  // role.list — Roles screen. No input; lists every role with its grants.
  api.define<Record<string, never>, RoleListOutput>({
    endpoint: 'role',
    action: 'list',
    encode: () => ({}),
    decode: (raw): RoleListOutput => ({
      rows: asArray(asObj(raw)['rows']).map((r) => decodeRoleRow(asObj(r))),
    }),
  });

  // comm_channel.list — Comm Channels screen. project_id REQUIRED (channels are
  // project-scoped cards). Generic codec both ways: no field-by-field mapping
  // (the wire's has_*_password flags + ports + ids decode by convention).
  api.define<{ projectId?: string | bigint }, CommChannelListOutput>({
    endpoint: 'comm_channel',
    action: 'list',
    encode: (i) => encodeWire(i),
    decode: (raw) => decodeWire(raw) as CommChannelListOutput,
  });

  // activity_sink.list — Activity Sinks screen. project_id REQUIRED; same
  // scope-thread + idle-until-scope posture as comm_channel.list.
  api.define<{ projectId?: string | bigint }, ActivitySinkListOutput>({
    endpoint: 'activity_sink',
    action: 'list',
    encode: (i) => {
      const m: Record<string, unknown> = {};
      if (i.projectId !== undefined && i.projectId !== null) m['project_id'] = i.projectId;
      return m;
    },
    decode: (raw): ActivitySinkListOutput => ({
      rows: asArray(asObj(raw)['rows']).map((r) => decodeActivitySinkRow(asObj(r))),
    }),
  });

  // comm_log.list — Comm Log screen. project_id REQUIRED; the server defaults
  // the time window to 24h when `since` is omitted and caps the row count.
  api.define<{ projectId?: string | bigint; kind?: string; since?: string }, CommLogListOutput>({
    endpoint: 'comm_log',
    action: 'list',
    encode: (i) => {
      const m: Record<string, unknown> = {};
      if (i.projectId !== undefined && i.projectId !== null) m['project_id'] = i.projectId;
      if (i.kind !== undefined) m['kind'] = i.kind;
      if (i.since !== undefined) m['since'] = i.since;
      return m;
    },
    decode: (raw): CommLogListOutput => ({
      rows: asArray(asObj(raw)['rows']).map((r) => decodeCommLogRow(asObj(r))),
    }),
  });

  // scheduler.list — workspace Jobs screen. No input; admin-only. Returns
  // every hard-coded background job with its properties + last-run status.
  api.define<Record<string, never>, SchedulerListOutput>({
    endpoint: 'scheduler',
    action: 'list',
    encode: () => ({}),
    decode: (raw): SchedulerListOutput => ({
      jobs: asArray(asObj(raw)['jobs']).map((r) => decodeSchedulerJob(asObj(r))),
    }),
  });

  // scheduler.run — "run now" on the Jobs screen. Triggers one job by name
  // and returns its immediate outcome + the refreshed metrics row.
  api.define<{ name: string }, SchedulerRunOutput>({
    endpoint: 'scheduler',
    action: 'run',
    encode: (i) => ({ name: i.name }),
    decode: (raw): SchedulerRunOutput => {
      const j = asObj(raw);
      return {
        name: asStr(j['name']),
        started: asBool(j['started']),
        ok: asBool(j['ok']),
        error: asStr(j['error']),
        duration: asStr(j['duration']),
        ran_at: asStr(j['ran_at']),
        message: asStr(j['message']),
        job: decodeSchedulerJob(asObj(j['job'])),
      };
    },
  });

  /* ---- Write specs (create / role / unlink). Idempotent-by-presence so a
   *      double-register at boot is a no-op rather than a throw. ---- */

  // person.create — Contacts create. The tier (contact/assignee/user) rides on
  // the wire verbatim; the 'user' tier provisions a user_account server-side
  // (email required there). bigint ids on the wire revive via asId.
  if (!api.registry.has({ endpoint: 'person', action: 'create' })) {
    api.define<PersonCreateInput, PersonCreateOutput>({
      endpoint: 'person',
      action: 'create',
      encode: (i) => {
        const m: Record<string, unknown> = { title: i.title, tier: i.tier };
        if (i.email !== undefined && i.email !== '') m['email'] = i.email;
        return m;
      },
      decode: (raw): PersonCreateOutput => {
        const j = asObj(raw);
        return {
          personCardId: asId(j['person_card_id']),
          userAccountId: asId(j['user_account_id']),
        };
      },
    });
  }

  // person.grant_account — promote an existing person to a user (mint + link a
  // user_account). Idempotent server-side; email optional (falls back to the
  // person's stored email).
  if (!api.registry.has({ endpoint: 'person', action: 'grant_account' })) {
    api.define<PersonGrantAccountInput, PersonGrantAccountOutput>({
      endpoint: 'person',
      action: 'grant_account',
      encode: (i) => {
        const m: Record<string, unknown> = { person_card_id: i.personCardId };
        if (i.email !== undefined && i.email !== '') m['email'] = i.email;
        return m;
      },
      decode: (raw): PersonGrantAccountOutput => ({ userAccountId: asId(asObj(raw)['user_account_id']) }),
    });
  }

  // user_role.set — Users role assign (optionally project-scoped).
  if (!api.registry.has({ endpoint: 'user_role', action: 'set' })) {
    api.define<UserRoleSetInput, UserRoleSetOutput>({
      endpoint: 'user_role',
      action: 'set',
      encode: (i) => {
        const m: Record<string, unknown> = { user_id: i.userId, role_name: i.roleName };
        // An empty/blank scope (the optional scope field left blank) → a global
        // grant: omit the key entirely rather than send '' (the server NULLIFs
        // an empty string, but omitting keeps the wire honest).
        if (i.scopeProjectId !== undefined && String(i.scopeProjectId) !== '') {
          m['scope_project_id'] = i.scopeProjectId;
        }
        return m;
      },
      decode: (raw): UserRoleSetOutput => {
        const j = asObj(raw);
        return { ok: j['ok'] === true, userRoleId: asId(j['user_role_id']) };
      },
    });
  }

  // user_role.revoke — Users per-assigned-role Revoke (scope must match the
  // grant: NULL clears the global grant, a project id clears that scoped one).
  if (!api.registry.has({ endpoint: 'user_role', action: 'revoke' })) {
    api.define<UserRoleRevokeInput, UserRoleRevokeOutput>({
      endpoint: 'user_role',
      action: 'revoke',
      encode: (i) => {
        const m: Record<string, unknown> = { user_id: i.userId, role_name: i.roleName };
        if (i.scopeProjectId !== undefined && String(i.scopeProjectId) !== '') {
          m['scope_project_id'] = i.scopeProjectId;
        }
        return m;
      },
      decode: (raw): UserRoleRevokeOutput => {
        const j = asObj(raw);
        return { ok: j['ok'] === true, deleted: asNum(j['deleted']) };
      },
    });
  }

  // user.unlink_person — Users unlink the linked person card. Idempotent
  // server-side (an absent link returns deleted=false, not an error).
  if (!api.registry.has({ endpoint: 'user', action: 'unlink_person' })) {
    api.define<UserUnlinkPersonInput, UserUnlinkPersonOutput>({
      endpoint: 'user',
      action: 'unlink_person',
      encode: (i) => ({ user_account_id: i.userAccountId }),
      decode: (raw): UserUnlinkPersonOutput => ({ deleted: asObj(raw)['deleted'] === true }),
    });
  }

  /* ---- Nested-editor specs (flow-step transitions, edge matrix, defs). ---- */

  // card_type.select — the edge matrix axis (every card_type). Global reference
  // data; no input fields.
  if (!api.registry.has({ endpoint: 'card_type', action: 'select' })) {
    api.define<Record<string, never>, CardTypeListOutput>({
      endpoint: 'card_type',
      action: 'select',
      encode: () => ({}),
      decode: (raw): CardTypeListOutput => ({
        rows: asArray(asObj(raw)['rows']).map((r) => decodeCardTypeRow(asObj(r))),
      }),
    });
  }

  // flow_step.list — the selected flow's transition rows (grouped by `from`
  // client-side). flow_id REQUIRED.
  if (!api.registry.has({ endpoint: 'flow_step', action: 'list' })) {
    api.define<FlowStepListInput, FlowStepListOutput>({
      endpoint: 'flow_step',
      action: 'list',
      encode: (i) => ({ flow_id: i.flowId }),
      decode: (raw): FlowStepListOutput => ({
        rows: asArray(asObj(raw)['rows']).map((r) => decodeFlowStepRow(asObj(r))),
      }),
    });
  }

  // flow_step.set — upsert one transition (id omitted / 0 = insert). A 0
  // requires_role_id / empty scope means "any authenticated user"; omit it.
  if (!api.registry.has({ endpoint: 'flow_step', action: 'set' })) {
    api.define<FlowStepSetInput, FlowStepSetOutput>({
      endpoint: 'flow_step',
      action: 'set',
      encode: (i) => {
        const m: Record<string, unknown> = {
          flow_id: i.flowId,
          from_card_id: i.fromCardId,
          to_card_id: i.toCardId,
          label: i.label,
          sort_order: i.sortOrder ?? 0,
        };
        if (i.id !== undefined && String(i.id) !== '' && String(i.id) !== '0') m['id'] = i.id;
        if (i.requiresRoleId !== undefined && String(i.requiresRoleId) !== '' && String(i.requiresRoleId) !== '0') {
          m['requires_role_id'] = i.requiresRoleId;
        }
        return m;
      },
      decode: (raw): FlowStepSetOutput => ({ id: asStr(asObj(raw)['id']) }),
    });
  }

  // flow_step.delete — remove one transition by id.
  if (!api.registry.has({ endpoint: 'flow_step', action: 'delete' })) {
    api.define<FlowStepDeleteInput, FlowStepDeleteOutput>({
      endpoint: 'flow_step',
      action: 'delete',
      encode: (i) => ({ flow_step_id: i.flowStepId }),
      decode: (raw): FlowStepDeleteOutput => {
        const j = asObj(raw);
        return { ok: j['ok'] === true, deleted: asNum(j['deleted']) };
      },
    });
  }

  // flow.preview_delete — read-shaped dry run for the flow-delete guard. Returns
  // the step count + affected-task counts + sample labels.
  if (!api.registry.has({ endpoint: 'flow', action: 'preview_delete' })) {
    api.define<FlowPreviewDeleteInput, FlowPreviewDeleteOutput>({
      endpoint: 'flow',
      action: 'preview_delete',
      encode: (i) => ({ flow_id: i.flowId }),
      decode: (raw): FlowPreviewDeleteOutput => {
        const j = asObj(raw);
        const ph = asObj(j['tasks_by_phase']);
        return {
          flow_id: asStr(j['flow_id']),
          flow_name: asStr(j['flow_name']),
          step_count: asNum(j['step_count']),
          tasks_currently_in_flow_states: asNum(j['tasks_currently_in_flow_states']),
          tasks_by_phase: {
            triage: asNum(ph['triage']),
            active: asNum(ph['active']),
            terminal: asNum(ph['terminal']),
          },
          sample_step_labels: asArray(j['sample_step_labels']).map((s) => asStr(s)),
        };
      },
    });
  }

  // flow.delete — destructive; the dispatcher copies a `flow_disallowed` row's
  // blocker payload into the fault's `detail`, so the editor can show them.
  if (!api.registry.has({ endpoint: 'flow', action: 'delete' })) {
    api.define<FlowDeleteInput, FlowDeleteOutput>({
      endpoint: 'flow',
      action: 'delete',
      encode: (i) => ({ flow_id: i.flowId }),
      decode: (raw): FlowDeleteOutput => {
        const j = asObj(raw);
        return { ok: j['ok'] === true, deleted: asNum(j['deleted']) };
      },
    });
  }

  // flow.set — upsert a flow (create when id is absent; rename/update when set).
  // ids may arrive as form strings, so they pass through verbatim (the wire is
  // json:",string" anyway).
  if (!api.registry.has({ endpoint: 'flow', action: 'set' })) {
    api.define<FlowSetInput, FlowSetOutput>({
      endpoint: 'flow',
      action: 'set',
      encode: (i) => {
        const m: Record<string, unknown> = {
          name: i.name,
          attribute_def_id: i.attributeDefId,
          scope_card_id: i.scopeCardId,
        };
        if (i.id !== undefined && String(i.id) !== '' && String(i.id) !== '0') m['id'] = i.id;
        if (i.doc !== undefined && i.doc !== '') m['doc'] = i.doc;
        if (i.defaultCreateStatusId !== undefined && String(i.defaultCreateStatusId) !== '0') {
          m['default_create_status_id'] = i.defaultCreateStatusId;
        }
        return m;
      },
      decode: (raw): FlowSetOutput => ({ id: asStr(asObj(raw)['id']) }),
    });
  }

  // edge.insert — bind an attribute_def to a card_type (idempotent server-side).
  if (!api.registry.has({ endpoint: 'edge', action: 'insert' })) {
    api.define<EdgeInsertInput, EdgeInsertOutput>({
      endpoint: 'edge',
      action: 'insert',
      encode: (i) => {
        const m: Record<string, unknown> = {
          attribute_def_id: i.attributeDefId,
          card_type_id: i.cardTypeId,
        };
        if (i.isRequired !== undefined) m['is_required'] = i.isRequired;
        if (i.ordering !== undefined) m['ordering'] = i.ordering;
        return m;
      },
      decode: (raw): EdgeInsertOutput => ({ ok: asObj(raw)['ok'] === true }),
    });
  }

  // edge.delete — unbind. A `usage_count` in the (ok=true) result is a SOFT
  // refusal: attribute_value rows still reference the (card_type, def) pair.
  if (!api.registry.has({ endpoint: 'edge', action: 'delete' })) {
    api.define<EdgeDeleteInput, EdgeDeleteOutput>({
      endpoint: 'edge',
      action: 'delete',
      encode: (i) => ({ attribute_def_id: i.attributeDefId, card_type_id: i.cardTypeId }),
      decode: (raw): EdgeDeleteOutput => {
        const j = asObj(raw);
        const out: EdgeDeleteOutput = { ok: j['ok'] === true };
        const uc = asNumOpt(j['usage_count']);
        if (uc !== undefined) out.usageCount = uc;
        return out;
      },
    });
  }

  // attribute_def.insert — create a custom attribute_def with optional initial
  // edges. is_built_in is always false (only migrations install built-ins).
  if (!api.registry.has({ endpoint: 'attribute_def', action: 'insert' })) {
    api.define<AttributeDefInsertInput, AttributeDefInsertOutput>({
      endpoint: 'attribute_def',
      action: 'insert',
      encode: (i) => {
        const m: Record<string, unknown> = { name: i.name, value_type: i.valueType };
        // Only meaningful for card_ref value types; harmless (server-ignored) otherwise.
        if (i.targetCardType !== undefined && i.targetCardType !== '') {
          m['target_card_type'] = i.targetCardType;
        }
        if (i.bindTo !== undefined && i.bindTo.length > 0) {
          m['bind_to'] = i.bindTo.map((b) => {
            const e: Record<string, unknown> = { card_type_id: b.cardTypeId };
            if (b.isRequired !== undefined) e['is_required'] = b.isRequired;
            if (b.ordering !== undefined) e['ordering'] = b.ordering;
            return e;
          });
        }
        return m;
      },
      decode: (raw): AttributeDefInsertOutput => ({ id: asStr(asObj(raw)['id']) }),
    });
  }

  /* ---- Comm-channel + activity-sink config writes (write-only secrets). --- */

  // comm_channel.set — Comm Channels config. Generic codec: the caller passes a
  // camelCase input containing ONLY the fields to write (the draft→input mapper
  // applies the omit rules — password omitted unless typed, id/intake omitted
  // when 0/''), and encodeWire drops undefined + converts keys. A key absent
  // from the wire preserves the stored value server-side (PATCH semantics).
  if (!api.registry.has({ endpoint: 'comm_channel', action: 'set' })) {
    api.define<CommChannelSetInput, CommChannelSetOutput>({
      endpoint: 'comm_channel',
      action: 'set',
      encode: (i) => encodeWire(i),
      decode: (raw) => decodeWire(raw) as CommChannelSetOutput,
    });
  }

  // activity_sink.set — Activity Sinks config. Same write-only secret rule for
  // msgraph_client_secret (omit → preserve), plus the activity_filter JSON.
  if (!api.registry.has({ endpoint: 'activity_sink', action: 'set' })) {
    api.define<ActivitySinkSetInput, ActivitySinkSetOutput>({
      endpoint: 'activity_sink',
      action: 'set',
      encode: (i) => {
        const m: Record<string, unknown> = {
          project_id: i.projectId,
          name: i.name,
          sink_kind: i.sinkKind,
        };
        if (i.id !== undefined && String(i.id) !== '' && String(i.id) !== '0') m['id'] = i.id;
        if (i.msgraphTenantId !== undefined) m['msgraph_tenant_id'] = i.msgraphTenantId;
        if (i.msgraphClientId !== undefined) m['msgraph_client_id'] = i.msgraphClientId;
        if (i.msgraphTeamId !== undefined) m['msgraph_team_id'] = i.msgraphTeamId;
        if (i.msgraphChannelId !== undefined) m['msgraph_channel_id'] = i.msgraphChannelId;
        if (i.activityFilter !== undefined) m['activity_filter'] = i.activityFilter;
        if (i.channelStatus !== undefined && i.channelStatus !== '') m['channel_status'] = i.channelStatus;
        // Write-only secret: send the key only when typed.
        if (i.msgraphClientSecret !== undefined) m['msgraph_client_secret'] = i.msgraphClientSecret;
        return m;
      },
      decode: (raw): ActivitySinkSetOutput => ({ sinkId: asStr(asObj(raw)['sink_id']) }),
    });
  }

  /* ---- Agents: create / delete. ------------------------------------------- */

  if (!api.registry.has({ endpoint: 'agent', action: 'create' })) {
    api.define<AgentCreateInput, AgentCreateOutput>({
      endpoint: 'agent',
      action: 'create',
      encode: (i) => ({ display_name: i.displayName }),
      decode: (raw): AgentCreateOutput => ({ userId: asStr(asObj(raw)['user_id']) }),
    });
  }

  if (!api.registry.has({ endpoint: 'agent', action: 'delete' })) {
    api.define<AgentDeleteInput, AgentDeleteOutput>({
      endpoint: 'agent',
      action: 'delete',
      encode: (i) => ({ user_id: i.userId }),
      decode: (raw): AgentDeleteOutput => {
        const j = asObj(raw);
        return { ok: j['ok'] === true, deleted: asNum(j['deleted']) };
      },
    });
  }

  /* ---- Agent tokens: list (labels+timestamps), create (secret once), revoke. */

  if (!api.registry.has({ endpoint: 'user_token', action: 'list' })) {
    api.define<UserTokenListInput, UserTokenListOutput>({
      endpoint: 'user_token',
      action: 'list',
      encode: (i) => ({ user_id: i.userId }),
      decode: (raw): UserTokenListOutput => ({
        rows: asArray(asObj(raw)['rows']).map((r) => decodeUserTokenRow(asObj(r))),
      }),
    });
  }

  if (!api.registry.has({ endpoint: 'user_token', action: 'create' })) {
    api.define<UserTokenCreateInput, UserTokenCreateOutput>({
      endpoint: 'user_token',
      action: 'create',
      encode: (i) => {
        const m: Record<string, unknown> = { user_id: i.userId, label: i.label };
        if (i.expiresAt !== undefined && i.expiresAt !== '') m['expires_at'] = i.expiresAt;
        return m;
      },
      decode: (raw): UserTokenCreateOutput => {
        const j = asObj(raw);
        return { token: asStr(j['token']), label: asStr(j['label']) };
      },
    });
  }

  if (!api.registry.has({ endpoint: 'user_token', action: 'revoke' })) {
    api.define<UserTokenRevokeInput, UserTokenRevokeOutput>({
      endpoint: 'user_token',
      action: 'revoke',
      encode: (i) => ({ user_id: i.userId, label: i.label }),
      decode: (raw): UserTokenRevokeOutput => {
        const j = asObj(raw);
        return { ok: j['ok'] === true, deleted: asNum(j['deleted']) };
      },
    });
  }

  /* ---- Role mappings: list / set / delete (claim_value → role). ----------- */

  if (!api.registry.has({ endpoint: 'role_mapping', action: 'list' })) {
    api.define<Record<string, never>, RoleMappingListOutput>({
      endpoint: 'role_mapping',
      action: 'list',
      encode: () => ({}),
      decode: (raw): RoleMappingListOutput => ({
        rows: asArray(asObj(raw)['rows']).map((r) => decodeRoleMappingRow(asObj(r))),
      }),
    });
  }

  if (!api.registry.has({ endpoint: 'role_mapping', action: 'set' })) {
    api.define<RoleMappingSetInput, RoleMappingSetOutput>({
      endpoint: 'role_mapping',
      action: 'set',
      encode: (i) => ({ claim_value: i.claimValue, role_name: i.roleName }),
      decode: (raw): RoleMappingSetOutput => ({ ok: asObj(raw)['ok'] === true }),
    });
  }

  if (!api.registry.has({ endpoint: 'role_mapping', action: 'delete' })) {
    api.define<RoleMappingDeleteInput, RoleMappingDeleteOutput>({
      endpoint: 'role_mapping',
      action: 'delete',
      encode: (i) => ({ claim_value: i.claimValue }),
      decode: (raw): RoleMappingDeleteOutput => {
        const j = asObj(raw);
        return { ok: j['ok'] === true, deleted: asNum(j['deleted']) };
      },
    });
  }
}
