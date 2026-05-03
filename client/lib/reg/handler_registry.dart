/// Client-side handler registry. Mirrors the server's `(endpoint, action)`
/// keying scheme so the dispatcher can encode the typed `Input` to JSON and
/// decode `Output` JSON back into a typed instance.
///
/// In v1 the registry is purely a JSON codec table; it does not perform
/// authorization or any other server logic.
library;

/// Encodes a typed input into the JSON tree the server expects in `data`.
/// `null` means "no input payload" (the dispatcher omits `data` from the
/// sub-request).
typedef InputEncoder<I> = dynamic Function(I input);

/// Decodes a sub-response's `data` (already json-decoded) into a typed
/// output instance.
typedef OutputDecoder<R> = R Function(dynamic raw);

/// Type-erased codecs the dispatcher actually invokes. The registry wraps
/// the typed [InputEncoder] / [OutputDecoder] in closures so the dispatcher
/// can hold them without leaking generic type parameters all the way out.
typedef RawEncode = dynamic Function(dynamic input);
typedef RawDecode = dynamic Function(dynamic raw);

/// One registry row, typed at registration time.
class HandlerSpec<I, R> {
  final String endpoint;
  final String action;
  final InputEncoder<I> encode;
  final OutputDecoder<R> decode;

  const HandlerSpec({
    required this.endpoint,
    required this.action,
    required this.encode,
    required this.decode,
  });

  String get key => '$endpoint.$action';
}

/// Type-erased view onto a [HandlerSpec]. Created by the registry at
/// registration time; consumed by the dispatcher.
class HandlerEntry {
  final String endpoint;
  final String action;
  final RawEncode encode;
  final RawDecode decode;
  const HandlerEntry({
    required this.endpoint,
    required this.action,
    required this.encode,
    required this.decode,
  });
}

/// Process-wide registry. Phase 12 uses it as a typed lookup table; later
/// phases plug cache invalidation hints in here too.
class HandlerRegistry {
  final Map<String, HandlerEntry> _by = {};

  void register<I, R>(HandlerSpec<I, R> spec) {
    final k = spec.key;
    if (_by.containsKey(k)) {
      throw StateError('handler $k already registered');
    }
    // Wrap the typed codecs in `dynamic`-shaped closures so the dispatcher
    // can call them without any generic-variance gymnastics.
    _by[k] = HandlerEntry(
      endpoint: spec.endpoint,
      action: spec.action,
      encode: (dynamic input) => spec.encode(input as I),
      decode: (dynamic raw) => spec.decode(raw),
    );
  }

  HandlerEntry? lookup(String endpoint, String action) =>
      _by['$endpoint.$action'];

  /// True when a handler is registered for `(endpoint, action)`.
  bool has(String endpoint, String action) =>
      _by.containsKey('$endpoint.$action');
}
