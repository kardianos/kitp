/// AppShell: the persistent scaffold that wraps every routed screen.
///
/// Top nav (AppBar) carries the two top-level destinations the app has in
/// v1: Projects and Inbox. The left rail is reserved for per-project
/// navigation in later phases; for now it renders empty.
library;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../app.dart';

class AppShell extends StatelessWidget {
  /// The current sub-screen, supplied by the router via `ShellRoute.builder`.
  final Widget child;

  /// Index of the currently selected nav destination. Computed by the
  /// router from the active path.
  final int selectedIndex;

  const AppShell({
    super.key,
    required this.child,
    required this.selectedIndex,
  });

  @override
  Widget build(BuildContext context) {
    final auth = KitpApp.authStateOf(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text('kitp'),
        actions: [
          // Top-nav buttons. Tested by `shell_test.dart` via Finder.byKey.
          TextButton(
            key: const Key('nav-projects'),
            style: _navStyle(context, selectedIndex == 0),
            onPressed: () => context.go('/projects'),
            child: const Text('Projects'),
          ),
          TextButton(
            key: const Key('nav-inbox'),
            style: _navStyle(context, selectedIndex == 1),
            onPressed: () => context.go('/inbox'),
            child: const Text('Inbox'),
          ),
          TextButton(
            key: const Key('nav-grid'),
            style: _navStyle(context, selectedIndex == 2),
            onPressed: () => context.go('/grid'),
            child: const Text('Grid'),
          ),
          TextButton(
            key: const Key('nav-kanban'),
            style: _navStyle(context, selectedIndex == 3),
            onPressed: () => context.go('/kanban'),
            child: const Text('Kanban'),
          ),
          TextButton(
            key: const Key('nav-activity'),
            style: _navStyle(context, selectedIndex == 4),
            onPressed: () => context.go('/activity'),
            child: const Text('Activity'),
          ),
          // Admin menu: visible when signed-in admins exist (OIDC mode) or
          // in dev mode where `auth` is null and SystemUser has full access.
          if (auth == null || auth.isAdmin)
            PopupMenuButton<String>(
              key: const Key('nav-admin'),
              tooltip: 'Admin',
              onSelected: (v) => context.go(v),
              itemBuilder: (_) => const [
                PopupMenuItem(
                  value: '/admin/users',
                  child: Text('Users & Roles'),
                ),
                PopupMenuItem(
                  value: '/admin/attributes',
                  child: Text('Attributes & Values'),
                ),
              ],
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                child: Text(
                  'Admin',
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
            ),
          if (auth != null && auth.isSignedIn) ...[
            const SizedBox(width: 16),
            Padding(
              key: const Key('nav-user-chip'),
              padding: const EdgeInsets.only(right: 8),
              child: Center(child: Text(auth.displayName ?? '')),
            ),
            TextButton(
              key: const Key('nav-logout'),
              onPressed: () => auth.signOut(),
              child: const Text('Logout'),
            ),
          ],
          const SizedBox(width: 16),
        ],
      ),
      body: Row(
        children: [
          // Left rail: empty in P12. Phase 13+ will populate it with
          // per-project context.
          const SizedBox(
            width: 220,
            child: _LeftRailPlaceholder(),
          ),
          const VerticalDivider(width: 1, thickness: 1),
          Expanded(child: child),
        ],
      ),
    );
  }

  ButtonStyle _navStyle(BuildContext context, bool active) {
    final cs = Theme.of(context).colorScheme;
    return TextButton.styleFrom(
      foregroundColor: active ? cs.primary : cs.onSurfaceVariant,
    );
  }
}

class _LeftRailPlaceholder extends StatelessWidget {
  const _LeftRailPlaceholder();
  @override
  Widget build(BuildContext context) {
    return Container(
      color: Theme.of(context).colorScheme.surfaceContainerLow,
      child: const SizedBox.expand(),
    );
  }
}
