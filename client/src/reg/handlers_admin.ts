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
  FlowDeleteInput,
  FlowDeleteOutput,
  FlowListInput,
  FlowListOutput,
  FlowPreviewDeleteInput,
  FlowPreviewDeleteOutput,
  FlowRow,
  FlowSetInput,
  FlowSetOutput,
  FlowStepDeleteInput,
  FlowStepDeleteOutput,
  FlowStepListInput,
  FlowStepListOutput,
  FlowStepRow,
  FlowStepSetInput,
  FlowStepSetOutput,
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
  UserRoleListInput,
  UserRoleListOutput,
  UserRoleListRow,
  UserRoleRevokeInput,
  UserRoleRevokeOutput,
  UserUnlinkPersonInput,
  UserUnlinkPersonOutput,
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
  // Server omits `person_card_id` when the user has no linked person card
  // (login-only account, agent). Surface as bigint when present so the
  // admin UI can render the "User" tier with a person-card cross-link.
  if (j.person_card_id !== undefined && j.person_card_id !== null) {
    out.person_card_id = asId(j.person_card_id);
  }
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

const userUnlinkPerson: HandlerSpec<UserUnlinkPersonInput, UserUnlinkPersonOutput> = {
  endpoint: 'user',
  action: 'unlink_person',
  encode: (i) => ({ user_account_id: i.userAccountId }),
  decode: (raw) => {
    const j = asObj(raw);
    return { deleted: asBoolOrFalse(j.deleted) };
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

const userRoleList: HandlerSpec<UserRoleListInput, UserRoleListOutput> = {
  endpoint: 'user_role',
  action: 'list',
  encode: (i) => ({ user_id: i.userId }),
  decode: (raw) => {
    const j = asObj(raw);
    const rawRows = Array.isArray(j.rows) ? j.rows : [];
    const rows: UserRoleListRow[] = rawRows.map((r) => {
      const o = asObj(r);
      const row: UserRoleListRow = {
        role_name: typeof o.role_name === 'string' ? o.role_name : '',
      };
      if (o.scope_project_id !== undefined && o.scope_project_id !== null) {
        row.scope_project_id = asIdOrZero(o.scope_project_id);
      }
      return row;
    });
    return { rows };
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
// flow.list / flow.set / flow.delete / flow.preview_delete
//
// Admin-only write paths for the per-attribute state machine (Gate 14 of
// FLOW_AND_SCREEN_KERNEL.md). The /admin/flows screen lets a project admin
// author transitions without writing SQL. Reads (`flow.list`) are open to
// any authenticated user.
// ============================================================================

function decodeFlowRow(j: Record<string, unknown>): FlowRow {
  return {
    id: asId(j.id),
    name: asStr(j.name),
    doc: asStrOrEmpty(j.doc),
    attribute_def_id: asId(j.attribute_def_id),
    attribute_def_name: asStrOrEmpty(j.attribute_def_name),
    scope_card_id: asId(j.scope_card_id),
    default_create_status_id: asIdOrZero(j.default_create_status_id),
    created_at: asStrOrEmpty(j.created_at),
  };
}

const flowList: HandlerSpec<FlowListInput, FlowListOutput> = {
  endpoint: 'flow',
  action: 'list',
  encode: (i) => {
    const m: Record<string, unknown> = {};
    if (i.scopeCardId !== undefined) m.scope_card_id = i.scopeCardId;
    if (i.attributeDefId !== undefined) m.attribute_def_id = i.attributeDefId;
    return m;
  },
  decode: (raw) => {
    const j = asObj(raw);
    return { rows: asArray(j.rows).map((r) => decodeFlowRow(asObj(r))) };
  },
};

const flowSet: HandlerSpec<FlowSetInput, FlowSetOutput> = {
  endpoint: 'flow',
  action: 'set',
  encode: (i) => {
    const m: Record<string, unknown> = {
      name: i.name,
      attribute_def_id: i.attributeDefId,
      scope_card_id: i.scopeCardId,
    };
    if (i.id !== undefined && i.id !== 0n) m.id = i.id;
    if (i.doc !== undefined && i.doc !== '') m.doc = i.doc;
    if (i.defaultCreateStatusId !== undefined && i.defaultCreateStatusId !== 0n) {
      m.default_create_status_id = i.defaultCreateStatusId;
    }
    return m;
  },
  decode: (raw) => {
    const j = asObj(raw);
    return { id: asId(j.id) };
  },
};

const flowDelete: HandlerSpec<FlowDeleteInput, FlowDeleteOutput> = {
  endpoint: 'flow',
  action: 'delete',
  encode: (i) => ({ flow_id: i.flowId }),
  decode: (raw) => {
    const j = asObj(raw);
    return {
      ok: asBoolOrFalse(j.ok),
      deleted: asNumOrZero(j.deleted),
    };
  },
};

const flowPreviewDelete: HandlerSpec<
  FlowPreviewDeleteInput,
  FlowPreviewDeleteOutput
> = {
  endpoint: 'flow',
  action: 'preview_delete',
  encode: (i) => ({ flow_id: i.flowId }),
  decode: (raw) => {
    const j = asObj(raw);
    const phaseRaw = j.tasks_by_phase;
    const phase = phaseRaw === null || phaseRaw === undefined ? {} : asObj(phaseRaw);
    return {
      flow_id: asId(j.flow_id),
      flow_name: asStrOrEmpty(j.flow_name),
      step_count: asNumOrZero(j.step_count),
      tasks_currently_in_flow_states: asNumOrZero(j.tasks_currently_in_flow_states),
      tasks_by_phase: {
        triage: asNumOrZero(phase.triage),
        active: asNumOrZero(phase.active),
        terminal: asNumOrZero(phase.terminal),
      },
      sample_step_labels: asArray(j.sample_step_labels).map((v) =>
        typeof v === 'string' ? v : '',
      ),
    };
  },
};

// ============================================================================
// flow_step.list / flow_step.set / flow_step.delete
// ============================================================================

function decodeFlowStepRow(j: Record<string, unknown>): FlowStepRow {
  return {
    id: asId(j.id),
    flow_id: asId(j.flow_id),
    from_card_id: asId(j.from_card_id),
    to_card_id: asId(j.to_card_id),
    label: asStrOrEmpty(j.label),
    requires_role_id: asIdOrZero(j.requires_role_id),
    requires_role_name: asStrOrEmpty(j.requires_role_name),
    sort_order: asNumOrZero(j.sort_order),
  };
}

const flowStepList: HandlerSpec<FlowStepListInput, FlowStepListOutput> = {
  endpoint: 'flow_step',
  action: 'list',
  encode: (i) => ({ flow_id: i.flowId }),
  decode: (raw) => {
    const j = asObj(raw);
    return { rows: asArray(j.rows).map((r) => decodeFlowStepRow(asObj(r))) };
  },
};

const flowStepSet: HandlerSpec<FlowStepSetInput, FlowStepSetOutput> = {
  endpoint: 'flow_step',
  action: 'set',
  encode: (i) => {
    const m: Record<string, unknown> = {
      flow_id: i.flowId,
      from_card_id: i.fromCardId,
      to_card_id: i.toCardId,
      label: i.label,
    };
    if (i.id !== undefined && i.id !== 0n) m.id = i.id;
    if (i.requiresRoleId !== undefined && i.requiresRoleId !== 0n) {
      m.requires_role_id = i.requiresRoleId;
    }
    if (i.sortOrder !== undefined && i.sortOrder !== 0) {
      m.sort_order = i.sortOrder;
    }
    return m;
  },
  decode: (raw) => {
    const j = asObj(raw);
    return { id: asId(j.id) };
  },
};

const flowStepDelete: HandlerSpec<FlowStepDeleteInput, FlowStepDeleteOutput> = {
  endpoint: 'flow_step',
  action: 'delete',
  encode: (i) => ({ flow_step_id: i.flowStepId }),
  decode: (raw) => {
    const j = asObj(raw);
    return {
      ok: asBoolOrFalse(j.ok),
      deleted: asNumOrZero(j.deleted),
    };
  },
};

// ============================================================================
// Re-exports + registration helper
// ============================================================================

export {
  userListWithRoles,
  userUnlinkPerson,
  roleList,
  userRoleSet,
  userRoleRevoke,
  userRoleList,
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
  flowList,
  flowSet,
  flowDelete,
  flowPreviewDelete,
  flowStepList,
  flowStepSet,
  flowStepDelete,
};

/** Register the admin handlers on top of the v1 set. */
export function registerAdminHandlers(r: HandlerRegistry): void {
  r.register(userListWithRoles);
  r.register(userUnlinkPerson);
  r.register(roleList);
  r.register(userRoleSet);
  r.register(userRoleRevoke);
  r.register(userRoleList);
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
  r.register(flowList);
  r.register(flowSet);
  r.register(flowDelete);
  r.register(flowPreviewDelete);
  r.register(flowStepList);
  r.register(flowStepSet);
  r.register(flowStepDelete);
}
