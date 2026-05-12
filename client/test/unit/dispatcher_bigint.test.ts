/**
 * Verify that ids exceeding Number.MAX_SAFE_INTEGER (2^53 − 1) round-trip
 * through the dispatcher with full precision intact.
 *
 * This is the gate test for the "id-as-bigint, numbers on the wire"
 * decision: if the dispatcher's JSON layer can preserve a 60-bit id, the
 * client is safe against the user's future "unique integer mapping
 * rules" producing ids beyond the JS safe-integer range.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  clearCardRefAttrRegistry,
  Dispatcher,
  registerCardRefAttr,
  reviveIds,
  type HandlerRegistryLike,
  type HandlerSpec,
} from '../../src/dispatch/dispatcher.js';

class TestRegistry implements HandlerRegistryLike {
  private by = new Map<string, HandlerSpec<unknown, unknown>>();
  register<I, R>(spec: HandlerSpec<I, R>): void {
    this.by.set(
      `${spec.endpoint}.${spec.action}`,
      spec as HandlerSpec<unknown, unknown>,
    );
  }
  lookup<I = unknown, R = unknown>(
    endpoint: string,
    action: string,
  ): HandlerSpec<I, R> | undefined {
    return this.by.get(`${endpoint}.${action}`) as
      | HandlerSpec<I, R>
      | undefined;
  }
}

const noopSchedule = (_cb: () => void): void => {
  // tests trigger flushNow() manually
};

// 2^53 + 1 — the smallest positive integer that JS Number cannot
// represent exactly. JSON.parse rounds it down to 2^53. If the dispatcher
// round-trips this value intact, every larger id is safe by induction.
const LARGE_LITERAL = '9007199254740993';
const LARGE_BIGINT = 9007199254740993n;

/**
 * Build a fetch mock that echoes the request's sub ids back and injects
 * `respData` as the single subresponse's data field. Because the dispatcher
 * keys subresponses by id, we have to read the outgoing UUID from the
 * request body before composing the response.
 */
function echoIdFetch(respData: string): {
  fetch: ReturnType<typeof vi.fn>;
  sentBody: () => string;
} {
  let sentBody = '';
  const fn = vi.fn(async (_url: unknown, init: { body?: string } | undefined) => {
    sentBody = init?.body ?? '';
    // Pull the sub-request id out of the body. The dispatcher emits
    // `subrequests:[{id, endpoint, action, data}]` so a regex is enough.
    const m = /"id"\s*:\s*"([^"]+)"/.exec(sentBody);
    const subId = m?.[1] ?? 'unknown';
    return new Response(
      `{"subresponses":[{"id":"${subId}","ok":true,"data":${respData}}]}`,
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  return { fetch: fn, sentBody: () => sentBody };
}

describe('dispatcher bigint round-trip', () => {
  it('preserves a 60-bit id sent by the server', async () => {
    const reg = new TestRegistry();
    reg.register({
      endpoint: 'card',
      action: 'insert',
      encode: (i: unknown) => i,
      // Decoder is an identity passthrough; the dispatcher is responsible
      // for converting id-named numbers to bigint before the decoder runs.
      decode: (r: unknown) => r,
    });

    // Server emits ids as JSON strings via `json:",string"`.
    const { fetch: fetchMock } = echoIdFetch(`{"id":"${LARGE_LITERAL}"}`);
    const d = new Dispatcher({
      apiBase: '',
      registry: reg,
      fetch: fetchMock as unknown as typeof fetch,
      schedule: noopSchedule,
    });

    const p = d.request({ endpoint: 'card', action: 'insert', data: {} });
    d.flushNow();
    const result = (await p) as { id: bigint };

    expect(typeof result.id).toBe('bigint');
    expect(result.id).toBe(LARGE_BIGINT);
  });

  it('preserves a 60-bit id inside a nested id-named array', async () => {
    const reg = new TestRegistry();
    reg.register({
      endpoint: 'tag',
      action: 'apply',
      encode: (i: unknown) => i,
      decode: (r: unknown) => r,
    });

    const { fetch: fetchMock } = echoIdFetch(
      `{"removed_tag_ids":["${LARGE_LITERAL}","42"]}`,
    );
    const d = new Dispatcher({
      apiBase: '',
      registry: reg,
      fetch: fetchMock as unknown as typeof fetch,
      schedule: noopSchedule,
    });

    const p = d.request({ endpoint: 'tag', action: 'apply', data: {} });
    d.flushNow();
    const result = (await p) as { removed_tag_ids: bigint[] };

    expect(result.removed_tag_ids).toEqual([LARGE_BIGINT, 42n]);
  });

  it('revives card_ref attribute values registered via the schema cache', () => {
    // The demo seed writes attribute values as JSON numbers via
    // `to_jsonb(bigint)`; through the dispatcher writes they're JSON
    // strings. Either way the rendering layer expects bigint so the
    // picker option lookup (strict-equality) succeeds.
    //
    // Card_ref names are no longer hard-coded; the schema cache
    // registers them with the dispatcher on load(). Simulate that here
    // by registering the names directly, then walking the reviver.
    clearCardRefAttrRegistry();
    registerCardRefAttr('assignee', false);
    registerCardRefAttr('milestone_ref', false);
    registerCardRefAttr('component_ref', false);
    registerCardRefAttr('default_filter', false);
    registerCardRefAttr('tags', true);
    const before = {
      attributes: {
        assignee: 2,
        milestone_ref: '8',
        component_ref: 11,
        default_filter: '42', // screen.default_filter is a card_ref → filter
        sort_order: 100, // unrelated integer — must not be revived
        tags: [16, '17'], // mixed string + number, both must end up bigint
      },
    };
    const after = reviveIds(JSON.parse(JSON.stringify(before))) as {
      attributes: Record<string, unknown>;
    };
    expect(after.attributes.assignee).toBe(2n);
    expect(after.attributes.milestone_ref).toBe(8n);
    expect(after.attributes.component_ref).toBe(11n);
    expect(after.attributes.default_filter).toBe(42n);
    expect(after.attributes.tags).toEqual([16n, 17n]);
    // sort_order is a primitive number attribute and must remain a number.
    expect(after.attributes.sort_order).toBe(100);
  });

  it('emits a 60-bit bigint in the outgoing request with full precision', async () => {
    const reg = new TestRegistry();
    reg.register({
      endpoint: 'card',
      action: 'update',
      encode: (i: unknown) => i,
      decode: (r: unknown) => r,
    });

    const { fetch: fetchMock, sentBody } = echoIdFetch('{}');
    const d = new Dispatcher({
      apiBase: '',
      registry: reg,
      fetch: fetchMock as unknown as typeof fetch,
      schedule: noopSchedule,
    });

    void d.request({
      endpoint: 'card',
      action: 'update',
      data: { card_id: LARGE_BIGINT },
    });
    d.flushNow();
    await vi.waitFor(() => expect(sentBody()).not.toBe(''));

    // The raw digits must appear in the body — quoted as a JSON string
    // (strings-on-wire) is fine, raw integer is fine too, but an
    // IEEE-rounded value would lose the trailing bits.
    expect(sentBody()).toContain(LARGE_LITERAL);
  });
});
