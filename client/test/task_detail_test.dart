/// Widget test for `TaskDetailScreen`.
///
/// Asserts:
///   1. Initial load: a single HTTP batch returns task + activity + tags +
///      milestones + components + users; the side panel + description +
///      activity + comment composer all render.
///   2. Editing status fires ONE batch (`attribute.update`) followed by a
///      refresh batch.
///   3. Editing the description (focus → type → blur) fires exactly ONE
///      `attribute.update` batch (typing N chars must NOT issue N HTTP calls).
///   4. Posting a comment fires ONE batch (`comment.insert`); the activity
///      stream re-renders to include the comment, and the comment composer
///      remains the last widget on the page.
///   5. The activity row renderer resolves user ids to names — an
///      `attr_update` for `assignee` shows "alice", not "2".
library;

import 'dart:convert';

import 'package:client/app.dart';
import 'package:client/dispatch/dispatcher.dart';
import 'package:client/reg/handler_registry.dart';
import 'package:client/reg/handlers.dart';
import 'package:client/ui/screens/task_detail_screen.dart';
import 'package:client/ui/widgets/attribute_side_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class _Backend {
  int httpCalls = 0;
  final List<List<Map<String, dynamic>>> batches = [];

  // Authoritative task state. Mutations from attribute.update / comment.insert
  // mutate this in-place so subsequent fetches see the new state.
  final Map<String, dynamic> task = {
    'id': 42,
    'card_type_id': 2,
    'card_type_name': 'task',
    'parent_card_id': 7,
    'attributes': {
      'title': 'Investigate bug',
      'status': 'todo',
      'assignee': 2,
    },
  };

  // The activity stream includes one assignee attr_update so the renderer
  // has something whose value is a user_id worth resolving to a name.
  List<Map<String, dynamic>> activity = [
    {
      'id': 1,
      'kind': 'card_create',
      'actor_id': 1,
      'created_at': '2026-05-01T10:00:00Z',
    },
    {
      'id': 2,
      'kind': 'attr_update',
      'attribute_name': 'title',
      'value_old': null,
      'value_new': 'Investigate bug',
      'actor_id': 1,
      'created_at': '2026-05-01T10:00:01Z',
    },
    {
      'id': 3,
      'kind': 'attr_update',
      'attribute_name': 'assignee',
      'value_old': null,
      'value_new': 2,
      'actor_id': 1,
      'created_at': '2026-05-01T10:00:02Z',
    },
  ];
  int _nextActivity = 100;
  int _nextCommentBody = 500;

  http.Response handle(http.Request req) {
    httpCalls++;
    final body = jsonDecode(req.body) as Map<String, dynamic>;
    final subs = (body['subrequests'] as List).cast<Map<String, dynamic>>();
    batches.add(subs);
    final responses = <Map<String, dynamic>>[];
    for (final s in subs) {
      final endpoint = s['endpoint'] as String;
      final action = s['action'] as String;
      final data = (s['data'] as Map?)?.cast<String, dynamic>() ?? const {};
      if (endpoint == 'card' && action == 'select_with_attributes') {
        final ctName = data['card_type_name'];
        if (ctName == 'task') {
          responses.add({
            'id': s['id'],
            'ok': true,
            'data': {'rows': [task]},
          });
        } else if (ctName == 'milestone') {
          responses.add({
            'id': s['id'],
            'ok': true,
            'data': {
              'rows': const [
                {
                  'id': 21,
                  'card_type_id': 3,
                  'card_type_name': 'milestone',
                  'parent_card_id': 7,
                  'attributes': {'title': 'M1'},
                },
                {
                  'id': 22,
                  'card_type_id': 3,
                  'card_type_name': 'milestone',
                  'parent_card_id': 7,
                  'attributes': {'title': 'M2'},
                },
              ],
            },
          });
        } else if (ctName == 'component') {
          responses.add({
            'id': s['id'],
            'ok': true,
            'data': {
              'rows': const [
                {
                  'id': 31,
                  'card_type_id': 4,
                  'card_type_name': 'component',
                  'parent_card_id': 7,
                  'attributes': {'title': 'Backend'},
                },
              ],
            },
          });
        } else if (ctName == 'tag') {
          responses.add({
            'id': s['id'],
            'ok': true,
            'data': {
              'rows': const [
                {
                  'id': 41,
                  'card_type_id': 5,
                  'card_type_name': 'tag',
                  'parent_card_id': 7,
                  'attributes': {
                    'title': 'priority/high',
                    'path': 'priority/high'
                  },
                },
                {
                  'id': 50,
                  'card_type_id': 5,
                  'card_type_name': 'tag',
                  'parent_card_id': 7,
                  'attributes': {
                    'title': 'priority/low',
                    'path': 'priority/low'
                  },
                },
              ],
            },
          });
        } else if (ctName == 'project') {
          responses.add({
            'id': s['id'],
            'ok': true,
            'data': {
              'rows': const [
                {
                  'id': 7,
                  'card_type_id': 1,
                  'card_type_name': 'project',
                  'parent_card_id': null,
                  'attributes': {'title': 'My Project'},
                }
              ],
            },
          });
        } else {
          responses.add({
            'id': s['id'],
            'ok': true,
            'data': const {'rows': []},
          });
        }
      } else if (endpoint == 'activity' && action == 'select') {
        responses.add({
          'id': s['id'],
          'ok': true,
          'data': {'rows': activity},
        });
      } else if (endpoint == 'user' && action == 'select') {
        responses.add({
          'id': s['id'],
          'ok': true,
          'data': {
            'rows': const [
              {'id': 1, 'display_name': 'System'},
              {'id': 2, 'display_name': 'alice'},
              {'id': 3, 'display_name': 'bob'},
            ],
          },
        });
      } else if (endpoint == 'attribute' && action == 'update') {
        final attrs = (task['attributes'] as Map).cast<String, dynamic>();
        final prev = attrs[data['attribute_name']];
        if (data['value'] == null) {
          attrs.remove(data['attribute_name'] as String);
        } else {
          attrs[data['attribute_name'] as String] = data['value'];
        }
        activity = List.of(activity)
          ..add({
            'id': _nextActivity++,
            'kind': 'attr_update',
            'attribute_name': data['attribute_name'],
            'value_old': prev,
            'value_new': data['value'],
            'actor_id': 1,
            'created_at': '2026-05-01T10:01:00Z',
          });
        responses.add({
          'id': s['id'],
          'ok': true,
          'data': {
            'ok': true,
            'activity_id': _nextActivity - 1,
            'prev_value': prev,
          },
        });
      } else if (endpoint == 'comment' && action == 'insert') {
        final aid = _nextActivity++;
        final bid = _nextCommentBody++;
        activity = List.of(activity)
          ..add({
            'id': aid,
            'kind': 'comment',
            'comment_body': data['body'],
            'actor_id': 1,
            'created_at': '2026-05-01T10:02:00Z',
          });
        responses.add({
          'id': s['id'],
          'ok': true,
          'data': {
            'ok': true,
            'activity_id': aid,
            'comment_body_id': bid,
          },
        });
      } else {
        responses.add({
          'id': s['id'],
          'ok': false,
          'error': {'code': 'unknown_handler', 'message': '$endpoint.$action'},
        });
      }
    }
    return http.Response(
      jsonEncode({'subresponses': responses}),
      200,
      headers: {'content-type': 'application/json'},
    );
  }
}

Dispatcher _dispatcher(_Backend b) {
  final reg = HandlerRegistry();
  registerBuiltInHandlers(reg);
  return Dispatcher(
    httpClient: MockClient((req) async => b.handle(req)),
    registry: reg,
    apiBase: 'http://test.invalid',
  );
}

/// Pumps KitpApp, lets the projects screen settle, then resets the call
/// counter and navigates to /task/42 via go_router.
Future<void> _navigateToTask(WidgetTester tester, _Backend backend) async {
  // Tall surface so the side panel + description + activity + comment
  // composer all fit without forcing manual scrolling in tests that
  // operate on multiple sections.
  await tester.binding.setSurfaceSize(const Size(1200, 1400));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(KitpApp(dispatcher: _dispatcher(backend)));
  await tester.pumpAndSettle();
  backend.httpCalls = 0;
  backend.batches.clear();
  final ctx = tester.element(find.byType(Scaffold).first);
  GoRouter.of(ctx).go('/task/42');
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('opens task, side panel + description + activity + comment composer all render',
      (tester) async {
    final backend = _Backend();
    await _navigateToTask(tester, backend);

    // Exactly ONE HTTP call for the screen entry — N-CLI-2.
    expect(backend.httpCalls, 1);
    expect(backend.batches.first.length, 6);

    // Side panel rendered with all 4 dropdowns + tag editor.
    expect(find.byType(AttributeSidePanel), findsOneWidget);
    expect(find.byKey(const Key('task-side-panel')), findsOneWidget);
    expect(find.byKey(const Key('task-status-dropdown')), findsOneWidget);
    expect(find.byKey(const Key('task-assignee-dropdown')), findsOneWidget);
    expect(find.byKey(const Key('task-milestone-dropdown')), findsOneWidget);
    expect(find.byKey(const Key('task-component-dropdown')), findsOneWidget);
    expect(find.byKey(const Key('task-edit-tags-button')), findsOneWidget);

    // Main column has title + description + activity + comment composer.
    expect(find.byKey(const Key('task-title-field')), findsOneWidget);
    expect(find.byKey(const Key('task-description-field')), findsOneWidget);
    // T6: activity is now a collapsed-by-default ExpansionTile; the
    // header is always present, the inner list is hidden until expanded.
    expect(find.byKey(const Key('task-activity-expansion')), findsOneWidget);
    expect(find.byKey(const Key('task-activity-list')), findsNothing);
    await tester.tap(find.byKey(const Key('task-activity-expansion')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('task-activity-list')), findsOneWidget);
    expect(find.byKey(const Key('task-comment-input')), findsOneWidget);
    expect(find.byKey(const Key('task-comment-post')), findsOneWidget);

    // Activity row renders the assignee name "alice", not the raw id "2".
    expect(find.textContaining('alice'), findsAtLeastNWidgets(1));
  });

  testWidgets('changing status fires one batch then refreshes',
      (tester) async {
    final backend = _Backend();
    await _navigateToTask(tester, backend);

    expect(backend.httpCalls, 1);

    await tester.tap(find.byKey(const Key('task-status-dropdown')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('doing').last);
    await tester.pumpAndSettle();

    expect(backend.httpCalls, 3);
    final updateBatch = backend.batches[1];
    expect(updateBatch.length, 1);
    expect(updateBatch.first['endpoint'], 'attribute');
    expect(updateBatch.first['action'], 'update');
    final ud = updateBatch.first['data'] as Map<String, dynamic>;
    expect(ud['card_id'], 42);
    expect(ud['attribute_name'], 'status');
    expect(ud['value'], 'doing');
  });

  testWidgets('description focus → type → blur fires ONE attribute.update batch',
      (tester) async {
    final backend = _Backend();
    await _navigateToTask(tester, backend);

    final initialCalls = backend.httpCalls;
    expect(initialCalls, 1);

    final field = find.byKey(const Key('task-description-field'));
    expect(field, findsOneWidget);

    // Tap to focus, then type — typing should NOT issue any HTTP calls.
    await tester.tap(field);
    await tester.pumpAndSettle();
    await tester.enterText(field, 'A new description.');
    await tester.pump(const Duration(milliseconds: 50));
    expect(backend.httpCalls, initialCalls,
        reason: 'typing must not fire any HTTP calls');

    // Blur: drive the focus away by tapping the title field.
    await tester.tap(find.byKey(const Key('task-title-field')));
    await tester.pumpAndSettle();

    // Exactly one update batch + one refresh batch.
    expect(backend.httpCalls, initialCalls + 2);
    final updateBatches = backend.batches.skip(1).toList();
    final descUpdates = updateBatches.where((b) =>
        b.length == 1 &&
        b.first['endpoint'] == 'attribute' &&
        b.first['action'] == 'update' &&
        ((b.first['data'] as Map)['attribute_name'] == 'description'));
    expect(descUpdates.length, 1,
        reason: 'expected one description attribute.update batch');
    final desc = descUpdates.first.first;
    final descData = desc['data'] as Map<String, dynamic>;
    expect(descData['card_id'], 42);
    expect(descData['attribute_name'], 'description');
    expect(descData['value'], 'A new description.');
  });

  testWidgets('posting a comment fires one batch and the comment composer is the last section',
      (tester) async {
    final backend = _Backend();
    await _navigateToTask(tester, backend);

    // T6: expand the activity section so the inner list (and post-comment
    // body) is mounted and findable.
    expect(find.byKey(const Key('task-activity-expansion')), findsOneWidget);
    await tester.tap(find.byKey(const Key('task-activity-expansion')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('task-activity-list')), findsOneWidget);

    await tester.enterText(
        find.byKey(const Key('task-comment-input')), 'looks good!');
    await tester.tap(find.byKey(const Key('task-comment-post')));
    await tester.pumpAndSettle();

    // 1 (initial) + 1 (insert) + 1 (refresh) = 3.
    expect(backend.httpCalls, 3);
    final ins = backend.batches[1];
    expect(ins.length, 1);
    expect(ins.first['endpoint'], 'comment');
    expect(ins.first['action'], 'insert');
    final cd = ins.first['data'] as Map<String, dynamic>;
    expect(cd['card_id'], 42);
    expect(cd['body'], 'looks good!');

    // Activity stream now contains the comment body.
    expect(find.text('looks good!'), findsOneWidget);

    // Comment composer is positioned BELOW the activity list. Compare top
    // offsets in global coords; "below" means higher y.
    final activityRect = tester.getRect(find.byKey(const Key('task-activity-list')));
    final composerRect = tester.getRect(find.byKey(const Key('task-comment-input')));
    expect(composerRect.top, greaterThan(activityRect.top));
  });
}
