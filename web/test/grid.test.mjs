import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
let FakeElement;

before(async () => {
  ({ FakeElement } = installDomShim());
  // The keyed-list row reconciler (core/keyed-list.ts) reads `node.nextSibling`
  // to place rows in order; the shared minimal DOM shim doesn't model it (the
  // other controls render via replaceChildren and never hit this path). Teach
  // the shim's prototype the real-DOM semantics here — local to this test file,
  // no edit to the shared shim. Without it `insertBefore(el, undefined)` would
  // append an already-present node twice.
  Object.defineProperty(FakeElement.prototype, 'nextSibling', {
    configurable: true,
    get() {
      const p = this.parentNode;
      if (!p) return null;
      const i = p.children.indexOf(this);
      return i >= 0 && i + 1 < p.children.length ? p.children[i + 1] : null;
    },
  });
  // Make insertBefore move (not duplicate) a node already in the tree — the
  // real DOM removes it from its old position first.
  const origInsert = FakeElement.prototype.insertBefore;
  FakeElement.prototype.insertBefore = function (n, ref) {
    if (n && n.parentNode) {
      const i = n.parentNode.children.indexOf(n);
      if (i >= 0) n.parentNode.children.splice(i, 1);
    }
    return origInsert.call(this, n, ref);
  };
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  // Register the controls the Grid composes with (Control.register throws on dup).
  M.registerScreenFilterBar();
  M.registerScreenHost();
  M.registerKanbanControls();
  M.registerTagChip();
  M.registerGrid();
});

/**
 * The Grid renders rows via the recycling virtualList: a FIXED pool of row
 * nodes is content-swapped, so `[data-grid-row]` matches every pooled node
 * (visible AND parked). The VISIBLE window is the pool nodes the list shows —
 * those whose `display` is not 'none'. Tests assert on this visible window +
 * the data-* hooks, never a node-per-item count of the whole pool.
 */
function visibleGridRows(root) {
  return root
    .querySelectorAll('[data-grid-row]')
    .filter((r) => r.style.display !== 'none');
}

/* -------------------------------------------------------------------------- */
/* Grid-specific mock transport: distinct rows per card_type_name, and it      */
/* echoes the tasks query's `order` / `where` so the sort test can assert on   */
/* the re-issued query. Each test gets a fresh closure (isolated state).       */
/* -------------------------------------------------------------------------- */

const PROJECT_ID = 100n;

function gridMockTransport() {
  // Records the most recent tasks-query input so tests can inspect order/where.
  const sent = { taskInputs: [] };

  const task = (id, title, attrs) => ({
    id: String(id),
    card_type_id: '5',
    card_type_name: 'task',
    parent_card_id: String(PROJECT_ID),
    phase: 'active',
    attributes: { title, ...attrs },
  });

  // Two tasks; one fully populated (refs + tags), one sparse (all unset).
  const TASKS = [
    task(201n, 'Wire pickers', {
      sort_order: 100,
      status: '40', // → "Todo"
      assignee: '10', // → "Alice"
      priority: 'high',
      milestone_ref: '32', // → "M1"
      component_ref: '50', // → "Frontend"
      tags: ['60', '61'], // → area/frontend/ui, priority/high
      due_date: '2026-06-01',
    }),
    task(202n, 'API rate limits', { sort_order: 200 }),
  ];

  const card = (id, type, attrs) => ({
    id: String(id),
    card_type_id: '9',
    card_type_name: type,
    parent_card_id: String(PROJECT_ID),
    attributes: attrs,
  });

  function respond(sr) {
    const key = `${sr.endpoint}.${sr.action}`;
    if (key === 'card.select_with_attributes') {
      const data = sr.data ?? {};
      switch (data.card_type_name) {
        case 'person':
          return { id: sr.id, ok: true, data: { rows: [card(10n, 'person', { title: 'Alice' })] } };
        case 'status':
          return { id: sr.id, ok: true, data: { rows: [card(40n, 'status', { name: 'Todo' })] } };
        case 'milestone':
          return { id: sr.id, ok: true, data: { rows: [card(32n, 'milestone', { title: 'M1' })] } };
        case 'component':
          return { id: sr.id, ok: true, data: { rows: [card(50n, 'component', { title: 'Frontend' })] } };
        case 'tag':
          return {
            id: sr.id,
            ok: true,
            data: {
              rows: [
                card(60n, 'tag', { path: 'area/frontend/ui' }),
                card(61n, 'tag', { path: 'priority/high' }),
              ],
            },
          };
        case 'task':
        default:
          sent.taskInputs.push(data);
          return { id: sr.id, ok: true, data: { rows: TASKS } };
      }
    }
    return { id: sr.id, ok: false, error: { code: 'unknown_handler', message: `mock has no ${key}` } };
  }

  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => respond(sr));
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
  return { transport, sent };
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api); // defines the shared card.select_with_attributes spec
  M.registerGridCardRefAttrs(); // primes assignee/status/component_ref/tags revival
  return { dispatcher, api };
}

async function settle(dispatcher) {
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  M.flushSync?.();
}

function mountGrid(api, tree) {
  tree.at(['scope', 'projectId']).set(PROJECT_ID);
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const ctx = { api, tree, scope };
  const grid = M.Control.New('Grid', { type: 'Grid' }, ctx);
  grid.mount(new FakeElement('div'));
  return grid;
}

/* -------------------------------------------------------------------------- */
/* Tasks query lands + rows render in column order.                            */
/* -------------------------------------------------------------------------- */

test('Grid: tasks query lands and rows render in declared column order', async () => {
  const { transport } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  // Tasks landed at grid.tasks.
  const tasks = tree.at(['grid', 'tasks']).peek();
  assert.equal(tasks.length, 2, 'two seeded tasks landed');

  // Header columns render in the declared order.
  const heads = grid.el.querySelectorAll('[data-grid-header]');
  const headFields = heads.map((h) => h.dataset.gridCol);
  assert.deepEqual(
    headFields,
    [
      'id',
      'attributes.title',
      'attributes.status',
      'attributes.assignee',
      'attributes.priority',
      'attributes.milestone_ref',
      'attributes.component_ref',
      'tags',
      'attributes.due_date',
      'created_at',
      'last_activity_at',
    ],
    'all 11 columns in order',
  );

  // Body rows render, keyed by card id.
  const rows = visibleGridRows(grid.el);
  assert.equal(rows.length, 2, 'two body rows');
  assert.deepEqual(rows.map((r) => r.dataset.cardId), ['201', '202']);

  // First row's cells render in column order with the right id + title.
  const cells = rows[0].querySelectorAll('[data-grid-col]');
  assert.equal(cells.length, 11, 'eleven cells in the first row');
  const idCell = cells.find((c) => c.dataset.gridCol === 'id');
  assert.equal(idCell.textContent, '#201');
  const titleCell = cells.find((c) => c.dataset.gridCol === 'attributes.title');
  assert.equal(titleCell.textContent, 'Wire pickers');
});

/* -------------------------------------------------------------------------- */
/* The body is a recycling virtualList scroll viewport (spacer + content +     */
/* a FIXED pool of recycled row nodes), NOT a node-per-task reconciler.        */
/* -------------------------------------------------------------------------- */

test('Grid: rows render through the recycling virtualList (spacer + pooled rows in the body)', async () => {
  const { transport } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  // The scroll viewport is the grid body; the virtualList installs a sizing
  // spacer + a translated content layer inside it.
  const body = grid.el.querySelector('[data-grid-body]');
  assert.ok(body, 'the grid body is present');
  const spacer = body.querySelectorAll('[data-role]').find((e) => e.dataset.role === 'vlist-spacer');
  assert.ok(spacer, 'virtualList sizing spacer mounted in the body');
  const content = body.querySelectorAll('[data-role]').find((e) => e.dataset.role === 'vlist-content');
  assert.ok(content, 'virtualList content layer mounted in the body');

  // The row nodes are the recycling pool: the FIXED pool size (bounded by the
  // viewport, NOT the task count), with exactly two VISIBLE for the two tasks.
  const pool = grid.el.querySelectorAll('[data-grid-row]');
  assert.ok(pool.length >= 2, 'a pool of recycled row nodes exists');
  const visible = visibleGridRows(grid.el);
  assert.equal(visible.length, 2, 'two visible rows for the two tasks (rest of the pool parked)');
});

/* -------------------------------------------------------------------------- */
/* The body is the BOTH-AXES scroll container (issue #15): it carries the       */
/* visible-scrollbar `.scroll-y` + `.scroll-x` classes, and the header stays    */
/* a sibling of the body inside the table (outside the scroll viewport) so the  */
/* virtualList's scrollTop math is untouched; alignment under horizontal scroll */
/* is a DOM-only translateX sync the control wires on the body's scroll event.  */
/* -------------------------------------------------------------------------- */

test('Grid: body carries both-axes scroll classes; header stays outside the body (#15)', async () => {
  const { transport } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  const body = grid.el.querySelector('[data-grid-body]');
  assert.ok(body, 'the grid body (scroll viewport) is present');
  assert.ok(body.classList.contains('scroll-y'), 'body wears .scroll-y (vertical)');
  assert.ok(body.classList.contains('scroll-x'), 'body wears .scroll-x (horizontal #15)');

  // The header row is a sibling of the body inside the table — NOT a descendant
  // of the body (so it never enters the virtualList scroll viewport). The
  // translateX sync keeps it column-aligned under horizontal scroll.
  const table = grid.el.querySelector('[data-grid-table]');
  const headerRow = table.querySelector('[data-grid-header-row]');
  assert.ok(headerRow, 'the header row is present in the table');
  assert.equal(
    body.querySelector('[data-grid-header-row]'),
    null,
    'the header row is NOT inside the scrolling body',
  );
});

/* -------------------------------------------------------------------------- */
/* Label resolution from the lookup tree paths (assignee id → person name).    */
/* -------------------------------------------------------------------------- */

test('Grid: resolves card_ref labels from the lookup tree paths', async () => {
  const { transport } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  const rows = visibleGridRows(grid.el);
  const row = rows[0]; // task 201
  const cellText = (field) =>
    row.querySelectorAll('[data-grid-col]').find((c) => c.dataset.gridCol === field).textContent;

  assert.equal(cellText('attributes.assignee'), 'Alice', 'assignee id → person name');
  assert.equal(cellText('attributes.status'), 'Todo', 'status id → status name');
  assert.equal(cellText('attributes.milestone_ref'), 'M1', 'milestone id → title');
  assert.equal(cellText('attributes.component_ref'), 'Frontend', 'component id → title');
  assert.equal(cellText('attributes.priority'), 'high', 'priority scalar pill');

  // The sparse row (202) shows em-dashes for every unset ref.
  const sparse = rows[1];
  const sparseText = (field) =>
    sparse.querySelectorAll('[data-grid-col]').find((c) => c.dataset.gridCol === field).textContent;
  assert.equal(sparseText('attributes.assignee'), '—', 'unset assignee → dash');
  assert.equal(sparseText('attributes.milestone_ref'), '—', 'unset milestone → dash');
});

/* -------------------------------------------------------------------------- */
/* Tags column renders one TagChip per tag.                                    */
/* -------------------------------------------------------------------------- */

test('Grid: Tags column renders one TagChip per tag (leaf label)', async () => {
  const { transport } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  const row = visibleGridRows(grid.el)[0]; // task 201
  const tagsCell = row.querySelectorAll('[data-grid-col]').find((c) => c.dataset.gridCol === 'tags');
  const chips = tagsCell.querySelectorAll('[data-tag-chip]');
  assert.equal(chips.length, 2, 'two tag chips');
  // Chips carry the full path + show the LEAF segment as label.
  assert.deepEqual(chips.map((c) => c.dataset.tagPath), ['area/frontend/ui', 'priority/high']);
  const leafText = (chip) =>
    chip.querySelectorAll('[data-tag-chip]').length === 0 // it IS the chip
      ? chip.children.find((x) => x.classList.contains('tag-chip__label')).textContent
      : null;
  assert.deepEqual(chips.map(leafText), ['ui', 'high'], 'chip label is the leaf segment');
});

/* -------------------------------------------------------------------------- */
/* TagChip unit: renders a chip per tag from a tags array (control-level).      */
/* -------------------------------------------------------------------------- */

test('TagChip: renders the leaf segment + full path; one per tag in an array', () => {
  const tree = new M.TreeNode({}, []);
  const ctx = { api: null, tree, scope: {} };
  const host = new FakeElement('div');
  for (const path of ['area/frontend/ui', 'flat', 'priority/high']) {
    const chip = M.Control.New('TagChip', { type: 'TagChip', path }, ctx);
    chip.mount(host);
  }
  const chips = host.querySelectorAll('[data-tag-chip]');
  assert.equal(chips.length, 3, 'three chips, one per tag');
  assert.deepEqual(chips.map((c) => c.dataset.tagPath), ['area/frontend/ui', 'flat', 'priority/high']);
  const labels = chips.map(
    (c) => c.children.find((x) => x.classList.contains('tag-chip__label')).textContent,
  );
  assert.deepEqual(labels, ['ui', 'flat', 'high'], 'leaf segment (or whole path when flat)');
});

/* -------------------------------------------------------------------------- */
/* Sort-header click cycles asc → desc → off and re-issues the query.          */
/* -------------------------------------------------------------------------- */

test('Grid: sort-header click cycles asc → desc → off, re-issuing the query order', async () => {
  const { transport, sent } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  const initialFires = sent.taskInputs.length;
  const titleHeader = grid.el
    .querySelectorAll('[data-grid-header]')
    .find((h) => h.dataset.gridCol === 'attributes.title');
  const sortBtn = titleHeader.querySelector('[data-grid-sort-button]');

  // 1st click → ASC.
  sortBtn.dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  assert.equal(titleHeader.dataset.sortDir, 'asc', 'header shows asc');
  assert.equal(titleHeader.dataset.sortField, 'attributes.title');
  let last = sent.taskInputs[sent.taskInputs.length - 1];
  assert.deepEqual(last.order, [{ field: 'attributes.title', direction: 'ASC' }], 'query re-issued ASC');

  // 2nd click → DESC.
  sortBtn.dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  assert.equal(titleHeader.dataset.sortDir, 'desc', 'header shows desc');
  last = sent.taskInputs[sent.taskInputs.length - 1];
  assert.deepEqual(last.order, [{ field: 'attributes.title', direction: 'DESC' }], 'query re-issued DESC');

  // 3rd click → OFF (no order; server default).
  sortBtn.dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  assert.equal(titleHeader.dataset.sortDir, undefined, 'header shows no sort');
  last = sent.taskInputs[sent.taskInputs.length - 1];
  // The kanban encoder drops an empty order array, so the off-state query omits it.
  assert.ok(last.order === undefined || last.order.length === 0, 'off state sends no order');

  assert.ok(sent.taskInputs.length >= initialFires + 3, 'each click re-issued the tasks query');
});

/* -------------------------------------------------------------------------- */
/* ScreenHost dispatch: grid → Grid; unknown → NotFound.                       */
/* -------------------------------------------------------------------------- */

test('ScreenHost dispatches a grid screen to the Grid control', () => {
  const { transport } = gridMockTransport();
  const { api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const ctx = { api, tree, scope: { projectId: null } };
  const host = M.Control.New(
    'ScreenHost',
    { type: 'ScreenHost', screen: { slug: 'grid', layout: 'grid', title: 'Grid' } },
    ctx,
  );
  host.mount(new FakeElement('div'));

  const body = host.el.querySelector('.screen-host__body');
  assert.equal(body.dataset.layout, 'grid');
  assert.equal(body.findByControl('Grid').length, 1, 'grid layout resolved to a Grid control');
  // Exactly ONE ScreenFilterBar: ScreenHost provides the shared bar; the Grid
  // relies on it rather than mounting its own (no duplicate bar).
  assert.equal(host.el.findByControl('ScreenFilterBar').length, 1, 'exactly one shared filter bar');
  assert.equal(body.findByControl('ScreenFilterBar').length, 0, 'Grid does not mount its own bar');
});

test('ScreenHost still dispatches an unknown layout to NotFound', () => {
  const { transport } = gridMockTransport();
  const { api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const ctx = { api, tree, scope: { projectId: null } };
  const host = M.Control.New(
    'ScreenHost',
    { type: 'ScreenHost', screen: { slug: 'mystery', layout: 'hologram' }, filterBar: false },
    ctx,
  );
  host.mount(new FakeElement('div'));
  const nf = host.el.querySelector('.screen-host__body').findByControl('NotFound');
  assert.equal(nf.length, 1, 'unknown layout → NotFound');
});

/* -------------------------------------------------------------------------- */
/* Pure helpers: cycleSort / buildOrderClauses / effectiveSort / columns.      */
/* -------------------------------------------------------------------------- */

test('grid-helpers cycleSort: asc → desc → off, switch column resets to asc', () => {
  const { cycleSort } = M;
  assert.deepEqual(cycleSort(null, 'attributes.title'), { field: 'attributes.title', direction: 'asc' });
  assert.deepEqual(
    cycleSort({ field: 'attributes.title', direction: 'asc' }, 'attributes.title'),
    { field: 'attributes.title', direction: 'desc' },
  );
  assert.equal(cycleSort({ field: 'attributes.title', direction: 'desc' }, 'attributes.title'), null);
  // Switching to a different column starts a fresh ASC.
  assert.deepEqual(
    cycleSort({ field: 'attributes.title', direction: 'desc' }, 'attributes.status'),
    { field: 'attributes.status', direction: 'asc' },
  );
});

test('grid-helpers buildOrderClauses + effectiveSort + sortStatesFromFilter', () => {
  const { buildOrderClauses, effectiveSort, sortStatesFromFilter } = M;
  assert.deepEqual(buildOrderClauses(null), []);
  assert.deepEqual(buildOrderClauses({ field: 'created_at', direction: 'desc' }), [
    { field: 'created_at', direction: 'DESC' },
  ]);
  // Header sort overrides the filter sort.
  const filterSort = sortStatesFromFilter([{ attr: 'priority', dir: 'asc' }]);
  assert.deepEqual(filterSort, [{ field: 'attributes.priority', direction: 'asc' }]);
  assert.deepEqual(effectiveSort({ field: 'created_at', direction: 'asc' }, filterSort), [
    { field: 'created_at', direction: 'asc' },
  ]);
  // No header sort → the filter sort comes back.
  assert.deepEqual(effectiveSort(null, filterSort), filterSort);
});

test('grid-helpers GRID_COLUMNS has the expected sortable / non-sortable fields', () => {
  const { GRID_COLUMNS } = M;
  const byKind = Object.fromEntries(GRID_COLUMNS.map((c) => [c.kind, c]));
  // ID and Tags are non-sortable (field null); the rest carry a wire field.
  assert.equal(byKind.id.field, null);
  assert.equal(byKind.tags.field, null);
  assert.equal(byKind.title.field, 'attributes.title');
  assert.equal(byKind.milestone.field, 'attributes.milestone_ref');
  assert.equal(byKind.created.field, 'created_at');
});
