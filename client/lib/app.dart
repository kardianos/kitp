/// Top-level Flutter app widget.
///
/// `KitpApp` hosts the [Dispatcher] via an [InheritedWidget] so any descendant
/// widget can grab it with `KitpApp.dispatcher(context)`.
library;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'auth/auth_state.dart';
import 'auth/oidc_client.dart';
import 'auth/oidc_session.dart';
import 'dispatch/dispatcher.dart';
import 'reg/handler_registry.dart';
import 'reg/handlers.dart';
import 'ui/shell.dart';
import 'ui/screens/activity_screen.dart';
import 'ui/screens/admin_attributes_screen.dart';
import 'ui/screens/admin_users_screen.dart';
import 'ui/screens/grid_screen.dart';
import 'ui/screens/inbox_screen.dart';
import 'ui/screens/kanban_screen.dart';
import 'ui/screens/login_screen.dart';
import 'ui/screens/project_detail_screen.dart';
import 'ui/screens/projects_screen.dart';
import 'ui/screens/task_detail_screen.dart';

class KitpApp extends StatefulWidget {
  /// Optional dispatcher injection. Tests pass a fake; production lets the
  /// state object construct one.
  final Dispatcher? dispatcher;

  /// Optional auth state injection (for tests). Production builds derive
  /// one from the build-time OIDC config.
  final AuthState? authState;

  const KitpApp({super.key, this.dispatcher, this.authState});

  /// Look up the [Dispatcher] provided to this app from anywhere below.
  /// Throws if no `KitpApp` ancestor is mounted; that's a programming
  /// error, not a runtime error.
  static Dispatcher dispatcherOf(BuildContext context) {
    final inh = context.dependOnInheritedWidgetOfExactType<_KitpScope>();
    assert(inh != null, 'KitpApp.dispatcherOf called without a KitpApp ancestor');
    return inh!.dispatcher;
  }

  /// Look up the [AuthState] provided to this app. Returns null when OIDC
  /// is disabled (dev mode) so widgets can render unconditionally.
  static AuthState? authStateOf(BuildContext context) {
    final inh = context.dependOnInheritedWidgetOfExactType<_KitpScope>();
    return inh?.authState;
  }

  @override
  State<KitpApp> createState() => _KitpAppState();
}

class _KitpAppState extends State<KitpApp> {
  late final Dispatcher _dispatcher;
  late final GoRouter _router;
  AuthState? _authState;
  OidcSession? _session;
  OidcConfig? _config;
  bool _ownsDispatcher = false;

  @override
  void initState() {
    super.initState();
    String? origin;
    try {
      origin = Uri.base.origin;
    } catch (_) {
      origin = null; // dart:io tests have a file:// base URL with no origin.
    }
    final cfg = OidcConfig.fromEnv(originFallback: origin);
    _config = cfg;
    if (cfg.enabled) {
      _authState = widget.authState ?? AuthState();
      _session = OidcSession(config: cfg, authState: _authState!);
    } else {
      _authState = widget.authState;
    }
    if (widget.dispatcher != null) {
      _dispatcher = widget.dispatcher!;
    } else {
      final reg = HandlerRegistry();
      registerBuiltInHandlers(reg);
      _dispatcher = Dispatcher.production(
        registry: reg,
        authState: _authState,
        onUnauthorized: _session == null ? null : () => _session!.refresh(),
      );
      _ownsDispatcher = true;
    }
    _router = _buildRouter();
  }

  @override
  void dispose() {
    if (_ownsDispatcher) {
      _dispatcher.httpClient.close();
    }
    super.dispose();
  }

  GoRouter _buildRouter() {
    return GoRouter(
      initialLocation: '/projects',
      // OIDC redirect: when sign-in is required but the user has no token,
      // we send them to /login (except for the callback route, which needs
      // to read the code/state query parameters). Dev mode skips this.
      redirect: (ctx, state) {
        final auth = _authState;
        final cfg = _config;
        if (cfg == null || !cfg.enabled || auth == null) return null;
        final loc = state.matchedLocation;
        if (loc.startsWith('/auth/callback')) return null;
        if (loc == '/login') return null;
        if (!auth.isSignedIn) return '/login';
        // Admin gating: non-admins hitting /admin go to /projects.
        if (loc.startsWith('/admin') && !auth.isAdmin) return '/projects';
        return null;
      },
      routes: [
        GoRoute(
          path: '/login',
          pageBuilder: (ctx, state) {
            final cfg = _config;
            final session = _session;
            if (cfg == null || session == null) {
              return const NoTransitionPage(child: SizedBox.shrink());
            }
            return NoTransitionPage(child: LoginScreen(config: cfg, session: session));
          },
        ),
        GoRoute(
          path: '/auth/callback',
          pageBuilder: (ctx, state) {
            final session = _session;
            if (session == null) {
              return const NoTransitionPage(child: SizedBox.shrink());
            }
            return NoTransitionPage(
              child: CallbackScreen(
                session: session,
                code: state.uri.queryParameters['code'] ?? '',
                state: state.uri.queryParameters['state'] ?? '',
                onSuccess: () => GoRouter.of(ctx).go('/projects'),
              ),
            );
          },
        ),
        GoRoute(
          path: '/admin/users',
          pageBuilder: (ctx, state) =>
              const NoTransitionPage(child: AdminUsersScreen()),
        ),
        // T5 placeholder: AdminAttributesScreen replaces the SizedBox below.
        GoRoute(
          path: '/admin/attributes',
          pageBuilder: (ctx, state) =>
              const NoTransitionPage(child: AdminAttributesScreen()),
        ),
        ShellRoute(
          builder: (ctx, state, child) {
            final loc = state.matchedLocation;
            // Map the active route to a nav index. Order matches the
            // AppShell nav buttons: 0=Projects, 1=Inbox, 2=Grid, 3=Kanban,
            // 4=Activity.
            int index = 0;
            if (loc.startsWith('/inbox')) {
              index = 1;
            } else if (loc.startsWith('/grid')) {
              index = 2;
            } else if (loc.startsWith('/kanban')) {
              index = 3;
            } else if (loc.startsWith('/activity')) {
              index = 4;
            }
            return AppShell(selectedIndex: index, child: child);
          },
          routes: [
            GoRoute(
              path: '/projects',
              pageBuilder: (ctx, state) => const NoTransitionPage(
                child: ProjectsScreen(),
              ),
            ),
            GoRoute(
              path: '/inbox',
              pageBuilder: (ctx, state) => const NoTransitionPage(
                child: InboxScreen(),
              ),
            ),
            GoRoute(
              path: '/grid',
              pageBuilder: (ctx, state) {
                final projParam = state.uri.queryParameters['project'];
                final projectId = int.tryParse(projParam ?? '');
                return NoTransitionPage(
                  child: GridScreen(projectId: projectId),
                );
              },
            ),
            GoRoute(
              path: '/kanban',
              pageBuilder: (ctx, state) {
                final projParam = state.uri.queryParameters['project'];
                final projectId = int.tryParse(projParam ?? '');
                return NoTransitionPage(
                  child: KanbanScreen(projectId: projectId),
                );
              },
            ),
            GoRoute(
              path: '/activity',
              pageBuilder: (ctx, state) =>
                  const NoTransitionPage(child: ActivityScreen()),
            ),
            GoRoute(
              path: '/project/:id',
              pageBuilder: (ctx, state) {
                final id = int.tryParse(state.pathParameters['id'] ?? '') ?? 0;
                return NoTransitionPage(
                  child: ProjectDetailScreen(projectId: id),
                );
              },
            ),
            GoRoute(
              path: '/task/:id',
              pageBuilder: (ctx, state) {
                final id = int.tryParse(state.pathParameters['id'] ?? '') ?? 0;
                return NoTransitionPage(
                  child: TaskDetailScreen(taskId: id),
                );
              },
            ),
          ],
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final auth = _authState;
    final router = MaterialApp.router(
      title: 'kitp',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.indigo),
        useMaterial3: true,
      ),
      routerConfig: _router,
    );
    Widget app = router;
    if (auth != null) {
      // Wrap in a listener so route redirects re-fire when auth changes.
      // Note: the builder closure must reference `router`, not `app` —
      // earlier this read `app` after we'd reassigned it, which made the
      // closure return the AnimatedBuilder itself and stack-overflowed.
      app = AnimatedBuilder(
        animation: auth,
        builder: (ctx, _) => router,
      );
    }
    return _KitpScope(
      dispatcher: _dispatcher,
      authState: _authState,
      session: _session,
      config: _config,
      child: app,
    );
  }
}

/// Inherited widget that exposes the [Dispatcher] to descendants.
class _KitpScope extends InheritedWidget {
  final Dispatcher dispatcher;
  final AuthState? authState;
  final OidcSession? session;
  final OidcConfig? config;
  const _KitpScope({
    required this.dispatcher,
    required this.authState,
    required this.session,
    required this.config,
    required super.child,
  });

  @override
  bool updateShouldNotify(_KitpScope old) =>
      old.dispatcher != dispatcher || old.authState != authState;
}

