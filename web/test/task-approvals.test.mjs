/**
 * Task approvals — requests and votes on a task's status edges (a record,
 * not a gate).
 *
 * Coverage:
 *   - approval.list decode and the edge model (buildApprovalEdges): the people
 *     asked with their current-round vote, others' votes (agents included,
 *     never answering for a person), a settled request keeping the votes it
 *     settled with, the viewer's vote and "waiting on me", edge order;
 *   - the APPROVALS section: edges render with chips and a tally; voting
 *     sends approval.decide on the open request (with a reason when added);
 *     asking sends approval.set with the edge and the picked people from
 *     activity.actors;
 *   - "Waiting on you": rows say status → action → next status, a vote sends
 *     approval.decide and the band empties + hides, the waiting count lands
 *     in the tree;
 *   - votes in the comment stream and the Activity page; the row badge; the
 *     screen `panels` reader.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom, flushMicrotasks } from './ui-dom-setup.mjs';

let M;
const TASK = 54n;

before(async () => {
  installUiDom();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerTaskApprovals();
  M.registerApprovalQueue();
});

beforeEach(() => {
  document.body.replaceChildren();
});

const S = {
  idea: { id: '11', label: 'New idea', phase: 'triage' },
  todo: { id: '12', label: 'Todo', phase: 'active' },
  review: { id: '14', label: 'Review', phase: 'active' },
  done: { id: '15', label: 'Done', phase: 'terminal' },
};
const ACTIONS = [
  { from: S.idea, to: S.todo, label: 'Accept' },
  { from: S.review, to: S.done, label: 'Approve' },
];

function vote(id, by, personId, decision, over = {}) {
  return {
    id: String(id), by_id: String(100 + id), by, person_id: personId === null ? '' : String(personId),
    decision, from_id: S.review.id, to_id: S.done.id, action: 'Approve', status: S.review,
    reason: '', at: `2026-10-22T1${id}:00:00Z`, settled: false, stale: false, ...over,
  };
}

/** A task in Review: Dana + Lee asked to approve; Dana approved, Pat (unasked)
 *  approved, Dana's agent approved; an older settled Accept request. */
function listWire() {
  return {
    status: S.review,
    actions: ACTIONS,
    requests: [
      {
        id: '700', from: S.idea, to: S.todo, action: 'Accept', note: '', requested_by_id: '1',
        requested_by: 'System', requested_at: '2026-10-20T10:00:00Z', reached_at: '2026-10-20T12:00:00Z',
        approvers: [{ person_id: '30', name: 'Dana' }],
      },
      {
        id: '701', from: S.review, to: S.done, action: 'Approve', note: 'Please check the copy', requested_by_id: '1',
        requested_by: 'System', requested_at: '2026-10-22T09:00:00Z', approvers: [
          { person_id: '30', name: 'Dana' },
          { person_id: '31', name: 'Lee' },
        ],
      },
    ],
    decisions: [
      vote(4, 'claude (for Dana)', null, 'approve'),
      vote(3, 'Pat', 32, 'approve'),
      vote(2, 'Dana', 30, 'approve', { reason: 'LGTM' }),
      vote(1, 'Dana', 30, 'approve', {
        from_id: S.idea.id, to_id: S.todo.id, action: 'Accept', status: S.idea, at: '2026-10-20T11:00:00Z', settled: true,
      }),
    ],
  };
}

test('buildApprovalEdges: asked people, others, settled requests, the viewer', () => {
  const list = M.decodeApprovalList(listWire());
  const edges = M.buildApprovalEdges(list, { userId: 999n, personId: 31n }); // the viewer is Lee
  assert.deepEqual(edges.map((e) => e.action), ['Approve', 'Accept'], 'the edge with an open request first');

  const [approve, accept] = edges;
  const open = approve.requests[0];
  assert.equal(open.open, true);
  assert.deepEqual(open.asked.map((a) => [a.name, a.vote?.decision ?? null]), [['Dana', 'approve'], ['Lee', null]]);
  assert.equal(open.approved, 1);
  assert.deepEqual(approve.others.map((v) => v.by), ['claude (for Dana)', 'Pat'], "others: the agent (not Dana's answer) and Pat");
  assert.equal(approve.waitingOnMe, true, 'Lee is asked and has not voted');
  assert.equal(approve.mine, null);

  assert.equal(accept.requests[0].open, false, 'reached Todo: settled');
  assert.equal(accept.requests[0].asked[0].vote?.decision, 'approve', 'kept the vote it settled with');
  assert.equal(accept.others.length, 0, 'settled votes are not current');

  const asDana = M.buildApprovalEdges(list, { userId: 102n, personId: 30n });
  assert.equal(asDana[0].mine?.reason, 'LGTM');
  assert.equal(asDana[0].waitingOnMe, false);
});

test('actionChoices put the current status first', () => {
  const list = M.decodeApprovalList(listWire());
  assert.deepEqual(M.actionChoices(list).map((a) => a.label), ['Approve', 'Accept']);
  assert.equal(M.edgeLabel('Approve', list.actions[1].from, list.actions[1].to), 'Approve: Review → Done');
});

/* -------------------------------------------------------------------------- */
/* The section and the queue against a mock server.                           */
/* -------------------------------------------------------------------------- */

function mockServer({ list = listWire(), queue = [] } = {}) {
  const sent = [];
  let queueRows = [...queue];
  function respond(sr) {
    const k = `${sr.endpoint}.${sr.action}`;
    const data = sr.data ?? {};
    sent.push({ k, data });
    switch (k) {
      case 'approval.list':
        return { id: sr.id, ok: true, data: list };
      case 'approval.queue':
        return { id: sr.id, ok: true, data: { rows: queueRows } };
      case 'approval.decide':
        queueRows = queueRows.filter((r) => r.approval_id !== String(data.approval_id));
        return { id: sr.id, ok: true, data: { decision_id: '9000', changed: true } };
      case 'approval.set':
        return { id: sr.id, ok: true, data: { approval_id: '702', created: true, changed: true } };
      case 'activity.actors':
        return {
          id: sr.id, ok: true, data: {
            rows: [
              { id: '5', name: 'Dana', is_agent: false, person_id: '30' },
              { id: '6', name: 'Lee', is_agent: false, person_id: '31' },
              { id: '7', name: 'claude (for Dana)', is_agent: true },
            ],
          },
        };
      default:
        return { id: sr.id, ok: false, error: { code: 'unknown', message: k } };
    }
  }
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      return { status: 200, text: JSON.stringify({ subresponses: req.subrequests.map(respond) }) };
    },
  };
  return { transport, sent, writes: (k) => sent.filter((s) => s.k === k).map((s) => s.data) };
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerApprovalSpecs(api);
  M.registerCommentSpecs(api);
  return { dispatcher, api };
}

async function settle(dispatcher) {
  for (let i = 0; i < 4; i++) await dispatcher.flushNow();
  await flushMicrotasks();
  for (let i = 0; i < 2; i++) await dispatcher.flushNow();
  await flushMicrotasks();
}

function mountSection(api, viewer) {
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(31n);
  tree.at(['auth', 'user']).set(viewer);
  const c = M.Control.New('TaskApprovals', { type: 'TaskApprovals', taskId: TASK.toString() }, { api, tree });
  c.mount(document.createElement('div'));
  document.body.appendChild(c.el);
  return c;
}

test('TaskApprovals: edges render; a vote answers the open request', async () => {
  const srv = mockServer();
  const { dispatcher, api } = bootApi(srv.transport);
  const c = mountSection(api, { userId: 999n, personCardId: 31n });
  await settle(dispatcher);

  const edge = c.el.querySelector('[data-approval-edge="14>15"]');
  assert.ok(edge, 'the Approve edge renders');
  assert.match(edge.textContent, /Approve: Review → Done/);
  assert.equal(edge.querySelector('[data-approval-state]').textContent, '1 of 2 approved');
  assert.deepEqual(
    [...edge.querySelectorAll('[data-approval-asked]')].map((ch) => [ch.textContent, ch.dataset.vote]),
    [['Dana', 'approve'], ['Lee', 'waiting']],
  );
  assert.match(edge.querySelector('[data-approval-others]').textContent, /claude \(for Dana\).*Pat/);
  assert.ok(edge.classList.contains('task-approvals__edge--waiting'), 'highlighted: waiting on the viewer');
  assert.match(c.el.querySelector('[data-approvals-heading]').textContent, /1 open/);

  // Add a reason, then approve: approval.decide on request 701.
  edge.querySelector('[data-approval-add-reason]').click();
  edge.querySelector('[data-approval-mine] textarea').value = 'Copy reads well';
  edge.querySelector('[data-approval-vote="approve"]').click();
  await settle(dispatcher);
  assert.deepEqual(srv.writes('approval.decide'), [
    { task_id: '54', decision: 'approve', approval_id: '701', reason: 'Copy reads well' },
  ]);
});

test('TaskApprovals: asking sends the edge and the picked people', async () => {
  const srv = mockServer();
  const { dispatcher, api } = bootApi(srv.transport);
  const c = mountSection(api, { userId: 999n, personCardId: 31n });
  await settle(dispatcher);

  c.el.querySelector('[data-approvals-ask]').click();
  await settle(dispatcher);
  const form = c.el.querySelector('[data-approval-ask-form]');
  assert.ok(form, 'the ask form opens once the people load');
  assert.deepEqual(
    [...form.querySelectorAll('[data-approval-person]')].map((b) => b.dataset.approvalPerson),
    ['30', '31'],
    'people only — no agent',
  );
  const sel = form.querySelector('[data-approval-action]');
  assert.equal(sel.value, '14>15', 'defaults to an action from the current status');
  form.querySelector('[data-approval-ask-submit]').click();
  await settle(dispatcher);
  assert.equal(srv.writes('approval.set').length, 0, 'nobody picked: nothing sent');
  assert.match(form.textContent, /Pick at least one person/);

  form.querySelector('[data-approval-person="30"]').checked = true;
  form.querySelector('[data-approval-note]').value = 'Ship it?';
  form.querySelector('[data-approval-ask-submit]').click();
  await settle(dispatcher);
  assert.deepEqual(srv.writes('approval.set'), [
    { task_id: '54', from_status_id: '14', to_status_id: '15', approver_ids: ['30'], note: 'Ship it?' },
  ]);
  assert.equal(c.el.querySelector('[data-approval-ask-form]'), null, 'the form closes after asking');
});

function queueRow(id, over = {}) {
  return {
    approval_id: String(id), task_id: '54', task_title: 'Ship the copy', project_id: '31', project_title: 'Apollo',
    status: S.review, from: S.review, to: S.done, action: 'Approve', note: 'Please check',
    requested_by: 'System', requested_at: '2026-10-22T09:00:00Z', asked: 2, approved: 1, rejected: 0, ...over,
  };
}

test('ApprovalQueue: says what is asked; a vote empties and hides it', async () => {
  const srv = mockServer({ queue: [queueRow(701)] });
  const { dispatcher, api } = bootApi(srv.transport);
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(31n);
  const c = M.Control.New('ApprovalQueue', { type: 'ApprovalQueue' }, { api, tree });
  c.mount(document.createElement('div'));
  document.body.appendChild(c.el);
  await settle(dispatcher);

  assert.notEqual(c.el.style.display, 'none');
  const row = c.el.querySelector('[data-approval-queue-row="701"]');
  assert.match(row.querySelector('[data-approval-queue-asked]').textContent, /Review→Approve→Done/);
  assert.match(row.textContent, /#54 Ship the copy/);
  assert.match(row.textContent, /1 of 2 approved/);
  assert.equal(tree.at([...M.APPROVALS_WAITING_PATH]).peek(), 1);

  row.querySelector('[data-approval-queue-vote="approve"]').click();
  await settle(dispatcher);
  assert.deepEqual(srv.writes('approval.decide'), [{ task_id: '54', decision: 'approve', approval_id: '701' }]);
  assert.equal(c.el.style.display, 'none', 'nothing waiting: hidden');
  assert.equal(tree.at([...M.APPROVALS_WAITING_PATH]).peek(), 0);
});

/* -------------------------------------------------------------------------- */
/* Votes elsewhere: comments, the Activity page, row badges, screen panels.    */
/* -------------------------------------------------------------------------- */

function decisionRow(over = {}) {
  return {
    id: 900n, cardId: TASK, kind: 'approval_decision', actorId: 7n, actorName: 'claude (for Dana)',
    createdAt: '2026-10-22T12:00:00Z', commentBody: 'Tests pass',
    valueNew: { decision: 'approve', from_id: '14', to_id: '15', action: 'Approve' },
    refs: { 14: 'Review', 15: 'Done' }, ...over,
  };
}

test('a vote is a comment entry: verdict, edge, reason; agents named with their owner', () => {
  const [c] = M.deriveComments([decisionRow()]);
  assert.deepEqual(c.vote, { decision: 'approve', label: 'Approve: Review → Done' });
  assert.equal(c.body, 'Tests pass');
  assert.equal(c.actorName, 'claude (for Dana)');
});

test('a vote reads like a comment on the Activity page', () => {
  const lines = M.buildLines(TASK, [decisionRow({ valueNew: { decision: 'reject', from_id: '14', to_id: '15', action: 'Approve' } })]);
  assert.equal(lines[0].label, 'Rejected · Approve: Review → Done');
  assert.equal(lines[0].body, 'Tests pass');
});

test('approvalBadge: tone and tally', () => {
  assert.equal(M.approvalBadge(undefined), null);
  const pending = M.approvalBadge({ asked: 2, approved: 1, rejected: 0 });
  assert.equal(pending.dataset.approvalBadge, 'pending');
  assert.equal(pending.textContent, '1/2');
  assert.equal(M.approvalBadge({ asked: 2, approved: 2, rejected: 0 }).dataset.approvalBadge, 'success');
  assert.equal(M.approvalBadge({ asked: 2, approved: 1, rejected: 1 }).dataset.approvalBadge, 'danger');
});

test('readPanels: a screen card lists its panels', () => {
  assert.deepEqual(M.readPanels({ attributes: { panels: '["approval_queue"]' } }), ['approval_queue']);
  assert.deepEqual(M.readPanels({ attributes: { panels: 'not json' } }), []);
  assert.deepEqual(M.readPanels({ attributes: {} }), []);
  assert.equal(M.SCREEN_PANELS.approval_queue, 'ApprovalQueue');
});
