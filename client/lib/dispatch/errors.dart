/// Typed exceptions surfaced by the dispatcher.
///
/// Widgets should pattern-match on these instead of inspecting arbitrary
/// strings or `dynamic` errors.
library;

/// Thrown on a sub-request whose future was killed because some other
/// sub-request in the same batch failed (server returns `error.code='aborted'`)
/// or because the batch never reached the server (HTTP 5xx, network failure,
/// malformed response).
class BatchAbortedError implements Exception {
  /// Short reason. For server-driven aborts this is `"aborted"`. For transport
  /// failures this is the underlying cause's `toString()` or `"http_<status>"`.
  final String reason;

  const BatchAbortedError(this.reason);

  @override
  String toString() => 'BatchAbortedError($reason)';
}

/// Thrown on a sub-request whose own `{ok:false, error:{code,message}}`
/// envelope arrived from the server. `aborted`-coded errors are mapped to
/// [BatchAbortedError] before this is thrown, so seeing this means *this*
/// sub-request was the one that misbehaved.
class SubRequestError implements Exception {
  /// Server-supplied error code (e.g. `"not_found"`, `"unknown_handler"`).
  final String code;
  final String message;

  const SubRequestError(this.code, this.message);

  @override
  String toString() => 'SubRequestError($code, $message)';
}
