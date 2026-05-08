/**
 * Admin endpoint handlers: user.list_with_roles, role.list, user_role.set,
 * user_role.revoke, role_mapping.list/set/delete. Mirrors the Dart
 * `client/lib/reg/handlers_admin.dart`.
 */

import {
  asArray,
  asBoolOrFalse,
  asNum,
  asNumOpt,
  asNumOrZero,
  asObj,
  asStr,
  asStrOpt,
  asStrOrEmpty,
} from './handlers.js';
import type { HandlerSpec } from './handler_registry.js';
import { HandlerRegistry } from './handler_registry.js';
import type {
  ProjectTypeDeleteInput,
  ProjectTypeDeleteOutput,
  ProjectTypeInsertInput,
  ProjectTypeInsertOutput,
  ProjectTypeRow,
  ProjectTypeSelectInput,
  ProjectTypeSelectOutput,
  ProjectTypeUpdateInput,
  ProjectTypeUpdateOutput,
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
  UserListWithRolesInput,
  UserListWithRolesOutput,
  UserListWithRolesRow,
  UserRoleRevokeInput,
  UserRoleRevokeOutput,
  UserRoleSetInput,
  UserRoleSetOutput,
} from './types.js';

// ============================================================================
// user.list_with_roles
// ============================================================================

function decodeRoleAssignmentRow(j: Record<string, unknown>): RoleAssignmentRow {
  const out: RoleAssignmentRow = {
    role_name: asStr(j.role_name),
  };
  const scopeId = asNumOpt(j.scope_project_id);
  if (scopeId !== undefined) out.scope_project_id = scopeId;
  const scopeTitle = asStrOpt(j.scope_project_title);
  if (scopeTitle !== undefined) out.scope_project_title = scopeTitle;
  return out;
}

function decodeUserListWithRolesRow(
  j: Record<string, unknown>,
): UserListWithRolesRow {
  const out: UserListWithRolesRow = {
    id: asNum(j.id),
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
    id: asNum(j.id),
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
      user_role_id: asNumOrZero(j.user_role_id),
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
    role_id: asNum(j.role_id),
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
// project_type.* (admin)
// ============================================================================

function decodeProjectTypeRow(j: Record<string, unknown>): ProjectTypeRow {
  const out: ProjectTypeRow = {
    id: asNum(j.id),
    name: asStr(j.name),
    is_built_in: asBoolOrFalse(j.is_built_in),
    is_default: asBoolOrFalse(j.is_default),
  };
  const doc = asStrOpt(j.doc);
  if (doc !== undefined) out.doc = doc;
  return out;
}

const projectTypeSelect: HandlerSpec<
  ProjectTypeSelectInput,
  ProjectTypeSelectOutput
> = {
  endpoint: 'project_type',
  action: 'select',
  encode: () => ({}),
  decode: (raw) => {
    const j = asObj(raw);
    return {
      rows: asArray(j.rows).map((r) => decodeProjectTypeRow(asObj(r))),
    };
  },
};

const projectTypeInsert: HandlerSpec<
  ProjectTypeInsertInput,
  ProjectTypeInsertOutput
> = {
  endpoint: 'project_type',
  action: 'insert',
  encode: (i) => {
    const m: Record<string, unknown> = { name: i.name };
    if (i.doc !== undefined && i.doc !== '') m.doc = i.doc;
    if (i.isDefault === true) m.is_default = true;
    return m;
  },
  decode: (raw) => ({ id: asNum(asObj(raw).id) }),
};

const projectTypeUpdate: HandlerSpec<
  ProjectTypeUpdateInput,
  ProjectTypeUpdateOutput
> = {
  endpoint: 'project_type',
  action: 'update',
  encode: (i) => {
    const m: Record<string, unknown> = { id: i.id };
    if (i.name !== undefined) m.name = i.name;
    if (i.doc !== undefined) m.doc = i.doc;
    if (i.isDefault !== undefined) m.is_default = i.isDefault;
    return m;
  },
  decode: (raw) => ({ ok: asBoolOrFalse(asObj(raw).ok) }),
};

const projectTypeDelete: HandlerSpec<
  ProjectTypeDeleteInput,
  ProjectTypeDeleteOutput
> = {
  endpoint: 'project_type',
  action: 'delete',
  encode: (i) => ({ id: i.id }),
  decode: (raw) => {
    const j = asObj(raw);
    const out: ProjectTypeDeleteOutput = { ok: asBoolOrFalse(j.ok) };
    const usage = asNumOpt(j.usage_count);
    if (usage !== undefined) out.usage_count = usage;
    return out;
  },
};

// ============================================================================
// Re-exports + registration helper
// ============================================================================

export {
  projectTypeDelete,
  projectTypeInsert,
  projectTypeSelect,
  projectTypeUpdate,
  roleList,
  roleMappingDelete,
  roleMappingList,
  roleMappingSet,
  userListWithRoles,
  userRoleRevoke,
  userRoleSet,
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
  r.register(projectTypeSelect);
  r.register(projectTypeInsert);
  r.register(projectTypeUpdate);
  r.register(projectTypeDelete);
}
