/**
 * Client-side handler registry. Mirrors the server's `(endpoint, action)`
 * keying scheme so the dispatcher can encode the typed `Input` to JSON and
 * decode `Output` JSON back into a typed instance.
 *
 * In v1 the registry is purely a JSON codec table; it does not perform
 * authorization or any other server logic. Ported from the Dart
 * `client/lib/reg/handler_registry.dart`.
 */

/**
 * Encodes a typed input into the JSON tree the server expects in `data`.
 * The encoder is expected to return a JSON-encodable value (object, array,
 * primitive). The dispatcher serialises the wrapping {@link SubRequest} for
 * the wire.
 */
export type InputEncoder<I> = (input: I) => unknown;

/**
 * Decodes a sub-response's `data` (already JSON-decoded into a JS value)
 * into a typed output instance.
 */
export type OutputDecoder<R> = (raw: unknown) => R;

/** One registry row, typed at registration time. */
export interface HandlerSpec<I, R> {
  readonly endpoint: string;
  readonly action: string;
  readonly encode: InputEncoder<I>;
  readonly decode: OutputDecoder<R>;
}

/**
 * Process-wide registry. The dispatcher looks specs up by
 * `${endpoint}.${action}` and invokes their encode/decode callbacks.
 */
export class HandlerRegistry {
  private readonly by = new Map<string, HandlerSpec<unknown, unknown>>();

  /** Register a single handler. Throws if `(endpoint, action)` already has one. */
  register<I, R>(spec: HandlerSpec<I, R>): void {
    const k = `${spec.endpoint}.${spec.action}`;
    if (this.by.has(k)) {
      throw new Error(`handler ${k} already registered`);
    }
    // Type-erase the spec so we can hold heterogeneous handlers in one map;
    // the typed-out version is reconstituted at lookup time.
    this.by.set(k, spec as unknown as HandlerSpec<unknown, unknown>);
  }

  /** Look up a handler by `(endpoint, action)`. Returns undefined when missing. */
  lookup<I, R>(endpoint: string, action: string): HandlerSpec<I, R> | undefined {
    const got = this.by.get(`${endpoint}.${action}`);
    return got as HandlerSpec<I, R> | undefined;
  }

  /** True when a handler is registered for `(endpoint, action)`. */
  has(endpoint: string, action: string): boolean {
    return this.by.has(`${endpoint}.${action}`);
  }
}
