/// Smoke + interaction tests for the admin users screen.
///
/// We mount the AdminUsersScreen inside a minimal KitpApp scope (so it can
/// resolve the dispatcher) and assert:
///   - The screen renders one row per user with role chips for scoped grants.
///   - Picking a role + clicking Grant issues exactly one batch carrying
///     user_role.set.
import 'dart:convert';

import 'package:client/app.dart';
import 'package:client/dispatch/dispatcher.dart';
import 'package:client/reg/handler_registry.dart';
import 'package:client/reg/handlers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  testWidgets('admin users screen lists users + grants role in one batch',
      (tester) async {
    final calls = <List>[];
    final mock = MockClient((req) async {
      final body = jsonDecode(req.body) as Map<String, dynamic>;
      final subs = body['subrequests'] as List;
      calls.add(subs);
      final responses = <Map<String, dynamic>>[];
      for (final s in subs) {
        final m = s as Map<String, dynamic>;
        final id = m['id'] as String;
        final key = '${m['endpoint']}.${m['action']}';
        switch (key) {
          case 'user.list_with_roles':
            responses.add({
              'id': id,
              'ok': true,
              'data': {
                'rows': [
                  {
                    'id': 2,
                    'display_name': 'alice',
                    'email': 'alice@example.invalid',
                    'roles': []
                  },
                  {
                    'id': 3,
                    'display_name': 'bob',
                    'roles': [
                      {
                        'role_name': 'manager',
                        'scope_project_id': 7,
                        'scope_project_title': 'Default Project'
                      }
                    ]
                  },
                ]
              }
            });
            break;
          case 'role.list':
            responses.add({
              'id': id,
              'ok': true,
              'data': {
                'rows': [
                  {'id': 1, 'name': 'system', 'doc': 'sys', 'grants': []},
                  {'id': 2, 'name': 'viewer', 'doc': 'r', 'grants': []},
                  {'id': 3, 'name': 'worker', 'doc': 'w', 'grants': []},
                  {'id': 4, 'name': 'manager', 'doc': 'm', 'grants': []},
                  {'id': 5, 'name': 'admin', 'doc': 'a', 'grants': []},
                ]
              }
            });
            break;
          case 'card.select':
            responses.add({
              'id': id,
              'ok': true,
              'data': {
                'rows': [
                  {'id': 7, 'card_type_id': 1, 'card_type_name': 'project', 'title': 'Default Project'},
                ]
              }
            });
            break;
          case 'user_role.set':
            responses.add({'id': id, 'ok': true, 'data': {'ok': true, 'user_role_id': 99}});
            break;
          default:
            responses.add({'id': id, 'ok': true, 'data': {}});
        }
      }
      return http.Response(jsonEncode({'subresponses': responses}), 200);
    });
    final reg = HandlerRegistry();
    registerBuiltInHandlers(reg);
    final dispatcher = Dispatcher(
      httpClient: mock,
      registry: reg,
      apiBase: 'http://test.invalid',
      scheduleFlush: (flush) => Future.microtask(flush),
    );

    await tester.pumpWidget(KitpApp(dispatcher: dispatcher));
    await tester.pumpAndSettle();
    // Navigate to /admin/users using the router context inside MaterialApp.router.
    final BuildContext ctx = tester.element(find.byType(Navigator).first);
    GoRouter.of(ctx).go('/admin/users');
    await tester.pumpAndSettle();

    expect(find.text('alice'), findsOneWidget);
    expect(find.text('bob'), findsOneWidget);
    expect(find.text('manager @ Default Project'), findsOneWidget);

    // Open the manage dialog for alice.
    await tester.tap(find.byKey(const ValueKey('manage-2')));
    await tester.pumpAndSettle();

    // Pick worker via the dropdown.
    await tester.tap(find.byKey(const ValueKey('role-picker')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('worker').last);
    await tester.pumpAndSettle();

    final beforeBatch = calls.length;
    await tester.tap(find.byKey(const ValueKey('grant-button')));
    await tester.pumpAndSettle();

    // Grant gesture issues exactly ONE new batch carrying user_role.set.
    final grantBatch = calls[beforeBatch];
    final hasSet = grantBatch.any((s) => '${(s as Map)['endpoint']}.${(s)['action']}' == 'user_role.set');
    expect(hasSet, isTrue, reason: 'grant batch missing user_role.set');
    // The user_role.set batch should be JUST the one set call (no other endpoints
    // mixed in — that's the "one HTTP call per gesture" rule).
    expect(grantBatch.length, 1, reason: 'grant gesture must be ONE batch with ONE subrequest');
  });
}
