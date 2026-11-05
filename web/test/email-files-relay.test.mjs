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
 *     an existing one without the setting doesn't, and both round-trip;
 *   - a message's image / PDF / markdown opens in the shared viewer (paging
 *     through the thread's files) and every file downloads;
 *   - the reply box's Attach files picks the thread's and the task's files
 *     (or uploads one onto the thread), shows them with their size, sends
 *     them as attachment_ids, and holds a reply over 20 MB.
 */

import { test, before, beforeEach } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom, flushMicrotasks } from './ui-dom-setup.mjs';

let M;

const TASK = 59n;

let replies;
let calls;
let threadFiles;
let taskFiles;
const seeded = new Set();

function fileWire(id, filename, mime, size, kind, cardId) {
  return { id: String(id), card_id: String(cardId), file_id: String(id + 5000), filename, mime_type: mime, size_bytes: size, created_at: '2026-10-21T08:15:00.000Z', thumb_file_id: '0', kind };
}

function resetData() {
  calls = [];
  threadFiles = [fileWire(901, 'invoice.pdf', 'application/pdf', 2048, 'pdf', 145)];
  taskFiles = [fileWire(950, 'spec.md', 'text/markdown', 300, 'markdown', 59), fileWire(951, 'huge.zip', 'application/zip', 21 * 1024 * 1024, 'other', 59)];
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
  if (k === 'attachment.list') {
    const rows = String(sr.data.card_id) === '145' ? threadFiles : String(sr.data.card_id) === TASK.toString() ? taskFiles : [];
    return { id: sr.id, ok: true, data: { rows } };
  }
  if (k === 'reply.post') {
    return { id: sr.id, ok: true, data: { reply_id: '999' } };
  }
  if (k === 'cas.missing_chunks') {
    return { id: sr.id, ok: true, data: { missing: (sr.data.addresses ?? []).filter((a) => !seeded.has(a)) } };
  }
  if (k === 'file.create') {
    return { id: sr.id, ok: true, data: { id: '7001', filename: sr.data.filename, mime_type: sr.data.mime_type, size_bytes: 8 } };
  }
  if (k === 'attachment.create') {
    const row = fileWire(977, 'photo.png', 'image/png', 8, 'image', sr.data.card_id);
    threadFiles = [...threadFiles, row];
    return { id: sr.id, ok: true, data: row };
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
  M.registerAttachmentSpecs(api);
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
  {
    r: { id: 1n, to: 'bob@x.test, cy@x.test', deliveryStatus: 'sent', refused: 'cy@x.test', attachmentsLeftOff: 0 },
    want: 'Sent on to bob@x.test, cy@x.test · sent, but refused for cy@x.test',
  },
];
for (const c of RELAY_TEXT) {
  test(`relayText: ${c.want}`, () => {
    assert.equal(M.relayText(c.r), c.want);
  });
}

test('replyStatusText names who the server refused', () => {
  assert.equal(M.replyStatusText({ deliveryStatus: 'sent', refused: '' }), 'sent');
  assert.equal(M.replyStatusText({ deliveryStatus: 'sent', refused: 'cy@x.test' }), 'sent, but refused for cy@x.test');
  assert.equal(M.replyStatusText({ deliveryStatus: 'bounced', refused: '' }), 'bounced');
});

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

/* ------------------------------ viewing ------------------------------ */

function viewableReplies() {
  replies[0].attachments = [
    { id: '901', filename: 'invoice.pdf', mime_type: 'application/pdf', size_bytes: 2048, kind: 'pdf', on_thread: true },
    { id: '903', filename: 'data.csv', mime_type: 'text/csv', size_bytes: 20, kind: 'other', on_thread: true },
  ];
  replies[1].attachments = [{ id: '904', filename: 'photo.jpg', mime_type: 'image/jpeg', size_bytes: 99, kind: 'image', on_thread: true }];
}

test('a viewable file opens in the viewer and pages through the thread; others download', async () => {
  viewableReplies();
  const { dispatcher, api } = bootApi();
  const fetched = [];
  const fetchBlob = (url, onDone) => {
    fetched.push(url);
    onDone(new globalThis.Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }));
  };
  const c = mount(api, { fetchBlob });
  await settle(dispatcher);

  const pdf = c.el.querySelector('[data-reply-file="901"]');
  assert.ok(pdf.querySelector('[data-reply-file-download]'), 'a viewable file also has Download');
  assert.equal(pdf.querySelector('[data-reply-file-download]').getAttribute('href'), '/api/v1/attachment/901/download');
  const csv = c.el.querySelector('[data-reply-file="903"]');
  assert.equal(csv.querySelector('[data-reply-file-view]'), null, 'a csv has no viewer');
  assert.equal(csv.querySelector('a').getAttribute('href'), '/api/v1/attachment/903/download');

  pdf.querySelector('[data-reply-file-view="901"]').click();
  await flushMicrotasks();
  const gallery = document.querySelector('[data-attachments-gallery]');
  assert.ok(gallery, 'the viewer opened');
  assert.equal(gallery.querySelector('[data-gallery-caption]').textContent, 'invoice.pdf (1/2)', 'pages through the thread\'s viewable files');
  assert.ok(gallery.querySelector('iframe'), 'a PDF shows in a frame');
  assert.deepEqual(fetched, ['/api/v1/attachment/901/view']);

  gallery.querySelector('[data-gallery-next]').click();
  assert.equal(gallery.querySelector('[data-gallery-caption]').textContent, 'photo.jpg (2/2)');
  assert.ok(gallery.querySelector('img'), 'an image shows as an image');
  gallery.querySelector('[data-gallery-close]').click();
  assert.equal(document.querySelector('[data-attachments-gallery]'), null, 'closed');
});

test('destroying the thread view closes an open viewer', async () => {
  viewableReplies();
  const { dispatcher, api } = bootApi();
  const c = mount(api, { fetchBlob: (u, done) => done(new globalThis.Blob([new Uint8Array([1])])) });
  await settle(dispatcher);
  c.el.querySelector('[data-reply-file-view="904"]').click();
  assert.ok(document.querySelector('[data-attachments-gallery]'));
  c.destroy();
  assert.equal(document.querySelector('[data-attachments-gallery]'), null);
});

/* ------------------------------ picking ------------------------------ */

async function openPicker(c, dispatcher) {
  c.el.querySelector('[data-reply-attach]').click();
  await settle(dispatcher);
  return c.el.querySelector('[data-reply-picker]');
}

function typeReply(c, text) {
  const ta = c.el.querySelector('[data-reply-input]');
  ta.value = text;
  return ta;
}

test("Attach files lists the thread's and the task's files and sends the picked ones", async () => {
  const { dispatcher, api } = bootApi();
  const c = mount(api);
  await settle(dispatcher);
  const panel = await openPicker(c, dispatcher);
  assert.equal(panel.hidden, false);
  const lists = calls.filter((x) => x.k === 'attachment.list').map((x) => x.data.card_id).sort();
  assert.deepEqual(lists, ['145', TASK.toString()], 'loads the thread and the task');
  assert.ok(panel.querySelector('[data-reply-pick="901"]'), "the thread's file");
  assert.ok(panel.querySelector('[data-reply-pick="950"]'), "the task's file");

  for (const id of ['901', '950']) {
    const cb = panel.querySelector(`[data-reply-pick="${id}"]`);
    cb.checked = true;
    cb.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }));
  }
  const chips = [...c.el.querySelectorAll('[data-reply-picked-file]')].map((e) => e.dataset.replyPickedFile);
  assert.deepEqual(chips, ['901', '950']);
  assert.equal(c.el.querySelector('[data-reply-picked-total]').textContent, M.pickedSummary([2048, 300]).text);

  // × drops one again.
  c.el.querySelector('[data-reply-unpick="950"]').click();
  assert.deepEqual([...c.el.querySelectorAll('[data-reply-picked-file]')].map((e) => e.dataset.replyPickedFile), ['901']);

  typeReply(c, 'Invoice attached.');
  c.el.querySelector('[data-reply-send]').click();
  await settle(dispatcher);
  const post = calls.find((x) => x.k === 'reply.post');
  assert.deepEqual(post.data, { comm_id: '145', body: 'Invoice attached.', attachment_ids: ['901'] });
  assert.equal(c.el.querySelectorAll('[data-reply-picked-file]').length, 0, 'the picks clear after sending');
});

test('a reply over 20 MB is held, its text kept', async () => {
  const { dispatcher, api } = bootApi();
  const c = mount(api);
  await settle(dispatcher);
  const panel = await openPicker(c, dispatcher);
  const cb = panel.querySelector('[data-reply-pick="951"]');
  cb.checked = true;
  cb.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }));
  const total = c.el.querySelector('[data-reply-picked-total]');
  assert.ok(total.classList.contains('task-comms__over'));
  assert.match(total.textContent, /over the 20 MB a reply can carry/);
  const ta = typeReply(c, 'Too big.');
  c.el.querySelector('[data-reply-send]').click();
  await settle(dispatcher);
  assert.equal(calls.filter((x) => x.k === 'reply.post').length, 0, 'not sent');
  assert.equal(ta.value, 'Too big.', 'the text stays');
});

test("a thread's own page picks only the thread's files", async () => {
  const { dispatcher, api } = bootApi();
  const c = mount(api, { taskId: undefined, commId: '145' });
  await settle(dispatcher);
  const panel = await openPicker(c, dispatcher);
  assert.deepEqual(calls.filter((x) => x.k === 'attachment.list').map((x) => x.data.card_id), ['145']);
  assert.ok(panel.querySelector('[data-reply-pick="901"]'));
  assert.equal(panel.querySelector('[data-reply-pick="950"]'), null);
});

test('an upload from the reply box lands on the thread and is picked', async () => {
  const { dispatcher, api } = bootApi();
  const postChunk = (blob, onDone) => {
    void (async () => {
      const buf = new Uint8Array(await blob.arrayBuffer());
      const address = createHash('sha256').update(Buffer.from(buf)).digest('hex');
      seeded.add(address);
      onDone({ address, sizeBytes: buf.length });
    })();
  };
  const c = mount(api, { postChunk });
  await settle(dispatcher);
  const panel = await openPicker(c, dispatcher);
  const input = panel.querySelector('[data-reply-upload]');
  const file = new globalThis.File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'photo.png', { type: 'image/png' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }));
  for (let i = 0; i < 4; i++) await settle(dispatcher);
  const create = calls.find((x) => x.k === 'attachment.create');
  assert.ok(create, 'attachment.create ran');
  assert.equal(String(create.data.card_id), '145', 'onto the thread');
  assert.deepEqual([...c.el.querySelectorAll('[data-reply-picked-file]')].map((e) => e.dataset.replyPickedFile), ['977'], 'and picked');
});

test('pickedSummary counts and flags the limit', () => {
  assert.deepEqual(M.pickedSummary([]), { text: '', over: false });
  assert.equal(M.pickedSummary([1024]).text, `1 file, ${M.formatBytes(1024)}`);
  assert.equal(M.pickedSummary([M.MAX_REPLY_FILE_BYTES, 1]).over, true);
  assert.equal(M.pickedSummary([M.MAX_REPLY_FILE_BYTES]).over, false);
});
