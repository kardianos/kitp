import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
let FakeElement;

before(async () => {
  ({ FakeElement } = installDomShim());
  // The Grid renders rows through the keyed virtual list (see grid.test.mjs);
  // teach the shim the nextSibling / move-on-insert semantics it needs.
  Object.defineProperty(FakeElement.prototype, 'nextSibling', {
    configurable: true,
    get() {
      const p = this.parentNode;
      if (!p) return null;
      const i = p.children.indexOf(this);
      return i >= 0 && i + 1 < p.children.length ? p.children[i + 1] : null;
    },
  });
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
  // Register the controls the task screens compose (Control.register throws on dup).
  M.registerScreenFilterBar();
  M.registerScreenHost();
  M.registerKanbanControls();
  M.registerTagChip();
  M.registerGrid();
  M.registerPredicateFilter();
  M.registerQuickChips();
  M.registerNamedFilters();
});

const PROJECT_ID = 100n;

/**
 * A task-screen mock transport: distinct rows per card_type, an attribute_def
 * source for the `{ cardType: 'task' }` schema, and it RECORDS every tasks-query
 * input so a test can assert what the Advanced predicate fed (where[] / tree).
 */
function taskMockTransport() {
  const sent = { taskInputs: [] };

  const task = (id, title, attrs) => ({
    id: String(id),
    card_type_id: '5',
    card_type_name: 'task',
    parent_card_id: String(PROJECT_ID),
    phase: 'active',
    attributes: { title, ...attrs },
  });
  const card = (id, type, attrs) => ({
    id: String(id),
    card_type_id: '9',
    card_type_name: type,
    parent_card_id: String(PROJECT_ID),
    attributes: attrs,
  });

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
            {
              id: '1',
              name: 'status',
              value_type: 'card_ref',
              target_card_type_name: 'status',
              is_built_in: true,
              bound_to: [{ card_type_id: '5', card_type_name: 'task', ordering: 1 }],
            },
            {
              id: '2',
              name: 'milestone_ref',
              value_type: 'card_ref',
              target_card_type_name: 'milestone',
              is_built_in: true,
              bound_to: [{ card_type_id: '5', card_type_name: 'task', ordering: 2 }],
            },
            {
              id: '3',
              name: 'title',
              value_type: 'text',
              is_built_in: true,
              bound_to: [{ card_type_id: '5', card_type_name: 'task', ordering: 3 }],
            },
          ],
        },
      };
    }
    if (key === 'card.select_with_attributes') {
      const data = sr.data ?? {};
      switch (data.card_type_name) {
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
        case 'predicate_snippet':
          return {
            id: sr.id,
            ok: true,
            data: {
              rows: [
                card(900n, 'predicate_snippet', {
                  title: 'My open work',
                  predicate: JSON.stringify({ attr: 'status', op: 'not terminal' }),
                }),
                card(901n, 'predicate_snippet', {
                  title: 'API component',
                  predicate: JSON.stringify({ attr: 'component_ref', op: 'in', values: ['50'] }),
                }),
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
  transport.sent = sent;
  return transport;
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api);
  M.registerGridCardRefAttrs();
  M.registerFilterSpecs(api);
  return { dispatcher, api };
}

async function settle(dispatcher) {
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  M.flushSync?.();
}

/** Mount a grid task screen (ScreenHost → ScreenFilterBar + Grid) with a project
 *  scope already resolved so the tasks query fires. */
function mountScreen(api) {
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(PROJECT_ID);
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const ctx = { api, tree, scope };
  const host = M.Control.New(
    'ScreenHost',
    // resolveScreen:false — these cases assert on the bare predicate→query
    // wiring (the Advanced editor), not screen-card resolution / saved filters;
    // the screen-card backbone has its own dedicated test file.
    { type: 'ScreenHost', screen: { slug: 'grid', layout: 'grid', title: 'Grid' }, resolveScreen: false },
    ctx,
  );
  host.mount(new FakeElement('div'));
  return { host, tree };
}

function setSelect(el, value) {
  el.value = value;
  el.dispatchEvent({ type: 'change' });
  M.flushSync?.();
}
function setInput(el, value) {
  el.value = value;
  el.dispatchEvent({ type: 'input' });
  M.flushSync?.();
}

/* -------------------------------------------------------------------------- */
/* The Advanced affordance mounts a PredicateFilter.                           */
/* -------------------------------------------------------------------------- */

test('ScreenFilterBar: the Advanced toggle expands a panel hosting a PredicateFilter', async () => {
  const transport = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { host } = mountScreen(api);
  await settle(dispatcher);

  const bar = host.el.findByControl('ScreenFilterBar')[0];
  assert.ok(bar, 'shared filter bar mounted');
  // The PredicateFilter is spawned by the bar (its panel starts hidden).
  assert.equal(bar.findByControl('PredicateFilter').length, 1, 'one PredicateFilter mounted under the bar');
  const panel = bar.querySelector('[data-filter-panel]');
  assert.ok(panel, 'advanced panel present');
  assert.equal(panel.style.display, 'none', 'panel starts collapsed');

  // Toggle Advanced → the panel expands.
  const advanced = bar.querySelector('[data-filter-advanced]');
  advanced.dispatchEvent({ type: 'click' });
  M.flushSync?.();
  assert.notEqual(panel.style.display, 'none', 'panel expanded on Advanced click');
  assert.equal(advanced.getAttribute('aria-expanded'), 'true');
});

/* -------------------------------------------------------------------------- */
/* A built predicate feeds the Grid tasks query (where[] for a flat AND).      */
/* -------------------------------------------------------------------------- */

test('ScreenFilterBar: a flat-AND predicate feeds the Grid tasks query where[] (composed with search)', async () => {
  const transport = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { host, tree } = mountScreen(api);
  await settle(dispatcher);

  const firesBefore = transport.sent.taskInputs.length;

  const pf = host.el.findByControl('PredicateFilter')[0];
  // Build: milestone_ref in [32]. add leaf → default attr is the first schema
  // entry (status, a card_ref) → switch to milestone_ref → op 'in' → pick M1.
  pf.querySelector('[data-pred-add-leaf]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  setSelect(pf.querySelector('[data-pred-attr]'), 'milestone_ref');
  setSelect(pf.querySelector('[data-pred-op]'), 'in');
  const ref = pf.querySelector('[data-pred-ref]');
  assert.ok(ref, 'ref picker rendered with options from grid.lookups');
  // Options were projected from the Grid's milestone lookup (id 32 → "M1").
  const refValues = ref.children.map((o) => o.value);
  assert.ok(refValues.includes('32'), 'milestone option present from lookups');
  ref.children.find((o) => o.value === '32').selected = true;
  ref.dispatchEvent({ type: 'change' });
  M.flushSync?.();
  await settle(dispatcher);

  const last = transport.sent.taskInputs[transport.sent.taskInputs.length - 1];
  assert.deepEqual(
    last.where,
    [{ attr: 'milestone_ref', op: 'in', values: ['32'] }],
    'flat-AND predicate fed the tasks query where[]',
  );
  assert.equal(last.tree, undefined, 'no tree for a flat-AND predicate');
  assert.ok(transport.sent.taskInputs.length > firesBefore, 'predicate edit refired the tasks query');

  // Add a search term → it composes (ANDs) into the same where[] alongside the leaf.
  const search = host.el.findByControl('ScreenFilterBar')[0].querySelector('[data-filter-search]');
  setInput(search, 'rate');
  await settle(dispatcher);
  const composed = transport.sent.taskInputs[transport.sent.taskInputs.length - 1];
  assert.deepEqual(composed.where, [
    { attr: 'title', op: 'contains', value: 'rate' },
    { attr: 'milestone_ref', op: 'in', values: ['32'] },
  ], 'search leaf + predicate leaf compose in where[]');
});

/* -------------------------------------------------------------------------- */
/* A structured predicate (OR) feeds the v2 tree input.                        */
/* -------------------------------------------------------------------------- */

test('ScreenFilterBar: a structured (OR) predicate feeds the Grid tasks query tree', async () => {
  const transport = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { host } = mountScreen(api);
  await settle(dispatcher);

  const pf = host.el.findByControl('PredicateFilter')[0];
  setSelect(pf.querySelectorAll('[data-pred-connective]')[0], 'or');
  pf.querySelector('[data-pred-add-leaf]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  setSelect(pf.querySelector('[data-pred-attr]'), 'title');
  setSelect(pf.querySelector('[data-pred-op]'), 'contains');
  setInput(pf.querySelector('[data-pred-value]').querySelector('input'), 'urgent');
  await settle(dispatcher);

  const last = transport.sent.taskInputs[transport.sent.taskInputs.length - 1];
  assert.deepEqual(
    last.tree,
    { connective: 'or', children: [{ attr: 'title', op: 'contains', values: ['urgent'] }] },
    'structured predicate fed the v2 tree input',
  );
  assert.equal(last.where, undefined, 'no where[] when no search + a structured tree');
});

/* -------------------------------------------------------------------------- */
/* Clear resets the predicate (and re-runs the query without it).              */
/* -------------------------------------------------------------------------- */

test('ScreenFilterBar: Clear resets the predicate leaf + drops it from the tasks query', async () => {
  const transport = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { host, tree } = mountScreen(api);
  await settle(dispatcher);

  const bar = host.el.findByControl('ScreenFilterBar')[0];
  const pf = bar.findByControl('PredicateFilter')[0];
  pf.querySelector('[data-pred-add-leaf]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  setSelect(pf.querySelector('[data-pred-attr]'), 'title');
  setSelect(pf.querySelector('[data-pred-op]'), 'contains');
  setInput(pf.querySelector('[data-pred-value]').querySelector('input'), 'temp');
  await settle(dispatcher);
  assert.ok(tree.at(['screen', 'predicate']).peek(), 'predicate set before Clear');

  // Clear → predicate leaf reset to null + the editor re-seeds (no leaves).
  bar.querySelector('.filterbar__clear').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  await settle(dispatcher);

  assert.equal(tree.at(['screen', 'predicate']).peek(), null, 'predicate cleared to null');
  const pf2 = bar.findByControl('PredicateFilter')[0];
  assert.equal(pf2.querySelectorAll('[data-pred-leaf]').length, 0, 'editor re-seeded with no leaves');

  const last = transport.sent.taskInputs[transport.sent.taskInputs.length - 1];
  assert.equal(last.where, undefined, 'tasks query no longer carries the predicate');
  assert.equal(last.tree, undefined, 'no tree after Clear');
});

/* -------------------------------------------------------------------------- */
/* QUICK CHIPS — pinned per-attribute one-tap filters over screen.predicate.    */
/* -------------------------------------------------------------------------- */

/** Find the bar's QuickChips DOM node under a mounted screen. */
function quickChips(host) {
  return host.el.findByControl('ScreenFilterBar')[0].findByControl('QuickChips')[0];
}
/** Recursively walk the live control tree (public childControls()) for a type. */
function findControl(root, type) {
  if (root.type === type) return root;
  for (const c of root.childControls()) {
    const hit = findControl(c, type);
    if (hit) return hit;
  }
  return null;
}
/** The QuickChips control INSTANCE (carries the toggle/clear/read test hooks). */
function quickChipControl(host) {
  return findControl(host, 'QuickChips');
}

test('QuickChips: the bar pins a chip row (Status / Assignee / Milestone / Component / Tags)', async () => {
  const transport = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { host } = mountScreen(api);
  await settle(dispatcher);

  const chips = quickChips(host);
  assert.ok(chips, 'QuickChips row mounted by the bar');
  const attrs = chips.querySelectorAll('[data-quick-chip]').map((b) => b.dataset.quickChip);
  assert.deepEqual(
    attrs,
    ['status', 'assignee', 'milestone_ref', 'component_ref', 'tags'],
    'the default pinned chip set, in order',
  );
});

test('QuickChips: selecting values writes an `attr in [values]` top-level leaf into screen.predicate', async () => {
  const transport = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { host, tree } = mountScreen(api);
  await settle(dispatcher);

  const cc = quickChipControl(host);
  assert.ok(cc, 'QuickChips control instance');

  // One value → an `eq` leaf; a second value → an `in` leaf (multi).
  cc.toggleChipValue('status', '40');
  M.flushSync?.();
  assert.deepEqual(
    tree.at(['screen', 'predicate']).peek(),
    { kind: 'leaf', attr: 'status', op: 'eq', values: ['40'] },
    'single selection → a bare eq leaf',
  );
  cc.toggleChipValue('status', '41');
  M.flushSync?.();
  assert.deepEqual(
    tree.at(['screen', 'predicate']).peek(),
    { kind: 'leaf', attr: 'status', op: 'in', values: ['40', '41'] },
    'second selection → an in leaf with both values',
  );

  // The chip reflects its active selection + count.
  assert.deepEqual(cc.chipValues('status'), ['40', '41'], 'chip reflects both selected values');
  const trigger = quickChips(host).querySelector('[data-quick-chip="status"]');
  assert.ok(
    trigger.querySelector('.filterbar__chip-label').textContent.includes('2'),
    'trigger shows the active count',
  );
  assert.ok(trigger.classList.contains('filterbar__chip--active'), 'active chip is tinted');

  // It fed the live tasks query (Grid reads screen.predicate reactively).
  await settle(dispatcher);
  const last = transport.sent.taskInputs[transport.sent.taskInputs.length - 1];
  assert.deepEqual(
    last.where,
    [{ attr: 'status', op: 'in', values: ['40', '41'] }],
    'the chip leaf fed the tasks query where[]',
  );
});

test('QuickChips: clearing a chip removes its leaf from screen.predicate', async () => {
  const transport = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { host, tree } = mountScreen(api);
  await settle(dispatcher);

  const cc = quickChipControl(host);
  cc.toggleChipValue('status', '40');
  M.flushSync?.();
  assert.ok(tree.at(['screen', 'predicate']).peek(), 'predicate set after select');

  cc.clearChipLeaf('status');
  M.flushSync?.();
  assert.equal(tree.at(['screen', 'predicate']).peek(), null, 'leaf removed → predicate null');
  assert.deepEqual(cc.chipValues('status'), [], 'chip reflects no selection');
  const trigger = quickChips(host).querySelector('[data-quick-chip="status"]');
  assert.equal(trigger.querySelector('.filterbar__chip-clear').style.display, 'none', 'clear-X hidden');
  assert.ok(!trigger.classList.contains('filterbar__chip--active'), 'chip no longer active');
});

test('QuickChips: a chip leaf composes (ANDs) with an existing Advanced leaf in the root', async () => {
  const transport = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { host, tree } = mountScreen(api);
  await settle(dispatcher);

  // Build an Advanced leaf first: milestone_ref in [32] (a flat-AND leaf).
  const pf = host.el.findByControl('PredicateFilter')[0];
  pf.querySelector('[data-pred-add-leaf]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  setSelect(pf.querySelector('[data-pred-attr]'), 'milestone_ref');
  setSelect(pf.querySelector('[data-pred-op]'), 'in');
  const ref = pf.querySelector('[data-pred-ref]');
  ref.children.find((o) => o.value === '32').selected = true;
  ref.dispatchEvent({ type: 'change' });
  M.flushSync?.();

  // Now a quick chip for status → both leaves AND in the root.
  const cc = quickChipControl(host);
  cc.toggleChipValue('status', '40');
  M.flushSync?.();

  assert.deepEqual(tree.at(['screen', 'predicate']).peek(), {
    kind: 'group',
    connective: 'and',
    children: [
      { kind: 'leaf', attr: 'milestone_ref', op: 'in', values: ['32'] },
      { kind: 'leaf', attr: 'status', op: 'eq', values: ['40'] },
    ],
  }, 'Advanced leaf + chip leaf compose as a flat AND in the root');

  // Consistency: the Advanced editor re-seeds from the merged tree (it now shows
  // BOTH leaves), and both are fed to the tasks query.
  const pf2 = host.el.findByControl('PredicateFilter')[0];
  assert.equal(pf2.querySelectorAll('[data-pred-leaf]').length, 2, 'Advanced editor shows both leaves');
  await settle(dispatcher);
  const last = transport.sent.taskInputs[transport.sent.taskInputs.length - 1];
  assert.deepEqual(last.where, [
    { attr: 'milestone_ref', op: 'in', values: ['32'] },
    { attr: 'status', op: '=', values: ['40'] },
  ], 'both leaves fed the tasks query where[]');
});

test('QuickChips: a predicate change from ANOTHER surface reflects in the chip active state', async () => {
  const transport = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { host, tree } = mountScreen(api);
  await settle(dispatcher);

  const cc = quickChipControl(host);
  assert.deepEqual(cc.chipValues('status'), [], 'chip starts empty');

  // Simulate the Advanced editor / a named filter writing a status leaf directly
  // into the SAME screen.predicate the chips read.
  tree.at(['screen', 'predicate']).set({ kind: 'leaf', attr: 'status', op: 'in', values: ['40', '41'] });
  M.flushSync?.();

  assert.deepEqual(cc.chipValues('status'), ['40', '41'], 'chip reflects the externally-written leaf');
  const trigger = quickChips(host).querySelector('[data-quick-chip="status"]');
  assert.ok(trigger.classList.contains('filterbar__chip--active'), 'chip becomes active');
  assert.ok(trigger.querySelector('.filterbar__chip-label').textContent.includes('2'), 'count reflects 2');
});

/* -------------------------------------------------------------------------- */
/* NAMED FILTERS — the "Named" multi-select toggles snippet-id leaves.          */
/* Picking a snippet emits a `{op:'snippet', values:[id]}` top-level leaf into   */
/* screen.predicate (the server expands it); un-picking removes it. Keyed by     */
/* snippet id (one leaf per snippet) so multiple snippets AND together.          */
/* -------------------------------------------------------------------------- */

/** The NamedFilters control INSTANCE (carries the toggle/clear/read hooks). */
function namedFiltersControl(host) {
  return findControl(host, 'NamedFilters');
}

test('NamedFilters: the snippet store loads predicate_snippet cards for the project', async () => {
  const transport = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { host, tree } = mountScreen(api);
  await settle(dispatcher);

  const nf = namedFiltersControl(host);
  assert.ok(nf, 'NamedFilters control instance');

  // The scoped load landed the project's snippet cards at screen.snippets.
  const rows = tree.at(['screen', 'snippets']).peek();
  assert.ok(Array.isArray(rows) && rows.length === 2, 'two snippet cards loaded');
  const opts = nf.snippetOptions();
  assert.deepEqual(
    opts.map((o) => o.title),
    ['My open work', 'API component'],
    'the multi-select options are the snippet titles',
  );
  assert.deepEqual(opts.map((o) => o.key), ['900', '901'], 'keyed by snippet id');
});

test('NamedFilters: picking a snippet adds a snippet-id leaf to screen.predicate (server expands it)', async () => {
  const transport = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { host, tree } = mountScreen(api);
  await settle(dispatcher);

  const nf = namedFiltersControl(host);
  nf.toggleSnippetId(900n);
  M.flushSync?.();

  // The wire shape card_compile_predicate dispatches on: op 'snippet' carrying
  // the snippet id (stringified). The client does NOT expand it.
  assert.deepEqual(
    tree.at(['screen', 'predicate']).peek(),
    { kind: 'leaf', attr: '_snippet', op: 'snippet', values: ['900'] },
    'a single snippet → a bare snippet leaf carrying the id',
  );
  assert.deepEqual(nf.activeSnippetIds(), ['900'], 'control reflects the active snippet');
  const trigger = host.el.findByControl('NamedFilters')[0].querySelector('[data-named-filters]');
  assert.ok(trigger.classList.contains('filterbar__chip--active'), 'trigger is tinted active');
  assert.ok(trigger.querySelector('.filterbar__chip-label').textContent.includes('1'), 'count reflects 1');

  // It fed the live tasks query. A bare snippet leaf is a flat-AND-of-leaves, so
  // it crosses on `where[]` as the wire leaf the SQL compiler dispatches on
  // (the server compiles where[] + tree through the SAME card_compile_predicate
  // — op:'snippet' fetches the snippet card + recurses + cycle-guards).
  await settle(dispatcher);
  const last = transport.sent.taskInputs[transport.sent.taskInputs.length - 1];
  assert.deepEqual(
    last.where,
    [{ attr: '_snippet', op: 'snippet', values: ['900'] }],
    'the snippet-id leaf fed the tasks query (server expands the snippet id)',
  );
  assert.equal(last.tree, undefined, 'a single snippet leaf stays flat-AND (where[])');
});

test('NamedFilters: un-picking a snippet removes its leaf from screen.predicate', async () => {
  const transport = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { host, tree } = mountScreen(api);
  await settle(dispatcher);

  const nf = namedFiltersControl(host);
  nf.toggleSnippetId(900n);
  M.flushSync?.();
  assert.ok(tree.at(['screen', 'predicate']).peek(), 'predicate set after pick');

  // Toggle the SAME snippet again → removed (idempotent toggle).
  nf.toggleSnippetId(900n);
  M.flushSync?.();
  assert.equal(tree.at(['screen', 'predicate']).peek(), null, 'snippet leaf removed → predicate null');
  assert.deepEqual(nf.activeSnippetIds(), [], 'no active snippet');
  const trigger = host.el.findByControl('NamedFilters')[0].querySelector('[data-named-filters]');
  assert.ok(!trigger.classList.contains('filterbar__chip--active'), 'trigger no longer active');
  assert.equal(trigger.querySelector('.filterbar__chip-clear').style.display, 'none', 'clear-X hidden');
});

test('NamedFilters: two snippets AND together as one leaf each', async () => {
  const transport = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { host, tree } = mountScreen(api);
  await settle(dispatcher);

  const nf = namedFiltersControl(host);
  nf.toggleSnippetId(900n);
  M.flushSync?.();
  nf.toggleSnippetId(901n);
  M.flushSync?.();

  assert.deepEqual(tree.at(['screen', 'predicate']).peek(), {
    kind: 'group',
    connective: 'and',
    children: [
      { kind: 'leaf', attr: '_snippet', op: 'snippet', values: ['900'] },
      { kind: 'leaf', attr: '_snippet', op: 'snippet', values: ['901'] },
    ],
  }, 'two snippets → two snippet leaves AND-ed in the root (one leaf per id)');
  assert.deepEqual(nf.activeSnippetIds(), ['900', '901'], 'both snippets active');

  // Clear-X drops them all at once.
  nf.clearSnippets();
  M.flushSync?.();
  assert.equal(tree.at(['screen', 'predicate']).peek(), null, 'clear drops all snippet leaves');
});

test('NamedFilters: active state reflects an external predicate change', async () => {
  const transport = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { host, tree } = mountScreen(api);
  await settle(dispatcher);

  const nf = namedFiltersControl(host);
  assert.deepEqual(nf.activeSnippetIds(), [], 'starts with no active snippet');

  // Simulate another surface (the Advanced editor / a named view) writing a
  // snippet leaf directly into the SAME screen.predicate the multi-select reads.
  tree.at(['screen', 'predicate']).set({ kind: 'leaf', attr: '_snippet', op: 'snippet', values: ['901'] });
  M.flushSync?.();

  assert.deepEqual(nf.activeSnippetIds(), ['901'], 'reflects the externally-written snippet leaf');
  const trigger = host.el.findByControl('NamedFilters')[0].querySelector('[data-named-filters]');
  assert.ok(trigger.classList.contains('filterbar__chip--active'), 'trigger becomes active');
});

test('NamedFilters: a snippet leaf composes with a quick-chip leaf + an Advanced leaf in the root AND', async () => {
  const transport = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { host, tree } = mountScreen(api);
  await settle(dispatcher);

  // Advanced leaf: milestone_ref in [32].
  const pf = host.el.findByControl('PredicateFilter')[0];
  pf.querySelector('[data-pred-add-leaf]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  setSelect(pf.querySelector('[data-pred-attr]'), 'milestone_ref');
  setSelect(pf.querySelector('[data-pred-op]'), 'in');
  const ref = pf.querySelector('[data-pred-ref]');
  ref.children.find((o) => o.value === '32').selected = true;
  ref.dispatchEvent({ type: 'change' });
  M.flushSync?.();

  // Quick-chip leaf: status eq 40.
  quickChipControl(host).toggleChipValue('status', '40');
  M.flushSync?.();

  // Snippet leaf: snippet 901.
  namedFiltersControl(host).toggleSnippetId(901n);
  M.flushSync?.();

  assert.deepEqual(tree.at(['screen', 'predicate']).peek(), {
    kind: 'group',
    connective: 'and',
    children: [
      { kind: 'leaf', attr: 'milestone_ref', op: 'in', values: ['32'] },
      { kind: 'leaf', attr: 'status', op: 'eq', values: ['40'] },
      { kind: 'leaf', attr: '_snippet', op: 'snippet', values: ['901'] },
    ],
  }, 'Advanced + quick-chip + snippet leaves all AND in the root (one tree, many surfaces)');

  // Consistency: the multi-select still reflects only its snippet; the chip
  // still reflects only its value — each surface owns its own slice of the tree.
  assert.deepEqual(namedFiltersControl(host).activeSnippetIds(), ['901'], 'named reflects its snippet');
  assert.deepEqual(quickChipControl(host).chipValues('status'), ['40'], 'chip reflects its value');
});
