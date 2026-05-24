/**
 * Central data dispatcher: every component that wants server data goes
 * through here, every render tick produces at most one HTTP
 * `POST /api/v1/batch` (REQUIREMENTS N-CLI-1/2/3).
 *
 * Lifecycle of a `request()` call:
 *   1. Look up the handler spec in the registry. Missing spec → reject
 *      synchronously with `SubRequestError('unknown_handler')`.
 *   2. Assign the sub-request a UUID, encode its `data` via the spec, stash a
 *      Pending entry (resolve/reject closure + decode fn) keyed by id.
 *   3. The first call in any batching window schedules a flush via
 *      `requestAnimationFrame` (rAF) when available, falling back to
 *      `queueMicrotask`. Subsequent calls in the same window just append.
 *   4. On flush we POST the whole queue, decode each sub-response, route
 *      success/error/aborted onto each Pending.
 *
 * Tests inject a synchronous `schedule` (`(cb) => cb()`) and call `flushNow()`
 * manually so they can assert "exactly one HTTP call" without pumping a frame.
 */

import { v4 as uuid } from 'uuid';

import type { ApiFault, BindingEntry, FaultKind, Result } from './bag.svelte';
import { BatchAbortedError, SubRequestError } from './errors.js';
import {
  type SubRequest,
  type SubResponse,
  subRequestToJson,
  subResponseFromJson,
} from './subrequest.js';

/* -------------------------------------------------------------------------- */
/* BigInt-aware JSON helpers.                                                 */
/*                                                                            */
/* The server emits id fields as JSON strings (Go `json:",string"` on every  */
/* int64 id field) so full int64 precision crosses the wire intact —         */
/* JSON.parse would otherwise round any value > Number.MAX_SAFE_INTEGER to   */
/* the nearest float64. We convert those string-encoded ids back to bigint   */
/* in `reviveIds` and emit outgoing bigint values as JSON strings via        */
/* `stringifyBigInt`.                                                        */
/*                                                                            */
/* "Id-named" means a key matching /(?:^|_)id$|_ids$|Id$|Ids$/. Both single-  */
/* value and array fields are handled.                                        */
/* -------------------------------------------------------------------------- */

const ID_KEY_RE = /(?:^|_)id$|_ids$|Id$|Ids$/;
const DIGITS_RE = /^-?\d+$/;

/**
 * Attribute names whose values are card_ref / card_ref[] in v1. Stored
 * as JSON numbers by the demo seed (`to_jsonb(bigint)`) but as JSON
 * strings when written through the dispatcher (`stringifyBigInt`); we
 * normalise both shapes to bigint at decode time so the rendering
 * layer can compare against picker option values without type-juggling
 * across number vs. bigint vs. string.
 *
 * Closed list because the reviver runs over every response — we don't
 * want to BigInt-ify arbitrary integer attributes (e.g. `sort_order`).
 * Phase-aligned with the seeded set of card_ref attribute_defs.
 */
/**
 * Runtime registry of attribute names whose values are card_ref bigint
 * ids. Populated by `AttributeSchemaCache.load()` from the seeded +
 * admin-defined attribute_def rows; the dispatcher consults it when
 * walking response JSON. Built-in card_refs (status, assignee,
 * milestone_ref, …) AND any custom admin attribute show up here once
 * the schema has been fetched — there is no hard-coded list to
 * maintain.
 *
 * The set starts empty; `main.ts` preloads the schema right after the
 * /auth/me probe so the first batched data fetch already has the
 * correct revival map. Components that bypass that preload (the rare
 * test, the MCP CLI) will see card_ref values as raw JSON numbers
 * until they trigger a schema load.
 */
const CARD_REF_ATTR_KEYS = new Set<string>();
const CARD_REF_ARRAY_ATTR_KEYS = new Set<string>();

/** Register an attribute name so the dispatcher revives its bigint ids. */
export function registerCardRefAttr(name: string, isArray: boolean): void {
  if (isArray) CARD_REF_ARRAY_ATTR_KEYS.add(name);
  else CARD_REF_ATTR_KEYS.add(name);
}

/** Test hook: forget every registered card_ref attribute. */
export function clearCardRefAttrRegistry(): void {
  CARD_REF_ATTR_KEYS.clear();
  CARD_REF_ARRAY_ATTR_KEYS.clear();
}

function shouldReviveAsId(key: string): boolean {
  return ID_KEY_RE.test(key) || CARD_REF_ATTR_KEYS.has(key);
}

function shouldReviveAsIdArray(key: string): boolean {
  return CARD_REF_ARRAY_ATTR_KEYS.has(key);
}

/**
 * Walk a parsed JSON value and convert id-shaped fields to bigint.
 * Operates bottom-up; arrays of id-strings (e.g. `removed_tag_ids:["1","2"]`)
 * are detected by the parent key. Returns the input mutated in place.
 *
 * Non-string values left alone — a legacy number id (small enough to fit in
 * Number.MAX_SAFE_INTEGER, emitted by an older server) is also accepted to
 * keep transition mixes safe.
 *
 * Card_ref attribute values are revived even though their keys don't
 * end in `id`; see CARD_REF_ATTR_KEYS above.
 */
export function reviveIds(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = reviveIds(value[i]);
    return value;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (shouldReviveAsId(k)) {
        if (typeof v === 'string' && DIGITS_RE.test(v)) {
          obj[k] = BigInt(v);
        } else if (typeof v === 'number' && Number.isInteger(v)) {
          obj[k] = BigInt(v);
        } else if (Array.isArray(v)) {
          for (let i = 0; i < v.length; i++) {
            const e = v[i];
            if (typeof e === 'string' && DIGITS_RE.test(e)) {
              v[i] = BigInt(e);
            } else if (typeof e === 'number' && Number.isInteger(e)) {
              v[i] = BigInt(e);
            }
          }
        }
      } else if (shouldReviveAsIdArray(k) && Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          const e = v[i];
          if (typeof e === 'string' && DIGITS_RE.test(e)) {
            v[i] = BigInt(e);
          } else if (typeof e === 'number' && Number.isInteger(e)) {
            v[i] = BigInt(e);
          }
        }
      } else {
        obj[k] = reviveIds(v);
      }
    }
    return obj;
  }
  return value;
}

/**
 * Stringify a value to JSON, emitting bigint values as JSON strings
 * (`"123"`). The server's `json:",string"` tag parses them back to int64.
 */
export function stringifyBigInt(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
}

/* -------------------------------------------------------------------------- */
/* Registry types — minimal interface here so this file does not depend on    */
/* the (parallel-task) HandlerRegistry implementation.                        */
/* -------------------------------------------------------------------------- */

export type Encode<I> = (input: I) => unknown;
export type Decode<R> = (raw: unknown) => R;

export interface HandlerSpec<I = unknown, R = unknown> {
  endpoint: string;
  action: string;
  encode: Encode<I>;
  decode: Decode<R>;
}

export interface HandlerRegistryLike {
  lookup<I = unknown, R = unknown>(
    endpoint: string,
    action: string,
  ): HandlerSpec<I, R> | undefined;
}

/* -------------------------------------------------------------------------- */
/* Auth integration — minimal interface here so this file does not depend on  */
/* the (parallel-task) AuthState implementation.                              */
/* -------------------------------------------------------------------------- */

export interface AuthStateLike {
  isSignedIn: boolean;
}

/* -------------------------------------------------------------------------- */
/* Internal Pending record — one per in-flight call. Either a Promise-based   */
/* `request()` caller (kind='promise') or a Bag binding (kind='binding').     */
/* Both share the same queue / batch / decode pipeline; the flush dispatch    */
/* loop picks the right delivery channel per entry.                           */
/* -------------------------------------------------------------------------- */

interface PendingPromise {
  kind: 'promise';
  sub: SubRequest;
  decode: Decode<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

interface PendingBinding {
  kind: 'binding';
  sub: SubRequest;
  bindId: string;
  seq: number;
}

type Pending = PendingPromise | PendingBinding;

/* -------------------------------------------------------------------------- */
/* Schedule fn: microtask. Coalesces the synchronous burst of `request()`    */
/* calls inside one event handler / effect into a single batch — same as     */
/* rAF gave us — but without rAF's hidden-tab throttling. Chrome pauses or   */
/* clamps rAF to ~1Hz on backgrounded tabs; a microtask still fires at the   */
/* end of the current task regardless, so a request issued while the tab    */
/* is hidden no longer stalls until focus returns.                          */
/* -------------------------------------------------------------------------- */

export type Schedule = (cb: () => void) => void;

const defaultSchedule: Schedule = (cb) => {
  queueMicrotask(cb);
};

/* -------------------------------------------------------------------------- */
/* Dispatcher options                                                         */
/* -------------------------------------------------------------------------- */

export interface DispatcherOptions {
  apiBase: string;
  registry: HandlerRegistryLike;
  /** Optional fetch override; defaults to global `fetch`. Tests inject a mock. */
  fetch?: typeof fetch;
  /** Optional auth state — drives the 401 → onUnauthorized retry gate. */
  authState?: AuthStateLike;
  /** Optional refresh hook. See class doc. */
  onUnauthorized?: () => Promise<boolean>;
  /** Override the flush scheduler (tests pass `(cb) => cb()`). */
  schedule?: Schedule;
}

export interface RequestArgs<I = unknown> {
  endpoint: string;
  action: string;
  type?: string;
  ref?: Record<string, unknown>;
  key?: Record<string, unknown>;
  data?: I;
}

/* -------------------------------------------------------------------------- */
/* Dispatcher                                                                 */
/* -------------------------------------------------------------------------- */

export class Dispatcher {
  private readonly apiBase: string;
  private readonly registry: HandlerRegistryLike;
  private readonly fetchImpl: typeof fetch;
  private readonly authState: AuthStateLike | undefined;
  private readonly onUnauthorized: (() => Promise<boolean>) | undefined;
  private readonly schedule: Schedule;

  /** In-flight batch buffer. Cleared at the start of every flush. */
  private queue: Pending[] = [];
  /** True once we have asked the scheduler for a flush callback. */
  private flushScheduled = false;

  /** Active bag bindings — id → handler entry. Bag.dispose() unregisters. */
  private readonly bindings = new Map<string, BindingEntry>();

  /** Fault listeners keyed by ApiFault['kind']. Registered at boot in
   *  `main.ts`; every batch-level or sub-level failure flows through here
   *  before per-call handlers see it, so behaviours like "401 ⇒ /login"
   *  live in exactly one place. */
  private readonly faultListeners = new Map<FaultKind, Array<(f: ApiFault) => void>>();

  constructor(opts: DispatcherOptions) {
    this.apiBase = opts.apiBase;
    this.registry = opts.registry;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.authState = opts.authState;
    this.onUnauthorized = opts.onUnauthorized;
    this.schedule = opts.schedule ?? defaultSchedule;
  }

  /**
   * Register a fault listener. Every failure path (sub-error, batch
   * abort, decode failure, network error, HTTP 4xx/5xx) emits an
   * {@link ApiFault} of the matching kind; every listener for that
   * kind is invoked before per-call handlers see the failure. This is
   * the single place to wire global behaviours like 401 ⇒ /login or
   * "decode errors go to the toast".
   */
  onFault(kind: FaultKind, listener: (f: ApiFault) => void): void {
    let bucket = this.faultListeners.get(kind);
    if (bucket === undefined) {
      bucket = [];
      this.faultListeners.set(kind, bucket);
    }
    bucket.push(listener);
  }

  /** Internal: register a {@link Bag} binding. Owned by `Bag.bind()`. */
  bindRegister(id: string, entry: BindingEntry): void {
    this.bindings.set(id, entry);
  }

  /** Internal: unregister a {@link Bag} binding. Owned by `Bag.dispose()`. */
  bindUnregister(id: string): void {
    this.bindings.delete(id);
  }

  /**
   * Internal: queue a sub-request for a bound id. Allocates a fresh
   * sequence number so `replaceInflight` can drop stale responses on
   * arrival.
   */
  bindSubmit<I, R>(bindId: string, spec: HandlerSpec<I, R>, data: I): void {
    const entry = this.bindings.get(bindId);
    if (entry === undefined) return; // bag disposed mid-flight; drop
    entry.latestSeq++;
    const seq = entry.latestSeq;
    let encoded: unknown;
    try {
      encoded = data === undefined ? null : spec.encode(data);
    } catch (e) {
      // Synchronous encode failure routes through the same fault path
      // as a decode error so global listeners (e.g. toast) see it too.
      const fault: ApiFault = { kind: 'decode', message: `encode_error: ${String(e)}` };
      this.emitFault(fault);
      entry.handler({ ok: false, error: fault });
      return;
    }
    const sub: SubRequest = {
      id: uuid(),
      type: 'data',
      endpoint: spec.endpoint,
      action: spec.action,
      ref: {},
      key: {},
      data: encoded,
    };
    this.queue.push({ kind: 'binding', sub, bindId, seq });
    this.maybeScheduleFlush();
  }

  /**
   * Submit one sub-request. Resolves with the typed `R` decoded from the
   * matching sub-response, or rejects with {@link SubRequestError} /
   * {@link BatchAbortedError}.
   *
   * All `request()` calls in the same flush window share one HTTP call.
   */
  request<I = unknown, R = unknown>(args: RequestArgs<I>): Promise<R> {
    const spec = this.registry.lookup<I, R>(args.endpoint, args.action);
    if (!spec) {
      return Promise.reject(
        new SubRequestError(
          'unknown_handler',
          `no client registration for ${args.endpoint}.${args.action}`,
        ),
      );
    }

    return new Promise<R>((resolve, reject) => {
      let encoded: unknown;
      try {
        encoded = args.data === undefined ? null : spec.encode(args.data);
      } catch (e) {
        reject(new BatchAbortedError(`encode_error: ${String(e)}`));
        return;
      }

      const sub: SubRequest = {
        id: uuid(),
        type: args.type ?? 'data',
        endpoint: args.endpoint,
        action: args.action,
        ref: args.ref ?? {},
        key: args.key ?? {},
        data: encoded,
      };

      this.queue.push({
        kind: 'promise',
        sub,
        decode: spec.decode as Decode<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.maybeScheduleFlush();
    });
  }

  /**
   * Submit one sub-request bypassing the HandlerRegistry. Used by the
   * data-bound form kernel where the draft is already in wire shape
   * (snake_case keys matching the server's published JSON Schema) so
   * the spec.encode step would be a no-op or worse, destructive.
   *
   * Caller passes `data` already in the JSON shape the server's
   * dispatcher expects. Response decoding is also bypassed — caller
   * receives the raw unknown that the dispatcher delivered.
   *
   * Use plain `request()` for typed reads + writes where the wire
   * shape differs from the TypeScript interface.
   */
  requestRaw(args: {
    endpoint: string;
    action: string;
    data?: unknown;
    type?: string;
    ref?: Record<string, unknown>;
    key?: Record<string, unknown>;
  }): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const sub: SubRequest = {
        id: uuid(),
        type: args.type ?? 'data',
        endpoint: args.endpoint,
        action: args.action,
        ref: args.ref ?? {},
        key: args.key ?? {},
        data: args.data ?? null,
      };
      this.queue.push({
        kind: 'promise',
        sub,
        decode: (raw: unknown) => raw,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.maybeScheduleFlush();
    });
  }

  /** Force an immediate flush. Tests bypass the scheduler with this. */
  flushNow(): Promise<void> {
    return this.flush();
  }

  private maybeScheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.schedule(() => {
      void this.flush();
    });
  }

  private buildHeaders(): Record<string, string> {
    // BFF cookie-only model: the kitp_session cookie identifies the
    // actor on the server side. The dispatcher no longer carries the
    // access token in JS — same-origin fetch sends the cookie
    // automatically, and there is nothing here to leak to XSS.
    return { 'Content-Type': 'application/json' };
  }

  private async flush(): Promise<void> {
    if (!this.flushScheduled && this.queue.length === 0) return;
    this.flushScheduled = false;
    if (this.queue.length === 0) return;

    // Snapshot + clear at the top so any `request()` calls made while we are
    // awaiting fetch are queued for the *next* batch.
    const batch = this.queue;
    this.queue = [];

    const body = stringifyBigInt({
      subrequests: batch.map((p) => subRequestToJson(p.sub)),
    });
    const url = `${this.apiBase}/api/v1/batch`;

    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body,
      });
    } catch (e) {
      const fault: ApiFault = { kind: 'network', message: String(e) };
      this.emitFault(fault);
      this.failAll(batch, fault, new BatchAbortedError(String(e)));
      return;
    }

    // 401: try one refresh + retry. Second 401 surfaces as a fail-all so the
    // caller can route to /login.
    if (
      resp.status === 401 &&
      this.authState?.isSignedIn === true &&
      this.onUnauthorized !== undefined
    ) {
      let refreshed = false;
      try {
        refreshed = await this.onUnauthorized();
      } catch {
        refreshed = false;
      }
      if (refreshed) {
        try {
          resp = await this.fetchImpl(url, {
            method: 'POST',
            headers: this.buildHeaders(),
            body,
          });
        } catch (e) {
          const fault: ApiFault = { kind: 'network', message: String(e) };
          this.emitFault(fault);
          this.failAll(batch, fault, new BatchAbortedError(String(e)));
          return;
        }
      }
    }

    if (resp.status >= 400) {
      // 4xx / 5xx: the body has no per-sub-response slots, so the batch
      // contract collapses to "every future fails the same way."
      const fault: ApiFault = { kind: 'http', status: resp.status };
      this.emitFault(fault);
      this.failAll(batch, fault, new BatchAbortedError(`http_${resp.status}`));
      return;
    }

    let parsed: unknown;
    try {
      const text = await resp.text();
      parsed = JSON.parse(text);
      parsed = reviveIds(parsed);
    } catch (e) {
      const fault: ApiFault = { kind: 'decode', message: `bad_response: ${String(e)}` };
      this.emitFault(fault);
      this.failAll(batch, fault, new BatchAbortedError(`bad_response: ${String(e)}`));
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      const fault: ApiFault = { kind: 'decode', message: 'bad_response: not an object' };
      this.emitFault(fault);
      this.failAll(batch, fault, new BatchAbortedError('bad_response: not an object'));
      return;
    }
    const rawSubs = (parsed as Record<string, unknown>)['subresponses'];
    if (!Array.isArray(rawSubs)) {
      const fault: ApiFault = { kind: 'decode', message: 'bad_response: no subresponses' };
      this.emitFault(fault);
      this.failAll(batch, fault, new BatchAbortedError('bad_response: no subresponses'));
      return;
    }

    const subs = new Map<string, SubResponse>();
    for (const r of rawSubs) {
      if (r && typeof r === 'object') {
        const sr = subResponseFromJson(r as Record<string, unknown>);
        subs.set(sr.id, sr);
      }
    }

    for (const p of batch) {
      const sr = subs.get(p.sub.id);
      if (sr === undefined) {
        const fault: ApiFault = { kind: 'aborted', reason: 'missing_subresponse' };
        this.deliverFault(p, fault, new BatchAbortedError('missing_subresponse'));
        continue;
      }
      if (sr.ok) {
        this.deliverOk(p, sr.data);
        continue;
      }
      const err = sr.error;
      if (err && err.code === 'aborted') {
        const reason = err.message.length > 0 ? err.message : 'aborted';
        const fault: ApiFault = { kind: 'aborted', reason };
        this.emitFault(fault);
        this.deliverFault(p, fault, new BatchAbortedError(reason));
      } else {
        const fault: ApiFault = {
          kind: 'sub_error',
          code: err?.code ?? 'unknown_error',
          message: err?.message ?? '',
        };
        if (err?.detail !== undefined) {
          (fault as { detail?: unknown }).detail = err.detail;
        }
        this.emitFault(fault);
        this.deliverFault(p, fault, new SubRequestError(fault.code, fault.message, err?.detail));
      }
    }
  }

  /** Emit a fault to every registered listener for its kind. */
  private emitFault(f: ApiFault): void {
    const bucket = this.faultListeners.get(f.kind);
    if (bucket === undefined) return;
    for (const fn of bucket) {
      try { fn(f); } catch { /* swallow — one bad listener cannot break the funnel */ }
    }
  }

  /** Deliver a decoded success to either a promise caller or a bound handler. */
  private deliverOk(p: Pending, raw: unknown): void {
    if (p.kind === 'promise') {
      try {
        p.resolve(p.decode(raw));
      } catch (e) {
        const fault: ApiFault = { kind: 'decode', message: `decode_error: ${String(e)}` };
        this.emitFault(fault);
        p.reject(new BatchAbortedError(`decode_error: ${String(e)}`));
      }
      return;
    }
    const entry = this.bindings.get(p.bindId);
    if (entry === undefined) return; // bag disposed mid-flight
    if (entry.replaceInflight && p.seq !== entry.latestSeq) return; // superseded
    let decoded: unknown;
    try {
      decoded = entry.decode(raw);
    } catch (e) {
      const fault: ApiFault = { kind: 'decode', message: `decode_error: ${String(e)}` };
      this.emitFault(fault);
      entry.handler({ ok: false, error: fault });
      return;
    }
    entry.handler({ ok: true, data: decoded } as Result<unknown>);
  }

  /** Deliver a failure to either a promise caller or a bound handler. The
   *  fault has already been emitted to the global registry by the caller. */
  private deliverFault(p: Pending, fault: ApiFault, err: Error): void {
    if (p.kind === 'promise') {
      p.reject(err);
      return;
    }
    const entry = this.bindings.get(p.bindId);
    if (entry === undefined) return;
    if (entry.replaceInflight && p.seq !== entry.latestSeq) return;
    entry.handler({ ok: false, error: fault });
  }

  /** Batch-level failure: every entry in the batch sees the same fault. */
  private failAll(batch: readonly Pending[], fault: ApiFault, err: Error): void {
    for (const p of batch) {
      this.deliverFault(p, fault, err);
    }
  }
}
