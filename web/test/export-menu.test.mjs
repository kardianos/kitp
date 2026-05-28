/**
 * ExportMenu (#42) — the project-export dropdown.
 *
 * Drives the menu on a REAL DOM (jsdom) — it opens a Popover (floating-ui) and
 * triggers same-origin downloads. The download mechanisms are STUBBED so no
 * real navigation / network fires and the built URL can be asserted directly.
 *
 * Coverage:
 *   - exportNavUrl builds the correct route + query params per format + toggle;
 *   - the CSV "Export" action triggers a hidden-anchor nav download with that
 *     exact URL (stubbed navDownload);
 *   - the xlsx / zip "Export" actions fetch a blob from that URL (stubbed
 *     fetch) and trigger an object-URL save-as;
 *   - the predicate rides the URL as a `tree=` query param;
 *   - the toggle checkboxes flip the params; attachments/activity only render
 *     for ZIP;
 *   - the menu opens from the project Export hook (the projectExport intent
 *     wired by the AppShell + raised by the ProjectLayout's Export button).
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom, flushMicrotasks } from './ui-dom-setup.mjs';

let M;

const PROJECT_ID = 31n;

before(async () => {
  installUiDom();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerExportMenu();
  M.registerProjectLayout();
  M.registerProjectPropertiesPanel();
  M.registerAppShell();
  M.registerScreenHost();
  M.registerScreenFilterBar();
  M.registerKanbanControls();
  M.registerAccountPage();
});

beforeEach(() => {
  document.body.replaceChildren();
  M._resetRouterForTest?.();
});

function click(el) {
  el.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}
function change(el) {
  el.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }));
}

/** Mount a bare ExportMenu with stubbed download sinks; return handles. */
function mountMenu(config = {}) {
  const tree = new M.TreeNode({}, []);
  const ctx = { api: null, tree };
  const navUrls = [];
  const blobUrls = [];
  const fetched = [];

  const xm = M.Control.New(
    'ExportMenu',
    {
      type: 'ExportMenu',
      navDownload: (url) => navUrls.push(url),
      blobDeps: {
        fetchImpl: async (url) => {
          fetched.push(url);
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: { get: () => 'attachment; filename="project-demo-31.zip"' },
            async blob() {
              return new globalThis.Blob(['x'], { type: 'application/zip' });
            },
            async text() {
              return '';
            },
          };
        },
        createObjectUrl: (b) => {
          const u = `blob:fake/${blobUrls.length}`;
          blobUrls.push({ url: u, blob: b });
          return u;
        },
        revokeObjectUrl: () => {},
      },
      ...config,
    },
    ctx,
  );
  xm.mount(document.body);
  return { xm, tree, navUrls, blobUrls, fetched };
}

/** The Popover panel appended to <body>. */
function panel() {
  return document.body.querySelector('[data-export-menu]');
}

/** Open the menu anchored to a fresh button. */
async function openMenu(xm, detail = {}) {
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  xm.open({ projectId: PROJECT_ID, anchor, ...detail });
  await flushMicrotasks();
  return anchor;
}

/** Click the format radio for `fmt`, then click Export. */
function chooseFormat(fmt) {
  const radio = panel().querySelector(`[data-export-format="${fmt}"] input`);
  radio.checked = true;
  change(radio);
}

/* -------------------------------------------------------------------------- */
/* Pure URL builder.                                                          */
/* -------------------------------------------------------------------------- */

test('exportNavUrl builds the route + query params per format/toggle', () => {
  const off = M.defaultToggles();

  // Bare URLs (no toggles) — no query string.
  assert.equal(M.exportNavUrl(31n, 'csv', off), '/api/v1/project/31/export.csv');
  assert.equal(M.exportNavUrl(31n, 'xlsx', off), '/api/v1/project/31/export.xlsx');
  assert.equal(M.exportNavUrl(31n, 'zip', off), '/api/v1/project/31/export.zip');

  // include_deleted applies to every format.
  assert.equal(
    M.exportNavUrl(31n, 'csv', { ...off, includeDeleted: true }),
    '/api/v1/project/31/export.csv?include_deleted=1',
  );

  // attachments + activity are ZIP-only.
  assert.equal(
    M.exportNavUrl(31n, 'zip', {
      includeDeleted: true,
      includeAttachments: true,
      includeActivity: true,
    }),
    '/api/v1/project/31/export.zip?include_deleted=1&include_attachments=1&include_activity=1',
  );
  // On a CSV URL the zip-only toggles are dropped (the route ignores them).
  assert.equal(
    M.exportNavUrl(31n, 'csv', {
      includeDeleted: false,
      includeAttachments: true,
      includeActivity: true,
    }),
    '/api/v1/project/31/export.csv',
  );

  // apiBase prefixes the path.
  assert.equal(
    M.exportNavUrl(31n, 'csv', off, 'http://x'),
    'http://x/api/v1/project/31/export.csv',
  );
});

test('fallbackFilename + formatExtension', () => {
  assert.equal(M.formatExtension('xlsx'), 'xlsx');
  assert.equal(M.fallbackFilename(31n, 'zip'), 'project-31.zip');
});

test('parseAttachmentFilename pulls the quoted name', () => {
  assert.equal(
    M.parseAttachmentFilename('attachment; filename="project-demo-31.csv"'),
    'project-demo-31.csv',
  );
  assert.equal(M.parseAttachmentFilename(null), null);
});

/* -------------------------------------------------------------------------- */
/* CSV: nav-anchor download with the right URL.                               */
/* -------------------------------------------------------------------------- */

test('CSV Export triggers a nav download with the route URL', async () => {
  const { xm, navUrls } = mountMenu();
  await openMenu(xm);

  click(panel().querySelector('[data-export-run]'));

  assert.equal(navUrls.length, 1, 'one nav download fired');
  assert.equal(navUrls[0], '/api/v1/project/31/export.csv', 'default = CSV, no toggles');
  assert.equal(xm.isOpen(), false, 'menu closed after CSV export');
});

test('CSV Export with include_deleted toggle adds the param', async () => {
  const { xm, navUrls } = mountMenu();
  await openMenu(xm);

  const del = panel().querySelector('[data-export-toggle="includeDeleted"] input');
  del.checked = true;
  change(del);
  click(panel().querySelector('[data-export-run]'));

  assert.equal(navUrls[0], '/api/v1/project/31/export.csv?include_deleted=1');
});

/* -------------------------------------------------------------------------- */
/* xlsx / zip: blob fetch download.                                           */
/* -------------------------------------------------------------------------- */

test('Excel Export fetches the .xlsx route as a blob', async () => {
  const { xm, fetched, navUrls } = mountMenu();
  await openMenu(xm);

  chooseFormat('xlsx');
  click(panel().querySelector('[data-export-run]'));
  await flushMicrotasks();

  assert.equal(navUrls.length, 0, 'xlsx does NOT use the nav-anchor path');
  assert.equal(fetched.length, 1, 'one blob fetch fired');
  assert.equal(fetched[0], '/api/v1/project/31/export.xlsx');
});

test('ZIP Export with attachments + activity toggles builds the full URL', async () => {
  const { xm, fetched } = mountMenu();
  await openMenu(xm);

  chooseFormat('zip');
  // ZIP reveals the attachment + activity toggles.
  const att = panel().querySelector('[data-export-toggle="includeAttachments"] input');
  const act = panel().querySelector('[data-export-toggle="includeActivity"] input');
  assert.ok(att, 'attachments toggle present for ZIP');
  assert.ok(act, 'activity toggle present for ZIP');
  att.checked = true;
  change(att);
  act.checked = true;
  change(act);

  click(panel().querySelector('[data-export-run]'));
  await flushMicrotasks();

  assert.equal(
    fetched[0],
    '/api/v1/project/31/export.zip?include_attachments=1&include_activity=1',
  );
});

test('attachments + activity toggles are hidden for CSV', async () => {
  const { xm } = mountMenu();
  await openMenu(xm);

  // Default format is CSV — only the deleted toggle shows.
  assert.ok(panel().querySelector('[data-export-toggle="includeDeleted"]'), 'deleted shown');
  assert.equal(
    panel().querySelector('[data-export-toggle="includeAttachments"]'),
    null,
    'attachments hidden for CSV',
  );
  assert.equal(
    panel().querySelector('[data-export-toggle="includeActivity"]'),
    null,
    'activity hidden for CSV',
  );
});

/* -------------------------------------------------------------------------- */
/* Predicate rides the tree= param.                                           */
/* -------------------------------------------------------------------------- */

test('the active predicate is sent as a tree= query param', async () => {
  const { xm, navUrls } = mountMenu();
  const predicate = M.leaf('status', 'eq', ['done']);
  await openMenu(xm, { predicate });

  click(panel().querySelector('[data-export-run]'));

  const url = navUrls[0];
  assert.ok(url.includes('tree='), 'tree param present');
  const tree = JSON.parse(decodeURIComponent(url.split('tree=')[1]));
  assert.equal(tree.attr, 'status', 'tree carries the predicate leaf');
});

/* -------------------------------------------------------------------------- */
/* Opens from the Project detail Export hook (the projectExport intent).      */
/* -------------------------------------------------------------------------- */

test('the AppShell wires projectExport → ExportMenu.open()', async () => {
  const tree = new M.TreeNode({}, []);
  // The AppShell fires a static `projects` query on mount; a stub api that
  // never lands rows is enough (the export menu wiring is what we assert).
  const ctx = { api: { callByName: () => {} }, tree };
  M.installRouter(tree);

  const navUrls = [];
  const shell = M.Control.New(
    'AppShell',
    {
      type: 'AppShell',
      boardConfig: { type: 'ScreenHost', screen: { slug: 'kanban', layout: 'kanban' } },
      exportMenuConfig: { type: 'ExportMenu', navDownload: (u) => navUrls.push(u) },
    },
    ctx,
  );
  shell.mount(document.body);

  const hosts = shell.el.querySelectorAll('[data-control="ExportMenu"]');
  assert.equal(hosts.length, 1, 'the AppShell mounted ONE ExportMenu');

  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  shell.intent('projectExport', { projectId: PROJECT_ID, anchor });
  await flushMicrotasks();

  assert.ok(panel(), 'projectExport opened the menu (popover panel in <body>)');

  // And the menu actually exports through the wired sink.
  click(panel().querySelector('[data-export-run]'));
  assert.equal(navUrls[0], '/api/v1/project/31/export.csv');

  // projectExportClose tears it down.
  shell.intent('projectExport', { projectId: PROJECT_ID, anchor });
  await flushMicrotasks();
  shell.intent('projectExportClose');
  assert.equal(panel(), null, 'projectExportClose closed the menu');
});

test("the ProjectLayout Export button raises projectExport with the anchor", async () => {
  let captured = null;
  const tree = new M.TreeNode({}, []);
  // Seed the scope leaf the ProjectLayout reads (child leaves default to
  // undefined; set the path explicitly).
  tree.at(['scope', 'projectId']).set(PROJECT_ID);
  const bus = { emit: (type, detail) => (type === 'projectExport' ? (captured = detail) : null) };
  const ctx = {
    api: { callByName: () => {} }, // ProjectLayout fires loads on mount; swallow them.
    tree,
    bus,
  };

  const layout = M.Control.New('Project', { type: 'Project' }, ctx);
  layout.mount(document.body);

  const exportBtn = layout.el.querySelector('[data-project-export]');
  assert.ok(exportBtn, 'Export button rendered');
  assert.equal(exportBtn.getAttribute('aria-haspopup'), 'menu');

  click(exportBtn);
  assert.ok(captured, 'projectExport intent emitted');
  assert.equal(captured.projectId, PROJECT_ID, 'carries the in-scope project id');
  assert.equal(captured.anchor, exportBtn, 'carries the Export button as the popover anchor');
});

test('AppShell user chip expands a menu → Account navigates to /account (#21)', async () => {
  const tree = new M.TreeNode({}, []);
  const ctx = { api: { callByName: () => {} }, tree };
  M.installRouter(tree);
  const shell = M.Control.New(
    'AppShell',
    { type: 'AppShell', boardConfig: { type: 'ScreenHost', screen: { slug: 'kanban', layout: 'kanban' } } },
    ctx,
  );
  shell.mount(document.body);

  // The menu is hidden until the chip is clicked; it then exposes Account + Logout.
  const chip = shell.el.querySelector('[data-user-chip]');
  assert.ok(chip, 'the user chip is a button');
  const menu = shell.el.querySelector('[data-user-menu]');
  assert.equal(menu.style.display, 'none', 'menu hidden at rest');
  chip.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.notEqual(menu.style.display, 'none', 'chip click opens the menu');
  assert.ok(shell.el.querySelector('[data-user-menu-account]'), 'Account item present');
  assert.ok(shell.el.querySelector('[data-user-menu-logout]'), 'Logout item present');

  // Account navigates to /account; the outlet renders the AccountPage.
  shell.el.querySelector('[data-user-menu-account]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flushMicrotasks();
  assert.equal(tree.at(['router', 'route']).peek().name, 'account', 'navigated to the account route');
  assert.ok(shell.el.querySelector('[data-control="AccountPage"]'), 'the account page rendered');
});
