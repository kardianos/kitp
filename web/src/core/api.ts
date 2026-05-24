/**
 * Declarative, pre-registered API.
 *
 * API specs are declared and REGISTERED UP FRONT — (endpoint, action) plus
 * typed encode/decode — then invoked declaratively as:
 *
 *   call(CardSelectWithAttributes, { cardTypeName: 'screen', parentCardId },
 *        (out) => tree.at(['screens', slug]).merge(out));
 *
 * There is NO per-call try/catch. Every failure (sub_error, aborted, decode,
 * network, http) funnels through the dispatcher's CENTRALIZED fault registry
 * (one boot-registered listener set, not per-call branches) — matching the
 * team's stated preference for callback + centralized error registry over
 * await ladders (MEMORY.md).
 *
 * `call` returns the sub-request id so a caller can correlate; the common
 * path is fire-and-forget-with-onOk. An optional `onErr` lets a single call
 * specialize its own UX without breaking the central funnel (the fault is
 * still emitted globally first).
 */

import { Dispatcher, type ApiFault } from './dispatch.js';

/** A pre-registered API spec: literal endpoint/action + typed codec. */
export interface ApiSpec<I, O> {
  readonly endpoint: string;
  readonly action: string;
  readonly encode: (input: I) => unknown;
  readonly decode: (raw: unknown) => O;
}

/** Declare a spec. Identity codecs default to pass-through. */
export function defineSpec<I, O>(spec: {
  endpoint: string;
  action: string;
  encode?: (input: I) => unknown;
  decode?: (raw: unknown) => O;
}): ApiSpec<I, O> {
  return {
    endpoint: spec.endpoint,
    action: spec.action,
    encode: spec.encode ?? ((i) => i as unknown),
    decode: spec.decode ?? ((raw) => raw as O),
  };
}

/** Registry of declared specs, keyed by `endpoint.action`. */
export class ApiRegistry {
  private readonly by = new Map<string, ApiSpec<unknown, unknown>>();

  register<I, O>(spec: ApiSpec<I, O>): ApiSpec<I, O> {
    const k = `${spec.endpoint}.${spec.action}`;
    if (this.by.has(k)) throw new Error(`api spec ${k} already registered`);
    this.by.set(k, spec as ApiSpec<unknown, unknown>);
    return spec;
  }

  has(spec: { endpoint: string; action: string }): boolean {
    return this.by.has(`${spec.endpoint}.${spec.action}`);
  }

  /** Resolve a spec by its `endpoint.action` key (the declarative addressing). */
  get(key: string): ApiSpec<unknown, unknown> | undefined {
    return this.by.get(key);
  }
}

/** Options for a single call. `alive` lets a control drop late responses. */
export interface CallOptions {
  /**
   * Specialize this one call's failure UX. The typed ApiFault is still
   * funneled globally first; this is purely per-call routing (e.g. a control
   * self-representing the error). No promise — a callback with the fault.
   */
  onErr?: (fault: ApiFault) => void;
  /** Drop the response if this returns false at delivery (control destroyed). */
  alive?: () => boolean;
}

/**
 * The Api facade: holds the dispatcher + the registry of declared specs, and
 * exposes the team-preferred `call(spec, data, onOk)` surface.
 */
export class Api {
  readonly registry = new ApiRegistry();

  constructor(readonly dispatcher: Dispatcher) {}

  /** Declare + register a spec (sugar over registry.register(defineSpec(...))). */
  define<I, O>(spec: {
    endpoint: string;
    action: string;
    encode?: (input: I) => unknown;
    decode?: (raw: unknown) => O;
  }): ApiSpec<I, O> {
    return this.registry.register(defineSpec(spec));
  }

  /**
   * Invoke a pre-registered spec. Success runs `onOk(decoded)`. Failures
   * funnel through the centralized fault registry; the optional `onErr`
   * specializes this call without bypassing the funnel. Returns the
   * sub-request id.
   *
   * NO PROMISE: this routes straight through the dispatcher's callback
   * surface (`request(args, onOk, onFault)`). There is no `.then`/`await`
   * anywhere on the path.
   */
  call<I, O>(
    spec: ApiSpec<I, O>,
    data: I,
    onOk: (out: O) => void,
    opts: CallOptions = {},
  ): string {
    if (!this.registry.has(spec)) {
      throw new Error(`api.call: spec ${spec.endpoint}.${spec.action} not registered`);
    }
    let encoded: unknown;
    try {
      encoded = data === undefined ? undefined : spec.encode(data);
    } catch (e) {
      // Encode is synchronous client-side; surface it as a decode-shaped fault
      // to the per-call hook (no global funnel — nothing crossed the wire).
      opts.onErr?.({ kind: 'decode', message: `encode_error: ${String(e)}` });
      return '';
    }
    const alive = opts.alive;
    const onFault = opts.onErr;
    const { id } = this.dispatcher.request(
      {
        endpoint: spec.endpoint,
        action: spec.action,
        data: encoded,
        decode: spec.decode as (raw: unknown) => unknown,
        ...(alive ? { alive } : {}),
      },
      (decoded) => onOk(decoded as O),
      // The dispatcher already emitted the typed ApiFault to the central
      // funnel; onErr is purely for per-call specialization.
      onFault ? (f) => onFault(f) : undefined,
    );
    return id;
  }

  /**
   * Invoke a spec resolved from the registry by its `endpoint.action` key.
   * The declarative data layer addresses specs by string key, so this is the
   * surface DataController calls. Input/output are untyped at this boundary
   * (the spec's own encode/decode still run). Returns the sub-request id, or
   * '' if the key is unknown (routed to onErr as a decode-shaped fault).
   */
  callByName(
    specKey: string,
    data: unknown,
    onOk: (out: unknown) => void,
    opts: CallOptions = {},
  ): string {
    const spec = this.registry.get(specKey);
    if (!spec) {
      opts.onErr?.({ kind: 'decode', message: `unknown_spec: ${specKey}` });
      return '';
    }
    return this.call(spec, data, onOk, opts);
  }
}
