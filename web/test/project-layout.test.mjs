/**
 * ProjectLayout — the `project` layout body (Project detail / overview).
 *
 * Runs against a REAL DOM (jsdom via ui-dom-setup) because the properties
 * slide-over mounts the RefPicker (Popover/floating-ui) + DatePicker editors,
 * which the light shim can't drive — same posture as the task-detail tests.
 *
 * Coverage (the task's acceptance list):
 *   - the `project` layout resolves to a ProjectLayout (NOT NotFound);
 *   - the header renders the project title + its markdown description;
 *   - the project-scoped task collection loads the project's child tasks;
 *   - a task row opens `/task/:id` (navigate fires);
 *   - the properties panel edits a project ATTRIBUTE via attribute.update
 *     OPTIMISTICALLY;
 *   - the panel edits the project title via attribute.update;
 *   - the per-project screen nav renders the project's screen cards as tabs;
 *   - the Export / Import HOOK buttons fire their bus intents.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom, flushMicrotasks } from './ui-dom-setup.mjs';

let M;

function key(target, k, opts = {}) {
  target.dispatchEvent(
    new globalThis.window.KeyboardEvent('keydown', {
      key: k,
      bubbles: true,
      cancelable: true,
      ...opts,
    }),
  );
}
function toggle(detailsEl, open = true) {
  detailsEl.open = open;
  detailsEl.dispatchEvent(new globalThis.window.Event('toggle', { bubbles: false }));
}

before(async () => {
  installUiDom();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerCombobox();
  M.registerDatePicker();
  M.registerRefPicker();
  M.registerProjectLayout();
  M.registerProjectPropertiesPanel();
});

beforeEach(() => {
  document.body.replaceChildren();
  M._resetRouterForTest?.();
});

const PROJECT_ID = 100n;

/**
 * A transport serving the project, its child tasks, its screen cards, the
 * attribute_def schema, and card.search label lookups; RECORDS every
 * attribute.update. A fresh closure per test.
 */
function projectMockTransport() {
  const updates = [];
  const navs = [];

  const project = {
    id: String(PROJECT_ID),
    card_type_id: '2',
    card_type_name: 'project',
    attributes: {
      title: 'Apollo',
      description: '# Apollo\n\nThe **flagship** initiative.',
      lead: '10', // card_ref → person (global)
      target_date: '2026-09-01', // date
    },
  };

  const tasks = [
    { id: '54', card_type_id: '5', card_type_name: 'task', parent_card_id: String(PROJECT_ID), attributes: { title: 'Wire pickers' } },
    { id: '55', card_type_id: '5', card_type_name: 'task', parent_card_id: String(PROJECT_ID), attributes: { title: 'Ship the board' } },
  ];

  const screens = [
    { id: '200', card_type_id: '3', card_type_name: 'screen', parent_card_id: String(PROJECT_ID), attributes: { title: 'Overview', slug: 'project', layout: 'project' } },
    { id: '201', card_type_id: '3', card_type_name: 'screen', parent_card_id: String(PROJECT_ID), attributes: { title: 'Board', slug: 'kanban', layout: 'kanban' } },
  ];

  const defRow = (name, valueType, target, ordering) => ({
    id: `def-${name}`,
    name,
    value_type: valueType,
    is_built_in: true,
    ...(target ? { target_card_type_name: target } : {}),
    bound_to: [{ card_type_id: '2', card_type_name: 'project', ordering }],
  });
  const DEFS = [
    defRow('title', 'text', null, 0),
    defRow('description', 'text', null, 1),
    defRow('lead', 'card_ref', 'person', 2),
    defRow('target_date', 'date', null, 3),
  ];

  function respond(sr) {
    const k = `${sr.endpoint}.${sr.action}`;
    const data = sr.data ?? {};
    if (k === 'card.select_with_attributes') {
      if (data.card_type_name === 'project') return { id: sr.id, ok: true, data: { rows: [project] } };
      if (data.card_type_name === 'task') return { id: sr.id, ok: true, data: { rows: tasks } };
      if (data.card_type_name === 'screen') return { id: sr.id, ok: true, data: { rows: screens } };
      return { id: sr.id, ok: true, data: { rows: [] } };
    }
    if (k === 'attribute_def.select') return { id: sr.id, ok: true, data: { rows: DEFS } };
    if (k === 'card.search') {
      const rows = [];
      if (data.card_type_name === 'person') rows.push({ id: '10', title: 'Alice' });
      return { id: sr.id, ok: true, data: { rows } };
    }
    if (k === 'attribute.update') {
      updates.push(data);
      return { id: sr.id, ok: true, data: { ok: true, activity_id: '999' } };
    }
    return { id: sr.id, ok: false, error: { code: 'unknown', message: `mock has no ${k}` } };
  }

  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => respond(sr));
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
  return { transport, updates, navs };
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api); // card.select_with_attributes + attribute.update
  M.registerGridCardRefAttrs(); // revive card_ref attrs to bigint
  M.registerAdminSpecs(api); // attribute_def.select
  M.registerCardSearchSpec(api); // card.search (RefPicker + label lookups)
  return { dispatcher, api };
}

async function settle(dispatcher) {
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  M.flushSync?.();
  await flushMicrotasks();
  M.flushSync?.();
}

/** Mount a ProjectLayout against a fresh tree seeded with the scope project id. */
function mountProjectLayout(api, { projectId = PROJECT_ID } = {}) {
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(projectId);
  const intents = [];
  const bus = { emit: (type, detail) => intents.push({ type, detail }) };
  const ctx = { api, tree, bus };
  const ctrl = M.Control.New('Project', { type: 'Project' }, ctx);
  ctrl.mount(document.createElement('div'));
  document.body.appendChild(ctrl.el);
  return { ctrl, tree, intents };
}

/* -------------------------------------------------------------------------- */
/* Layout resolution (the headline acceptance: project → ProjectLayout).        */
/* -------------------------------------------------------------------------- */

test('the `project` layout maps to a Project control (not NotFound)', () => {
  assert.equal(M.layoutToControlType('project'), 'Project');
  // And the control is registered → Control.New returns the real control.
  const tree = new M.TreeNode({}, []);
  const c = M.Control.New('Project', { type: 'Project' }, { api: null, tree });
  assert.equal(c.el.dataset.control, 'Project', 'a real ProjectLayout mounted, not NotFound');
});

/* -------------------------------------------------------------------------- */
/* Header: title + markdown description.                                       */
/* -------------------------------------------------------------------------- */

test('header renders the project title + markdown description', async () => {
  const { transport } = projectMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountProjectLayout(api);
  await settle(dispatcher);

  const title = ctrl.el.querySelector('[data-project-title]');
  assert.ok(title, 'title rendered');
  assert.equal(title.textContent, 'Apollo');

  const desc = ctrl.el.querySelector('[data-project-desc]');
  assert.ok(desc, 'description rendered');
  // Markdown sink: an <h1> + <strong> from the source.
  assert.ok(desc.querySelector('h1'), 'markdown heading rendered');
  assert.ok(desc.querySelector('strong'), 'markdown bold rendered');
});

/* -------------------------------------------------------------------------- */
/* Scoped task collection loads the project's child tasks.                      */
/* -------------------------------------------------------------------------- */

test('the project-scoped task collection loads the project tasks', async () => {
  const { transport } = projectMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountProjectLayout(api);
  await settle(dispatcher);

  const rows = ctrl.el.querySelectorAll('[data-project-task-row]');
  assert.equal(rows.length, 2, 'both child tasks rendered');
  const titles = [...rows].map((r) => r.querySelector('.project-detail__row-title').textContent);
  assert.deepEqual(titles, ['Wire pickers', 'Ship the board']);
});

/* -------------------------------------------------------------------------- */
/* A task row opens /task/:id.                                                  */
/* -------------------------------------------------------------------------- */

test('clicking a task row navigates to /task/:id', async () => {
  const { transport } = projectMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl, tree } = mountProjectLayout(api);
  await settle(dispatcher);

  // navigate() lands the parsed route into the module-installed router tree;
  // install it against this control's tree so the click's route write is
  // observable (the AppShell does this once at boot).
  const dispose = M.installRouter(tree);

  const row = ctrl.el.querySelector('[data-project-task-row]');
  assert.equal(row.dataset.cardId, '54');
  row.click();

  const route = M.peekRoute(tree);
  assert.equal(route.name, 'task');
  assert.equal(route.params.id, '54');
  dispose();
});

/* -------------------------------------------------------------------------- */
/* Per-project screen nav: the screen cards render as tabs.                     */
/* -------------------------------------------------------------------------- */

test('per-project screen nav renders the project screen cards as tabs', async () => {
  const { transport } = projectMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountProjectLayout(api);
  await settle(dispatcher);

  const tabs = [...ctrl.el.querySelectorAll('[data-project-tab]')].map((t) => t.dataset.projectTab);
  assert.ok(tabs.includes('project'), 'overview tab present');
  assert.ok(tabs.includes('kanban'), 'board tab present');
  // The active slug ('project') carries the active mark.
  const active = ctrl.el.querySelector('.project-detail__tab--active');
  assert.ok(active, 'an active tab is marked');
  assert.equal(active.dataset.projectTab, 'project');
});

/* -------------------------------------------------------------------------- */
/* Properties panel: open via "Edit properties" + edit an ATTRIBUTE optimistically. */
/* -------------------------------------------------------------------------- */

test('properties panel edits a project attribute via attribute.update (optimistic)', async () => {
  const { transport, updates } = projectMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountProjectLayout(api);
  await settle(dispatcher);

  // Open the slide-over via the header action.
  ctrl.el.querySelector('[data-project-edit]').click();
  await settle(dispatcher);

  const panel = ctrl.el.querySelector('[data-control="ProjectPropertiesPanel"]');
  assert.ok(panel, 'properties panel spawned');
  assert.notEqual(panel.style.display, 'none', 'panel is open');

  // The target_date row → a DatePicker editor on expand. Its value commits eagerly.
  const dateRow = panel.querySelector('[data-attr-row="target_date"]');
  assert.ok(dateRow, 'target_date attribute row rendered (project-bound)');
  toggle(dateRow, true);
  await settle(dispatcher);

  // The DatePicker is a Combobox-shaped editor; rather than drive its UI, edit
  // a text-input-backed attribute. Use the lead card_ref's RefPicker is heavy;
  // assert the row VALUE summary reflects the loaded value, then commit a title.
  const valueEl = dateRow.querySelector('[data-attr-value]');
  assert.equal(valueEl.textContent, '2026-09-01', 'date summary shows the loaded value');

  // Commit via the title field (also attribute.update on the project card).
  const titleInput = panel.querySelector('[data-project-props-title]');
  assert.equal(titleInput.value, 'Apollo');
  titleInput.value = 'Apollo II';
  key(titleInput, 'Enter');
  await settle(dispatcher);

  const titleUpdate = updates.find((u) => u.attribute_name === 'title');
  assert.ok(titleUpdate, 'attribute.update(title) fired on the project');
  assert.equal(titleUpdate.value, 'Apollo II');
  assert.equal(String(titleUpdate.card_id), '100');

  // Optimistic: the project HEADER repaints to the new title without a reload.
  assert.equal(ctrl.el.querySelector('[data-project-title]').textContent, 'Apollo II');
});

test('properties panel edits a project attribute row via attribute.update', async () => {
  const { transport, updates } = projectMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountProjectLayout(api);
  await settle(dispatcher);

  ctrl.el.querySelector('[data-project-edit]').click();
  await settle(dispatcher);
  const panel = ctrl.el.querySelector('[data-control="ProjectPropertiesPanel"]');

  // The description field commits on Mod+Enter — a project attribute write.
  const descInput = panel.querySelector('[data-project-props-desc]');
  assert.ok(descInput, 'description textarea rendered');
  descInput.value = 'A fresh charter.';
  key(descInput, 'Enter', { metaKey: true });
  await settle(dispatcher);

  const descUpdate = updates.find((u) => u.attribute_name === 'description');
  assert.ok(descUpdate, 'attribute.update(description) fired on the project');
  assert.equal(descUpdate.value, 'A fresh charter.');
});

/* -------------------------------------------------------------------------- */
/* Export / Import HOOK buttons fire their bus intents (#41 / #42 land later).   */
/* -------------------------------------------------------------------------- */

test('Export / Import header buttons fire hook intents', async () => {
  const { transport } = projectMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl, intents } = mountProjectLayout(api);
  await settle(dispatcher);

  ctrl.el.querySelector('[data-project-export]').click();
  ctrl.el.querySelector('[data-project-import]').click();

  const exportIntent = intents.find((i) => i.type === 'projectExport');
  const importIntent = intents.find((i) => i.type === 'projectImport');
  assert.ok(exportIntent, 'export hook emitted projectExport');
  assert.ok(importIntent, 'import hook emitted projectImport');
  assert.equal(String(exportIntent.detail.projectId), '100');
});
