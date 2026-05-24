import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';

let M;
before(async () => {
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/core.js`);
});

/* -------------------------------------------------------------------------- */
/* A fake Api that captures the LAST callByName invocation and lets the test  */
/* synchronously deliver an onOk result or an onErr fault. No real dispatcher  */
/* needed — the data layer only ever touches the callback surface.            */
/* -------------------------------------------------------------------------- */

function fakeApi() {
  const calls = [];
  return {
    calls,
    callByName(specKey, data, onOk, opts = {}) {
      calls.push({ specKey, data, onOk, opts });
      return 'fake-id';
    },
    /** Deliver a success to the most recent call. */
    deliverOk(out) {
      const c = calls.at(-1);
      if (c.opts.alive && !c.opts.alive()) return; // respect the alive gate
      c.onOk(out);
    },
    /** Deliver a fault to the most recent call. */
    deliverFault(fault) {
      const c = calls.at(-1);
      if (c.opts.alive && !c.opts.alive()) return;
      c.opts.onErr?.(fault);
    },
  };
}

/** A fake DataHost wrapping the real tree + a captured intent table. */
function fakeHost(M, { queries = [], actions = [], config = {}, scope } = {}) {
  const api = fakeApi();
  const tree = new M.TreeNode({}, []);
  const handlers = new Map();
  const intents = new Map();
  const faults = [];
  let alive = true;
  const disposers = [];
  const host = {
    ctx: { api, tree },
    config,
    ...(scope ? { scope } : {}),
    dataQueries: () => queries,
    dataActions: () => actions,
    findHandler: (name) => handlers.get(name),
    setFault: (f) => faults.push(f),
    isAlive: () => alive,
    addDisposer: (fn) => disposers.push(fn),
    onIntent: (name, fn) => {
      if (!intents.has(name)) intents.set(name, []);
      intents.get(name).push(fn);
    },
  };
  return {
    host,
    api,
    tree,
    faults,
    handler: (name, fn) => handlers.set(name, fn),
    fireIntent: (name, payload) => (intents.get(name) ?? []).forEach((fn) => fn(payload)),
    kill: () => {
      alive = false;
    },
    dispose: () => disposers.splice(0).forEach((d) => d()),
  };
}

/* -------------------------------------------------------------------------- */
/* resolveInput.                                                               */
/* -------------------------------------------------------------------------- */

test('resolveInput: lit / config / payload / from(tree) / from(scope)', () => {
  const { resolveInput, TreeNode } = M;
  const tree = new TreeNode({}, []);
  tree.at(['user', 'id']).set(42n);
  const input = resolveInput(
    {
      a: { lit: 'hello' },
      b: { config: 'cardTypeName' },
      c: { payload: 'title' },
      d: { from: 'user.id' },
      e: { from: 'scope.flag' },
    },
    {
      tree,
      config: { cardTypeName: 'task' },
      scope: { flag: true },
      payload: { title: 'Buy milk' },
    },
  );
  assert.deepEqual(input, {
    a: 'hello',
    b: 'task',
    c: 'Buy milk',
    d: 42n,
    e: true,
  });
});

test('resolveInput: empty/absent spec yields {}', () => {
  const { resolveInput, TreeNode } = M;
  assert.deepEqual(resolveInput(undefined, { tree: new TreeNode({}, []), config: {} }), {});
});

/* -------------------------------------------------------------------------- */
/* Query: fires on mount.                                                      */
/* -------------------------------------------------------------------------- */

test('query fires once on mount; toPath result lands in the tree', () => {
  const { DataController } = M;
  const f = fakeHost(M, {
    queries: [
      {
        name: 'load',
        spec: 'card.list',
        when: 'mount',
        input: { card_type_name: { config: 'cardTypeName' } },
        result: { toPath: 'screen.tasks' },
      },
    ],
    config: { cardTypeName: 'task' },
  });
  const dc = new DataController(f.host, f.tree);
  dc.wire();
  assert.equal(f.api.calls.length, 1, 'mount fired the query exactly once');
  assert.deepEqual(f.api.calls[0].data, { card_type_name: 'task' }, 'input built from config');

  f.api.deliverOk({ rows: [{ id: 1n }] });
  assert.deepEqual(f.tree.at(['screen', 'tasks']).peek(), { rows: [{ id: 1n }] }, 'toPath wrote result');
});

/* -------------------------------------------------------------------------- */
/* Query: fires on a signal trigger (tree path change).                        */
/* -------------------------------------------------------------------------- */

test('query with { signal } trigger refetches when the watched path changes', () => {
  const { DataController, flushSync } = M;
  const f = fakeHost(M, {
    queries: [
      {
        name: 'byProject',
        spec: 'card.list',
        when: { signal: 'filters.projectId' },
        input: { project_id: { from: 'filters.projectId' } },
        result: { toPath: 'screen.tasks' },
      },
    ],
  });
  const dc = new DataController(f.host, f.tree);
  dc.wire();
  // The signal-trigger effect runs once eagerly on wiring.
  assert.equal(f.api.calls.length, 1, 'signal trigger fires once on wire (initial read)');

  f.tree.at(['filters', 'projectId']).set(7n);
  flushSync();
  assert.equal(f.api.calls.length, 2, 'changing the watched path refetched');
  assert.deepEqual(f.api.calls[1].data, { project_id: 7n }, 'input rebuilt from the new tree value');

  // A no-op write (Object.is gate) does NOT refetch.
  f.tree.at(['filters', 'projectId']).set(7n);
  flushSync();
  assert.equal(f.api.calls.length, 2, 'no-op write did not refetch (cascade-safe)');
});

/* -------------------------------------------------------------------------- */
/* Action: optimistic apply + rollback on fault.                               */
/* -------------------------------------------------------------------------- */

test('action: optimistic patch applies immediately, commits on success', () => {
  const { DataController } = M;
  const f = fakeHost(M, {
    actions: [
      {
        intent: 'add',
        spec: 'card.create',
        input: { title: { payload: 'title' } },
        optimistic: {
          path: 'screen.tasks',
          patch: (cur, payload) => [...(Array.isArray(cur) ? cur : []), { id: -1n, title: payload.title }],
        },
        result: { toPath: 'screen.tasks' },
        onError: 'top',
      },
    ],
  });
  f.tree.at(['screen', 'tasks']).set([{ id: 1n, title: 'old' }]);
  const dc = new DataController(f.host, f.tree);
  dc.wire();

  f.fireIntent('add', { title: 'new' });
  // Optimistic row applied BEFORE the server replies.
  assert.deepEqual(f.tree.at(['screen', 'tasks']).peek(), [
    { id: 1n, title: 'old' },
    { id: -1n, title: 'new' },
  ]);
  assert.deepEqual(f.api.calls[0].data, { title: 'new' }, 'action input from payload');

  // Server replies with the authoritative set; result toPath overwrites.
  f.api.deliverOk([{ id: 1n, title: 'old' }, { id: 9n, title: 'new' }]);
  assert.deepEqual(f.tree.at(['screen', 'tasks']).peek(), [
    { id: 1n, title: 'old' },
    { id: 9n, title: 'new' },
  ]);
});

test('action: optimistic patch ROLLS BACK on fault', () => {
  const { DataController } = M;
  const f = fakeHost(M, {
    actions: [
      {
        intent: 'add',
        spec: 'card.create',
        optimistic: {
          path: 'screen.tasks',
          patch: (cur) => [...(Array.isArray(cur) ? cur : []), { id: -1n, title: 'temp' }],
        },
        onError: 'top',
      },
    ],
  });
  const original = [{ id: 1n, title: 'old' }];
  f.tree.at(['screen', 'tasks']).set(original);
  const dc = new DataController(f.host, f.tree);
  dc.wire();

  f.fireIntent('add', {});
  assert.equal(f.tree.at(['screen', 'tasks']).peek().length, 2, 'optimistic row present');

  f.api.deliverFault({ kind: 'sub_error', code: 'nope', message: 'denied' });
  assert.deepEqual(f.tree.at(['screen', 'tasks']).peek(), original, 'snapshot restored on fault');
});

/* -------------------------------------------------------------------------- */
/* Error routing: self vs top vs method.                                       */
/* -------------------------------------------------------------------------- */

test("error route 'self' delivers the fault to the control's setFault", () => {
  const { DataController } = M;
  const f = fakeHost(M, {
    queries: [{ name: 'load', spec: 'card.list', when: 'mount', result: { toPath: 'x' }, onError: 'self' }],
  });
  const dc = new DataController(f.host, f.tree);
  dc.wire();
  f.api.deliverFault({ kind: 'sub_error', code: 'boom', message: 'bad' });
  assert.equal(f.faults.length, 1, 'self route delivered to setFault');
  assert.equal(f.faults[0].code, 'boom');
});

test("error route 'top' does NOT touch the control (central funnel handles it)", () => {
  const { DataController } = M;
  const f = fakeHost(M, {
    actions: [{ intent: 'go', spec: 'card.do', onError: 'top' }],
  });
  const dc = new DataController(f.host, f.tree);
  dc.wire();
  f.fireIntent('go', {});
  f.api.deliverFault({ kind: 'sub_error', code: 'boom', message: 'bad' });
  assert.equal(f.faults.length, 0, "top route leaves self-representation untouched");
});

test('error route { method } invokes the named handler with the fault', () => {
  const { DataController } = M;
  const got = [];
  const f = fakeHost(M, {
    queries: [
      { name: 'load', spec: 'card.list', when: 'mount', result: { toPath: 'x' }, onError: { method: 'onLoadErr' } },
    ],
  });
  f.handler('onLoadErr', (fault) => got.push(fault));
  const dc = new DataController(f.host, f.tree);
  dc.wire();
  f.api.deliverFault({ kind: 'sub_error', code: 'boom', message: 'bad' });
  assert.equal(got.length, 1, 'method route invoked the named handler');
  assert.equal(got[0].code, 'boom');
});

/* -------------------------------------------------------------------------- */
/* Result via { method } sink + alive gating.                                  */
/* -------------------------------------------------------------------------- */

test('result { method } invokes the named handler with the decoded result', () => {
  const { DataController } = M;
  const got = [];
  const f = fakeHost(M, {
    queries: [{ name: 'load', spec: 'card.list', when: 'mount', result: { method: 'land' } }],
  });
  f.handler('land', (out) => got.push(out));
  const dc = new DataController(f.host, f.tree);
  dc.wire();
  f.api.deliverOk({ rows: [1, 2] });
  assert.deepEqual(got, [{ rows: [1, 2] }]);
});

test('mergePath structurally merges into the tree', () => {
  const { DataController } = M;
  const f = fakeHost(M, {
    queries: [{ name: 'load', spec: 'card.get', when: 'mount', result: { mergePath: 'screen' } }],
  });
  f.tree.at(['screen', 'title']).set('keep');
  const dc = new DataController(f.host, f.tree);
  dc.wire();
  f.api.deliverOk({ count: 5 });
  assert.equal(f.tree.at(['screen', 'title']).peek(), 'keep', 'untouched sibling preserved');
  assert.equal(f.tree.at(['screen', 'count']).peek(), 5, 'merged field landed');
});
