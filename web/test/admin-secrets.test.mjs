/**
 * Admin secrets + agents + roles editors test (closes #22–#45).
 *
 * Covers the final admin editors built on the MasterDetail + NestedEditor
 * framework:
 *
 *   - comm_channel.set: a write-only IMAP/SMTP password is sent ONLY when the
 *     user typed a new value (omitted otherwise → server preserves the cipher);
 *     the has_*_password flags drive the "configured" / "not set" caption.
 *   - activity_sink.set: the write-only client_secret omits-when-blank; the
 *     activity-filter predicate editor round-trips leaves to the JSON attribute.
 *   - agent.create / agent.delete (the generic MasterDetail affordances).
 *   - user_token mint (secret surfaced ONCE in a copyable reveal) / list (labels
 *     + timestamps only) / revoke.
 *   - role_mapping.set / role_mapping.delete (claim_value → role).
 *
 * The pure helpers (channelDraftToSet / sinkDraftToSet / the activity predicate
 * model) are unit-tested directly; the controls are driven through the same
 * mock-transport harness the other admin tests use.
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
  M.registerNestedEditor();
  M.registerRecordForm();
  M.registerPredicateFilter();
  M.registerCombobox();
  M.registerRefPicker();
});

const PROJECT_ID = '31';

/* -------------------------------------------------------------------------- */
/* Mock transport — comm/sink list + set, agents, tokens, role mappings.       */
/* -------------------------------------------------------------------------- */

function adminTransport() {
  const sent = { writes: [] };
  const rec = (key, data) => sent.writes.push({ key, data: data ?? {} });

  let channelRows = [
    {
      id: '80', name: 'Support inbox', channel_type: 'email',
      imap_host: 'imap.example.com', smtp_host: 'smtp.example.com',
      from_address: 'support@example.com', channel_status: 'enabled',
      has_imap_password: true, has_smtp_password: false,
      created_at: '2026-01-02T00:00:00Z',
    },
  ];
  let sinkRows = [
    {
      id: '90', name: 'Teams feed', sink_kind: 'msgraph_teams',
      msgraph_tenant_id: 't-1', msgraph_client_id: 'c-1', msgraph_team_id: 'team-1',
      msgraph_channel_id: 'chan-1', activity_filter: '', channel_status: 'enabled',
      has_client_secret: true, created_at: '2026-01-03T00:00:00Z',
    },
  ];
  let agentRows = [
    { id: '3001', display_name: 'bot-1', parent_user_id: '2001', is_agent: true },
  ];
  let tokenRows = [
    { label: 'laptop', created_at: '2026-05-01T00:00:00Z', last_used_at: '2026-05-10T00:00:00Z' },
    { label: 'old', created_at: '2026-04-01T00:00:00Z', last_used_at: '2026-04-02T00:00:00Z', revoked_at: '2026-04-15T00:00:00Z' },
  ];
  let mappingRows = [
    { claim_value: 'kitp-admins', role_id: '1', role_name: 'admin' },
  ];
  const roleRows = [
    { id: '1', name: 'admin', doc: 'full access', grants: [{ card_type: 'task', process: 'card.update' }] },
    { id: '2', name: 'worker', doc: 'task work', grants: [] },
  ];

  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => {
        const key = `${sr.endpoint}.${sr.action}`;
        const data = sr.data ?? {};
        switch (key) {
          case 'comm_channel.list':
            return { id: sr.id, ok: true, data: { rows: channelRows } };
          case 'activity_sink.list':
            return { id: sr.id, ok: true, data: { rows: sinkRows } };
          case 'user.select':
            return { id: sr.id, ok: true, data: { rows: agentRows } };
          case 'user_token.list':
            return { id: sr.id, ok: true, data: { rows: tokenRows } };
          case 'role.list':
            return { id: sr.id, ok: true, data: { rows: roleRows } };
          case 'role_mapping.list':
            return { id: sr.id, ok: true, data: { rows: mappingRows } };
          /* ---- writes ---- */
          case 'comm_channel.set': {
            rec(key, data);
            const isInsert = data.id === undefined || data.id === null || data.id === '' || data.id === '0';
            if (isInsert) {
              const nid = String(80 + channelRows.length);
              channelRows = [
                ...channelRows,
                {
                  id: nid, name: data.name, channel_type: data.channel_type ?? 'email',
                  channel_status: data.channel_status ?? 'enabled',
                  has_imap_password: false, has_smtp_password: false,
                },
              ];
              return { id: sr.id, ok: true, data: { channel_id: nid } };
            }
            return { id: sr.id, ok: true, data: { channel_id: data.id } };
          }
          case 'activity_sink.set':
            rec(key, data);
            return { id: sr.id, ok: true, data: { sink_id: data.id ?? '91' } };
          case 'agent.create':
            rec(key, data);
            agentRows = [...agentRows, { id: '3002', display_name: data.display_name, parent_user_id: '2001', is_agent: true }];
            return { id: sr.id, ok: true, data: { user_id: '3002' } };
          case 'agent.delete':
            rec(key, data);
            agentRows = agentRows.filter((a) => String(a.id) !== String(data.user_id));
            return { id: sr.id, ok: true, data: { ok: true, deleted: 1 } };
          case 'user_token.create':
            rec(key, data);
            tokenRows = [{ label: data.label, created_at: '2026-05-24T00:00:00Z', last_used_at: '' }, ...tokenRows];
            return { id: sr.id, ok: true, data: { token: 'SEKRET-TOKEN-abc123', label: data.label } };
          case 'user_token.revoke':
            rec(key, data);
            tokenRows = tokenRows.map((t) => (t.label === data.label ? { ...t, revoked_at: '2026-05-24T01:00:00Z' } : t));
            return { id: sr.id, ok: true, data: { ok: true, deleted: 1 } };
          case 'role_mapping.set':
            rec(key, data);
            mappingRows = mappingRows.some((m) => m.claim_value === data.claim_value)
              ? mappingRows.map((m) => (m.claim_value === data.claim_value ? { ...m, role_name: data.role_name } : m))
              : [...mappingRows, { claim_value: data.claim_value, role_id: '2', role_name: data.role_name }];
            return { id: sr.id, ok: true, data: { ok: true } };
          case 'role_mapping.delete':
            rec(key, data);
            mappingRows = mappingRows.filter((m) => m.claim_value !== data.claim_value);
            return { id: sr.id, ok: true, data: { ok: true, deleted: 1 } };
          default:
            return { id: sr.id, ok: false, error: { code: 'unknown_handler', message: `mock has no ${key}` } };
        }
      });
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
  M.registerProjectSpecs(api);
  M.registerAdminSpecs(api);
  M.registerFilterSpecs(api);
  M.registerFilterCardSpecs(api);
  M.registerCardSearchSpec(api);
  return { dispatcher, api };
}

async function settle(dispatcher) {
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  M.flushSync?.();
}

function mountView(api, view) {
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(PROJECT_ID);
  const scope = { get projectId() { return tree.at(['scope', 'projectId']).peek() ?? null; } };
  const ctx = { api, tree, scope };
  const ctrl = M.Control.New('MasterDetail', M.adminScreenConfig(view), ctx);
  ctrl.mount(new FakeElement('div'));
  return { ctrl, tree };
}

function visibleRows(root) {
  return root.querySelectorAll('[data-md-row]').filter((r) => r.style.display !== 'none');
}
function writesFor(transport, key) {
  return transport.sent.writes.filter((w) => w.key === key);
}
async function selectFirstRow(ctrl, dispatcher) {
  const rows = visibleRows(ctrl.el);
  rows[0].dispatchEvent({ type: 'click' });
  M.flushSync?.();
  await settle(dispatcher);
  return rows[0].dataset.mdId;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers: the write-only-secret omit-when-blank rule.                   */
/* -------------------------------------------------------------------------- */

test('channelDraftToSet omits a password when blank, sends it when typed', () => {
  const base = M.emptyChannelDraft();
  base.name = 'Inbox';
  base.id = '80';
  // No password typed → key OMITTED entirely (server preserves the cipher).
  const omitted = M.channelDraftToSet(base, PROJECT_ID);
  assert.equal('imapPassword' in omitted, false, 'imapPassword omitted when blank');
  assert.equal('smtpPassword' in omitted, false, 'smtpPassword omitted when blank');
  assert.equal(omitted.name, 'Inbox');
  assert.equal(omitted.projectId, PROJECT_ID);
  assert.equal(omitted.id, '80');

  // Password typed → key PRESENT with the typed value.
  const typed = { ...base, imapPassword: 'hunter2' };
  const out = M.channelDraftToSet(typed, PROJECT_ID);
  assert.equal(out.imapPassword, 'hunter2', 'imapPassword sent when typed');
  assert.equal('smtpPassword' in out, false, 'smtpPassword still omitted');
});

test('intake_status round-trips: hydrated from the row, sent only when set', () => {
  // channelRowToDraft consumes the DECODED (camelCase) CommChannel row.
  // Unset on the row → blank draft → omitted from the wire payload.
  const none = M.channelRowToDraft({
    id: '80', name: 'X', channelType: 'email', channelStatus: 'enabled',
    hasImapPassword: false, hasSmtpPassword: false,
  });
  assert.equal(none.intakeStatusId, '', 'unset intake stays blank');
  assert.equal('intakeStatusId' in M.channelDraftToSet(none, PROJECT_ID), false, 'blank intake omitted from payload');

  // Set on the row → draft carries it → sent on save.
  const set = M.channelRowToDraft({
    id: '80', name: 'X', channelType: 'email', channelStatus: 'enabled',
    intakeStatusId: '321', hasImapPassword: false, hasSmtpPassword: false,
  });
  assert.equal(set.intakeStatusId, '321', 'intake hydrated from the row');
  assert.equal(M.channelDraftToSet(set, PROJECT_ID).intakeStatusId, '321', 'intake sent when set');
});

test('Workflows: row→draft→flow.set carries doc + default_create_status, keeps the governed attr', () => {
  // The Workflows RecordForm edits name / description / default-create status;
  // the governed attribute + scope ride along so flow.set updates the SAME flow.
  const draft = M.workflowRowToDraft({
    id: '5', name: 'Status', doc: 'old', attribute_def_id: '9',
    scope_card_id: '31', default_create_status_id: '12',
  });
  assert.equal(draft.doc, 'old', 'description hydrated');
  assert.equal(draft.defaultCreateStatusId, '12', 'default-create status hydrated');
  assert.equal(draft.attributeDefId, '9', 'governed attr carried (hidden)');

  // Edit the two fields the user wanted editable.
  draft.doc = 'new description';
  draft.defaultCreateStatusId = '13';
  const input = M.workflowDraftToInput(draft, '31');
  assert.equal(input.id, '5', 'updates the same flow by id');
  assert.equal(input.doc, 'new description', 'edited description sent');
  assert.equal(input.defaultCreateStatusId, '13', 'edited default-create status sent');
  assert.equal(input.attributeDefId, '9', 'governed attr preserved (not changed)');
  assert.equal(input.scopeCardId, '31', 'scope preserved');
});

test('channelRowToDraft starts passwords blank (never echoed)', () => {
  const draft = M.channelRowToDraft({
    id: '80', name: 'X', channelType: 'email', imapHost: 'h', smtpHost: 's',
    fromAddress: 'f@x', channelStatus: 'enabled', hasImapPassword: true, hasSmtpPassword: true,
  });
  assert.equal(draft.imapPassword, '', 'imap password blank on load');
  assert.equal(draft.smtpPassword, '', 'smtp password blank on load');
});

test('channelRowToDraft hydrates saved ports + usernames (not secrets)', () => {
  const draft = M.channelRowToDraft({
    id: '80', name: 'X', channelType: 'email',
    imapHost: 'imap.h', imapPort: 993, imapUsername: 'in@x',
    smtpHost: 'smtp.h', smtpPort: 587, smtpUsername: 'out@x',
    fromAddress: 'f@x', channelStatus: 'enabled', hasImapPassword: true, hasSmtpPassword: true,
  });
  assert.equal(draft.imapPort, '993', 'imap port shown as saved');
  assert.equal(draft.imapUsername, 'in@x', 'imap username shown as saved');
  assert.equal(draft.smtpPort, '587', 'smtp port shown as saved');
  assert.equal(draft.smtpUsername, 'out@x', 'smtp username shown as saved');
});

test('channelRowToDraft leaves unset ports/usernames blank', () => {
  const draft = M.channelRowToDraft({
    id: '81', name: 'Y', channelType: 'email',
    channelStatus: 'enabled', hasImapPassword: false, hasSmtpPassword: false,
  });
  assert.equal(draft.imapPort, '', 'unset imap port is blank');
  assert.equal(draft.imapUsername, '', 'unset imap username is blank');
  assert.equal(draft.smtpPort, '', 'unset smtp port is blank');
});

test('validateChannelDraft requires name + rejects non-email channel type', () => {
  assert.ok('name' in M.validateChannelDraft({ ...M.emptyChannelDraft(), name: '' }));
  assert.ok('channelType' in M.validateChannelDraft({ ...M.emptyChannelDraft(), name: 'X', channelType: 'sms' }));
  assert.deepEqual(M.validateChannelDraft({ ...M.emptyChannelDraft(), name: 'X' }), {});
});

test('sinkDraftToSet omits client_secret when blank, sends it when typed; always sends activity_filter', () => {
  const base = M.emptySinkDraft();
  base.name = 'Feed';
  const omitted = M.sinkDraftToSet(base, PROJECT_ID);
  assert.equal('msgraphClientSecret' in omitted, false, 'secret omitted when blank');
  assert.equal(omitted.activityFilter, '', 'activity_filter always present (empty = match all)');

  const typed = { ...base, msgraphClientSecret: 's3cr3t', activityFilter: '{"op":"and","items":[]}' };
  const out = M.sinkDraftToSet(typed, PROJECT_ID);
  assert.equal(out.msgraphClientSecret, 's3cr3t', 'secret sent when typed');
  assert.equal(out.activityFilter, '{"op":"and","items":[]}');
});

/* -------------------------------------------------------------------------- */
/* Activity predicate model.                                                   */
/* -------------------------------------------------------------------------- */

test('activity predicate: append/remove leaves round-trip via JSON', () => {
  let p = M.activityPredicateFromString('');
  assert.equal(p, null, 'empty string → null (match every row)');
  p = M.activityAppendLeaf(p, { kind: 'leaf', op: 'kind_in', values: ['comment'] });
  p = M.activityAppendLeaf(p, { kind: 'leaf', op: 'actor_not_in', values: ['9'] });
  const json = M.activityPredicateToString(p);
  const back = M.activityPredicateFromString(json);
  const leaves = M.activityTopLevelLeaves(back);
  assert.equal(leaves.length, 2);
  assert.match(leaves[0].summary, /kind in/);
  assert.match(leaves[0].summary, /comment/);
  assert.match(leaves[1].summary, /actor not in/);

  const pruned = M.activityRemoveLeafAt(back, 1);
  assert.equal(M.activityTopLevelLeaves(pruned).length, 1);
  // Removing the last leaf collapses to null (match everything).
  assert.equal(M.activityRemoveLeafAt(pruned, 0), null);
});

/* -------------------------------------------------------------------------- */
/* Comm Channels config editor (write-only passwords).                         */
/* -------------------------------------------------------------------------- */

test('Comm Channels: config form renders has_*_password state; saving without typing omits the passwords', async () => {
  const transport = adminTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountView(api, 'comm_channels');
  await settle(dispatcher);
  await selectFirstRow(ctrl, dispatcher);

  // The secret-state captions reflect the row flags (imap configured, smtp not).
  const imapState = ctrl.el.querySelector('[data-record-form-secret-state="imapPassword"]');
  const smtpState = ctrl.el.querySelector('[data-record-form-secret-state="smtpPassword"]');
  assert.match(imapState.textContent, /configured/, 'imap password shown configured');
  assert.match(smtpState.textContent, /not set/, 'smtp password shown not set');
  // The password inputs are blank on load.
  assert.equal(ctrl.el.querySelector('[data-record-form-field="imapPassword"]').value, '');

  // Save WITHOUT typing a password → comm_channel.set carries no password keys.
  ctrl.el.querySelector('[data-record-form-save]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  const sets = writesFor(transport, 'comm_channel.set');
  assert.equal(sets.length, 1, 'one comm_channel.set fired');
  assert.equal('imap_password' in sets[0].data, false, 'imap_password omitted (not typed)');
  assert.equal('smtp_password' in sets[0].data, false, 'smtp_password omitted (not typed)');
  assert.equal(String(sets[0].data.project_id), PROJECT_ID, 'project scope threaded');
  assert.equal(String(sets[0].data.id), '80', 'updates the selected channel');
});

test('Comm Channels: typing into the name field does NOT replace the input (focus survives)', async () => {
  // The bug: the nested-editor render effect subscribed to `draft`; every
  // keystroke wrote `draft`, the effect re-fired, the form re-rendered, the
  // `<input>` was replaced — so the user could only type one letter at a time
  // before focus was lost to the new node. Fix: the render effect no longer
  // subscribes to `draft`; structural draft writes (hydrate / +New / save reset
  // / filter-list mutations) call render explicitly. Per-field keystrokes
  // write `draft` without re-rendering, so the input stays put.
  const transport = adminTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountView(api, 'comm_channels');
  await settle(dispatcher);
  await selectFirstRow(ctrl, dispatcher);

  const before = ctrl.el.querySelector('[data-record-form-field="name"]');
  assert.ok(before, 'name input rendered');
  before.value = 'a';
  before.dispatchEvent({ type: 'input' });
  M.flushSync?.();
  const after = ctrl.el.querySelector('[data-record-form-field="name"]');
  assert.equal(after, before, 'same DOM input after a keystroke (no re-render)');
  // A second keystroke also lands on the same input (the regression: pre-fix,
  // this would be a fresh element each time).
  before.value = 'ab';
  before.dispatchEvent({ type: 'input' });
  M.flushSync?.();
  assert.equal(ctrl.el.querySelector('[data-record-form-field="name"]'), before, 'still the same input');
});

test('Comm Channels: creating a channel shows it in the list without a manual reload', async () => {
  const transport = adminTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountView(api, 'comm_channels');
  await settle(dispatcher);
  assert.equal(visibleRows(ctrl.el).length, 1, 'one seeded channel initially');

  // + New → fill name → Save (an INSERT: no id).
  ctrl.el.querySelector('[data-record-form-new]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  const nameInput = ctrl.el.querySelector('[data-record-form-field="name"]');
  nameInput.value = 'New Channel';
  nameInput.dispatchEvent({ type: 'input' });
  M.flushSync?.();
  ctrl.el.querySelector('[data-record-form-save]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);

  const sets = writesFor(transport, 'comm_channel.set');
  assert.equal(sets.length, 1, 'one comm_channel.set fired');
  assert.equal('id' in sets[0].data, false, 'insert carries no id');
  // The master list reflects the new channel WITHOUT a screen reload (RecordForm
  // re-issued comm_channel.list + rewrote items, which the virtualList tracks).
  assert.equal(visibleRows(ctrl.el).length, 2, 'new channel appears in the list immediately');
});

test('Comm Channels: typing a password sends ONLY that field', async () => {
  const transport = adminTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountView(api, 'comm_channels');
  await settle(dispatcher);
  await selectFirstRow(ctrl, dispatcher);

  const imapPwd = ctrl.el.querySelector('[data-record-form-field="imapPassword"]');
  imapPwd.value = 'new-imap-secret';
  imapPwd.dispatchEvent({ type: 'input' });
  M.flushSync?.();
  ctrl.el.querySelector('[data-record-form-save]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);

  const sets = writesFor(transport, 'comm_channel.set');
  assert.equal(sets.length, 1);
  assert.equal(sets[0].data.imap_password, 'new-imap-secret', 'typed imap password sent');
  assert.equal('smtp_password' in sets[0].data, false, 'untouched smtp password still omitted');
});

/* -------------------------------------------------------------------------- */
/* Activity Sinks config editor (write-only secret + filter).                  */
/* -------------------------------------------------------------------------- */

test('Activity Sinks: client_secret omitted when blank; adding a filter leaf saves the predicate JSON', async () => {
  const transport = adminTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountView(api, 'activity_sinks');
  await settle(dispatcher);
  await selectFirstRow(ctrl, dispatcher);

  assert.equal(ctrl.el.querySelector('[data-ne-secret-state="neClientSecret"]').textContent, 'configured');

  // Add an activity-filter leaf (kind_in: comment) via the mini-form.
  ctrl.el.querySelector('[data-ne-af-op]').value = 'kind_in';
  ctrl.el.querySelector('[data-ne-af-values]').value = 'comment, card_create';
  ctrl.el.querySelector('[data-ne-af-add-btn]').dispatchEvent({ type: 'click' });
  M.flushSync?.();

  // A leaf row now renders.
  assert.ok(ctrl.el.querySelector('[data-ne-af-leaf]'), 'a filter leaf row rendered');

  ctrl.el.querySelector('[data-ne-config-save]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  const sets = writesFor(transport, 'activity_sink.set');
  assert.equal(sets.length, 1, 'one activity_sink.set fired');
  assert.equal('msgraph_client_secret' in sets[0].data, false, 'client secret omitted (not typed)');
  const filter = JSON.parse(sets[0].data.activity_filter);
  assert.equal(filter.op, 'and');
  assert.equal(filter.items.length, 1);
  assert.equal(filter.items[0].op, 'kind_in');
  assert.deepEqual(filter.items[0].values, ['comment', 'card_create']);
});

/* -------------------------------------------------------------------------- */
/* Agents: create / delete.                                                    */
/* -------------------------------------------------------------------------- */

test('Agents: + New fires agent.create with the display name', async () => {
  const transport = adminTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountView(api, 'agents');
  await settle(dispatcher);

  ctrl.el.querySelector('[data-md-new]').dispatchEvent({ type: 'click' });
  const dialog = ctrl.el.querySelector('[data-md-create]');
  dialog.querySelector('[data-md-form-field="display_name"]').value = 'research-agent';
  dialog.querySelector('[data-md-create-submit]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);

  const creates = writesFor(transport, 'agent.create');
  assert.equal(creates.length, 1);
  assert.equal(creates[0].data.display_name, 'research-agent');
});

test('Agents: Delete fires agent.delete for the selected agent', async () => {
  const transport = adminTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountView(api, 'agents');
  await settle(dispatcher);
  await selectFirstRow(ctrl, dispatcher);

  ctrl.el.querySelector('[data-md-delete]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);

  const dels = writesFor(transport, 'agent.delete');
  assert.equal(dels.length, 1);
  assert.equal(String(dels[0].data.user_id), '3001');
});

/* -------------------------------------------------------------------------- */
/* Agent tokens: mint (secret once) / list / revoke.                           */
/* -------------------------------------------------------------------------- */

test('Agents: tokens list shows labels + status; minting surfaces the secret ONCE; revoke fires', async () => {
  const transport = adminTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountView(api, 'agents');
  await settle(dispatcher);
  await selectFirstRow(ctrl, dispatcher);

  // The token list shows both labels with active/revoked status.
  const rows = ctrl.el.querySelectorAll('[data-ne-token-row]');
  assert.equal(rows.length, 2, 'two token rows');
  const laptop = ctrl.el.querySelector('[data-ne-token-row="laptop"]');
  assert.match(laptop.textContent, /active/);
  const old = ctrl.el.querySelector('[data-ne-token-row="old"]');
  assert.match(old.textContent, /revoked/);
  // No secret value is present in the list (labels + timestamps only).
  assert.equal(ctrl.el.querySelector('[data-ne-token-value]'), null, 'no secret shown in the list');

  // Mint a new token → the secret is surfaced ONCE in a copyable reveal.
  ctrl.el.querySelector('[data-ne-token-label]').value = 'ci';
  ctrl.el.querySelector('[data-ne-token-mint-btn]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);

  const mints = writesFor(transport, 'user_token.create');
  assert.equal(mints.length, 1);
  assert.equal(mints[0].data.label, 'ci');
  assert.equal(String(mints[0].data.user_id), '3001');
  const reveal = ctrl.el.querySelector('[data-ne-token-value]');
  assert.ok(reveal, 'the one-shot secret reveal rendered');
  assert.equal(reveal.textContent, 'SEKRET-TOKEN-abc123', 'the minted secret is shown once');

  // Dismiss the reveal → the secret is gone from the DOM.
  ctrl.el.querySelector('[data-ne-token-dismiss]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  assert.equal(ctrl.el.querySelector('[data-ne-token-value]'), null, 'secret cleared after dismiss');

  // Revoke the laptop token.
  ctrl.el.querySelector('[data-ne-token-revoke="laptop"]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  const revs = writesFor(transport, 'user_token.revoke');
  assert.equal(revs.length, 1);
  assert.equal(revs[0].data.label, 'laptop');
});

/* -------------------------------------------------------------------------- */
/* Roles: role_mapping set / delete (claim_value → role).                      */
/* -------------------------------------------------------------------------- */

test('OIDC Claims: role mappings load + render; add fires role_mapping.set; remove fires role_mapping.delete', async () => {
  const transport = adminTransport();
  const { dispatcher, api } = bootApi(transport);
  // The mapping editor is now its own Workspace screen — a standalone
  // roleMappings NestedEditor (not nested under Roles).
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(PROJECT_ID);
  const scope = { get projectId() { return tree.at(['scope', 'projectId']).peek() ?? null; } };
  const cfg = M.adminScreenConfig('oidc_claims');
  const ctrl = M.Control.New(cfg.type, cfg, { api, tree, scope });
  ctrl.mount(new FakeElement('div'));
  await settle(dispatcher);

  // The global mapping table loaded (independent of any selection).
  const mappings = tree.at(['admin', 'oidc_claims', 'mappings']).peek();
  assert.ok(Array.isArray(mappings) && mappings.length === 1, 'one mapping landed');
  assert.ok(ctrl.el.querySelector('[data-ne-mapping-row="kitp-admins"]'), 'the existing mapping renders');

  // Add a mapping (claim → worker).
  ctrl.el.querySelector('[data-ne-mapping-claim]').value = 'kitp-staff';
  ctrl.el.querySelector('[data-ne-mapping-role]').value = 'worker';
  ctrl.el.querySelector('[data-ne-mapping-add-btn]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  const sets = writesFor(transport, 'role_mapping.set');
  assert.equal(sets.length, 1);
  assert.equal(sets[0].data.claim_value, 'kitp-staff');
  assert.equal(sets[0].data.role_name, 'worker');

  // Remove the original mapping.
  ctrl.el.querySelector('[data-ne-mapping-delete="kitp-admins"]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  const dels = writesFor(transport, 'role_mapping.delete');
  assert.equal(dels.length, 1);
  assert.equal(dels[0].data.claim_value, 'kitp-admins');
});

test('Roles: grants stay read-only (no role_grant set/revoke handler exists)', () => {
  const cfg = M.adminScreenConfig('roles');
  const grants = cfg.detail.fields.find((f) => f.name === 'grants');
  assert.ok(grants, 'grants field present');
  assert.equal(grants.kind, 'badges', 'grants render as read-only badges');
  assert.ok(!cfg.detail.fields.some((f) => f.editable === true), 'no editable scalar field on Roles');
});
