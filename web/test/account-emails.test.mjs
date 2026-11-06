/**
 * Account → Email addresses (docs/EMAIL_ADDRESSES.md): the row notes, the
 * account-mail picker's labels, and the view driven through a mock
 * transport — add an address, enter its code, make it the primary.
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
  M.registerAccountEmails();
});

function transport(handlers) {
  const sent = [];
  return {
    sent,
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => {
        const key = `${sr.endpoint}.${sr.action}`;
        sent.push({ key, data: sr.data ?? {} });
        const h = handlers[key];
        if (h === undefined) return { id: sr.id, ok: false, error: { code: 'unknown_handler', message: `mock has no ${key}` } };
        const out = h(sr.data ?? {});
        if (out && out.__error) return { id: sr.id, ok: false, error: out.__error };
        return { id: sr.id, ok: true, data: out };
      });
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
}

function boot(t) {
  const dispatcher = new M.Dispatcher({ transport: t });
  const api = new M.Api(dispatcher);
  M.registerEmailSpecs(api);
  return { dispatcher, api };
}

async function settle(dispatcher) {
  for (let i = 0; i < 4; i++) await dispatcher.flushNow();
  M.flushSync?.();
}

function mount(api, type, cfg) {
  const ctrl = M.Control.New(type, { type, ...cfg }, { api, tree: new M.TreeNode({}, []), scope: {} });
  ctrl.mount(new FakeElement('div'));
  return ctrl;
}

const click = (el) => el.dispatchEvent({ type: 'click' });
const type = (el, v) => {
  el.value = v;
  el.dispatchEvent({ type: 'input' });
};

test('addressNote and accountMailLabel', () => {
  assert.equal(M.addressNote({ email: 'a@x', source: 'signin', verified: true, primary: true }), 'From your sign-in');
  assert.equal(M.addressNote({ email: 'a@x', source: 'added', verified: true, primary: false }, false), 'Added by them');
  assert.equal(M.addressNote({ email: 'a@x', source: 'added', verified: false, primary: false }), 'Waiting for its code');
  assert.equal(M.addressNote({ email: 'a@x', source: 'card', verified: true, primary: true }), '');
  assert.equal(M.addressNote({ email: 'a@x', source: 'card', verified: false, primary: true }), 'Not verified');
  assert.equal(M.accountMailLabel({ id: '1', name: 'Support', project: 'Ops', fromAddress: 'help@x' }), 'Support (Ops) — help@x');
  assert.equal(M.accountMailLabel({ id: '1', name: '', project: '', fromAddress: 'help@x' }), 'help@x — help@x');
});

test('AccountEmails adds an address, verifies it with its code and makes it the primary', async () => {
  const state = {
    primary: 'ada@corp.example',
    rows: [{ email: 'ada@corp.example', source: 'signin', verified: true, primary: true }],
  };
  const list = () => ({
    person_id: '9',
    primary: state.primary,
    can_add: true,
    addresses: state.rows.map((r) => ({ ...r, primary: r.email === state.primary })),
  });
  const t = transport({
    'person_email.list': list,
    'person_email.add': (d) => {
      state.rows.push({ email: d.email, source: 'added', verified: false, primary: false, code_expires_at: '2026-11-06T10:00:00Z' });
      return { email: d.email, sender_channel_id: '5' };
    },
    'person_email.verify': (d) => {
      if (d.code !== 'ABCDE-FGHJK') return { __error: { code: 'invalid_code', message: 'person_email.verify: that code doesn\'t match' } };
      state.rows.find((r) => r.email === d.email).verified = true;
      return { email: d.email, verified: true };
    },
    'person_email.set_primary': (d) => {
      state.primary = d.email;
      return { email: d.email };
    },
  });
  const { dispatcher, api } = boot(t);
  const ctrl = mount(api, 'AccountEmails', {});
  await settle(dispatcher);
  const corp = ctrl.el.querySelector('[data-email="ada@corp.example"]');
  assert.match(corp.textContent, /Primary/);
  assert.match(corp.textContent, /From your sign-in/);
  assert.equal(corp.querySelector('[data-email-remove]'), null, 'the primary has no Remove');

  type(ctrl.el.querySelector('[data-email-new]'), 'ada@home.example');
  click(ctrl.el.querySelector('[data-email-add]'));
  await settle(dispatcher);
  assert.deepEqual(t.sent.find((s) => s.key === 'person_email.add').data, { email: 'ada@home.example' });
  const home = () => ctrl.el.querySelector('[data-email="ada@home.example"]');
  assert.match(home().textContent, /Waiting for its code/);
  assert.match(ctrl.el.textContent, /We sent a code to ada@home\.example/);

  type(home().querySelector('[data-email-code="ada@home.example"]'), 'nope');
  click(home().querySelector('[data-email-verify]'));
  await settle(dispatcher);
  assert.match(ctrl.el.textContent, /That code doesn’t match/);

  type(home().querySelector('[data-email-code="ada@home.example"]'), 'ABCDE-FGHJK');
  click(home().querySelector('[data-email-verify]'));
  await settle(dispatcher);
  assert.match(home().textContent, /Added by you/);
  click(home().querySelector('[data-email-primary]'));
  await settle(dispatcher);
  assert.match(home().textContent, /Primary/);
  assert.ok(ctrl.el.querySelector('[data-email="ada@corp.example"]').querySelector('[data-email-remove]'), 'the old primary can now be removed');
});

test('AccountEmails says why an address can’t be added when no mail account sends codes', async () => {
  const t = transport({
    'person_email.list': () => ({ person_id: '9', primary: 'a@x.example', can_add: false, addresses: [{ email: 'a@x.example', source: 'card', verified: true, primary: true }] }),
  });
  const { dispatcher, api } = boot(t);
  const ctrl = mount(api, 'AccountEmails', {});
  await settle(dispatcher);
  assert.equal(ctrl.el.querySelector('[data-email-new]'), null);
  assert.match(ctrl.el.textContent, /an admin first chooses the mail account/);
});
