/// Central data dispatcher: every widget that wants server data goes through
/// here, every render frame produces at most one HTTP `POST /api/v1/batch`
/// (REQUIREMENTS N-CLI-1/2/3).
///
/// Lifecycle of a `request()` call:
///   1. We assign the sub-request a UUID, encode its `data` via the registry,
///      stash a [Completer] keyed by id, and append the wire-shape SubRequest
///      to a pending queue.
///   2. The first call in any batching window schedules a flush callback
///      (microtask by default, frame callback when running inside a
///      WidgetsBinding). Subsequent calls in the same window just append.
///   3. On flush we POST the whole queue, decode each sub-response, route
///      success/error/aborted onto each completer.
///
/// Why microtask + frame: in widget code, multiple `initState` paths invoking
/// the dispatcher resolve in the same frame and we want them coalesced.
/// Tests don't always pump frames, so falling back to a microtask keeps
/// pure-Dart `flutter test` behaviour identical.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/scheduler.dart';
import 'package:http/http.dart' as http;
import 'package:uuid/uuid.dart';

import '../auth/auth_state.dart';
import '../reg/handler_registry.dart';
import 'errors.dart';
import 'subrequest.dart';

/// Reads the API base URL injected via `--dart-define=KITP_API_BASE=...`,
/// defaulting to `http://localhost:8080`.
const String _kDefaultApiBase = String.fromEnvironment(
  'KITP_API_BASE',
  defaultValue: 'http://localhost:8080',
);

class Dispatcher {
  /// HTTP client. Tests inject a `MockClient`; production uses
  /// `http.Client()`.
  final http.Client httpClient;

  /// Base URL of the kitp API server. The dispatcher appends
  /// `/api/v1/batch` itself so callers cannot drift the path.
  final String apiBase;

  /// Registry the dispatcher consults to encode `data` payloads. The
  /// dispatcher itself does not require the registry to look up endpoints
  /// it sees — it just uses it to encode user-supplied typed inputs and to
  /// know that a destination handler exists. We keep the registry on the
  /// dispatcher (rather than as a parameter to every `request()`) because
  /// every call site needs the same registry.
  final HandlerRegistry registry;

  /// Optional override for the flush scheduler. The default schedules a
  /// frame callback when a binding is available, falling back to a
  /// microtask. Tests override this so they can synchronously assert
  /// "exactly one HTTP call" without pumping a fake frame.
  final void Function(void Function() flush)? scheduleFlush;

  /// Optional auth state. When non-null and signed in, the dispatcher
  /// attaches `Authorization: Bearer <access_token>` to each batch POST.
  /// Tests pass null; production wires in the real AuthState.
  final AuthState? authState;

  /// Optional refresh hook. Called when the dispatcher sees a 401 and
  /// `authState.isSignedIn` is true. Should return true if the token was
  /// rotated successfully; false (or thrown error) means re-login is
  /// required and the dispatcher fails the in-flight batch.
  final Future<bool> Function()? onUnauthorized;

  final _Uuid _uuid = const _Uuid();

  /// In-flight batch buffer. Cleared at the start of every flush.
  final List<_Pending> _queue = [];

  /// True once we have asked the scheduler for a flush callback. Reset to
  /// false at the very top of `_flush`.
  bool _flushScheduled = false;

  Dispatcher({
    required this.httpClient,
    required this.registry,
    this.apiBase = _kDefaultApiBase,
    this.scheduleFlush,
    this.authState,
    this.onUnauthorized,
  });

  /// Construct a dispatcher with sensible production defaults: a fresh
  /// `http.Client`, the configured base URL, and a [HandlerRegistry] with
  /// every built-in handler registered. The optional [registry] argument is
  /// for callers that already built one.
  factory Dispatcher.production({
    HandlerRegistry? registry,
    http.Client? httpClient,
    String? apiBase,
    AuthState? authState,
    Future<bool> Function()? onUnauthorized,
  }) {
    final reg = registry ?? HandlerRegistry();
    return Dispatcher(
      httpClient: httpClient ?? http.Client(),
      registry: reg,
      apiBase: apiBase ?? _kDefaultApiBase,
      authState: authState,
      onUnauthorized: onUnauthorized,
    );
  }

  /// Submit one sub-request. Resolves with the typed `R` decoded from the
  /// matching sub-response, or fails with [SubRequestError] /
  /// [BatchAbortedError].
  ///
  /// All `request()` calls in the same flush window share one HTTP call.
  Future<R> request<I, R>({
    required String endpoint,
    required String action,
    String type = 'data',
    Map<String, dynamic> ref = const {},
    Map<String, dynamic> key = const {},
    I? data,
  }) {
    final spec = registry.lookup(endpoint, action);
    if (spec == null) {
      return Future.error(
        SubRequestError(
          'unknown_handler',
          'no client registration for $endpoint.$action',
        ),
      );
    }
    final id = _uuid.v4();
    final encoded = data == null ? null : spec.encode(data);

    final sub = SubRequest(
      id: id,
      type: type,
      endpoint: endpoint,
      action: action,
      ref: ref,
      key: key,
      data: encoded,
    );
    final completer = Completer<R>();
    _queue.add(_Pending(
      sub: sub,
      decode: spec.decode,
      completer: completer,
    ));
    _maybeScheduleFlush();
    return completer.future;
  }

  /// Force an immediate flush. Tests sometimes want to bypass the scheduler.
  Future<void> flushNow() => _flush();

  void _maybeScheduleFlush() {
    if (_flushScheduled) return;
    _flushScheduled = true;
    final s = scheduleFlush;
    if (s != null) {
      s(() {
        _flush();
      });
      return;
    }
    // Inside a Flutter binding, prefer a frame callback so any synchronous
    // burst of `request()` calls inside one build pass coalesces. Outside
    // a binding (pure-Dart tests), a microtask is the closest equivalent
    // and keeps things ordered.
    final binding = SchedulerBinding.instance;
    // ignore: unnecessary_null_comparison
    if (binding != null) {
      binding.scheduleFrameCallback((_) => _flush());
      // Some test environments install a binding but never pump a frame.
      // Belt-and-suspenders: also schedule a microtask, with a guard so
      // whichever fires first wins. _flush() resets _flushScheduled and
      // empties the queue, so the second invocation is a no-op.
      scheduleMicrotask(_flush);
    } else {
      scheduleMicrotask(_flush);
    }
  }

  Future<void> _flush() async {
    if (!_flushScheduled) return;
    _flushScheduled = false;
    if (_queue.isEmpty) return;

    final batch = List<_Pending>.unmodifiable(_queue);
    _queue.clear();

    final body = jsonEncode({
      'subrequests': [for (final p in batch) p.sub.toJson()],
    });

    Map<String, String> _headers() {
      final h = <String, String>{'Content-Type': 'application/json'};
      final tok = authState?.accessToken;
      if (tok != null && tok.isNotEmpty) {
        h['Authorization'] = 'Bearer $tok';
      }
      return h;
    }

    http.Response resp;
    try {
      resp = await httpClient.post(
        Uri.parse('$apiBase/api/v1/batch'),
        headers: _headers(),
        body: body,
      );
    } catch (e) {
      _failAll(batch, BatchAbortedError(e.toString()));
      return;
    }

    // 401: try one refresh + retry. On second 401 we surface the failure
    // to the caller (they can route to login).
    if (resp.statusCode == 401 && authState?.isSignedIn == true && onUnauthorized != null) {
      try {
        final ok = await onUnauthorized!();
        if (ok) {
          resp = await httpClient.post(
            Uri.parse('$apiBase/api/v1/batch'),
            headers: _headers(),
            body: body,
          );
        }
      } catch (_) {
        // Fall through — we'll fail the batch below.
      }
    }

    if (resp.statusCode >= 500) {
      _failAll(batch, BatchAbortedError('http_${resp.statusCode}'));
      return;
    }
    if (resp.statusCode >= 400) {
      // 4xx: malformed request from us. Surface as an aborted batch so the
      // contract ("either every future succeeds or every future has an
      // exception") is preserved — there are no per-sub-response slots in
      // a 4xx body.
      _failAll(batch, BatchAbortedError('http_${resp.statusCode}'));
      return;
    }

    Map<String, dynamic> decoded;
    try {
      decoded = jsonDecode(resp.body) as Map<String, dynamic>;
    } catch (e) {
      _failAll(batch, BatchAbortedError('bad_response: $e'));
      return;
    }
    final raw = decoded['subresponses'];
    if (raw is! List) {
      _failAll(batch, const BatchAbortedError('bad_response: no subresponses'));
      return;
    }

    final subs = <String, SubResponse>{};
    for (final r in raw) {
      if (r is Map<String, dynamic>) {
        final sr = SubResponse.fromJson(r);
        subs[sr.id] = sr;
      }
    }

    for (final p in batch) {
      final sr = subs[p.sub.id];
      if (sr == null) {
        p.completer.completeError(
          const BatchAbortedError('missing_subresponse'),
        );
        continue;
      }
      if (sr.ok) {
        try {
          final out = p.decode(sr.data);
          p.completer.complete(out);
        } catch (e) {
          p.completer.completeError(BatchAbortedError('decode_error: $e'));
        }
        continue;
      }
      final err = sr.error;
      if (err != null && err.code == 'aborted') {
        p.completer.completeError(BatchAbortedError(err.message.isEmpty ? 'aborted' : err.message));
      } else {
        p.completer.completeError(SubRequestError(
          err?.code ?? 'unknown_error',
          err?.message ?? '',
        ));
      }
    }
  }

  void _failAll(List<_Pending> batch, Object error) {
    for (final p in batch) {
      if (!p.completer.isCompleted) {
        p.completer.completeError(error);
      }
    }
  }
}

class _Pending {
  final SubRequest sub;
  final dynamic Function(dynamic raw) decode;
  final Completer completer;
  _Pending({required this.sub, required this.decode, required this.completer});
}

class _Uuid {
  const _Uuid();
  String v4() => const Uuid().v4();
}
