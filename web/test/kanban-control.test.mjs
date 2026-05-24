import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
let FakeElement;

before(async () => {
  ({ FakeElement } = installDomShim());
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  // Register the real screen controls once (Control.register throws on dup).
  M.registerScreenFilterBar();
  M.registerScreenHost();
  M.registerKanbanControls();
});

beforeEach(() => {
  M._resetDragState();
});

/**
 * Each column's cards render via the recycling virtualList: a FIXED pool of
 * card nodes is content-swapped, so `[data-kanban-card]` matches every pooled
 * node (visible AND parked). The VISIBLE cards are the pool nodes the column is
 * showing — those whose `display` is not 'none'. Tests assert on this visible
 * window + the data-card-id hook, never a node-per-card count of the whole pool.
 */
function visibleCards(column) {
  return column
    .querySelectorAll('[data-kanban-card]')
    .filter((c) => c.style.display !== 'none');
}

/* -------------------------------------------------------------------------- */
/* A real Dispatcher driven by the mock transport, flushed synchronously via   */
/* the test-only flushNow hook. This exercises the REAL wire encode/decode +   */
/* bigint revival path end-to-end.                                             */
/* -------------------------------------------------------------------------- */

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api);
  return { dispatcher, api };
}

/** Drive every queued flush to completion (mock transport resolves sync-ish). */
async function settle(dispatcher) {
  await dispatcher.flushNow();
  // A second flush in case a delivery enqueued follow-ups (none here, cheap).
  await dispatcher.flushNow();
  M.flushSync?.();
}

/* -------------------------------------------------------------------------- */
/* Kanban query: tasks land in the tree and bucket into columns.               */
/* -------------------------------------------------------------------------- */

test('Kanban query lands tasks + milestones and buckets into columns', async () => {
  const { dispatcher, api } = bootApi(M.mockTransport());
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(M.DEMO_PROJECT_ID);
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const ctx = { api, tree, scope };

  const kanban = M.Control.New('Kanban', { type: 'Kanban' }, ctx);
  const host = new FakeElement('div');
  kanban.mount(host); // mount wires the data layer → fires the two queries

  await settle(dispatcher);

  // Tasks landed in the tree (6 seeded).
  const tasks = tree.at(['kanban', 'tasks']).peek();
  assert.equal(tasks.length, 6, 'six seeded tasks landed');
  // milestone_ref revived to bigint (card_ref attr registered in specs).
  const withMs = tasks.find((t) => t.id === 201n);
  assert.equal(typeof withMs.attributes.milestone_ref, 'bigint', 'milestone_ref revived to bigint');

  // Milestones (axis value-cards) landed.
  const axis = tree.at(['kanban', 'milestones']).peek();
  assert.equal(axis.length, 3, 'three milestones landed');

  // The board rendered columns: M1, M2, M3, then (unset).
  const cols = kanban.el.querySelectorAll('[data-kanban-column]');
  assert.equal(cols.length, 4, 'three milestone columns + (unset)');
  const keys = cols.map((c) => c.dataset.column);
  assert.deepEqual(keys, ['32', '33', '34', '__unset__'], 'columns keyed by value-card id + unset');

  // Column M1 (id 32) holds tasks 201 + 202; (unset) holds 206.
  const m1 = cols[0];
  const m1Cards = visibleCards(m1);
  assert.deepEqual(
    m1Cards.map((c) => c.dataset.cardId),
    ['201', '202'],
    'M1 bucketed its two tasks in sort_order',
  );
  const unset = cols[3];
  const unsetCards = visibleCards(unset);
  assert.deepEqual(
    unsetCards.map((c) => c.dataset.cardId),
    ['206'],
    'the no-milestone task landed in the (unset) column',
  );
});

/* -------------------------------------------------------------------------- */
/* The Advanced predicate (shared screen.predicate leaf) narrows the Kanban    */
/* tasks query the same way it narrows the Grid (where[] / tree).              */
/* -------------------------------------------------------------------------- */

/** A recording task transport for the Kanban predicate test: tasks + milestones,
 *  recording the tasks-query input so a test can read where[]/tree. */
function recordingKanbanTransport() {
  const sent = { taskInputs: [] };
  const row = (id, type, attrs) => ({
    id: String(id),
    card_type_id: type === 'task' ? '5' : '9',
    card_type_name: type,
    parent_card_id: '100',
    attributes: attrs,
  });
  const TASKS = [
    row(201n, 'task', { title: 'A', sort_order: 100, milestone_ref: '32' }),
    row(202n, 'task', { title: 'B', sort_order: 200 }),
  ];
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => {
        const key = `${sr.endpoint}.${sr.action}`;
        if (key === 'card.select_with_attributes') {
          const data = sr.data ?? {};
          if (data.card_type_name === 'task') {
            sent.taskInputs.push(data);
            return { id: sr.id, ok: true, data: { rows: TASKS } };
          }
          if (data.card_type_name === 'milestone') {
            return { id: sr.id, ok: true, data: { rows: [row(32n, 'milestone', { title: 'M1' })] } };
          }
          return { id: sr.id, ok: true, data: { rows: [] } };
        }
        return { id: sr.id, ok: false, error: { code: 'unknown_handler', message: `no ${key}` } };
      });
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
  transport.sent = sent;
  return transport;
}

test('Kanban: the shared screen.predicate narrows the tasks query (where[] flat AND, tree structured)', async () => {
  const transport = recordingKanbanTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(100n);
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const ctx = { api, tree, scope };
  const kanban = M.Control.New('Kanban', { type: 'Kanban' }, ctx);
  kanban.mount(new FakeElement('div'));
  await settle(dispatcher);

  const firesBefore = transport.sent.taskInputs.length;

  // A flat-AND predicate (one leaf) → fed into where[].
  tree.at(['screen', 'predicate']).set({
    kind: 'group',
    connective: 'and',
    children: [{ kind: 'leaf', attr: 'milestone_ref', op: 'in', values: ['32'] }],
  });
  await settle(dispatcher);
  let last = transport.sent.taskInputs[transport.sent.taskInputs.length - 1];
  assert.deepEqual(last.where, [{ attr: 'milestone_ref', op: 'in', values: ['32'] }], 'flat-AND → where[]');
  assert.equal(last.tree, undefined, 'no tree for a flat AND');
  assert.ok(transport.sent.taskInputs.length > firesBefore, 'predicate change refired the tasks query');

  // A structured (OR) predicate → fed into the v2 tree field instead.
  tree.at(['screen', 'predicate']).set({
    kind: 'group',
    connective: 'or',
    children: [{ kind: 'leaf', attr: 'title', op: 'contains', values: ['x'] }],
  });
  await settle(dispatcher);
  last = transport.sent.taskInputs[transport.sent.taskInputs.length - 1];
  assert.deepEqual(
    last.tree,
    { connective: 'or', children: [{ attr: 'title', op: 'contains', values: ['x'] }] },
    'structured → tree',
  );
  assert.equal(last.where, undefined, 'no where[] for a structured tree (no search)');
});

/* -------------------------------------------------------------------------- */
/* Each column's cards render through the recycling virtualList (spacer +      */
/* content + a pooled set of card nodes), NOT one DOM node per card.           */
/* -------------------------------------------------------------------------- */

test('Kanban: each column renders its cards through the recycling virtualList', async () => {
  const { dispatcher, api } = bootApi(M.mockTransport());
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(M.DEMO_PROJECT_ID);
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const ctx = { api, tree, scope };
  const kanban = M.Control.New('Kanban', { type: 'Kanban' }, ctx);
  kanban.mount(new FakeElement('div'));
  await settle(dispatcher);

  const cols = kanban.el.querySelectorAll('[data-kanban-column]');
  const m1 = cols[0]; // M1 (id 32) has two cards (201, 202)
  const body = m1.querySelector('[data-kanban-column-body]');
  assert.ok(body, 'column body present');
  // The virtualList installs its spacer + content layer inside the column body.
  const spacer = body.querySelectorAll('[data-role]').find((e) => e.dataset.role === 'vlist-spacer');
  assert.ok(spacer, 'virtualList spacer mounted in the column body');
  const content = body.querySelectorAll('[data-role]').find((e) => e.dataset.role === 'vlist-content');
  assert.ok(content, 'virtualList content layer mounted in the column body');
  // The cards are the recycling pool; exactly two are VISIBLE for the two cards.
  assert.equal(visibleCards(m1).length, 2, 'two visible cards (rest of the pool parked)');
});

/* -------------------------------------------------------------------------- */
/* The column row is the horizontal scroll container (issue #14): it carries    */
/* the visible-scrollbar `.scroll-x` class so overflowing columns scroll        */
/* horizontally instead of clipping.                                            */
/* -------------------------------------------------------------------------- */

test('Kanban: the column row carries the horizontal scroll class (#14)', async () => {
  const { dispatcher, api } = bootApi(M.mockTransport());
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(M.DEMO_PROJECT_ID);
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const ctx = { api, tree, scope };
  const kanban = M.Control.New('Kanban', { type: 'Kanban' }, ctx);
  kanban.mount(new FakeElement('div'));
  await settle(dispatcher);

  const board = kanban.el.querySelector('[data-kanban-board]');
  assert.ok(board, 'the column row (board) is present');
  assert.ok(
    board.classList.contains('scroll-x'),
    'the column row wears the .scroll-x horizontal-scroll class',
  );
});

/* -------------------------------------------------------------------------- */
/* Optimistic move: applies immediately, re-buckets, commits on success.       */
/* -------------------------------------------------------------------------- */

test('Kanban moveTask: optimistic re-bucket applies immediately, commits on success', async () => {
  const { dispatcher, api } = bootApi(M.mockTransport());
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(M.DEMO_PROJECT_ID);
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const ctx = { api, tree, scope };
  const kanban = M.Control.New('Kanban', { type: 'Kanban' }, ctx);
  kanban.mount(new FakeElement('div'));
  await settle(dispatcher);

  // Move task 201 from M1 (32) to M2 (33). Fire the declarative action intent.
  kanban.intent('moveTask', { cardId: 201n, attributeName: 'milestone_ref', value: 33n });

  // OPTIMISTIC: the tree reflects the new bucket BEFORE the server replies.
  const t201 = tree.at(['kanban', 'tasks']).peek().find((t) => t.id === 201n);
  assert.equal(t201.attributes.milestone_ref, 33n, 'optimistic patch moved the card to M2');

  await settle(dispatcher);

  // SUCCESS: the optimistic value stands (mock returns ok; no reload here).
  const after = tree.at(['kanban', 'tasks']).peek().find((t) => t.id === 201n);
  assert.equal(after.attributes.milestone_ref, 33n, 'committed move persists');
});

/* -------------------------------------------------------------------------- */
/* Optimistic move ROLLS BACK on a forced fault.                               */
/* -------------------------------------------------------------------------- */

test('Kanban moveTask: optimistic patch ROLLS BACK on fault (auto)', async () => {
  const { dispatcher, api } = bootApi(M.mockTransport());
  let topFault = null;
  dispatcher.onFault('sub_error', (f) => {
    topFault = f;
  });
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(M.DEMO_PROJECT_ID);
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const ctx = { api, tree, scope };
  const kanban = M.Control.New('Kanban', { type: 'Kanban' }, ctx);
  kanban.mount(new FakeElement('div'));
  await settle(dispatcher);

  // Seed a task whose id is the mock's forced-fault id, in M1.
  const tasks = tree.at(['kanban', 'tasks']).peek();
  const faulting = {
    id: M.FAULT_CARD_ID,
    card_type_id: 5n,
    card_type_name: 'task',
    attributes: { title: 'Doomed move', sort_order: 50, milestone_ref: 32n },
  };
  tree.at(['kanban', 'tasks']).set([...tasks, faulting]);

  // Move it to M2 (33) — the mock forces a fault for FAULT_CARD_ID.
  kanban.intent('moveTask', { cardId: M.FAULT_CARD_ID, attributeName: 'milestone_ref', value: 33n });

  // Optimistic patch applied first.
  const mid = tree.at(['kanban', 'tasks']).peek().find((t) => t.id === M.FAULT_CARD_ID);
  assert.equal(mid.attributes.milestone_ref, 33n, 'optimistic move applied before the fault');

  await settle(dispatcher);

  // ROLLBACK: the move reverted to the original milestone (32) on fault.
  const after = tree.at(['kanban', 'tasks']).peek().find((t) => t.id === M.FAULT_CARD_ID);
  assert.equal(after.attributes.milestone_ref, 32n, 'tree rolled back to the pre-move value');
  assert.ok(topFault, 'the fault funneled to the central (top) handler');
  assert.equal(topFault.code, 'flow_disallowed');
});

/* -------------------------------------------------------------------------- */
/* ScreenHost dispatch: kanban → Kanban, unknown layout → NotFound.            */
/* -------------------------------------------------------------------------- */

test('layoutToControlType maps known layouts and flags unknowns', () => {
  assert.equal(M.layoutToControlType('kanban'), 'Kanban');
  assert.equal(M.layoutToControlType('list'), 'Inbox');
  assert.equal(M.layoutToControlType('grid'), 'Grid');
  assert.equal(M.layoutToControlType('project'), 'Project');
  assert.match(M.layoutToControlType('bogus'), /UnknownLayout/);
});

test('ScreenHost dispatches a kanban screen to the Kanban control', () => {
  const { api } = bootApi(M.mockTransport());
  const tree = new M.TreeNode({}, []);
  const ctx = { api, tree, scope: { projectId: null } };
  const host = M.Control.New(
    'ScreenHost',
    { type: 'ScreenHost', screen: { slug: 'kanban', layout: 'kanban', title: 'Kanban' } },
    ctx,
  );
  const mountEl = new FakeElement('div');
  host.mount(mountEl);

  const body = host.el.querySelector('.screen-host__body');
  assert.ok(body, 'body region rendered');
  assert.equal(body.dataset.layout, 'kanban');
  // The Kanban control mounted into the body.
  const kanbans = body.findByControl('Kanban');
  assert.equal(kanbans.length, 1, 'kanban layout resolved to a Kanban control');
  // The shared ScreenFilterBar mounted above.
  const bars = host.el.findByControl('ScreenFilterBar');
  assert.equal(bars.length, 1, 'filter bar mounted');
});

test('ScreenHost dispatches an UNKNOWN layout to the NotFound placeholder', () => {
  const { api } = bootApi(M.mockTransport());
  const tree = new M.TreeNode({}, []);
  const ctx = { api, tree, scope: { projectId: null } };
  const host = M.Control.New(
    'ScreenHost',
    { type: 'ScreenHost', screen: { slug: 'mystery', layout: 'hologram' }, filterBar: false },
    ctx,
  );
  host.mount(new FakeElement('div'));

  const body = host.el.querySelector('.screen-host__body');
  const nf = body.findByControl('NotFound');
  assert.equal(nf.length, 1, 'unknown layout fell through to a visible NotFound');
  assert.match(nf[0].textContent, /Unknown control/, 'NotFound names the unresolved control');
});
