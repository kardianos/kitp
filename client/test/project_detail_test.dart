/// Widget test for `ProjectDetailScreen`.
///
/// We test:
///   1. Opening the screen mocks a SINGLE batch (one HTTP call) and the
///      list renders the 3 tasks with their attributes.
///   2. Submitting the create-task dialog issues ONE batch with a single
///      `card.insert` carrying the initial attributes.
///
/// We drive the live router by pumping `KitpApp` and navigating to
/// `/project/7`. The mock backend serves the project + tasks data.
library;

import 'dart:convert';

import 'package:client/app.dart';
import 'package:client/dispatch/dispatcher.dart';
import 'package:client/reg/handler_registry.dart';
import 'package:client/reg/handlers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class _Backend {
  int httpCalls = 0;
  // Captures every batch: each entry is the parsed sub-requests array.
  final List<List<Map<String, dynamic>>> batches = [];
  // In-memory tasks under project 7. The test's projects list is just the
  // single project we navigate into.
  final List<Map<String, dynamic>> tasks = [
    {'id': 11, 'title': 'Task one', 'status': 'todo', 'assignee': 2},
    {'id': 12, 'title': 'Task two', 'status': 'doing', 'assignee': 3},
    {'id': 13, 'title': 'Task three', 'status': 'done', 'assignee': null},
  ];
  int _nextTaskId = 100;

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
        final parent = data['parent_card_id'];
        if (ctName == 'project' && parent == null) {
          responses.add({
            'id': s['id'],
            'ok': true,
            'data': {
              'rows': [
                {
                  'id': 7,
                  'card_type_id': 1,
                  'card_type_name': 'project',
                  'parent_card_id': null,
                  'attributes': {'title': 'My Project'},
                }
              ]
            },
          });
        } else if (ctName == 'task' && parent == 7) {
          responses.add({
            'id': s['id'],
            'ok': true,
            'data': {
              'rows': [
                for (final t in tasks)
                  {
                    'id': t['id'],
                    'card_type_id': 2,
                    'card_type_name': 'task',
                    'parent_card_id': 7,
                    'attributes': {
                      'title': t['title'],
                      if (t['status'] != null) 'status': t['status'],
                      if (t['assignee'] != null) 'assignee': t['assignee'],
                    },
                  }
              ]
            },
          });
        } else {
          responses.add({
            'id': s['id'],
            'ok': true,
            'data': const {'rows': []},
          });
        }
      } else if (endpoint == 'user' && action == 'select') {
        responses.add({
          'id': s['id'],
          'ok': true,
          'data': {
            'rows': const [
              {'id': 2, 'display_name': 'alice'},
              {'id': 3, 'display_name': 'bob'},
              {'id': 4, 'display_name': 'carol'},
            ],
          },
        });
      } else if (endpoint == 'card' && action == 'insert') {
        final id = _nextTaskId++;
        final attrs =
            (data['attributes'] as Map?)?.cast<String, dynamic>() ?? const {};
        tasks.add({
          'id': id,
          'title': data['title'],
          'status': attrs['status'],
          'assignee': attrs['assignee'],
        });
        responses.add({
          'id': s['id'],
          'ok': true,
          'data': {'id': id},
        });
      } else if (endpoint == 'attribute' && action == 'update') {
        // Minimal stub: accept the update and return an ok result. The
        // test backend doesn't model per-card attributes for tasks beyond
        // status/assignee, so we just acknowledge.
        responses.add({
          'id': s['id'],
          'ok': true,
          'data': {'ok': true, 'activity_id': 1, 'prev_value': null},
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

/// Pumps KitpApp, lets the projects screen settle (one batch), then
/// navigates to /project/7 by tapping the Open button on the project row.
/// We assume there's a single project in the backend.
Future<void> _navigateToProject(WidgetTester tester, _Backend backend) async {
  await tester.pumpWidget(KitpApp(dispatcher: _dispatcher(backend)));
  await tester.pumpAndSettle();
  // Reset the call counter so the test asserts only on the project-detail
  // batch(es), not the projects list page.
  backend.httpCalls = 0;
  backend.batches.clear();
  await tester.tap(find.byKey(const Key('project-open-7')));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('opens project, shows 3 tasks via ONE batch', (tester) async {
    final backend = _Backend();
    await _navigateToProject(tester, backend);

    // Exactly ONE HTTP call for the screen entry — N-CLI-2.
    expect(backend.httpCalls, 1);

    // The single batch contains every sub-request the screen issues on
    // entry: project + tasks + tags + users (4 sub-requests).
    expect(backend.batches.first.length, 4);

    expect(find.byKey(const Key('task-row-11')), findsOneWidget);
    expect(find.byKey(const Key('task-row-12')), findsOneWidget);
    expect(find.byKey(const Key('task-row-13')), findsOneWidget);
    expect(find.text('Task one'), findsOneWidget);
    expect(find.text('Task two'), findsOneWidget);
    expect(find.text('Task three'), findsOneWidget);
    // Chips render value-only (no "<label>: " prefix); each task shows its
    // status + assignee chips.
    expect(find.text('todo'), findsOneWidget);
    expect(find.text('doing'), findsOneWidget);
    expect(find.text('done'), findsOneWidget);
    expect(find.text('alice'), findsOneWidget);
    expect(find.text('bob'), findsOneWidget);
  });

  testWidgets('create-task gesture submits ONE batch with attributes',
      (tester) async {
    final backend = _Backend();
    await _navigateToProject(tester, backend);
    final initialBatches = backend.batches.length;

    // Open the dialog and fill fields.
    await tester.tap(find.byKey(const Key('project-new-task-fab')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('new-task-title')), findsOneWidget);
    await tester.enterText(find.byKey(const Key('new-task-title')), 'New task');

    await tester.tap(find.byKey(const Key('new-task-submit')));
    await tester.pumpAndSettle();

    // Submission produced exactly ONE additional HTTP batch (the insert),
    // and a refresh batch after. Description was empty, so no follow-up
    // attribute.update batch.
    expect(backend.batches.length, initialBatches + 2);
    final insertBatch = backend.batches[initialBatches];
    expect(insertBatch.length, 1);
    final ins = insertBatch.first;
    expect(ins['endpoint'], 'card');
    expect(ins['action'], 'insert');
    final data = ins['data'] as Map<String, dynamic>;
    expect(data['card_type_name'], 'task');
    expect(data['parent_card_id'], 7);
    expect(data['title'], 'New task');
    // T1: dialog no longer presets status or assignee — those are picked
    // on the detail screen. The insert carries title only.
    expect(data.containsKey('attributes'), isFalse);

    // The new task is in the post-refresh list: find the row keyed by its
    // server-assigned id (100, the first allocation by the mock backend).
    expect(find.byKey(const Key('task-row-100')), findsOneWidget);
  });

  testWidgets('create-task with description fires insert + attribute.update',
      (tester) async {
    final backend = _Backend();
    await _navigateToProject(tester, backend);
    final initialBatches = backend.batches.length;

    await tester.tap(find.byKey(const Key('project-new-task-fab')));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.byKey(const Key('new-task-title')), 'Task with desc');
    await tester.enterText(
        find.byKey(const Key('new-task-description')),
        'Multi-line\ndescription body.');
    await tester.tap(find.byKey(const Key('new-task-submit')));
    await tester.pumpAndSettle();

    // insert batch + attribute.update batch + refresh = 3 added.
    expect(backend.batches.length, initialBatches + 3);
    final insertBatch = backend.batches[initialBatches];
    expect(insertBatch.length, 1);
    expect(insertBatch.first['action'], 'insert');

    final updateBatch = backend.batches[initialBatches + 1];
    expect(updateBatch.length, 1);
    final upd = updateBatch.first;
    expect(upd['endpoint'], 'attribute');
    expect(upd['action'], 'update');
    final updData = upd['data'] as Map<String, dynamic>;
    expect(updData['attribute_name'], 'description');
    expect(updData['value'], 'Multi-line\ndescription body.');
    expect(updData['card_id'], isNotNull);
  });
}
