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
      return [{ id: '40', name: 'status', value_type: 'card_ref', target_card_type_name: 'status', is_built_in: true, bound_to: [{ card_type_id: '5', card_type_name: 'task', is_required: false, ordering: 1 }] }];
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
  const ctrl = M.Control.New('MasterDetail', cfg, ctx);
  ctrl.mount(new FakeElement('div'));
  return { ctrl, tree, cfg };
}

/* -------------------------------------------------------------------------- */
/* Each admin view mounts as a registered MasterDetail.                        */
/* -------------------------------------------------------------------------- */

test('every admin view is config-only: mounts through Control.New as a MasterDetail', () => {
  const { api } = bootApi();
  for (const view of M.ADMIN_VIEWS) {
    const cfg = M.adminScreenConfig(view);
    assert.equal(cfg.type, 'MasterDetail', `${view} resolves to a MasterDetail config`);
    // The list query is built from the config (no per-screen control code).
    assert.ok(cfg.queries.some((q) => q.name === 'list'), `${view} has a built list query`);
    const { ctrl } = mountView(api, view);
    assert.equal(ctrl.type, 'MasterDetail', `${view} mounts as MasterDetail`);
    assert.ok(ctrl.el, `${view} produced a root element`);
  }
});

/* -------------------------------------------------------------------------- */
/* Each NEW screen loads its first row through its registered spec.            */
/* -------------------------------------------------------------------------- */

const SCREEN_SCOPE = {
  projects: ['admin', 'projects', 'items'],
  screens: ['admin', 'screens', 'items'],
  filters: ['admin', 'filters', 'items'],
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
    assert.equal(items.length, 1, `${view} landed exactly the one sample row`);
    const it = items[0];
    assert.ok(typeof it.id === 'string' && it.id.length > 0, `${view} row id normalised to a string`);
    assert.ok(it.raw && typeof it.raw === 'object', `${view} row carries a raw object`);
  });
}

/* -------------------------------------------------------------------------- */
/* Card-backed (editable) vs spec-registered (read-only) is correctly built.   */
/* -------------------------------------------------------------------------- */

test('card-backed admin screens carry an editField update action; read-only ones do not', () => {
  // Card-backed + editable: Projects / Screens / Named Filters (attribute.update).
  for (const view of ['projects', 'screens', 'filters']) {
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
  // Comm Channels / Activity Sinks / Roles mount config / mapping nested editors
  // that fire their own imperative comm_channel.set / activity_sink.set /
  // role_mapping.* calls — no MasterDetail-level action binding. Workflows /
  // Comm Log stay pure read-only viewers.
  assert.deepEqual(M.adminScreenConfig('comm_channels').detail.nested, { kind: 'commChannelConfig' });
  assert.deepEqual(M.adminScreenConfig('activity_sinks').detail.nested, { kind: 'activitySinkConfig' });
  assert.deepEqual(M.adminScreenConfig('roles').detail.nested, { kind: 'roleMappings' });
  for (const view of ['workflows', 'roles', 'comm_channels', 'activity_sinks', 'comm_log']) {
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
