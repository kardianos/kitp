/**
 * Personal notification subscriptions (account page) — the activity_subscription
 * specs' display decoding, the draft ↔ wire mappers, the generic RecordForm
 * field gates they rely on, and the config-only MasterDetail + RecordForm flow
 * (add / edit / delete with an inline confirm / friendly faults) driven through
 * a mock transport.
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
  M.registerRecordForm();
  M.registerPredicateFilter();
  M.registerActivityFilterEditor();
  M.registerAccountPage();
});

/* -------------------------------------------------------------------------- */
/* Pure: display decoding.                                                     */
/* -------------------------------------------------------------------------- */

const STATUS_CASES = [
  { name: 'enabled', row: { channel_status: 'enabled', sink_status: 'enabled' }, key: 'active', label: 'Active' },
  { name: 'paused', row: { channel_status: 'disabled-admin', sink_status: 'enabled' }, key: 'paused', label: 'Paused' },
  {
    name: 'fault with reason',
    row: { channel_status: 'disabled-fault', channel_fault_reason: '550 mailbox unavailable', sink_status: 'enabled' },
    key: 'fault',
    label: 'Stopped after a delivery failure: 550 mailbox unavailable',
  },
  { name: 'sink off wins', row: { channel_status: 'disabled-admin', sink_status: 'disabled-admin' }, key: 'sink_off', label: 'Paused by an admin (sink disabled)' },
  { name: 'missing statuses read as enabled', row: {}, key: 'active', label: 'Active' },
];
for (const c of STATUS_CASES) {
  test(`decodeSubscriptionRow status: ${c.name}`, () => {
    const r = M.decodeSubscriptionRow({ id: '7', ...c.row });
    assert.equal(r.statusKey, c.key);
    assert.equal(r.statusLabel, c.label);
  });
}

const ROLLUP_CASES = [
  [0, 'Immediately'],
  [15, 'Every 15 min'],
  [60, 'Every 1 h'],
  [90, 'Every 90 min'],
  [1440, 'Every 24 h'],
];
for (const [minutes, want] of ROLLUP_CASES) {
  test(`rollupLabel(${minutes}) = ${want}`, () => assert.equal(M.rollupLabel(minutes), want));
}

const SENT_CASES = [
  ['', 'Never'],
  ['2026-10-05T14:03:22.123Z', '2026-10-05 14:03 UTC'],
  ['not-a-date', 'not-a-date'],
];
for (const [iso, want] of SENT_CASES) {
  test(`lastSentLabel(${JSON.stringify(iso)}) = ${want}`, () => assert.equal(M.lastSentLabel(iso), want));
}

test('decodeSubscriptionRow camelCases the wire + derives the scope label', () => {
  const r = M.decodeSubscriptionRow({
    id: '7', name: 'Mine', sink_id: '91', sink_name: 'Project mail', project_id: '31', project_name: 'Apollo',
    rollup_minutes: 30, activity_filter: '{"op":"kind_in","values":["comment"]}', card_filter: '',
    last_pushed_at: '', last_pushed_count: '4',
  });
  assert.equal(r.sinkId, '91');
  assert.equal(r.projectId, '31');
  assert.equal(r.rollupMinutes, 30);
  assert.equal(r.scopeLabel, 'Apollo — Project mail');
  assert.equal(r.rollupLabel, 'Every 30 min');
  assert.equal(r.lastSentLabel, 'Never');
});

test('decodeSubscribableSinkRow labels "Project — Sink" and flags a paused sink', () => {
  const ok = M.decodeSubscribableSinkRow({ sink_id: '91', sink_name: 'Mail', project_id: '31', project_name: 'Apollo', sink_status: 'enabled' });
  assert.equal(ok.label, 'Apollo — Mail');
  const off = M.decodeSubscribableSinkRow({ sink_id: '92', sink_name: 'Old', project_id: '32', project_name: 'Zeus', sink_status: 'disabled-admin' });
  assert.equal(off.label, 'Zeus — Old (paused)');
});

/* -------------------------------------------------------------------------- */
/* Pure: draft ↔ wire.                                                         */
/* -------------------------------------------------------------------------- */

const VALIDATE_CASES = [
  { name: 'new needs a sink', patch: { name: 'A' }, errs: ['sinkId'] },
  { name: 'new ok', patch: { name: 'A', sinkId: '91' }, errs: [] },
  { name: 'name required', patch: { sinkId: '91', name: '  ' }, errs: ['name'] },
  { name: 'rollup must be whole minutes', patch: { sinkId: '91', name: 'A', rollupMinutes: '2.5' }, errs: ['rollupMinutes'] },
  { name: 'rollup capped at a day', patch: { sinkId: '91', name: 'A', rollupMinutes: '1441' }, errs: ['rollupMinutes'] },
  { name: 'blank rollup = immediate', patch: { sinkId: '91', name: 'A', rollupMinutes: '' }, errs: [] },
  { name: 'existing needs no sink', patch: { id: '7', name: 'A' }, errs: [] },
];
for (const c of VALIDATE_CASES) {
  test(`validateSubscriptionDraft: ${c.name}`, () => {
    const errs = M.validateSubscriptionDraft({ ...M.emptySubscriptionDraft(), ...c.patch });
    assert.deepEqual(Object.keys(errs).sort(), [...c.errs].sort());
  });
}

test('subscriptionDraftToSet: a create carries the sink + enabled, never an id', () => {
  const out = M.subscriptionDraftToSet({ ...M.emptySubscriptionDraft(), sinkId: '91', projectId: '31', name: ' Mine ', rollupMinutes: '15' });
  assert.deepEqual(out, { name: 'Mine', activityFilter: '', cardFilter: '', rollupMinutes: 15, sinkId: '91', enabled: true });
});

const ENABLED_CASES = [
  { name: 'untouched enabled → omitted', initial: true, now: true, sent: undefined },
  { name: 'untouched fault/paused → omitted (no accidental re-pause)', initial: false, now: false, sent: undefined },
  { name: 'pause', initial: true, now: false, sent: false },
  { name: 're-enable', initial: false, now: true, sent: true },
];
for (const c of ENABLED_CASES) {
  test(`subscriptionDraftToSet enabled: ${c.name}`, () => {
    const row = M.decodeSubscriptionRow({ id: '7', name: 'Mine', sink_id: '91', channel_status: c.initial ? 'enabled' : 'disabled-fault' });
    const draft = { ...M.subscriptionRowToDraft(row), enabled: c.now };
    const out = M.subscriptionDraftToSet(draft);
    assert.equal(out.id, '7');
    assert.equal('sinkId' in out, false, 'an update never re-sends the sink');
    assert.equal(out.enabled, c.sent);
    assert.equal('enabled' in out, c.sent !== undefined);
  });
}

/* -------------------------------------------------------------------------- */
/* Pure: event-filter descriptions ("me" for the @me actor token).             */
/* -------------------------------------------------------------------------- */

const DESCRIBE_CASES = [
  { leaf: { kind: 'leaf', op: 'actor_not_in', values: ['@me'] }, want: 'Not done by me' },
  { leaf: { kind: 'leaf', op: 'actor_in', values: ['@me', '12'] }, want: 'Done by me, 12' },
  { leaf: { kind: 'leaf', op: 'kind_in', values: ['comment', 'card_create'] }, want: 'Event is any of Comment, Card created' },
  { leaf: { kind: 'leaf', op: 'attr_not_in', values: ['sort_order'] }, want: 'Changed attribute is none of sort_order' },
];
for (const c of DESCRIBE_CASES) {
  test(`describeActivityLeaf: ${c.want}`, () => assert.equal(M.describeActivityLeaf(c.leaf), c.want));
}

test('summarizeActivityPredicate renders the @me token as "me"', () => {
  const p = M.activityPredicateFromString('{"op":"actor_not_in","values":["@me"]}');
  assert.equal(M.summarizeActivityPredicate(p), 'actor not in (me)');
});

/* -------------------------------------------------------------------------- */
/* Pure: RecordForm gates.                                                     */
/* -------------------------------------------------------------------------- */

const VISIBLE_CASES = [
  { when: undefined, draft: {}, want: true },
  { when: { field: 'id', in: ['0'] }, draft: { id: '0' }, want: true },
  { when: { field: 'id', in: ['0'] }, draft: { id: '7' }, want: false },
  { when: { field: 'id', notIn: ['0'] }, draft: { id: '7' }, want: true },
  { when: { field: 'kind', in: ['email'] }, draft: {}, want: false },
  { when: { field: 'on', in: ['true'] }, draft: { on: true }, want: true },
];
VISIBLE_CASES.forEach((c, i) => {
  test(`fieldVisible case ${i}`, () => {
    const f = { name: 'x', label: 'X', kind: 'text', ...(c.when ? { showWhen: c.when } : {}) };
    assert.equal(M.fieldVisible(f, c.draft), c.want);
  });
});

const FAULT_CASES = [
  { f: { kind: 'sub_error', code: 'no_email', message: 'raw' }, msgs: { no_email: 'Add an email' }, want: 'Add an email' },
  { f: { kind: 'sub_error', code: 'other', message: 'server says' }, msgs: { no_email: 'x' }, want: 'server says' },
  { f: { kind: 'http', status: 503 }, msgs: undefined, want: 'Request failed (http 503).' },
  { f: { kind: 'network', message: 'offline' }, msgs: undefined, want: 'offline' },
];
for (const c of FAULT_CASES) {
  test(`faultText: ${c.want}`, () => assert.equal(M.faultText(c.f, c.msgs), c.want));
}

/* -------------------------------------------------------------------------- */
/* The account-page subscription manager (mock transport).                     */
/* -------------------------------------------------------------------------- */

const ATTR_DEFS = [
  { id: '5', name: 'status', value_type: 'card_ref', target_card_type_name: 'status', bound_to: [{ card_type_id: '2', card_type_name: 'task', ordering: 1 }] },
  { id: '6', name: 'assignee', value_type: 'card_ref', target_card_type_name: 'person', bound_to: [{ card_type_id: '2', card_type_name: 'task', ordering: 2 }] },
];
const CARD_TYPES = [
  { id: '1', name: 'project' },
  { id: '2', name: 'task', parent_card_type_id: '1' },
  { id: '6', name: 'status', parent_card_type_id: '1' },
  { id: '8', name: 'person' },
];

function subscriptionTransport({ setError } = {}) {
  const sent = { writes: [], lists: 0 };
  let rows = [
    {
      id: '7', name: 'Assigned to me', sink_id: '91', sink_name: 'Project mail', project_id: '31',
      project_name: 'Apollo', channel_name: 'Support inbox', activity_filter: '', card_filter: '',
      rollup_minutes: 15, channel_status: 'enabled', channel_fault_reason: '', sink_status: 'enabled',
      last_pushed_at: '2026-10-05T14:03:00Z', last_pushed_count: '2', last_error: '', pending_since: '',
      created_at: '2026-10-01T00:00:00Z',
    },
    {
      id: '8', name: 'Everything', sink_id: '91', sink_name: 'Project mail', project_id: '31',
      project_name: 'Apollo', channel_name: 'Support inbox', activity_filter: '', card_filter: '',
      rollup_minutes: 0, channel_status: 'disabled-fault', channel_fault_reason: '550 no such user',
      sink_status: 'enabled', last_pushed_at: '', last_pushed_count: '0', last_error: '550 no such user',
      pending_since: '', created_at: '2026-10-01T00:00:00Z',
    },
  ];
  const sinks = [
    { sink_id: '91', sink_name: 'Project mail', project_id: '31', project_name: 'Apollo', channel_name: 'Support inbox', sink_status: 'enabled' },
    { sink_id: '95', sink_name: 'Ops mail', project_id: '40', project_name: 'Hermes', channel_name: 'Ops', sink_status: 'enabled' },
  ];
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => {
        const key = `${sr.endpoint}.${sr.action}`;
        const data = sr.data ?? {};
        switch (key) {
          case 'activity_subscription.list':
            sent.lists += 1;
            return { id: sr.id, ok: true, data: { rows } };
          case 'activity_subscription.sinks':
            return { id: sr.id, ok: true, data: { rows: sinks } };
          // The card filter's vocabulary: task has a project-scoped `status`
          // ref + a global `assignee` (person) ref.
          case 'attribute_def.select':
            return { id: sr.id, ok: true, data: { rows: ATTR_DEFS } };
          case 'card_type.select':
            return { id: sr.id, ok: true, data: { rows: CARD_TYPES } };
          case 'card.select_with_attributes':
            sent.writes.push({ key, data }); // recorded so the test can see the project-scoped loads
            return { id: sr.id, ok: true, data: { rows: [] } };
          case 'activity_subscription.set': {
            sent.writes.push({ key, data });
            if (setError) return { id: sr.id, ok: false, error: setError };
            if (data.id === undefined) {
              rows = [...rows, { ...rows[0], id: '9', name: data.name, sink_id: data.sink_id }];
              return { id: sr.id, ok: true, data: { subscription_id: '9' } };
            }
            return { id: sr.id, ok: true, data: { subscription_id: data.id } };
          }
          case 'activity_subscription.delete':
            sent.writes.push({ key, data });
            rows = rows.filter((r) => r.id !== data.id);
            return { id: sr.id, ok: true, data: { deleted: true } };
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

function boot(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api);
  M.registerAdminSpecs(api);
  M.registerFilterSpecs(api);
  M.registerSubscriptionSpecs(api);
  return { dispatcher, api };
}

async function settle(dispatcher) {
  for (let i = 0; i < 4; i++) await dispatcher.flushNow();
  M.flushSync?.();
}

function mountScreen(api) {
  const tree = new M.TreeNode({}, []);
  const ctx = { api, tree, scope: {} };
  const ctrl = M.Control.New('MasterDetail', M.masterDetailScreen(M.MY_SUBSCRIPTIONS_SCREEN), ctx);
  ctrl.mount(new FakeElement('div'));
  return { ctrl, tree };
}

function rowsOf(el) {
  return el.querySelectorAll('[data-md-row]').filter((r) => r.style.display !== 'none');
}
function writes(transport, key) {
  return transport.sent.writes.filter((w) => w.key === key);
}
async function select(ctrl, dispatcher, i) {
  rowsOf(ctrl.el)[i].dispatchEvent({ type: 'click' });
  M.flushSync?.();
  await settle(dispatcher);
}

test('subscriptions: the list shows the caller\'s rows with a status badge only when not active', async () => {
  const transport = subscriptionTransport();
  const { dispatcher, api } = boot(transport);
  const { ctrl } = mountScreen(api);
  await settle(dispatcher);
  const rows = rowsOf(ctrl.el);
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /Assigned to me/);
  assert.match(rows[0].textContent, /Apollo — Project mail/);
  assert.match(rows[1].textContent, /Stopped/, 'faulted subscription badged');
});

test('subscriptions: + Add → pick "Project — Sink" → save creates for that sink and reloads the list', async () => {
  const transport = subscriptionTransport();
  const { dispatcher, api } = boot(transport);
  const { ctrl } = mountScreen(api);
  await settle(dispatcher);
  const listsBefore = transport.sent.lists;

  ctrl.el.querySelector('[data-record-form-new]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  await settle(dispatcher); // sink options land
  const picker = ctrl.el.querySelector('[data-record-form-field="sinkId"]');
  assert.ok(picker.children.some((o) => o.textContent === 'Hermes — Ops mail'), 'sink picker lists "Project — Sink"');
  assert.equal(ctrl.el.querySelector('[data-record-form-delete]'), null, 'no delete on an unsaved subscription');

  picker.value = '95';
  picker.dispatchEvent({ type: 'change' });
  await settle(dispatcher);
  // Picking the sink set the project the card filter's value pickers load for:
  // the project-scoped status values load under project 40; people unscoped.
  const loads = writes(transport, 'card.select_with_attributes');
  assert.ok(
    loads.some((w) => w.data.card_type_name === 'status' && String(w.data.parent_card_id) === '40'),
    `status options load for the picked sink's project (saw ${JSON.stringify(loads.map((w) => w.data))})`,
  );
  assert.ok(loads.some((w) => w.data.card_type_name === 'person' && w.data.parent_card_id === undefined), 'people load unscoped');
  const name = ctrl.el.querySelector('[data-record-form-field="name"]');
  name.value = 'Ops digest';
  name.dispatchEvent({ type: 'input' });
  const rollup = ctrl.el.querySelector('[data-record-form-field="rollupMinutes"]');
  rollup.value = '60';
  rollup.dispatchEvent({ type: 'input' });
  ctrl.el.querySelector('[data-record-form-save]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);

  const sets = writes(transport, 'activity_subscription.set');
  assert.equal(sets.length, 1);
  assert.deepEqual(sets[0].data, {
    name: 'Ops digest', activity_filter: '', card_filter: '', rollup_minutes: 60, sink_id: '95', enabled: true,
  });
  assert.ok(transport.sent.lists > listsBefore, 'list re-fetched after the write');
  assert.equal(rowsOf(ctrl.el).length, 3, 'the new subscription shows up');
});

test('subscriptions: editing without touching Enabled keeps a faulted row as-is; unchecking pauses', async () => {
  const transport = subscriptionTransport();
  const { dispatcher, api } = boot(transport);
  const { ctrl } = mountScreen(api);
  await settle(dispatcher);

  await select(ctrl, dispatcher, 1); // the faulted one
  assert.match(ctrl.el.querySelector('[data-record-form-field="statusLabel"]').textContent, /550 no such user/);
  assert.equal(ctrl.el.querySelector('[data-record-form-field="sinkId"]'), null, 'sink is fixed once created');
  assert.equal(ctrl.el.querySelector('[data-record-form-field="scopeLabel"]').textContent, 'Apollo — Project mail');
  ctrl.el.querySelector('[data-record-form-save]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  let sets = writes(transport, 'activity_subscription.set');
  assert.equal(sets.length, 1);
  assert.equal(sets[0].data.id, '8');
  assert.equal('enabled' in sets[0].data, false, 'untouched toggle not sent');

  await select(ctrl, dispatcher, 0);
  const box = ctrl.el.querySelector('[data-record-form-field="enabled"]');
  assert.equal(box.checked, true);
  box.checked = false;
  box.dispatchEvent({ type: 'change' });
  ctrl.el.querySelector('[data-record-form-save]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  sets = writes(transport, 'activity_subscription.set');
  assert.equal(sets.length, 2);
  assert.equal(sets[1].data.id, '7');
  assert.equal(sets[1].data.enabled, false, 'pause sent');
});

test('subscriptions: actor conditions offer "Me" and save it as @me', async () => {
  const transport = subscriptionTransport();
  const { dispatcher, api } = boot(transport);
  const { ctrl } = mountScreen(api);
  await settle(dispatcher);
  await select(ctrl, dispatcher, 0);

  const op = ctrl.el.querySelector('[data-af-op]');
  op.value = 'actor_not_in';
  op.dispatchEvent({ type: 'change' });
  const me = ctrl.el.querySelector('[data-af-choice="@me"]');
  assert.ok(me, '"Me" offered for actor conditions');
  me.checked = true;
  ctrl.el.querySelector('[data-af-add-btn]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  assert.equal(ctrl.el.querySelector('[data-af-leaf]').textContent.includes('Not done by me'), true);

  ctrl.el.querySelector('[data-record-form-save]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  const sets = writes(transport, 'activity_subscription.set');
  assert.deepEqual(JSON.parse(sets[0].data.activity_filter), { op: 'and', items: [{ op: 'actor_not_in', values: ['@me'] }] });
});

test('subscriptions: delete asks inline first, then deletes + reloads + clears the selection', async () => {
  const transport = subscriptionTransport();
  const { dispatcher, api } = boot(transport);
  const { ctrl, tree } = mountScreen(api);
  await settle(dispatcher);
  await select(ctrl, dispatcher, 0);

  ctrl.el.querySelector('[data-record-form-delete]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  assert.equal(writes(transport, 'activity_subscription.delete').length, 0, 'nothing deleted before confirming');
  assert.ok(ctrl.el.querySelector('[data-record-form-delete-confirm]'), 'inline confirm shown');

  ctrl.el.querySelector('[data-record-form-delete-cancel]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  assert.equal(ctrl.el.querySelector('[data-record-form-delete-confirm]'), null, 'cancel backs out');

  ctrl.el.querySelector('[data-record-form-delete]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  ctrl.el.querySelector('[data-record-form-delete-confirm]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  const dels = writes(transport, 'activity_subscription.delete');
  assert.equal(dels.length, 1);
  assert.deepEqual(dels[0].data, { id: '7' });
  assert.equal(rowsOf(ctrl.el).length, 1, 'list reloaded without the deleted row');
  assert.equal(tree.at(['user', 'subscriptions', 'selectedId']).peek(), null, 'selection cleared');
});

test('subscriptions: a server fault code shows its friendly inline message', async () => {
  const transport = subscriptionTransport({ setError: { code: 'no_email', message: 'person has no email' } });
  const { dispatcher, api } = boot(transport);
  const { ctrl } = mountScreen(api);
  await settle(dispatcher);
  await select(ctrl, dispatcher, 0);
  ctrl.el.querySelector('[data-record-form-save]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  const err = ctrl.el.querySelector('[data-record-form-error]');
  assert.notEqual(err.style.display, 'none');
  assert.equal(err.textContent, M.SUBSCRIPTION_FAULT_MESSAGES.no_email);
});

test('AccountPage mounts the Notifications section with the subscriptions manager', async () => {
  const transport = subscriptionTransport();
  const { dispatcher, api } = boot(transport);
  const tree = new M.TreeNode({}, []);
  const page = M.Control.New('AccountPage', { type: 'AccountPage' }, { api, tree, scope: {} });
  page.mount(new FakeElement('div'));
  await settle(dispatcher);
  const section = page.el.querySelector('[data-account-notifications]');
  assert.ok(section, 'notifications section rendered');
  assert.ok(section.querySelector('[data-control="MasterDetail"]'), 'subscriptions MasterDetail mounted');
  assert.equal(rowsOf(section).length, 2, 'the caller\'s subscriptions listed');
});
