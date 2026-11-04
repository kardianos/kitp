/**
 * Personal screens and views (docs/PERSONAL_SCREENS.md):
 *   - the project-scope helpers and the views listing;
 *   - withScopeTree (a personal screen's base filter rides every query) and
 *     the `a|b` skip rule;
 *   - a personal screen end to end: the host resolves it by id, lands its
 *     base filter as screen.scopeTree, and the list fires over every project
 *     (no project_id) with that filter in its tree;
 *   - the View picker: "Save as my view" (private: true), 🔒 on yours, "Make
 *     my default" (my_default) and myDefaultView;
 *   - MyScreenSettings and MyScreens.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom, flushMicrotasks } from './ui-dom-setup.mjs';

let M;
let calls;
let state;

before(async () => {
  installUiDom();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  for (const r of ['registerCombobox', 'registerPredicateFilter', 'registerQuickChips', 'registerFilterPresetSelector', 'registerScreenFilterBar', 'registerCardListBody', 'registerScreenHost', 'registerMyScreenSettings', 'registerMyScreens', 'registerMyScreenPage']) {
    M[r]?.();
  }
});

const PRED = JSON.stringify({ attr: 'project', op: 'in', values: ['7'] });

beforeEach(() => {
  document.body.replaceChildren();
  calls = [];
  state = {
    screens: [
      { id: '500', title: 'Launch, active', layout: 'list', list_card_type: 'task', predicate: PRED, sort_order: 10, default_filter: '0', view_count: 1 },
      { id: '501', title: 'Threads', layout: 'grid', list_card_type: 'comm', predicate: '', sort_order: 20, default_filter: '0', view_count: 0 },
    ],
  };
});

function respond(sr) {
  const k = `${sr.endpoint}.${sr.action}`;
  const d = sr.data ?? {};
  calls.push({ k, data: d });
  if (k === 'my_screen.list') return { id: sr.id, ok: true, data: { screens: state.screens } };
  if (k === 'my_screen.set') return { id: sr.id, ok: true, data: { id: d.id ?? '502' } };
  if (k === 'my_screen.delete') return { id: sr.id, ok: true, data: { id: d.id } };
  if (k === 'card.select_with_attributes') {
    if (d.card_type_name === 'screen' && Array.isArray(d.ids)) {
      return { id: sr.id, ok: true, data: { rows: [{ id: '500', card_type_id: '9', card_type_name: 'screen', private: true, attributes: { title: 'Launch, active', layout: 'list', list_card_type: 'task', predicate: PRED, toggle_groups: '[]' } }] } };
    }
    if (d.card_type_name === 'filter' && d.parent_card_id === '500') {
      return { id: sr.id, ok: true, data: { rows: [{ id: '600', card_type_id: '10', card_type_name: 'filter', parent_card_id: '500', private: true, attributes: { title: 'Mine' } }] } };
    }
    if (d.card_type_name === 'filter') {
      return { id: sr.id, ok: true, data: { rows: [
        { id: '610', card_type_id: '10', card_type_name: 'filter', parent_card_id: '20', private: true, attributes: { title: 'My bugs' } },
        { id: '611', card_type_id: '10', card_type_name: 'filter', parent_card_id: '20', attributes: { title: 'Shared' } },
        { id: '600', card_type_id: '10', card_type_name: 'filter', parent_card_id: '500', private: true, attributes: { title: 'Mine' } },
      ] } };
    }
    if (d.card_type_name === 'screen') {
      return { id: sr.id, ok: true, data: { rows: [
        { id: '20', card_type_id: '9', card_type_name: 'screen', parent_card_id: '7', attributes: { title: 'Grid', slug: 'grid' } },
        { id: '500', card_type_id: '9', card_type_name: 'screen', private: true, attributes: { title: 'Launch, active' } },
      ] } };
    }
    if (d.card_type_name === 'project') {
      return { id: sr.id, ok: true, data: { rows: [
        { id: '7', card_type_id: '1', card_type_name: 'project', attributes: { title: 'Launch' } },
        { id: '8', card_type_id: '1', card_type_name: 'project', attributes: { title: 'Ops' } },
        { id: '10', card_type_id: '1', card_type_name: 'project', attributes: { title: 'Template', is_template: true } },
      ] } };
    }
    return { id: sr.id, ok: true, data: { rows: [] } };
  }
  if (k === 'attribute_def.select' || k === 'card_type.select' || k === 'flow.list') return { id: sr.id, ok: true, data: { rows: [] } };
  if (k === 'attribute.update') return { id: sr.id, ok: true, data: { ok: true } };
  if (k === 'card.delete') return { id: sr.id, ok: true, data: { ok: true } };
  return { id: sr.id, ok: true, data: { rows: [] } };
}

function bootApi() {
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      return { status: 200, text: JSON.stringify({ subresponses: req.subrequests.map(respond) }) };
    },
  };
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  for (const r of ['registerKanbanSpecs', 'registerAdminSpecs', 'registerFilterSpecs', 'registerCardSearchSpec', 'registerFilterCardSpecs', 'registerMyScreenSpecs', 'registerWatchSpecs']) {
    try {
      M[r]?.(api);
    } catch {
      /* a spec another set already defined */
    }
  }
  return { dispatcher, api };
}

async function settle(dispatcher) {
  for (let r = 0; r < 4; r++) {
    for (let i = 0; i < 6; i++) await dispatcher.flushNow();
    await flushMicrotasks();
  }
}

function mount(api, type, extra = {}, tree = new M.TreeNode({}, [])) {
  const c = M.Control.New(type, { type, ...extra }, { api, tree });
  c.mount(document.createElement('div'));
  document.body.appendChild(c.el);
  return { c, tree };
}

/* ------------------------------- helpers ------------------------------- */

const SCOPES = [
  { pred: '', want: { mode: 'all', projects: [] } },
  { pred: JSON.stringify({ attr: 'project', op: 'in', values: ['7', '8'] }), want: { mode: 'only', projects: ['7', '8'] } },
  { pred: JSON.stringify({ attr: 'project', op: 'not in', values: [8] }), want: { mode: 'except', projects: ['8'] } },
  { pred: JSON.stringify({ connective: 'and', children: [{ attr: 'project', op: 'in', values: ['7'] }] }), want: { mode: 'only', projects: ['7'] } },
  { pred: 'not json', want: { mode: 'all', projects: [] } },
];
for (const c of SCOPES) {
  test(`scopeFromPredicate(${c.pred.slice(0, 40)})`, () => {
    assert.deepEqual(M.scopeFromPredicate(c.pred), c.want);
  });
}

test('predicateFromScope round-trips and summaries read as text', () => {
  for (const scope of [{ mode: 'only', projects: ['7'] }, { mode: 'except', projects: ['7', '8'] }]) {
    assert.deepEqual(M.scopeFromPredicate(M.predicateFromScope(scope)), scope);
  }
  assert.equal(M.predicateFromScope({ mode: 'all', projects: ['7'] }), '');
  assert.equal(M.predicateFromScope({ mode: 'only', projects: [] }), '');
  const names = new Map([['7', 'Launch'], ['8', 'Ops']]);
  assert.equal(M.scopeSummary({ mode: 'all', projects: [] }, names), 'All projects');
  assert.equal(M.scopeSummary({ mode: 'only', projects: ['7', '8'] }, names), 'Launch, Ops');
  assert.equal(M.scopeSummary({ mode: 'except', projects: ['8'] }, names), 'All but Ops');
});

test('withScopeTree ANDs the scope in, moving flat leaves into the tree', () => {
  const scope = { attr: 'project', op: 'in', values: ['7'] };
  assert.deepEqual(M.withScopeTree(undefined, undefined, null), { where: undefined, tree: undefined });
  assert.deepEqual(M.withScopeTree([{ attr: 'title', op: 'contains', value: 'x' }], undefined, scope), {
    where: undefined,
    tree: { connective: 'and', children: [{ attr: 'title', op: 'contains', values: ['x'] }, scope] },
  });
  const tree = { connective: 'or', children: [] };
  assert.deepEqual(M.withScopeTree(undefined, tree, scope).tree, { connective: 'and', children: [tree, scope] });
});

test('myViewsOnShared lists your views on project screens, not on your own', () => {
  const filters = [
    { id: 610n, card_type_id: 10n, card_type_name: 'filter', parent_card_id: 20n, private: true, attributes: { title: 'My bugs' } },
    { id: 611n, card_type_id: 10n, card_type_name: 'filter', parent_card_id: 20n, attributes: { title: 'Shared' } },
    { id: 600n, card_type_id: 10n, card_type_name: 'filter', parent_card_id: 500n, private: true, attributes: { title: 'Mine' } },
  ];
  const screens = [
    { id: 20n, card_type_id: 9n, card_type_name: 'screen', parent_card_id: 7n, attributes: { title: 'Grid', slug: 'grid' } },
    { id: 500n, card_type_id: 9n, card_type_name: 'screen', private: true, attributes: { title: 'Mine' } },
  ];
  const got = M.myViewsOnShared(filters, screens, new Map([['7', 'Launch']]));
  assert.deepEqual(got, [{ id: '610', title: 'My bugs', screenId: '20', screenTitle: 'Grid', screenSlug: 'grid', projectId: '7', projectTitle: 'Launch' }]);
});

test('myDefaultView picks your private view marked my_default', () => {
  assert.equal(M.myDefaultView([{ id: 1n, private: true, attributes: {} }, { id: 2n, private: true, attributes: { my_default: true } }]), 2n);
  assert.equal(M.myDefaultView([{ id: 3n, attributes: { my_default: true } }]), null, "a shared view's flag is ignored");
});

/* --------------------------- personal screen --------------------------- */

test('a personal screen resolves by id and lists every project through its base filter', async () => {
  const { dispatcher, api } = bootApi();
  const { tree } = mount(api, 'ScreenHost', { screen: { slug: 'my-500', layout: 'list' }, personalScreenId: '500' });
  await settle(dispatcher);
  assert.ok(calls.some((x) => x.k === 'card.select_with_attributes' && x.data.card_type_name === 'screen' && x.data.ids?.[0] === '500'), 'the screen by id');
  assert.ok(calls.some((x) => x.k === 'card.select_with_attributes' && x.data.card_type_name === 'filter' && x.data.parent_card_id === '500'), 'its views');
  assert.deepEqual(tree.at(['screen', 'scopeTree']).peek(), { attr: 'project', op: 'in', values: ['7'] });
  assert.equal(tree.at(['screen', 'cardType']).peek(), 'task');
  const filters = tree.at(['screens', 'mine', '500', 'filters']).peek();
  assert.equal(filters.length, 1);
  const rows = calls.filter((x) => x.k === 'card.select_with_attributes' && x.data.card_type_name === 'task');
  assert.ok(rows.length > 0, 'the list fired its rows query');
  const last = rows[rows.length - 1].data;
  assert.equal(last.project_id ?? null, null, 'no project restriction');
  assert.ok(JSON.stringify(last.tree).includes('"attr":"project"'), 'the base filter rides the tree');
});

test('a project screen clears any personal base filter', async () => {
  const { dispatcher, api } = bootApi();
  const tree = new M.TreeNode({}, []);
  tree.at(['screen', 'scopeTree']).set({ attr: 'project', op: 'in', values: ['7'] });
  tree.at(['scope', 'projectId']).set(7n);
  mount(api, 'ScreenHost', { screen: { slug: 'grid', layout: 'list' } }, tree);
  await settle(dispatcher);
  assert.equal(tree.at(['screen', 'scopeTree']).peek(), null);
});

/* ------------------------------- the picker ------------------------------ */

test('the View picker marks your views and offers Save as my view / Make my default', async () => {
  const { dispatcher, api } = bootApi();
  const tree = new M.TreeNode({}, []);
  tree.at(['s', 'filters']).set([
    { id: 1n, card_type_id: 10n, card_type_name: 'filter', attributes: { title: 'Shared' } },
    { id: 2n, card_type_id: 10n, card_type_name: 'filter', private: true, attributes: { title: 'Mine' } },
  ]);
  tree.at(['s', 'activeFilterId']).set(2n);
  let mine = 0;
  const { c } = mount(api, 'FilterPresetSelector', { filtersPath: 's.filters', activeIdPath: 's.activeFilterId', onSaveMine: () => mine++ }, tree);
  await settle(dispatcher);
  // The selector's Combobox (private fields, plain properties at run time).
  const combo = c.combo;
  const labels = combo.staticOptions.map((o) => o.label);
  assert.deepEqual(labels, ['Shared', '🔒 Mine']);
  const footer = combo.footerActions.map((a) => a.label);
  assert.deepEqual(footer.slice(0, 3), ['Save current as new view…', 'Save as my view…', 'Make my default']);
  combo.footerActions.find((a) => a.label === 'Save as my view…').onRun();
  assert.equal(mine, 1);
  // On your own screen (no onSaveMine) every view is yours: no marks, one Save.
  document.body.replaceChildren();
  const own = mount(api, 'FilterPresetSelector', { filtersPath: 's.filters', activeIdPath: 's.activeFilterId' }, tree).c;
  await settle(dispatcher);
  assert.deepEqual(own.combo.staticOptions.map((o) => o.label), ['Shared', 'Mine']);
  assert.deepEqual(own.combo.footerActions.map((a) => a.label).slice(0, 2), ['Save current as new view…', 'Set as default']);
});

/* ------------------------------ settings ------------------------------ */

test('MyScreenSettings saves the name, layout, list and project scope', async () => {
  const { dispatcher, api } = bootApi();
  let saved = '';
  const { c } = mount(api, 'MyScreenSettings', { onSaved: (id) => (saved = id) });
  await settle(dispatcher);
  const title = c.el.querySelector('[data-my-screen-title]');
  title.value = 'Ops threads';
  title.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }));
  const lists = c.el.querySelector('[data-my-screen-lists]');
  lists.value = 'comm';
  lists.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }));
  const only = c.el.querySelector('[data-my-screen-scope="only"]');
  only.checked = true;
  only.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }));
  await settle(dispatcher);
  assert.equal(c.el.querySelector('[data-my-screen-project="10"]'), null, 'the template is not offered');
  // Saving with no project picked is refused on the page.
  c.el.querySelector('[data-my-screen-save]').click();
  assert.equal(calls.filter((x) => x.k === 'my_screen.set').length, 0);
  const ops = c.el.querySelector('[data-my-screen-project="8"]');
  ops.checked = true;
  ops.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }));
  c.el.querySelector('[data-my-screen-save]').click();
  await settle(dispatcher);
  const set = calls.find((x) => x.k === 'my_screen.set');
  assert.deepEqual(set.data, { title: 'Ops threads', layout: 'list', list_card_type: 'comm', predicate: JSON.stringify({ attr: 'project', op: 'in', values: ['8'] }) });
  assert.equal(saved, '502');
});

test('MyScreens lists your screens and your views on project screens; ↓ swaps the order', async () => {
  const { dispatcher, api } = bootApi();
  const { c } = mount(api, 'MyScreens');
  await settle(dispatcher);
  assert.deepEqual([...c.el.querySelectorAll('[data-my-screen]')].map((e) => e.dataset.myScreen), ['500', '501']);
  assert.match(c.el.querySelector('[data-my-screen="500"]').textContent, /List of tasks · Launch · 1 view/);
  assert.match(c.el.querySelector('[data-my-screen="501"]').textContent, /Grid of threads · All projects/);
  assert.deepEqual([...c.el.querySelectorAll('[data-my-view]')].map((e) => e.dataset.myView), ['610']);
  assert.equal(c.el.querySelector('[data-my-view="610"] a').getAttribute('href'), '/project/7/screen/grid');
  c.el.querySelector('[data-my-screen-down="500"]').click();
  await settle(dispatcher);
  const sets = calls.filter((x) => x.k === 'my_screen.set').map((x) => x.data);
  assert.deepEqual(sets, [{ id: '500', sort_order: 20 }, { id: '501', sort_order: 10 }]);
  c.el.querySelector('[data-my-view-delete="610"]').click();
  await settle(dispatcher);
  assert.ok(calls.some((x) => x.k === 'card.delete' && x.data.card_id === '610'));
});

test('the /my routes and their help topic', () => {
  assert.equal(M.matchRoute('/my/500').name, 'my_screen');
  assert.equal(M.matchRoute('/my/500').params.id, '500');
  assert.equal(M.matchRoute('/my-screens').name, 'my_screens');
  assert.equal(M.helpTopicForRoute(M.matchRoute('/my/500')), 'my_screens');
});
