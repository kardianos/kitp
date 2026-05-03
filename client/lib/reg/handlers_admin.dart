/// Phase 20 admin handlers: user.list_with_roles, role.list, user_role.set,
/// user_role.revoke, role_mapping.list/set/delete.
library;

import 'handler_registry.dart';

// ============================================================================
// user.list_with_roles
// ============================================================================

class UserListWithRolesInput {
  const UserListWithRolesInput();
  Map<String, dynamic> toJson() => const {};
}

class RoleAssignmentRow {
  final String roleName;
  final int? scopeProjectId;
  final String? scopeProjectTitle;
  const RoleAssignmentRow({
    required this.roleName,
    this.scopeProjectId,
    this.scopeProjectTitle,
  });
  factory RoleAssignmentRow.fromJson(Map<String, dynamic> j) => RoleAssignmentRow(
        roleName: j['role_name'] as String,
        scopeProjectId: (j['scope_project_id'] as num?)?.toInt(),
        scopeProjectTitle: j['scope_project_title'] as String?,
      );
}

class UserListWithRolesRow {
  final int id;
  final String displayName;
  final String? email;
  final String? oidcSub;
  final List<RoleAssignmentRow> roles;
  const UserListWithRolesRow({
    required this.id,
    required this.displayName,
    this.email,
    this.oidcSub,
    required this.roles,
  });
  factory UserListWithRolesRow.fromJson(Map<String, dynamic> j) {
    final raw = (j['roles'] as List?) ?? const [];
    return UserListWithRolesRow(
      id: (j['id'] as num).toInt(),
      displayName: j['display_name'] as String,
      email: j['email'] as String?,
      oidcSub: j['oidc_sub'] as String?,
      roles: [for (final r in raw) RoleAssignmentRow.fromJson(r as Map<String, dynamic>)],
    );
  }
}

class UserListWithRolesOutput {
  final List<UserListWithRolesRow> rows;
  const UserListWithRolesOutput({required this.rows});
  factory UserListWithRolesOutput.fromJson(Map<String, dynamic> j) {
    final raw = (j['rows'] as List?) ?? const [];
    return UserListWithRolesOutput(
      rows: [for (final r in raw) UserListWithRolesRow.fromJson(r as Map<String, dynamic>)],
    );
  }
}

// ============================================================================
// role.list
// ============================================================================

class RoleListInput {
  const RoleListInput();
  Map<String, dynamic> toJson() => const {};
}

class RoleGrantRow {
  final String cardType;
  final String process;
  const RoleGrantRow({required this.cardType, required this.process});
  factory RoleGrantRow.fromJson(Map<String, dynamic> j) => RoleGrantRow(
        cardType: j['card_type'] as String,
        process: j['process'] as String,
      );
}

class RoleRow {
  final int id;
  final String name;
  final String doc;
  final List<RoleGrantRow> grants;
  const RoleRow({required this.id, required this.name, required this.doc, required this.grants});
  factory RoleRow.fromJson(Map<String, dynamic> j) {
    final raw = (j['grants'] as List?) ?? const [];
    return RoleRow(
      id: (j['id'] as num).toInt(),
      name: j['name'] as String,
      doc: (j['doc'] as String?) ?? '',
      grants: [for (final r in raw) RoleGrantRow.fromJson(r as Map<String, dynamic>)],
    );
  }
}

class RoleListOutput {
  final List<RoleRow> rows;
  const RoleListOutput({required this.rows});
  factory RoleListOutput.fromJson(Map<String, dynamic> j) {
    final raw = (j['rows'] as List?) ?? const [];
    return RoleListOutput(
      rows: [for (final r in raw) RoleRow.fromJson(r as Map<String, dynamic>)],
    );
  }
}

// ============================================================================
// user_role.set / user_role.revoke
// ============================================================================

class UserRoleSetInput {
  final int userId;
  final String roleName;
  final int? scopeProjectId;
  const UserRoleSetInput({
    required this.userId,
    required this.roleName,
    this.scopeProjectId,
  });
  Map<String, dynamic> toJson() {
    final m = <String, dynamic>{'user_id': userId, 'role_name': roleName};
    if (scopeProjectId != null) m['scope_project_id'] = scopeProjectId;
    return m;
  }
}

class UserRoleSetOutput {
  final bool ok;
  final int userRoleId;
  const UserRoleSetOutput({required this.ok, required this.userRoleId});
  factory UserRoleSetOutput.fromJson(Map<String, dynamic> j) => UserRoleSetOutput(
        ok: (j['ok'] as bool?) ?? false,
        userRoleId: (j['user_role_id'] as num?)?.toInt() ?? 0,
      );
}

class UserRoleRevokeInput {
  final int userId;
  final String roleName;
  final int? scopeProjectId;
  const UserRoleRevokeInput({
    required this.userId,
    required this.roleName,
    this.scopeProjectId,
  });
  Map<String, dynamic> toJson() {
    final m = <String, dynamic>{'user_id': userId, 'role_name': roleName};
    if (scopeProjectId != null) m['scope_project_id'] = scopeProjectId;
    return m;
  }
}

class UserRoleRevokeOutput {
  final bool ok;
  final int deleted;
  const UserRoleRevokeOutput({required this.ok, required this.deleted});
  factory UserRoleRevokeOutput.fromJson(Map<String, dynamic> j) => UserRoleRevokeOutput(
        ok: (j['ok'] as bool?) ?? false,
        deleted: (j['deleted'] as num?)?.toInt() ?? 0,
      );
}

// ============================================================================
// role_mapping.* (claim_value -> role)
// ============================================================================

class RoleMappingListInput {
  const RoleMappingListInput();
  Map<String, dynamic> toJson() => const {};
}

class RoleMappingListRow {
  final String claimValue;
  final int roleId;
  final String roleName;
  const RoleMappingListRow({
    required this.claimValue,
    required this.roleId,
    required this.roleName,
  });
  factory RoleMappingListRow.fromJson(Map<String, dynamic> j) => RoleMappingListRow(
        claimValue: j['claim_value'] as String,
        roleId: (j['role_id'] as num).toInt(),
        roleName: j['role_name'] as String,
      );
}

class RoleMappingListOutput {
  final List<RoleMappingListRow> rows;
  const RoleMappingListOutput({required this.rows});
  factory RoleMappingListOutput.fromJson(Map<String, dynamic> j) {
    final raw = (j['rows'] as List?) ?? const [];
    return RoleMappingListOutput(
      rows: [for (final r in raw) RoleMappingListRow.fromJson(r as Map<String, dynamic>)],
    );
  }
}

class RoleMappingSetInput {
  final String claimValue;
  final String roleName;
  const RoleMappingSetInput({required this.claimValue, required this.roleName});
  Map<String, dynamic> toJson() => {'claim_value': claimValue, 'role_name': roleName};
}

class RoleMappingSetOutput {
  final bool ok;
  const RoleMappingSetOutput({required this.ok});
  factory RoleMappingSetOutput.fromJson(Map<String, dynamic> j) =>
      RoleMappingSetOutput(ok: (j['ok'] as bool?) ?? false);
}

class RoleMappingDeleteInput {
  final String claimValue;
  const RoleMappingDeleteInput({required this.claimValue});
  Map<String, dynamic> toJson() => {'claim_value': claimValue};
}

class RoleMappingDeleteOutput {
  final bool ok;
  final int deleted;
  const RoleMappingDeleteOutput({required this.ok, required this.deleted});
  factory RoleMappingDeleteOutput.fromJson(Map<String, dynamic> j) => RoleMappingDeleteOutput(
        ok: (j['ok'] as bool?) ?? false,
        deleted: (j['deleted'] as num?)?.toInt() ?? 0,
      );
}

/// Register the Phase 20 admin handlers on top of the v1 set.
void registerAdminHandlers(HandlerRegistry r) {
  r.register<UserListWithRolesInput, UserListWithRolesOutput>(HandlerSpec(
    endpoint: 'user',
    action: 'list_with_roles',
    encode: (i) => i.toJson(),
    decode: (raw) => UserListWithRolesOutput.fromJson(raw as Map<String, dynamic>),
  ));
  r.register<RoleListInput, RoleListOutput>(HandlerSpec(
    endpoint: 'role',
    action: 'list',
    encode: (i) => i.toJson(),
    decode: (raw) => RoleListOutput.fromJson(raw as Map<String, dynamic>),
  ));
  r.register<UserRoleSetInput, UserRoleSetOutput>(HandlerSpec(
    endpoint: 'user_role',
    action: 'set',
    encode: (i) => i.toJson(),
    decode: (raw) => UserRoleSetOutput.fromJson(raw as Map<String, dynamic>),
  ));
  r.register<UserRoleRevokeInput, UserRoleRevokeOutput>(HandlerSpec(
    endpoint: 'user_role',
    action: 'revoke',
    encode: (i) => i.toJson(),
    decode: (raw) => UserRoleRevokeOutput.fromJson(raw as Map<String, dynamic>),
  ));
  r.register<RoleMappingListInput, RoleMappingListOutput>(HandlerSpec(
    endpoint: 'role_mapping',
    action: 'list',
    encode: (i) => i.toJson(),
    decode: (raw) => RoleMappingListOutput.fromJson(raw as Map<String, dynamic>),
  ));
  r.register<RoleMappingSetInput, RoleMappingSetOutput>(HandlerSpec(
    endpoint: 'role_mapping',
    action: 'set',
    encode: (i) => i.toJson(),
    decode: (raw) => RoleMappingSetOutput.fromJson(raw as Map<String, dynamic>),
  ));
  r.register<RoleMappingDeleteInput, RoleMappingDeleteOutput>(HandlerSpec(
    endpoint: 'role_mapping',
    action: 'delete',
    encode: (i) => i.toJson(),
    decode: (raw) => RoleMappingDeleteOutput.fromJson(raw as Map<String, dynamic>),
  ));
}
