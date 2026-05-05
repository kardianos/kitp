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

import { BatchAbortedError, SubRequestError } from './errors.js';
import {
  type SubRequest,
  type SubResponse,
  subRequestToJson,
  subResponseFromJson,
} from './subrequest.js';

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
  accessToken: string | null;
  isSignedIn: boolean;
}

/* -------------------------------------------------------------------------- */
/* Internal Pending record — one per in-flight `request()` call.              */
/* -------------------------------------------------------------------------- */

interface Pending {
  sub: SubRequest;
  decode: Decode<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

/* -------------------------------------------------------------------------- */
/* Schedule fn: rAF when available (coalesces a render burst), microtask     */
/* fallback for tests / non-DOM environments.                                 */
/* -------------------------------------------------------------------------- */

export type Schedule = (cb: () => void) => void;

const defaultSchedule: Schedule = (cb) => {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(() => cb());
  } else {
    queueMicrotask(cb);
  }
};

/* -------------------------------------------------------------------------- */
/* Dispatcher options                                                         */
/* -------------------------------------------------------------------------- */

export interface DispatcherOptions {
  apiBase: string;
  registry: HandlerRegistryLike;
  /** Optional fetch override; defaults to global `fetch`. Tests inject a mock. */
  fetch?: typeof fetch;
  /** Optional auth state. When set & signed-in, adds `Authorization` header. */
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

  constructor(opts: DispatcherOptions) {
    this.apiBase = opts.apiBase;
    this.registry = opts.registry;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.authState = opts.authState;
    this.onUnauthorized = opts.onUnauthorized;
    this.schedule = opts.schedule ?? defaultSchedule;
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
        sub,
        decode: spec.decode as Decode<unknown>,
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
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    const tok = this.authState?.accessToken;
    if (tok && tok.length > 0) {
      h['Authorization'] = `Bearer ${tok}`;
    }
    return h;
  }

  private async flush(): Promise<void> {
    if (!this.flushScheduled && this.queue.length === 0) return;
    this.flushScheduled = false;
    if (this.queue.length === 0) return;

    // Snapshot + clear at the top so any `request()` calls made while we are
    // awaiting fetch are queued for the *next* batch.
    const batch = this.queue;
    this.queue = [];

    const body = JSON.stringify({
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
      this.failAll(batch, new BatchAbortedError(String(e)));
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
          this.failAll(batch, new BatchAbortedError(String(e)));
          return;
        }
      }
    }

    if (resp.status >= 400) {
      // 4xx / 5xx: the body has no per-sub-response slots, so the batch
      // contract collapses to "every future fails the same way."
      this.failAll(batch, new BatchAbortedError(`http_${resp.status}`));
      return;
    }

    let parsed: unknown;
    try {
      const text = await resp.text();
      parsed = JSON.parse(text);
    } catch (e) {
      this.failAll(batch, new BatchAbortedError(`bad_response: ${String(e)}`));
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      this.failAll(batch, new BatchAbortedError('bad_response: not an object'));
      return;
    }
    const rawSubs = (parsed as Record<string, unknown>)['subresponses'];
    if (!Array.isArray(rawSubs)) {
      this.failAll(batch, new BatchAbortedError('bad_response: no subresponses'));
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
        p.reject(new BatchAbortedError('missing_subresponse'));
        continue;
      }
      if (sr.ok) {
        try {
          const out = p.decode(sr.data);
          p.resolve(out);
        } catch (e) {
          p.reject(new BatchAbortedError(`decode_error: ${String(e)}`));
        }
        continue;
      }
      const err = sr.error;
      if (err && err.code === 'aborted') {
        p.reject(new BatchAbortedError(err.message.length > 0 ? err.message : 'aborted'));
      } else {
        p.reject(
          new SubRequestError(err?.code ?? 'unknown_error', err?.message ?? ''),
        );
      }
    }
  }

  private failAll(batch: readonly Pending[], error: unknown): void {
    for (const p of batch) {
      p.reject(error);
    }
  }
}
