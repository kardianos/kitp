/// AdminUsersScreen: list every user with their role chips, with a
/// "Manage" affordance that opens a side panel for adding/removing
/// (role, scope) tuples. Each gesture issues exactly ONE batch.
library;

import 'package:flutter/material.dart';

import '../../app.dart';
import '../../dispatch/dispatcher.dart';
import '../../reg/handlers_admin.dart';
import '../../reg/handlers.dart';

class AdminUsersScreen extends StatefulWidget {
  const AdminUsersScreen({super.key});

  @override
  State<AdminUsersScreen> createState() => _AdminUsersScreenState();
}

class _AdminUsersScreenState extends State<AdminUsersScreen> {
  Future<_AdminData>? _future;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _future ??= _load(KitpApp.dispatcherOf(context));
  }

  Future<_AdminData> _load(Dispatcher d) async {
    final users = d.request<UserListWithRolesInput, UserListWithRolesOutput>(
      endpoint: 'user',
      action: 'list_with_roles',
      data: const UserListWithRolesInput(),
    );
    final roles = d.request<RoleListInput, RoleListOutput>(
      endpoint: 'role',
      action: 'list',
      data: const RoleListInput(),
    );
    final projects = d.request<CardSelectInput, CardSelectOutput>(
      endpoint: 'card',
      action: 'select',
      data: const CardSelectInput(cardTypeName: 'project'),
    );
    final results = await Future.wait([users, roles, projects]);
    return _AdminData(
      users: (results[0] as UserListWithRolesOutput).rows,
      roles: (results[1] as RoleListOutput).rows,
      projects: (results[2] as CardSelectOutput).rows,
    );
  }

  void _refresh() {
    setState(() {
      _future = _load(KitpApp.dispatcherOf(context));
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Admin · Users & Roles')),
      body: FutureBuilder<_AdminData>(
        future: _future,
        builder: (ctx, snap) {
          if (!snap.hasData) {
            return const Center(child: CircularProgressIndicator());
          }
          final data = snap.data!;
          return ListView.separated(
            itemCount: data.users.length,
            separatorBuilder: (_, __) => const Divider(height: 1),
            itemBuilder: (ctx, i) {
              final u = data.users[i];
              return ListTile(
                title: Text(u.displayName),
                subtitle: Wrap(
                  spacing: 6,
                  runSpacing: 4,
                  children: [
                    if (u.email != null) Chip(label: Text(u.email!), key: ValueKey('e-${u.id}')),
                    for (final ra in u.roles)
                      Chip(
                        key: ValueKey('r-${u.id}-${ra.roleName}-${ra.scopeProjectId ?? 0}'),
                        label: Text(_roleChipLabel(ra)),
                      ),
                  ],
                ),
                trailing: TextButton(
                  key: ValueKey('manage-${u.id}'),
                  onPressed: () async {
                    await showDialog(
                      context: context,
                      builder: (_) => _ManageUserDialog(user: u, data: data),
                    );
                    _refresh();
                  },
                  child: const Text('Manage'),
                ),
              );
            },
          );
        },
      ),
    );
  }

  String _roleChipLabel(RoleAssignmentRow ra) {
    if (ra.scopeProjectTitle != null) {
      return '${ra.roleName} @ ${ra.scopeProjectTitle}';
    }
    return ra.roleName;
  }
}

class _AdminData {
  final List<UserListWithRolesRow> users;
  final List<RoleRow> roles;
  final List<CardRow> projects;
  _AdminData({required this.users, required this.roles, required this.projects});
}

class _ManageUserDialog extends StatefulWidget {
  final UserListWithRolesRow user;
  final _AdminData data;
  const _ManageUserDialog({required this.user, required this.data});
  @override
  State<_ManageUserDialog> createState() => _ManageUserDialogState();
}

class _ManageUserDialogState extends State<_ManageUserDialog> {
  String? _selectedRole;
  int? _selectedProject; // null = global

  @override
  Widget build(BuildContext context) {
    final dispatcher = KitpApp.dispatcherOf(context);
    return AlertDialog(
      title: Text('Manage ${widget.user.displayName}'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Existing roles', style: TextStyle(fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            for (final ra in widget.user.roles)
              ListTile(
                dense: true,
                title: Text(ra.scopeProjectTitle != null
                    ? '${ra.roleName} @ ${ra.scopeProjectTitle}'
                    : ra.roleName),
                trailing: IconButton(
                  key: ValueKey('revoke-${widget.user.id}-${ra.roleName}-${ra.scopeProjectId ?? 0}'),
                  icon: const Icon(Icons.remove_circle_outline),
                  onPressed: () async {
                    await dispatcher.request<UserRoleRevokeInput, UserRoleRevokeOutput>(
                      endpoint: 'user_role',
                      action: 'revoke',
                      data: UserRoleRevokeInput(
                        userId: widget.user.id,
                        roleName: ra.roleName,
                        scopeProjectId: ra.scopeProjectId,
                      ),
                    );
                    if (!mounted) return;
                    Navigator.of(context).pop();
                  },
                ),
              ),
            const Divider(),
            const Text('Add a role', style: TextStyle(fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            DropdownButton<String>(
              key: const ValueKey('role-picker'),
              hint: const Text('Role'),
              value: _selectedRole,
              items: [
                for (final r in widget.data.roles)
                  if (r.name != 'system')
                    DropdownMenuItem(value: r.name, child: Text(r.name)),
              ],
              onChanged: (v) => setState(() => _selectedRole = v),
            ),
            const SizedBox(height: 12),
            DropdownButton<int?>(
              key: const ValueKey('project-picker'),
              hint: const Text('Scope (project) — leave empty for global'),
              value: _selectedProject,
              items: [
                const DropdownMenuItem(value: null, child: Text('Global (no scope)')),
                for (final p in widget.data.projects)
                  DropdownMenuItem(value: p.id, child: Text(p.title ?? '#${p.id}')),
              ],
              onChanged: (v) => setState(() => _selectedProject = v),
            ),
            const SizedBox(height: 12),
            FilledButton(
              key: const ValueKey('grant-button'),
              onPressed: _selectedRole == null
                  ? null
                  : () async {
                      await dispatcher.request<UserRoleSetInput, UserRoleSetOutput>(
                        endpoint: 'user_role',
                        action: 'set',
                        data: UserRoleSetInput(
                          userId: widget.user.id,
                          roleName: _selectedRole!,
                          scopeProjectId: _selectedProject,
                        ),
                      );
                      if (!mounted) return;
                      Navigator.of(context).pop();
                    },
              child: const Text('Grant'),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Close')),
      ],
    );
  }
}
