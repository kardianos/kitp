import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
let FakeElement;

before(async () => {
  ({ FakeElement } = installDomShim());
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  // Register the real screen controls once (Control.register throws on dup).
  M.registerScreenFilterBar();
  M.registerScreenHost();
  M.registerKanbanControls();
  M.registerAppShell();
  M.registerProjectList();
});

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api);
  M.registerProjectSpecs(api);
  return { dispatcher, api };
}

/**
 * The list renders via the recycling virtualList: a FIXED pool of row nodes is
 * content-swapped, so `[data-project-row]` matches every pooled node (visible
 * AND parked). The VISIBLE window is the pool nodes the list is showing — those
 * whose `display` is not 'none'. Tests assert on this visible window + the
 * data-* hooks, never a node-per-item count of the whole pool.
 */
function visibleProjectRows(root) {
  return root
    .querySelectorAll('[data-project-row]')
    .filter((r) => r.style.display !== 'none');
}

async function settle(dispatcher) {
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  M.flushSync?.();
}

/** Build a ProjectList against a fresh tree, seeding the shared shell.projects
 *  path (the AppShell `projects` query lands rows here; the list reads it). */
function mountProjectList(api, seedProjects) {
  const tree = new M.TreeNode({}, []);
  if (seedProjects) tree.at(['shell', 'projects']).set(seedProjects);
  tree.at(['scope', 'projectId']).set(null);
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const ctx = { api, tree, scope };
  const ctrl = M.Control.New('ProjectList', { type: 'ProjectList' }, ctx);
  ctrl.mount(new FakeElement('div'));
  return { ctrl, tree };
}

const SEED = [
  { id: '31', label: 'Default Project' },
  { id: '42', label: 'Mobile App' },
];

/* -------------------------------------------------------------------------- */
/* projects-data reuse: the AppShell projects query lands shell.projects, and  */
/* the ProjectList reads the SAME path (no second fetch).                      */
/* -------------------------------------------------------------------------- */

test('AppShell projects query lands shell.projects; ProjectList renders rows from it', async () => {
  const { dispatcher, api } = bootApi(M.mockTransport());
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(null);
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const ctx = { api, tree, scope };

  // AppShell with the board lazily configured; lands on the projects view.
  const shell = M.Control.New(
    'AppShell',
    {
      type: 'AppShell',
      view: 'projects',
      defaultProjectLabel: 'Default Project',
      boardConfig: { type: 'ScreenHost', screen: { slug: 'kanban', layout: 'kanban' } },
    },
    ctx,
  );
  shell.mount(new FakeElement('div'));

  await settle(dispatcher); // AppShell `projects` query resolves (mock: 1 project)

  const landed = tree.at(['shell', 'projects']).peek();
  assert.ok(Array.isArray(landed) && landed.length >= 1, 'projects landed at shell.projects');
  assert.equal(landed[0].label, 'Default Project');

  // The ProjectList mounted in the outlet renders a row per landed project.
  const lists = shell.el.findByControl('ProjectList');
  assert.equal(lists.length, 1, 'ProjectList is the landing view');
  const rows = visibleProjectRows(shell.el);
  assert.equal(rows.length, 1, 'one row for the one landed project');
  assert.match(rows[0].textContent, /Default Project/);
  assert.match(rows[0].textContent, /open tasks: —/, 'dash placeholder for open count');
});

/* -------------------------------------------------------------------------- */
/* ProjectList renders rows + search filters them.                             */
/* -------------------------------------------------------------------------- */

test('ProjectList rows render through the recycling virtualList (spacer + pooled rows)', () => {
  const { api } = bootApi(M.mockTransport());
  const { ctrl } = mountProjectList(api, SEED);

  const list = ctrl.el.querySelector('[data-projects-list]');
  assert.ok(list, 'the list scroll viewport is present');
  const spacer = list.querySelectorAll('[data-role]').find((e) => e.dataset.role === 'vlist-spacer');
  assert.ok(spacer, 'virtualList sizing spacer mounted in the list');
  const content = list.querySelectorAll('[data-role]').find((e) => e.dataset.role === 'vlist-content');
  assert.ok(content, 'virtualList content layer mounted in the list');
  // The row nodes are the recycling pool; exactly two visible for the two seeds.
  const pool = ctrl.el.querySelectorAll('[data-project-row]');
  assert.ok(pool.length >= 2, 'a pool of recycled row nodes exists');
  assert.equal(visibleProjectRows(ctrl.el).length, 2, 'two visible rows (rest of the pool parked)');
});

test('ProjectList renders a row per project and search filters the list', () => {
  const { api } = bootApi(M.mockTransport());
  const { ctrl, tree } = mountProjectList(api, SEED);

  let rows = visibleProjectRows(ctrl.el);
  assert.equal(rows.length, 2, 'both seeded projects render');
  assert.deepEqual(
    rows.map((r) => r.dataset.projectId),
    ['31', '42'],
  );

  // Type into the search field → list filters by title substring.
  const search = ctrl.el.querySelector('[data-projects-search]');
  search.value = 'mobile';
  search.dispatchEvent({ type: 'input', target: search });
  M.flushSync?.();

  rows = visibleProjectRows(ctrl.el);
  assert.equal(rows.length, 1, 'search narrows to the matching project');
  assert.equal(rows[0].dataset.projectId, '42');
  assert.equal(tree.at(['projects', 'search']).peek(), 'mobile', 'search string lands in tree');
});

/* -------------------------------------------------------------------------- */
/* Selecting a project sets scope.projectId AND flips shell.view to 'board'.   */
/* -------------------------------------------------------------------------- */

test('selecting a project sets scope.projectId and flips shell.view to board', () => {
  const { api } = bootApi(M.mockTransport());
  const { ctrl, tree } = mountProjectList(api, SEED);

  const rows = visibleProjectRows(ctrl.el);
  const openBtn = rows[1].querySelector('[data-project-open]'); // Mobile App (42)
  openBtn.dispatchEvent({ type: 'click', target: openBtn });
  M.flushSync?.();

  assert.equal(tree.at(['scope', 'projectId']).peek(), 42n, 'scope.projectId set to the picked id');
  assert.equal(tree.at(['shell', 'view']).peek(), 'board', 'view flipped to board');
});

/* -------------------------------------------------------------------------- */
/* Create-project: optimistic add appears immediately, commits on success.     */
/* -------------------------------------------------------------------------- */

test('create-project optimistically adds the new project and persists on success', async () => {
  const { dispatcher, api } = bootApi(M.mockTransport());
  const { ctrl, tree } = mountProjectList(api, [...SEED]);

  // Open the quick-entry dialog, type a title, Add & Close.
  ctrl.intent('quickCreateOpen');
  const titleInput = ctrl.el.querySelector('[data-qe-title]');
  titleInput.value = 'New Service';
  const addClose = ctrl.el.querySelector('[data-qe-add-close]');
  addClose.dispatchEvent({ type: 'click', target: addClose });
  M.flushSync?.();

  // OPTIMISTIC: the new project shows BEFORE the server replies.
  let opts = tree.at(['shell', 'projects']).peek();
  assert.equal(opts.length, 3, 'optimistic add appended the new project');
  const optimistic = opts[2];
  assert.equal(optimistic.label, 'New Service');
  assert.equal(optimistic.pending, true, 'row marked pending until server confirms');

  await settle(dispatcher);

  // SUCCESS: the temp row's id is replaced with the server-returned id.
  opts = tree.at(['shell', 'projects']).peek();
  assert.equal(opts.length, 3, 'still three projects after commit');
  const created = opts.find((o) => o.label === 'New Service');
  assert.equal(created.id, M.CREATED_PROJECT_ID.toString(), 'temp id swapped for the real one');
  assert.notEqual(created.pending, true, 'no longer pending');

  // It is now visible in the list (and would be in the scope picker — same path).
  const rows = visibleProjectRows(ctrl.el);
  assert.equal(rows.length, 3, 'the created project appears in the list');
});

/* -------------------------------------------------------------------------- */
/* Create-project: optimistic add ROLLS BACK on a forced fault.                */
/* -------------------------------------------------------------------------- */

test('create-project optimistic add ROLLS BACK on fault (auto)', async () => {
  const { dispatcher, api } = bootApi(M.mockTransport());
  let topFault = null;
  dispatcher.onFault('sub_error', (f) => {
    topFault = f;
  });
  const { ctrl, tree } = mountProjectList(api, [...SEED]);

  ctrl.intent('quickCreateOpen');
  const titleInput = ctrl.el.querySelector('[data-qe-title]');
  // The mock forces a fault for this exact title.
  titleInput.value = M.FAULT_CREATE_TITLE;
  const addClose = ctrl.el.querySelector('[data-qe-add-close]');
  addClose.dispatchEvent({ type: 'click', target: addClose });
  M.flushSync?.();

  // Optimistic add applied first.
  let opts = tree.at(['shell', 'projects']).peek();
  assert.equal(opts.length, 3, 'optimistic add applied before the fault');

  await settle(dispatcher);

  // ROLLBACK: the optimistic row is gone; list is back to the original two.
  opts = tree.at(['shell', 'projects']).peek();
  assert.equal(opts.length, 2, 'rolled back to the original project set');
  assert.ok(topFault, 'the create fault funneled to the central (top) handler');
  assert.equal(topFault.code, 'validation');

  const rows = visibleProjectRows(ctrl.el);
  assert.equal(rows.length, 2, 'the list reverted too');
});

/* -------------------------------------------------------------------------- */
/* ScreenHost + NotFound still intact (regression guard for the view rewire).  */
/* -------------------------------------------------------------------------- */

test('ScreenHost still dispatches kanban → Kanban and unknown → NotFound', () => {
  const { api } = bootApi(M.mockTransport());
  const tree = new M.TreeNode({}, []);
  const ctx = { api, tree, scope: { projectId: null } };

  const host = M.Control.New(
    'ScreenHost',
    { type: 'ScreenHost', screen: { slug: 'kanban', layout: 'kanban', title: 'Kanban' } },
    ctx,
  );
  host.mount(new FakeElement('div'));
  const body = host.el.querySelector('.screen-host__body');
  assert.equal(body.findByControl('Kanban').length, 1, 'kanban layout → Kanban');

  const mystery = M.Control.New(
    'ScreenHost',
    { type: 'ScreenHost', screen: { slug: 'x', layout: 'hologram' }, filterBar: false },
    ctx,
  );
  mystery.mount(new FakeElement('div'));
  const nf = mystery.el.querySelector('.screen-host__body').findByControl('NotFound');
  assert.equal(nf.length, 1, 'unknown layout → visible NotFound');
});

/* -------------------------------------------------------------------------- */
/* AppShell view swap: g-nav intents flip the outlet between projects/board.   */
/* -------------------------------------------------------------------------- */

test('AppShell swaps the outlet between ProjectList and the board on view change', () => {
  const { api } = bootApi(M.mockTransport());
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(31n); // a scope so the board is happy
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const ctx = { api, tree, scope };

  const shell = M.Control.New(
    'AppShell',
    {
      type: 'AppShell',
      view: 'projects',
      boardConfig: { type: 'ScreenHost', screen: { slug: 'kanban', layout: 'kanban' } },
    },
    ctx,
  );
  shell.mount(new FakeElement('div'));

  // Landing: ProjectList present, no ScreenHost.
  assert.equal(shell.el.findByControl('ProjectList').length, 1, 'lands on ProjectList');
  assert.equal(shell.el.findByControl('ScreenHost').length, 0, 'board not mounted yet');

  // Raise the Kanban nav intent → view flips to board → outlet swaps.
  shell.intent('goKanban');
  M.flushSync?.();
  assert.equal(shell.el.findByControl('ProjectList').length, 0, 'ProjectList torn down');
  assert.equal(shell.el.findByControl('ScreenHost').length, 1, 'board (ScreenHost) mounted');

  // Back to projects.
  shell.intent('goProjects');
  M.flushSync?.();
  assert.equal(shell.el.findByControl('ProjectList').length, 1, 'ProjectList re-mounted');
  assert.equal(shell.el.findByControl('ScreenHost').length, 0, 'board torn down');
});

/* -------------------------------------------------------------------------- */
/* Recording transport: captures every shipped subrequest body AND honours the */
/* `is_template != true` where-leaf (the mock transport doesn't), so the       */
/* exclusion can be proved end-to-end given a transport that respects it.      */
/* -------------------------------------------------------------------------- */

function recordingProjectsTransport(projectRows) {
  const sent = [];
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => {
        sent.push(sr);
        const key = `${sr.endpoint}.${sr.action}`;
        if (key === 'card.select_with_attributes') {
          const data = sr.data ?? {};
          let rows = projectRows;
          // Honour a flat-AND `where` of leaves. We only need `is_template != true`.
          for (const leaf of data.where ?? []) {
            if (leaf.attr === 'is_template' && leaf.op === '!=') {
              const want = leaf.value;
              rows = rows.filter((r) => (r.attributes?.is_template ?? undefined) !== want);
            }
          }
          return { id: sr.id, ok: true, data: { rows } };
        }
        if (key === 'card.insert') {
          return { id: sr.id, ok: true, data: { id: '500' } };
        }
        if (key === 'attribute.update') {
          return { id: sr.id, ok: true, data: { ok: true, activity_id: '70001' } };
        }
        return { id: sr.id, ok: false, error: { code: 'unknown_handler', message: key } };
      });
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
  return { transport, sent };
}

/** Encode a project row exactly as card.select_with_attributes returns it. */
function projRow(id, title, extra) {
  return {
    id: String(id),
    card_type_id: '1',
    card_type_name: 'project',
    attributes: { title, ...(extra ?? {}) },
  };
}

/* -------------------------------------------------------------------------- */
/* The AppShell projects query input carries the `is_template != true` leaf —  */
/* and a seeded TEMPLATE row is excluded from BOTH list + scope picker.        */
/* -------------------------------------------------------------------------- */

test('AppShell projects query ships the is_template != true leaf, excluding templates', async () => {
  const PROJECTS = [
    projRow(31, 'Default Project'),
    projRow(99, 'Standard Project Template', { is_template: true }),
    projRow(42, 'Mobile App'), // no is_template row at all → must still appear
  ];
  const { transport, sent } = recordingProjectsTransport(PROJECTS);
  const { dispatcher, api } = bootApi(transport);

  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(null);
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const ctx = { api, tree, scope };

  const shell = M.Control.New(
    'AppShell',
    {
      type: 'AppShell',
      view: 'projects',
      defaultProjectLabel: 'Default Project',
      boardConfig: { type: 'ScreenHost', screen: { slug: 'kanban', layout: 'kanban' } },
    },
    ctx,
  );
  shell.mount(new FakeElement('div'));
  await settle(dispatcher);

  // The shipped projects sub-request carried the exclusion leaf verbatim.
  const projReq = sent.find(
    (sr) => sr.endpoint === 'card' && sr.action === 'select_with_attributes',
  );
  assert.ok(projReq, 'a card.select_with_attributes request was shipped');
  assert.deepEqual(
    projReq.data.where,
    [{ attr: 'is_template', op: '!=', value: true }],
    'the is_template != true leaf rides in the where field',
  );
  // The leaf equals the shared TEMPLATE_EXCLUSION_LEAF constant.
  assert.deepEqual(M.TEMPLATE_EXCLUSION_LEAF, { attr: 'is_template', op: '!=', value: true });

  // The honoring transport dropped the template; both other projects remain.
  const landed = tree.at(['shell', 'projects']).peek();
  const labels = landed.map((o) => o.label).sort();
  assert.deepEqual(labels, ['Default Project', 'Mobile App'], 'template excluded; unset kept');

  // List (shared path) shows two rows, no template row.
  const rows = visibleProjectRows(shell.el);
  assert.equal(rows.length, 2, 'list shows the two non-template projects');
  assert.ok(
    !rows.some((r) => /Standard Project Template/.test(r.textContent)),
    'the template is absent from the list',
  );

  // Scope picker (SAME path) shows the same two options, no template.
  const options = shell.el.querySelectorAll('OPTION');
  const pickerLabels = options.map((o) => o.textContent).sort();
  assert.deepEqual(pickerLabels, ['Default Project', 'Mobile App'], 'picker excludes the template too');
});

/* -------------------------------------------------------------------------- */
/* Create-with-description ships attributes.description through card.insert.    */
/* -------------------------------------------------------------------------- */

test('create-project with a description sends attributes.description', async () => {
  const { transport, sent } = recordingProjectsTransport([]);
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountProjectList(api, [...SEED]);

  ctrl.intent('quickCreateOpen');
  const titleInput = ctrl.el.querySelector('[data-qe-title]');
  titleInput.value = 'New Service';
  // Reveal + fill the real Description textarea behind "+ More details".
  const more = ctrl.el.querySelector('[data-qe-more]');
  more.dispatchEvent({ type: 'click', target: more });
  const descInput = ctrl.el.querySelector('[data-qe-description]');
  assert.ok(descInput, 'the disclosure exposes a real Description field');
  descInput.value = '  Ships invoices  ';

  const addClose = ctrl.el.querySelector('[data-qe-add-close]');
  addClose.dispatchEvent({ type: 'click', target: addClose });
  M.flushSync?.();
  await settle(dispatcher);

  const ins = sent.find((sr) => sr.endpoint === 'card' && sr.action === 'insert');
  assert.ok(ins, 'card.insert was shipped');
  assert.equal(ins.data.card_type_name, 'project');
  assert.equal(ins.data.title, 'New Service');
  assert.deepEqual(
    ins.data.attributes,
    { description: 'Ships invoices' },
    'description rides (trimmed) as attributes.description',
  );
});

test('create-project WITHOUT a description sends no attributes map', async () => {
  const { transport, sent } = recordingProjectsTransport([]);
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountProjectList(api, [...SEED]);

  ctrl.intent('quickCreateOpen');
  ctrl.el.querySelector('[data-qe-title]').value = 'Bare Project';
  const addClose = ctrl.el.querySelector('[data-qe-add-close]');
  addClose.dispatchEvent({ type: 'click', target: addClose });
  M.flushSync?.();
  await settle(dispatcher);

  const ins = sent.find((sr) => sr.endpoint === 'card' && sr.action === 'insert');
  assert.ok(ins, 'card.insert was shipped');
  assert.equal(ins.data.title, 'Bare Project');
  assert.equal('attributes' in ins.data, false, 'no attributes key when description is empty');
});

/* -------------------------------------------------------------------------- */
/* The ✎ editor opens the SHARED form (title + description) prefilled.          */
/* -------------------------------------------------------------------------- */

test('the shared form serves both create and edit (✎ prefills title + description)', () => {
  const { api } = bootApi(M.mockTransport());
  const { ctrl } = mountProjectList(api, [
    { id: '31', label: 'Default Project', description: 'The default workspace' },
  ]);

  const dialog = ctrl.el.querySelector('[data-quick-entry]');
  // Create mode: header "New project", blank fields, Add & Another visible.
  ctrl.intent('quickCreateOpen');
  assert.equal(dialog.style.display, '', 'dialog opened for create');
  assert.match(dialog.textContent, /New project/);
  assert.equal(ctrl.el.querySelector('[data-qe-title]').value, '', 'create starts blank');

  // Edit mode via ✎: SAME dialog element, header "Edit project", prefilled.
  const editBtn = ctrl.el.querySelector('[data-project-edit]');
  assert.equal(editBtn.disabled, false, '✎ is wired (enabled) for a real row');
  editBtn.dispatchEvent({ type: 'click', target: editBtn });
  assert.equal(dialog.style.display, '', 'the SAME dialog is reused for edit');
  assert.match(dialog.textContent, /Edit project/, 'edit heading');
  assert.equal(ctrl.el.querySelector('[data-qe-title]').value, 'Default Project', 'title prefilled');
  assert.equal(
    ctrl.el.querySelector('[data-qe-description]').value,
    'The default workspace',
    'description prefilled',
  );
});

/* -------------------------------------------------------------------------- */
/* Edit fires attribute.update for ONLY the changed field(s) + optimistic.      */
/* -------------------------------------------------------------------------- */

test('edit fires attribute.update for only the changed field and patches optimistically', async () => {
  const { transport, sent } = recordingProjectsTransport([]);
  const { dispatcher, api } = bootApi(transport);
  const { ctrl, tree } = mountProjectList(api, [
    { id: '31', label: 'Default Project', description: 'old desc' },
    { id: '42', label: 'Mobile App' },
  ]);

  // Open the editor for row 31, change ONLY the title.
  const editBtn = ctrl.el.querySelectorAll('[data-project-edit]')[0];
  editBtn.dispatchEvent({ type: 'click', target: editBtn });
  const titleInput = ctrl.el.querySelector('[data-qe-title]');
  titleInput.value = 'Default Workspace';
  // Description left unchanged ('old desc').
  const save = ctrl.el.querySelector('[data-qe-save]');
  assert.ok(save, 'edit footer shows a Save button');
  save.dispatchEvent({ type: 'click', target: save });
  M.flushSync?.();

  // OPTIMISTIC: the row label updated immediately, description untouched.
  let opts = tree.at(['shell', 'projects']).peek();
  const row31 = opts.find((o) => o.id === '31');
  assert.equal(row31.label, 'Default Workspace', 'title patched optimistically');
  assert.equal(row31.description, 'old desc', 'description left as-is');

  await settle(dispatcher);

  // Exactly ONE attribute.update shipped, for `title` only.
  const updates = sent.filter((sr) => sr.endpoint === 'attribute' && sr.action === 'update');
  assert.equal(updates.length, 1, 'only the changed field updates');
  assert.equal(updates[0].data.card_id, '31');
  assert.equal(updates[0].data.attribute_name, 'title');
  assert.equal(updates[0].data.value, 'Default Workspace');

  // The list row reflects the rename.
  const rows = visibleProjectRows(ctrl.el);
  assert.match(rows[0].textContent, /Default Workspace/);
});

test('edit changing BOTH fields fires two attribute.update calls', async () => {
  const { transport, sent } = recordingProjectsTransport([]);
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountProjectList(api, [
    { id: '31', label: 'Default Project', description: 'old desc' },
  ]);

  const editBtn = ctrl.el.querySelector('[data-project-edit]');
  editBtn.dispatchEvent({ type: 'click', target: editBtn });
  ctrl.el.querySelector('[data-qe-title]').value = 'Renamed';
  ctrl.el.querySelector('[data-qe-description]').value = 'new desc';
  const save = ctrl.el.querySelector('[data-qe-save]');
  save.dispatchEvent({ type: 'click', target: save });
  M.flushSync?.();
  await settle(dispatcher);

  const updates = sent
    .filter((sr) => sr.endpoint === 'attribute' && sr.action === 'update')
    .map((sr) => sr.data.attribute_name)
    .sort();
  assert.deepEqual(updates, ['description', 'title'], 'both changed fields update');
});

/* -------------------------------------------------------------------------- */
/* Edit optimistic patch ROLLS BACK on a forced fault.                          */
/* -------------------------------------------------------------------------- */

test('edit optimistic title patch ROLLS BACK on fault', async () => {
  const { dispatcher, api } = bootApi(M.mockTransport());
  let topFault = null;
  dispatcher.onFault('sub_error', (f) => {
    topFault = f;
  });
  // Use the FAULT_CARD_ID the mock always fails attribute.update against.
  const faultId = M.FAULT_CARD_ID.toString();
  const { ctrl, tree } = mountProjectList(api, [
    { id: faultId, label: 'Original Name' },
  ]);

  const editBtn = ctrl.el.querySelector('[data-project-edit]');
  editBtn.dispatchEvent({ type: 'click', target: editBtn });
  ctrl.el.querySelector('[data-qe-title]').value = 'Doomed Rename';
  const save = ctrl.el.querySelector('[data-qe-save]');
  save.dispatchEvent({ type: 'click', target: save });
  M.flushSync?.();

  // OPTIMISTIC: the label changed before the server replied.
  let opts = tree.at(['shell', 'projects']).peek();
  assert.equal(opts[0].label, 'Doomed Rename', 'optimistic rename applied');

  await settle(dispatcher);

  // ROLLBACK: the label reverted; the fault funneled to the top handler.
  opts = tree.at(['shell', 'projects']).peek();
  assert.equal(opts[0].label, 'Original Name', 'rolled back to the original title');
  assert.ok(topFault, 'the edit fault funneled to the central (top) handler');

  const rows = visibleProjectRows(ctrl.el);
  assert.match(rows[0].textContent, /Original Name/, 'the list row reverted too');
});
