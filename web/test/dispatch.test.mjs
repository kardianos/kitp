import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';

let D;
let A;
before(async () => {
  const outdir = await buildTestBundles();
  D = await import(`${outdir}/core.js`);
  A = D;
});

/** A transport that records the bodies it received and replays canned replies. */
function recordingTransport(reply) {
  const sent = [];
  return {
    sent,
    async send(body) {
      sent.push(JSON.parse(body));
      return reply(JSON.parse(body));
    },
  };
}

test('CALLBACK SURFACE: request returns just { id } — no promise', () => {
  const { Dispatcher } = D;
  const disp = new Dispatcher({ transport: recordingTransport(() => ({ status: 200, text: '{}' })) });
  const r = disp.request({ endpoint: 'x', action: 'a' });
  assert.deepEqual(Object.keys(r), ['id'], 'request returns ONLY { id }');
  assert.equal(typeof r.id, 'string');
  assert.equal(r.done, undefined, 'no `done` promise on the returned handle');
});

test('one POST per flush coalesces a burst of calls (onOk callbacks)', async () => {
  const { Dispatcher } = D;
  const t = recordingTransport((req) => ({
    status: 200,
    text: JSON.stringify({
      subresponses: req.subrequests.map((s) => ({ id: s.id, ok: true, data: { echo: s.action } })),
    }),
  }));
  // Default (microtask) schedule: two requests in the same synchronous tick
  // coalesce into ONE POST.
  const disp = new Dispatcher({ transport: t });
  const got = {};
  disp.request({ endpoint: 'x', action: 'a' }, (out) => (got.a = out));
  disp.request({ endpoint: 'x', action: 'b' }, (out) => (got.b = out));
  await disp.flushNow(); // TEST-ONLY internal hook drives the flush
  assert.equal(t.sent.length, 1, 'two requests in one tick -> exactly one POST');
  assert.equal(t.sent[0].subrequests.length, 2);
  assert.deepEqual(got.a, { echo: 'a' });
  assert.deepEqual(got.b, { echo: 'b' });
});

test('flushNow(done) callback form fires without the caller awaiting', async () => {
  const { Dispatcher } = D;
  const t = recordingTransport((req) => ({
    status: 200,
    text: JSON.stringify({ subresponses: req.subrequests.map((s) => ({ id: s.id, ok: true, data: {} })) }),
  }));
  const disp = new Dispatcher({ transport: t });
  disp.request({ endpoint: 'x', action: 'a' });
  await new Promise((resolve) => disp.flushNow(resolve));
  assert.equal(t.sent.length, 1, 'flush completed and the done callback fired');
});

test('bigint id revival on the way in', async () => {
  const { Dispatcher } = D;
  const big = '9007199254740993'; // > Number.MAX_SAFE_INTEGER
  const t = recordingTransport((req) => ({
    status: 200,
    text: JSON.stringify({
      subresponses: req.subrequests.map((s) => ({
        id: s.id,
        ok: true,
        data: { id: big, parent_id: '5', tag_ids: ['100', '200'] },
      })),
    }),
  }));
  const disp = new Dispatcher({ transport: t });
  let out;
  disp.request({ endpoint: 'card', action: 'get' }, (o) => (out = o));
  await disp.flushNow();
  assert.equal(typeof out.id, 'bigint', 'id field revived to bigint');
  assert.equal(out.id, BigInt(big), 'full int64 precision preserved');
  assert.equal(out.parent_id, 5n);
  assert.deepEqual(out.tag_ids, [100n, 200n], '_ids-suffixed arrays revived element-wise');
});

test('outgoing bigint stringified to JSON string', async () => {
  const { Dispatcher } = D;
  const t = recordingTransport((req) => ({
    status: 200,
    text: JSON.stringify({ subresponses: req.subrequests.map((s) => ({ id: s.id, ok: true, data: {} })) }),
  }));
  const disp = new Dispatcher({ transport: t, schedule: (cb) => cb() });
  disp.request({ endpoint: 'card', action: 'set', data: { card_id: 42n } });
  await disp.flushNow();
  assert.equal(t.sent[0].subrequests[0].data.card_id, '42', 'bigint serialized as a JSON string');
});

test('sub_error funnels through onFault AND delivers the fault to the call', async () => {
  const { Dispatcher } = D;
  const t = recordingTransport((req) => ({
    status: 200,
    text: JSON.stringify({
      subresponses: req.subrequests.map((s) => ({
        id: s.id,
        ok: false,
        error: { code: 'flow_disallowed', message: 'nope', detail: { from: 'open' } },
      })),
    }),
  }));
  const disp = new Dispatcher({ transport: t, schedule: (cb) => cb() });
  const faults = [];
  disp.onFault('sub_error', (f) => faults.push(f));
  const perCall = [];
  disp.request({ endpoint: 'attribute', action: 'update' }, () => {}, (f) => perCall.push(f));
  await disp.flushNow();
  assert.equal(faults.length, 1, 'fault funneled exactly once');
  assert.equal(faults[0].kind, 'sub_error');
  assert.equal(faults[0].code, 'flow_disallowed');
  assert.deepEqual(faults[0].detail, { from: 'open' }, 'structured detail carried over');
  assert.equal(perCall.length, 1, 'per-call onFault also invoked');
  assert.equal(perCall[0].code, 'flow_disallowed');
});

test('http error funnels and faults all in the batch', async () => {
  const { Dispatcher } = D;
  const t = recordingTransport(() => ({ status: 500, text: 'boom' }));
  const disp = new Dispatcher({ transport: t });
  const httpFaults = [];
  disp.onFault('http', (f) => httpFaults.push(f.status));
  const aFaults = [];
  const bFaults = [];
  disp.request({ endpoint: 'x', action: 'a' }, () => {}, (f) => aFaults.push(f));
  disp.request({ endpoint: 'x', action: 'b' }, () => {}, (f) => bFaults.push(f));
  await disp.flushNow();
  assert.equal(t.sent.length, 1, 'both requests share one (failed) POST');
  assert.deepEqual(httpFaults, [500], 'http fault emitted once for the batch');
  assert.equal(aFaults[0].kind, 'http', 'call a got the http fault');
  assert.equal(bFaults[0].kind, 'http', 'call b got the http fault');
});

test('Api.call: declarative spec + onOk, encode/decode applied (no promise)', async () => {
  const { Dispatcher } = D;
  const { Api } = A;
  const t = recordingTransport((req) => ({
    status: 200,
    text: JSON.stringify({
      subresponses: req.subrequests.map((s) => ({ id: s.id, ok: true, data: { rows: [{ n: 1 }, { n: 2 }] } })),
    }),
  }));
  const disp = new Dispatcher({ transport: t, schedule: (cb) => cb() });
  const api = new Api(disp);
  const Spec = api.define({
    endpoint: 'card',
    action: 'list',
    encode: (input) => ({ card_type_name: input.typeName }),
    decode: (raw) => ({ count: raw.rows.length }),
  });
  let got;
  api.call(Spec, { typeName: 'task' }, (out) => {
    got = out;
  });
  await disp.flushNow();
  assert.equal(t.sent[0].subrequests[0].data.card_type_name, 'task', 'encode applied');
  assert.deepEqual(got, { count: 2 }, 'decode applied + onOk invoked synchronously on delivery');
});

test('Api.callByName: resolves a spec by endpoint.action key', async () => {
  const { Dispatcher } = D;
  const { Api } = A;
  const t = recordingTransport((req) => ({
    status: 200,
    text: JSON.stringify({ subresponses: req.subrequests.map((s) => ({ id: s.id, ok: true, data: { v: 7 } })) }),
  }));
  const disp = new Dispatcher({ transport: t, schedule: (cb) => cb() });
  const api = new Api(disp);
  api.define({ endpoint: 'card', action: 'peek', decode: (raw) => raw.v });
  let got;
  const id = api.callByName('card.peek', {}, (out) => (got = out));
  await disp.flushNow();
  assert.equal(typeof id, 'string');
  assert.equal(got, 7, 'callByName resolved + delivered');

  // Unknown key routes a decode-shaped fault to onErr, returns ''.
  const faults = [];
  const id2 = api.callByName('card.nope', {}, () => {}, { onErr: (f) => faults.push(f) });
  assert.equal(id2, '', 'unknown spec key returns empty id');
  assert.equal(faults[0].kind, 'decode');
});

test('Api.call: alive=false drops the response (destroyed control)', async () => {
  const { Dispatcher } = D;
  const { Api } = A;
  const t = recordingTransport((req) => ({
    status: 200,
    text: JSON.stringify({ subresponses: req.subrequests.map((s) => ({ id: s.id, ok: true, data: {} })) }),
  }));
  const disp = new Dispatcher({ transport: t, schedule: (cb) => cb() });
  const api = new Api(disp);
  const Spec = api.define({ endpoint: 'x', action: 'y' });
  let called = false;
  api.call(Spec, {}, () => {
    called = true;
  }, { alive: () => false });
  await disp.flushNow();
  assert.equal(called, false, 'onOk not invoked when the call is no longer alive');
});

test('IN-FLIGHT SIGNAL: rises on enqueue, returns to 0 after a batch settles', async () => {
  const { Dispatcher } = D;
  const t = recordingTransport((req) => ({
    status: 200,
    text: JSON.stringify({
      subresponses: req.subrequests.map((s) => ({ id: s.id, ok: true, data: {} })),
    }),
  }));
  const disp = new Dispatcher({ transport: t });
  assert.equal(disp.inFlight.peek(), 0, 'idle at rest');
  disp.request({ endpoint: 'x', action: 'a' });
  disp.request({ endpoint: 'x', action: 'b' });
  assert.equal(disp.inFlight.peek(), 2, 'two enqueued → in-flight 2');
  await disp.flushNow();
  assert.equal(disp.inFlight.peek(), 0, 'settled → back to 0');
});

test('IN-FLIGHT SIGNAL: an HTTP error path also releases the count', async () => {
  const { Dispatcher } = D;
  const disp = new Dispatcher({ transport: recordingTransport(() => ({ status: 500, text: '' })) });
  disp.request({ endpoint: 'x', action: 'a' });
  assert.equal(disp.inFlight.peek(), 1);
  await disp.flushNow();
  assert.equal(disp.inFlight.peek(), 0, 'failAll released the in-flight count');
});
