// PeopleManager (#11): the unified People admin screen — one persons list with
// Users / Assignees / Contacts segment toggles + promote/demote, replacing the
// separate Contacts + Users screens.
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
  M.registerPeopleManager();
});

// 701 = contact, 702 = assignee (member, no account), 703 = user (member + account 900).
function recordingTransport() {
  const sent = { updates: [], grants: [], unlinks: [], creates: [], deletes: [] };
  function respond(sr) {
    const k = `${sr.endpoint}.${sr.action}`;
    const data = sr.data ?? {};
    if (k === 'card.select_with_attributes') {
      return {
        id: sr.id, ok: true,
        data: { rows: [
          { id: '701', card_type_name: 'person', attributes: { title: 'Carol Contact', person_kind: 'contact', email: 'carol@x.com' } },
          { id: '702', card_type_name: 'person', attributes: { title: 'Avery Assignee', person_kind: 'member' } },
          { id: '703', card_type_name: 'person', attributes: { title: 'Uma User', person_kind: 'member', email: 'uma@x.com' } },
        ] },
      };
    }
    if (k === 'user.list_with_roles') {
      return { id: sr.id, ok: true, data: { rows: [
        { id: '900', display_name: 'Uma User', email: 'uma@x.com', is_agent: false, person_card_id: '703', roles: [] },
      ] } };
    }
    if (k === 'attribute.update') { sent.updates.push(data); return { id: sr.id, ok: true, data: { ok: true } }; }
    if (k === 'person.grant_account') { sent.grants.push(data); return { id: sr.id, ok: true, data: { user_account_id: '901' } }; }
    if (k === 'user.unlink_person') { sent.unlinks.push(data); return { id: sr.id, ok: true, data: { ok: true, deleted: 1 } }; }
    if (k === 'person.create') { sent.creates.push(data); return { id: sr.id, ok: true, data: { person_card_id: '704', user_account_id: '0' } }; }
    if (k === 'card.delete') { sent.deletes.push(data); return { id: sr.id, ok: true, data: { ok: true, activity_id: '9' } }; }
    return { id: sr.id, ok: false, error: { code: 'unknown', message: k } };
  }
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      return { status: 200, text: JSON.stringify({ subresponses: req.subrequests.map(respond) }) };
    },
  };
  transport.sent = sent;
  return transport;
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api); // card.select_with_attributes + attribute.update
  M.registerAdminSpecs(api); // user.list_with_roles + person.create/grant_account + user.unlink_person
  M.registerFilterCardSpecs(api); // card.delete (the Remove affordance)
  return { dispatcher, api };
}

async function settle(dispatcher) {
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  M.flushSync?.();
}

function mount(api) {
  const tree = new M.TreeNode({}, []);
  const ctrl = M.Control.New('PeopleManager', { type: 'PeopleManager' }, { api, tree });
  ctrl.mount(new FakeElement('div'));
  return { ctrl, tree };
}

const seg = (ctrl, value) => ctrl.el.querySelector(`[data-people-segment="${value}"]`);
const rowIds = (ctrl) => ctrl.el.querySelectorAll('[data-people-row]').map((r) => r.dataset.peopleRow);

test('PeopleManager classifies + segment toggles filter (contact/assignee/user) (#11)', async () => {
  const { dispatcher, api } = bootApi(recordingTransport());
  const { ctrl } = mount(api);
  await settle(dispatcher);

  // "All" shows every person, classified by tier.
  assert.deepEqual(rowIds(ctrl).sort(), ['701', '702', '703']);
  const tierOf = (id) => ctrl.el.querySelector(`[data-people-row="${id}"]`).dataset.tier;
  assert.equal(tierOf('701'), 'contact');
  assert.equal(tierOf('702'), 'assignee');
  assert.equal(tierOf('703'), 'user', 'a person with a linked account is a user');

  // Segment toggles filter the list.
  seg(ctrl, 'user').dispatchEvent({ type: 'click' });
  assert.deepEqual(rowIds(ctrl), ['703']);
  seg(ctrl, 'contact').dispatchEvent({ type: 'click' });
  assert.deepEqual(rowIds(ctrl), ['701']);
});

test('PeopleManager promote assignee→user fires attribute.update + person.grant_account', async () => {
  const transport = recordingTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mount(api);
  await settle(dispatcher);

  const sel = ctrl.el.querySelector('[data-people-row="702"]').querySelector('[data-people-tier]');
  sel.value = 'user';
  sel.dispatchEvent({ type: 'change', target: sel });
  await settle(dispatcher);

  assert.equal(transport.sent.updates.length, 1, 'person_kind set to member');
  assert.equal(transport.sent.updates[0].attribute_name, 'person_kind');
  assert.equal(transport.sent.updates[0].value, 'member');
  assert.equal(transport.sent.grants.length, 1, 'a login was granted');
  assert.equal(String(transport.sent.grants[0].person_card_id), '702');
  assert.equal(transport.sent.unlinks.length, 0);
});

test('PeopleManager demote user→assignee fires attribute.update + user.unlink_person', async () => {
  const transport = recordingTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mount(api);
  await settle(dispatcher);

  const sel = ctrl.el.querySelector('[data-people-row="703"]').querySelector('[data-people-tier]');
  sel.value = 'assignee';
  sel.dispatchEvent({ type: 'change', target: sel });
  await settle(dispatcher);

  assert.equal(transport.sent.unlinks.length, 1, 'the login was revoked');
  assert.equal(String(transport.sent.unlinks[0].user_account_id), '900', 'unlinks the linked account');
  assert.equal(transport.sent.grants.length, 0);
});

test('PeopleManager "+ New" opens a modal (Name/Email/Type), Type defaults to the active segment', async () => {
  const transport = recordingTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mount(api);
  await settle(dispatcher);

  // Active segment = Contacts → the modal Type defaults to 'contact'.
  seg(ctrl, 'contact').dispatchEvent({ type: 'click' });
  ctrl.el.querySelector('[data-people-new]').dispatchEvent({ type: 'click' });

  // A modal opened — the three fields are present (no prompt was used).
  assert.ok(ctrl.el.querySelector('[data-pm-modal]'), 'modal opened');
  const nameInput = ctrl.el.querySelector('[data-people-new-name]');
  const typeSel = ctrl.el.querySelector('[data-people-new-type]');
  assert.ok(nameInput && typeSel, 'Name + Type fields present');
  assert.equal(typeSel.value, 'contact', 'Type defaults to the active segment tier');

  // Name required; a contact needs no email.
  const submit = ctrl.el.querySelector('[data-people-new-submit]');
  assert.equal(submit.disabled, true, 'Create disabled until a name is entered');
  nameInput.value = 'New Person';
  nameInput.dispatchEvent({ type: 'input', target: nameInput });
  assert.equal(submit.disabled, false, 'Create enabled once a name is set (contact needs no email)');

  submit.dispatchEvent({ type: 'click', target: submit });
  await settle(dispatcher);

  assert.equal(transport.sent.creates.length, 1, 'person.create fired');
  assert.equal(transport.sent.creates[0].tier, 'contact', 'created with the active segment tier');
  assert.equal(transport.sent.creates[0].title, 'New Person');
  assert.equal(ctrl.el.querySelector('[data-pm-modal]'), null, 'modal closed after create');
});

test('PeopleManager "+ New" requires an email when Type=User', async () => {
  const transport = recordingTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mount(api);
  await settle(dispatcher);

  ctrl.el.querySelector('[data-people-new]').dispatchEvent({ type: 'click' });
  const nameInput = ctrl.el.querySelector('[data-people-new-name]');
  const emailInput = ctrl.el.querySelector('[data-people-new-email]');
  const typeSel = ctrl.el.querySelector('[data-people-new-type]');
  const submit = ctrl.el.querySelector('[data-people-new-submit]');

  nameInput.value = 'Login Person';
  nameInput.dispatchEvent({ type: 'input', target: nameInput });
  typeSel.value = 'user';
  typeSel.dispatchEvent({ type: 'change', target: typeSel });
  assert.equal(submit.disabled, true, 'a user with no email cannot be created');

  emailInput.value = 'login@x.com';
  emailInput.dispatchEvent({ type: 'input', target: emailInput });
  assert.equal(submit.disabled, false, 'enabled once the email is supplied');

  submit.dispatchEvent({ type: 'click', target: submit });
  await settle(dispatcher);

  assert.equal(transport.sent.creates.length, 1);
  assert.equal(transport.sent.creates[0].tier, 'user');
  assert.equal(transport.sent.creates[0].email, 'login@x.com', 'email threaded to person.create');
});

test('PeopleManager Remove a contact: confirm dialog → card.delete (no unlink)', async () => {
  const transport = recordingTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mount(api);
  await settle(dispatcher);

  ctrl.el.querySelector('[data-people-row="701"]').querySelector('[data-people-remove]')
    .dispatchEvent({ type: 'click' });
  assert.ok(ctrl.el.querySelector('[data-pm-modal]'), 'confirm modal opened');
  ctrl.el.querySelector('[data-people-remove-confirm]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);

  assert.equal(transport.sent.deletes.length, 1, 'card.delete fired');
  assert.equal(String(transport.sent.deletes[0].card_id), '701', 'soft-deletes the contact card');
  assert.equal(transport.sent.unlinks.length, 0, 'a contact has no login to revoke');
  assert.equal(ctrl.el.querySelector('[data-pm-modal]'), null, 'modal closed after remove');
});

test('PeopleManager Remove a user: confirm → user.unlink_person + card.delete', async () => {
  const transport = recordingTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mount(api);
  await settle(dispatcher);

  ctrl.el.querySelector('[data-people-row="703"]').querySelector('[data-people-remove]')
    .dispatchEvent({ type: 'click' });
  ctrl.el.querySelector('[data-people-remove-confirm]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);

  assert.equal(transport.sent.unlinks.length, 1, 'the login was revoked first');
  assert.equal(String(transport.sent.unlinks[0].user_account_id), '900', 'unlinks the linked account');
  assert.equal(transport.sent.deletes.length, 1, 'then the person card is soft-deleted');
  assert.equal(String(transport.sent.deletes[0].card_id), '703');
});
