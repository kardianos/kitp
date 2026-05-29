// Activity screen (#1): the active-project activity feed. Loads project-scoped
// activity.select, resolves actor + card_ref labels, renders newest-first, and
// each row opens its card's /task/:id detail.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
let FakeElement;
let setPath;

before(async () => {
  ({ FakeElement, setPath } = installDomShim());
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerActivity();
});

beforeEach(() => {
  setPath('/activity');
  M._resetRouterForTest();
});

const PROJECT = 31n;

/** A transport serving project-scoped activity + label lookups. */
function activityTransport() {
  function respond(sr) {
    const k = `${sr.endpoint}.${sr.action}`;
    const data = sr.data ?? {};
    if (k === 'activity.select') {
      // Echo the project filter so the test can assert it was sent.
      lastActivityInput = data;
      return {
        id: sr.id,
        ok: true,
        data: {
          rows: [
            {
              id: '200', card_id: '9', nav_card_id: '9', nav_title: 'Fix the bug',
              kind: 'attr_update', attribute_name: 'milestone_ref',
              value_old: '234', value_new: '456', actor_id: '5', created_at: '2026-05-24T12:00:00.000Z',
            },
            {
              id: '201', card_id: '9', nav_card_id: '9', nav_title: 'Fix the bug',
              kind: 'comment', comment_body: 'hi',
              actor_id: '5', created_at: '2026-05-24T12:01:00.000Z',
            },
          ],
        },
      };
    }
    if (k === 'user.select') {
      return { id: sr.id, ok: true, data: { rows: [{ id: '5', display_name: 'Bob' }] } };
    }
    if (k === 'attribute_def.select') {
      return {
        id: sr.id, ok: true,
        data: { rows: [
          { id: 'def-m', name: 'milestone_ref', value_type: 'card_ref', is_built_in: true,
            target_card_type_name: 'milestone', bound_to: [{ card_type_id: '5', card_type_name: 'task', ordering: 0 }] },
        ] },
      };
    }
    if (k === 'card.search') {
      const rows = [];
      if (data.card_type_name === 'milestone') {
        rows.push({ id: '234', title: 'Q1' }, { id: '456', title: 'Q2' });
      }
      return { id: sr.id, ok: true, data: { rows } };
    }
    return { id: sr.id, ok: false, error: { code: 'unknown', message: `mock has no ${k}` } };
  }
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      return { status: 200, text: JSON.stringify({ subresponses: req.subrequests.map(respond) }) };
    },
  };
  return transport;
}

let lastActivityInput = null;

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerAdminSpecs(api); // user.select + attribute_def.select
  M.registerCommentSpecs(api); // activity.select
  M.registerCardSearchSpec(api); // card.search (label resolution)
  return { dispatcher, api };
}

async function settle(dispatcher) {
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  M.flushSync?.();
}

function mountActivity(api) {
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(PROJECT);
  M.installRouter(tree); // so row clicks land a route
  const ctrl = M.Control.New('Activity', { type: 'Activity' }, { api, tree });
  ctrl.mount(new FakeElement('div'));
  return { ctrl, tree };
}

test('Activity: groups same-card activity into one card with title + count summary', async () => {
  lastActivityInput = null;
  const { dispatcher, api } = bootApi(activityTransport());
  const { ctrl } = mountActivity(api);
  await settle(dispatcher);

  // The query was scoped to the active project.
  assert.equal(lastActivityInput.project_id, String(PROJECT), 'activity.select sent project_id');

  const groups = ctrl.el.querySelectorAll('[data-activity-group]');
  assert.equal(groups.length, 1, 'both rows (same owning card) collapse into one group');
  assert.equal(groups[0].dataset.activityGroup, '9', 'group keyed by the owning card');
  assert.equal(groups[0].dataset.activityCount, '2', 'group holds both rows');
  assert.equal(
    groups[0].querySelector('[data-activity-title]').textContent,
    'Fix the bug',
    'headline = owning card title',
  );
  const summary = groups[0].querySelector('[data-activity-summary]').textContent;
  assert.ok(summary.includes('comment') && summary.includes('update'), `summary counts kinds: ${summary}`);
});

test('Activity: clicking a group opens the owning card (/task/:navId)', async () => {
  const { dispatcher, api } = bootApi(activityTransport());
  const { ctrl, tree } = mountActivity(api);
  await settle(dispatcher);

  ctrl.el.querySelector('[data-activity-group="9"]').dispatchEvent({ type: 'click' });
  const route = tree.at([...M.ROUTER_PATH]).peek();
  assert.equal(route.name, 'task');
  assert.equal(route.params.id, '9', 'navigated to the owning card');
});

test('groupActivity + summarizeGroup: split by owning card; lone row = full text, multi = counts', () => {
  const rows = [
    { id: 2n, cardId: 9n, navCardId: 9n, navTitle: 'Fix the bug', kind: 'comment', commentBody: 'hey', actorId: 5n, createdAt: '2026-05-24T12:05:00.000Z' },
    { id: 1n, cardId: 9n, navCardId: 9n, navTitle: 'Fix the bug', kind: 'attr_update', attributeName: 'milestone_ref', valueOld: '234', valueNew: '456', actorId: 5n, createdAt: '2026-05-24T12:00:00.000Z' },
    { id: 3n, cardId: 14n, navCardId: 7n, navTitle: 'Other task', kind: 'comment', commentBody: 'x', actorId: 5n, createdAt: '2026-05-24T11:00:00.000Z' },
  ];
  const groups = M.groupActivity(rows);
  assert.equal(groups.length, 2, 'two owning cards → two groups');
  assert.equal(groups[0].navId, 9n);
  assert.equal(groups[0].rows.length, 2, 'adjacent same-card rows grouped');
  assert.equal(groups[1].navId, 7n);
  // Lone row → full action text (labels resolved via the maps).
  const single = M.summarizeGroup(groups[1].rows, { '5': 'Bob' }, {}, {});
  assert.ok(single.length > 0 && single.includes('Bob'), `single-row full text: ${single}`);
  // Multi-row → compact count by category.
  const multi = M.summarizeGroup(groups[0].rows, { '5': 'Bob' }, { '234': 'Q1', '456': 'Q2' }, {});
  assert.ok(multi.includes('1 comment') && multi.includes('1 update'), `count summary: ${multi}`);
});

test('Activity: defaults to the last 7 days (from_date sent), and changing From reloads', async () => {
  lastActivityInput = null;
  const { dispatcher, api } = bootApi(activityTransport());
  const { ctrl } = mountActivity(api);
  await settle(dispatcher);

  // The initial load carries a from_date = today − 7 (the default window).
  const want7 = M.isoDaysAgo(M.ACTIVITY_DEFAULT_LOOKBACK_DAYS);
  assert.equal(lastActivityInput.from_date, want7, 'default 7-day look-back applied');
  assert.equal(lastActivityInput.to_date, undefined, 'no upper bound by default');

  // Changing the From input fires a fresh activity.select with the new bound.
  const fromInput = ctrl.el.querySelector('[data-activity-date="from"]');
  fromInput.value = '2026-05-01';
  fromInput.dispatchEvent({ type: 'change' });
  await settle(dispatcher);
  assert.equal(lastActivityInput.from_date, '2026-05-01', 'edited From bound sent on reload');
});

test('Activity: Export CSV fetches the window at a high limit and builds a CSV', async () => {
  lastActivityInput = null;
  const { dispatcher, api } = bootApi(activityTransport());
  const { ctrl } = mountActivity(api);
  await settle(dispatcher);

  ctrl.el.querySelector('[data-activity-export]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  // The export pulls a high-limit page (not the on-screen cap) for the window.
  assert.equal(lastActivityInput.limit, 999, 'export fetch uses a high row cap');
  assert.equal(lastActivityInput.project_id, String(PROJECT), 'export is project-scoped');
  assert.equal(lastActivityInput.from_date, M.isoDaysAgo(M.ACTIVITY_DEFAULT_LOOKBACK_DAYS), 'export honours the date window');
});

test('activityRowsToCsv: header + one escaped row per activity, labels resolved', () => {
  const rows = [
    { id: 200n, cardId: 9n, kind: 'attr_update', attributeName: 'milestone_ref', valueOld: '234', valueNew: '456', actorId: 5n, createdAt: '2026-05-24T12:00:00.000Z' },
    { id: 201n, cardId: 9n, kind: 'comment', commentBody: 'hi, there', actorId: 5n, createdAt: '2026-05-24T12:01:00.000Z' },
  ];
  const csv = M.activityRowsToCsv(rows, { '5': 'Bob' }, { cardTitles: { '234': 'Q1', '456': 'Q2' }, tagPaths: {} });
  const lines = csv.split('\n');
  assert.equal(lines[0], 'timestamp,kind,card_id,actor,attribute,detail', 'header columns');
  assert.equal(lines.length, 3, 'header + 2 rows');
  // The attr_update detail resolves the milestone ids to titles via the maps.
  assert.ok(lines[1].includes('Bob changed milestone from Q1 to Q2'), 'card_ref labels resolved in detail');
  assert.equal(lines[1].split(',')[3], 'Bob', 'actor id resolved to name');
});

test('Activity: no active project → empty state, no query', async () => {
  lastActivityInput = null;
  const { dispatcher, api } = bootApi(activityTransport());
  const tree = new M.TreeNode({}, []); // scope.projectId unset
  M.installRouter(tree);
  const ctrl = M.Control.New('Activity', { type: 'Activity' }, { api, tree });
  ctrl.mount(new FakeElement('div'));
  await settle(dispatcher);

  assert.equal(lastActivityInput, null, 'no activity query without a project');
  assert.ok(ctrl.el.querySelector('[data-activity-body]').textContent.length > 0, 'shows an empty/placeholder line');
});
