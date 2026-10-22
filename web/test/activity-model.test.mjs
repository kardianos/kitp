// Activity feed model (activity-model.ts): days → groups of consecutive
// changes to one card → rolled-up lines, from server-joined rows.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;

before(async () => {
  installDomShim();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
});

const TASK = 9n;
let nextId = 1000n;

/** A row on the task (or a child card when cardId differs), newest-first input. */
function row(over) {
  nextId += 1n;
  return {
    id: nextId,
    cardId: TASK,
    cardType: 'task',
    cardTitle: 'Ship the feed',
    navCardId: TASK,
    navCardType: 'task',
    navTitle: 'Ship the feed',
    actorId: 5n,
    actorName: 'Daniel',
    createdAt: '2026-10-22T15:00:00.000Z',
    ...over,
  };
}

test('buildLines: a creation absorbs the values set in the same transaction', () => {
  const at = '2026-10-22T15:00:00.000Z';
  const rows = [
    // newest-first: the attr writes, then the create
    row({ kind: 'attr_update', attributeName: 'description', valueNew: 'A long description\nwith two lines', createdAt: at }),
    row({ kind: 'attr_update', attributeName: 'assignee', valueType: 'card_ref', valueNew: '77', refs: { 77: 'Lucie' }, createdAt: at }),
    row({ kind: 'attr_update', attributeName: 'status', valueType: 'card_ref', valueNew: '40', refs: { 40: 'Triage' }, createdAt: at }),
    row({ kind: 'attr_update', attributeName: 'title', valueNew: 'Ship the feed', createdAt: at }),
    row({ kind: 'card_create', createdAt: at }),
  ];
  const lines = M.buildLines(TASK, rows);
  assert.equal(lines.length, 1, 'one "Created" line');
  assert.equal(lines[0].label, 'Created');
  assert.deepEqual(lines[0].details, [
    { label: 'Status', value: 'Triage' },
    { label: 'Assignee', value: 'Lucie' },
  ], 'initial values as details, titled via refs; the title is the heading');
  assert.equal(lines[0].body, 'A long description with two lines', 'a long initial text is the excerpt');
});

test('buildLines: JSON-valued text is configuration — no excerpt, and a change is "edited"', () => {
  const at = '2026-10-22T15:00:00.000Z';
  const lines = M.buildLines(80n, [
    row({ kind: 'attr_update', cardId: 80n, cardType: 'filter', attributeName: 'predicate', valueOld: '{"attr":"status"}', valueNew: '[]', createdAt: '2026-10-22T16:00:00.000Z' }),
    row({ kind: 'attr_update', cardId: 80n, cardType: 'filter', attributeName: 'predicate', valueNew: '{"connective":"and","children":[]}', createdAt: at }),
    row({ kind: 'card_create', cardId: 80n, cardType: 'filter', createdAt: at }),
  ]);
  assert.equal(lines[0].label, 'Created');
  assert.equal(lines[0].body, undefined, 'no JSON excerpt');
  assert.deepEqual(lines[0].details, []);
  assert.equal(lines[1].edited, true, 'even a short JSON change is "edited"');
});

test('buildLines: repeated changes to one attribute roll up first old → last new', () => {
  const rows = [
    row({ kind: 'attr_update', attributeName: 'status', valueOld: '41', valueNew: '42', refs: { 41: 'Active', 42: 'Done' }, actorName: 'claude (for Daniel)', createdAt: '2026-10-22T15:10:00.000Z' }),
    row({ kind: 'attr_update', attributeName: 'status', valueOld: '40', valueNew: '41', refs: { 40: 'Triage', 41: 'Active' }, createdAt: '2026-10-22T15:05:00.000Z' }),
  ];
  const [line] = M.buildLines(TASK, rows);
  assert.equal(line.verb, 'attr');
  assert.equal(line.label, 'Status');
  assert.equal(line.old, 'Triage');
  assert.equal(line.new, 'Done');
  assert.equal(line.count, 2);
  assert.deepEqual(line.actors, ['Daniel', 'claude (for Daniel)'], 'every actor, oldest first');
});

test('buildLines: child cards are the subject; hidden plumbing attrs are dropped; long text is "edited"', () => {
  const rows = [
    row({ kind: 'attr_update', cardId: 50n, cardType: 'link', cardTitle: 'Fix the feed', attributeName: 'link_state', valueOld: 'open', valueNew: 'merged', actorName: 'Gerrit' }),
    row({ kind: 'attr_update', cardId: 60n, cardType: 'comm', cardTitle: 'Billing', attributeName: 'replies', valueOld: ['1'], valueNew: ['1', '2'] }),
    row({ kind: 'attr_update', attributeName: 'description', valueOld: 'x'.repeat(100), valueNew: 'y'.repeat(100) }),
  ];
  const lines = M.buildLines(TASK, rows);
  assert.equal(lines.length, 2, 'the comm replies id list is hidden');
  assert.equal(lines[0].label, 'Description');
  assert.equal(lines[0].edited, true, 'a long text change is "edited", not a diff');
  assert.equal(lines[1].subject, 'Link “Fix the feed”', 'a child card change names the child');
  assert.equal(lines[1].label, 'State', "the child's type prefix is dropped from its field");
  assert.equal(lines[1].old, 'Open', 'link states use their choice labels');
  assert.equal(lines[1].new, 'Merged');
});

test('buildLines: tag changes net out per card; comments carry their body', () => {
  const rows = [
    row({ kind: 'comment', commentBody: 'Looks  good\n\nto me' }),
    row({ kind: 'tag_remove', attributeName: 'tags', valueOld: ['1', '2'], valueNew: ['2'], refs: { 1: 'ui', 2: 'api' } }),
    row({ kind: 'tag_apply', attributeName: 'tags', valueOld: ['2'], valueNew: ['1', '2'], refs: { 1: 'ui', 2: 'api' } }),
    row({ kind: 'tag_apply', attributeName: 'tags', valueOld: [], valueNew: ['2'], refs: { 2: 'api' } }),
  ];
  const lines = M.buildLines(TASK, rows);
  const tags = lines.find((l) => l.verb === 'tags');
  assert.deepEqual(tags.added, ['api'], 'ui added then removed nets out; api stays added');
  assert.deepEqual(tags.removed, []);
  assert.equal(tags.count, 3);
  const comment = lines.find((l) => l.verb === 'comment');
  assert.equal(comment.body, 'Looks good to me', 'whitespace collapsed');
});

test('buildLines: an edit of a comment in the group marks that comment edited', () => {
  const comment = row({ kind: 'comment', commentBody: 'Contrast is low.' });
  const lines = M.buildLines(TASK, [
    row({ kind: 'comment_edit', valueNew: { activity_id: comment.id, new_body: 'Contrast is too low.' }, actorName: 'Daniel' }),
    comment,
    row({ kind: 'comment_edit', valueNew: { activity_id: 1n, new_body: 'An older comment, edited.' } }),
  ]);
  assert.deepEqual(lines.map((l) => [l.label, l.body]), [
    ['Edited a comment', 'An older comment, edited.'],
    ['Commented (edited)', 'Contrast is too low.'],
  ]);
});

test('buildLines: events read as sentences with titles, not ids', () => {
  const lines = M.buildLines(TASK, [
    row({ kind: 'task_move', valueNew: { new_project_id: '3', old_project_id: '2' }, refs: { 2: 'Old', 3: 'New home' } }),
    row({ kind: 'attachment_create', valueNew: { filename: 'notes.md' } }),
  ]);
  assert.deepEqual(lines.map((l) => l.label), ['Attached “notes.md”', 'Moved to project “New home”']);
});

test('buildFeed: splits by local day, groups adjacent rows per card within the gap', () => {
  const day = (d, h) => new Date(2026, 9, d, h, 0, 0).toISOString();
  const rows = [
    row({ kind: 'comment', createdAt: day(22, 15) }),
    row({ kind: 'comment', createdAt: day(22, 14) }),
    row({ kind: 'comment', navCardId: 7n, navTitle: 'Other', cardId: 7n, createdAt: day(22, 13) }),
    row({ kind: 'comment', createdAt: day(22, 12) }),
    row({ kind: 'comment', createdAt: day(22, 6) }), // > 3h gap → new group
    row({ kind: 'comment', createdAt: day(21, 23) }), // a new day
  ];
  const days = M.buildFeed(rows, {}, new Date(2026, 9, 22, 16, 0, 0));
  assert.deepEqual(days.map((d) => d.label), ['Today', 'Yesterday']);
  assert.deepEqual(days[0].groups.map((g) => [g.navId, g.rows.length]), [[9n, 2], [7n, 1], [9n, 1], [9n, 1]]);
  assert.equal(days[0].count, 5);
  assert.equal(days[1].groups.length, 1);
});

test('kindsForGroups / cardTypeLabel', () => {
  assert.deepEqual(M.kindsForGroups(['comments', 'tags']), ['tag_apply', 'tag_remove', 'comment', 'comment_edit']);
  assert.equal(M.cardTypeLabel('reply_body'), 'Email');
  assert.equal(M.cardTypeLabel('activity_sink'), 'Activity sink');
  assert.equal(M.cardTypeLabel('some_new_type'), 'Some new type');
});

test('userLabel names a personal agent with its owner, not a workspace agent', () => {
  assert.equal(M.userLabel({ display_name: 'claude', is_agent: true, parent_user_id: '3', parent_user_name: 'Daniel' }), 'claude (for Daniel)');
  assert.equal(M.userLabel({ display_name: 'Gerrit', is_agent: true, parent_user_id: '1', parent_user_name: 'System' }), 'Gerrit');
  assert.equal(M.userLabel({ display_name: 'Daniel', is_agent: false }), 'Daniel');
});
