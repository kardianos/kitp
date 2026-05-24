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
 *       out: { rows: [{ id, display_name, parent_user_id?, is_agent }] }
 *            — the lighter read, registered as a simpler fallback.
 *
 * The decoders pass the decoded rows through near-verbatim (the MasterDetail
 * field accessors read dotted paths off the raw row), only normalising the id
 * to a string and defaulting the roles array so the badges field never sees
 * undefined.
 */

import type { Api } from '../core/api.js';

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
  default_create_status_id?: string;
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

export interface CommChannelRow {
  id: string;
  name: string;
  channel_type: string;
  imap_host?: string;
  smtp_host?: string;
  from_address?: string;
  channel_status: string;
  channel_fault_reason?: string;
  has_imap_password: boolean;
  has_smtp_password: boolean;
  created_at?: string;
}

export interface CommChannelListOutput {
  rows: CommChannelRow[];
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
  const dcs = asStrOpt(j['default_create_status_id']);
  if (dcs !== undefined) out.default_create_status_id = dcs;
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

function decodeCommChannelRow(j: Record<string, unknown>): CommChannelRow {
  const out: CommChannelRow = {
    id: asStr(j['id']),
    name: asStr(j['name']),
    channel_type: asStr(j['channel_type']),
    channel_status: asStr(j['channel_status']),
    has_imap_password: asBool(j['has_imap_password']),
    has_smtp_password: asBool(j['has_smtp_password']),
  };
  const ih = asStrOpt(j['imap_host']);
  if (ih !== undefined) out.imap_host = ih;
  const sh = asStrOpt(j['smtp_host']);
  if (sh !== undefined) out.smtp_host = sh;
  const fa = asStrOpt(j['from_address']);
  if (fa !== undefined) out.from_address = fa;
  const fr = asStrOpt(j['channel_fault_reason']);
  if (fr !== undefined) out.channel_fault_reason = fr;
  const at = asStrOpt(j['created_at']);
  if (at !== undefined) out.created_at = at;
  return out;
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

  api.define<{ displayName?: string; isAgent?: boolean }, UserListOutput>({
    endpoint: 'user',
    action: 'select',
    encode: (i) => {
      const m: Record<string, unknown> = {};
      if (i.displayName !== undefined) m['display_name'] = i.displayName;
      if (i.isAgent !== undefined) m['is_agent'] = i.isAgent;
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
  // project-scoped cards), so the screen threads `{ from: 'scope.projectId' }`
  // and stays idle until the shared project scope resolves. Secrets are NOT in
  // the wire shape (only has_*_password flags), so nothing sensitive surfaces.
  api.define<{ projectId?: string | bigint }, CommChannelListOutput>({
    endpoint: 'comm_channel',
    action: 'list',
    encode: (i) => {
      const m: Record<string, unknown> = {};
      if (i.projectId !== undefined && i.projectId !== null) m['project_id'] = i.projectId;
      return m;
    },
    decode: (raw): CommChannelListOutput => ({
      rows: asArray(asObj(raw)['rows']).map((r) => decodeCommChannelRow(asObj(r))),
    }),
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
}
