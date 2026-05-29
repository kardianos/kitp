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
  // Prime the non-milestone axis card_ref attrs (status / component_ref /
  // assignee) so their values revive to bigint when grouping by those axes —
  // exactly what main.ts does at boot. Idempotent (Set-backed in the dispatcher).
  M.registerGridCardRefAttrs();
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

/* -------------------------------------------------------------------------- */
/* GROUP picker drives the column axis: re-key by status / component / etc.    */
/* -------------------------------------------------------------------------- */

/**
 * A transport that serves tasks + every axis value-card type (milestone /
 * status / component / person) so the GROUP-axis re-key can be exercised. Tasks
 * carry BOTH a milestone_ref AND a status so the same task set buckets two ways.
 * It records the tasks-query inputs so a test can assert the axis change does
 * NOT re-issue the tasks query (re-key is a board-only re-render).
 */
function multiAxisKanbanTransport() {
  const sent = { taskInputs: [] };
  const row = (id, type, parent, attrs) => ({
    id: String(id),
    card_type_id: type === 'task' ? '5' : '9',
    card_type_name: type,
    parent_card_id: parent === null ? undefined : String(parent),
    attributes: attrs,
  });
  // 4 tasks: two in status 50, one in status 51, one with no status.
  const TASKS = [
    row(201n, 'task', 100, { title: 'A', sort_order: 100, milestone_ref: '32', status: '50' }),
    row(202n, 'task', 100, { title: 'B', sort_order: 200, milestone_ref: '33', status: '50' }),
    row(203n, 'task', 100, { title: 'C', sort_order: 100, milestone_ref: '32', status: '51' }),
    row(204n, 'task', 100, { title: 'D', sort_order: 300, milestone_ref: '34' }), // no status
  ];
  const MILESTONES = [row(32n, 'milestone', 100, { title: 'M1' }), row(33n, 'milestone', 100, { title: 'M2' }), row(34n, 'milestone', 100, { title: 'M3' })];
  const STATUSES = [row(50n, 'status', 100, { title: 'To do' }), row(51n, 'status', 100, { title: 'Doing' })];
  const COMPONENTS = [row(60n, 'component', 100, { title: 'API' })];
  const PERSONS = [row(70n, 'person', null, { title: 'Ada' })];
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => {
        const key = `${sr.endpoint}.${sr.action}`;
        if (key === 'card.select_with_attributes') {
          const data = sr.data ?? {};
          switch (data.card_type_name) {
            case 'task':
              sent.taskInputs.push(data);
              return { id: sr.id, ok: true, data: { rows: TASKS } };
            case 'milestone':
              return { id: sr.id, ok: true, data: { rows: MILESTONES } };
            case 'status':
              return { id: sr.id, ok: true, data: { rows: STATUSES } };
            case 'component':
              return { id: sr.id, ok: true, data: { rows: COMPONENTS } };
            case 'person':
              return { id: sr.id, ok: true, data: { rows: PERSONS } };
            default:
              return { id: sr.id, ok: true, data: { rows: [] } };
          }
        }
        if (key === 'attribute.update') {
          return { id: sr.id, ok: true, data: { ok: true, activity_id: '70001' } };
        }
        return { id: sr.id, ok: false, error: { code: 'unknown_handler', message: `no ${key}` } };
      });
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
  transport.sent = sent;
  return transport;
}

function bootMultiAxisKanban() {
  const transport = multiAxisKanbanTransport();
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
  return { transport, dispatcher, tree, kanban };
}

test('Kanban: multi-field search ships a v2 leaf shape the server accepts', async () => {
  // Reproduces the "Failed to load kanban: internal: contains: missing value"
  // error reported when description / comments is added to the search set.
  // The kanban's wire `tree` field must carry leaf nodes that the predicate
  // compiler can extract a needle from — either { value } (v1) or { values }
  // (v2). Bare { attr, op } leaves trigger the missing-value RAISE.
  const { dispatcher, tree } = bootMultiAxisKanban();
  await settle(dispatcher);

  // Type a needle + activate description.
  tree.at(['screen', 'search']).set('foo');
  tree.at(['screen', 'searchFields']).set(['title', 'description']);
  await settle(dispatcher);

  const wireTree = tree.at(['kanban', 'tree']).peek();
  assert.equal(wireTree.connective, 'or', 'multi-field rides on an OR tree');
  for (const leaf of wireTree.children) {
    // Tree leaves MUST use the plural `values` form — the Go-side
    // CardWhereTreeNode struct has no `Value` field, so the singular form is
    // silently dropped on unmarshal and the predicate compiler raises
    // "contains: missing value".
    assert.ok(
      Array.isArray(leaf.values) && leaf.values.length > 0,
      `leaf for ${leaf.attr} ships values:[...] (the singular value is dropped server-side)`,
    );
    assert.equal(leaf.values[0], 'foo', 'needle survives in values[0]');
  }
});

test('Kanban: no GROUP set → default milestone axis (unchanged)', async () => {
  const { dispatcher, kanban } = bootMultiAxisKanban();
  await settle(dispatcher);
  // No screen.group → columns keyed by milestone value-cards (32/33/34) + unset.
  const cols = kanban.el.querySelectorAll('[data-kanban-column]');
  assert.deepEqual(
    cols.map((c) => c.dataset.column),
    ['32', '33', '34', '__unset__'],
    'default axis buckets by milestone_ref',
  );
  // Column 32 holds the two milestone-32 tasks (201, 203).
  assert.deepEqual(
    visibleCards(cols[0]).map((c) => c.dataset.cardId),
    ['201', '203'],
    'milestone 32 column holds its tasks',
  );
});

test('Kanban: GROUP=status re-keys columns to statuses + (unset)', async () => {
  const { transport, dispatcher, tree, kanban } = bootMultiAxisKanban();
  await settle(dispatcher);
  const taskFiresBefore = transport.sent.taskInputs.length;

  // Pick GROUP=status (what ScreenFilterBar's picker writes).
  tree.at(['screen', 'groupAxis']).set({ attr: 'status', lookup: 'statuses' });
  await settle(dispatcher);

  // Columns are now keyed by status value-cards (50 'To do', 51 'Doing') + unset.
  const cols = kanban.el.querySelectorAll('[data-kanban-column]');
  assert.deepEqual(
    cols.map((c) => c.dataset.column),
    ['50', '51', '__unset__'],
    'columns re-keyed to status value-cards + (unset)',
  );
  // Header labels resolve from the status cards' title attribute.
  assert.equal(cols[0].querySelector('.col__label').textContent, 'To do');
  assert.equal(cols[1].querySelector('.col__label').textContent, 'Doing');
  // Status 50 holds tasks 201 + 202; the no-status task (204) lands in (unset).
  assert.deepEqual(visibleCards(cols[0]).map((c) => c.dataset.cardId), ['201', '202']);
  assert.deepEqual(visibleCards(cols[2]).map((c) => c.dataset.cardId), ['204']);

  // Re-keying is a board-only re-render — it must NOT re-issue the tasks query.
  assert.equal(
    transport.sent.taskInputs.length,
    taskFiresBefore,
    'GROUP change re-keys without re-fetching tasks',
  );
});

test('Kanban: cross-column move updates the ACTIVE axis attr (status when grouped by status)', async () => {
  const { dispatcher, tree, kanban } = bootMultiAxisKanban();
  await settle(dispatcher);
  tree.at(['screen', 'groupAxis']).set({ attr: 'status', lookup: 'statuses' });
  await settle(dispatcher);

  // Drag task 201 (status 50) onto the 'Doing' column (status 51). Simulate the
  // native DnD start so the module-level drag id is set, then drop on the body.
  const cols = kanban.el.querySelectorAll('[data-kanban-column]');
  const card201 = visibleCards(cols[0]).find((c) => c.dataset.cardId === '201');
  card201.dispatchEvent({ type: 'dragstart', target: card201 });
  const toBody = cols[1].querySelector('[data-kanban-column-body]');
  toBody.dispatchEvent({ type: 'drop', target: toBody, clientY: 0 });

  // OPTIMISTIC: the dragged card's STATUS (the active axis attr) flips to 51 —
  // NOT milestone_ref, which the card keeps.
  const t201 = tree.at(['kanban', 'tasks']).peek().find((t) => t.id === 201n);
  assert.equal(t201.attributes.status, 51n, 'cross-column drop re-keyed the status axis attr');
  assert.equal(t201.attributes.milestone_ref, 32n, 'milestone_ref is untouched (status is the axis)');

  await settle(dispatcher);
  const after = tree.at(['kanban', 'tasks']).peek().find((t) => t.id === 201n);
  assert.equal(after.attributes.status, 51n, 'committed status move persists');
  // It re-bucketed: 201 now sits in the Doing column.
  const colsAfter = kanban.el.querySelectorAll('[data-kanban-column]');
  assert.ok(
    visibleCards(colsAfter[1]).some((c) => c.dataset.cardId === '201'),
    '201 re-bucketed into the Doing (status 51) column',
  );
});

test('Kanban: column order follows the value-cards\' explicit sort_order', async () => {
  // Same multi-axis harness but with REVERSE-order milestones: the server
  // returns them id-ASC (32, 33, 34), and the kanban must re-order them by
  // their explicit `sort_order` attribute (3, 1, 2 → board shows 33, 34, 32).
  // Pre-fix the kanban honoured first-seen / server order.
  const sent = { taskInputs: [] };
  const row = (id, type, parent, attrs) => ({
    id: String(id), card_type_id: type === 'task' ? '5' : '9',
    card_type_name: type,
    parent_card_id: parent === null ? undefined : String(parent),
    attributes: attrs,
  });
  const TASKS = [
    row(201n, 'task', 100, { title: 'A', sort_order: 100, milestone_ref: '32' }),
    row(202n, 'task', 100, { title: 'B', sort_order: 200, milestone_ref: '33' }),
    row(203n, 'task', 100, { title: 'C', sort_order: 300, milestone_ref: '34' }),
  ];
  // Server returns 32/33/34 in id order; the kanban must reorder by sort_order.
  const MILESTONES = [
    row(32n, 'milestone', 100, { title: 'M1', sort_order: 3 }),
    row(33n, 'milestone', 100, { title: 'M2', sort_order: 1 }),
    row(34n, 'milestone', 100, { title: 'M3', sort_order: 2 }),
  ];
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => {
        if (sr.endpoint === 'card' && sr.action === 'select_with_attributes') {
          const d = sr.data ?? {};
          if (d.card_type_name === 'task') { sent.taskInputs.push(d); return { id: sr.id, ok: true, data: { rows: TASKS } }; }
          if (d.card_type_name === 'milestone') return { id: sr.id, ok: true, data: { rows: MILESTONES } };
          return { id: sr.id, ok: true, data: { rows: [] } };
        }
        return { id: sr.id, ok: false, error: { code: 'unknown_handler', message: '' } };
      });
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(100n);
  const scope = { get projectId() { return tree.at(['scope', 'projectId']).peek() ?? null; } };
  const ctx = { api, tree, scope };
  const kanban = M.Control.New('Kanban', { type: 'Kanban' }, ctx);
  kanban.mount(new FakeElement('div'));
  await settle(dispatcher);

  // Columns ordered by milestone sort_order (1: 33, 2: 34, 3: 32) + (unset).
  const cols = kanban.el.querySelectorAll('[data-kanban-column]');
  assert.deepEqual(
    cols.map((c) => c.dataset.column),
    ['33', '34', '32', '__unset__'],
    'column order follows the milestone value-cards\' explicit sort_order',
  );
});

test('Kanban: a cross-column drop lands at the dropped slot (respects order)', async () => {
  const { dispatcher, tree, kanban } = bootMultiAxisKanban();
  await settle(dispatcher);
  tree.at(['screen', 'groupAxis']).set({ attr: 'status', lookup: 'statuses' });
  await settle(dispatcher);

  // cols[0] = To do (50, holds 201+202), cols[1] = Doing (51, holds 203).
  const cols = kanban.el.querySelectorAll('[data-kanban-column]');
  const toBody = cols[1].querySelector('[data-kanban-column-body]');
  toBody.dataset.dropSlot = '0'; // drop 201 at the TOP of Doing (before 203)
  const card201 = visibleCards(cols[0]).find((c) => c.dataset.cardId === '201');
  card201.dispatchEvent({ type: 'dragstart', target: card201 });
  toBody.dispatchEvent({ type: 'drop', target: toBody, clientY: 0 });

  const t = (id) => tree.at(['kanban', 'tasks']).peek().find((x) => x.id === id);
  assert.equal(t(201n).attributes.status, 51n, '201 re-keyed into Doing');
  // Cross-column drop now ALSO sets sort_order so it lands where dropped:
  // dropped at slot 0 → 201 sorts before the existing Doing card (203).
  assert.ok(
    t(201n).attributes.sort_order < t(203n).attributes.sort_order,
    `201 placed before 203 (sort ${t(201n).attributes.sort_order} < ${t(203n).attributes.sort_order})`,
  );

  await settle(dispatcher);
  const doingAfter = kanban.el.querySelectorAll('[data-kanban-column]')[1];
  assert.deepEqual(
    visibleCards(doingAfter).map((c) => c.dataset.cardId),
    ['201', '203'],
    'Doing shows 201 (dropped at top) then 203',
  );
});

test('Kanban: within-column drag rewrites sort_order optimistically (planSortRewrite)', async () => {
  const { dispatcher, tree, kanban } = bootMultiAxisKanban();
  await settle(dispatcher);
  // Default milestone axis. Column 32 holds 201 (sort 100) + 203 (sort 100).
  // Add a third card to column 32 so a reorder produces visible rewrites.
  const seeded = tree.at(['kanban', 'tasks']).peek();
  assert.ok(seeded.find((t) => t.id === 201n), 'tasks seeded');

  const cols = kanban.el.querySelectorAll('[data-kanban-column]');
  const m1 = cols[0]; // milestone 32: cards 201, 203 (both sort_order 100)
  const body = m1.querySelector('[data-kanban-column-body]');

  // Drag card 203 to the TOP of its own column (slot 0). The shim has no
  // layout, so drive the slot via the test seam data-drop-slot.
  body.dataset.dropSlot = '0';
  const card203 = visibleCards(m1).find((c) => c.dataset.cardId === '203');
  card203.dispatchEvent({ type: 'dragstart', target: card203 });
  body.dispatchEvent({ type: 'drop', target: body, clientY: 0 });

  // OPTIMISTIC: planSortRewrite renumbers the destination cell to canonical
  // (i+1)*STEP spacing with 203 first → 203:100, 201:200. status/milestone are
  // unchanged (same column → no axis re-key).
  const tasks = tree.at(['kanban', 'tasks']).peek();
  const t203 = tasks.find((t) => t.id === 203n);
  const t201 = tasks.find((t) => t.id === 201n);
  assert.equal(t203.attributes.sort_order, 100, '203 rewritten to slot 0 (100)');
  assert.equal(t201.attributes.sort_order, 200, '201 pushed to slot 1 (200)');
  assert.equal(t203.attributes.milestone_ref, 32n, 'milestone_ref untouched (within-column)');

  await settle(dispatcher);
  // The re-order persists; 203 now renders before 201 in the column.
  const colsAfter = kanban.el.querySelectorAll('[data-kanban-column]');
  assert.deepEqual(
    visibleCards(colsAfter[0]).map((c) => c.dataset.cardId),
    ['203', '201'],
    'within-column reorder placed 203 before 201',
  );
});

/* -------------------------------------------------------------------------- */
/* Animated drop placeholder (#1): a gliding bar shows the insertion gap.       */
/* -------------------------------------------------------------------------- */

test('Kanban: drag shows a drop placeholder in the column, hidden on dragend (#1)', async () => {
  const { dispatcher, kanban } = bootMultiAxisKanban();
  await settle(dispatcher);

  const cols = kanban.el.querySelectorAll('[data-kanban-column]');
  const body = cols[0].querySelector('[data-kanban-column-body]');
  const placeholder = body.querySelectorAll('[data-drop-placeholder]')[0];
  assert.ok(placeholder, 'a placeholder bar lives in the column body');
  assert.equal(placeholder.style.display, 'none', 'hidden at rest');

  const card = visibleCards(cols[0])[0];
  card.dispatchEvent({ type: 'dragstart', target: card });
  body.dispatchEvent({ type: 'dragover', target: body, clientY: 10 });
  assert.notEqual(placeholder.style.display, 'none', 'placeholder shown during dragover');

  card.dispatchEvent({ type: 'dragend', target: card });
  assert.equal(placeholder.style.display, 'none', 'placeholder hidden on dragend');
});

test('Kanban: the moved card settles into its new slot on drop (#context)', async () => {
  const { dispatcher, kanban } = bootMultiAxisKanban();
  await settle(dispatcher);

  const m1 = kanban.el.querySelectorAll('[data-kanban-column]')[0];
  const body = m1.querySelector('[data-kanban-column-body]');
  body.dataset.dropSlot = '0';
  const card203 = visibleCards(m1).find((c) => c.dataset.cardId === '203');
  card203.dispatchEvent({ type: 'dragstart', target: card203 });
  body.dispatchEvent({ type: 'drop', target: body, clientY: 0 });
  await settle(dispatcher);

  const after = visibleCards(kanban.el.querySelectorAll('[data-kanban-column]')[0]);
  const moved = after.find((c) => c.dataset.cardId === '203');
  const other = after.find((c) => c.dataset.cardId === '201');
  assert.ok(moved.classList.contains('card--settling'), 'the moved card carries the settle class');
  assert.ok(!other.classList.contains('card--settling'), 'an untouched card does not');
});

test('Kanban: a task created elsewhere (tasks.createdNonce) refetches the board', async () => {
  const { transport, dispatcher, tree } = bootMultiAxisKanban();
  await settle(dispatcher);
  const before = transport.sent.taskInputs.length;

  // Simulate the quick-entry overlay's post-create broadcast.
  const nonce = tree.at(['tasks', 'createdNonce']);
  nonce.set((nonce.peek() ?? 0) + 1);
  await settle(dispatcher);

  assert.ok(
    transport.sent.taskInputs.length > before,
    'createdNonce bump re-issued the kanban tasks query',
  );
});

/* -------------------------------------------------------------------------- */
/* Card click / Enter / o navigates into the task detail (`/task/:id`).         */
/* -------------------------------------------------------------------------- */

test('Kanban: clicking a card navigates to /task/:id', async () => {
  const { dispatcher, api } = bootApi(M.mockTransport());
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(M.DEMO_PROJECT_ID);
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const kanban = M.Control.New('Kanban', { type: 'Kanban' }, { api, tree, scope });
  kanban.mount(new FakeElement('div'));
  await settle(dispatcher);

  const card = visibleCards(kanban.el.querySelectorAll('[data-kanban-column]')[0])[0];
  const id = card.dataset.cardId;
  card.dispatchEvent({ type: 'click', target: card });
  assert.equal(location.pathname, `/task/${id}`, 'card click navigated to the task detail');
});

test('Kanban: Enter / o on a focused card opens the task detail', async () => {
  const { dispatcher, api } = bootApi(M.mockTransport());
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(M.DEMO_PROJECT_ID);
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const kanban = M.Control.New('Kanban', { type: 'Kanban' }, { api, tree, scope });
  kanban.mount(new FakeElement('div'));
  await settle(dispatcher);

  const card = visibleCards(kanban.el.querySelectorAll('[data-kanban-column]')[0])[0];
  const id = card.dataset.cardId;
  card.dispatchEvent({ type: 'keydown', key: 'Enter', target: card });
  assert.equal(location.pathname, `/task/${id}`, '`Enter` opened the task detail');
});

/* -------------------------------------------------------------------------- */
/* Per-column "+" quick-add raises quickCreateOpen with the lane prefill.       */
/* -------------------------------------------------------------------------- */

test('Kanban: column "+" raises quickCreateOpen prefilled to that column axis', async () => {
  const { dispatcher, api } = bootApi(M.mockTransport());
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(M.DEMO_PROJECT_ID);
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const intents = [];
  const bus = { emit: (type, detail) => intents.push({ type, detail }) };
  const ctx = { api, tree, scope, bus };

  const kanban = M.Control.New('Kanban', { type: 'Kanban' }, ctx);
  kanban.mount(new FakeElement('div'));
  await settle(dispatcher);

  // Click the "+" on the M1 milestone column (key '32'); default axis = milestone.
  const add = kanban.el.querySelectorAll('[data-kanban-column-add]').find(
    (b) => b.dataset.kanbanColumnAdd === '32',
  );
  assert.ok(add, 'the M1 column has a + quick-add button');
  add.dispatchEvent({ type: 'click', target: add });

  const open = intents.find((i) => i.type === 'quickCreateOpen');
  assert.ok(open, 'clicking + raised quickCreateOpen');
  assert.deepEqual(
    open.detail.prefill.laneAttribute,
    { name: 'milestone_ref', value: 32n },
    'prefilled the column axis (milestone_ref = 32)',
  );
});

/* -------------------------------------------------------------------------- */
/* #26 — a LANE axis splits the board into swim lanes (lanes × columns).        */
/* -------------------------------------------------------------------------- */

test('Kanban: a LANE axis splits the board into swim lanes', async () => {
  const { dispatcher, tree, kanban } = bootMultiAxisKanban();
  await settle(dispatcher);

  // Columns by status, lanes by milestone.
  tree.at(['screen', 'groupAxis']).set({ attr: 'status', lookup: 'statuses' });
  tree.at(['screen', 'laneAxis']).set({ attr: 'milestone_ref', lookup: 'milestones' });
  await settle(dispatcher);

  const lanes = kanban.el.querySelectorAll('[data-kanban-lane]');
  assert.ok(lanes.length >= 2, 'board split into one lane per milestone value');
  // Each lane holds the column set (status columns).
  const firstLaneCols = lanes[0].querySelectorAll('[data-kanban-column]');
  assert.ok(firstLaneCols.length >= 1, 'a lane contains the status columns');

  // Turning lanes off collapses back to a single column row (no lane wrappers).
  tree.at(['screen', 'laneAxis']).set(null);
  await settle(dispatcher);
  assert.equal(kanban.el.querySelectorAll('[data-kanban-lane]').length, 0, 'no lanes when laneAxis cleared');
});
