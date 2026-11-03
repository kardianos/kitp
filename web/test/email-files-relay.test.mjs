/**
 * Files from email and sending replies on (docs/MAIL_INTAKE_AND_CALENDARS.md,
 * "Files from email", "Attachments from email", "Sending replies on"):
 *   - comm.list_for_task decodes a message's files, the files left off and
 *     the copy sent on;
 *   - the conversation shows each file (a download link), Add to task for a
 *     file that is still the thread's on a task's threads, "on the task" for
 *     one that moved, the left-off note and "Sent on to …";
 *   - Add to task calls comm.attachment_to_task, reloads the thread and tells
 *     the page its files changed;
 *   - the mail account form's two settings: a new account sends replies on,
 *     an existing one without the setting doesn't, and both round-trip.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom, flushMicrotasks } from './ui-dom-setup.mjs';

let M;

const TASK = 59n;

let replies;
let calls;

function resetData() {
  calls = [];
  replies = [
    {
      id: '801', to: 'support@acme.test', from: 'Ada <ada@example.com>',
      from_name: 'Ada', from_address: 'ada@example.com', author_id: '0',
      subject: 'Invoice', body_text: 'Attached.', delivery_status: 'received',
      created_at: '2026-10-21T08:15:00.000Z',
      attachments: [
        { id: '901', filename: 'invoice.pdf', mime_type: 'application/pdf', size_bytes: 2048, on_thread: true },
        { id: '902', filename: 'terms.pdf', mime_type: 'application/pdf', size_bytes: 10, on_thread: false },
      ],
      attachments_left_off: 0,
      relay: { id: '803', to: 'bob@example.com', delivery_status: 'sent', attachments_left_off: 0 },
    },
    {
      id: '802', to: 'support@acme.test', from: 'Ada <ada@example.com>',
      from_name: 'Ada', from_address: 'ada@example.com', author_id: '0',
      subject: 'Photos', body_text: 'Photos.', delivery_status: 'received',
      created_at: '2026-10-21T09:15:00.000Z',
      attachments: [],
      attachments_left_off: 2,
    },
  ];
}

before(async () => {
  installUiDom();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerRefPicker();
  M.registerTransitionBar();
  M.registerCommThreads();
});

beforeEach(() => {
  document.body.replaceChildren();
  resetData();
});

function respond(sr) {
  const k = `${sr.endpoint}.${sr.action}`;
  calls.push({ k, data: sr.data ?? {} });
  if (k === 'comm.list_for_task') {
    return {
      id: sr.id,
      ok: true,
      data: {
        rows: [{ id: '145', title: 'Invoice', thread_id: 'aaa', channel_id: '144', comm_status: '54', recipients: [], replies }],
      },
    };
  }
  if (k === 'comm.attachment_to_task') {
    return { id: sr.id, ok: true, data: { attachment_id: String(sr.data.attachment_id), task_id: TASK.toString() } };
  }
  if (k === 'card.select_with_attributes' || k === 'flow_step.list_for_card' || k === 'card.search') {
    return { id: sr.id, ok: true, data: { rows: [] } };
  }
  return { id: sr.id, ok: false, error: { code: 'unknown', message: k } };
}

function bootApi() {
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      return { status: 200, text: JSON.stringify({ subresponses: req.subrequests.map(respond) }) };
    },
  };
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api);
  M.registerCommThreadSpecs(api);
  M.registerTransitionSpecs(api);
  return { dispatcher, api };
}

async function settle(dispatcher) {
  for (let i = 0; i < 8; i++) await dispatcher.flushNow();
  await flushMicrotasks();
  for (let i = 0; i < 4; i++) await dispatcher.flushNow();
  await flushMicrotasks();
}

function mount(api, extra = {}) {
  const tree = new M.TreeNode({}, []);
  const ctx = { api, tree };
  const c = M.Control.New('CommThreads', { type: 'CommThreads', taskId: TASK.toString(), ...extra }, ctx);
  c.mount(document.createElement('div'));
  document.body.appendChild(c.el);
  return c;
}

test('a message shows its files, Add to task, the copy sent on and the files left off', async () => {
  const { dispatcher, api } = bootApi();
  const c = mount(api);
  await settle(dispatcher);

  const first = c.el.querySelector('[data-reply-row="801"]');
  const files = first.querySelectorAll('[data-reply-file]');
  assert.equal(files.length, 2);
  const link = files[0].querySelector('a');
  assert.equal(link.textContent, 'invoice.pdf');
  assert.equal(link.getAttribute('href'), '/api/v1/attachment/901/download');
  assert.ok(files[0].querySelector('[data-reply-file-add="901"]'), 'a thread file on a task offers Add to task');
  assert.equal(files[1].querySelector('[data-reply-file-add]'), null, 'a file on the task has no Add');
  assert.ok(files[1].querySelector('[data-reply-file-on-task]'), 'a moved file says it is on the task');
  const relay = first.querySelector('[data-reply-relay]');
  assert.equal(relay.dataset.replyRelay, 'sent');
  assert.equal(relay.textContent.trim(), 'Sent on to bob@example.com · sent');

  const second = c.el.querySelector('[data-reply-row="802"]');
  assert.equal(second.querySelector('[data-reply-files]'), null);
  assert.equal(second.querySelector('[data-reply-left-off]').textContent, M.leftOffText(2));
  assert.equal(second.querySelector('[data-reply-relay]'), null);
});

test('Add to task moves the file, reloads the thread and tells the page', async () => {
  const { dispatcher, api } = bootApi();
  let changed = 0;
  const c = mount(api, { onFilesChanged: () => changed++ });
  await settle(dispatcher);
  const lists = calls.filter((x) => x.k === 'comm.list_for_task').length;

  c.el.querySelector('[data-reply-file-add="901"]').click();
  await settle(dispatcher);
  const call = calls.find((x) => x.k === 'comm.attachment_to_task');
  assert.deepEqual(call.data, { comm_id: '145', attachment_id: '901' });
  assert.equal(changed, 1, 'onFilesChanged fired');
  assert.ok(calls.filter((x) => x.k === 'comm.list_for_task').length > lists, 'the thread reloaded');
});

test("a thread's own page (a thread on its own) has no Add to task", async () => {
  const { dispatcher, api } = bootApi();
  const c = mount(api, { taskId: undefined, commId: '145' });
  await settle(dispatcher);
  assert.ok(c.el.querySelector('[data-reply-file="901"]'));
  assert.equal(c.el.querySelector('[data-reply-file-add]'), null);
});

const RELAY_TEXT = [
  { r: { id: 1n, to: 'bob@x.test', deliveryStatus: 'pending', attachmentsLeftOff: 0 }, want: 'Sent on to bob@x.test · queued' },
  { r: { id: 1n, to: 'bob@x.test', deliveryStatus: 'failed', attachmentsLeftOff: 0 }, want: 'Sent on to bob@x.test · not sent' },
  {
    r: { id: 1n, to: 'bob@x.test, cy@x.test', deliveryStatus: 'sent', attachmentsLeftOff: 2 },
    want: 'Sent on to bob@x.test, cy@x.test · sent (without its 2 attachments: too large to send)',
  },
  {
    r: { id: 1n, to: 'bob@x.test', deliveryStatus: 'bounced', attachmentsLeftOff: 1 },
    want: 'Sent on to bob@x.test · bounced (without its attachment: too large to send)',
  },
];
for (const c of RELAY_TEXT) {
  test(`relayText: ${c.want}`, () => {
    assert.equal(M.relayText(c.r), c.want);
  });
}

test('leftOffText counts one and many', () => {
  assert.match(M.leftOffText(1), /^1 attachment was left off/);
  assert.match(M.leftOffText(3), /^3 attachments were left off/);
});

const DRAFTS = [
  { label: 'a new account sends replies on and keeps files', row: null, relay: 'on', files: 'keep' },
  { label: 'an account from before the settings: off, keep', row: {}, relay: 'off', files: 'keep' },
  { label: 'stored values come back', row: { relayReplies: 'on', emailAttachments: 'drop' }, relay: 'on', files: 'drop' },
  { label: 'relay switched off', row: { relayReplies: 'off' }, relay: 'off', files: 'keep' },
];
for (const c of DRAFTS) {
  test(`mail account draft: ${c.label}`, () => {
    const draft =
      c.row === null
        ? M.emptyChannelDraft()
        : M.channelRowToDraft({ id: '80', name: 'X', channelType: 'email', channelStatus: 'enabled', hasImapPassword: false, hasSmtpPassword: false, ...c.row });
    assert.equal(draft.relayReplies, c.relay);
    assert.equal(draft.emailAttachments, c.files);
    draft.name = 'X';
    const input = M.channelDraftToSet(draft, '7');
    assert.equal(input.relayReplies, c.relay);
    assert.equal(input.emailAttachments, c.files);
  });
}

test('the two settings offer exactly the server values', () => {
  assert.deepEqual(M.RELAY_REPLIES_OPTIONS.map((o) => o.value), ['on', 'off']);
  assert.deepEqual(M.EMAIL_ATTACHMENTS_OPTIONS.map((o) => o.value), ['keep', 'drop']);
});
