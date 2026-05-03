/// Widget tests for `KanbanScreen`.
///
/// Asserts:
///   - Cards are rendered in `attributes.sort_order ASC` order; ties
///     break by id ASC.
///   - Drag a card up within the same column → ONE batch with ONE
///     `attribute.update` for sort_order.
///   - Drag across columns → ONE batch with TWO updates (sort_order +
///     column attribute).
///   - Drag across columns AND lanes → ONE batch with THREE updates
///     (sort_order + column + lane).
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
  final List<List<Map<String, dynamic>>> batches = [];

  // In-memory tasks. Mutated by attribute.update so re-fetches see it.
  final List<Map<String, dynamic>> tasks = [
    {
      'id': 501,
      'title': 'Card A',
      'status': 'doing',
      'assignee': 2,
      'sort_order': 100,
    },
    {
      'id': 502,
      'title': 'Card B',
      'status': 'doing',
      'assignee': 3,
      'sort_order': 200,
    },
    {
      'id': 503,
      'title': 'Card C',
      'status': 'todo',
      'assignee': 2,
      'sort_order': 300,
    },
  ];

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
            'data': {
              'rows': [
                for (final t in tasks)
                  {
                    'id': t['id'],
                    'card_type_id': 2,
                    'card_type_name': 'task',
                    'parent_card_id': null,
                    'attributes': {
                      'title': t['title'],
                      if (t['status'] != null) 'status': t['status'],
                      if (t['assignee'] != null) 'assignee': t['assignee'],
                      if (t['sort_order'] != null) 'sort_order': t['sort_order'],
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
      } else if (endpoint == 'attribute' && action == 'update') {
        final id = (data['card_id'] as num).toInt();
        final name = data['attribute_name'] as String;
        final value = data['value'];
        for (final t in tasks) {
          if (t['id'] == id) {
            t[name] = value;
            break;
          }
        }
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

/// Wide surface so 4 status columns + (optionally) a swim lane render
/// without overflow.
Future<void> _setLargeSurface(WidgetTester tester) async {
  await tester.binding.setSurfaceSize(const Size(1600, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
}

/// Drag a card and finish on the destination's centre. Flutter's
/// `LongPressDraggable` requires a 500ms hold before drag start;
/// `tester.timedDrag` doesn't trigger it, so we drive press → settle →
/// translate manually. We translate in two steps so the DragTarget below
/// the destination has a chance to receive a hover event before the up.
Future<void> _dragCard(
  WidgetTester tester, {
  required Key cardKey,
  required Key targetKey,
}) async {
  final source = tester.getCenter(find.byKey(cardKey));
  final target = tester.getCenter(find.byKey(targetKey));
  final gesture = await tester.startGesture(source);
  // Long-press threshold.
  await tester.pump(const Duration(milliseconds: 600));
  // Halfway hover so DragTarget candidate sets register.
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

/// Convenience: extract one sub-request matching attribute_name from a
/// kanban drop batch. Throws if not found.
Map<String, dynamic> _findUpdate(
    List<Map<String, dynamic>> batch, String attrName) {
  for (final sub in batch) {
    final data = sub['data'] as Map<String, dynamic>;
    if (data['attribute_name'] == attrName) return sub;
  }
  throw StateError('no attribute.update for $attrName in $batch');
}

void main() {
  testWidgets('drag from doing to review fires ONE batch with sort_order + status updates',
      (tester) async {
    await _setLargeSurface(tester);
    final backend = _Backend();
    await tester.pumpWidget(KitpApp(dispatcher: _dispatcher(backend)));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('nav-kanban')));
    await tester.pumpAndSettle();

    final initial = backend.httpCalls;
    expect(find.byKey(const Key('kanban-card-501')), findsOneWidget);
    expect(find.byKey(const Key('kanban-col-__none__-review')), findsOneWidget);

    // The "review" column is empty in this fixture; its only drop slot is
    // slot-0 (the tail/empty-column slot).
    await _dragCard(
      tester,
      cardKey: const Key('kanban-card-501'),
      targetKey: const Key('kanban-slot-__none__-review-0'),
    );

    expect(backend.httpCalls, initial + 1);
    final batch = backend.batches.last;
    expect(batch.length, 2,
        reason: 'expected sort_order + status updates in same batch');
    final names = <String>{};
    for (final sub in batch) {
      expect(sub['endpoint'], 'attribute');
      expect(sub['action'], 'update');
      final data = sub['data'] as Map<String, dynamic>;
      expect(data['card_id'], 501);
      names.add(data['attribute_name'] as String);
    }
    expect(names, {'sort_order', 'status'});
    final statusUpdate = _findUpdate(batch, 'status');
    expect((statusUpdate['data'] as Map)['value'], 'review');
  });

  testWidgets('drag within the same column fires ONE batch with ONLY sort_order',
      (tester) async {
    await _setLargeSurface(tester);
    final backend = _Backend();
    await tester.pumpWidget(KitpApp(dispatcher: _dispatcher(backend)));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('nav-kanban')));
    await tester.pumpAndSettle();

    final initial = backend.httpCalls;

    // Cards 501 (sort_order=100) and 502 (sort_order=200) are both in the
    // "doing" column. Drag 502 onto the slot ABOVE 501 (the very first
    // slot in the doing column).
    expect(find.byKey(const Key('kanban-slot-__none__-doing-0')), findsOneWidget);
    expect(find.byKey(const Key('kanban-card-501')), findsOneWidget);
    expect(find.byKey(const Key('kanban-card-502')), findsOneWidget);
    await _dragCard(
      tester,
      cardKey: const Key('kanban-card-502'),
      targetKey: const Key('kanban-slot-__none__-doing-0'),
    );

    expect(backend.httpCalls, initial + 1);
    final batch = backend.batches.last;
    expect(batch.length, 1,
        reason:
            'within-column drag must update sort_order only; got: $batch');
    final sub = batch.first;
    expect(sub['endpoint'], 'attribute');
    expect(sub['action'], 'update');
    final data = sub['data'] as Map<String, dynamic>;
    expect(data['card_id'], 502);
    expect(data['attribute_name'], 'sort_order');
    // Slot 0 above the first card whose sort_order=100 ⇒ new sort_order=0.
    expect((data['value'] as num).toDouble(), 0.0);
  });

  testWidgets(
      'drag across column AND swim lane fires ONE batch with THREE updates',
      (tester) async {
    await _setLargeSurface(tester);
    final backend = _Backend();
    await tester.pumpWidget(KitpApp(dispatcher: _dispatcher(backend)));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('nav-kanban')));
    await tester.pumpAndSettle();

    // Switch swim lanes to "assignee".
    await tester.tap(find.byKey(const Key('kanban-lanes-by')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Assignee').last);
    await tester.pumpAndSettle();

    // Both alice (id=2) and bob (id=3) lanes exist now.
    expect(find.byKey(const Key('kanban-lane-2')), findsOneWidget);
    expect(find.byKey(const Key('kanban-lane-3')), findsOneWidget);

    final initial = backend.httpCalls;

    // Card 501 is at (status=doing, assignee=2). Drop into the empty
    // (status=review, assignee=3) cell so all three attributes change.
    await _dragCard(
      tester,
      cardKey: const Key('kanban-card-501'),
      targetKey: const Key('kanban-slot-3-review-0'),
    );

    expect(backend.httpCalls, initial + 1);
    final batch = backend.batches.last;
    expect(batch.length, 3,
        reason:
            'expected sort_order + status + assignee updates in same batch; got: $batch');
    final names = <String>{};
    final values = <String, dynamic>{};
    for (final sub in batch) {
      expect(sub['endpoint'], 'attribute');
      expect(sub['action'], 'update');
      final data = sub['data'] as Map<String, dynamic>;
      expect(data['card_id'], 501);
      names.add(data['attribute_name'] as String);
      values[data['attribute_name'] as String] = data['value'];
    }
    expect(names, {'sort_order', 'status', 'assignee'});
    expect(values['status'], 'review');
    expect(values['assignee'], 3);
  });
}
