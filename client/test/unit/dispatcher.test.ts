/**
 * Dispatcher unit tests.
 *
 * Each test injects a synchronous schedule (`(cb) => cb()`) so a manual call
 * to `dispatcher.flushNow()` is the only thing that triggers the POST. This
 * lets us assert "exactly one HTTP call per tick" deterministically.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  Dispatcher,
  type HandlerRegistryLike,
  type HandlerSpec,
} from '../../src/dispatch/dispatcher.js';
import { BatchAbortedError, SubRequestError } from '../../src/dispatch/errors.js';

/* -------------------------------------------------------------------------- */
/* Test helpers                                                               */
/* -------------------------------------------------------------------------- */

class TestRegistry implements HandlerRegistryLike {
  private by = new Map<string, HandlerSpec<unknown, unknown>>();

  register<I, R>(spec: HandlerSpec<I, R>): void {
    this.by.set(`${spec.endpoint}.${spec.action}`, spec as HandlerSpec<unknown, unknown>);
  }

  lookup<I = unknown, R = unknown>(
    endpoint: string,
    action: string,
  ): HandlerSpec<I, R> | undefined {
    return this.by.get(`${endpoint}.${action}`) as HandlerSpec<I, R> | undefined;
  }
}

/** Identity codecs cover most of these tests where the wire shape == input. */
const identitySpec = (endpoint: string, action: string): HandlerSpec<unknown, unknown> => ({
  endpoint,
  action,
  encode: (i) => i,
  decode: (r) => r,
});

/** Build a `Response`-like object with the given status + JSON body. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Mint a fresh fake `fetch` returning a sequence of responses. */
function sequenceFetch(responses: Response[]): ReturnType<typeof vi.fn> {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[i++];
    if (r === undefined) throw new Error('sequenceFetch: out of responses');
    return r;
  });
}

/**
 * No-op schedule: do not fire the flush callback automatically. Tests trigger
 * the flush manually with `flushNow()` so we can assert per-tick coalescing
 * without races.
 */
const noopSchedule = (_cb: () => void): void => {
  // intentionally empty
};

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('Dispatcher', () => {
  it('coalesces all tick-local request() calls into one POST', async () => {
    // Five distinct registered handlers — one POST should carry all five.
    const reg = new TestRegistry();
    for (let i = 0; i < 5; i++) {
      reg.register(identitySpec('e', `a${i}`));
    }

    // Build a server response with all five subresponses (we capture the
    // request body to read back the ids).
    let postedBody: string | undefined;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      postedBody = init.body as string;
      const parsed = JSON.parse(postedBody) as { subrequests: Array<{ id: string }> };
      const subresponses = parsed.subrequests.map((s, idx) => ({
        id: s.id,
        ok: true,
        data: { idx },
      }));
      return jsonResponse(200, { subresponses });
    });

    const d = new Dispatcher({
      apiBase: 'http://test',
      registry: reg,
      fetch: fetchMock as unknown as typeof fetch,
      schedule: noopSchedule,
    });

    const promises: Array<Promise<unknown>> = [];
    for (let i = 0; i < 5; i++) {
      promises.push(d.request({ endpoint: 'e', action: `a${i}` }));
    }

    await d.flushNow();
    const results = await Promise.all(promises);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('http://test/api/v1/batch');
    expect(postedBody).toBeDefined();
    const parsed = JSON.parse(postedBody!) as { subrequests: unknown[] };
    expect(parsed.subrequests).toHaveLength(5);
    expect(results).toHaveLength(5);
  });

  it('routes each subresponse through its own decode()', async () => {
    const reg = new TestRegistry();
    const decodeA = vi.fn((raw: unknown) => ({ kind: 'A', raw }));
    const decodeB = vi.fn((raw: unknown) => ({ kind: 'B', raw }));
    reg.register({
      endpoint: 'e', action: 'a',
      encode: (i) => i,
      decode: decodeA,
    });
    reg.register({
      endpoint: 'e', action: 'b',
      encode: (i) => i,
      decode: decodeB,
    });

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(init.body as string) as {
        subrequests: Array<{ id: string; action: string }>;
      };
      const subresponses = parsed.subrequests.map((s) => ({
        id: s.id,
        ok: true,
        data: { tag: s.action.toUpperCase() },
      }));
      return jsonResponse(200, { subresponses });
    });

    const d = new Dispatcher({
      apiBase: 'http://test',
      registry: reg,
      fetch: fetchMock as unknown as typeof fetch,
      schedule: noopSchedule,
    });

    const pa = d.request({ endpoint: 'e', action: 'a' });
    const pb = d.request({ endpoint: 'e', action: 'b' });
    await d.flushNow();
    const [a, b] = await Promise.all([pa, pb]);

    expect(decodeA).toHaveBeenCalledTimes(1);
    expect(decodeA).toHaveBeenCalledWith({ tag: 'A' });
    expect(decodeB).toHaveBeenCalledTimes(1);
    expect(decodeB).toHaveBeenCalledWith({ tag: 'B' });
    expect(a).toEqual({ kind: 'A', raw: { tag: 'A' } });
    expect(b).toEqual({ kind: 'B', raw: { tag: 'B' } });
  });

  it('refreshes once on 401 and retries the same body', async () => {
    const reg = new TestRegistry();
    reg.register(identitySpec('e', 'a'));

    // Capture every request body so we can assert the second one is identical.
    const sentBodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      sentBodies.push(init.body as string);
      if (sentBodies.length === 1) {
        return new Response('unauthorized', { status: 401 });
      }
      const parsed = JSON.parse(init.body as string) as {
        subrequests: Array<{ id: string }>;
      };
      const sub = parsed.subrequests[0]!;
      return jsonResponse(200, {
        subresponses: [{ id: sub.id, ok: true, data: { ok: true } }],
      });
    });

    const onUnauthorized = vi.fn(async () => true);
    const d = new Dispatcher({
      apiBase: 'http://test',
      registry: reg,
      fetch: fetchMock as unknown as typeof fetch,
      schedule: noopSchedule,
      authState: { isSignedIn: true },
      onUnauthorized,
    });

    const p = d.request({ endpoint: 'e', action: 'a', data: { x: 1 } });
    await d.flushNow();
    const result = await p;

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBodies[0]).toBe(sentBodies[1]); // identical retry body
    expect(result).toEqual({ ok: true });
  });

  it('fails the whole batch with BatchAbortedError on 5xx', async () => {
    const reg = new TestRegistry();
    reg.register(identitySpec('e', 'a'));
    reg.register(identitySpec('e', 'b'));

    const fetchMock = sequenceFetch([
      new Response('boom', { status: 500 }),
    ]);

    const d = new Dispatcher({
      apiBase: 'http://test',
      registry: reg,
      fetch: fetchMock as unknown as typeof fetch,
      schedule: noopSchedule,
    });

    const pa = d.request({ endpoint: 'e', action: 'a' });
    const pb = d.request({ endpoint: 'e', action: 'b' });
    await d.flushNow();

    await expect(pa).rejects.toBeInstanceOf(BatchAbortedError);
    await expect(pb).rejects.toBeInstanceOf(BatchAbortedError);
    await expect(pa).rejects.toMatchObject({ reason: 'http_500' });
  });

  it('routes a per-pending decode_error as BatchAbortedError; siblings still resolve', async () => {
    const reg = new TestRegistry();
    reg.register({
      endpoint: 'e', action: 'bad',
      encode: (i) => i,
      decode: () => {
        throw new Error('boom');
      },
    });
    reg.register(identitySpec('e', 'good'));

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(init.body as string) as {
        subrequests: Array<{ id: string; action: string }>;
      };
      return jsonResponse(200, {
        subresponses: parsed.subrequests.map((s) => ({
          id: s.id,
          ok: true,
          data: { from: s.action },
        })),
      });
    });

    const d = new Dispatcher({
      apiBase: 'http://test',
      registry: reg,
      fetch: fetchMock as unknown as typeof fetch,
      schedule: noopSchedule,
    });

    const pBad = d.request({ endpoint: 'e', action: 'bad' });
    const pGood = d.request({ endpoint: 'e', action: 'good' });
    await d.flushNow();

    await expect(pBad).rejects.toBeInstanceOf(BatchAbortedError);
    await expect(pBad).rejects.toMatchObject({
      reason: expect.stringContaining('decode_error'),
    });
    await expect(pGood).resolves.toEqual({ from: 'good' });
  });

  it('rejects synchronously with SubRequestError(unknown_handler) when no spec exists', async () => {
    const reg = new TestRegistry();
    const fetchMock = vi.fn();
    const d = new Dispatcher({
      apiBase: 'http://test',
      registry: reg,
      fetch: fetchMock as unknown as typeof fetch,
      schedule: noopSchedule,
    });

    const p = d.request({ endpoint: 'nope', action: 'missing' });
    await expect(p).rejects.toBeInstanceOf(SubRequestError);
    await expect(p).rejects.toMatchObject({ code: 'unknown_handler' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
