/**
 * CommThreads — the task-detail COMMS section. Proves the comm_status surface
 * added for first-class comm tracking:
 *   - each comm renders a phase-toned comm_status badge (C5: see current status);
 *   - a per-section phase-filter chip row narrows the threads by comm_status
 *     phase, independently of the task's status (C4);
 *   - each comm mounts a TransitionBar bound to comm_status so the thread can be
 *     advanced / closed (C6) — its host + the comm-flow steps render.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom, flushMicrotasks } from './ui-dom-setup.mjs';

let M;

const TASK = 59n;

const STATUSES = [
  { id: '54', phase: 'active', title: 'Open' },
  { id: '56', phase: 'terminal', title: 'Resolved' },
];

const COMMS = [
  { id: '145', title: 'Inquiry A', thread_id: 'aaa', channel_id: '144', comm_status: '54' },
  { id: '200', title: 'Inquiry B', thread_id: 'bbb', channel_id: '144', comm_status: '56' },
];

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
});

function respond(sr) {
  const k = `${sr.endpoint}.${sr.action}`;
  const data = sr.data ?? {};
  if (k === 'comm.list_for_task') {
    return {
      id: sr.id,
      ok: true,
      data: {
        rows: COMMS.map((c) => ({
          id: c.id,
          title: c.title,
          thread_id: c.thread_id,
          channel_id: c.channel_id,
          comm_status: c.comm_status,
          recipients: [],
          replies: [],
        })),
      },
    };
  }
  if (k === 'card.select_with_attributes') {
    if (data.card_type_name === 'status') {
      return {
        id: sr.id,
        ok: true,
        data: { rows: STATUSES.map((s) => ({ id: s.id, phase: s.phase, attributes: { title: s.title } })) },
      };
    }
    return { id: sr.id, ok: true, data: { rows: [] } }; // persons, etc.
  }
  if (k === 'flow_step.list_for_card') {
    // The Open comm can "Start working"; the Resolved comm can "Reopen".
    const rows =
      String(data.card_id) === '145'
        ? [{ id: '28', flow_id: '4', flow_name: 'comm', attribute_def_id: '44', attribute_def_name: 'comm_status',
             from_card_id: '54', from_label: 'Open', from_phase: 'active',
             to_card_id: '55', to_label: 'In progress', to_phase: 'active',
             label: 'Start working', requires_role_id: '0', requires_role_name: '', sort_order: 1, allowed: true }]
        : [];
    return { id: sr.id, ok: true, data: { rows } };
  }
  if (k === 'card.search') {
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
  M.registerKanbanSpecs(api); // card.select_with_attributes + attribute.update
  M.registerCommThreadSpecs(api); // comm.list_for_task + reply.post + ...
  M.registerTransitionSpecs(api); // flow_step.list_for_card
  return { dispatcher, api };
}

async function settle(dispatcher) {
  for (let i = 0; i < 8; i++) await dispatcher.flushNow();
  await flushMicrotasks();
  for (let i = 0; i < 4; i++) await dispatcher.flushNow();
  await flushMicrotasks();
}

function mount(api) {
  const tree = new M.TreeNode({}, []);
  const ctx = { api, tree };
  const c = M.Control.New('CommThreads', { type: 'CommThreads', taskId: TASK.toString() }, ctx);
  c.mount(document.createElement('div'));
  document.body.appendChild(c.el);
  return c;
}

test('CommThreads: each comm renders a phase-toned comm_status badge', async () => {
  const { dispatcher, api } = bootApi();
  const c = mount(api);
  await settle(dispatcher);

  const rows = [...c.el.querySelectorAll('[data-comm-row]')];
  assert.equal(rows.length, 2, 'two comms');
  const badgeOf = (id) =>
    rows.find((r) => r.dataset.commRow === id).querySelector('[data-comm-status-badge]');
  assert.equal(badgeOf('145').dataset.phase, 'active');
  assert.equal(badgeOf('145').textContent, 'Open');
  assert.equal(badgeOf('200').dataset.phase, 'terminal');
  assert.equal(badgeOf('200').textContent, 'Resolved');
});

test('CommThreads: a comm-bound TransitionBar mounts with the comm-flow step', async () => {
  const { dispatcher, api } = bootApi();
  const c = mount(api);
  await settle(dispatcher);

  // The Open comm's transition host carries a TransitionBar with the "Start
  // working" step (Open→In progress) loaded from flow_step.list_for_card.
  const openRow = [...c.el.querySelectorAll('[data-comm-row]')].find((r) => r.dataset.commRow === '145');
  const host = openRow.querySelector('[data-comm-transitions]');
  assert.ok(host, 'transition host present on the comm');
  assert.ok(host.querySelector('[data-control="TransitionBar"]'), 'TransitionBar mounted');
  // progressPrimary: the first progress step (Open→In progress) is a PRIMARY
  // inline button, not buried in a dropdown. With no other active→active steps
  // the dropdown toggle is absent (nothing aux to show).
  assert.doesNotMatch(host.textContent, /No status changes/, 'a transition is available');
  const primary = host.querySelector('[data-testid="transition-progress-primary"]');
  assert.ok(primary, 'progress primary button present');
  assert.match(primary.textContent, /Start working/, 'primary button shows the comm-flow step');
});

test('CommThreads: the phase-filter chips narrow threads by comm_status phase', async () => {
  const { dispatcher, api } = bootApi();
  const c = mount(api);
  await settle(dispatcher);

  const chips = [...c.el.querySelectorAll('[data-phase-chip]')];
  // "All", plus a chip per present phase (active, terminal).
  const chipKeys = chips.map((b) => b.dataset.phaseChip);
  assert.deepEqual(chipKeys.sort(), ['active', 'all', 'terminal']);

  // Click the "active" chip → only the Open (active) comm remains rendered.
  chips.find((b) => b.dataset.phaseChip === 'active').click();
  await flushMicrotasks();
  const rows = [...c.el.querySelectorAll('[data-comm-row]')];
  assert.equal(rows.length, 1, 'only the active comm shown');
  assert.equal(rows[0].dataset.commRow, '145');
});
