/**
 * Batch dispatcher — speaks the EXACT kitp wire protocol verbatim.
 *
 * Ported from client/src/dispatch/. The protocol knowledge here is
 * hard-won and the Go server depends on it:
 *
 *   - One POST /api/v1/batch per microtask flush (coalesces a synchronous
 *     burst of call()s into one HTTP request). Microtask, not rAF, to dodge
 *     Chrome's hidden-tab rAF clamp.
 *   - Request:  { subrequests: [{ id, type, endpoint, action, ref?, key?, data? }] }
 *   - Response: { subresponses: [{ id, ok, data?, error?: {code,message,detail?} }] }
 *     Mirrors server/internal/api/api.go SubResponse + sqlfunc.go's
 *     RETURNS TABLE(idx, ok, code, message, result).
 *   - BigInt id revival: server emits int64 ids as JSON strings
 *     (json:",string"); we revive id-shaped keys to bigint on the way in and
 *     stringify outgoing bigints. The data tree compares ids as bigint.
 *   - Centralized fault funnel: every failure emits a typed ApiFault to
 *     every registered listener before per-call delivery. 401 handling lives
 *     here as a boot-registered listener, not per-call code.
 *
 * The transport is injectable so the end-to-end proof can run against a
 * canned in-memory backend; production passes a fetch-backed transport.
 */

import { signal, type ReadonlySignal } from './signal.js';

/* -------------------------------------------------------------------------- */
/* Wire-shape types (mirror client/src/dispatch/subrequest.ts).               */
/* -------------------------------------------------------------------------- */

export interface SubRequest {
  id: string;
  type: string;
  endpoint: string;
  action: string;
  ref?: Record<string, unknown>;
  key?: Record<string, unknown>;
  data?: unknown;
}

export interface SubError {
  code: string;
  message: string;
  detail?: unknown;
}

export interface SubResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: SubError;
}

/* -------------------------------------------------------------------------- */
/* Fault funnel.                                                              */
/* -------------------------------------------------------------------------- */

export type ApiFault =
  | { kind: 'sub_error'; code: string; message: string; detail?: unknown }
  | { kind: 'aborted'; reason: string }
  | { kind: 'http'; status: number }
  | { kind: 'decode'; message: string }
  | { kind: 'network'; message: string };

export type FaultKind = ApiFault['kind'];

/** The fault variant for a given kind (narrows listener payloads). */
export type FaultOf<K extends FaultKind> = Extract<ApiFault, { kind: K }>;

/**
 * The `reason` the backend stamps on every NON-offending sub-request when one
 * sibling in the same batch fails (see server `api.go` — `ErrorEnvelope{Code:
 * "aborted", Message: "batch aborted by sibling sub-request"}`). It's pure
 * noise: the real cause rides a separate `sub_error` fault on the offender.
 * Both the central fault funnel (`main.ts`) and every self-represented control
 * (`Control.setFault`) drop it so the genuine error is the one that surfaces.
 */
export const SIBLING_ABORT_REASON = 'batch aborted by sibling sub-request';

/* -------------------------------------------------------------------------- */
/* Typed errors (mirror client/src/dispatch/errors.ts).                       */
/* -------------------------------------------------------------------------- */

export class SubRequestError extends Error {
  readonly code: string;
  readonly detail?: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'SubRequestError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
    Object.setPrototypeOf(this, SubRequestError.prototype);
  }
}

export class BatchAbortedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'BatchAbortedError';
    this.reason = reason;
    Object.setPrototypeOf(this, BatchAbortedError.prototype);
  }
}

/* -------------------------------------------------------------------------- */
/* BigInt-aware JSON (mirror client/src/dispatch/dispatcher.ts).              */
/* -------------------------------------------------------------------------- */

const ID_KEY_RE = /(?:^|_)id$|_ids$|Id$|Ids$/;
const DIGITS_RE = /^-?\d+$/;

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

function reviveScalar(v: unknown): unknown {
  if (typeof v === 'string' && DIGITS_RE.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  return v;
}

/** Walk parsed JSON and convert id-shaped fields to bigint. Mutates in place. */
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
        if (Array.isArray(v)) {
          for (let i = 0; i < v.length; i++) v[i] = reviveScalar(v[i]);
        } else {
          obj[k] = reviveScalar(v);
        }
      } else if (CARD_REF_ARRAY_ATTR_KEYS.has(k) && Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) v[i] = reviveScalar(v[i]);
      } else {
        obj[k] = reviveIds(v);
      }
    }
    return obj;
  }
  return value;
}

/** JSON.stringify emitting bigint values as JSON strings ("123"). */
export function stringifyBigInt(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

/* -------------------------------------------------------------------------- */
/* Transport — injectable so the proof can mock the network.                  */
/* -------------------------------------------------------------------------- */

/** Sends one serialized batch body, resolves a parsed-but-unrevived response. */
export interface Transport {
  send(body: string): Promise<{ status: number; text: string }>;
}

/** Production transport: same-origin fetch to /api/v1/batch (cookie auth). */
export function fetchTransport(apiBase = ''): Transport {
  return {
    async send(body: string) {
      const resp = await fetch(`${apiBase}/api/v1/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      return { status: resp.status, text: await resp.text() };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Pending records.                                                           */
/* -------------------------------------------------------------------------- */

type Decode<R> = (raw: unknown) => R;

interface Pending {
  sub: SubRequest;
  /** Read-only & safe to coalesce with byte-identical siblings in one flush. */
  dedup: boolean;
  decode: Decode<unknown>;
  /** Scope token — when killed, the response is dropped (control destroyed). */
  alive: () => boolean;
  /** Success callback with the decoded result. No promise leaves this surface. */
  onOk: (v: unknown) => void;
  /** Failure callback with the typed fault. The central funnel fired first. */
  onFault: (f: ApiFault) => void;
}

export interface DispatcherOptions {
  transport: Transport;
  /** Optional flush scheduler override (tests pass `(cb) => cb()`). */
  schedule?: (cb: () => void) => void;
}

const defaultSchedule = (cb: () => void): void => queueMicrotask(cb);
const alwaysAlive = (): boolean => true;
const noopOk = (): void => {};
const noopFault = (): void => {};

export interface RawRequestArgs {
  endpoint: string;
  action: string;
  type?: string;
  ref?: Record<string, unknown>;
  key?: Record<string, unknown>;
  data?: unknown;
  decode?: Decode<unknown>;
  alive?: () => boolean;
  /**
   * Opt this request into same-flush coalescing: byte-identical dedup requests
   * (same endpoint/action/data, no ref/key) collapse to ONE wire sub-request,
   * and the shared response fans out to every caller. Set ONLY for reads — a
   * read is a pure function of its input within one batch, so the merged
   * response is correct; merging writes would silently drop a mutation.
   */
  dedup?: boolean;
}

export class Dispatcher {
  private readonly transport: Transport;
  private readonly schedule: (cb: () => void) => void;
  private queue: Pending[] = [];
  private flushScheduled = false;
  private readonly faultListeners = new Map<FaultKind, Array<(f: ApiFault) => void>>();
  /** Count of requests enqueued but not yet settled (delivered or failed).
   *  A reactive source so UI can show a global "loading" affordance and a
   *  render-coordination boundary can wait on `inFlight === 0`. */
  private readonly inFlightSig = signal(0, 'dispatch.inFlight');

  constructor(opts: DispatcherOptions) {
    this.transport = opts.transport;
    this.schedule = opts.schedule ?? defaultSchedule;
  }

  /** Number of outstanding requests (enqueued, not yet settled), as a signal. */
  get inFlight(): ReadonlySignal<number> {
    return this.inFlightSig;
  }

  /**
   * Register a fault listener. Every failure path funnels through here. The
   * listener payload is narrowed to the variant matching `kind`.
   */
  onFault<K extends FaultKind>(kind: K, listener: (f: FaultOf<K>) => void): void {
    let bucket = this.faultListeners.get(kind);
    if (!bucket) {
      bucket = [];
      this.faultListeners.set(kind, bucket);
    }
    bucket.push(listener as (f: ApiFault) => void);
  }

  /**
   * Queue one sub-request. On success the decoded result is delivered to
   * `onOk`; on failure the typed ApiFault is delivered to `onFault` (AFTER the
   * fault has already been emitted to the central funnel). All calls in one
   * flush window share one HTTP POST.
   *
   * NO PROMISE crosses this surface — the caller gets back only `{ id }` for
   * correlation. The single allowed promise (awaiting `transport.send`) lives
   * privately inside `flush()` and never escapes.
   */
  request(
    args: RawRequestArgs,
    onOk: (decoded: unknown) => void = noopOk,
    onFault: (f: ApiFault) => void = noopFault,
  ): { id: string } {
    const id = newId();
    const sub: SubRequest = {
      id,
      type: args.type ?? 'data',
      endpoint: args.endpoint,
      action: args.action,
    };
    if (args.ref) sub.ref = args.ref;
    if (args.key) sub.key = args.key;
    if (args.data !== undefined) sub.data = args.data;

    this.queue.push({
      sub,
      dedup: args.dedup === true && args.ref === undefined && args.key === undefined,
      decode: (args.decode as Decode<unknown>) ?? ((raw) => raw),
      alive: args.alive ?? alwaysAlive,
      onOk,
      onFault,
    });
    this.inFlightSig.set(this.inFlightSig.peek() + 1);
    this.maybeScheduleFlush();
    return { id };
  }

  /**
   * @internal TEST-ONLY synchronous flush hook. Product code never awaits the
   * dispatcher; it registers `onOk`/`onFault` callbacks. Tests use this to
   * drive a flush to completion without a promise in product code. The
   * optional `done` callback fires once the flush settles (callback form so
   * even the test surface need not `await`); the returned promise is the one
   * internal place a promise is exposed, marked test-only.
   */
  flushNow(done?: () => void): Promise<void> {
    const p = this.flush();
    if (done) void p.then(done);
    return p;
  }

  private maybeScheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.schedule(() => void this.flush());
  }

  private emitFault(f: ApiFault): void {
    const bucket = this.faultListeners.get(f.kind);
    if (!bucket) return;
    for (const fn of bucket) {
      try {
        fn(f);
      } catch {
        // one bad listener cannot break the funnel
      }
    }
  }

  private failAll(batch: readonly Pending[], fault: ApiFault): void {
    for (const p of batch) {
      if (p.alive()) p.onFault(fault);
    }
    // Every failAll path settles the whole batch (the 4 early-return error
    // paths in flush); release its in-flight count here. The success path
    // releases at the end of flush's delivery loop instead.
    this.inFlightSig.set(this.inFlightSig.peek() - batch.length);
  }

  private async flush(): Promise<void> {
    this.flushScheduled = false;
    if (this.queue.length === 0) return;

    // Snapshot + clear: calls made while awaiting go in the next batch.
    const batch = this.queue;
    this.queue = [];

    // Read-dedup: collapse byte-identical dedup-eligible reads to ONE wire
    // sub-request. `respIdOf` maps every pending's id to the id whose response
    // carries its result (its own, or the leader it folded into). The server
    // dedups too; doing it here also shrinks the request body and the work the
    // server must fan back out.
    const respIdOf = new Map<string, string>();
    const leaderByKey = new Map<string, string>();
    const wire: Array<Record<string, unknown>> = [];
    for (const p of batch) {
      if (p.dedup) {
        const s = p.sub;
        const key = `${s.endpoint} ${s.action} ${stringifyBigInt(s.data ?? null)}`;
        const leader = leaderByKey.get(key);
        if (leader !== undefined) {
          respIdOf.set(s.id, leader);
          continue; // folded into the leader; not sent
        }
        leaderByKey.set(key, s.id);
      }
      respIdOf.set(p.sub.id, p.sub.id);
      wire.push(trimSub(p.sub));
    }

    const body = stringifyBigInt({ subrequests: wire });

    let resp: { status: number; text: string };
    try {
      resp = await this.transport.send(body);
    } catch (e) {
      const fault: ApiFault = { kind: 'network', message: String(e) };
      this.emitFault(fault);
      this.failAll(batch, fault);
      return;
    }

    if (resp.status >= 400) {
      const fault: ApiFault = { kind: 'http', status: resp.status };
      this.emitFault(fault);
      this.failAll(batch, fault);
      return;
    }

    let parsed: unknown;
    try {
      parsed = reviveIds(JSON.parse(resp.text));
    } catch (e) {
      const fault: ApiFault = { kind: 'decode', message: `bad_response: ${String(e)}` };
      this.emitFault(fault);
      this.failAll(batch, fault);
      return;
    }

    const rawSubs =
      parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)['subresponses']
        : undefined;
    if (!Array.isArray(rawSubs)) {
      const fault: ApiFault = { kind: 'decode', message: 'bad_response: no subresponses' };
      this.emitFault(fault);
      this.failAll(batch, fault);
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
      const sr = subs.get(respIdOf.get(p.sub.id) ?? p.sub.id);
      if (!sr) {
        const fault: ApiFault = { kind: 'aborted', reason: 'missing_subresponse' };
        this.emitFault(fault);
        if (p.alive()) p.onFault(fault);
        continue;
      }
      if (sr.ok) {
        if (!p.alive()) continue;
        try {
          const decoded = p.decode(sr.data);
          p.onOk(decoded);
        } catch (e) {
          const fault: ApiFault = { kind: 'decode', message: `decode_error: ${String(e)}` };
          this.emitFault(fault);
          if (p.alive()) p.onFault(fault);
        }
        continue;
      }
      const err = sr.error;
      if (err && err.code === 'aborted') {
        const reason = err.message.length > 0 ? err.message : 'aborted';
        const fault: ApiFault = { kind: 'aborted', reason };
        this.emitFault(fault);
        if (p.alive()) p.onFault(fault);
      } else {
        const fault: ApiFault = {
          kind: 'sub_error',
          code: err?.code ?? 'unknown_error',
          message: err?.message ?? '',
          ...(err?.detail !== undefined ? { detail: err.detail } : {}),
        };
        this.emitFault(fault);
        if (p.alive()) p.onFault(fault);
      }
    }
    // Success path: the whole batch has been delivered — release its count.
    this.inFlightSig.set(this.inFlightSig.peek() - batch.length);
  }
}

/** Empty ref/key/data are omitted, matching the Svelte client's toJson. */
function trimSub(s: SubRequest): Record<string, unknown> {
  const m: Record<string, unknown> = {
    id: s.id,
    type: s.type,
    endpoint: s.endpoint,
    action: s.action,
  };
  if (s.ref && Object.keys(s.ref).length > 0) m.ref = s.ref;
  if (s.key && Object.keys(s.key).length > 0) m.key = s.key;
  if (s.data !== null && s.data !== undefined) m.data = s.data;
  return m;
}

function subResponseFromJson(raw: Record<string, unknown>): SubResponse {
  let error: SubError | undefined;
  const e = raw['error'];
  if (e && typeof e === 'object') {
    const obj = e as Record<string, unknown>;
    error = {
      code: typeof obj['code'] === 'string' ? obj['code'] : '',
      message: typeof obj['message'] === 'string' ? obj['message'] : '',
    };
    if (obj['detail'] !== undefined && obj['detail'] !== null) error.detail = obj['detail'];
  }
  const out: SubResponse = {
    id: typeof raw['id'] === 'string' ? raw['id'] : '',
    ok: raw['ok'] === true,
    data: raw['data'],
  };
  if (error) out.error = error;
  return out;
}

/** crypto.randomUUID when available; tiny fallback otherwise (drops uuid dep). */
function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'sub-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
