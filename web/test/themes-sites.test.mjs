/**
 * Themes, a page's place in its site, and sites shown inside kitp (web half):
 *
 *   - the Themes admin screen: the RecordForm (name, base, navigation,
 *     accent, footer) and the FILES panel over a theme's built-in base —
 *     view, customize, edit + save, revert, a refused template;
 *   - PLACE IN SITE on a page: the trail, moving the page, reordering child
 *     pages, the navigation flags;
 *   - SiteView: a portal shown in kitp frames its site under a sandbox.
 *
 * Driven through the dom-shim + mock-transport harness; transports record
 * every subrequest so the wire shape (snake_case, ids as strings) is checked.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
let FakeElement;
let setPath;

before(async () => {
  ({ FakeElement, setPath } = installDomShim());
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerMasterDetail();
  M.registerRecordForm();
  M.registerThemeFiles();
  M.registerPageStructure();
  M.registerSiteView();
});

beforeEach(() => {
  setPath('/projects');
  M._resetRouterForTest?.();
});

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
  M.registerProjectSpecs(api); // + the bundle / portal / theme specs
  M.registerAdminSpecs(api);
  return { dispatcher, api };
}

async function settle(dispatcher) {
  for (let i = 0; i < 4; i++) await dispatcher.flushNow();
  M.flushSync?.();
}

const click = (el) => el.dispatchEvent({ type: 'click' });
/** `root.querySelector(outer).querySelector(inner)` — the dom shim has no
 *  descendant combinator. */
const inside = (root, outer, inner) => root.querySelector(outer).querySelector(inner);

/* -------------------------------------------------------------------------- */
/* Pure helpers.                                                               */
/* -------------------------------------------------------------------------- */

test('themeFileRows: a theme’s files over its base, by path', () => {
  const base = { key: 'sidebar', files: [
    { path: 'theme.json', isText: true, sizeBytes: 10 },
    { path: 'page.html', isText: true, sizeBytes: 900 },
    { path: 'site.css', isText: true, sizeBytes: 500 },
  ] };
  const own = [
    { path: 'site.css', sizeBytes: 520 },
    { path: 'logo.png', sizeBytes: 2048 },
    { path: 'custom.css', sizeBytes: 30 },
  ];
  assert.deepEqual(M.themeFileRows(base, own).map((r) => [r.path, r.origin, r.isText]), [
    ['custom.css', 'own', true],
    ['logo.png', 'own', false],
    ['page.html', 'base', true],
    ['site.css', 'override', true],
    ['theme.json', 'base', true],
  ]);
  assert.deepEqual(M.themeFileRows(undefined, own).map((r) => r.origin), ['own', 'own', 'own']);
});

for (const [kind, name, want] of [
  ['logo', 'Brand Mark.PNG', 'logo.png'],
  ['logo', 'mark.svg', 'logo.svg'],
  ['logo', 'mark.ico', null],
  ['favicon', 'icon.ico', 'favicon.ico'],
  ['favicon', 'icon.webp', null],
]) {
  test(`brandPath(${kind}, ${name}) → ${want}`, () => {
    assert.equal(M.brandPath(kind, name), want);
  });
}

test('themePathForUpload and bytesToBase64', () => {
  assert.equal(M.themePathForUpload('Inter Var.WOFF2'), 'inter-var.woff2');
  assert.equal(M.themePathForUpload('.hidden.css'), 'hidden.css');
  assert.equal(M.bytesToBase64(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), 'iVBORw==');
  const big = new Uint8Array(100000).fill(65);
  assert.equal(atob(M.bytesToBase64(big)).length, 100000, 'large files encode in chunks');
});

test('theme form mappers and validation', () => {
  const draft = M.themeRowToDraft({ id: 130n, title: 'Docs look', base: 'newspaper', nav: 'section', accent: '#aa0000', footer: '© Docs', portals: ['PROD', 'QA'] });
  assert.equal(draft.portals, 'PROD, QA');
  assert.deepEqual(M.themeDraftToInput({ ...draft, accent: ' #AA0000 ' }), {
    id: 130n, title: 'Docs look', base: 'newspaper', nav: 'section', accent: '#aa0000', footer: '© Docs',
  });
  assert.deepEqual(M.validateThemeDraft({ title: '', base: '', accent: 'red' }), {
    title: 'A theme needs a name.', base: 'Choose a theme to start from.', accent: 'Use a colour like #2f6bdb.',
  });
  assert.deepEqual(M.validateThemeDraft({ title: 'X', base: 'blog', accent: '' }), {});
});

test('reorderWrites renumbers siblings 10, 20, 30 and writes only what changed', () => {
  const sib = [
    { id: 1n, sort: 10 },
    { id: 2n, sort: 20 },
    { id: 3n, sort: 0 },
  ];
  assert.deepEqual(M.reorderWrites(sib, 2n, -1), [{ id: 2n, sort: 10 }, { id: 1n, sort: 20 }, { id: 3n, sort: 30 }]);
  assert.deepEqual(M.reorderWrites(sib, 1n, 1), [{ id: 2n, sort: 10 }, { id: 1n, sort: 20 }, { id: 3n, sort: 30 }]);
  assert.deepEqual(M.reorderWrites(sib, 1n, -1), [], 'already first');
  assert.deepEqual(M.reorderWrites(sib, 3n, 1), [], 'already last');
});

test('subtreeIds: a page and everything below it', () => {
  const nodes = [
    { id: 70n, parentId: 31n }, { id: 71n, parentId: 70n }, { id: 72n, parentId: 71n }, { id: 73n, parentId: 70n },
  ];
  assert.deepEqual([...M.subtreeIds(71n, nodes)].sort(), [71n, 72n]);
  assert.deepEqual([...M.subtreeIds(70n, nodes)].sort(), [70n, 71n, 72n, 73n]);
});

/* -------------------------------------------------------------------------- */
/* Themes admin screen.                                                        */
/* -------------------------------------------------------------------------- */

const BASES = [
  { key: 'sidebar', name: 'Side menu', description: 'Docs.', nav: 'full', paginate: 0, order: 'site', files: [
    { path: 'page.html', mime_type: 'text/html; charset=utf-8', size_bytes: 900, is_text: true },
    { path: 'site.css', mime_type: 'text/css; charset=utf-8', size_bytes: 500, is_text: true },
    { path: 'theme.json', mime_type: 'application/json', size_bytes: 80, is_text: true },
  ] },
  { key: 'newspaper', name: 'Newspaper', description: 'Columns.', nav: 'section', paginate: 9, order: 'newest', files: [] },
];

function themeHandlers(state) {
  const row = () => ({
    id: '130', title: 'Docs look', base: 'sidebar', base_name: 'Side menu', nav: '', accent: '', footer: '',
    files: Object.entries(state.files).map(([path, text]) => ({ path, mime_type: 'text/css', size_bytes: text.length, updated_at: '2026-11-01T00:00:00Z' })),
    portals: ['Docs (PROD)'],
  });
  return {
    'theme.list': () => ({ rows: [row()] }),
    'theme.bases': () => ({ rows: BASES }),
    'theme.base_file': (d) => ({ path: d.path, mime_type: 'text/css', size_bytes: 20, is_text: true, text: `/* built-in ${d.path} */` }),
    'theme.file_get': (d) => ({ path: d.path, mime_type: 'text/css', size_bytes: 5, is_text: true, text: state.files[d.path] }),
    'theme.file_put': (d) => {
      if (d.path === 'page.html' && d.text.includes('{{if')) {
        return { __error: { code: 'template_error', message: 'theme.file_put: page.html:1: unexpected EOF' } };
      }
      state.files[d.path] = d.text;
      state.puts.push(d);
      return { theme_id: d.theme_id, path: d.path, size_bytes: d.text.length, changed: true };
    },
    'theme.file_delete': (d) => {
      delete state.files[d.path];
      state.deletes.push(d);
      return { deleted: true };
    },
    'theme.set': (d) => {
      state.sets.push(d);
      return { id: '130', created: false, changed: true };
    },
  };
}

async function mountThemes(handlers) {
  const t = transportFor(handlers);
  const { dispatcher, api } = bootApi(t.transport);
  const tree = new M.TreeNode({}, []);
  const ctx = { api, tree, scope: { get projectId() { return null; } } };
  const ctrl = M.Control.New('MasterDetail', M.adminScreenConfig('themes'), ctx);
  ctrl.mount(new FakeElement('div'));
  await settle(dispatcher);
  click(ctrl.el.querySelectorAll('[data-md-row]')[0]);
  M.flushSync?.();
  await settle(dispatcher);
  return { t, dispatcher, ctrl, tree };
}

test('Themes admin: the form edits settings and saves through theme.set', async () => {
  const state = { files: {}, puts: [], deletes: [], sets: [] };
  const { dispatcher, ctrl } = await mountThemes(themeHandlers(state));
  const field = (name) => ctrl.el.querySelector(`[data-record-form-field="${name}"]`);
  assert.match(ctrl.el.querySelector('[data-md-row]').textContent, /Side menu · used by Docs \(PROD\)/);
  assert.equal(field('title').value, 'Docs look');
  assert.deepEqual(field('base').querySelectorAll('option').map((o) => o.textContent), ['—', 'Side menu', 'Newspaper']);
  assert.equal(field('base').value, 'sidebar');
  assert.match(field('portals').textContent, /Docs \(PROD\)/);

  field('base').value = 'newspaper';
  field('base').dispatchEvent({ type: 'change' });
  field('nav').value = 'collapsible';
  field('nav').dispatchEvent({ type: 'change' });
  field('accent').value = '#0F766E';
  field('accent').dispatchEvent({ type: 'input' });
  field('footer').value = '© Docs';
  field('footer').dispatchEvent({ type: 'input' });
  click(ctrl.el.querySelector('[data-record-form-save]'));
  await settle(dispatcher);
  assert.deepEqual(state.sets, [{ id: '130', title: 'Docs look', base: 'newspaper', nav: 'collapsible', accent: '#0f766e', footer: '© Docs' }]);
});

test('Themes admin: FILES lists the base’s files; Customize copies one, Save edits it, Revert drops it', async () => {
  const state = { files: {}, puts: [], deletes: [], sets: [] };
  const { dispatcher, ctrl } = await mountThemes(themeHandlers(state));
  const files = () => ctrl.el.querySelectorAll('[data-theme-file]').map((r) => `${r.dataset.themeFile}:${r.dataset.origin}`);
  assert.deepEqual(files(), ['page.html:base', 'site.css:base', 'theme.json:base']);
  assert.match(ctrl.el.querySelector('[data-theme-files-intro]').textContent, /Starts from Side menu/);

  // View a built-in file: read-only.
  click(inside(ctrl.el, '[data-theme-file="site.css"]', '[data-theme-action="view"]'));
  await settle(dispatcher);
  let editor = ctrl.el.querySelector('[data-theme-editor]');
  assert.equal(editor.value, '/* built-in site.css */');
  assert.equal(editor.readOnly, true);
  assert.equal(ctrl.el.querySelector('[data-theme-action="save"]'), null, 'no Save on a built-in file');

  // Customize: the copy becomes the theme's own, open for editing.
  click(inside(ctrl.el, '[data-theme-file="site.css"]', '[data-theme-action="customize"]'));
  await settle(dispatcher);
  assert.deepEqual(state.puts.at(-1), { theme_id: '130', path: 'site.css', text: '/* built-in site.css */' });
  assert.deepEqual(files(), ['page.html:base', 'site.css:override', 'theme.json:base']);
  editor = ctrl.el.querySelector('[data-theme-editor]');
  assert.equal(editor.readOnly, false);
  editor.value = 'body { color: teal; }';
  editor.dispatchEvent({ type: 'input' });
  click(ctrl.el.querySelector('[data-theme-action="save"]'));
  await settle(dispatcher);
  assert.equal(state.files['site.css'], 'body { color: teal; }');

  // Revert: the built-in file applies again.
  click(inside(ctrl.el, '[data-theme-file="site.css"]', '[data-theme-action="revert"]'));
  await settle(dispatcher);
  assert.deepEqual(state.deletes, [{ theme_id: '130', path: 'site.css' }]);
  assert.deepEqual(files(), ['page.html:base', 'site.css:base', 'theme.json:base']);
});

test('Themes admin: a template the server refuses shows its file and line; New file starts an empty one', async () => {
  const state = { files: { 'page.html': '<p>ok</p>' }, puts: [], deletes: [], sets: [] };
  const { dispatcher, ctrl } = await mountThemes(themeHandlers(state));
  click(inside(ctrl.el, '[data-theme-file="page.html"]', '[data-theme-action="edit"]'));
  await settle(dispatcher);
  const editor = ctrl.el.querySelector('[data-theme-editor]');
  assert.equal(editor.value, '<p>ok</p>');
  editor.value = '<p>{{if .Page.Title}}</p>';
  editor.dispatchEvent({ type: 'input' });
  click(ctrl.el.querySelector('[data-theme-action="save"]'));
  await settle(dispatcher);
  assert.equal(ctrl.el.querySelector('[data-theme-editor-error]').textContent, 'page.html:1: unexpected EOF');
  assert.equal(state.files['page.html'], '<p>ok</p>', 'the refused template was not saved');
  assert.equal(ctrl.el.querySelector('[data-theme-editor]').value, '<p>{{if .Page.Title}}</p>', 'the draft is kept to fix');

  const name = ctrl.el.querySelector('[data-theme-new-path]');
  name.value = 'custom.css';
  click(ctrl.el.querySelector('[data-theme-action="new"]'));
  await settle(dispatcher);
  assert.deepEqual(state.puts.at(-1), { theme_id: '130', path: 'custom.css', text: '' });
  assert.equal(ctrl.el.querySelector('[data-theme-open]').dataset.themeOpen, 'custom.css');
});

/* -------------------------------------------------------------------------- */
/* PLACE IN SITE.                                                              */
/* -------------------------------------------------------------------------- */

function pageRows(state) {
  const page = (id, parent, title, extra = {}) => ({
    id, card_type_id: '20', card_type_name: 'page', parent_card_id: parent, attributes: { title, ...extra },
  });
  return [
    page('70', state.parents['70'] ?? '31', 'Home'),
    page('71', state.parents['71'] ?? '70', 'Guide', { sort_order: 10, nav_hidden: state.navHidden === true }),
    page('72', '71', 'Install', { sort_order: 20 }),
    page('73', '71', 'Upgrade', { sort_order: 10, nav_hidden: true }),
    page('74', '70', 'FAQ', { sort_order: 20 }),
    page('90', '32', 'Other project'),
  ];
}

async function mountStructure(state, pageId = '71') {
  const t = transportFor({
    'card.select_with_attributes': () => ({ rows: pageRows(state) }),
    'card.move': (d) => {
      state.moves.push(d);
      state.parents[d.card_id] = d.new_parent_card_id;
      return { ok: true, activity_id: '1' };
    },
    'attribute.update': (d) => {
      state.updates.push(d);
      if (d.attribute_name === 'nav_hidden') state.navHidden = d.value;
      return { ok: true, activity_id: '2' };
    },
  });
  const { dispatcher, api } = bootApi(t.transport);
  const tree = new M.TreeNode({}, []);
  M.installRouter(tree);
  let changed = 0;
  const ctrl = M.Control.New('PageStructure', { type: 'PageStructure', pageId, onChanged: () => { changed++; } }, { api, tree });
  ctrl.mount(new FakeElement('div'));
  await settle(dispatcher);
  return { ctrl, dispatcher, changed: () => changed };
}

test('PLACE IN SITE: the trail, the parent picker (never the page’s own subtree), child pages in site order', async () => {
  const state = { parents: {}, moves: [], updates: [] };
  const { ctrl } = await mountStructure(state);
  assert.deepEqual(ctrl.el.querySelector('[data-page-trail]').querySelectorAll('li').map((li) => li.textContent), ['Home', 'Guide']);
  const select = ctrl.el.querySelector('[data-page-parent]');
  assert.equal(select.value, '70');
  assert.deepEqual(
    select.querySelectorAll('option').map((o) => `${o.value}:${o.textContent}`),
    ['31:Top of the project', '70:Home', '74:Home › FAQ'],
  );
  const kids = ctrl.el.querySelectorAll('[data-page-child-row]');
  assert.deepEqual(kids.map((k) => k.dataset.pageChildRow), ['73', '72'], 'Upgrade (10) before Install (20)');
  assert.match(kids[0].textContent, /hidden from navigation/);
  assert.equal(kids[0].querySelector('[data-page-move="up"]').disabled, true);
  assert.equal(kids[1].querySelector('[data-page-move="down"]').disabled, true);
});

test('PLACE IN SITE: moving, reordering and the navigation flags write and refresh', async () => {
  const state = { parents: {}, moves: [], updates: [] };
  const { ctrl, dispatcher, changed } = await mountStructure(state);

  const select = ctrl.el.querySelector('[data-page-parent]');
  select.value = '74';
  select.dispatchEvent({ type: 'change' });
  await settle(dispatcher);
  assert.deepEqual(state.moves, [{ card_id: '71', new_parent_card_id: '74' }]);
  assert.equal(ctrl.el.querySelector('[data-page-parent]').value, '74', 'reloaded after the move');
  assert.equal(changed(), 1);

  click(inside(ctrl.el, '[data-page-child-row="72"]', '[data-page-move="up"]'));
  await settle(dispatcher);
  assert.deepEqual(state.updates.map((u) => [u.card_id, u.attribute_name, u.value]), [['72', 'sort_order', 10], ['73', 'sort_order', 20]]);

  const flag = ctrl.el.querySelector('[data-page-flag="nav_hidden"]');
  assert.equal(flag.checked, false);
  flag.checked = true;
  flag.dispatchEvent({ type: 'change' });
  await settle(dispatcher);
  assert.deepEqual(state.updates.at(-1), { card_id: '71', attribute_name: 'nav_hidden', value: true });
  assert.equal(ctrl.el.querySelector('[data-page-flag="nav_hidden"]').checked, true);
  assert.equal(changed(), 3);
});

/* -------------------------------------------------------------------------- */
/* Sites in kitp.                                                              */
/* -------------------------------------------------------------------------- */

async function mountSite(rows, portalId = '120') {
  const t = transportFor({ 'portal.list': () => ({ rows }) });
  const { dispatcher, api } = bootApi(t.transport);
  const tree = new M.TreeNode({}, []);
  const ctrl = M.Control.New('SiteView', { type: 'SiteView', portalId }, { api, tree });
  ctrl.mount(new FakeElement('div'));
  await settle(dispatcher);
  return ctrl;
}

const PORTAL = { id: '120', title: 'Handbook', host: '', public: false, internal: true, theme_id: '0', theme_title: '', page_count: 3, built_at: '2026-11-01T00:00:00Z', statuses: [], warnings: [] };

test('SiteView frames a portal shown in kitp, sandboxed, with an Open in new tab link', async () => {
  const ctrl = await mountSite([PORTAL]);
  const frame = ctrl.el.querySelector('[data-site-frame]');
  assert.equal(frame.src, '/api/v1/portal/120/site/');
  // allow-same-origin: the site's own requests must carry the (SameSite=Lax)
  // session cookie; no allow-scripts, so nothing in it can use that origin.
  assert.equal(frame.getAttribute('sandbox'), 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  assert.match(ctrl.el.textContent, /Handbook/);
  assert.match(ctrl.el.textContent, /3 pages/);
  assert.equal(ctrl.el.querySelector('[data-site-open]').href, '/api/v1/portal/120/site/');
});

test('SiteView: a portal not shown in kitp (or unknown) says so', async () => {
  for (const rows of [[{ ...PORTAL, internal: false }], []]) {
    const ctrl = await mountSite(rows);
    assert.equal(ctrl.el.querySelector('[data-site-frame]'), null);
    assert.match(ctrl.el.querySelector('[data-site-message]').textContent, /isn’t shown in kitp/);
  }
});

test('the /site/:id route', () => {
  assert.deepEqual(M.matchRoute('/site/120'), { name: 'site', params: { id: '120' }, path: '/site/120' });
  assert.equal(M.siteRouteUrl(120n), '/site/120');
});

test('pictureSnippets: a page’s attached images as Insert-menu entries', () => {
  assert.deepEqual(M.pictureSnippets([{ id: 12n, filename: 'Q3 [draft].png' }]), [{
    group: 'Pictures',
    label: 'Q3 [draft].png',
    text: '![Q3 \\[draft\\].png](/api/v1/attachment/12/view)',
    hint: '',
    description: 'Attached to this page; published with it',
  }]);
  assert.equal(M.detailProfile('page').insertPictures, true);
  assert.equal(M.detailProfile('task').insertPictures, false);
});
