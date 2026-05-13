/**
 * Admin endpoint handlers: user.list_with_roles, role.list, user_role.set,
 * user_role.revoke, role_mapping.list/set/delete. Mirrors the Dart
 * `client/lib/reg/handlers_admin.dart`.
 */

import {
  asArray,
  asBoolOrFalse,
  asId,
  asIdOpt,
  asIdOrZero,
  asNumOrZero,
  asObj,
  asStr,
  asStrOpt,
  asStrOrEmpty,
} from './handlers.js';
import type { HandlerSpec } from './handler_registry.js';
import { HandlerRegistry } from './handler_registry.js';
import type {
  AgentCreateInput,
  AgentCreateOutput,
  AgentDeleteInput,
  AgentDeleteOutput,
  RoleAssignmentRow,
  RoleGrantRow,
  RoleListInput,
  RoleListOutput,
  RoleMappingDeleteInput,
  RoleMappingDeleteOutput,
  RoleMappingListInput,
  RoleMappingListOutput,
  RoleMappingListRow,
  RoleMappingSetInput,
  RoleMappingSetOutput,
  RoleRow,
  UserCardAgentClearInput,
  UserCardAgentClearOutput,
  UserCardAgentListInput,
  UserCardAgentListOutput,
  UserCardAgentListRow,
  UserCardAgentSetInput,
  UserCardAgentSetOutput,
  UserListWithRolesInput,
  UserListWithRolesOutput,
  UserListWithRolesRow,
  UserRoleRevokeInput,
  UserRoleRevokeOutput,
  UserRoleSetInput,
  UserRoleSetOutput,
  UserTokenCreateInput,
  UserTokenCreateOutput,
  UserTokenListInput,
  UserTokenListOutput,
  UserTokenListRow,
  UserTokenRevokeInput,
  UserTokenRevokeOutput,
} from './types.js';

// ============================================================================
// user.list_with_roles
// ============================================================================

function decodeRoleAssignmentRow(j: Record<string, unknown>): RoleAssignmentRow {
  const out: RoleAssignmentRow = {
    role_name: asStr(j.role_name),
  };
  const scopeId = asIdOpt(j.scope_project_id);
  if (scopeId !== undefined) out.scope_project_id = scopeId;
  const scopeTitle = asStrOpt(j.scope_project_title);
  if (scopeTitle !== undefined) out.scope_project_title = scopeTitle;
  return out;
}

function decodeUserListWithRolesRow(
  j: Record<string, unknown>,
): UserListWithRolesRow {
  const out: UserListWithRolesRow = {
    id: asId(j.id),
    display_name: asStr(j.display_name),
    roles: asArray(j.roles).map((r) => decodeRoleAssignmentRow(asObj(r))),
  };
  const email = asStrOpt(j.email);
  if (email !== undefined) out.email = email;
  const oidcSub = asStrOpt(j.oidc_sub);
  if (oidcSub !== undefined) out.oidc_sub = oidcSub;
  return out;
}

const userListWithRoles: HandlerSpec<
  UserListWithRolesInput,
  UserListWithRolesOutput
> = {
  endpoint: 'user',
  action: 'list_with_roles',
  encode: () => ({}),
  decode: (raw) => {
    const j = asObj(raw);
    return {
      rows: asArray(j.rows).map((r) => decodeUserListWithRolesRow(asObj(r))),
    };
  },
};

// ============================================================================
// role.list
// ============================================================================

function decodeRoleGrantRow(j: Record<string, unknown>): RoleGrantRow {
  return {
    card_type: asStr(j.card_type),
    process: asStr(j.process),
  };
}

function decodeRoleRow(j: Record<string, unknown>): RoleRow {
  return {
    id: asId(j.id),
    name: asStr(j.name),
    doc: asStrOrEmpty(j.doc),
    grants: asArray(j.grants).map((r) => decodeRoleGrantRow(asObj(r))),
  };
}

const roleList: HandlerSpec<RoleListInput, RoleListOutput> = {
  endpoint: 'role',
  action: 'list',
  encode: () => ({}),
  decode: (raw) => {
    const j = asObj(raw);
    return {
      rows: asArray(j.rows).map((r) => decodeRoleRow(asObj(r))),
    };
  },
};

// ============================================================================
// user_role.set / user_role.revoke
// ============================================================================

const userRoleSet: HandlerSpec<UserRoleSetInput, UserRoleSetOutput> = {
  endpoint: 'user_role',
  action: 'set',
  encode: (i) => {
    const m: Record<string, unknown> = {
      user_id: i.userId,
      role_name: i.roleName,
    };
    if (i.scopeProjectId !== undefined) m.scope_project_id = i.scopeProjectId;
    return m;
  },
  decode: (raw) => {
    const j = asObj(raw);
    return {
      ok: asBoolOrFalse(j.ok),
      user_role_id: asIdOrZero(j.user_role_id),
    };
  },
};

const userRoleRevoke: HandlerSpec<UserRoleRevokeInput, UserRoleRevokeOutput> = {
  endpoint: 'user_role',
  action: 'revoke',
  encode: (i) => {
    const m: Record<string, unknown> = {
      user_id: i.userId,
      role_name: i.roleName,
    };
    if (i.scopeProjectId !== undefined) m.scope_project_id = i.scopeProjectId;
    return m;
  },
  decode: (raw) => {
    const j = asObj(raw);
    return {
      ok: asBoolOrFalse(j.ok),
      deleted: asNumOrZero(j.deleted),
    };
  },
};

// ============================================================================
// role_mapping.list / set / delete
// ============================================================================

function decodeRoleMappingListRow(
  j: Record<string, unknown>,
): RoleMappingListRow {
  return {
    claim_value: asStr(j.claim_value),
    role_id: asId(j.role_id),
    role_name: asStr(j.role_name),
  };
}

const roleMappingList: HandlerSpec<RoleMappingListInput, RoleMappingListOutput> = {
  endpoint: 'role_mapping',
  action: 'list',
  encode: () => ({}),
  decode: (raw) => {
    const j = asObj(raw);
    return {
      rows: asArray(j.rows).map((r) => decodeRoleMappingListRow(asObj(r))),
    };
  },
};

const roleMappingSet: HandlerSpec<RoleMappingSetInput, RoleMappingSetOutput> = {
  endpoint: 'role_mapping',
  action: 'set',
  encode: (i) => ({ claim_value: i.claimValue, role_name: i.roleName }),
  decode: (raw) => {
    const j = asObj(raw);
    return { ok: asBoolOrFalse(j.ok) };
  },
};

const roleMappingDelete: HandlerSpec<
  RoleMappingDeleteInput,
  RoleMappingDeleteOutput
> = {
  endpoint: 'role_mapping',
  action: 'delete',
  encode: (i) => ({ claim_value: i.claimValue }),
  decode: (raw) => {
    const j = asObj(raw);
    return {
      ok: asBoolOrFalse(j.ok),
      deleted: asNumOrZero(j.deleted),
    };
  },
};

// ============================================================================
// agent.create / agent.delete
// ============================================================================

const agentCreate: HandlerSpec<AgentCreateInput, AgentCreateOutput> = {
  endpoint: 'agent',
  action: 'create',
  encode: (i) => ({ display_name: i.displayName }),
  decode: (raw) => {
    const j = asObj(raw);
    return {
      user_id: asId(j.user_id),
      person_card_id: asId(j.person_card_id),
    };
  },
};

const agentDelete: HandlerSpec<AgentDeleteInput, AgentDeleteOutput> = {
  endpoint: 'agent',
  action: 'delete',
  encode: (i) => ({ user_id: i.userId }),
  decode: (raw) => {
    const j = asObj(raw);
    return {
      ok: asBoolOrFalse(j.ok),
      deleted: asNumOrZero(j.deleted),
    };
  },
};

// ============================================================================
// user_token.create / list / revoke
// ============================================================================

const userTokenCreate: HandlerSpec<UserTokenCreateInput, UserTokenCreateOutput> = {
  endpoint: 'user_token',
  action: 'create',
  encode: (i) => {
    const m: Record<string, unknown> = { user_id: i.userId, label: i.label };
    if (i.expiresAt !== undefined) m.expires_at = i.expiresAt;
    return m;
  },
  decode: (raw) => {
    const j = asObj(raw);
    return { token: asStr(j.token), label: asStr(j.label) };
  },
};

function decodeUserTokenListRow(j: Record<string, unknown>): UserTokenListRow {
  const out: UserTokenListRow = {
    label: asStr(j.label),
    created_at: asStr(j.created_at),
    last_used_at: asStr(j.last_used_at),
  };
  const exp = asStrOpt(j.expires_at);
  if (exp !== undefined) out.expires_at = exp;
  const rev = asStrOpt(j.revoked_at);
  if (rev !== undefined) out.revoked_at = rev;
  return out;
}

const userTokenList: HandlerSpec<UserTokenListInput, UserTokenListOutput> = {
  endpoint: 'user_token',
  action: 'list',
  encode: (i) => ({ user_id: i.userId }),
  decode: (raw) => {
    const j = asObj(raw);
    return {
      rows: asArray(j.rows).map((r) => decodeUserTokenListRow(asObj(r))),
    };
  },
};

const userTokenRevoke: HandlerSpec<UserTokenRevokeInput, UserTokenRevokeOutput> = {
  endpoint: 'user_token',
  action: 'revoke',
  encode: (i) => ({ user_id: i.userId, label: i.label }),
  decode: (raw) => {
    const j = asObj(raw);
    return { ok: asBoolOrFalse(j.ok), deleted: asNumOrZero(j.deleted) };
  },
};

// ============================================================================
// user_card_agent.set / clear / list
// ============================================================================

const userCardAgentSet: HandlerSpec<UserCardAgentSetInput, UserCardAgentSetOutput> = {
  endpoint: 'user_card_agent',
  action: 'set',
  encode: (i) => ({ card_id: i.cardId, agent_user_id: i.agentUserId }),
  decode: (raw) => {
    const j = asObj(raw);
    return { ok: asBoolOrFalse(j.ok) };
  },
};

const userCardAgentClear: HandlerSpec<
  UserCardAgentClearInput,
  UserCardAgentClearOutput
> = {
  endpoint: 'user_card_agent',
  action: 'clear',
  encode: (i) => ({ card_id: i.cardId }),
  decode: (raw) => {
    const j = asObj(raw);
    return { ok: asBoolOrFalse(j.ok), deleted: asNumOrZero(j.deleted) };
  },
};

function decodeUserCardAgentListRow(j: Record<string, unknown>): UserCardAgentListRow {
  return {
    card_id: asId(j.card_id),
    agent_user_id: asId(j.agent_user_id),
    created_at: asStr(j.created_at),
  };
}

const userCardAgentList: HandlerSpec<UserCardAgentListInput, UserCardAgentListOutput> = {
  endpoint: 'user_card_agent',
  action: 'list',
  encode: (i) => {
    const m: Record<string, unknown> = {};
    if (i.parentCardId !== undefined) m.parent_card_id = i.parentCardId;
    return m;
  },
  decode: (raw) => {
    const j = asObj(raw);
    return {
      rows: asArray(j.rows).map((r) => decodeUserCardAgentListRow(asObj(r))),
    };
  },
};

// ============================================================================
// Re-exports + registration helper
// ============================================================================

export {
  userListWithRoles,
  roleList,
  userRoleSet,
  userRoleRevoke,
  roleMappingList,
  roleMappingSet,
  roleMappingDelete,
  agentCreate,
  agentDelete,
  userTokenCreate,
  userTokenList,
  userTokenRevoke,
  userCardAgentSet,
  userCardAgentClear,
  userCardAgentList,
};

/** Register the admin handlers on top of the v1 set. */
export function registerAdminHandlers(r: HandlerRegistry): void {
  r.register(userListWithRoles);
  r.register(roleList);
  r.register(userRoleSet);
  r.register(userRoleRevoke);
  r.register(roleMappingList);
  r.register(roleMappingSet);
  r.register(roleMappingDelete);
  r.register(agentCreate);
  r.register(agentDelete);
  r.register(userTokenCreate);
  r.register(userTokenList);
  r.register(userTokenRevoke);
  r.register(userCardAgentSet);
  r.register(userCardAgentClear);
  r.register(userCardAgentList);
}
