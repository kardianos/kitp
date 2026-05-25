/**
 * Screen-card backbone tests — the view system's resolution + saved-filter
 * layer (#29). Covers:
 *
 *   - the pure accessors (slug / layout / predicate / default_filter / fallback
 *     slug→layout map / the (project, slug) state path).
 *   - loadScreenAndFilters: a screen card resolved by slug + its filter cards
 *     loaded (two-step, ZERO-PROMISE callback path).
 *   - ScreenHost: a resolved screen card drives the body layout (the router seam
 *     now consults real screens — a 'kanban'-seeded host re-dispatches to Grid
 *     when the screen card's `layout` is 'grid').
 *   - ScreenFilterBar: named filters land in the preset selector; picking one
 *     applies its predicate to `screen.predicate` + its group to `screen.group`.
 *   - Save: creates a filter card (optimistic append + select) via card.insert.
 *   - default_filter applied on FIRST visit; `status notTerminal` fallback when
 *     the screen carries no default.
 *   - the (slug, project) cache restores the active preset on re-mount (back-nav).
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
let FakeElement;

before(async () => {
  ({ FakeElement } = installDomShim());
  // window.prompt / confirm for the Save / Rename / Delete flows.
  globalThis.window.prompt = (_msg, _init) => globalThis.window.__promptValue ?? null;
  globalThis.window.confirm = () => globalThis.window.__confirmValue !== false;

  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerScreenFilterBar();
  M.registerScreenHost();
  M.registerKanbanControls();
  M.registerTagChip();
  M.registerGrid();
  M.registerGridCardRefAttrs();
  M.registerPredicateFilter();
  M.registerFilterPresetSelector();
  M.registerCombobox();
});

const PROJECT_ID = 100n;
const SCREEN_GRID_ID = 700n; // the 'grid' screen card
const FILTER_OPEN_ID = 810n; // a saved filter ("Open work")
const FILTER_MINE_ID = 811n; // a saved filter ("Mine")

/* -------------------------------------------------------------------------- */
/* A mock transport serving screen + filter cards + tasks.                     */
/* -------------------------------------------------------------------------- */

function screenMockTransport(opts = {}) {
  const sent = { taskInputs: [], inserts: [], updates: [], deletes: [], screenReads: 0, filterReads: 0 };
  const defaultFilterId = opts.defaultFilterId; // bigint | undefined

  const card = (id, type, attrs) => ({
    id: String(id),
    card_type_id: '9',
    card_type_name: type,
    parent_card_id: String(PROJECT_ID),
    attributes: attrs,
  });
  const task = (id, title, attrs) => ({
    id: String(id),
    card_type_id: '5',
    card_type_name: 'task',
    parent_card_id: String(PROJECT_ID),
    phase: 'active',
    attributes: { title, ...attrs },
  });

  // The screen card: slug 'grid', layout 'grid' (so a 'kanban'-seeded host
  // re-dispatches to Grid). Its default_filter points at FILTER_OPEN_ID when set.
  function screenRow() {
    const attrs = { slug: 'grid', layout: 'grid', title: 'Grid' };
    if (defaultFilterId !== undefined) attrs.default_filter = String(defaultFilterId);
    return {
      id: String(SCREEN_GRID_ID),
      card_type_id: '20',
      card_type_name: 'screen',
      parent_card_id: String(PROJECT_ID),
      attributes: attrs,
    };
  }

  // Two saved filter cards parented to the screen. "Open work" carries a
  // milestone_ref predicate; "Mine" carries a status predicate + a group.
  const FILTERS = [
    {
      id: String(FILTER_OPEN_ID),
      card_type_id: '21',
      card_type_name: 'filter',
      parent_card_id: String(SCREEN_GRID_ID),
      attributes: {
        title: 'Open work',
        predicate: JSON.stringify({ attr: 'milestone_ref', op: 'in', values: ['32'] }),
      },
    },
    {
      id: String(FILTER_MINE_ID),
      card_type_id: '21',
      card_type_name: 'filter',
      parent_card_id: String(SCREEN_GRID_ID),
      attributes: {
        title: 'Mine',
        predicate: JSON.stringify({ attr: 'status', op: '=', values: ['40'] }),
        group_by_attr: 'status',
      },
    },
  ];

  const TASKS = [
    task(201n, 'Wire pickers', { sort_order: 100, status: '40', milestone_ref: '32' }),
    task(202n, 'API rate limits', { sort_order: 200 }),
  ];

  function respond(sr) {
    const key = `${sr.endpoint}.${sr.action}`;
    if (key === 'attribute_def.select') {
      return {
        id: sr.id,
        ok: true,
        data: {
          rows: [
            { id: '1', name: 'status', value_type: 'card_ref', target_card_type_name: 'status', is_built_in: true, bound_to: [{ card_type_id: '5', card_type_name: 'task', ordering: 1 }] },
            { id: '2', name: 'milestone_ref', value_type: 'card_ref', target_card_type_name: 'milestone', is_built_in: true, bound_to: [{ card_type_id: '5', card_type_name: 'task', ordering: 2 }] },
            { id: '3', name: 'title', value_type: 'text', is_built_in: true, bound_to: [{ card_type_id: '5', card_type_name: 'task', ordering: 3 }] },
          ],
        },
      };
    }
    if (key === 'card.select_with_attributes') {
      const data = sr.data ?? {};
      switch (data.card_type_name) {
        case 'screen':
          sent.screenReads++;
          return { id: sr.id, ok: true, data: { rows: [screenRow()] } };
        case 'filter':
          sent.filterReads++;
          return { id: sr.id, ok: true, data: { rows: FILTERS } };
        case 'person':
          return { id: sr.id, ok: true, data: { rows: [card(10n, 'person', { title: 'Alice' })] } };
        case 'status':
          return { id: sr.id, ok: true, data: { rows: [card(40n, 'status', { name: 'Doing' })] } };
        case 'milestone':
          return { id: sr.id, ok: true, data: { rows: [card(32n, 'milestone', { title: 'M1' })] } };
        case 'component':
          return { id: sr.id, ok: true, data: { rows: [card(50n, 'component', { title: 'FE' })] } };
        case 'tag':
          return { id: sr.id, ok: true, data: { rows: [card(60n, 'tag', { path: 'a/b' })] } };
        case 'task':
        default:
          sent.taskInputs.push(data);
          return { id: sr.id, ok: true, data: { rows: TASKS } };
      }
    }
    if (key === 'card.insert') {
      sent.inserts.push(sr.data ?? {});
      return { id: sr.id, ok: true, data: { id: '900' } };
    }
    if (key === 'attribute.update') {
      sent.updates.push(sr.data ?? {});
      return { id: sr.id, ok: true, data: { ok: true, activity_id: '70001' } };
    }
    if (key === 'card.delete') {
      sent.deletes.push(sr.data ?? {});
      return { id: sr.id, ok: true, data: { ok: true, activity_id: '70002' } };
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
  transport.sent = sent;
  return transport;
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api);
  M.registerProjectSpecs(api); // card.insert
  M.registerGridCardRefAttrs();
  M.registerFilterSpecs(api); // attribute_def.select
  M.registerFilterCardSpecs(api); // card.delete
  return { dispatcher, api };
}

async function settle(dispatcher) {
  // Several rounds: screen → filter reads are sequential batches, plus the
  // Grid's tasks/lookups; flush a few times to drain the chain.
  for (let i = 0; i < 5; i++) await dispatcher.flushNow();
  M.flushSync?.();
}

/** Walk the live control tree (depth-first) for the first control of `type`.
 *  findByControl returns DOM elements; this returns the Control INSTANCE so a
 *  test can invoke its config callbacks (the same path the Combobox fires). */
function findControl(root, type) {
  if (root.type === type) return root;
  for (const c of root.childControls()) {
    const hit = findControl(c, type);
    if (hit) return hit;
  }
  return null;
}

/** Mount a ScreenHost SEEDED with the kanban layout (so resolution must flip it
 *  to grid). Returns the host + the (project, slug) state path. */
function mountHost(api, tree) {
  tree.at(['scope', 'projectId']).set(PROJECT_ID);
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const ctx = { api, tree, scope };
  const host = M.Control.New(
    'ScreenHost',
    { type: 'ScreenHost', screen: { slug: 'grid', layout: 'kanban', title: 'Grid' }, resolveScreen: true },
    ctx,
  );
  host.mount(new FakeElement('div'));
  return { host, statePath: M.screenStatePath(PROJECT_ID, 'grid') };
}

/* -------------------------------------------------------------------------- */
/* Pure accessors.                                                             */
/* -------------------------------------------------------------------------- */

test('accessors: slug / layout / title / default_filter / predicate decode', () => {
  const screen = {
    id: 700n,
    card_type_id: 20n,
    card_type_name: 'screen',
    attributes: { slug: 'grid', layout: 'grid', title: 'Grid', default_filter: '810' },
  };
  assert.equal(M.readSlug(screen), 'grid');
  assert.equal(M.readLayout(screen), 'grid');
  assert.equal(M.readScreenTitle(screen), 'Grid');
  assert.equal(M.readDefaultFilterID(screen), 810n, 'default_filter revived to bigint');

  const filter = {
    id: 810n,
    card_type_id: 21n,
    card_type_name: 'filter',
    attributes: {
      title: 'Open',
      predicate: JSON.stringify({ attr: 'milestone_ref', op: 'in', values: ['32'] }),
      group_by_attr: 'status',
    },
  };
  const pred = M.readPredicate(filter);
  assert.deepEqual(pred, { kind: 'leaf', attr: 'milestone_ref', op: 'in', values: ['32'] });
  assert.equal(M.readGroupByAttr(filter), 'status');

  // Missing / malformed predicate → null (never throws).
  assert.equal(M.readPredicate({ id: 1n, attributes: {} }), null);
  assert.equal(M.readPredicate({ id: 1n, attributes: { predicate: 'not json{' } }), null);
});

test('fallbackLayoutForSlug: known slugs map; unknown → unknown', () => {
  assert.equal(M.fallbackLayoutForSlug('kanban'), 'kanban');
  assert.equal(M.fallbackLayoutForSlug('grid'), 'grid');
  assert.equal(M.fallbackLayoutForSlug('inbox'), 'list');
  assert.equal(M.fallbackLayoutForSlug('project'), 'project');
  assert.equal(M.fallbackLayoutForSlug('hologram'), 'unknown');
});

test('screenStatePath: keyed by (project, slug); null project → "none"', () => {
  assert.deepEqual(M.screenStatePath(100n, 'grid'), ['screens', '100', 'grid']);
  assert.deepEqual(M.screenStatePath(null, 'grid'), ['screens', 'none', 'grid']);
});

/* -------------------------------------------------------------------------- */
/* loadScreenAndFilters.                                                       */
/* -------------------------------------------------------------------------- */

test('loadScreenAndFilters: resolves the screen by slug + loads its filters', async () => {
  const transport = screenMockTransport({ defaultFilterId: FILTER_OPEN_ID });
  const { dispatcher, api } = bootApi(transport);

  let result = null;
  M.loadScreenAndFilters(api, PROJECT_ID, 'grid', (set) => (result = set));
  await settle(dispatcher);

  assert.ok(result, 'callback fired');
  assert.ok(result.screen, 'screen card resolved');
  assert.equal(result.screen.id, SCREEN_GRID_ID, 'matched the grid screen by slug');
  assert.equal(result.filters.length, 2, 'both filter cards loaded');
  assert.ok(result.defaultFilter, 'default filter resolved');
  assert.equal(result.defaultFilter.id, FILTER_OPEN_ID, 'default_filter id matched a filter card');
  assert.equal(transport.sent.screenReads, 1);
  assert.equal(transport.sent.filterReads, 1, 'filter read fired after the screen matched');
});

/* -------------------------------------------------------------------------- */
/* ScreenHost: a resolved screen card drives the body layout.                  */
/* -------------------------------------------------------------------------- */

test('ScreenHost: a screen card resolved by slug re-dispatches the body to its layout', async () => {
  const transport = screenMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const { host, statePath } = mountHost(api, tree);

  // Seeded layout (kanban) painted synchronously BEFORE resolution.
  let body = host.el.querySelector('.screen-host__body');
  assert.equal(body.dataset.layout, 'kanban', 'seeded with the fallback kanban layout');

  await settle(dispatcher);

  // After resolution the screen card's layout='grid' re-dispatched the body.
  body = host.el.querySelector('.screen-host__body');
  assert.equal(body.dataset.layout, 'grid', 'resolved screen card re-keyed the body to grid');
  assert.equal(body.findByControl('Grid').length, 1, 'grid layout → Grid control');
  assert.equal(tree.at([...statePath, 'screenId']).peek(), SCREEN_GRID_ID, 'screen id landed at the (project,slug) key');
  assert.equal(tree.at([...statePath, 'filters']).peek().length, 2, 'filters landed at the (project,slug) key');
});

/* -------------------------------------------------------------------------- */
/* ScreenFilterBar: named filters load + picking one applies its predicate.    */
/* -------------------------------------------------------------------------- */

test('ScreenFilterBar: named filters load into the preset selector; picking one applies its predicate', async () => {
  const transport = screenMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const { host, statePath } = mountHost(api, tree);
  await settle(dispatcher);

  const bar = host.el.findByControl('ScreenFilterBar')[0];
  assert.ok(bar, 'filter bar mounted (DOM)');
  const selectorEl = bar.findByControl('FilterPresetSelector')[0];
  assert.ok(selectorEl, 'preset selector mounted in row 1');
  const selector = findControl(host, 'FilterPresetSelector');
  assert.ok(selector, 'preset selector control instance found');

  // The filters list landed at the (project,slug) key → the selector reads it.
  assert.equal(tree.at([...statePath, 'filters']).peek().length, 2, 'filters available to the selector');

  // Pick the "Open work" preset (drive the bar's apply via the selector's
  // onPick callback — the same path the Combobox fires on a user pick).
  selector.config.onPick(FILTER_OPEN_ID);
  M.flushSync?.();
  await settle(dispatcher);

  assert.deepEqual(
    tree.at(['screen', 'predicate']).peek(),
    { kind: 'leaf', attr: 'milestone_ref', op: 'in', values: ['32'] },
    "picking 'Open work' applied its predicate to screen.predicate",
  );
  assert.equal(tree.at([...statePath, 'activeFilterId']).peek(), FILTER_OPEN_ID, 'active id cached');

  // The applied predicate fed the Grid tasks query (flat-AND → where[]).
  const last = transport.sent.taskInputs[transport.sent.taskInputs.length - 1];
  assert.deepEqual(last.where, [{ attr: 'milestone_ref', op: 'in', values: ['32'] }], 'predicate fed the tasks query');

  // Pick "Mine" → its predicate + group apply.
  selector.config.onPick(FILTER_MINE_ID);
  M.flushSync?.();
  await settle(dispatcher);
  assert.deepEqual(
    tree.at(['screen', 'predicate']).peek(),
    { kind: 'leaf', attr: 'status', op: 'eq', values: ['40'] },
    "picking 'Mine' applied its status predicate",
  );
  assert.equal(tree.at(['screen', 'group']).peek(), 'status', "'Mine' applied its group_by_attr → screen.group");
});

/* -------------------------------------------------------------------------- */
/* Save creates a filter card (optimistic).                                    */
/* -------------------------------------------------------------------------- */

test('ScreenFilterBar: Save creates a filter card via card.insert (optimistic append + select)', async () => {
  const transport = screenMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const { host, statePath } = mountHost(api, tree);
  await settle(dispatcher);

  const selector = findControl(host, 'FilterPresetSelector');
  assert.ok(selector, 'preset selector control instance found');

  // Build a predicate then Save it as a new view.
  selector.config.onPick(FILTER_OPEN_ID); // gives us a non-null predicate
  M.flushSync?.();
  await settle(dispatcher);

  globalThis.window.__promptValue = 'My saved view';
  const beforeCount = tree.at([...statePath, 'filters']).peek().length;
  selector.config.onSave();
  M.flushSync?.();

  // Optimistic append happened immediately (before the server round-trip).
  assert.equal(tree.at([...statePath, 'filters']).peek().length, beforeCount + 1, 'optimistic filter appended');

  await settle(dispatcher);

  // card.insert was shipped with the title + serialized predicate.
  const ins = transport.sent.inserts.find((i) => i.title === 'My saved view');
  assert.ok(ins, 'card.insert shipped for the saved view');
  assert.equal(ins.card_type_name, 'filter');
  // parent_card_id crosses the wire as a JSON string (Go json:",string").
  assert.equal(String(ins.parent_card_id), SCREEN_GRID_ID.toString(), 'parented under the screen card');
  assert.ok(ins.attributes && typeof ins.attributes.predicate === 'string', 'predicate stored as a JSON string');
  assert.deepEqual(
    JSON.parse(ins.attributes.predicate),
    { attr: 'milestone_ref', op: 'in', values: ['32'] },
    'serialized predicate matches the active filter',
  );
  // The new row's temp id was swapped for the server id (900) and selected.
  assert.equal(tree.at([...statePath, 'activeFilterId']).peek(), 900n, 'saved view selected (server id)');
  const saved = tree.at([...statePath, 'filters']).peek().find((f) => f.id === 900n);
  assert.ok(saved, 'saved filter row carries the real server id');

  globalThis.window.__promptValue = undefined;
});

/* -------------------------------------------------------------------------- */
/* default_filter applied on first visit + status notTerminal fallback.        */
/* -------------------------------------------------------------------------- */

test('default_filter applied on first visit', async () => {
  const transport = screenMockTransport({ defaultFilterId: FILTER_OPEN_ID });
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const { statePath } = mountHost(api, tree);
  await settle(dispatcher);

  // On first visit the screen's default_filter (Open work) applied automatically.
  assert.equal(tree.at([...statePath, 'activeFilterId']).peek(), FILTER_OPEN_ID, 'default filter selected on first visit');
  assert.deepEqual(
    tree.at(['screen', 'predicate']).peek(),
    { kind: 'leaf', attr: 'milestone_ref', op: 'in', values: ['32'] },
    "default filter's predicate applied to screen.predicate",
  );
});

test('default-on-first-visit falls back to `status notTerminal` when no default_filter', async () => {
  const transport = screenMockTransport(); // no defaultFilterId
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const { statePath } = mountHost(api, tree);
  await settle(dispatcher);

  // No default → the `status notTerminal` fallback applied; active id null
  // (visited, "Default").
  assert.equal(tree.at([...statePath, 'activeFilterId']).peek(), null, 'no preset; cache marked visited');
  assert.deepEqual(
    tree.at(['screen', 'predicate']).peek(),
    { kind: 'leaf', attr: 'status', op: 'notTerminal' },
    'fallback applied a single status notTerminal leaf',
  );
});

/* -------------------------------------------------------------------------- */
/* The (slug, project) cache restores the active preset on re-mount.           */
/* -------------------------------------------------------------------------- */

test('(slug, project) cache restores the active preset on re-mount (back-nav)', async () => {
  const transport = screenMockTransport({ defaultFilterId: FILTER_OPEN_ID });
  const { dispatcher, api } = bootApi(transport);
  // ONE shared tree across the two mounts (the app's single data tree). The
  // active-filter id is cached under the (project, slug) key.
  const tree = new M.TreeNode({}, []);

  // First mount: the default applies; then the user picks "Mine".
  const first = mountHost(api, tree);
  await settle(dispatcher);
  const sel1 = findControl(first.host, 'FilterPresetSelector');
  sel1.config.onPick(FILTER_MINE_ID);
  M.flushSync?.();
  await settle(dispatcher);
  assert.equal(tree.at([...first.statePath, 'activeFilterId']).peek(), FILTER_MINE_ID, 'user picked Mine');

  // Tear the host down (leave the route) — the cache stays in the tree.
  first.host.destroy();

  // Re-mount the SAME (project, slug) screen (back-nav). The default must NOT
  // re-apply over the cached active preset; the cache restores "Mine".
  const second = mountHost(api, tree);
  await settle(dispatcher);
  assert.equal(
    tree.at([...second.statePath, 'activeFilterId']).peek(),
    FILTER_MINE_ID,
    're-mount restored the cached active preset (not the default)',
  );
  assert.deepEqual(
    tree.at(['screen', 'predicate']).peek(),
    { kind: 'leaf', attr: 'status', op: 'eq', values: ['40'] },
    "restored Mine's predicate (not the default's)",
  );
});
