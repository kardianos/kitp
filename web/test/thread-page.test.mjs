/**
 * A thread's own page (/thread/:id, docs/CONVERSATIONS.md): TaskDetail with
 * the comm profile.
 *
 *   - It paints once, complete: the project's areas (which sections show),
 *     the labels of its card_ref values and the "is the parent a task?"
 *     check are in before the first paint, so no section shows and then
 *     vanishes and no "#160" turns into "Help Desk" a moment later.
 *   - The comm cards are read once (the parent check doesn't re-read them).
 *   - A thread on a task opens on the task, without painting the thread.
 *   - The CONVERSATION section doesn't repeat what the header shows: no
 *     subject, status badge or status actions, no phase filter, and the
 *     heading stays CONVERSATION.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom, flushMicrotasks } from './ui-dom-setup.mjs';

let M;

before(async () => {
  installUiDom();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  for (const reg of [
    M.registerCombobox,
    M.registerDatePicker,
    M.registerRefPicker,
    M.registerFieldEditor,
    M.registerCardRefValue,
    M.registerAttributeRow,
    M.registerTaskAttributePanel,
    M.registerTaskDetail,
    M.registerTaskComments,
    M.registerCommThreads,
    M.registerTransitionBar,
    M.registerAttachmentsSection,
    M.registerThreadPlacement,
  ]) {
    try {
      reg();
    } catch {
      /* already registered in this process */
    }
  }
});

beforeEach(() => {
  document.body.replaceChildren();
});

const def = (name, valueType, target, ordering) => ({
  id: `def-${name}`,
  name,
  value_type: valueType,
  is_built_in: true,
  ...(target ? { target_card_type_name: target } : {}),
  bound_to: [{ card_type_id: '9', card_type_name: 'comm', ordering }],
});
const DEFS = [
  def('title', 'text', null, 0),
  def('comm_status', 'card_ref', 'status', 1),
  def('channel_ref', 'card_ref', 'comm_channel', 2),
  def('thread_id', 'text', null, 3),
];

/**
 * Serves one thread (#161, "Printer on fire", channel #160 "Help Desk") whose
 * parent is `parentId`: the project 145, or a task when `parentIsTask`. Tasks
 * is switched off in the project. At every POST it records what the page
 * shows at that moment, so a test can check nothing flashed between round
 * trips.
 */
function threadTransport({ parentId = '145', parentIsTask = false, tasksState = 'off' } = {}) {
  const sent = [];
  const sentData = [];
  const seen = [];
  let td = null;
  const comm = {
    id: '161',
    card_type_id: '9',
    card_type_name: 'comm',
    parent_card_id: parentId,
    attributes: { title: 'Printer on fire', comm_status: '155', channel_ref: '160', thread_id: 'Ab3dE5gH9k' },
  };
  const row = { id: '161', title: 'Printer on fire', thread_id: 'Ab3dE5gH9k', channel_id: '160', comm_status: '155', recipients: [], replies: [], acked: false };
  function respond(sr) {
    const key = `${sr.endpoint}.${sr.action}`;
    const d = sr.data ?? {};
    const ok = (data) => ({ id: sr.id, ok: true, data });
    switch (key) {
      case 'card.select_with_attributes':
        if (d.card_type_name === 'comm') return ok({ rows: [comm] });
        if (d.card_type_name === 'status') return ok({ rows: [{ id: '155', card_type_name: 'status', phase: 'active', attributes: { title: 'Open' } }] });
        return ok({ rows: [] });
      case 'attribute_def.select':
        return ok({ rows: DEFS });
      case 'card.search': {
        if (d.card_type_name === 'comm_channel') return ok({ rows: [{ id: '160', title: 'Help Desk' }] });
        if (d.card_type_name === 'status') return ok({ rows: [{ id: '155', title: 'Open' }] });
        if (d.card_type_name === 'task') return ok({ rows: parentIsTask ? [{ id: parentId, title: 'Fix the printer' }] : [] });
        return ok({ rows: [] });
      }
      case 'area.list':
        return ok({ areas: [
          { key: 'tasks', title: 'Tasks', doc: '', scope: 'project', sort: 10, state: tasksState, depends_on: [], starts: [], added: [], screens: [], items: null },
          { key: 'conversations', title: 'Conversations', doc: '', scope: 'project', sort: 20, state: 'on', depends_on: [], starts: [], added: [], screens: [], items: null },
        ] });
      case 'comm.list_for_task':
        return ok({ rows: [row] });
      case 'activity.select':
      case 'user.select':
      case 'attachment.list':
      case 'flow_step.list_for_card':
        return ok({ rows: [] });
      default:
        return { id: sr.id, ok: false, error: { code: 'unknown', message: `mock has no ${key}` } };
    }
  }
  const snapshot = () => {
    if (td === null) return;
    const main = td.el.querySelector('.task-detail__main') ?? td.el.querySelector('[data-task-detail-grid] > :nth-child(3)');
    const loading = td.el.querySelector('[data-task-detail-loading]');
    const placement = td.el.querySelector('[data-control="ThreadPlacement"]');
    seen.push({
      painted: loading.style.display === 'none',
      raw160: /#160\b/.test(td.el.textContent),
      placement: placement !== null && placement.parentElement.style.display !== 'none',
      main: main !== null,
    });
  };
  const transport = {
    async send(body) {
      snapshot();
      const req = JSON.parse(body);
      for (const s of req.subrequests) {
        sent.push(`${s.endpoint}.${s.action}${s.data?.card_type_name ? `:${s.data.card_type_name}` : ''}`);
        sentData.push(s);
      }
      return { status: 200, text: JSON.stringify({ subresponses: req.subrequests.map(respond) }) };
    },
  };
  return { transport, sent, sentData, seen, setDetail: (c) => (td = c) };
}

function boot(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api);
  M.registerGridCardRefAttrs();
  M.registerAdminSpecs(api);
  M.registerCardSearchSpec(api);
  M.registerCommentSpecs(api);
  M.registerCommThreadSpecs(api);
  M.registerTransitionSpecs(api);
  M.registerAttachmentSpecs(api);
  M.registerProjectSpecs(api); // area.list
  return { dispatcher, api };
}

async function settle(dispatcher) {
  for (let i = 0; i < 6; i++) {
    await dispatcher.flushNow();
    M.flushSync?.();
    await flushMicrotasks();
  }
  M.flushSync?.();
}

function mountThread(api, tree = new M.TreeNode({}, [])) {
  const td = M.Control.New('TaskDetail', { type: 'TaskDetail', taskId: '161', cardTypeName: 'comm' }, { api, tree });
  td.mount(document.createElement('div'));
  document.body.appendChild(td.el);
  return td;
}

test('thread page: paints once, complete — no section of an off area flashes, no raw #id label', async () => {
  const t = threadTransport();
  const { dispatcher, api } = boot(t.transport);
  const td = mountThread(api);
  t.setDetail(td);
  await settle(dispatcher);

  const loading = td.el.querySelector('[data-task-detail-loading]');
  assert.equal(loading.style.display, 'none', 'the thread painted');
  assert.match(td.el.textContent, /Help Desk/, 'the channel shows its name');
  assert.doesNotMatch(td.el.textContent, /#160\b/);
  assert.equal(td.el.querySelector('[data-control="ThreadPlacement"]'), null, 'Tasks is off: the TASK section never mounts');
  for (const s of t.seen) {
    if (!s.painted) continue;
    assert.equal(s.raw160, false, 'no "#160" was ever on screen');
    assert.equal(s.placement, false, 'the TASK section was never on screen');
  }
  const commReads = t.sentData.filter((s) => s.endpoint === 'card' && s.action === 'select_with_attributes' && s.data?.card_type_name === 'comm');
  assert.equal(commReads.length, 1, 'the comm card is read once');
  assert.deepEqual(commReads[0].data.ids, ['161'], 'by id, not every comm in the install (A12)');
});

test('thread page: a thread on a task opens on the task without painting the thread', async () => {
  const t = threadTransport({ parentId: '77', parentIsTask: true });
  const { dispatcher, api } = boot(t.transport);
  const tree = new M.TreeNode({}, []);
  M.installRouter(tree);
  const td = mountThread(api, tree);
  t.setDetail(td);
  await settle(dispatcher);
  const route = tree.at([...M.ROUTER_PATH]).peek();
  assert.equal(route.name, 'task', 'opens on the task route');
  assert.equal(route.params.id, '77');
  assert.ok(t.seen.every((s) => !s.painted), 'the thread never painted');
});

test('thread page: the CONVERSATION section leaves the subject, status and its actions to the header', async () => {
  const t = threadTransport();
  const { dispatcher, api } = boot(t.transport);
  const td = mountThread(api);
  await settle(dispatcher);
  const comms = td.el.querySelector('[data-control="CommThreads"]');
  assert.ok(comms, 'the conversation section mounted');
  assert.equal(comms.querySelector('[data-comms-heading]').textContent, 'CONVERSATION', 'heading stays CONVERSATION once loaded');
  assert.equal(comms.querySelector('[data-comms-phase-filter]'), null, 'no phase filter for one thread');
  assert.equal(comms.querySelector('[data-comms-start]'), null, 'no "+ Start comm"');
  const row = comms.querySelector('[data-comm-row="161"]');
  assert.ok(row, 'the thread row');
  assert.equal(row.querySelector('.task-comms__subject'), null, 'no second subject');
  assert.equal(row.querySelector('[data-comm-status-badge]'), null, 'no second status badge');
  assert.equal(row.querySelector('[data-comm-transitions]'), null, 'no second set of status actions');
  assert.equal(row.querySelector('[data-comm-detach]'), null, 'no Detach (it is not on a task)');
  assert.match(row.querySelector('.task-comms__thread').textContent, /^Ref Ab3dE5gH9k$/);
  assert.ok(row.querySelector('[data-comm-ack]'), 'the ACK stays');
  // The header still has the one status and its actions.
  assert.equal(td.el.querySelectorAll('[data-control="TransitionBar"]').length, 1, 'one set of status actions on the page');
});

test('thread page: the TASK section shows only while Tasks is on — not off, not never set up (A23)', async () => {
  for (const [tasksState, shown] of [['on', true], ['unused', false], ['off', false]]) {
    const t = threadTransport({ tasksState });
    const { dispatcher, api } = boot(t.transport);
    const td = mountThread(api);
    await settle(dispatcher);
    const placement = td.el.querySelector('[data-control="ThreadPlacement"]');
    assert.equal(placement !== null, shown, `Tasks ${tasksState}: TASK section ${shown ? 'shown' : 'hidden'}`);
    td.destroy?.();
  }
});
