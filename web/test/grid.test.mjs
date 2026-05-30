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
  // RefPicker + Combobox back the BulkActionBar's value editors.
  M.registerCombobox();
  M.registerRefPicker();
  M.registerBulkActionBar();
  M.registerGrid();
  // The "Columns" chooser now lives on the filter bar (viewActions seam).
  M.registerGridColumns();
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
  // Records the most recent tasks-query input so tests can inspect order/where,
  // plus every write sub-request (attribute.update / task.move / task.purge)
  // AND a per-flush batch log so a test can assert the bulk fan-out coalesced
  // into ONE POST (one batch entry holding N sub-requests).
  const sent = { taskInputs: [], writes: [], batches: [] };

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
    {
      // Top-level audit timestamps (decoded by the shared CardWithAttrs decoder).
      ...task(201n, 'Wire pickers', {
        sort_order: 100,
        status: '40', // → "Todo"
        assignee: '10', // → "Alice"
        priority: 'high',
        milestone_ref: '32', // → "M1"
        component_ref: '50', // → "Frontend"
        tags: ['60', '61'], // → area/frontend/ui, priority/high
        due_date: '2026-06-01',
      }),
      created_at: '2026-05-20T10:00:00Z',
      last_activity_at: '2026-05-22T12:00:00Z',
    },
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
                card(60n, 'tag', { path: 'area/frontend/ui', color: 'blue' }),
                card(61n, 'tag', { path: 'priority/high', color: 'red' }),
              ],
            },
          };
        case 'task':
        default:
          sent.taskInputs.push(data);
          return { id: sr.id, ok: true, data: { rows: TASKS } };
      }
    }
    if (key === 'attribute.update') {
      sent.writes.push({ kind: 'attribute.update', data: sr.data ?? {} });
      return { id: sr.id, ok: true, data: { ok: true, activity_id: '1' } };
    }
    if (key === 'task.move') {
      sent.writes.push({ kind: 'task.move', data: sr.data ?? {} });
      return {
        id: sr.id,
        ok: true,
        data: { moved_card_ids: [sr.data?.card_id], resolved_status_id: '40' },
      };
    }
    if (key === 'task.purge') {
      sent.writes.push({ kind: 'task.purge', data: sr.data ?? {} });
      return { id: sr.id, ok: true, data: { ok: true, purged_card_ids: [sr.data?.card_id] } };
    }
    if (key === 'card.search') {
      // The BulkActionBar's RefPickers fire this when their menus open; tests
      // don't open menus, but answer harmlessly if one does.
      return { id: sr.id, ok: true, data: { rows: [] } };
    }
    return { id: sr.id, ok: false, error: { code: 'unknown_handler', message: `mock has no ${key}` } };
  }

  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      // Log this flush's sub-request endpoint.actions so a test can prove the
      // bulk fan-out coalesced into ONE POST (one batch entry, N writes in it).
      sent.batches.push(req.subrequests.map((s) => `${s.endpoint}.${s.action}`));
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
  M.registerGridBulkSpecs(api); // task.move + task.purge write specs
  M.registerCardSearchSpec(api); // backs the RefPicker editors in the BulkActionBar
  return { dispatcher, api };
}

async function settle(dispatcher) {
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  M.flushSync?.();
}

function mountGrid(api, tree) {
  tree.at(['scope', 'projectId']).set(PROJECT_ID);
  // Data-driven grid columns (#17): seed the schema axes + screen column config
  // the grid reads (the ScreenFilterBar publishes refAxes/attrSchema; ScreenHost
  // lands extra_columns / tag_prefix_columns). This reproduces the seeded grid
  // screen: ID · Title · Status · Assignee · Milestone · Component · Priority
  // (tag-prefix) · Tags · Due (extra) · Created · Last activity.
  tree.at(['screen', 'refAxes']).set([
    { attr: 'status', label: 'Status', targetCardType: 'status', multi: false },
    { attr: 'assignee', label: 'Assignee', targetCardType: 'person', multi: false },
    { attr: 'milestone_ref', label: 'Milestone', targetCardType: 'milestone', multi: false },
    { attr: 'component_ref', label: 'Component', targetCardType: 'component', multi: false },
  ]);
  tree.at(['screen', 'tagPrefixColumns']).set(['priority']);
  tree.at(['screen', 'extraColumns']).set(['due_date']);
  tree.at(['screen', 'attrSchema']).set([{ name: 'due_date', label: 'Due date', valueType: 'date' }]);
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

  // Header columns render in the declared order, behind the leading select cell.
  const heads = grid.el.querySelectorAll('[data-grid-header]');
  const headFields = heads.map((h) => h.dataset.gridCol);
  assert.deepEqual(
    headFields,
    [
      'select',
      'id',
      'attributes.title',
      'attributes.status',
      'attributes.assignee',
      'attributes.milestone_ref',
      'attributes.component_ref',
      // Tag-prefix sub-columns: `priority` first (explicit screen config),
      // then `area` auto-derived from the loaded tag cards' paths. No
      // catch-all Tags column — every applied tag surfaces in its prefix slot.
      'tag:priority',
      'tag:area',
      'attributes.due_date',
      'created_at',
      'last_activity_at',
    ],
    'a leading select column then all 11 data-driven columns in order',
  );

  // Body rows render, keyed by card id.
  const rows = visibleGridRows(grid.el);
  assert.equal(rows.length, 2, 'two body rows');
  assert.deepEqual(rows.map((r) => r.dataset.cardId), ['201', '202']);

  // First row's cells render in column order with the right id + title (a
  // leading select cell precedes the 11 data cells).
  const cells = rows[0].querySelectorAll('[data-grid-col]');
  assert.equal(cells.length, 12, 'a select cell plus eleven data cells in the first row');
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
  // Priority is now a data-driven tag-prefix column (tag `priority/high` → "high").
  assert.equal(cellText('tag:priority'), 'high', 'priority tag-prefix pill');
  // Created / Last-activity now decode from the top-level wire fields (#20).
  assert.equal(cellText('created_at'), '2026-05-20', 'created_at top-level → Created column');
  assert.equal(cellText('last_activity_at'), '2026-05-22', 'last_activity_at → Last activity column');

  // The sparse row (202) shows em-dashes for every unset ref.
  const sparse = rows[1];
  const sparseText = (field) =>
    sparse.querySelectorAll('[data-grid-col]').find((c) => c.dataset.gridCol === field).textContent;
  assert.equal(sparseText('attributes.assignee'), '—', 'unset assignee → dash');
  assert.equal(sparseText('attributes.milestone_ref'), '—', 'unset milestone → dash');
});

/* -------------------------------------------------------------------------- */
/* Inline cell edit (#30): double-click a scalar attribute cell to edit it in  */
/* place; commit fires attribute.update and optimistically patches grid.tasks. */
/* -------------------------------------------------------------------------- */

test('Grid: double-click a scalar cell edits inline → attribute.update + optimistic patch', async () => {
  const { transport, sent } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  // A minimal screen: no ref axes/tag prefixes, one scalar `attr` extra column.
  tree.at(['scope', 'projectId']).set(PROJECT_ID);
  tree.at(['screen', 'refAxes']).set([]);
  tree.at(['screen', 'tagPrefixColumns']).set([]);
  tree.at(['screen', 'extraColumns']).set(['estimate']);
  tree.at(['screen', 'attrSchema']).set([{ name: 'estimate', label: 'Estimate', valueType: 'text' }]);
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const grid = M.Control.New('Grid', { type: 'Grid' }, { api, tree, scope });
  grid.mount(new FakeElement('div'));
  await settle(dispatcher);

  const row = visibleGridRows(grid.el).find((r) => r.dataset.cardId === '201');
  const cell = row
    .querySelectorAll('[data-grid-col]')
    .find((c) => c.dataset.gridCol === 'attributes.estimate');
  assert.ok(cell, 'the scalar estimate column rendered an editable cell');
  assert.ok(cell.classList.contains('grid__cell--editable'), 'cell is marked editable');

  // Double-click opens the inline editor.
  cell.dispatchEvent({ type: 'dblclick', target: cell });
  assert.ok(cell.classList.contains('grid__cell--editing'), 'cell entered edit mode');
  const input = cell.querySelectorAll('input')[0];
  assert.ok(input, 'a text input editor spawned in the cell');

  // Type a value + Enter to commit.
  input.value = '3d';
  input.dispatchEvent({ type: 'keydown', key: 'Enter', target: input });
  await settle(dispatcher);

  // Optimistic patch: grid.tasks reflects the new value immediately.
  const patched = tree.at(['grid', 'tasks']).peek().find((t) => t.id.toString() === '201');
  assert.equal(patched.attributes.estimate, '3d', 'grid.tasks optimistically patched');

  // attribute.update fired with the encoded wire payload.
  const w = sent.writes.find((x) => x.kind === 'attribute.update');
  assert.ok(w, 'attribute.update fired');
  assert.equal(w.data.card_id, '201', 'targets the right card');
  assert.equal(w.data.attribute_name, 'estimate', 'targets the right attribute');
  assert.equal(w.data.value, '3d', 'sends the typed value');

  // The editor is gone (cell back to read mode).
  assert.ok(!cell.classList.contains('grid__cell--editing'), 'edit mode cleared after commit');
});

test('Grid: Escape cancels an inline edit without firing a write', async () => {
  const { transport, sent } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(PROJECT_ID);
  tree.at(['screen', 'refAxes']).set([]);
  tree.at(['screen', 'tagPrefixColumns']).set([]);
  tree.at(['screen', 'extraColumns']).set(['estimate']);
  tree.at(['screen', 'attrSchema']).set([{ name: 'estimate', label: 'Estimate', valueType: 'text' }]);
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const grid = M.Control.New('Grid', { type: 'Grid' }, { api, tree, scope });
  grid.mount(new FakeElement('div'));
  await settle(dispatcher);

  const cell = visibleGridRows(grid.el)
    .find((r) => r.dataset.cardId === '201')
    .querySelectorAll('[data-grid-col]')
    .find((c) => c.dataset.gridCol === 'attributes.estimate');
  cell.dispatchEvent({ type: 'dblclick', target: cell });
  const input = cell.querySelectorAll('input')[0];
  input.value = 'nope';
  input.dispatchEvent({ type: 'keydown', key: 'Escape', target: input });
  await settle(dispatcher);

  assert.ok(!cell.classList.contains('grid__cell--editing'), 'edit mode cleared');
  assert.equal(
    sent.writes.filter((x) => x.kind === 'attribute.update').length,
    0,
    'no attribute.update fired on cancel',
  );
});

/* -------------------------------------------------------------------------- */
/* Tag-prefix sub-columns render one pill per matching tag (suffix only).      */
/* -------------------------------------------------------------------------- */

test('Grid: tag-prefix sub-columns render one pill per matching tag (suffix only + palette color)', async () => {
  const { transport } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  const row = visibleGridRows(grid.el)[0]; // task 201 — tags: area/frontend/ui + priority/high
  const cells = row.querySelectorAll('[data-grid-col]');
  const cellByCol = (field) => cells.find((c) => c.dataset.gridCol === field);

  // priority slot — the only path matching `priority/` is `priority/high`, color "red".
  const priorityCell = cellByCol('tag:priority');
  const priorityPills = priorityCell.querySelectorAll('.grid__pill');
  assert.equal(priorityPills.length, 1, 'one priority pill');
  assert.equal(priorityPills[0].textContent, 'high', 'priority pill shows the suffix only');
  assert.equal(priorityPills[0].dataset.tagColor, 'red', 'priority pill carries the "red" palette tone');

  // area slot — path `area/frontend/ui` lands here with suffix `frontend/ui` and color "blue".
  const areaCell = cellByCol('tag:area');
  const areaPills = areaCell.querySelectorAll('.grid__pill');
  assert.equal(areaPills.length, 1, 'one area pill');
  assert.equal(areaPills[0].textContent, 'frontend/ui', 'area pill shows the suffix after `area/`');
  assert.equal(areaPills[0].dataset.tagColor, 'blue', 'area pill carries the "blue" palette tone');
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

test('grid-helpers buildGridColumns: data-driven set from refAxes + screen config', () => {
  const { buildGridColumns } = M;
  const refAxes = [
    { attr: 'status', label: 'Status', targetCardType: 'status', multi: false },
    { attr: 'assignee', label: 'Assignee', targetCardType: 'person', multi: false },
    { attr: 'tags', label: 'Tags', targetCardType: 'tag', multi: true }, // multi → skipped (prefixes columns)
  ];
  const schema = [{ name: 'due_date', label: 'Due date', valueType: 'date' }];
  const cols = buildGridColumns(refAxes, schema, ['due_date'], ['priority']);
  const byKey = Object.fromEntries(cols.map((c) => [c.key, c]));

  // Order: id, title, ref(status), ref(assignee), tag_prefix(priority), date(due_date), created, last_activity.
  // No catch-all `tags` column — every tag surfaces in its prefix sub-column.
  assert.deepEqual(
    cols.map((c) => c.key),
    ['id', 'title', 'status', 'assignee', 'tag:priority', 'due_date', 'created', 'last_activity'],
    'multi-ref tags axis is skipped; tag-prefix + extra columns slot in (no catch-all Tags)',
  );
  // ID / tag-prefix are non-sortable (field null); refs + date carry a field.
  assert.equal(byKey.id.field, null);
  assert.equal(byKey['tag:priority'].field, null);
  assert.equal(byKey.status.kind, 'ref');
  assert.equal(byKey.status.lookup, 'statuses'); // person→persons, status→statuses, …
  assert.equal(byKey.assignee.lookup, 'persons');
  assert.equal(byKey.due_date.kind, 'date');
  assert.equal(byKey.due_date.field, 'attributes.due_date');
  assert.equal(byKey.created.field, 'created_at');
});

test('grid-helpers extractTagPrefixes: distinct alphabetically-sorted prefixes', () => {
  const { extractTagPrefixes } = M;
  // Duplicate prefixes collapse; un-prefixed paths (no `/`) are skipped.
  assert.deepEqual(
    extractTagPrefixes(['area/frontend/ui', 'priority/high', 'area/api', 'flat']),
    ['area', 'priority'],
  );
  assert.deepEqual(extractTagPrefixes([]), []);
});

test('grid-helpers tagPrefixValues returns every matching suffix', () => {
  const { tagPrefixValues } = M;
  // Multiple tags can share one prefix — every match is returned.
  assert.deepEqual(
    tagPrefixValues(['area/frontend/ui', 'area/api', 'priority/high'], 'area'),
    ['frontend/ui', 'api'],
  );
  assert.deepEqual(tagPrefixValues(['area/frontend'], 'priority'), []);
});

test('grid-helpers estimateTagPrefixColumnPx tracks the widest suffix + header', () => {
  const { estimateTagPrefixColumnPx } = M;
  // No matching tags → the column hugs the header label, never the 56px floor.
  const empty = estimateTagPrefixColumnPx([], 'priority');
  assert.ok(empty >= 56, 'never collapses below the floor');
  // A long suffix should drive the column wider than a short header.
  const wide = estimateTagPrefixColumnPx(
    ['area/frontend', 'area/backend', 'area/the-very-long-platform-team'],
    'area',
  );
  const narrow = estimateTagPrefixColumnPx(['area/ui'], 'area');
  assert.ok(wide > narrow, 'wider suffix → wider column');
  // A wide HEADER beats a tiny body — the column still fits the header label.
  const headerHeavy = estimateTagPrefixColumnPx(['supercategory/a'], 'supercategory');
  const bodyHeavy = estimateTagPrefixColumnPx(['a/superlong-but-not-quite'], 'a');
  assert.ok(headerHeavy >= 56);
  assert.ok(bodyHeavy >= 56);
});

/* -------------------------------------------------------------------------- */
/* Pure grouping helpers: groupAttrFromGroupValue + walkGrouped.               */
/* -------------------------------------------------------------------------- */

test('grid-helpers groupAttrFromGroupValue maps picker value → attr + lookup', () => {
  const { groupAttrFromGroupValue } = M;
  assert.deepEqual(groupAttrFromGroupValue('milestone'), { attr: 'milestone_ref', lookup: 'milestones' });
  assert.deepEqual(groupAttrFromGroupValue('component'), { attr: 'component_ref', lookup: 'components' });
  assert.deepEqual(groupAttrFromGroupValue('status'), { attr: 'status', lookup: 'statuses' });
  assert.deepEqual(groupAttrFromGroupValue('assignee'), { attr: 'assignee', lookup: 'persons' });
  // Unknown / absent → null (caller treats as flat list).
  assert.equal(groupAttrFromGroupValue('nope'), null);
  assert.equal(groupAttrFromGroupValue(null), null);
  assert.equal(groupAttrFromGroupValue(undefined), null);
});

test('grid-helpers walkGrouped: null attr → flat row-only sequence', () => {
  const { walkGrouped } = M;
  const rows = [{ attributes: { status: 'a' } }, { attributes: { status: 'b' } }];
  const out = walkGrouped(rows, null, () => 'x');
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((i) => i.kind), ['row', 'row']);
  assert.deepEqual(out.map((i) => i.idx), [0, 1]);
});

test('grid-helpers walkGrouped: emits header per run with label + count, (unset) bucket', () => {
  const { walkGrouped } = M;
  // Pre-ordered (as the server would return): two Doing, one Done, one unset.
  const rows = [
    { attributes: { status: '1', title: 't1' } },
    { attributes: { status: '1', title: 't2' } },
    { attributes: { status: '2', title: 't3' } },
    { attributes: { status: null, title: 't4' } },
  ];
  const labelOf = (v) => (v === '1' ? 'Doing' : v === '2' ? 'Done' : `?${v}`);
  const out = walkGrouped(rows, 'status', labelOf);
  // header(Doing·2) row row header(Done·1) row header((unset)·1) row
  assert.deepEqual(
    out.map((i) => (i.kind === 'group' ? `H:${i.label}:${i.count}` : `R:${i.row.attributes.title}`)),
    ['H:Doing:2', 'R:t1', 'R:t2', 'H:Done:1', 'R:t3', 'H:(unset):1', 'R:t4'],
  );
  // Row idx tracks the rows-only sequence (headers don't consume an index).
  const rowIdx = out.filter((i) => i.kind === 'row').map((i) => i.idx);
  assert.deepEqual(rowIdx, [0, 1, 2, 3]);
});

/* -------------------------------------------------------------------------- */
/* Grouping integration: the GROUP picker (screen.group) drives the body into  */
/* grouped sections (header rows + data rows) through the recycling virtualList */
/* -------------------------------------------------------------------------- */

/**
 * A grouping-focused mock: several tasks across two statuses + an unset one,
 * with two status lookups (Doing / Done). It mirrors the server by applying the
 * tasks query's `order` (sort by the first order key) so the rows arrive
 * bucketed — walkGrouped relies on that pre-ordering.
 */
function groupingMockTransport() {
  const sent = { taskInputs: [] };
  const task = (id, title, status) => ({
    id: String(id),
    card_type_id: '5',
    card_type_name: 'task',
    parent_card_id: String(PROJECT_ID),
    phase: 'active',
    attributes: { title, sort_order: Number(id), ...(status === null ? {} : { status: String(status) }) },
  });
  // Deliberately unsorted seed order so the server-side order (and grouping)
  // is what produces the buckets.
  const TASKS = [
    task(301n, 'Alpha', 1), // Doing
    task(302n, 'Bravo', 2), // Done
    task(303n, 'Charlie', 1), // Doing
    task(304n, 'Delta', null), // (unset)
    task(305n, 'Echo', 2), // Done
  ];
  const card = (id, type, attrs) => ({
    id: String(id), card_type_id: '9', card_type_name: type, parent_card_id: String(PROJECT_ID), attributes: attrs,
  });

  function sortTasks(rows, order) {
    if (!Array.isArray(order) || order.length === 0) return rows;
    const key = order[0];
    const field = String(key.field).replace(/^attributes\./, '');
    const dir = key.direction === 'DESC' ? -1 : 1;
    return [...rows].sort((a, b) => {
      const av = a.attributes[field], bv = b.attributes[field];
      const ae = av === undefined || av === null || av === '';
      const be = bv === undefined || bv === null || bv === '';
      if (ae && be) return 0;
      if (ae) return 1; // unset last regardless of dir
      if (be) return -1;
      return (String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0) * dir;
    });
  }

  function respond(sr) {
    if (`${sr.endpoint}.${sr.action}` === 'card.select_with_attributes') {
      const data = sr.data ?? {};
      switch (data.card_type_name) {
        case 'status':
          return { id: sr.id, ok: true, data: { rows: [card(1n, 'status', { name: 'Doing' }), card(2n, 'status', { name: 'Done' })] } };
        case 'person': case 'milestone': case 'component': case 'tag':
          return { id: sr.id, ok: true, data: { rows: [] } };
        case 'task': default:
          sent.taskInputs.push(data);
          return { id: sr.id, ok: true, data: { rows: sortTasks(TASKS, data.order) } };
      }
    }
    return { id: sr.id, ok: false, error: { code: 'unknown_handler', message: 'no' } };
  }
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      return { status: 200, text: JSON.stringify({ subresponses: req.subrequests.map(respond) }) };
    },
  };
  return { transport, sent };
}

/** The visible flat item sequence in the body: data rows ([data-grid-row]) and
 *  group headers ([data-grid-group-header]) in DOM order, skipping parked
 *  (display:none) pool nodes. */
function visibleItems(root) {
  return root
    .querySelectorAll('[data-grid-body]')[0]
    .querySelectorAll('[data-role="vlist-row"]')
    .filter((n) => n.style.display !== 'none')
    .map((n) =>
      n.dataset.gridGroupHeader !== undefined
        ? { kind: 'group', label: n.querySelectorAll('.grid__group-label')[0]?.textContent, count: n.querySelectorAll('.grid__group-count')[0]?.textContent, dir: n.dataset.groupDir }
        : { kind: 'row', id: n.dataset.cardId },
    );
}

test('Grid: GROUP picker (screen.group) buckets the body into header + row sections', async () => {
  const { transport } = groupingMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  // No group set yet → flat list, no group headers.
  assert.equal(
    grid.el.querySelectorAll('[data-grid-group-header]').filter((n) => n.style.display !== 'none').length,
    0,
    'no group headers when ungrouped',
  );

  // Drive the GROUP picker: group by status.
  tree.at(['screen', 'groupAxis']).set({ attr: 'status', lookup: 'statuses' });
  await settle(dispatcher);

  const items = visibleItems(grid.el);
  // Expect: Doing(2) [301,303], Done(2) [302,305], (unset)(1) [304].
  assert.deepEqual(
    items,
    [
      { kind: 'group', label: 'Doing', count: '· 2', dir: 'asc' },
      { kind: 'row', id: '301' },
      { kind: 'row', id: '303' },
      { kind: 'group', label: 'Done', count: '· 2', dir: 'asc' },
      { kind: 'row', id: '302' },
      { kind: 'row', id: '305' },
      { kind: 'group', label: '(unset)', count: '· 1', dir: 'asc' },
      { kind: 'row', id: '304' },
    ],
    'header(label·count) then bucketed rows, in column-sort order, unset last',
  );
});

test('Grid: grouping prepends the group key to the wire order[] (rows arrive bucketed)', async () => {
  const { transport, sent } = groupingMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  tree.at(['screen', 'groupAxis']).set({ attr: 'status', lookup: 'statuses' });
  await settle(dispatcher);
  const last = sent.taskInputs[sent.taskInputs.length - 1];
  assert.deepEqual(last.order, [{ field: 'attributes.status', direction: 'ASC' }], 'group key first, asc');
});

test('Grid: group-header click flips the group direction (asc ⇄ desc)', async () => {
  const { transport, sent } = groupingMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);
  tree.at(['screen', 'groupAxis']).set({ attr: 'status', lookup: 'statuses' });
  await settle(dispatcher);

  // First visible group header (Doing, asc).
  let header = grid.el.querySelectorAll('[data-grid-group-header]').find((n) => n.style.display !== 'none');
  assert.equal(header.dataset.groupDir, 'asc');

  // Click it → group dir flips to desc; the query re-issues with DESC group key.
  header.dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  const last = sent.taskInputs[sent.taskInputs.length - 1];
  assert.deepEqual(last.order, [{ field: 'attributes.status', direction: 'DESC' }], 'group key flipped DESC');

  // The body now leads with Done (desc), unset still last; header reads desc.
  const items = visibleItems(grid.el);
  assert.equal(items[0].kind, 'group');
  assert.equal(items[0].label, 'Done', 'desc → Done bucket first');
  assert.equal(items[0].dir, 'desc');
  assert.equal(items[items.length - 1].kind, 'row', 'unset bucket (Delta) still trails');
});

test('Grid: grouped rows recycle through the fixed virtualList pool (no churn)', async () => {
  const { transport } = groupingMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  // Pool node count before grouping.
  const poolBefore = grid.el.querySelectorAll('[data-role="vlist-row"]').length;
  tree.at(['screen', 'groupAxis']).set({ attr: 'status', lookup: 'statuses' });
  await settle(dispatcher);
  const poolAfter = grid.el.querySelectorAll('[data-role="vlist-row"]').length;
  // Same fixed pool — grouping flows through the SAME recycled nodes (the flat
  // header+row item list is just longer; no per-item node creation).
  assert.equal(poolAfter, poolBefore, 'grouping reuses the fixed recycling pool');

  // The visible window holds BOTH headers and rows, all backed by pool nodes.
  const visible = grid.el.querySelectorAll('[data-role="vlist-row"]').filter((n) => n.style.display !== 'none');
  const headers = visible.filter((n) => n.dataset.gridGroupHeader !== undefined);
  const rows = visible.filter((n) => n.dataset.gridRow !== undefined);
  assert.ok(headers.length === 3, 'three group headers visible');
  assert.ok(rows.length === 5, 'five data rows visible');
});

/* -------------------------------------------------------------------------- */
/* Row click / Enter / o navigates into the task detail (`/task/:id`).          */
/* -------------------------------------------------------------------------- */

test('Grid: clicking a data row navigates to /task/:id', async () => {
  const { transport } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  const row = visibleGridRows(grid.el)[0];
  assert.equal(row.dataset.cardId, '201');
  row.dispatchEvent({ type: 'click', target: row });
  assert.equal(location.pathname, '/task/201', 'row click navigated to the task detail');
});

test('Grid: Enter / o on a focused row opens the task detail', async () => {
  const { transport } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  const row = visibleGridRows(grid.el)[1];
  assert.equal(row.dataset.cardId, '202');
  row.dispatchEvent({ type: 'keydown', key: 'o', target: row });
  assert.equal(location.pathname, '/task/202', '`o` opened the task detail');
});

/* -------------------------------------------------------------------------- */
/* Bulk selection (tree-backed, recycling-safe) + the BulkActionBar.           */
/* -------------------------------------------------------------------------- */

/** Walk a control's subtree depth-first, collecting controls of `type`. */
function findControls(control, type) {
  const out = [];
  const walk = (c) => {
    if (c.type === type) out.push(c);
    for (const ch of c.childControls()) walk(ch);
  };
  walk(control);
  return out;
}

/** The Grid's spawned BulkActionBar control instance. */
function bulkBar(grid) {
  const bars = findControls(grid, 'BulkActionBar');
  assert.equal(bars.length, 1, 'one BulkActionBar mounted under the Grid');
  return bars[0];
}

/** The visible select checkboxes in the body rows (one per visible row). */
function rowSelectBoxes(grid) {
  return visibleGridRows(grid.el).map(
    (r) => r.querySelectorAll('[data-grid-select-row]')[0],
  );
}

test('Grid: toggling a row checkbox populates grid.selection (the tree set)', async () => {
  const { transport } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  // Selection starts empty (a Set in the tree).
  const sel = () => tree.at(['grid', 'selection']).peek();
  assert.ok(sel() instanceof Set && sel().size === 0, 'selection seeds as an empty Set');

  // Click the first row's checkbox → its id lands in the set.
  const boxes = rowSelectBoxes(grid);
  boxes[0].dispatchEvent({ type: 'click', target: boxes[0] });
  assert.deepEqual([...sel()], ['201'], 'row 201 selected');

  // Click the second → both ids present.
  boxes[1].dispatchEvent({ type: 'click', target: boxes[1] });
  assert.deepEqual([...sel()].sort(), ['201', '202'], 'both rows selected');

  // Re-click the first → it leaves the set (toggle off).
  boxes[0].dispatchEvent({ type: 'click', target: boxes[0] });
  assert.deepEqual([...sel()], ['202'], 'row 201 toggled off');
});

test('Grid: Space on a focused row toggles its selection', async () => {
  const { transport } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  const sel = () => tree.at(['grid', 'selection']).peek();
  const row = visibleGridRows(grid.el)[0];
  row.dispatchEvent({ type: 'keydown', key: ' ', target: row });
  assert.deepEqual([...sel()], ['201'], 'Space selected the focused row');
  // Navigation did NOT fire (Space is selection, not open).
  row.dispatchEvent({ type: 'keydown', key: ' ', target: row });
  assert.equal(sel().size, 0, 'Space again toggled it off');
});

test('Grid: header select-all checks every loaded task; re-click clears', async () => {
  const { transport } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  const sel = () => tree.at(['grid', 'selection']).peek();
  const all = grid.el.querySelectorAll('[data-grid-select-all]')[0];
  assert.ok(all, 'header select-all checkbox present');

  all.dispatchEvent({ type: 'click', target: all });
  assert.deepEqual([...sel()].sort(), ['201', '202'], 'select-all checked every task');
  M.flushSync?.(); // the header tri-state repaints in an effect (microtask)
  assert.equal(all.checked, true, 'header reflects all-selected');

  // Re-click → clears.
  all.dispatchEvent({ type: 'click', target: all });
  assert.equal(sel().size, 0, 'select-all re-click cleared the selection');
});

test('Grid: recycled rows render checked state from the tree set', async () => {
  const { transport } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  // Mutate the TREE set directly (the source of truth) + bump the version, as
  // the control's setSelection does — the row update must reflect it without
  // any per-node state.
  tree.at(['grid', 'selection']).set(new Set(['201']));
  const v = tree.at(['grid', 'selectionVersion']);
  v.set((v.peek() ?? 0) + 1);
  M.flushSync?.();

  const rows = visibleGridRows(grid.el);
  const boxFor = (r) => r.querySelectorAll('[data-grid-select-row]')[0];
  assert.equal(boxFor(rows[0]).checked, true, 'row 201 renders checked from the tree');
  assert.equal(boxFor(rows[1]).checked, false, 'row 202 renders unchecked');
  assert.ok('selected' in rows[0].dataset, 'selected row carries [data-selected]');
  assert.ok(!('selected' in rows[1].dataset), 'unselected row has no [data-selected]');
});

test('BulkActionBar: hidden when empty, shows the count when ≥1 selected', async () => {
  const { transport } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  const bar = grid.el.querySelectorAll('[data-bulk-bar]')[0];
  assert.ok(bar, 'bulk bar present in the DOM');
  assert.equal(bar.style.display, 'none', 'hidden with an empty selection');

  // Select two rows → the bar shows + the count updates.
  const boxes = rowSelectBoxes(grid);
  boxes[0].dispatchEvent({ type: 'click', target: boxes[0] });
  boxes[1].dispatchEvent({ type: 'click', target: boxes[1] });
  M.flushSync?.();
  assert.notEqual(bar.style.display, 'none', 'bar visible with a selection');
  const count = grid.el.querySelectorAll('[data-bulk-count]')[0];
  assert.equal(count.textContent, '2 tasks selected', 'count reflects the selection');
});

test('BulkActionBar: assign fires attribute.update once per selected card, batched', async () => {
  const { transport, sent } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  // The assignable fields are DATA-DRIVEN from `screen.refAxes` — mountGrid
  // already seeds it (status/assignee/milestone/component), the same axes the
  // bulk bar's attr picker offers.

  // Select both rows.
  const boxes = rowSelectBoxes(grid);
  boxes[0].dispatchEvent({ type: 'click', target: boxes[0] });
  boxes[1].dispatchEvent({ type: 'click', target: boxes[1] });

  // Drive the bar: pick the `status` ref attribute (its value editor is a
  // RefPicker), set a value, then click Apply — invoking the onChange callbacks
  // the bar wired (same path a user click takes).
  const bar = bulkBar(grid);
  // The attribute picker is the Combobox with the 'Field…' placeholder (its
  // options come from setOptions(screen.refAxes), not config.options).
  const attrCombo = findControls(bar, 'Combobox').find((c) => c.config.placeholder === 'Field…');
  assert.ok(attrCombo, 'the attribute picker is present');
  attrCombo.config.onChange('status'); // → builds the RefPicker value editor
  const valueRef = findControls(bar, 'RefPicker').find((c) => c.config.cardType === 'status');
  assert.ok(valueRef, 'a RefPicker value editor mounted for the picked ref attribute');
  valueRef.config.onChange(40n);

  const batchesBefore = sent.batches.length;
  const applyBtn = grid.el.querySelectorAll('[data-bulk-assign]')[0];
  assert.equal(applyBtn.disabled, false, 'Apply enabled once attr + value + selection set');
  applyBtn.dispatchEvent({ type: 'click', target: applyBtn });
  await settle(dispatcher);

  // One attribute.update per selected card.
  const updates = sent.writes.filter((w) => w.kind === 'attribute.update');
  assert.equal(updates.length, 2, 'one attribute.update per selected card');
  assert.deepEqual(
    updates.map((u) => String(u.data.card_id)).sort(),
    ['201', '202'],
    'targets both selected cards',
  );
  assert.ok(
    updates.every((u) => u.data.attribute_name === 'status' && String(u.data.value) === '40'),
    'each update sets status = 40',
  );

  // Coalesced: the two updates rode in ONE new batch (one POST).
  const newBatches = sent.batches.slice(batchesBefore);
  const assignBatch = newBatches.find((b) => b.includes('attribute.update'));
  assert.ok(assignBatch, 'an assign batch was sent');
  assert.equal(
    assignBatch.filter((k) => k === 'attribute.update').length,
    2,
    'both attribute.update calls coalesced into ONE batch',
  );

  // Selection cleared after the bulk op.
  assert.equal(tree.at(['grid', 'selection']).peek().size, 0, 'selection cleared after assign');

  // The reconciling re-query rode in the SAME batch as the writes, AFTER them —
  // so one server tx sees the writes and returns reconciled rows. (A separate,
  // concurrent re-query POST could read a pre-write snapshot and land stale rows
  // over the optimistic patch — the grid then wouldn't update until a re-nav.)
  assert.ok(
    assignBatch.includes('card.select_with_attributes'),
    're-query coalesced into the SAME batch as the writes (no separate racing POST)',
  );
  assert.ok(
    assignBatch.lastIndexOf('attribute.update') < assignBatch.indexOf('card.select_with_attributes'),
    're-query select is ordered AFTER the writes within the batch',
  );
});

test('BulkActionBar: Add stages a field so Apply sets several attributes at once', async () => {
  const { transport, sent } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  // Select both rows.
  const boxes = rowSelectBoxes(grid);
  boxes[0].dispatchEvent({ type: 'click', target: boxes[0] });
  boxes[1].dispatchEvent({ type: 'click', target: boxes[1] });

  const bar = bulkBar(grid);
  const attrCombo = findControls(bar, 'Combobox').find((c) => c.config.placeholder === 'Field…');

  // Pick status = 40, then "Add" it (stages a chip + resets the editor).
  attrCombo.config.onChange('status');
  findControls(bar, 'RefPicker').find((c) => c.config.cardType === 'status').config.onChange(40n);
  const addBtn = grid.el.querySelectorAll('[data-bulk-add-field]')[0];
  assert.equal(addBtn.disabled, false, 'Add enabled once a field+value is set');
  addBtn.dispatchEvent({ type: 'click', target: addBtn });
  assert.ok(grid.el.querySelectorAll('[data-bulk-staged="status"]')[0], 'a staged chip for status appeared');

  // Pick milestone = 32 and Apply WITHOUT adding it — the in-editor pair counts too.
  attrCombo.config.onChange('milestone_ref');
  findControls(bar, 'RefPicker').find((c) => c.config.cardType === 'milestone').config.onChange(32n);

  const batchesBefore = sent.batches.length;
  const applyBtn = grid.el.querySelectorAll('[data-bulk-assign]')[0];
  assert.equal(applyBtn.disabled, false, 'Apply enabled with one staged + one in-editor field');
  applyBtn.dispatchEvent({ type: 'click', target: applyBtn });
  await settle(dispatcher);

  // 2 cards × 2 fields = 4 attribute.update writes.
  const updates = sent.writes.filter((w) => w.kind === 'attribute.update');
  assert.equal(updates.length, 4, 'one attribute.update per (card × field)');
  const byAttr = (name) =>
    updates.filter((u) => u.data.attribute_name === name).map((u) => String(u.data.card_id)).sort();
  assert.deepEqual(byAttr('status'), ['201', '202'], 'status set on both cards');
  assert.deepEqual(byAttr('milestone_ref'), ['201', '202'], 'milestone set on both cards');

  // All four rode in ONE batch (one POST), plus the reconciling re-query.
  const newBatches = sent.batches.slice(batchesBefore);
  const assignBatch = newBatches.find((b) => b.includes('attribute.update'));
  assert.equal(
    assignBatch.filter((k) => k === 'attribute.update').length,
    4,
    'all four updates coalesced into ONE batch',
  );

  // Selection cleared + the staged chips reset after apply.
  assert.equal(tree.at(['grid', 'selection']).peek().size, 0, 'selection cleared after multi-assign');
});

test('BulkActionBar: Unassign clears the picked field on every selected card', async () => {
  const { transport, sent } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  // Select both rows.
  const boxes = rowSelectBoxes(grid);
  boxes[0].dispatchEvent({ type: 'click', target: boxes[0] });
  boxes[1].dispatchEvent({ type: 'click', target: boxes[1] });

  // Pick the field but DON'T enter a value — Apply stays disabled while
  // Unassign becomes available (the action posts value=null per card).
  const bar = bulkBar(grid);
  const attrCombo = findControls(bar, 'Combobox').find((c) => c.config.placeholder === 'Field…');
  attrCombo.config.onChange('milestone_ref');

  const applyBtn = grid.el.querySelectorAll('[data-bulk-assign]')[0];
  const unassignBtn = grid.el.querySelectorAll('[data-bulk-unassign]')[0];
  assert.ok(unassignBtn, 'an Unassign button is rendered');
  assert.equal(applyBtn.disabled, true, 'Apply stays disabled without a value');
  assert.equal(unassignBtn.disabled, false, 'Unassign enabled with field + selection');

  const batchesBefore = sent.batches.length;
  unassignBtn.dispatchEvent({ type: 'click', target: unassignBtn });
  await settle(dispatcher);

  // One attribute.update per selected card, each writing value=null.
  const updates = sent.writes.filter((w) => w.kind === 'attribute.update');
  assert.equal(updates.length, 2, 'one attribute.update per selected card');
  assert.deepEqual(
    updates.map((u) => String(u.data.card_id)).sort(),
    ['201', '202'],
    'targets both selected cards',
  );
  assert.ok(
    updates.every((u) => u.data.attribute_name === 'milestone_ref' && u.data.value === null),
    'each update clears milestone_ref to null',
  );

  // Coalesced into ONE batch (same path as Apply).
  const newBatches = sent.batches.slice(batchesBefore);
  const unassignBatch = newBatches.find((b) => b.includes('attribute.update'));
  assert.ok(unassignBatch, 'an unassign batch was sent');
  assert.equal(
    unassignBatch.filter((k) => k === 'attribute.update').length,
    2,
    'both attribute.update calls coalesced into ONE batch',
  );

  // Selection cleared after the bulk op.
  assert.equal(tree.at(['grid', 'selection']).peek().size, 0, 'selection cleared after unassign');
});

test('BulkActionBar: project-scoped ref pickers are scoped to the active project; person is not', async () => {
  const { transport } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  const bar = bulkBar(grid);
  const attrCombo = findControls(bar, 'Combobox').find((c) => c.config.placeholder === 'Field…');

  // A project-owned value-card type (milestone) → the picker is scoped to the
  // active project, so a cross-project pick (→ cross_project_ref reject) can't
  // be made.
  attrCombo.config.onChange('milestone_ref');
  const msRef = findControls(bar, 'RefPicker').find((c) => c.config.cardType === 'milestone');
  assert.ok(msRef, 'milestone RefPicker mounted');
  assert.equal(msRef.config.parentScopePath, 'scope.projectId', 'milestone picker scoped to the project');

  // A global ref (assignee → person) stays UNSCOPED (persons aren't project-owned).
  attrCombo.config.onChange('assignee');
  const personRef = findControls(bar, 'RefPicker').find((c) => c.config.cardType === 'person');
  assert.ok(personRef, 'assignee RefPicker mounted');
  assert.equal(personRef.config.parentScopePath, undefined, 'person picker is not project-scoped');
});

test('BulkActionBar: move fires task.move over the selection', async () => {
  const { transport, sent } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  const boxes = rowSelectBoxes(grid);
  boxes[0].dispatchEvent({ type: 'click', target: boxes[0] });
  boxes[1].dispatchEvent({ type: 'click', target: boxes[1] });

  // Pick a destination project on the move RefPicker (its onChange fires the
  // fan-out directly).
  const bar = bulkBar(grid);
  const moveRp = findControls(bar, 'RefPicker')[0];
  assert.ok(moveRp, 'the move-to-project RefPicker is mounted');
  moveRp.config.onChange(999n);
  await settle(dispatcher);

  const moves = sent.writes.filter((w) => w.kind === 'task.move');
  assert.equal(moves.length, 2, 'one task.move per selected card');
  assert.deepEqual(moves.map((m) => String(m.data.card_id)).sort(), ['201', '202']);
  assert.ok(moves.every((m) => String(m.data.new_project_id) === '999'), 'moved to project 999');
  assert.equal(tree.at(['grid', 'selection']).peek().size, 0, 'selection cleared after move');
});

test('BulkActionBar: purge is gated by a type-to-confirm and fires task.purge', async () => {
  const { transport, sent } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  const boxes = rowSelectBoxes(grid);
  boxes[0].dispatchEvent({ type: 'click', target: boxes[0] });
  boxes[1].dispatchEvent({ type: 'click', target: boxes[1] });

  // Open the purge confirm. No task.purge fires yet (gated).
  const purgeBtn = grid.el.querySelectorAll('[data-bulk-purge]')[0];
  purgeBtn.dispatchEvent({ type: 'click', target: purgeBtn });
  assert.ok(grid.el.querySelectorAll('[data-bulk-confirm]')[0], 'confirm dialog opened');
  const confirmBtn = grid.el.querySelectorAll('[data-bulk-confirm-accept]')[0];
  assert.equal(confirmBtn.disabled, true, 'confirm disabled until DELETE is typed');
  assert.equal(sent.writes.filter((w) => w.kind === 'task.purge').length, 0, 'no purge yet');

  // Type the wrong word → still gated.
  const input = grid.el.querySelectorAll('[data-bulk-confirm-input]')[0];
  input.value = 'delete';
  input.dispatchEvent({ type: 'input', target: input });
  assert.equal(confirmBtn.disabled, true, 'wrong text keeps it gated');

  // Type DELETE → enabled; click → fires one task.purge per selected card.
  input.value = 'DELETE';
  input.dispatchEvent({ type: 'input', target: input });
  assert.equal(confirmBtn.disabled, false, 'DELETE enables the destructive button');
  confirmBtn.dispatchEvent({ type: 'click', target: confirmBtn });
  await settle(dispatcher);

  const purges = sent.writes.filter((w) => w.kind === 'task.purge');
  assert.equal(purges.length, 2, 'one task.purge per selected card');
  assert.deepEqual(purges.map((p) => String(p.data.card_id)).sort(), ['201', '202']);
  assert.equal(grid.el.querySelectorAll('[data-bulk-confirm]').length, 0, 'confirm closed after purge');
  assert.equal(tree.at(['grid', 'selection']).peek().size, 0, 'selection cleared after purge');
});

test('BulkActionBar: Clear empties the selection without a write', async () => {
  const { transport, sent } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  const boxes = rowSelectBoxes(grid);
  boxes[0].dispatchEvent({ type: 'click', target: boxes[0] });
  assert.equal(tree.at(['grid', 'selection']).peek().size, 1);
  const writesBefore = sent.writes.length;

  const clearBtn = grid.el.querySelectorAll('[data-bulk-clear]')[0];
  clearBtn.dispatchEvent({ type: 'click', target: clearBtn });
  assert.equal(tree.at(['grid', 'selection']).peek().size, 0, 'Clear emptied the selection');
  assert.equal(sent.writes.length, writesBefore, 'Clear fired no write');
});

/* -------------------------------------------------------------------------- */
/* #24 — per-column filter funnels + column show/hide/reorder.                  */
/* -------------------------------------------------------------------------- */

test('Grid: ref columns carry a per-column filter funnel', async () => {
  const { transport } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);
  const funnels = grid.el.querySelectorAll('[data-grid-col-filter]').map((b) => b.dataset.gridColFilter);
  assert.deepEqual(
    funnels.sort(),
    ['assignee', 'component_ref', 'milestone_ref', 'status'],
    'a filter funnel on each ref column (not on tag-prefix / scalar / tags)',
  );
});

test('Grid: screen.columnConfig hides + reorders columns', async () => {
  const { transport } = gridMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const grid = mountGrid(api, tree);
  await settle(dispatcher);

  const headFields = () =>
    grid.el.querySelectorAll('[data-grid-header]').map((h) => h.dataset.gridCol);

  // Hide the Status + Priority columns.
  tree.at(['screen', 'columnConfig']).set({ hidden: ['status', 'tag:priority'], order: [] });
  await settle(dispatcher);
  let fields = headFields();
  assert.ok(!fields.includes('attributes.status'), 'status hidden');
  assert.ok(!fields.includes('tag:priority'), 'priority hidden');
  assert.ok(fields.includes('attributes.assignee'), 'assignee still visible');

  // Reorder: put assignee first (after the always-present id/title order is by key).
  tree.at(['screen', 'columnConfig']).set({
    hidden: [],
    order: ['assignee', 'id', 'title', 'status', 'milestone_ref', 'component_ref'],
  });
  await settle(dispatcher);
  fields = headFields();
  // assignee now precedes id/title.
  assert.ok(
    fields.indexOf('attributes.assignee') < fields.indexOf('id'),
    'assignee reordered ahead of id',
  );
});
