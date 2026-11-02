/**
 * Conversations (docs/CONVERSATIONS.md), web half: trimming received replies
 * for display ("Show quoted text"), the thread page's route and detail
 * profile, the TASK section of a thread on its own (Attach to task… / Make a
 * task), and the mail account's New mail / Quoting settings.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
let FakeElement;
let setPath;
/** Configs the stub RefPicker was spawned with. */
const pickerConfigs = [];

before(async () => {
  ({ FakeElement, setPath } = installDomShim());
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerThreadPlacement();
  class StubPicker extends M.Control {
    createRoot() {
      const el = document.createElement('span');
      el.dataset.control = 'RefPicker';
      return el;
    }
    render() {
      pickerConfigs.push(this.config);
    }
  }
  M.Control.register('RefPicker', StubPicker);
});

beforeEach(() => {
  setPath('/projects');
  M._resetRouterForTest?.();
  pickerConfigs.length = 0;
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
  M.registerProjectSpecs(api);
  M.registerCommThreadSpecs(api);
  return { dispatcher, api };
}

async function settle(dispatcher) {
  for (let i = 0; i < 4; i++) await dispatcher.flushNow();
  M.flushSync?.();
}

/* -------------------------------------------------------------------------- */
/* Trimming received replies (the same cases as the server's TestSplitQuoted). */
/* -------------------------------------------------------------------------- */

const SPLIT_CASES = [
  ['plain', 'Thanks, that worked.', ''],
  ['on wrote', 'Thanks!\n\nOn 2026-11-02 Mon, Support <s@x.com> wrote:\n> Try again.\n', 'Thanks!'],
  ['gmail wrapped', 'Fixed.\n\nOn Mon, Nov 2, 2026 at 10:01 AM Support <s@x.com>\nwrote:\n\n> Try again.', 'Fixed.'],
  ['original message', 'See below.\n\n-----Original Message-----\nFrom: a\nSent: b\n\nold', 'See below.'],
  ['outlook block', 'Yes.\n\n________________________________\nFrom: Support <s@x.com>\nSent: Monday\nTo: me\nSubject: Re\n\nold', 'Yes.'],
  ['quote run to end', 'Sure.\n\n> old line\n>\n> more\n', 'Sure.'],
  ['kitp trailer only', 'Got it.\n\nTask: 42\nRef: Ab3dE5gH9k\n', 'Got it.'],
  ['quoted with trailer', 'Ok.\n\n> old\n> Ref: Ab3dE5gH9k\n', 'Ok.'],
  ['bottom-posted', '> your question\n\nmy answer', ''],
  ['inline replies', '> q1\na1\n> q2\na2', ''],
  ['all quoted', 'On Mon, Ada wrote:\n> everything', ''],
  ['crlf', 'Done.\r\n\r\n> old\r\n', 'Done.'],
  ['from without sent', 'From: the team, with thanks.\nBye', ''],
];

for (const [name, body, own] of SPLIT_CASES) {
  test(`splitQuoted: ${name}`, () => {
    const got = M.splitQuoted(body);
    if (own === '') {
      assert.deepEqual(got, { own: body, quoted: '' }, 'shown whole');
    } else {
      assert.equal(got.own, own);
      assert.notEqual(got.quoted.trim(), '', 'the quoted tail is kept');
    }
  });
}

test('replyBody folds a received message’s quoted history behind "Show quoted text"', () => {
  const listen = (el, ev, fn) => el.addEventListener(ev, fn);
  const [body, toggle, quoted] = M.replyBody('Thanks!\n\n> earlier', 'in', listen);
  assert.equal(body.textContent, 'Thanks!');
  assert.equal(toggle.textContent, 'Show quoted text');
  assert.equal(quoted.style.display, 'none');
  assert.equal(quoted.textContent, '> earlier');
  toggle.dispatchEvent({ type: 'click' });
  assert.equal(quoted.style.display, '');
  assert.equal(toggle.textContent, 'Hide quoted text');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  // Our own messages are stored without a quote: shown whole.
  const out = M.replyBody('Sent text\n\n> not ours to trim', 'out', listen);
  assert.equal(out.length, 1);
  assert.equal(out[0].textContent, 'Sent text\n\n> not ours to trim');
});

/* -------------------------------------------------------------------------- */
/* The thread page.                                                            */
/* -------------------------------------------------------------------------- */

test('a thread on its own has a route and the comm detail profile', () => {
  assert.equal(M.threadUrl(300n), '/thread/300');
  assert.equal(M.cardUrl('300', 'thread'), '/thread/300');
  assert.equal(M.matchRoute('/thread/300').name, 'thread');
  assert.equal(M.helpTopicForRoute(M.matchRoute('/thread/300')), 'task_detail');
  const p = M.detailProfile('comm');
  assert.equal(p.noun, 'Thread');
  assert.equal(p.route, 'thread');
  assert.equal(p.statusAttr, 'comm_status');
  assert.ok(p.sections.includes('placement') && p.sections.includes('comms'));
  assert.ok(!p.sections.includes('description'), 'the messages are the content');
  assert.equal(p.commsSelf, true);
  assert.deepEqual(p.parentRoute, { cardType: 'task', route: 'task' }, 'a thread on a task opens on the task');
  assert.equal(M.SECTION_AREA.placement, 'tasks', 'attach / make a task hide with Tasks');
  assert.ok(M.detailProfile('task').sections.includes('description'));
});

function placement(api, tree) {
  const c = M.Control.New(
    'ThreadPlacement',
    { type: 'ThreadPlacement', commId: '300', projectId: '31', title: 'Printer on fire' },
    { api, tree },
  );
  c.mount(new FakeElement('div'));
  return c;
}

const btn = (c, key) => c.el.querySelector(`[data-thread-placement="${key}"]`);

test('ThreadPlacement: Make a task creates the task in the project, attaches the thread, opens the task', async () => {
  const t = transportFor({
    'card.insert': () => ({ id: '900' }),
    'comm.attach': (d) => ({ comm_id: d.comm_id, parent_id: d.task_id, task_id: d.task_id }),
  });
  const { dispatcher, api } = bootApi(t.transport);
  const tree = new M.TreeNode({}, []);
  M.installRouter(tree);
  const c = placement(api, tree);
  btn(c, 'make').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  await settle(dispatcher);
  assert.deepEqual(t.of('card.insert')[0].data, { card_type_name: 'task', parent_card_id: '31', title: 'Printer on fire' });
  assert.deepEqual(t.of('comm.attach')[0].data, { comm_id: '300', task_id: '900' });
  assert.equal(M.peekRoute(tree)?.path ?? M.currentRoute?.(tree)?.path, '/task/900');
});

test('ThreadPlacement: Attach to task… picks a task in the project and attaches; a refusal shows inline', async () => {
  const t = transportFor({
    'comm.attach': () => ({ __error: { code: 'same_project', message: 'comm.attach: the task is in another project' } }),
  });
  const { dispatcher, api } = bootApi(t.transport);
  const tree = new M.TreeNode({}, []);
  M.installRouter(tree);
  const c = placement(api, tree);
  btn(c, 'attach').dispatchEvent({ type: 'click' });
  const cfg = pickerConfigs.at(-1);
  assert.equal(cfg.cardType, 'task');
  assert.equal(cfg.parentScopePath, 'scope.projectId');
  cfg.onChange(77n);
  await settle(dispatcher);
  assert.deepEqual(t.of('comm.attach')[0].data, { comm_id: '300', task_id: '77' });
  const err = c.el.querySelector('[data-thread-placement-error]');
  assert.equal(err.style.display, '');
  assert.match(err.textContent, /another project/);
  assert.equal(btn(c, 'attach').disabled, false, 'buttons come back after a refusal');
});

/* -------------------------------------------------------------------------- */
/* Mail account settings.                                                      */
/* -------------------------------------------------------------------------- */

test('channel draft: New mail keeps what an account did before the setting; Quoting defaults to the last message', () => {
  const base = { id: '5', name: 'Support', channelType: 'email', channelStatus: 'enabled', hasImapPassword: false, hasSmtpPassword: false };
  assert.equal(M.channelRowToDraft({ ...base, intakeStatusId: '54' }).intakeMode, 'task');
  assert.equal(M.channelRowToDraft({ ...base }).intakeMode, 'ignore');
  assert.equal(M.channelRowToDraft({ ...base, intakeMode: 'thread' }).intakeMode, 'thread');
  assert.equal(M.channelRowToDraft({ ...base }).replyQuote, 'last');
  assert.equal(M.channelRowToDraft({ ...base, replyQuote: 'all' }).replyQuote, 'all');
  assert.equal(M.emptyChannelDraft().intakeMode, 'task', 'a new account files new mail as tasks');
  const set = M.channelDraftToSet({ ...M.emptyChannelDraft(), name: 'Billing', intakeMode: 'thread', replyQuote: 'off' }, '31');
  assert.equal(set.intakeMode, 'thread');
  assert.equal(set.replyQuote, 'off');
  assert.deepEqual(M.INTAKE_MODE_OPTIONS.map((o) => o.value), ['task', 'thread', 'ignore']);
  assert.deepEqual(M.REPLY_QUOTE_OPTIONS.map((o) => o.value), ['off', 'last', 'all']);
});
