/**
 * Task approvals — requests and votes on a task's status edges (a record,
 * not a gate).
 *
 * Coverage:
 *   - approval.list decode and the edge model (buildApprovalEdges): the people
 *     asked with their current-round vote, others' votes (agents included,
 *     never answering for a person), a settled request keeping the votes it
 *     settled with, the viewer's vote and "waiting on me", edge order;
 *   - the APPROVAL VOTES section: edges render with chips and a tally, all
 *     worded as votes ("Vote approve", never the workflow's "Approve");
 *     voting sends approval.decide on the open request (with a reason when
 *     added); asking sends approval.set with the edge and the picked people
 *     from activity.actors;
 *   - votes in the comment stream and the Activity page;
 *   - the task's approvals as row data: the wire decode, the Approvals badge
 *     and "asked" chip, the derived-column table a screen's extra_columns
 *     names them from (Grid column, list / Kanban chips, with_approvals), the
 *     filter fields (approval_state / approval_waiting_on / approval_asked_at)
 *     and how a saved sort on them reaches the server.
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
  assert.equal(M.edgeLabel('Approve', list.actions[1].from, list.actions[1].to), 'Review → Done (Approve)');
  assert.equal(M.stepText('', 'Review', 'Done'), 'Review → Done');
  assert.equal(M.voteWords('reject'), 'Voted reject');
});

/* -------------------------------------------------------------------------- */
/* The section against a mock server.                                         */
/* -------------------------------------------------------------------------- */

function mockServer({ list = listWire() } = {}) {
  const sent = [];
  function respond(sr) {
    const k = `${sr.endpoint}.${sr.action}`;
    const data = sr.data ?? {};
    sent.push({ k, data });
    switch (k) {
      case 'approval.list':
        return { id: sr.id, ok: true, data: list };
      case 'approval.decide':
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
  assert.match(edge.textContent, /Review → Done \(Approve\)/);
  assert.equal(edge.querySelector('[data-approval-state]').textContent, '1 of 2 voted approve');
  assert.deepEqual(
    [...edge.querySelectorAll('[data-approval-asked]')].map((ch) => [ch.textContent, ch.dataset.vote]),
    [['Dana', 'approve'], ['Lee', 'waiting']],
  );
  assert.match(edge.querySelector('[data-approval-others]').textContent, /claude \(for Dana\).*Pat/);
  assert.ok(edge.classList.contains('task-approvals__edge--waiting'), 'highlighted: waiting on the viewer');
  assert.equal(c.el.querySelector('[data-approvals-heading]').textContent, 'APPROVAL VOTES (1 open)');

  // Worded and styled as a vote: "Vote approve", outlined (never the primary,
  // status-moving style), accented because Lee is asked, with the reminder.
  const approve = edge.querySelector('[data-approval-vote="approve"]');
  assert.equal(approve.textContent.trim(), 'Vote approve');
  assert.equal(approve.classList.contains('btn-primary'), false);
  assert.equal(approve.dataset.asked, '');
  assert.equal(edge.querySelector('[data-approval-vote="reject"]').textContent.trim(), 'Vote reject');
  assert.equal(edge.querySelector('[data-approval-hint]').textContent, "A vote is a record. It doesn't change the status.");

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

/* -------------------------------------------------------------------------- */
/* Votes elsewhere: comments, the Activity page.                              */
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
  assert.deepEqual(c.vote, { decision: 'approve', label: 'Review → Done (Approve)' });
  assert.equal(c.body, 'Tests pass');
  assert.equal(c.actorName, 'claude (for Dana)');
});

test('a vote reads like a comment on the Activity page', () => {
  const lines = M.buildLines(TASK, [decisionRow({ valueNew: { decision: 'reject', from_id: '14', to_id: '15', action: 'Approve' } })]);
  assert.equal(lines[0].label, 'Voted reject · Review → Done (Approve)');
  assert.equal(lines[0].body, 'Tests pass');
});

/* -------------------------------------------------------------------------- */
/* The task's approvals as row data: badge, derived columns, filters, sorts.   */
/* -------------------------------------------------------------------------- */

function summary(over = {}) {
  return { state: 'open', asked: 2, approved: 1, rejected: 0, askedAt: '2026-10-22T09:00:00Z', waitingOnMe: false, ...over };
}

test('the approvals on a card row decode from the wire', () => {
  const row = M.decodeCardWithAttrs({
    id: '54', card_type_id: '5', card_type_name: 'task', attributes: {},
    approvals: { state: 'rejected', asked: 2, approved: 1, rejected: 1, asked_at: '2026-10-22T09:00:00Z', waiting_on_me: true },
  });
  assert.deepEqual(row.approvals, summary({ state: 'rejected', rejected: 1, waitingOnMe: true }));
  assert.equal(M.decodeCardWithAttrs({ id: '55', attributes: {} }).approvals, undefined);
});

test('approvalBadge: tone by state, tally, and "your vote"', () => {
  assert.equal(M.approvalBadge(undefined), null);
  const pending = M.approvalBadge(summary());
  assert.equal(pending.dataset.approvalBadge, 'pending');
  assert.equal(pending.textContent, '1/2');
  assert.match(pending.title, /1 of 2 voted approve.*Votes don't change the status/);
  assert.equal(M.approvalBadge(summary({ state: 'approved', approved: 2 })).dataset.approvalBadge, 'success');
  assert.equal(M.approvalBadge(summary({ state: 'rejected', rejected: 1 })).dataset.approvalBadge, 'danger');
  const mine = M.approvalBadge(summary({ waitingOnMe: true }));
  assert.equal(mine.textContent, '1/2your vote');
  assert.equal(mine.dataset.approvalMine, '');
  assert.match(M.approvalAsked(summary()).textContent, /^asked /);
  assert.equal(M.approvalAsked(undefined), null);
});

test('derived columns: named in extra_columns, rendered from the table', () => {
  assert.deepEqual(M.derivedColumnsFor('task').map(([n]) => n), ['approvals', 'approval_asked_at']);
  assert.deepEqual(M.derivedColumnsFor('comm'), []);
  assert.equal(M.derivedColumn('due_date'), undefined, 'an attribute is not derived');
  assert.equal(M.derivedColumn('toString'), undefined, 'no prototype keys');
  assert.equal(M.columnsNeedApprovals(['due_date']), false);
  assert.equal(M.columnsNeedApprovals(['due_date', 'approvals']), true);

  const row = { id: 54n, attributes: {}, approvals: summary({ waitingOnMe: true }) };
  const parts = M.derivedParts(['due_date', 'approvals', 'approval_asked_at'], row);
  assert.deepEqual(parts.map((p) => p.className), ['approval-badge', 'approval-asked muted'], 'attribute columns stay Grid-only');
  assert.deepEqual(M.derivedParts(['approvals'], { id: 55n, attributes: {} }), [], 'no open request: nothing');

  // The Grid: a derived column sorts by its server field.
  const cols = M.buildGridColumns([], [], ['approvals', 'approval_asked_at'], []);
  assert.deepEqual(
    cols.filter((c) => c.kind === 'derived').map((c) => [c.key, c.label, c.field]),
    [['approvals', 'Approvals', 'approval_state'], ['approval_asked_at', 'Approval asked', 'approval_asked_at']],
  );
  assert.deepEqual(M.readExtraColumns({ attributes: { extra_columns: '["approvals"]' } }), ['approvals']);
  assert.deepEqual(M.parseStringList('nope'), []);
});

test('approval filter fields: ops, sortability, and the wire sort field', () => {
  const [state, waiting, asked] = M.DERIVED_FILTER_FIELDS.task;
  assert.deepEqual([state.name, waiting.name, asked.name], ['approval_state', 'approval_waiting_on', 'approval_asked_at']);
  assert.deepEqual([...M.opsForAttr(state)], ['eq', 'ne', 'in', 'notIn']);
  assert.deepEqual(state.choices.map((c) => c.value), ['open', 'rejected', 'approved', 'none']);
  assert.deepEqual([...M.opsForAttr(waiting)], ['in', 'notIn']);
  assert.equal(waiting.targetCardType, 'person', 'the person picker, with Me');
  assert.equal(waiting.sortable, false);
  assert.deepEqual([...M.opsForAttr(asked)], ['withinLastDays']);

  for (const name of ['approval_state', 'approval_asked_at', 'created_at', 'last_activity_at']) {
    assert.equal(M.isTopLevelField(name), true, name);
  }
  assert.equal(M.isTopLevelField('due_date'), false);
  assert.deepEqual(
    M.sortStatesFromFilter([{ attr: 'approval_asked_at', dir: 'asc' }, { attr: 'due_date', dir: 'desc' }]),
    [{ field: 'approval_asked_at', direction: 'asc' }, { field: 'attributes.due_date', direction: 'desc' }],
  );
});
