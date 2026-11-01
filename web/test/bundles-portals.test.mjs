/**
 * Feature bundles + portals (web half): the new-project dialog's presets, the
 * project properties FEATURES section, the `pages` layout config + page route,
 * the detail profiles, the Portals admin screen (RecordForm with Rebuild /
 * Preview actions) and the Values screen's publishes_to picker.
 *
 * Driven through the dom-shim + mock-transport harness the other control tests
 * use; every transport records the subrequests it saw so a test can assert the
 * wire shape (snake_case, ids as strings).
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
let FakeElement;
let setPath;
/** Configs the stub RefPicker was spawned with (Values screen test). */
const pickerConfigs = [];

before(async () => {
  ({ FakeElement, setPath } = installDomShim());
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerProjectList();
  M.registerProjectPropertiesPanel();
  M.registerMasterDetail();
  M.registerRecordForm();
  M.registerEnumManager();
  M.registerPagePublications();
  M.registerNewPageButton();
  // A stub RefPicker that records its config: the Values screen spawns one per
  // card_ref attribute of a value row (a status's publishes_to).
  class StubPicker extends M.Control {
    createRoot() {
      const el = document.createElement('span');
      el.dataset.control = 'RefPicker';
      return el;
    }
    render() {
      pickerConfigs.push(this.config);
    }
  }
  M.Control.register('RefPicker', StubPicker);
});

beforeEach(() => {
  setPath('/projects');
  M._resetRouterForTest?.();
});

/** A transport answering from a key → (data) => result map; records every
 *  subrequest. Unknown keys answer unknown_handler. */
function transportFor(handlers) {
  const sent = [];
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => {
        sent.push(sr);
        const key = `${sr.endpoint}.${sr.action}`;
        const h = handlers[key];
        if (h === undefined) return { id: sr.id, ok: false, error: { code: 'unknown_handler', message: key } };
        const out = h(sr.data ?? {});
        if (out && out.__error) return { id: sr.id, ok: false, error: out.__error };
        return { id: sr.id, ok: true, data: out };
      });
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
  return { transport, sent, of: (key) => sent.filter((s) => `${s.endpoint}.${s.action}` === key) };
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api);
  M.registerProjectSpecs(api); // + the bundle / portal specs
  M.registerAdminSpecs(api);
  M.registerFilterCardSpecs(api);
  M.registerCardSearchSpec(api);
  return { dispatcher, api };
}

async function settle(dispatcher) {
  for (let i = 0; i < 4; i++) await dispatcher.flushNow();
  M.flushSync?.();
}

const CATALOG = {
  features: [
    { key: 'tracker', title: 'Task tracking', doc: 'Tasks + flow.', sort: 10, enabled: false, conflict: '' },
    { key: 'conversations', title: 'Conversations', doc: 'Email threads.', sort: 20, enabled: false, conflict: '' },
    { key: 'publishing', title: 'Publishing', doc: 'Pages + portals.', sort: 30, enabled: false, conflict: '' },
  ],
  presets: [
    { key: 'issue_tracker', title: 'Issue tracker', doc: 'Tasks.', sort: 10, features: ['tracker'] },
    { key: 'content', title: 'Content management', doc: 'Tasks and pages.', sort: 30, features: ['tracker', 'publishing'] },
  ],
};

/* -------------------------------------------------------------------------- */
/* Specs + pure helpers.                                                       */
/* -------------------------------------------------------------------------- */

test('previewUrl maps a build file path to the preview route', () => {
  assert.equal(M.previewUrl(5n, 'guide/index.html'), '/api/v1/portal/5/preview/guide/');
  assert.equal(M.previewUrl(5n, 'index.html'), '/api/v1/portal/5/preview/');
  assert.equal(M.previewUrl(5n), '/api/v1/portal/5/preview/');
  assert.equal(M.previewUrl(5n, 'a/b/index.html'), '/api/v1/portal/5/preview/a/b/');
});

test('decoders read the wire rows (ids → bigint, missing fields defaulted)', () => {
  const row = M.decodePortalRow({ id: '120', title: 'QA', public: false, root_page_id: '700', statuses: ['Docs › In review'], page_count: 3, dirty: true });
  assert.equal(row.id, 120n);
  assert.equal(row.rootPageId, 700n);
  assert.equal(row.public, false);
  assert.equal(row.dirty, true);
  assert.deepEqual(row.statuses, ['Docs › In review']);
  assert.equal(row.host, '');
  const pub = M.decodePublication({ portal_id: '9', portal_title: 'PROD', current: false, path: 'index.html' });
  assert.equal(pub.portalId, 9n);
  assert.equal(pub.current, false);
  const f = M.decodeFeature({ key: 'publishing', enabled: true });
  assert.equal(f.enabled, true);
  assert.equal(f.conflict, '');
});

test('preset choices: composeChoice reads the preset key off a "Start from" value', () => {
  assert.equal(M.composeChoice('preset:content'), 'content');
  assert.equal(M.composeChoice('42'), null);
  assert.equal(M.composeChoice(''), null);
  assert.equal(M.composeChoice('preset:'), null);
  assert.deepEqual(M.BUNDLE_SOURCE_EXCLUSION_LEAF, { attr: 'bundle_key', op: 'not exists' });
});

/* -------------------------------------------------------------------------- */
/* New-project dialog: presets → project.compose; templates hide bundle sources */
/* -------------------------------------------------------------------------- */

function mountProjectList(api) {
  const tree = new M.TreeNode({}, []);
  tree.at(['shell', 'projects']).set([{ id: '31', label: 'Default Project' }]);
  tree.at(['scope', 'projectId']).set(null);
  const scope = { get projectId() { return tree.at(['scope', 'projectId']).peek() ?? null; } };
  const ctrl = M.Control.New('ProjectList', { type: 'ProjectList' }, { api, tree, scope });
  ctrl.mount(new FakeElement('div'));
  return { ctrl, tree };
}

function projectHandlers() {
  return {
    'card.select_with_attributes': () => ({ rows: [{ id: '10', card_type_id: '1', card_type_name: 'project', attributes: { title: 'Standard Project Template', is_template: true } }] }),
    'bundle.list': () => CATALOG,
    'project.compose': () => ({ new_project_id: '601', features: ['tracker', 'publishing', 'conversations'] }),
    'card.insert': () => ({ id: '500' }),
  };
}

test('templates query excludes feature-bundle sources (bundle_key not exists)', async () => {
  const t = transportFor(projectHandlers());
  const { dispatcher, api } = bootApi(t.transport);
  mountProjectList(api);
  await settle(dispatcher);
  const reads = t.of('card.select_with_attributes');
  assert.equal(reads.length, 1, 'one templates read');
  const where = reads[0].data.where;
  assert.ok(where.some((l) => l.attr === 'is_template' && l.op === '=' && l.value === true), 'selects templates');
  assert.ok(where.some((l) => l.attr === 'bundle_key' && l.op === 'not exists'), 'and leaves out bundle sources');
});

test('new-project dialog: a preset creates the project through project.compose with ticked extras', async () => {
  const t = transportFor(projectHandlers());
  const { dispatcher, api } = bootApi(t.transport);
  const { ctrl, tree } = mountProjectList(api);
  await settle(dispatcher);

  // The catalog landed; the "Start from" select offers the presets + templates.
  assert.equal(tree.at(['projects', 'bundles']).peek().presets.length, 2);
  ctrl.el.querySelector('[data-new-project]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  const sel = ctrl.el.querySelector('[data-qe-template]');
  const values = sel.querySelectorAll('option').map((o) => o.value);
  assert.deepEqual(values, ['', 'preset:issue_tracker', 'preset:content', '10']);

  // Pick the content preset: its doc shows, and the one feature it lacks is
  // offered as an extra.
  sel.value = 'preset:content';
  sel.dispatchEvent({ type: 'change' });
  const extras = ctrl.el.querySelectorAll('[data-qe-feature]');
  assert.deepEqual(extras.map((e) => e.value), ['conversations']);
  assert.match(ctrl.el.querySelector('[data-qe-preset-doc]').textContent, /Tasks and pages/);
  extras[0].checked = true;

  const title = ctrl.el.querySelector('[data-qe-title]');
  title.value = 'Docs';
  ctrl.el.querySelector('[data-qe-add-close]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);

  const composes = t.of('project.compose');
  assert.equal(composes.length, 1, 'one project.compose');
  assert.deepEqual(composes[0].data, { name: 'Docs', preset: 'content', features: ['conversations'] });
  assert.equal(t.of('card.insert').length, 0, 'no card.insert for a preset');
  assert.equal(t.of('project.stamp').length, 0, 'no project.stamp for a preset');
  // The optimistic row was promoted to the composed project's id.
  const rows = tree.at(['shell', 'projects']).peek();
  assert.ok(rows.some((r) => r.id === '601' && r.label === 'Docs'), 'new project row carries the server id');
});

test('new-project dialog: "Create as template" hides the presets', async () => {
  const t = transportFor(projectHandlers());
  const { dispatcher, api } = bootApi(t.transport);
  const { ctrl } = mountProjectList(api);
  await settle(dispatcher);
  ctrl.el.querySelector('[data-new-project]').dispatchEvent({ type: 'click' });
  const isTmpl = ctrl.el.querySelector('[data-qe-is-template]');
  isTmpl.checked = true;
  isTmpl.dispatchEvent({ type: 'change' });
  const values = ctrl.el.querySelector('[data-qe-template]').querySelectorAll('option').map((o) => o.value);
  assert.deepEqual(values, ['', '10'], 'only the blank choice + templates');
});

test('new-project dialog: an older server without bundle.list keeps the template paths', async () => {
  const h = projectHandlers();
  delete h['bundle.list'];
  const t = transportFor(h);
  const { dispatcher, api } = bootApi(t.transport);
  const { ctrl, tree } = mountProjectList(api);
  await settle(dispatcher);
  assert.deepEqual(tree.at(['projects', 'bundles']).peek(), { presets: [], features: [] });
  ctrl.el.querySelector('[data-new-project]').dispatchEvent({ type: 'click' });
  const values = ctrl.el.querySelector('[data-qe-template]').querySelectorAll('option').map((o) => o.value);
  assert.deepEqual(values, ['', '10']);
});

/* -------------------------------------------------------------------------- */
/* Project properties: FEATURES section.                                       */
/* -------------------------------------------------------------------------- */

test('properties panel FEATURES: enabled marked, conflict disabled, Add applies + refreshes nav', async () => {
  let applied = false;
  const t = transportFor({
    'card.select_with_attributes': () => ({ rows: [{ id: '31', card_type_id: '1', card_type_name: 'project', attributes: { title: 'Legacy' } }] }),
    'attribute_def.select': () => ({ rows: [] }),
    'bundle.list': (d) => {
      assert.equal(d.project_id, '31', 'bundle.list is scoped to the project');
      return {
        presets: [],
        features: [
          { key: 'tracker', title: 'Task tracking', doc: 'Tasks.', sort: 10, enabled: false, conflict: 'This project already has its own status flow.' },
          { key: 'conversations', title: 'Conversations', doc: 'Email.', sort: 20, enabled: true, conflict: '' },
          { key: 'publishing', title: 'Publishing', doc: 'Pages.', sort: 30, enabled: applied, conflict: '' },
        ],
      };
    },
    'bundle.apply': (d) => {
      applied = true;
      return { results: [{ key: d.keys[0], status: 'applied', copied: 7, existing: 0, message: '' }] };
    },
  });
  const { dispatcher, api } = bootApi(t.transport);
  const tree = new M.TreeNode({}, []);
  const saved = [];
  const panel = M.Control.New('ProjectPropertiesPanel', { type: 'ProjectPropertiesPanel', onSaved: (p) => saved.push(p) }, { api, tree });
  panel.mount(new FakeElement('div'));
  panel.open(31n);
  await settle(dispatcher);

  const row = (key) => panel.el.querySelector(`[data-feature="${key}"]`);
  assert.ok(row('conversations').querySelector('[data-feature-enabled]'), 'enabled feature is marked');
  const trackerAdd = row('tracker').querySelector('[data-feature-add]');
  assert.equal(trackerAdd.disabled, true, 'a conflicting feature cannot be added');
  assert.match(row('tracker').textContent, /already has its own status flow/);

  row('publishing').querySelector('[data-feature-add]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  const applies = t.of('bundle.apply');
  assert.equal(applies.length, 1);
  assert.deepEqual(applies[0].data, { project_id: '31', keys: ['publishing'] });
  assert.equal(tree.at(['shell', 'navRefresh']).peek(), 1, 'nav refresh nonce bumped so new screens appear');
  assert.equal(saved.length, 1, 'host notified');
  assert.ok(row('publishing').querySelector('[data-feature-enabled]'), 'the list reloaded: publishing is now on');
});

test('properties panel FEATURES: a failed apply shows the server message inline', async () => {
  const t = transportFor({
    'card.select_with_attributes': () => ({ rows: [{ id: '31', card_type_id: '1', card_type_name: 'project', attributes: { title: 'P' } }] }),
    'attribute_def.select': () => ({ rows: [] }),
    'bundle.list': () => ({ presets: [], features: [{ key: 'publishing', title: 'Publishing', doc: '', sort: 1, enabled: false, conflict: '' }] }),
    'bundle.apply': () => ({ __error: { code: 'bundle_conflict', message: 'Publishing can’t be added: this project already has its own publish_status flow' } }),
  });
  const { dispatcher, api } = bootApi(t.transport);
  const tree = new M.TreeNode({}, []);
  const panel = M.Control.New('ProjectPropertiesPanel', { type: 'ProjectPropertiesPanel' }, { api, tree });
  panel.mount(new FakeElement('div'));
  panel.open(31n);
  await settle(dispatcher);
  const add = panel.el.querySelector('[data-feature-add="publishing"]');
  add.dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  const err = panel.el.querySelector('[data-feature="publishing"]').querySelector('[data-feature-error]');
  assert.equal(err.style.display, '');
  assert.match(err.textContent, /already has its own publish_status flow/);
  assert.equal(add.disabled, false, 'the button is usable again');
});

/* -------------------------------------------------------------------------- */
/* Pages layout + page route + detail profiles.                                */
/* -------------------------------------------------------------------------- */

test('pages layout: CardListBody, opens the page route, "+ New page" view action', () => {
  assert.equal(M.layoutToControlType('pages'), 'CardListBody');
  const cfg = M.bodyConfigForLayout('pages');
  assert.equal(cfg.openRoute, 'page');
  assert.equal(cfg.parentChipCardType, 'page');
  assert.equal(cfg.parentChipKnownOnly, true);
  assert.deepEqual(cfg.order[0], { field: 'attributes.sort_order', direction: 'ASC' });
  assert.deepEqual(M.viewActionsForLayout('pages'), [{ type: 'NewPageButton' }]);
  // Other layouts keep opening tasks (no openRoute → default 'task').
  assert.equal(M.bodyConfigForLayout('comms').openRoute, undefined);
});

test('page route: /page/:id matches and card urls follow the configured route', () => {
  assert.equal(M.matchRoute('/page/71').name, 'page');
  assert.equal(M.matchRoute('/page/71').params.id, '71');
  assert.equal(M.pageUrl(71n), '/page/71');
  assert.equal(M.cardUrl('71', 'page'), '/page/71');
  assert.equal(M.cardUrl('54'), '/task/54');
  assert.equal(M.helpTopicForRoute(M.matchRoute('/page/71')), 'task_detail');
});

test('detail profiles: pages use publish_status, no task-only sections, editable order', () => {
  const page = M.detailProfile('page');
  assert.equal(page.noun, 'Page');
  assert.equal(page.statusAttr, 'publish_status');
  assert.deepEqual([...page.sections].sort(), ['attachments', 'comments', 'publications']);
  assert.ok(page.skipAttrs.includes('publish_status'));
  assert.ok(page.showAttrs.includes('sort_order'));
  assert.equal(page.commRedirect, false);
  const task = M.detailProfile('task');
  assert.ok(task.sections.includes('comms') && !task.sections.includes('publications'));
  assert.equal(M.detailProfile('unknown_type'), task, 'unknown types fall back to the task profile');
});

test('enclosingProjectId walks page parents up to the project', () => {
  const pages = new Map([
    [70n, { id: 70n, parent_card_id: 31n }],
    [71n, { id: 71n, parent_card_id: 70n }],
    [72n, { id: 72n, parent_card_id: 71n }],
  ]);
  assert.equal(M.enclosingProjectId(pages.get(72n), pages), 31n);
  assert.equal(M.enclosingProjectId(pages.get(70n), pages), 31n);
  assert.equal(M.enclosingProjectId({ id: 5n }, pages), undefined);
  // A parent cycle stops at the cap instead of spinning.
  const cyc = new Map([[1n, { id: 1n, parent_card_id: 2n }], [2n, { id: 2n, parent_card_id: 1n }]]);
  assert.equal(M.enclosingProjectId(cyc.get(1n), cyc), undefined);
});

test('NewPageButton creates an untitled page under the active project and opens it', async () => {
  const t = transportFor({ 'card.insert': () => ({ id: '880' }) });
  const { dispatcher, api } = bootApi(t.transport);
  const tree = new M.TreeNode({}, []);
  M.installRouter(tree);
  tree.at(['scope', 'projectId']).set(31n);
  const btn = M.Control.New('NewPageButton', { type: 'NewPageButton' }, { api, tree });
  btn.mount(new FakeElement('div'));
  btn.el.dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  const ins = t.of('card.insert');
  assert.equal(ins.length, 1);
  assert.deepEqual(ins[0].data, { card_type_name: 'page', parent_card_id: '31', title: 'Untitled page' });
  assert.equal(M.peekRoute(tree)?.path ?? M.currentRoute?.(tree)?.path, '/page/880');
});

/* -------------------------------------------------------------------------- */
/* PUBLISHED ON section.                                                       */
/* -------------------------------------------------------------------------- */

test('PagePublications lists portals with current / stale state and preview links', async () => {
  const t = transportFor({
    'page.publications': (d) => {
      assert.equal(d.page_id, '71');
      return {
        rows: [
          { portal_id: '120', portal_title: 'Docs (PROD)', host: 'docs.example.com', public: true, published_at: '2026-06-01T10:00:00Z', published_by: 'Ada', current: false, path: 'getting-started/index.html' },
          { portal_id: '121', portal_title: 'Docs (QA)', host: '', public: false, published_at: '2026-06-02T10:00:00Z', published_by: 'Ada', current: true, path: '' },
        ],
      };
    },
    'card.insert': () => ({ id: '881' }),
  });
  const { dispatcher, api } = bootApi(t.transport);
  const tree = new M.TreeNode({}, []);
  M.installRouter(tree);
  const ctrl = M.Control.New('PagePublications', { type: 'PagePublications', pageId: '71' }, { api, tree });
  ctrl.mount(new FakeElement('div'));
  await settle(dispatcher);

  const rows = ctrl.el.querySelectorAll('[data-page-pub]');
  assert.equal(rows.length, 2);
  const prod = ctrl.el.querySelector('[data-page-pub="120"]');
  assert.equal(prod.querySelector('[data-page-pub-state]').dataset.pagePubState, 'stale');
  assert.match(prod.textContent, /docs\.example\.com/);
  assert.equal(prod.querySelector('[data-page-pub-preview]').href, '/api/v1/portal/120/preview/getting-started/');
  const qa = ctrl.el.querySelector('[data-page-pub="121"]');
  assert.equal(qa.querySelector('[data-page-pub-state]').dataset.pagePubState, 'current');
  assert.match(qa.textContent, /Preview only/);
  assert.match(qa.querySelector('[data-page-pub-preview]').textContent, /building/);

  // "+ Child page" creates a page under THIS page.
  ctrl.el.querySelector('[data-page-child]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  assert.deepEqual(t.of('card.insert')[0].data, { card_type_name: 'page', parent_card_id: '71', title: 'Untitled page' });
});

test('PagePublications: an unpublished page says how to publish it', async () => {
  const t = transportFor({ 'page.publications': () => ({ rows: [] }) });
  const { dispatcher, api } = bootApi(t.transport);
  const ctrl = M.Control.New('PagePublications', { type: 'PagePublications', pageId: '71' }, { api, tree: new M.TreeNode({}, []) });
  ctrl.mount(new FakeElement('div'));
  await settle(dispatcher);
  assert.match(ctrl.el.querySelector('[data-page-pubs-empty]').textContent, /Not published/);
});

/* -------------------------------------------------------------------------- */
/* Portals admin screen.                                                       */
/* -------------------------------------------------------------------------- */

function portalHandlers(state) {
  return {
    'portal.list': () => ({ rows: state.rows }),
    'portal.set': (d) => {
      state.sets.push(d);
      if (d.id === undefined) {
        state.rows = [...state.rows, { id: '130', title: d.title, host: d.host, public: d.public, root_page_id: String(d.root_page_id ?? '0'), root_title: '', statuses: [], page_count: 0, built_at: '', warnings: [], dirty: true, last_error: '' }];
        return { id: '130', created: true, changed: true };
      }
      return { id: d.id, created: false, changed: true };
    },
    'portal.rebuild': (d) => {
      state.rebuilds.push(d);
      state.rows = state.rows.map((r) => (r.id === d.id ? { ...r, dirty: true } : r));
      return { queued: true };
    },
    'card.select_with_attributes': () => ({ rows: [{ id: '700', card_type_id: '20', card_type_name: 'page', parent_card_id: '31', attributes: { title: 'Home' } }] }),
  };
}

function mountPortals(api) {
  const tree = new M.TreeNode({}, []);
  const ctx = { api, tree, scope: { get projectId() { return null; } } };
  const ctrl = M.Control.New('MasterDetail', M.adminScreenConfig('portals'), ctx);
  ctrl.mount(new FakeElement('div'));
  return { ctrl, tree };
}

async function selectFirst(ctrl, dispatcher) {
  const rows = ctrl.el.querySelectorAll('[data-md-row]').filter((r) => r.style.display !== 'none');
  rows[0].dispatchEvent({ type: 'click' });
  M.flushSync?.();
  await settle(dispatcher);
}

test('Portals admin: lists portals, shows build state, saves through portal.set', async () => {
  const state = {
    sets: [], rebuilds: [],
    rows: [{ id: '120', title: 'Docs (PROD)', host: 'docs.example.com', public: true, root_page_id: '700', root_title: 'Home', root_project_id: '31', statuses: ['Docs › Published'], page_count: 4, built_at: '2026-06-01T00:00:00Z', active_build_id: '9', warnings: ['"Orphan" isn\'t reachable'], dirty: false, last_error: '' }],
  };
  const t = transportFor(portalHandlers(state));
  const { dispatcher, api } = bootApi(t.transport);
  const { ctrl, tree } = mountPortals(api);
  await settle(dispatcher);
  assert.equal(tree.at(['admin', 'portals', 'items']).peek().length, 1, 'portal row listed');
  await selectFirst(ctrl, dispatcher);

  const field = (name) => ctrl.el.querySelector(`[data-record-form-field="${name}"]`);
  assert.equal(field('title').value, 'Docs (PROD)');
  assert.equal(field('host').value, 'docs.example.com');
  assert.equal(field('public').checked, true);
  assert.equal(field('rootPageId').value, '700');
  assert.match(field('statuses').textContent, /Docs › Published/);
  assert.match(field('build').textContent, /4 pages · built/);
  assert.match(field('warnings').textContent, /Orphan/);
  assert.equal(ctrl.el.querySelector('[data-record-form-field-wrap="lastError"]'), null, 'no last-error row when the build is fine');

  // Edit + save → portal.set with every field (ids as strings on the wire).
  field('host').value = 'Docs.Example.org';
  field('host').dispatchEvent({ type: 'input' });
  field('public').checked = false;
  field('public').dispatchEvent({ type: 'change' });
  ctrl.el.querySelector('[data-record-form-save]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  assert.equal(state.sets.length, 1);
  assert.deepEqual(state.sets[0], { id: '120', title: 'Docs (PROD)', host: 'docs.example.org', public: false, root_page_id: '700' });
});

test('Portals admin: Rebuild queues a build and reloads; Preview links to the preview route', async () => {
  const state = {
    sets: [], rebuilds: [],
    rows: [{ id: '120', title: 'Docs (QA)', host: '', public: false, root_page_id: '700', root_title: 'Home', statuses: [], page_count: 0, built_at: '', warnings: [], dirty: false, last_error: 'render "Home": boom' }],
  };
  const t = transportFor(portalHandlers(state));
  const { dispatcher, api } = bootApi(t.transport);
  const { ctrl, tree } = mountPortals(api);
  await settle(dispatcher);
  await selectFirst(ctrl, dispatcher);

  assert.match(ctrl.el.querySelector('[data-record-form-field="lastError"]').textContent, /boom/);
  assert.match(ctrl.el.querySelector('[data-record-form-field="statuses"]').textContent, /No status publishes here yet/);
  assert.match(ctrl.el.querySelector('[data-record-form-field="build"]').textContent, /Not built yet/);
  const preview = ctrl.el.querySelector('[data-record-form-action="Preview"]');
  assert.equal(preview.href, '/api/v1/portal/120/preview/');
  assert.equal(preview.target, '_blank');

  ctrl.el.querySelector('[data-record-form-action="Rebuild"]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  assert.deepEqual(state.rebuilds, [{ id: '120' }]);
  assert.equal(tree.at(['admin', 'portals', 'items']).peek()[0].raw.dirty, true, 'list reloaded after the rebuild');
});

test('Portals admin: + New portal creates without an id and requires a title', async () => {
  const state = { sets: [], rebuilds: [], rows: [] };
  const t = transportFor(portalHandlers(state));
  const { dispatcher, api } = bootApi(t.transport);
  const { ctrl, tree } = mountPortals(api);
  await settle(dispatcher);
  ctrl.el.querySelector('[data-record-form-new]').dispatchEvent({ type: 'click' });
  assert.equal(ctrl.el.querySelector('[data-record-form-action="Rebuild"]'), null, 'no actions on an unsaved portal');
  await settle(dispatcher); // the root-page options land (and re-render the form)
  ctrl.el.querySelector('[data-record-form-save]').dispatchEvent({ type: 'click' });
  assert.match(ctrl.el.querySelector('[data-record-form-error]').textContent, /needs a title/);
  await settle(dispatcher);
  assert.equal(state.sets.length, 0, 'blank title blocked client-side');

  const title = ctrl.el.querySelector('[data-record-form-field="title"]');
  title.value = 'Docs (PROD)';
  title.dispatchEvent({ type: 'input' });
  ctrl.el.querySelector('[data-record-form-save]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  assert.equal(state.sets.length, 1);
  assert.equal('id' in state.sets[0], false, 'create sends no id');
  assert.deepEqual(state.sets[0], { title: 'Docs (PROD)', host: '', public: false, root_page_id: '0' });
  assert.equal(tree.at(['admin', 'portals', 'items']).peek().length, 1, 'new portal listed after save');
});

test('portal form mappers round-trip a row', () => {
  const draft = M.portalRowToDraft({ id: 120n, title: 'PROD', host: 'docs.example.com', public: true, rootPageId: 0n, statuses: [], warnings: [], builtAt: '', pageCount: 0, dirty: true, lastError: '' });
  assert.equal(draft.id, '120');
  assert.equal(draft.rootPageId, '', 'unset root → blank select');
  assert.match(draft.build, /Not built yet · rebuild pending/);
  const input = M.portalDraftToInput({ ...draft, rootPageId: '700' });
  assert.deepEqual(input, { id: 120n, title: 'PROD', host: 'docs.example.com', public: true, rootPageId: 700n });
});

/* -------------------------------------------------------------------------- */
/* Values screen: a status's publishes_to picker.                              */
/* -------------------------------------------------------------------------- */

test('Values: status rows get a publishes_to portal picker that writes attribute.update', async () => {
  pickerConfigs.length = 0;
  const t = transportFor({
    'attribute_def.select': () => ({
      rows: [
        { id: 'd1', name: 'status', value_type: 'card_ref', is_built_in: true, enum_managed: true, target_card_type_name: 'status', bound_to: [{ card_type_id: '5', card_type_name: 'task', is_required: true }] },
        { id: 'd2', name: 'publishes_to', value_type: 'card_ref[]', is_built_in: true, enum_managed: false, target_card_type_name: 'portal', bound_to: [{ card_type_id: '6', card_type_name: 'status', is_required: false }] },
      ],
    }),
    'card_type.select': () => ({ rows: [{ id: '6', name: 'status', uses_phase: true }] }),
    'card.select_with_attributes': (d) =>
      d.card_type_name === 'status'
        ? { rows: [
            { id: '61', card_type_id: '6', card_type_name: 'status', parent_card_id: '31', phase: 'active', attributes: { title: 'Published', publishes_to: ['120', '121'] } },
            { id: '60', card_type_id: '6', card_type_name: 'status', parent_card_id: '31', phase: 'triage', attributes: { title: 'Draft' } },
          ] }
        : { rows: [] },
    'card.search': (d) => ({ rows: d.card_type_name === 'portal' ? [{ id: '120', title: 'PROD' }, { id: '121', title: 'QA' }] : [] }),
    'attribute.update': () => ({ ok: true, activity_id: '1' }),
  });
  const { dispatcher, api } = bootApi(t.transport);
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(31n);
  const ctrl = M.Control.New('EnumManager', { type: 'EnumManager' }, { api, tree });
  ctrl.mount(new FakeElement('div'));
  await settle(dispatcher);

  const latest = new Map();
  for (const c of pickerConfigs) latest.set(c['aria-label'], c);
  const published = latest.get('Publishes to for Published');
  assert.ok(published, 'the Published status row carries a picker');
  assert.equal(published.cardType, 'portal');
  assert.equal(published.multi, true);
  assert.equal(published.parentScopePath, undefined, 'portals are global: no project scope');
  assert.deepEqual(published.values, [120n, 121n]);
  assert.deepEqual(published.currentLabels, { 120: 'PROD', 121: 'QA' }, 'chip labels resolved through card.search');
  assert.deepEqual(latest.get('Publishes to for Draft').values, []);

  published.onChangeMulti([120n]);
  await settle(dispatcher);
  const ups = t.of('attribute.update');
  assert.equal(ups.length, 1);
  assert.equal(ups[0].data.card_id, '61');
  assert.equal(ups[0].data.attribute_name, 'publishes_to');
  assert.deepEqual(ups[0].data.value.map(String), ['120']);
});
