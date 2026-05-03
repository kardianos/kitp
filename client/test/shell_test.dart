import 'dart:convert';

import 'package:client/app.dart';
import 'package:client/dispatch/dispatcher.dart';
import 'package:client/reg/handler_registry.dart';
import 'package:client/reg/handlers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// Build a Dispatcher that answers every batch with `subresponses` mirroring
/// each sub-request's id, ok=true, data={}. The ProjectsScreen on entry
/// fires one `card.select_with_attributes` request — this lets it succeed
/// with an empty rows list so the shell-routing tests can run.
Dispatcher _testDispatcher() {
  final reg = HandlerRegistry();
  registerBuiltInHandlers(reg);
  final client = MockClient((req) async {
    final body = jsonDecode(req.body) as Map<String, dynamic>;
    final subs = (body['subrequests'] as List).cast<Map<String, dynamic>>();
    final responses = [
      for (final s in subs)
        {
          'id': s['id'],
          'ok': true,
          'data': const {'rows': []},
        }
    ];
    return http.Response(jsonEncode({'subresponses': responses}), 200,
        headers: {'content-type': 'application/json'});
  });
  return Dispatcher(
    httpClient: client,
    registry: reg,
    apiBase: 'http://test.invalid',
  );
}

void main() {
  testWidgets('app shell renders both nav items and starts on Projects', (tester) async {
    await tester.pumpWidget(KitpApp(dispatcher: _testDispatcher()));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('nav-projects')), findsOneWidget);
    expect(find.byKey(const Key('nav-inbox')), findsOneWidget);
    // ProjectsScreen empty state.
    expect(find.byKey(const Key('projects-empty')), findsOneWidget);
  });

  testWidgets('tapping Inbox routes to the inbox screen', (tester) async {
    await tester.pumpWidget(KitpApp(dispatcher: _testDispatcher()));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('projects-empty')), findsOneWidget);

    await tester.tap(find.byKey(const Key('nav-inbox')));
    await tester.pumpAndSettle();

    // Mock backend returns empty rows for every sub-request, so the
    // inbox renders its empty-state copy.
    expect(find.byKey(const Key('inbox-empty')), findsOneWidget);
    expect(find.byKey(const Key('projects-empty')), findsNothing);
  });

  testWidgets('Projects nav routes back to projects', (tester) async {
    await tester.pumpWidget(KitpApp(dispatcher: _testDispatcher()));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('nav-inbox')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('nav-projects')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('projects-empty')), findsOneWidget);
  });
}
