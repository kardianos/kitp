/**
 * TaskComments (#35) — comments + the activity feed for the Task detail.
 *
 * Runs against a REAL DOM (jsdom via ui-dom-setup) because the comment bodies
 * render through the markdown sink (DOMPurify needs a real DOM) and the control
 * mounts inside the TaskDetail (which composes the RefPicker editors). The app
 * barrel (app.js) carries TaskComments + its specs + the pure activity-text
 * helpers; we register them against one Control singleton.
 *
 * Coverage:
 *   - `activity.select` loads + the feed renders rows NEWEST-FIRST with resolved
 *     actor labels + a per-kind phrase;
 *   - "Load more" pages older rows via the `before_activity_id` cursor and
 *     appends them;
 *   - comments are DERIVED from the stream (kind=comment + comment_edit) and
 *     render their bodies as sanitized markdown;
 *   - `comment.insert` posts a comment optimistically (immediate append) + then
 *     refreshes;
 *   - an author-gated edit fires `comment.update`; a non-author sees NO edit
 *     pencil;
 *   - the pure deriveComments / sortActivityDesc / formatActivityText helpers.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom, flushMicrotasks } from './ui-dom-setup.mjs';

let M;

function key(target, k, opts = {}) {
  target.dispatchEvent(
    new globalThis.window.KeyboardEvent('keydown', {
      key: k,
      bubbles: true,
      cancelable: true,
      ...opts,
    }),
  );
}

before(async () => {
  installUiDom();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerTaskComments();
});

beforeEach(() => {
  document.body.replaceChildren();
});

const CARD_ID = 54n;
const ALICE = '10'; // current user (author of c100)
const BOB = '11'; // a different user (author of c101)

/* -------------------------------------------------------------------------- */
/* Wire helpers — activity rows in the shape activity_select_batch.sql emits.   */
/* -------------------------------------------------------------------------- */

let clock = 0;
function ts(seq) {
  // Monotonic ISO timestamps so newest-first sort is deterministic.
  const base = Date.parse('2026-05-24T12:00:00.000Z');
  return new Date(base + seq * 1000).toISOString();
}

function commentRow(id, actorId, body, seq) {
  return {
    id: String(id),
    card_id: String(CARD_ID),
    kind: 'comment',
    actor_id: actorId,
    created_at: ts(seq),
    comment_body: body,
  };
}
function attrRow(id, actorId, name, oldV, newV, seq) {
  return {
    id: String(id),
    card_id: String(CARD_ID),
    kind: 'attr_update',
    attribute_name: name,
    value_old: oldV,
    value_new: newV,
    actor_id: actorId,
    created_at: ts(seq),
  };
}
function commentEditRow(id, actorId, targetId, newBody, seq) {
  return {
    id: String(id),
    card_id: String(CARD_ID),
    kind: 'comment_edit',
    value_new: { activity_id: String(targetId), new_body: newBody },
    actor_id: actorId,
    created_at: ts(seq),
  };
}

/**
 * Transport serving activity.select (with cursor paging) + user.select +
 * comment.insert + comment.update. Records every comment write. The activity
 * store is mutable so a post/edit refresh observes the new rows; the server
 * returns ASCENDING (chronological) like the real handler.
 */
function commentsMockTransport(opts = {}) {
  const inserts = [];
  const updates = [];
  // Seed: an attr_update (oldest), then two comments. Ascending by id.
  const store = [
    attrRow(200, BOB, 'priority', 'low', 'high', 0),
    commentRow(100, ALICE, 'First **comment** body.', 1),
    commentRow(101, BOB, 'Second comment.', 2),
  ];
  // An older page (ids < 200) for the "Load more" cursor test.
  const olderPage = [
    attrRow(50, BOB, 'status', '30', '31', -2),
    attrRow(60, ALICE, 'assignee', null, '10', -1),
  ];
  const PAGE_LIMIT = opts.limit ?? 50;

  function respond(sr) {
    const k = `${sr.endpoint}.${sr.action}`;
    const data = sr.data ?? {};
    if (k === 'activity.select') {
      const before = data.before_activity_id;
      if (before !== undefined && before !== null) {
        // Older page (cursor walk). Return rows with id < before.
        const beforeN = BigInt(before);
        const rows = olderPage.filter((r) => BigInt(r.id) < beforeN);
        return { id: sr.id, ok: true, data: { rows } };
      }
      // Top page: ascending chronological, capped at the limit.
      const rows = [...store].sort((a, b) => Number(BigInt(a.id) - BigInt(b.id))).slice(0, PAGE_LIMIT);
      return { id: sr.id, ok: true, data: { rows } };
    }
    if (k === 'user.select') {
      return {
        id: sr.id,
        ok: true,
        data: {
          rows: [
            { id: ALICE, display_name: 'Alice' },
            { id: BOB, display_name: 'Bob' },
          ],
        },
      };
    }
    if (k === 'comment.insert') {
      inserts.push(data);
      const newId = 300 + inserts.length;
      // Mutate the store so the refresh observes the posted comment.
      store.push(commentRow(newId, ALICE, data.body, 10 + inserts.length));
      return {
        id: sr.id,
        ok: true,
        data: { ok: true, activity_id: String(newId), comment_body_id: String(900 + inserts.length) },
      };
    }
    if (k === 'comment.update') {
      updates.push(data);
      if (opts.failUpdate === true) {
        return { id: sr.id, ok: false, error: { code: 'forbidden', message: 'not the author' } };
      }
      const editId = 400 + updates.length;
      // Mutate: append a comment_edit row pointing at the target.
      const targetId = data.activity_id?.toString?.() ?? String(data.activity_id);
      store.push(commentEditRow(editId, ALICE, targetId, data.body, 20 + updates.length));
      return { id: sr.id, ok: true, data: { ok: true, edit_activity_id: String(editId) } };
    }
    return { id: sr.id, ok: false, error: { code: 'unknown', message: `mock has no ${k}` } };
  }

  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => respond(sr));
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
  return { transport, inserts, updates };
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerAdminSpecs(api); // user.select (actor labels)
  M.registerCommentSpecs(api); // activity.select + comment.insert/update
  return { dispatcher, api };
}

async function settle(dispatcher) {
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  M.flushSync?.();
  await flushMicrotasks();
  M.flushSync?.();
}

function mountComments(api, { currentUserId, limit, authUserId } = {}) {
  const tree = new M.TreeNode({}, []);
  // Optionally land the signed-in identity at auth.user (the boot /auth/me probe
  // shape) so the control reads the current user from the tree, not config.
  if (authUserId !== undefined) {
    tree.at([...M.AUTH_USER_PATH]).set({
      userId: BigInt(authUserId),
      displayName: 'Auth User',
      roles: ['worker'],
      isAdmin: false,
      isAgent: false,
      parentUserId: null,
    });
  }
  const ctx = { api, tree };
  const activityHost = document.createElement('div');
  document.body.appendChild(activityHost);
  const cfg = {
    type: 'TaskComments',
    cardId: String(CARD_ID),
    activityHost,
  };
  if (currentUserId !== undefined) cfg.currentUserId = currentUserId;
  if (limit !== undefined) cfg.limit = limit;
  const tc = M.Control.New('TaskComments', cfg, ctx);
  tc.mount(document.createElement('div'));
  document.body.appendChild(tc.el);
  return { tc, activityHost, tree };
}

/* -------------------------------------------------------------------------- */
/* Activity feed: load + newest-first + resolved labels.                       */
/* -------------------------------------------------------------------------- */

test('TaskComments: activity.select loads + feed renders rows newest-first with resolved labels', async () => {
  const { transport } = commentsMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { activityHost } = mountComments(api);
  await settle(dispatcher);

  const rows = [...activityHost.querySelectorAll('[data-activity-row]')];
  assert.ok(rows.length >= 3, 'feed rendered the seed rows');
  // Newest-first: the second comment (id 101, seq 2) comes before the first
  // comment (id 100, seq 1) which comes before the attr_update (id 200... wait
  // — id 200 has seq 0, the OLDEST timestamp). Order is by timestamp desc.
  const ids = rows.map((r) => r.dataset.activityRow);
  assert.deepEqual(ids, ['101', '100', '200'], 'newest-first by timestamp, id tiebreak');

  // Resolved actor labels + per-kind phrase.
  const attrText = activityHost.querySelector('[data-activity-row="200"] [data-activity-text]');
  assert.match(attrText.textContent, /^Bob changed priority from low to high/);
  const commentText = activityHost.querySelector('[data-activity-row="101"] [data-activity-text]');
  assert.equal(commentText.textContent, 'Bob commented.');
});

test('TaskComments: "Load more" uses the before_activity_id cursor and appends older rows', async () => {
  // limit:3 so the 3-row top page fills the page cap → hasMore stays true and
  // the "Load more" button renders. The mock's older page (ids 50, 60) returns
  // for a cursor request (before_activity_id = the smallest loaded id, 200).
  const { transport } = commentsMockTransport({ limit: 3 });
  const { dispatcher, api } = bootApi(transport);
  const { activityHost } = mountComments(api, { limit: 3 });
  await settle(dispatcher);

  const more = activityHost.querySelector('[data-activity-more]');
  assert.ok(more, '"Load more" present (top page filled the cap → hasMore stays true)');

  more.click();
  await settle(dispatcher);

  const ids = [...activityHost.querySelectorAll('[data-activity-row]')].map((r) => r.dataset.activityRow);
  // The older page (ids 50, 60 — both < the cursor 200) is appended below.
  assert.ok(ids.includes('60'), 'older row 60 appended');
  assert.ok(ids.includes('50'), 'older row 50 appended');
  // Still newest-first overall.
  assert.equal(ids[0], '101', 'newest row stays on top after paging');
});

/* -------------------------------------------------------------------------- */
/* Comments derived from the stream + markdown bodies.                         */
/* -------------------------------------------------------------------------- */

test('TaskComments: comments derive from the stream and render markdown (sanitized)', async () => {
  const { transport } = commentsMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { tc } = mountComments(api);
  await settle(dispatcher);

  const rows = [...tc.el.querySelectorAll('[data-comment-row]')];
  assert.equal(rows.length, 2, 'two comments derived (the attr_update is NOT a comment)');
  // Newest-first: c101 then c100.
  assert.deepEqual(rows.map((r) => r.dataset.commentRow), ['101', '100']);

  // Markdown body sanitized: the **bold** becomes <strong>.
  const body = tc.el.querySelector('[data-comment-row="100"] [data-comment-body]');
  assert.ok(body, 'comment body rendered');
  assert.ok(body.querySelector('strong'), 'markdown bold rendered through the sink');
  assert.match(body.textContent, /First comment body\./);
});

test('TaskComments: a comment_edit row overrides the body + flags (edited)', async () => {
  const { transport } = commentsMockTransport();
  const { dispatcher, api } = bootApi(transport);
  // Author edits their own comment, then we observe the refreshed stream.
  const { tc } = mountComments(api, { currentUserId: ALICE });
  await settle(dispatcher);

  const c100 = tc.el.querySelector('[data-comment-row="100"]');
  c100.querySelector('[data-comment-edit]').click();
  const input = tc.el.querySelector('[data-comment-row="100"] [data-comment-edit-input]');
  input.value = 'Edited body.';
  input.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }));
  key(input, 'Enter', { metaKey: true });
  await settle(dispatcher);

  const body = tc.el.querySelector('[data-comment-row="100"] [data-comment-body]');
  assert.match(body.textContent, /Edited body\./, 'edited body replaced the original');
  const edited = tc.el.querySelector('[data-comment-row="100"] .task-comments__edited');
  assert.ok(edited, '(edited) flag shown');
});

/* -------------------------------------------------------------------------- */
/* Comment composer → comment.insert (optimistic).                             */
/* -------------------------------------------------------------------------- */

test('TaskComments: composer posts a comment optimistically + fires comment.insert', async () => {
  const { transport, inserts } = commentsMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { tc } = mountComments(api, { currentUserId: ALICE });
  await settle(dispatcher);

  const before = tc.el.querySelectorAll('[data-comment-row]').length;
  const input = tc.el.querySelector('[data-comment-input]');
  assert.ok(input, 'composer textarea present');
  input.value = 'A brand new comment.';
  input.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }));
  key(input, 'Enter', { metaKey: true });
  // Synchronously (before any flush) the optimistic row should already be in.
  const optimisticCount = tc.el.querySelectorAll('[data-comment-row]').length;
  assert.equal(optimisticCount, before + 1, 'optimistic comment appended immediately');

  await settle(dispatcher);

  assert.equal(inserts.length, 1, 'comment.insert fired once');
  assert.equal(inserts[0].body, 'A brand new comment.');
  assert.equal(inserts[0].card_id?.toString?.() ?? String(inserts[0].card_id), '54');
  // After the refresh the real row lands (still present, count holds).
  const rows = [...tc.el.querySelectorAll('[data-comment-row]')];
  assert.ok(rows.some((r) => r.textContent.includes('A brand new comment.')), 'posted comment present after refresh');
  // The composer cleared.
  assert.equal(tc.el.querySelector('[data-comment-input]').value, '');
});

test('TaskComments: Comment button is disabled for an empty draft, enabled once typed', async () => {
  const { transport } = commentsMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { tc } = mountComments(api, { currentUserId: ALICE });
  await settle(dispatcher);

  const submit = tc.el.querySelector('[data-comment-submit]');
  assert.equal(submit.disabled, true, 'empty draft → disabled');
  const input = tc.el.querySelector('[data-comment-input]');
  input.value = 'hello';
  input.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }));
  assert.equal(submit.disabled, false, 'typed draft → enabled');
});

/* -------------------------------------------------------------------------- */
/* Author-gated edit.                                                          */
/* -------------------------------------------------------------------------- */

test('TaskComments: an author-gated edit fires comment.update', async () => {
  const { transport, updates } = commentsMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { tc } = mountComments(api, { currentUserId: ALICE });
  await settle(dispatcher);

  // Alice authored c100 → the edit pencil is shown.
  const c100 = tc.el.querySelector('[data-comment-row="100"]');
  const pencil = c100.querySelector('[data-comment-edit]');
  assert.ok(pencil, 'author sees the edit pencil');
  pencil.click();
  const input = tc.el.querySelector('[data-comment-row="100"] [data-comment-edit-input]');
  input.value = 'Reworded.';
  input.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }));
  tc.el.querySelector('[data-comment-row="100"] [data-comment-edit-save]').click();
  await settle(dispatcher);

  assert.equal(updates.length, 1, 'comment.update fired once');
  assert.equal(updates[0].body, 'Reworded.');
  assert.equal(updates[0].activity_id?.toString?.() ?? String(updates[0].activity_id), '100');
});

test('TaskComments: a non-author cannot edit a comment (no edit pencil)', async () => {
  const { transport } = commentsMockTransport();
  const { dispatcher, api } = bootApi(transport);
  // Current user is Alice; c101 was authored by Bob → no pencil on c101.
  const { tc } = mountComments(api, { currentUserId: ALICE });
  await settle(dispatcher);

  const c101 = tc.el.querySelector('[data-comment-row="101"]'); // Bob's
  assert.ok(c101, 'Bob comment present');
  assert.equal(c101.querySelector('[data-comment-edit]'), null, 'no edit pencil for a non-author');

  // Alice's own comment c100 DOES get the pencil (control gate sanity).
  const c100 = tc.el.querySelector('[data-comment-row="100"]');
  assert.ok(c100.querySelector('[data-comment-edit]'), 'author still gets the pencil');
});

test('TaskComments: with no currentUserId, NO comment shows an edit pencil', async () => {
  const { transport } = commentsMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { tc } = mountComments(api); // no currentUserId, no auth.user
  await settle(dispatcher);

  const pencils = tc.el.querySelectorAll('[data-comment-edit]');
  assert.equal(pencils.length, 0, 'no edit affordance without a known current user');
});

/* -------------------------------------------------------------------------- */
/* Author-gating reads the real identity from auth.user (no config override).   */
/* -------------------------------------------------------------------------- */

test('TaskComments: author-gating reads auth.user — author sees the pencil, others do not', async () => {
  const { transport } = commentsMockTransport();
  const { dispatcher, api } = bootApi(transport);
  // No config.currentUserId; the identity comes from auth.user (= Alice).
  const { tc } = mountComments(api, { authUserId: ALICE });
  await settle(dispatcher);

  // Alice authored c100 → pencil shown; Bob authored c101 → no pencil.
  const c100 = tc.el.querySelector('[data-comment-row="100"]'); // Alice's
  assert.ok(c100.querySelector('[data-comment-edit]'), 'author (from auth.user) sees the pencil');
  const c101 = tc.el.querySelector('[data-comment-row="101"]'); // Bob's
  assert.equal(c101.querySelector('[data-comment-edit]'), null, 'non-author gets no pencil');
});

test('TaskComments: the pencil appears reactively once auth.user lands', async () => {
  const { transport } = commentsMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { tc, tree } = mountComments(api); // unresolved at mount
  await settle(dispatcher);

  // Before the identity lands: no pencil on Alice's own comment.
  assert.equal(
    tc.el.querySelector('[data-comment-row="100"] [data-comment-edit]'),
    null,
    'no pencil before the probe lands',
  );

  // The boot /auth/me probe resolves as Alice → the control repaints + the
  // pencil appears on Alice's comment.
  tree.at([...M.AUTH_USER_PATH]).set({
    userId: BigInt(ALICE),
    displayName: 'Alice',
    roles: ['worker'],
    isAdmin: false,
    isAgent: false,
    parentUserId: null,
  });
  M.flushSync?.();
  await flushMicrotasks();

  assert.ok(
    tc.el.querySelector('[data-comment-row="100"] [data-comment-edit]'),
    'pencil appears for the author once auth.user lands',
  );
});

/* -------------------------------------------------------------------------- */
/* Pure helpers (no DOM).                                                       */
/* -------------------------------------------------------------------------- */

test('deriveComments: derives comments newest-first with comment_edit override', () => {
  // Input is newest-first (the control sorts before deriving).
  const rows = [
    { id: 401n, kind: 'comment_edit', valueNew: { activity_id: 100n, new_body: 'Edited!' }, actorId: 10n, createdAt: ts(20) },
    { id: 101n, kind: 'comment', commentBody: 'Two', actorId: 11n, createdAt: ts(2) },
    { id: 100n, kind: 'comment', commentBody: 'One', actorId: 10n, createdAt: ts(1) },
    { id: 200n, kind: 'attr_update', attributeName: 'priority', valueOld: 'low', valueNew: 'high', actorId: 11n, createdAt: ts(0) },
  ];
  const comments = M.deriveComments(rows);
  assert.equal(comments.length, 2);
  assert.deepEqual(comments.map((c) => c.id.toString()), ['101', '100']);
  // c100 got the comment_edit override + edited flag.
  const c100 = comments.find((c) => c.id === 100n);
  assert.equal(c100.body, 'Edited!');
  assert.equal(c100.edited, true);
  // c101 unedited.
  const c101 = comments.find((c) => c.id === 101n);
  assert.equal(c101.body, 'Two');
  assert.equal(c101.edited, false);
});

test('sortActivityDescNewestFirst: orders by createdAt desc, id tiebreak', () => {
  const rows = [
    { id: 1n, kind: 'comment', actorId: 1n, createdAt: ts(1) },
    { id: 2n, kind: 'comment', actorId: 1n, createdAt: ts(3) },
    { id: 3n, kind: 'comment', actorId: 1n, createdAt: ts(2) },
  ];
  const sorted = M.sortActivityDescNewestFirst(rows);
  assert.deepEqual(sorted.map((r) => r.id.toString()), ['2', '3', '1']);
  // Input not mutated.
  assert.deepEqual(rows.map((r) => r.id.toString()), ['1', '2', '3']);
});

test('formatActivityText: per-kind phrases with actor + ref labels', () => {
  const userNames = { 10: 'Alice', 11: 'Bob' };
  assert.equal(
    M.formatActivityText({ id: 1n, kind: 'card_create', actorId: 10n, createdAt: ts(0) }, userNames),
    'Alice created the card.',
  );
  assert.equal(
    M.formatActivityText({ id: 2n, kind: 'comment', actorId: 11n, createdAt: ts(0) }, userNames),
    'Bob commented.',
  );
  assert.equal(
    M.formatActivityText(
      { id: 3n, kind: 'attr_update', attributeName: 'priority', valueOld: 'low', valueNew: 'high', actorId: 10n, createdAt: ts(0) },
      userNames,
    ),
    'Alice changed priority from low to high',
  );
  // Unknown actor falls back to user#<id>.
  assert.equal(
    M.formatActivityText({ id: 4n, kind: 'card_move', actorId: 99n, createdAt: ts(0) }, userNames),
    'user#99 moved the card.',
  );
});
