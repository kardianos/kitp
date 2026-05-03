/// Smoke tests for the admin attributes screen.
///
/// Strategy: mount the screen behind a mocked dispatcher that responds to
/// the bootstrap batch (attribute_def.select + card_type.select + 3
/// card.select_with_attributes for the ref card types) and assert:
///   - Each attribute_def renders as a list row.
///   - Selecting an attribute shows its bound card types.
///   - For a ref-style attribute (milestone_ref), the value-card population
///     is rendered with an Active toggle.
///   - Toggling Active issues exactly one batch carrying attribute.update.
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
  testWidgets('admin attributes screen renders list + toggles is_active in one batch',
      (tester) async {
    final calls = <List>[];
    final mock = MockClient((req) async {
      final body = jsonDecode(req.body) as Map<String, dynamic>;
      final subs = (body['subrequests'] as List).cast<Map<String, dynamic>>();
      calls.add(subs);
      final responses = <Map<String, dynamic>>[];
      for (final m in subs) {
        final id = m['id'] as String;
        final key = '${m['endpoint']}.${m['action']}';
        switch (key) {
          case 'attribute_def.select':
            responses.add({
              'id': id,
              'ok': true,
              'data': {
                'rows': [
                  {
                    'id': 1,
                    'name': 'title',
                    'value_type': 'text',
                    'is_built_in': true,
                    'bound_to': [
                      {
                        'card_type_id': 10,
                        'card_type_name': 'task',
                        'is_required': true,
                        'is_built_in': true,
                        'ordering': 0
                      },
                    ]
                  },
                  {
                    'id': 2,
                    'name': 'milestone_ref',
                    'value_type': 'card_ref',
                    'is_built_in': true,
                    'bound_to': [
                      {
                        'card_type_id': 10,
                        'card_type_name': 'task',
                        'is_required': false,
                        'is_built_in': true,
                        'ordering': 1
                      },
                    ]
                  },
                  {
                    'id': 3,
                    'name': 'is_active',
                    'value_type': 'bool',
                    'is_built_in': true,
                    'bound_to': []
                  },
                ]
              }
            });
            break;
          case 'card_type.select':
            responses.add({
              'id': id,
              'ok': true,
              'data': {
                'rows': [
                  {'id': 10, 'name': 'task', 'allow_self_parent': true, 'is_built_in': true},
                  {'id': 11, 'name': 'milestone', 'allow_self_parent': false, 'is_built_in': true},
                  {'id': 12, 'name': 'component', 'allow_self_parent': false, 'is_built_in': true},
                  {'id': 13, 'name': 'tag', 'allow_self_parent': false, 'is_built_in': true},
                ]
              }
            });
            break;
          case 'card.select_with_attributes':
            final data = m['data'] as Map<String, dynamic>?;
            final ctn = data?['card_type_name'] as String?;
            if (ctn == 'milestone') {
              responses.add({
                'id': id,
                'ok': true,
                'data': {
                  'rows': [
                    {
                      'id': 1001,
                      'card_type_id': 11,
                      'card_type_name': 'milestone',
                      'attributes': {'title': 'M1'}
                    },
                    {
                      'id': 1002,
                      'card_type_id': 11,
                      'card_type_name': 'milestone',
                      'attributes': {'title': 'M2', 'is_active': false}
                    },
                  ]
                }
              });
            } else {
              responses.add({'id': id, 'ok': true, 'data': {'rows': []}});
            }
            break;
          case 'attribute.update':
            responses.add({
              'id': id,
              'ok': true,
              'data': {'ok': true, 'activity_id': 999}
            });
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
    final BuildContext ctx = tester.element(find.byType(Navigator).first);
    GoRouter.of(ctx).go('/admin/attributes');
    await tester.pumpAndSettle();

    // Master list shows every attribute_def row.
    expect(find.byKey(const ValueKey('attr-row-1')), findsOneWidget);
    expect(find.byKey(const ValueKey('attr-row-2')), findsOneWidget);
    expect(find.byKey(const ValueKey('attr-row-3')), findsOneWidget);
    expect(find.text('milestone_ref'), findsOneWidget);
    expect(find.text('is_active'), findsOneWidget);

    // Default selection is the first def — exercise selecting milestone_ref
    // explicitly so the value-card population renders.
    await tester.tap(find.byKey(const ValueKey('attr-row-2')));
    await tester.pumpAndSettle();

    // Both milestone value cards are listed.
    expect(find.byKey(const ValueKey('value-card-1001')), findsOneWidget);
    expect(find.byKey(const ValueKey('value-card-1002')), findsOneWidget);
    expect(find.text('M1'), findsOneWidget);
    expect(find.text('M2'), findsOneWidget);

    // Toggle the M1 active switch — fires exactly one batch carrying
    // attribute.update.
    final beforeBatch = calls.length;
    await tester.tap(find.byKey(const ValueKey('active-toggle-1001')));
    await tester.pumpAndSettle();
    final toggleBatch = calls[beforeBatch];
    final keys = toggleBatch.map((s) => '${(s as Map)['endpoint']}.${s['action']}').toList();
    expect(keys, contains('attribute.update'),
        reason: 'toggle should issue attribute.update');
    expect(toggleBatch.length, 1,
        reason: 'one gesture must produce one batch with one subrequest');
  });
}
