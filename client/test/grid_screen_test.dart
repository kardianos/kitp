/// Widget tests for `GridScreen`.
///
/// Asserts:
///   - Opening the grid issues EXACTLY ONE HTTP call.
///   - Sorting (clicking a header) issues exactly one new batch.
///   - Filtering (deselecting a status chip) issues exactly one new batch.
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
              'rows': const [
                {
                  'id': 401,
                  'card_type_id': 2,
                  'card_type_name': 'task',
                  'parent_card_id': 1,
                  'attributes': {
                    'title': 'Alpha',
                    'status': 'todo',
                    'assignee': 2,
                  },
                },
                {
                  'id': 402,
                  'card_type_id': 2,
                  'card_type_name': 'task',
                  'parent_card_id': 1,
                  'attributes': {
                    'title': 'Beta',
                    'status': 'doing',
                    'assignee': 3,
                  },
                },
                {
                  'id': 403,
                  'card_type_id': 2,
                  'card_type_name': 'task',
                  'parent_card_id': 1,
                  'attributes': {
                    'title': 'Gamma',
                    'status': 'review',
                  },
                },
                {
                  'id': 404,
                  'card_type_id': 2,
                  'card_type_name': 'task',
                  'parent_card_id': 1,
                  'attributes': {
                    'title': 'Delta',
                    'status': 'done',
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

/// The dense grid is wider than the default 800px test viewport, so we
/// crank the surface up to a real laptop width before pumping the app.
Future<void> _setLargeSurface(WidgetTester tester) async {
  await tester.binding.setSurfaceSize(const Size(1600, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
}

void main() {
  testWidgets('grid loads in ONE batch with 4 rows', (tester) async {
    await _setLargeSurface(tester);
    final backend = _Backend();
    await tester.pumpWidget(KitpApp(dispatcher: _dispatcher(backend)));
    await tester.pumpAndSettle();

    backend.httpCalls = 0;
    backend.batches.clear();

    await tester.tap(find.byKey(const Key('nav-grid')));
    await tester.pumpAndSettle();

    expect(backend.httpCalls, 1);
    expect(find.byKey(const Key('grid-row-401')), findsOneWidget);
    expect(find.byKey(const Key('grid-row-402')), findsOneWidget);
    expect(find.byKey(const Key('grid-row-403')), findsOneWidget);
    expect(find.byKey(const Key('grid-row-404')), findsOneWidget);
    expect(find.byKey(const Key('grid-row-count')), findsOneWidget);
  });

  testWidgets('clicking the Status header sorts (1 new batch)',
      (tester) async {
    await _setLargeSurface(tester);
    final backend = _Backend();
    await tester.pumpWidget(KitpApp(dispatcher: _dispatcher(backend)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('nav-grid')));
    await tester.pumpAndSettle();

    final initial = backend.httpCalls;

    await tester.tap(find.byKey(const Key('grid-header-status')));
    await tester.pumpAndSettle();

    // Exactly one new HTTP batch.
    expect(backend.httpCalls, initial + 1);
    final newBatch = backend.batches.last;
    final taskSub = newBatch.firstWhere(
      (s) =>
          s['endpoint'] == 'card' &&
          s['action'] == 'select_with_attributes' &&
          (s['data'] as Map)['card_type_name'] == 'task',
    );
    final order = ((taskSub['data'] as Map)['order'] as List)
        .cast<Map<String, dynamic>>();
    expect(order.length, 1);
    expect(order[0]['field'], 'attributes.status');
    expect(order[0]['direction'], 'ASC');

    // Toggle direction with a second click → another single batch.
    final beforeSecond = backend.httpCalls;
    await tester.tap(find.byKey(const Key('grid-header-status')));
    await tester.pumpAndSettle();
    expect(backend.httpCalls, beforeSecond + 1);
    final secondBatch = backend.batches.last;
    final taskSub2 = secondBatch.firstWhere(
      (s) =>
          s['endpoint'] == 'card' &&
          s['action'] == 'select_with_attributes' &&
          (s['data'] as Map)['card_type_name'] == 'task',
    );
    final order2 = ((taskSub2['data'] as Map)['order'] as List)
        .cast<Map<String, dynamic>>();
    expect(order2[0]['direction'], 'DESC');
  });

  testWidgets('initial load sends the default status filter as tree',
      (tester) async {
    await _setLargeSurface(tester);
    final backend = _Backend();
    await tester.pumpWidget(KitpApp(dispatcher: _dispatcher(backend)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('nav-grid')));
    await tester.pumpAndSettle();

    // The screen seeds a default `status in (todo, doing, review, done)`
    // predicate so the FilterBar shows a single chip on entry. The wire
    // shape is the new `tree:` field — no legacy `where[]`.
    final batch = backend.batches.last;
    final taskSub = batch.firstWhere(
      (s) =>
          s['endpoint'] == 'card' &&
          s['action'] == 'select_with_attributes' &&
          (s['data'] as Map)['card_type_name'] == 'task',
    );
    // Wire shape: a top-level AND group wrapping the default status leaf.
    // The wrap is required so the server's CardWhereGroup root has a
    // connective; bare leaves at the root are rejected.
    final tree = (taskSub['data'] as Map)['tree'] as Map<String, dynamic>?;
    expect(tree, isNotNull);
    expect(tree!['connective'], 'and');
    final children = (tree['children'] as List).cast<Map<String, dynamic>>();
    expect(children, hasLength(1));
    final leaf = children.first;
    expect(leaf['attr'], 'status');
    expect(leaf['op'], 'in');
    final values = (leaf['values'] as List).cast<String>();
    expect(values.toSet(), {'todo', 'doing', 'review', 'done'});

    // The bar renders one removable chip for that default predicate.
    expect(find.byKey(const Key('filter-chip-0')), findsOneWidget);
  });

  testWidgets('removing the default filter chip clears the tree (1 new batch)',
      (tester) async {
    await _setLargeSurface(tester);
    final backend = _Backend();
    await tester.pumpWidget(KitpApp(dispatcher: _dispatcher(backend)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('nav-grid')));
    await tester.pumpAndSettle();

    final initial = backend.httpCalls;

    // Tap the chip's delete (X) icon — InputChip exposes it as a
    // close icon nested inside the chip; finding by the close icon
    // descendant of the chip is the most direct route.
    final chip = find.byKey(const Key('filter-chip-0'));
    expect(chip, findsOneWidget);
    final delete = find.descendant(
      of: chip,
      matching: find.byType(Icon),
    );
    await tester.tap(delete.last);
    await tester.pumpAndSettle();

    expect(backend.httpCalls, initial + 1);
    final batch = backend.batches.last;
    final taskSub = batch.firstWhere(
      (s) =>
          s['endpoint'] == 'card' &&
          s['action'] == 'select_with_attributes' &&
          (s['data'] as Map)['card_type_name'] == 'task',
    );
    // No filter → no `tree` field on the wire; the legacy `where` field
    // is also absent so the server scans every (non-deleted) task.
    expect((taskSub['data'] as Map).containsKey('tree'), isFalse);
    expect((taskSub['data'] as Map).containsKey('where'), isFalse);
  });
}
