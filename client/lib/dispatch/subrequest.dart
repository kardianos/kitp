/// Wire-shape value classes for one sub-request and one sub-response.
///
/// These mirror REQUIREMENTS.md §4.1 N-API-2/3. They are intentionally
/// untyped at the `data` level — the [Dispatcher] handles encode/decode of
/// the typed payloads via the handler registry.
library;

/// One element in the batched request body sent to `POST /api/v1/batch`.
class SubRequest {
  /// Client-supplied correlation id. The dispatcher generates a UUID for
  /// every call; tests may pass an explicit id for stable assertions.
  final String id;

  /// `data | action | query` per the requirements. Defaults to `data`.
  final String type;
  final String endpoint;
  final String action;

  final Map<String, dynamic> ref;
  final Map<String, dynamic> key;

  /// JSON-encodable payload. May be `null` for handlers like `card_type.select`
  /// that take no input.
  final dynamic data;

  const SubRequest({
    required this.id,
    required this.type,
    required this.endpoint,
    required this.action,
    this.ref = const {},
    this.key = const {},
    this.data,
  });

  Map<String, dynamic> toJson() {
    final m = <String, dynamic>{
      'id': id,
      'type': type,
      'endpoint': endpoint,
      'action': action,
    };
    if (ref.isNotEmpty) m['ref'] = ref;
    if (key.isNotEmpty) m['key'] = key;
    if (data != null) m['data'] = data;
    return m;
  }
}

/// One element in the batched response body. The decoder is intentionally
/// permissive with `data` — the dispatcher hands the raw JSON tree off to
/// the registered output codec.
class SubResponse {
  final String id;
  final bool ok;
  final dynamic data;
  final SubResponseError? error;

  const SubResponse({
    required this.id,
    required this.ok,
    this.data,
    this.error,
  });

  factory SubResponse.fromJson(Map<String, dynamic> json) {
    SubResponseError? err;
    final raw = json['error'];
    if (raw is Map<String, dynamic>) {
      err = SubResponseError(
        (raw['code'] as String?) ?? '',
        (raw['message'] as String?) ?? '',
      );
    }
    return SubResponse(
      id: json['id'] as String,
      ok: (json['ok'] as bool?) ?? false,
      data: json['data'],
      error: err,
    );
  }
}

class SubResponseError {
  final String code;
  final String message;
  const SubResponseError(this.code, this.message);
}
