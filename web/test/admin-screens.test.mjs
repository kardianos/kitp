/**
 * Admin screens generalisation test. Proves EVERY new admin screen is
 * config-only: each MasterDetailConfig mounts through the SAME registered
 * `MasterDetail` control (no per-screen control code), and each non-card screen's
 * registered `*.list` / `*.select` spec decodes a representative server row into
 * the uniform `{ id, raw }` item the list pane renders.
 *
 * The mock transport returns realistic rows shaped exactly like the Go handlers
 * (ids as JSON strings; nested arrays for badges/grants/bound_to). Project-scoped
 * reads (comm_channel / activity_sink / comm_log) are seeded a scope.projectId
 * leaf so their `{ signal: 'scope.projectId' }` + `skipWhenNull` list query fires.
 */

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
  M.registerMasterDetail();
  M.registerEnumManager(); // the Enums admin view is its own control, not a MasterDetail
  M.registerPeopleManager(); // the People admin view is its own control too
  M.registerNestedEditor(); // the OIDC Claims admin view is a standalone NestedEditor
  M.registerSchedulerJobs(); // the Background Jobs admin view is its own control too
  M.registerRecordForm(); // Comm Channels mounts the generic RecordForm in its detail
});

const PROJECT_ID = '31';

/* -------------------------------------------------------------------------- */
/* Mock transport — one realistic row per non-card endpoint + the card reads.  */
/* -------------------------------------------------------------------------- */

function cardRows(cardTypeName) {
  // Minimal card rows shaped like card.select_with_attributes for the four
  // card-backed admin screens (project / screen / filter; person for Contacts).
  const attrsByType = {
    project: { title: 'Apollo', description: 'Lunar program', is_template: false },
    screen: { title: 'Board', layout: 'kanban', slug: 'board', hotkey: 'k', sort_order: 1 },
    filter: { title: 'Open tasks', predicate: '{"attr":"status"}', sort: 'created', group_by_attr: 'milestone_ref' },
    person: { title: 'Ada', email: 'ada@example.com', person_kind: 'member' },
  };
  return [
    { id: '7001', card_type_id: '9', card_type_name: cardTypeName, parent_card_id: PROJECT_ID, attributes: attrsByType[cardTypeName] ?? {} },
  ];
}

function rowsFor(key, data) {
  switch (key) {
    case 'card.select_with_attributes':
      return cardRows(data.card_type_name);
    case 'user.list_with_roles':
      return [{ id: '2001', display_name: 'Grace', email: 'grace@example.com', is_agent: false, roles: [{ role_name: 'admin' }] }];
    case 'user.select':
      // Agents screen passes is_agent:true.
      return [{ id: '3001', display_name: 'bot-1', parent_user_id: '2001', is_agent: true }];
    case 'attribute_def.select':
      return [
        { id: '40', name: 'status', value_type: 'card_ref', target_card_type_name: 'status', is_built_in: true, bound_to: [{ card_type_id: '5', card_type_name: 'task', is_required: false, ordering: 1 }] },
        { id: '41', name: 'severity', value_type: 'text', is_built_in: false, bound_to: [] },
      ];
    case 'flow.list':
      return [{ id: '50', name: 'Default flow', doc: 'task status workflow', attribute_def_id: '40', attribute_def_name: 'status', scope_card_id: PROJECT_ID, default_create_status_id: '60', created_at: '2026-01-01T00:00:00Z' }];
    case 'role.list':
      return [{ id: '1', name: 'admin', doc: 'full access', grants: [{ card_type: 'task', process: 'card.update' }, { card_type: 'comm', process: 'comment.post' }] }];
    case 'comm_channel.list':
      return [{ id: '80', name: 'Support inbox', channel_type: 'email', imap_host: 'imap.example.com', smtp_host: 'smtp.example.com', from_address: 'support@example.com', channel_status: 'enabled', has_imap_password: true, has_smtp_password: true, created_at: '2026-01-02T00:00:00Z' }];
    case 'activity_sink.list':
      return [{ id: '90', name: 'Teams feed', sink_kind: 'msgraph_teams', msgraph_tenant_id: 't-1', msgraph_team_id: 'team-1', msgraph_channel_id: 'chan-1', channel_status: 'enabled', has_client_secret: true, last_pushed_count: '12', created_at: '2026-01-03T00:00:00Z' }];
    case 'comm_log.list':
      return [{ id: '100', channel_id: '80', channel_name: 'Support inbox', kind: 'poll', detail: { fetched: 3 }, at: '2026-05-24T12:00:00Z' }];
    default:
      return null;
  }
}

function adminTransport() {
  return {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => {
        const key = `${sr.endpoint}.${sr.action}`;
        const rows = rowsFor(key, sr.data ?? {});
        if (rows === null) {
          return { id: sr.id, ok: false, error: { code: 'unknown_handler', message: `mock has no ${key}` } };
        }
        return { id: sr.id, ok: true, data: { rows } };
      });
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
}

function bootApi() {
  const dispatcher = new M.Dispatcher({ transport: adminTransport() });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api); // card.select_with_attributes + attribute.update
  M.registerAdminSpecs(api); // every non-card admin spec
  return { dispatcher, api };
}

async function settle(dispatcher) {
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  M.flushSync?.();
}

/** Mount a MasterDetail from a view key against a fresh tree; seed the project
 *  scope so project-scoped list queries fire. */
function mountView(api, view) {
  const tree = new M.TreeNode({}, []);
  // The shared project scope the comm_* / activity_sink screens read.
  tree.at(['scope', 'projectId']).set(PROJECT_ID);
  const scope = { get projectId() { return tree.at(['scope', 'projectId']).peek() ?? null; } };
  const ctx = { api, tree, scope };
  const cfg = M.adminScreenConfig(view);
  // Mount as the config's own control type (most are MasterDetail; Enums is its
  // own EnumManager control).
  const ctrl = M.Control.New(cfg.type, cfg, ctx);
  ctrl.mount(new FakeElement('div'));
  return { ctrl, tree, cfg };
}

/* -------------------------------------------------------------------------- */
/* Each admin view mounts as a registered MasterDetail.                        */
/* -------------------------------------------------------------------------- */

test('every admin view is config-only: resolves to a registered control config', () => {
  const { api } = bootApi();
  for (const view of M.ADMIN_VIEWS) {
    const cfg = M.adminScreenConfig(view);
    const { ctrl } = mountView(api, view);
    assert.equal(ctrl.type, cfg.type, `${view} mounts as its config type (${cfg.type})`);
    assert.ok(ctrl.el, `${view} produced a root element`);
    // Most admin views are MasterDetail (with a built list query); the Enums
    // view is its own control (EnumManager) — no per-screen MasterDetail code.
    if (cfg.type === 'MasterDetail') {
      assert.ok(cfg.queries.some((q) => q.name === 'list'), `${view} has a built list query`);
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Each NEW screen loads its first row through its registered spec.            */
/* -------------------------------------------------------------------------- */

const SCREEN_SCOPE = {
  screens: ['admin', 'screens', 'items'],
  attributes: ['admin', 'attributes', 'items'],
  workflows: ['admin', 'workflows', 'items'],
  roles: ['admin', 'roles', 'items'],
  agents: ['admin', 'agents', 'items'],
  comm_channels: ['admin', 'comm_channels', 'items'],
  activity_sinks: ['admin', 'activity_sinks', 'items'],
  comm_log: ['admin', 'comm_log', 'items'],
};

for (const [view, itemsPath] of Object.entries(SCREEN_SCOPE)) {
  test(`${view}: list spec decodes a sample row into a { id, raw } item`, async () => {
    const { dispatcher, api } = bootApi();
    const { tree } = mountView(api, view);
    await settle(dispatcher);

    const items = tree.at(itemsPath).peek();
    assert.ok(Array.isArray(items), `${view} items leaf is an array`);
    assert.ok(items.length >= 1, `${view} landed at least the sample row`);
    const it = items[0];
    assert.ok(typeof it.id === 'string' && it.id.length > 0, `${view} row id normalised to a string`);
    assert.ok(it.raw && typeof it.raw === 'object', `${view} row carries a raw object`);
  });
}

/* -------------------------------------------------------------------------- */
/* Card-backed (editable) vs spec-registered (read-only) is correctly built.   */
/* -------------------------------------------------------------------------- */

test('card-backed admin screens carry an editField update action; read-only ones do not', () => {
  // Card-backed + editable: Screens (attribute.update).
  for (const view of ['screens']) {
    const cfg = M.adminScreenConfig(view);
    assert.ok(
      cfg.actions.some((a) => a.intent === 'editField' && a.spec === 'attribute.update'),
      `${view} has an attribute.update editField action`,
    );
  }
  // No inline editField (the nested editors / create dialog are the write
  // surface): Attributes / Workflows / Roles / Agents / Comm* .
  for (const view of ['attributes', 'workflows', 'roles', 'agents', 'comm_channels', 'activity_sinks', 'comm_log']) {
    const cfg = M.adminScreenConfig(view);
    assert.ok(!cfg.actions.some((a) => a.intent === 'editField'), `${view} has no inline editField action`);
  }
  // Attributes now carries a create action (attribute_def.insert); its edge
  // matrix + Screens filters + Workflows transitions are nested editors that
  // fire their own imperative calls (no MasterDetail-level action binding).
  const attrs = M.adminScreenConfig('attributes');
  assert.ok(
    attrs.actions.some((a) => a.intent === 'createItem' && a.spec === 'attribute_def.insert'),
    'attributes has an attribute_def.insert create action',
  );
  // Agents now carry create (agent.create) + delete (agent.delete); their token
  // panel is a nested editor that fires its own imperative user_token.* calls.
  const agents = M.adminScreenConfig('agents');
  assert.ok(
    agents.actions.some((a) => a.intent === 'createItem' && a.spec === 'agent.create'),
    'agents has an agent.create create action',
  );
  assert.ok(
    agents.actions.some((a) => a.intent === 'deleteItem' && a.spec === 'agent.delete'),
    'agents has an agent.delete delete action',
  );
  assert.deepEqual(agents.detail.nested, { kind: 'agentTokens' }, 'agents mounts the token nested editor');
  // Comm Channels now mounts the generic RecordForm (detail.form) instead of a
  // bespoke nested editor: a field table + save/list-refresh owned by the
  // control. Activity Sinks still uses its config nested editor (not migrated).
  const commCh = M.adminScreenConfig('comm_channels');
  assert.equal(commCh.detail.nested, undefined, 'comm_channels no longer uses a nested editor');
  assert.equal(commCh.detail.form?.saveSpec, 'comm_channel.set', 'comm_channels mounts RecordForm saving via comm_channel.set');
  assert.ok(Array.isArray(commCh.detail.form?.fields) && commCh.detail.form.fields.length > 0, 'comm_channels form has a field table');
  assert.deepEqual(M.adminScreenConfig('activity_sinks').detail.nested, { kind: 'activitySinkConfig' });
  // Roles is now a pure overview — the OIDC claim→role mapping editor moved to
  // its own Workspace screen (oidc_claims), a standalone roleMappings NestedEditor.
  assert.equal(M.adminScreenConfig('roles').detail.nested, undefined, 'roles no longer nests the mapping editor');
  assert.equal(M.adminScreenConfig('oidc_claims').type, 'NestedEditor', 'OIDC Claims is a standalone editor');
  assert.equal(M.adminScreenConfig('oidc_claims').kind, 'roleMappings', 'it renders the role_mapping table');
  // Workflows now carries a create action (flow.set); rename lives in the nested
  // flow-step editor. The rest stay pure read-only viewers.
  const wf = M.adminScreenConfig('workflows');
  assert.ok(
    wf.actions.some((a) => a.intent === 'createItem' && a.spec === 'flow.set'),
    'workflows has a flow.set create action',
  );
  for (const view of ['roles', 'comm_channels', 'activity_sinks', 'comm_log']) {
    const cfg = M.adminScreenConfig(view);
    assert.equal(cfg.actions.length, 0, `${view} is a read-only viewer (no MasterDetail action)`);
  }
});

/* -------------------------------------------------------------------------- */
/* Badge fields render from nested arrays (Roles grants, Attributes bound_to). */
/* -------------------------------------------------------------------------- */

test('Roles: grants render as read-only badges from the nested array', async () => {
  const { dispatcher, api } = bootApi();
  const { ctrl, tree } = mountView(api, 'roles');
  await settle(dispatcher);

  const items = tree.at(['admin', 'roles', 'items']).peek();
  const id = items[0].id;
  tree.at(['admin', 'roles', 'selectedId']).set(id);
  M.flushSync?.();

  const badges = ctrl.el.querySelectorAll('[data-role="badges"]');
  assert.ok(badges.length > 0, 'a badges container rendered for grants');
  assert.match(badges[0].textContent, /card\.update/);
  assert.match(badges[0].textContent, /comment\.post/);
  // No editable inputs on a read-only Roles detail.
  assert.equal(ctrl.el.querySelector('[data-role="input"]'), null);
});

test('Attributes: the detail mounts the edge-matrix nested editor (replacing bound_to badges)', () => {
  const cfg = M.adminScreenConfig('attributes');
  // The scalar bound_to badges field is gone — the nested edge matrix is the
  // bind/unbind surface now.
  assert.ok(!cfg.detail.fields.some((f) => f.name === 'bound_to'), 'no bound_to scalar field');
  assert.deepEqual(cfg.detail.nested, { kind: 'edgeMatrix' }, 'edge-matrix nested editor configured');

  // Workflows + Screens carry their nested editors too.
  assert.deepEqual(M.adminScreenConfig('workflows').detail.nested, { kind: 'flowSteps' });
  assert.deepEqual(M.adminScreenConfig('screens').detail.nested, { kind: 'screenFilters' });
});

test('Workflows: create optimistic row carries the flat `name` (not "(untitled)")', () => {
  // flow.list rows are flat ({ name, … }) with titleField 'name'. Without a
  // custom optimisticRaw the default builds a card-shaped { attributes: { title } }
  // row, so the new workflow read "(untitled)" until a manual reload. The
  // optimisticRaw must put the typed name at the flat `name` key.
  const cfg = M.adminScreenConfig('workflows');
  const raw = cfg.create.optimisticRaw({ name: 'My Flow', attribute_def_id: '5' });
  assert.equal(raw.name, 'My Flow', 'optimistic row exposes the flat name (titleField)');
});

test('Custom attributes: hides built-ins (rowFilter) + offers a picker target (#13)', async () => {
  const { dispatcher, api } = bootApi();
  const { ctrl, cfg } = mountView(api, 'attributes');
  await settle(dispatcher);

  // Reframed + a picker-target field wired into the create input.
  assert.equal(cfg.title, 'Custom attributes');
  assert.ok(cfg.create.fields.some((f) => f.name === 'target_card_type'), 'create offers a picker target');
  assert.deepEqual(cfg.create.input.targetCardType, { payload: 'target_card_type' });

  // Behavior: only the CUSTOM attribute (41 severity) renders; the built-in
  // (40 status) is hidden by the rowFilter. (Filter to visible pooled rows.)
  const ids = ctrl.el
    .querySelectorAll('[data-md-row]')
    .filter((r) => r.style.display !== 'none')
    .map((r) => r.dataset.mdId);
  assert.ok(ids.includes('41'), 'custom attribute shows');
  assert.ok(!ids.includes('40'), 'built-in attribute hidden');
});

test('Screens admin: list + create are scoped to the active project (#10)', () => {
  const cfg = M.adminScreenConfig('screens');
  // The list filters screen cards by their parent project and refires on scope.
  assert.deepEqual(cfg.list.input.parentCardId, { from: 'scope.projectId' });
  assert.deepEqual(cfg.list.when, { signal: 'scope.projectId' });
  assert.deepEqual(cfg.list.skipWhenNull, ['parentCardId']);
  // New screens are parented to the active project (not orphaned globally).
  assert.deepEqual(cfg.create.input.parentCardId, { from: 'scope.projectId' });
  // The list is ordered by sort_order so it matches the sidebar nav order.
  assert.deepEqual(cfg.list.input.order, { lit: [{ field: 'attributes.sort_order', direction: 'ASC' }] });
  // No advanced/predicate filter (a project has few screens) — and crucially the
  // COMPILED list query keeps its scope-signal trigger (NOT a listVersion one a
  // predicateFilter would force), so it fires on mount + every project switch
  // rather than silently skipping when scope wasn't ready (the "doesn't show" bug).
  assert.equal(cfg.list.predicateFilter, undefined, 'no predicateFilter');
  const listQ = cfg.queries.find((q) => q.name === 'list');
  assert.deepEqual(listQ.when, { signal: 'scope.projectId' }, 'list fires on the scope signal');
});

/* -------------------------------------------------------------------------- */
/* Project-scoped screen stays idle until the scope resolves.                  */
/* -------------------------------------------------------------------------- */

test('Comm Channels: skips the list read until scope.projectId resolves, then fires', async () => {
  const { dispatcher, api } = bootApi();
  const tree = new M.TreeNode({}, []);
  // Scope starts null → the { signal } + skipWhenNull list query must stay idle.
  tree.at(['scope', 'projectId']).set(null);
  const scope = { get projectId() { return tree.at(['scope', 'projectId']).peek() ?? null; } };
  const ctrl = M.Control.New('MasterDetail', M.adminScreenConfig('comm_channels'), { api, tree, scope });
  ctrl.mount(new FakeElement('div'));
  await settle(dispatcher);

  assert.deepEqual(tree.at(['admin', 'comm_channels', 'items']).peek(), [], 'no rows while scope is null');

  // Resolve the scope → the { signal: 'scope.projectId' } trigger refires.
  tree.at(['scope', 'projectId']).set(PROJECT_ID);
  M.flushSync?.();
  await settle(dispatcher);

  const items = tree.at(['admin', 'comm_channels', 'items']).peek();
  assert.equal(items.length, 1, 'channel row loaded once the scope resolved');
  assert.match(M.fieldText(items[0].raw, 'name'), /Support inbox/);
});

test('ADMIN_SECTION classifies every admin view (Workspace global vs Project scoped)', () => {
  // Every view is classified into exactly one section.
  for (const v of M.ADMIN_VIEWS) {
    assert.ok(M.ADMIN_SECTION[v] === 'workspace' || M.ADMIN_SECTION[v] === 'project', `${v} classified`);
  }
  // Confirmed grouping: global-data screens are Workspace; the rest are Project
  // (always filtered to the active project).
  const inSection = (s) => M.ADMIN_VIEWS.filter((v) => M.ADMIN_SECTION[v] === s).sort();
  assert.deepEqual(inSection('workspace'), ['agents', 'attributes', 'jobs', 'oidc_claims', 'people', 'roles']);
  assert.deepEqual(inSection('project'), ['activity_sinks', 'comm_channels', 'comm_log', 'enums', 'screens', 'workflows']);
});

test('WORKSPACE rail order: Agents sits directly under People', () => {
  // The rail renders ADMIN_VIEWS order within each section (main.ts adminLinks),
  // so the WORKSPACE order is ADMIN_VIEWS filtered to workspace.
  const workspace = M.ADMIN_VIEWS.filter((v) => M.ADMIN_SECTION[v] === 'workspace');
  const pi = workspace.indexOf('people');
  assert.ok(pi >= 0, 'People is in the workspace section');
  assert.equal(workspace[pi + 1], 'agents', 'Agents immediately follows People');
});

test('every PROJECT admin screen scopes its list to the active project', () => {
  // A project-section screen must thread scope.projectId into its list query
  // (parentCardId/projectId/scopeCardId from scope), so it can't leak rows from
  // other projects. EnumManager (Values) is its own control (project-scoped by
  // construction), so it's exempt from this MasterDetail-shaped check.
  for (const v of M.ADMIN_VIEWS) {
    if (M.ADMIN_SECTION[v] !== 'project' || v === 'enums') continue;
    const cfg = M.adminScreenConfig(v);
    const listQ = cfg.queries.find((q) => q.name === 'list');
    assert.ok(listQ, `${v}: has a list query`);
    const input = listQ.input ?? {};
    const scoped = ['parentCardId', 'projectId', 'scopeCardId'].some(
      (k) => input[k] && typeof input[k] === 'object' && input[k].from === 'scope.projectId',
    );
    assert.ok(scoped, `${v}: list query is scoped to scope.projectId (got ${JSON.stringify(input)})`);
  }
});

/* -------------------------------------------------------------------------- */
/* Agents: the nested editor manages an agent's "acts as" roles (web-only,     */
/* via the existing user_role.list / .set / .revoke handlers).                 */
/* -------------------------------------------------------------------------- */

test('Agents nested editor: lists, assigns, and revokes an agent\'s roles', async () => {
  const sent = [];
  let agentRoles = [{ role_name: 'worker' }]; // mutated by set/revoke so reload reflects truth
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => {
        const key = `${sr.endpoint}.${sr.action}`;
        const data = sr.data ?? {};
        sent.push({ key, data });
        switch (key) {
          case 'user.select':
            return { id: sr.id, ok: true, data: { rows: [{ id: '3001', display_name: 'bot-1', parent_user_id: '2001', is_agent: true }] } };
          case 'user_role.list':
            return { id: sr.id, ok: true, data: { rows: agentRoles } };
          case 'role.list':
            return { id: sr.id, ok: true, data: { rows: [
              { id: '1', name: 'admin', grants: [] },
              { id: '2', name: 'manager', grants: [] },
              { id: '3', name: 'worker', grants: [] },
            ] } };
          case 'user_token.list':
            return { id: sr.id, ok: true, data: { rows: [] } };
          case 'user_role.set':
            agentRoles = [...agentRoles, { role_name: String(data.role_name) }];
            return { id: sr.id, ok: true, data: { ok: true, user_role_id: '999' } };
          case 'user_role.revoke':
            agentRoles = agentRoles.filter((g) => g.role_name !== String(data.role_name));
            return { id: sr.id, ok: true, data: { ok: true, deleted: 1 } };
          default:
            return { id: sr.id, ok: false, error: { code: 'unknown', message: key } };
        }
      });
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api);
  M.registerAdminSpecs(api);
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(PROJECT_ID);
  const scope = { get projectId() { return tree.at(['scope', 'projectId']).peek() ?? null; } };
  const ctrl = M.Control.New('MasterDetail', M.adminScreenConfig('agents'), { api, tree, scope });
  ctrl.mount(new FakeElement('div'));
  await settle(dispatcher); // agents list loads (one agent)

  // Select the agent → the nested editor loads its roles + the catalogue.
  tree.at(['admin', 'agents', 'selectedId']).set('3001');
  await settle(dispatcher);

  // Current grant ('worker') renders as a revocable row.
  const roleRows = ctrl.el.querySelectorAll('[data-ne-agent-role-row]');
  assert.deepEqual(roleRows.map((r) => r.dataset.neAgentRoleRow), ['worker'], 'current role listed');

  // The single assign dropdown offers the catalogue minus the held role.
  const assign = ctrl.el.querySelectorAll('[data-ne-agent-role-assign]')[0];
  assert.ok(assign, 'assign dropdown present');
  assert.deepEqual(
    assign.children.map((o) => o.value),
    ['', 'admin', 'manager'],
    'placeholder + roles not already held (worker excluded)',
  );

  // Pick 'manager' → fires a GLOBAL user_role.set (no scope) for this agent.
  assign.value = 'manager';
  assign.dispatchEvent({ type: 'change', target: assign });
  await settle(dispatcher);
  const setReq = sent.filter((s) => s.key === 'user_role.set').pop();
  assert.ok(setReq, 'user_role.set fired');
  assert.equal(String(setReq.data.user_id), '3001', 'set targets the agent');
  assert.equal(setReq.data.role_name, 'manager', 'set carries the chosen role');
  assert.equal(setReq.data.scope_project_id, undefined, 'global grant (no project scope)');
  // Reload reflects the new grant.
  assert.deepEqual(
    ctrl.el.querySelectorAll('[data-ne-agent-role-row]').map((r) => r.dataset.neAgentRoleRow).sort(),
    ['manager', 'worker'],
    'assigned role appears after reload',
  );

  // Revoke 'worker'.
  const revokeBtn = ctrl.el.querySelectorAll('[data-ne-agent-role-revoke="worker"]')[0];
  assert.ok(revokeBtn, 'worker revoke button present');
  revokeBtn.dispatchEvent({ type: 'click', target: revokeBtn });
  await settle(dispatcher);
  const revReq = sent.filter((s) => s.key === 'user_role.revoke').pop();
  assert.equal(String(revReq.data.user_id), '3001', 'revoke targets the agent');
  assert.equal(revReq.data.role_name, 'worker', 'revoke carries the role');
  assert.deepEqual(
    ctrl.el.querySelectorAll('[data-ne-agent-role-row]').map((r) => r.dataset.neAgentRoleRow),
    ['manager'],
    'revoked role removed after reload',
  );
});
