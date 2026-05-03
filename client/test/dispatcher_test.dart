import 'dart:convert';

import 'package:client/dispatch/dispatcher.dart';
import 'package:client/dispatch/errors.dart';
import 'package:client/reg/handler_registry.dart';
import 'package:client/reg/handlers.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// Build a dispatcher whose flush is synchronous: tests `await
/// dispatcher.flushNow()` (or just await any of the futures, which the
/// dispatcher itself flushes via the supplied `scheduleFlush` hook).
Dispatcher _build({
  required MockClient client,
  void Function(void Function() flush)? schedule,
}) {
  final reg = HandlerRegistry();
  registerBuiltInHandlers(reg);
  return Dispatcher(
    httpClient: client,
    registry: reg,
    apiBase: 'http://test.invalid',
    scheduleFlush: schedule ?? (flush) => Future.microtask(flush),
  );
}

void main() {
  test('three concurrent requests in one frame produce one HTTP call', () async {
    int httpCalls = 0;
    List<dynamic> seenSubrequests = [];

    final client = MockClient((req) async {
      httpCalls++;
      final body = jsonDecode(req.body) as Map<String, dynamic>;
      seenSubrequests = body['subrequests'] as List<dynamic>;
      // Echo each id back with ok=true.
      final responses = [
        for (final raw in seenSubrequests)
          {
            'id': (raw as Map)['id'],
            'ok': true,
            'data': {'x': (raw['data'] as Map)['x'], 'message': raw['data']['message']},
          }
      ];
      return http.Response(jsonEncode({'subresponses': responses}), 200,
          headers: {'content-type': 'application/json'});
    });

    final dispatcher = _build(client: client);

    final f1 = dispatcher.request<EchoPingInput, EchoPingOutput>(
      endpoint: 'echo',
      action: 'ping',
      data: const EchoPingInput(x: 1, message: 'a'),
    );
    final f2 = dispatcher.request<EchoPingInput, EchoPingOutput>(
      endpoint: 'echo',
      action: 'ping',
      data: const EchoPingInput(x: 2, message: 'b'),
    );
    final f3 = dispatcher.request<EchoPingInput, EchoPingOutput>(
      endpoint: 'echo',
      action: 'ping',
      data: const EchoPingInput(x: 3, message: 'c'),
    );

    final results = await Future.wait([f1, f2, f3]);
    expect(httpCalls, 1);
    expect(seenSubrequests.length, 3);
    expect(results.map((r) => r.x).toList(), [1, 2, 3]);
    expect(results.map((r) => r.message).toList(), ['a', 'b', 'c']);
  });

  test('sub-response routing matches by id under shuffled order', () async {
    final client = MockClient((req) async {
      final body = jsonDecode(req.body) as Map<String, dynamic>;
      final subs = (body['subrequests'] as List).cast<Map<String, dynamic>>();
      // Reverse the response order. Routing must still resolve each future
      // with the correct payload.
      final responses = [
        for (final s in subs.reversed)
          {
            'id': s['id'],
            'ok': true,
            'data': {
              'x': (s['data'] as Map)['x'],
              'message': (s['data'] as Map)['message'],
            },
          }
      ];
      return http.Response(jsonEncode({'subresponses': responses}), 200);
    });

    final dispatcher = _build(client: client);

    final fa = dispatcher.request<EchoPingInput, EchoPingOutput>(
      endpoint: 'echo',
      action: 'ping',
      data: const EchoPingInput(x: 10, message: 'alpha'),
    );
    final fb = dispatcher.request<EchoPingInput, EchoPingOutput>(
      endpoint: 'echo',
      action: 'ping',
      data: const EchoPingInput(x: 20, message: 'beta'),
    );
    final fc = dispatcher.request<EchoPingInput, EchoPingOutput>(
      endpoint: 'echo',
      action: 'ping',
      data: const EchoPingInput(x: 30, message: 'gamma'),
    );

    final a = await fa;
    final b = await fb;
    final c = await fc;
    expect(a.x, 10);
    expect(a.message, 'alpha');
    expect(b.x, 20);
    expect(b.message, 'beta');
    expect(c.x, 30);
    expect(c.message, 'gamma');
  });

  test('aborted error code is mapped to BatchAbortedError on that future', () async {
    final client = MockClient((req) async {
      final body = jsonDecode(req.body) as Map<String, dynamic>;
      final subs = (body['subrequests'] as List).cast<Map<String, dynamic>>();
      // First sub-request: ok. Second: error.code=aborted.
      return http.Response(jsonEncode({
        'subresponses': [
          {
            'id': subs[0]['id'],
            'ok': true,
            'data': {'x': 7, 'message': 'ok'},
          },
          {
            'id': subs[1]['id'],
            'ok': false,
            'error': {'code': 'aborted', 'message': 'rolled back'},
          },
        ]
      }), 200);
    });

    final dispatcher = _build(client: client);
    final f1 = dispatcher.request<EchoPingInput, EchoPingOutput>(
      endpoint: 'echo',
      action: 'ping',
      data: const EchoPingInput(x: 7, message: 'ok'),
    );
    final f2 = dispatcher.request<EchoPingInput, EchoPingOutput>(
      endpoint: 'echo',
      action: 'ping',
      data: const EchoPingInput(x: 9, message: 'will-abort'),
    );
    final r1 = await f1;
    expect(r1.x, 7);
    await expectLater(f2, throwsA(isA<BatchAbortedError>()));
  });

  test('non-aborted error code becomes SubRequestError', () async {
    final client = MockClient((req) async {
      final body = jsonDecode(req.body) as Map<String, dynamic>;
      final subs = (body['subrequests'] as List).cast<Map<String, dynamic>>();
      return http.Response(jsonEncode({
        'subresponses': [
          {
            'id': subs[0]['id'],
            'ok': false,
            'error': {'code': 'not_found', 'message': 'no such row'},
          }
        ]
      }), 200);
    });
    final dispatcher = _build(client: client);
    final f = dispatcher.request<EchoPingInput, EchoPingOutput>(
      endpoint: 'echo',
      action: 'ping',
      data: const EchoPingInput(x: 1, message: 'm'),
    );
    await expectLater(
      f,
      throwsA(isA<SubRequestError>()
          .having((e) => e.code, 'code', 'not_found')
          .having((e) => e.message, 'message', 'no such row')),
    );
  });

  test('http 5xx fails every pending future with BatchAbortedError', () async {
    final client = MockClient((req) async {
      return http.Response('boom', 503);
    });
    final dispatcher = _build(client: client);
    final f1 = dispatcher.request<EchoPingInput, EchoPingOutput>(
      endpoint: 'echo',
      action: 'ping',
      data: const EchoPingInput(x: 1, message: 'a'),
    );
    final f2 = dispatcher.request<EchoPingInput, EchoPingOutput>(
      endpoint: 'echo',
      action: 'ping',
      data: const EchoPingInput(x: 2, message: 'b'),
    );
    await expectLater(
      f1,
      throwsA(isA<BatchAbortedError>().having((e) => e.reason, 'reason', 'http_503')),
    );
    await expectLater(f2, throwsA(isA<BatchAbortedError>()));
  });

  test('network failure fails every pending future with BatchAbortedError', () async {
    final client = MockClient((req) async {
      throw http.ClientException('connection refused');
    });
    final dispatcher = _build(client: client);
    final f1 = dispatcher.request<EchoPingInput, EchoPingOutput>(
      endpoint: 'echo',
      action: 'ping',
      data: const EchoPingInput(x: 1, message: 'a'),
    );
    final f2 = dispatcher.request<EchoPingInput, EchoPingOutput>(
      endpoint: 'echo',
      action: 'ping',
      data: const EchoPingInput(x: 2, message: 'b'),
    );
    await expectLater(f1, throwsA(isA<BatchAbortedError>()));
    await expectLater(f2, throwsA(isA<BatchAbortedError>()));
  });

  test('unknown handler resolves locally as SubRequestError', () async {
    final client = MockClient((req) async {
      // Should never fire; the dispatcher rejects before the HTTP call.
      throw StateError('unexpected http call');
    });
    final dispatcher = _build(client: client);
    final f = dispatcher.request<EchoPingInput, EchoPingOutput>(
      endpoint: 'no_such',
      action: 'go',
      data: const EchoPingInput(x: 0, message: ''),
    );
    await expectLater(
      f,
      throwsA(isA<SubRequestError>().having((e) => e.code, 'code', 'unknown_handler')),
    );
  });
}
