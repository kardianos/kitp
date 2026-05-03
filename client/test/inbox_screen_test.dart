/// Widget tests for `InboxScreen`.
///
/// Asserts:
///   - Opening the inbox results in EXACTLY ONE HTTP call (the dispatcher
///     coalesces every initial sub-request into one batch).
///   - The single batch contains the `inbox.select` task fetch, plus the
///     user/milestone/component/tag lookup sub-requests.
///   - Rows render with title + status / assignee / priority chips.
///   - Tapping a row navigates to /task/:id.
///   - Drag a card from index N to index 0 → ONE batch with ONE
///     `user_card_sort.set` whose computed sort_order is below the
///     previous first card's value.
///   - Drag a card from index 0 to between two existing rows → ONE batch
///     with sort_order = midpoint of the neighbours.
library;

import 'dart:convert';

import 'package:client/app.dart';
import 'package:client/dispatch/dispatcher.dart';
import 'package:client/reg/handler_registry.dart';
import 'package:client/reg/handlers.dart';
import 'package:client/ui/screens/inbox_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class _Backend {
  int httpCalls = 0;
  final List<List<Map<String, dynamic>>> batches = [];

  // Tasks pre-baked for the inbox: assignee=2, status != "done". Each
  // carries an optional `personal_sort_order` so the in-memory mock
  // can re-render after a `user_card_sort.set` write.
  final List<Map<String, dynamic>> inboxTasks;

  _Backend({List<Map<String, dynamic>>? tasks})
      : inboxTasks = tasks ??
            [
              {
                'id': 101,
                'title': 'Wire pickers',
                'status': 'todo',
                'assignee': 2,
                'tags': [201], // priority/high
                'personal_sort_order': 100.0,
              },
              {
                'id': 102,
                'title': 'API rate limits',
                'status': 'doing',
                'assignee': 2,
                'milestone_ref': 11,
                'component_ref': 22,
                'tags': [201, 301], // priority/high + area/backend
                'personal_sort_order': 200.0,
              },
              {
                'id': 103,
                'title': 'Empty grid',
                'status': 'review',
                'assignee': 2,
                'personal_sort_order': 300.0,
              },
            ];

  /// Re-sort the in-memory inbox tasks by personal_sort_order ASC, with
  /// nulls last (id ASC tie-breaker). Mirrors the server's ORDER BY.
  void _resort() {
    inboxTasks.sort((a, b) {
      final sa = a['personal_sort_order'] as double?;
      final sb = b['personal_sort_order'] as double?;
      if (sa != null && sb != null) {
        final c = sa.compareTo(sb);
        if (c != 0) return c;
        return (a['id'] as int).compareTo(b['id'] as int);
      }
      if (sa == null && sb == null) {
        return (a['id'] as int).compareTo(b['id'] as int);
      }
      return sa == null ? 1 : -1;
    });
  }

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
      if (endpoint == 'inbox' && action == 'select') {
        _resort();
        responses.add({
          'id': s['id'],
          'ok': true,
          'data': {
            'rows': [
              for (final t in inboxTasks)
                {
                  'id': t['id'],
                  'card_type_id': 2,
                  'parent_card_id': null,
                  'attributes': {
                    'title': t['title'],
                    if (t['status'] != null) 'status': t['status'],
                    if (t['assignee'] != null) 'assignee': t['assignee'],
                    if (t['milestone_ref'] != null)
                      'milestone_ref': t['milestone_ref'],
                    if (t['component_ref'] != null)
                      'component_ref': t['component_ref'],
                    if (t['tags'] != null) 'tags': t['tags'],
                  },
                  if (t['personal_sort_order'] != null)
                    'personal_sort_order': t['personal_sort_order'],
                },
            ],
          },
        });
      } else if (endpoint == 'card' && action == 'select_with_attributes') {
        final ctName = data['card_type_name'];
        if (ctName == 'milestone') {
          responses.add({
            'id': s['id'],
            'ok': true,
            'data': {
              'rows': [
                {
                  'id': 11,
                  'card_type_id': 3,
                  'card_type_name': 'milestone',
                  'parent_card_id': 1,
                  'attributes': {'title': 'M1'},
                },
              ],
            },
          });
        } else if (ctName == 'component') {
          responses.add({
            'id': s['id'],
            'ok': true,
            'data': {
              'rows': [
                {
                  'id': 22,
                  'card_type_id': 4,
                  'card_type_name': 'component',
                  'parent_card_id': 1,
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
              'rows': [
                {
                  'id': 201,
                  'card_type_id': 5,
                  'card_type_name': 'tag',
                  'parent_card_id': 1,
                  'attributes': {
                    'title': 'priority/high',
                    'path': 'priority/high',
                  },
                },
                {
                  'id': 301,
                  'card_type_id': 5,
                  'card_type_name': 'tag',
                  'parent_card_id': 1,
                  'attributes': {
                    'title': 'area/backend',
                    'path': 'area/backend',
                  },
                },
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
      } else if (endpoint == 'user' && action == 'select') {
        responses.add({
          'id': s['id'],
          'ok': true,
          'data': {
            'rows': const [
              {'id': 2, 'display_name': 'alice'},
              {'id': 3, 'display_name': 'bob'},
            ],
          },
        });
      } else if (endpoint == 'user_card_sort' && action == 'set') {
        final id = (data['card_id'] as num).toInt();
        final order = (data['sort_order'] as num).toDouble();
        for (final t in inboxTasks) {
          if (t['id'] == id) {
            t['personal_sort_order'] = order;
            break;
          }
        }
        responses.add({
          'id': s['id'],
          'ok': true,
          'data': {'ok': true},
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

/// Wide enough surface to host a draggable feedback layer cleanly.
Future<void> _setLargeSurface(WidgetTester tester) async {
  await tester.binding.setSurfaceSize(const Size(1024, 800));
  addTearDown(() => tester.binding.setSurfaceSize(null));
}

/// Drag the row identified by [cardKey] onto the slot identified by
/// [targetKey]. Same long-press-then-translate trick the kanban tests
/// use: a microtask hover step gives the DragTarget a chance to register
/// before the up event lands.
Future<void> _dragRow(
  WidgetTester tester, {
  required Key cardKey,
  required Key targetKey,
}) async {
  final source = tester.getCenter(find.byKey(cardKey));
  final target = tester.getCenter(find.byKey(targetKey));
  final gesture = await tester.startGesture(source);
  await tester.pump(const Duration(milliseconds: 600));
  await gesture.moveTo(Offset(
    (source.dx + target.dx) / 2,
    (source.dy + target.dy) / 2,
  ));
  await tester.pump(const Duration(milliseconds: 50));
  await gesture.moveTo(target);
  await tester.pump(const Duration(milliseconds: 200));
  await gesture.up();
  await tester.pumpAndSettle();
}

/// Drag from [handleKey] to [targetKey] without a long-press. The
/// handle uses an immediate `Draggable`, so we skip the 600ms hold
/// step that `_dragRow` uses.
Future<void> _dragHandle(
  WidgetTester tester, {
  required Key handleKey,
  required Key targetKey,
}) async {
  final source = tester.getCenter(find.byKey(handleKey));
  final target = tester.getCenter(find.byKey(targetKey));
  final gesture = await tester.startGesture(source);
  // Move just enough to clear the kPanSlop threshold.
  await gesture.moveBy(const Offset(0, 30));
  await tester.pump(const Duration(milliseconds: 50));
  await gesture.moveTo(Offset(
    (source.dx + target.dx) / 2,
    (source.dy + target.dy) / 2,
  ));
  await tester.pump(const Duration(milliseconds: 50));
  await gesture.moveTo(target);
  await tester.pump(const Duration(milliseconds: 200));
  await gesture.up();
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('inbox loads in ONE batch and renders 3 task rows',
      (tester) async {
    final backend = _Backend();
    await tester.pumpWidget(KitpApp(dispatcher: _dispatcher(backend)));
    await tester.pumpAndSettle();

    // Reset counters once we're past the initial Projects screen.
    backend.httpCalls = 0;
    backend.batches.clear();

    await tester.tap(find.byKey(const Key('nav-inbox')));
    await tester.pumpAndSettle();

    // EXACTLY ONE HTTP call for inbox entry.
    expect(backend.httpCalls, 1);

    // The single batch must contain the inbox.select call plus the
    // user/milestone/component/tag fetches (5 sub-requests in total).
    final subs = backend.batches.first;
    expect(subs.length, 5);
    final inboxSub = subs.firstWhere(
      (s) => s['endpoint'] == 'inbox' && s['action'] == 'select',
      orElse: () => const {},
    );
    expect(inboxSub.isNotEmpty, true,
        reason: 'inbox.select sub-request must be present');

    // Rows visible (we don't assert order here — kCurrentUserId hasn't
    // changed; that's still alice at id=2).
    expect(kCurrentUserId, 2);
    expect(find.byKey(const Key('task-row-101')), findsOneWidget);
    expect(find.byKey(const Key('task-row-102')), findsOneWidget);
    expect(find.byKey(const Key('task-row-103')), findsOneWidget);

    // Title text.
    expect(find.text('Wire pickers'), findsOneWidget);
    expect(find.text('API rate limits'), findsOneWidget);
    expect(find.text('Empty grid'), findsOneWidget);

    // Status chips render the value only (no "<label>: " prefix).
    expect(find.text('todo'), findsOneWidget);
    expect(find.text('doing'), findsOneWidget);
    expect(find.text('review'), findsOneWidget);

    // Assignee resolved to alice for all rows.
    expect(find.text('alice'), findsNWidgets(3));

    // Priority tag chip rendered for the two tasks that have it.
    expect(find.text('priority/high'), findsNWidgets(2));

    // Milestone + component chips for the second task.
    expect(find.text('M1'), findsOneWidget);
    expect(find.text('Backend'), findsOneWidget);

    // Tag chip for the non-priority tag on the second task.
    expect(find.text('area/backend'), findsOneWidget);

    // Inbox header reflects the count.
    expect(find.byKey(const Key('inbox-header')), findsOneWidget);
    expect(find.text('Inbox — 3 open tasks'), findsOneWidget);
  });

  testWidgets('inbox empty-state renders when no tasks match', (tester) async {
    final backend = _Backend()..inboxTasks.clear();
    await tester.pumpWidget(KitpApp(dispatcher: _dispatcher(backend)));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('nav-inbox')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('inbox-empty')), findsOneWidget);
    expect(find.text('Your inbox is clear.'), findsOneWidget);
  });

  testWidgets('drag last row to top fires ONE batch with one user_card_sort.set',
      (tester) async {
    await _setLargeSurface(tester);
    // Five rows so we have a clear "index 4 → index 0" target.
    final backend = _Backend(tasks: [
      {'id': 101, 'title': 'A', 'status': 'todo', 'assignee': 2, 'personal_sort_order': 100.0},
      {'id': 102, 'title': 'B', 'status': 'todo', 'assignee': 2, 'personal_sort_order': 200.0},
      {'id': 103, 'title': 'C', 'status': 'todo', 'assignee': 2, 'personal_sort_order': 300.0},
      {'id': 104, 'title': 'D', 'status': 'todo', 'assignee': 2, 'personal_sort_order': 400.0},
      {'id': 105, 'title': 'E', 'status': 'todo', 'assignee': 2, 'personal_sort_order': 500.0},
    ]);
    await tester.pumpWidget(KitpApp(dispatcher: _dispatcher(backend)));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('nav-inbox')));
    await tester.pumpAndSettle();

    final initialCalls = backend.httpCalls;
    expect(find.byKey(const Key('task-row-105')), findsOneWidget);
    expect(find.byKey(const Key('inbox-slot-0')), findsOneWidget);

    // Drag the last row (105) onto slot 0 (above the current first row).
    await _dragRow(
      tester,
      cardKey: const Key('task-row-105'),
      targetKey: const Key('inbox-slot-0'),
    );

    // ONE new HTTP call.
    expect(backend.httpCalls, initialCalls + 1);
    final batch = backend.batches.last;
    expect(batch.length, 1, reason: 'reorder should emit a single sub-request');
    final sub = batch.first;
    expect(sub['endpoint'], 'user_card_sort');
    expect(sub['action'], 'set');
    final data = sub['data'] as Map<String, dynamic>;
    expect(data['card_id'], 105);
    // Target slot is above row A (sort=100), so new sort = 100 - 100 = 0.
    expect((data['sort_order'] as num).toDouble(), 0.0);
  });

  testWidgets('each row exposes a drag handle on the leading edge',
      (tester) async {
    final backend = _Backend();
    await tester.pumpWidget(KitpApp(dispatcher: _dispatcher(backend)));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('nav-inbox')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('inbox-drag-handle-101')), findsOneWidget);
    expect(find.byKey(const Key('inbox-drag-handle-102')), findsOneWidget);
    expect(find.byKey(const Key('inbox-drag-handle-103')), findsOneWidget);
  });

  testWidgets('dragging the handle (no long-press) reorders the list',
      (tester) async {
    await _setLargeSurface(tester);
    final backend = _Backend(tasks: [
      {'id': 101, 'title': 'A', 'status': 'todo', 'assignee': 2, 'personal_sort_order': 100.0},
      {'id': 102, 'title': 'B', 'status': 'todo', 'assignee': 2, 'personal_sort_order': 200.0},
      {'id': 103, 'title': 'C', 'status': 'todo', 'assignee': 2, 'personal_sort_order': 300.0},
    ]);
    await tester.pumpWidget(KitpApp(dispatcher: _dispatcher(backend)));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('nav-inbox')));
    await tester.pumpAndSettle();

    final initialCalls = backend.httpCalls;

    // Grab the handle on row 103 and drag it to slot 0 (above A).
    await _dragHandle(
      tester,
      handleKey: const Key('inbox-drag-handle-103'),
      targetKey: const Key('inbox-slot-0'),
    );

    // ONE new HTTP call carrying ONE user_card_sort.set.
    expect(backend.httpCalls, initialCalls + 1);
    final batch = backend.batches.last;
    expect(batch.length, 1);
    final sub = batch.first;
    expect(sub['endpoint'], 'user_card_sort');
    expect(sub['action'], 'set');
    final data = sub['data'] as Map<String, dynamic>;
    expect(data['card_id'], 103);
    // Above A (sort=100) → sort = 100 - 100 = 0.
    expect((data['sort_order'] as num).toDouble(), 0.0);
  });

  testWidgets('drag from top to between two rows uses midpoint sort_order',
      (tester) async {
    await _setLargeSurface(tester);
    // Three rows so the math is unambiguous: drop at slot 2 (between B
    // and C) should use the midpoint of (200, 300) = 250.
    final backend = _Backend(tasks: [
      {'id': 101, 'title': 'A', 'status': 'todo', 'assignee': 2, 'personal_sort_order': 100.0},
      {'id': 102, 'title': 'B', 'status': 'todo', 'assignee': 2, 'personal_sort_order': 200.0},
      {'id': 103, 'title': 'C', 'status': 'todo', 'assignee': 2, 'personal_sort_order': 300.0},
    ]);
    await tester.pumpWidget(KitpApp(dispatcher: _dispatcher(backend)));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('nav-inbox')));
    await tester.pumpAndSettle();

    final initialCalls = backend.httpCalls;
    // Drag the top card (A=101) onto slot 2 (between B and C).
    expect(find.byKey(const Key('inbox-slot-2')), findsOneWidget);
    await _dragRow(
      tester,
      cardKey: const Key('task-row-101'),
      targetKey: const Key('inbox-slot-2'),
    );

    expect(backend.httpCalls, initialCalls + 1);
    final batch = backend.batches.last;
    expect(batch.length, 1);
    final sub = batch.first;
    expect(sub['endpoint'], 'user_card_sort');
    expect(sub['action'], 'set');
    final data = sub['data'] as Map<String, dynamic>;
    expect(data['card_id'], 101);
    // Slot 2 in a list of [A, B, C] sits between B and C. Removing A
    // first leaves [B, C]; slot 2 in [B, C] is the bottom — but the
    // screen adjusts insertAt down by 1 because A was originally above
    // it, leaving the effective slot at 1 (between B and C → midpoint
    // of (200, 300) = 250).
    expect((data['sort_order'] as num).toDouble(), 250.0);
  });
}
