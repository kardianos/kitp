/// Widget tests for `ProjectsScreen`.
///
/// We use a `MockClient` so the test runs without a real server. The
/// dispatcher is wired up exactly as in production (registry + Dispatcher),
/// so the call counts asserted here match what the live app would issue.
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

/// In-memory project list mutated by inserts.
class _Backend {
  final List<Map<String, dynamic>> projects = [];
  int _nextId = 100;
  int httpCalls = 0;

  http.Response handle(http.Request req) {
    httpCalls++;
    final body = jsonDecode(req.body) as Map<String, dynamic>;
    final subs = (body['subrequests'] as List).cast<Map<String, dynamic>>();
    final responses = <Map<String, dynamic>>[];
    for (final s in subs) {
      final endpoint = s['endpoint'] as String;
      final action = s['action'] as String;
      final data = (s['data'] as Map?)?.cast<String, dynamic>() ?? const {};
      if (endpoint == 'card' && action == 'select_with_attributes') {
        responses.add({
          'id': s['id'],
          'ok': true,
          'data': {
            'rows': [
              for (final p in projects)
                {
                  'id': p['id'],
                  'card_type_id': 1,
                  'card_type_name': 'project',
                  'parent_card_id': null,
                  'attributes': {'title': p['title']},
                }
            ]
          },
        });
      } else if (endpoint == 'card' && action == 'insert') {
        final id = _nextId++;
        projects.add({'id': id, 'title': data['title']});
        responses.add({
          'id': s['id'],
          'ok': true,
          'data': {'id': id},
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

void main() {
  testWidgets('empty → create two projects → list shows both', (tester) async {
    final backend = _Backend();
    await tester.pumpWidget(KitpApp(dispatcher: _dispatcher(backend)));
    await tester.pumpAndSettle();

    // Initial fetch happens in one HTTP call.
    expect(backend.httpCalls, 1);
    expect(find.byKey(const Key('projects-empty')), findsOneWidget);

    // Open the create dialog and submit "Alpha".
    await tester.tap(find.byKey(const Key('projects-new-fab')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('new-project-title')), findsOneWidget);
    await tester.enterText(
        find.byKey(const Key('new-project-title')), 'Alpha');
    await tester.tap(find.byKey(const Key('new-project-submit')));
    await tester.pumpAndSettle();

    // After create + refresh: 1 (initial) + 1 (insert) + 1 (refresh) = 3.
    expect(backend.httpCalls, 3);
    expect(find.text('Alpha'), findsOneWidget);

    // Submit a second project, "Beta".
    await tester.tap(find.byKey(const Key('projects-new-fab')));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.byKey(const Key('new-project-title')), 'Beta');
    await tester.tap(find.byKey(const Key('new-project-submit')));
    await tester.pumpAndSettle();

    expect(backend.httpCalls, 5);
    expect(find.text('Alpha'), findsOneWidget);
    expect(find.text('Beta'), findsOneWidget);
    expect(find.byKey(const Key('projects-list')), findsOneWidget);
    expect(find.byKey(const Key('projects-empty')), findsNothing);
  });

  testWidgets('error from server is surfaced to the user', (tester) async {
    final reg = HandlerRegistry();
    registerBuiltInHandlers(reg);
    final dispatcher = Dispatcher(
      httpClient: MockClient((req) async {
        return http.Response('boom', 503);
      }),
      registry: reg,
      apiBase: 'http://test.invalid',
    );
    await tester.pumpWidget(KitpApp(dispatcher: dispatcher));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('projects-error')), findsOneWidget);
  });
}
