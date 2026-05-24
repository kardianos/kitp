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
    { type: 'ScreenHost', screen: { slug: 'grid', layout: 'grid', title: 'Grid' } },
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
