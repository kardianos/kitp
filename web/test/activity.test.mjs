// Activity screen (#1): the active-project activity feed. Loads project-scoped
// activity.select (server-joined names + titles + facets), renders days →
// groups → rolled-up lines, filters server-side, pages back, and each group's
// title links to its task.
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

const ROWS = [
  {
    id: '201', card_id: '9', card_type: 'task', card_title: 'Fix the bug',
    nav_card_id: '9', nav_card_type: 'task', nav_title: 'Fix the bug',
    kind: 'comment', comment_body: 'hi there',
    actor_id: '4', actor_name: 'claude (for Daniel)', created_at: '2026-05-24T12:01:00.000Z',
  },
  {
    id: '200', card_id: '9', card_type: 'task', card_title: 'Fix the bug',
    nav_card_id: '9', nav_card_type: 'task', nav_title: 'Fix the bug',
    kind: 'attr_update', attribute_name: 'milestone_ref', value_type: 'card_ref',
    value_old: '234', value_new: '456', refs: { 234: 'Q1', 456: 'Q2' },
    actor_id: '5', actor_name: 'Bob', created_at: '2026-05-24T12:00:00.000Z',
  },
];

const FACETS = {
  total: 2,
  actors: [{ id: '4', name: 'claude (for Daniel)', count: 1 }, { id: '5', name: 'Bob', count: 1 }],
  kinds: [{ kind: 'comment', count: 1 }, { kind: 'attr_update', count: 1 }],
  card_types: [{ card_type: 'task', count: 2 }],
};

let inputs = [];
const last = () => inputs[inputs.length - 1];

/** A transport serving project-scoped activity; facets only when asked. */
function activityTransport(rows = ROWS) {
  function respond(sr) {
    const k = `${sr.endpoint}.${sr.action}`;
    if (k === 'activity.select') {
      const data = sr.data ?? {};
      inputs.push(data);
      const out = { rows };
      if (data.facets === true) out.facets = FACETS;
      return { id: sr.id, ok: true, data: out };
    }
    return { id: sr.id, ok: false, error: { code: 'unknown', message: `mock has no ${k}` } };
  }
  return {
    async send(body) {
      const req = JSON.parse(body);
      return { status: 200, text: JSON.stringify({ subresponses: req.subrequests.map(respond) }) };
    },
  };
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerCommentSpecs(api); // activity.select
  return { dispatcher, api };
}

async function settle(dispatcher) {
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  M.flushSync?.();
}

function mountActivity(api, config = {}, seed = () => {}) {
  inputs = [];
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(PROJECT);
  seed(tree);
  M.installRouter(tree); // so title clicks land a route
  const ctrl = M.Control.New('Activity', { type: 'Activity', ...config }, { api, tree });
  ctrl.mount(new FakeElement('div'));
  return { ctrl, tree };
}

const q = (ctrl, sel) => ctrl.el.querySelector(sel);
const qa = (ctrl, sel) => ctrl.el.querySelectorAll(sel);

test('Activity: one group per card, with joined titles and names — no ids', async () => {
  const { dispatcher, api } = bootApi(activityTransport());
  const { ctrl } = mountActivity(api);
  await settle(dispatcher);

  assert.equal(last().project_id, String(PROJECT), 'project-scoped');
  assert.equal(last().facets, true, 'the first load asks for facets');

  const groups = qa(ctrl, '[data-activity-group]');
  assert.equal(groups.length, 1, 'both rows (same card, minutes apart) form one group');
  assert.equal(groups[0].dataset.activityGroup, '9');
  assert.equal(groups[0].dataset.activityCount, '2');
  assert.equal(groups[0].querySelector('[data-activity-title]').textContent, 'Fix the bug');

  const lines = groups[0].querySelectorAll('[data-activity-line]');
  assert.deepEqual(lines.map((l) => l.dataset.activityLine), ['attr', 'comment'], 'oldest first within a group');
  assert.ok(lines[0].textContent.includes('Milestone') && lines[0].textContent.includes('Q1') && lines[0].textContent.includes('Q2'),
    `card_ref values titled: ${lines[0].textContent}`);
  assert.ok(lines[1].textContent.includes('hi there'), 'comment excerpt shown');

  const actors = groups[0].querySelectorAll('[data-activity-actor]').map((a) => a.textContent);
  assert.ok(actors.some((a) => a.includes('claude') && a.includes('for Daniel')), `agent shows its owner: ${actors}`);
  assert.ok(actors.some((a) => a.includes('Bob')));

  assert.equal(q(ctrl, '[data-activity-stats]').textContent, '2 events · 2 people');
});

test('Activity: the group title is a task link — plain click navigates, Ctrl-click is left to the browser', async () => {
  const { dispatcher, api } = bootApi(activityTransport());
  const { ctrl, tree } = mountActivity(api);
  await settle(dispatcher);

  const link = q(ctrl, '.activity-group__link');
  assert.equal(link.tagName, 'A');
  assert.equal(link.href, '/task/9');
  let prevented = false;
  link.dispatchEvent({ type: 'click', ctrlKey: true, button: 0, preventDefault: () => (prevented = true) });
  assert.equal(prevented, false, 'Ctrl-click not intercepted');
  link.dispatchEvent({ type: 'click', button: 0 });
  const route = tree.at([...M.ROUTER_PATH]).peek();
  assert.equal(route.name, 'task');
  assert.equal(route.params.id, '9');
});

test('Activity: People / Changes / Items filters go to the server; facets are not re-asked', async () => {
  const { dispatcher, api } = bootApi(activityTransport());
  const { ctrl } = mountActivity(api);
  await settle(dispatcher);

  const people = q(ctrl, '[data-activity-menu="people"]');
  const options = people.querySelectorAll('[data-activity-option]');
  assert.deepEqual(options.map((o) => o.dataset.activityOption), ['4', '5'], 'people from the facets');
  options[0].checked = true;
  options[0].dispatchEvent({ type: 'change' });
  await settle(dispatcher);
  assert.deepEqual(last().actor_ids, ['4']);
  assert.equal(last().facets, undefined, 'a filter change keeps the window facets');
  assert.ok(people.querySelector('.activity-menu__trigger').textContent.startsWith('People: claude'));

  const kinds = q(ctrl, '[data-activity-menu="kinds"]');
  const comments = kinds.querySelector('[data-activity-option="comments"]');
  assert.ok(comments, 'kind groups with activity are offered');
  comments.checked = true;
  comments.dispatchEvent({ type: 'change' });
  await settle(dispatcher);
  assert.deepEqual(last().kinds, ['comment', 'comment_edit']);
  assert.deepEqual(last().actor_ids, ['4'], 'filters AND together');

  const types = q(ctrl, '[data-activity-menu="types"]');
  const task = types.querySelector('[data-activity-option="task"]');
  task.checked = true;
  task.dispatchEvent({ type: 'change' });
  await settle(dispatcher);
  assert.deepEqual(last().card_types, ['task']);
  assert.ok(q(ctrl, '[data-activity-stats]').textContent.includes('matching'), 'stats say the feed is filtered');

  q(ctrl, '[data-activity-clear]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  assert.equal(last().actor_ids, undefined, 'Clear drops every filter');
  assert.equal(last().kinds, undefined);
  assert.equal(last().card_types, undefined);
});

test('Activity: People can leave the picks out ("everyone but me"); the viewer is listed first as Me', async () => {
  const { dispatcher, api } = bootApi(activityTransport());
  const { ctrl } = mountActivity(api, {}, (tree) => tree.at(['auth', 'user']).set({ userId: 5n }));
  await settle(dispatcher);

  const people = q(ctrl, '[data-activity-menu="people"]');
  const options = () => people.querySelectorAll('[data-activity-option]');
  assert.deepEqual(options().map((o) => o.dataset.activityOption), ['5', '4'], 'the viewer first');
  assert.ok(people.querySelector('.activity-menu__label').textContent === 'Me (Bob)');

  const before = inputs.length;
  people.querySelector('[data-activity-mode="exclude"]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  assert.equal(inputs.length, before, 'switching with nothing picked reloads nothing');

  options()[0].checked = true;
  options()[0].dispatchEvent({ type: 'change' });
  await settle(dispatcher);
  assert.deepEqual(last().exclude_actor_ids, ['5']);
  assert.equal(last().actor_ids, undefined);
  assert.equal(people.querySelector('.activity-menu__trigger').textContent, 'People: not Me (Bob)');

  people.querySelector('[data-activity-mode="include"]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  assert.deepEqual(last().actor_ids, ['5'], 'back to only the picks');
  assert.equal(last().exclude_actor_ids, undefined);

  people.querySelector('[data-activity-mode="exclude"]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  q(ctrl, '[data-activity-clear]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  assert.equal(last().exclude_actor_ids, undefined, 'Clear drops the exclusion');
  assert.equal(people.querySelector('[data-activity-mode="include"]').getAttribute('aria-pressed'), 'true', 'and resets the switch');
});

test('Activity: search is debounced and sent as q', async () => {
  const { dispatcher, api } = bootApi(activityTransport());
  const { ctrl } = mountActivity(api);
  await settle(dispatcher);
  const before = inputs.length;

  const search = q(ctrl, '[data-activity-search]');
  search.value = 'fix';
  search.dispatchEvent({ type: 'input' });
  search.value = 'fix the';
  search.dispatchEvent({ type: 'input' });
  await new Promise((r) => setTimeout(r, 300));
  await settle(dispatcher);
  assert.equal(inputs.length, before + 1, 'one load after typing settles');
  assert.equal(last().q, 'fix the');
});

test('Activity: defaults to the last 7 days; presets and From reload with fresh facets', async () => {
  const { dispatcher, api } = bootApi(activityTransport());
  const { ctrl } = mountActivity(api);
  await settle(dispatcher);

  assert.equal(last().from_date, M.isoDaysAgo(M.ACTIVITY_DEFAULT_LOOKBACK_DAYS), 'default 7-day look-back');
  assert.equal(last().to_date, undefined, 'no upper bound by default');

  const range = q(ctrl, '[data-activity-range]');
  range.value = 'all';
  range.dispatchEvent({ type: 'change' });
  await settle(dispatcher);
  assert.equal(last().from_date, undefined, 'All time has no lower bound');
  assert.equal(last().facets, true, 'a new window re-asks for facets');

  const from = q(ctrl, '[data-activity-date="from"]');
  from.value = '2026-05-01';
  from.dispatchEvent({ type: 'change' });
  await settle(dispatcher);
  assert.equal(last().from_date, '2026-05-01');
  assert.equal(range.value, 'custom', 'editing a date switches the preset to Custom');
});

test('Activity: "Load older" pages back with the id cursor and appends', async () => {
  const { dispatcher, api } = bootApi(activityTransport());
  const { ctrl } = mountActivity(api, { limit: 2 });
  await settle(dispatcher);

  const more = q(ctrl, '[data-activity-more]');
  assert.ok(more, 'a full page offers more');
  more.dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  assert.equal(last().before_activity_id, '200', 'cursor = the oldest row shown');
  assert.equal(last().facets, undefined, 'paging keeps the facets');
  assert.equal(qa(ctrl, '[data-activity-group]')[0].dataset.activityCount, '4', 'the page was appended');
});

test('Activity: Export CSV fetches the filtered window at a high limit', async () => {
  const { dispatcher, api } = bootApi(activityTransport());
  const { ctrl } = mountActivity(api);
  await settle(dispatcher);

  q(ctrl, '[data-activity-export]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  assert.equal(last().limit, 999, 'export fetch uses a high row cap');
  assert.equal(last().project_id, String(PROJECT));
  assert.equal(last().from_date, M.isoDaysAgo(M.ACTIVITY_DEFAULT_LOOKBACK_DAYS), 'export honours the window');
});

test('activityRowsToCsv: header + one escaped row per activity, names and titles from the rows', () => {
  const rows = [
    { id: 200n, cardId: 50n, cardType: 'link', cardTitle: 'Fix, the bug', navCardId: 9n, navTitle: 'Ship it', kind: 'attr_update', attributeName: 'link_state', valueOld: 'open', valueNew: 'merged', actorId: 25n, actorName: 'Gerrit', createdAt: '2026-05-24T12:00:00.000Z' },
    { id: 201n, cardId: 9n, kind: 'attr_update', attributeName: 'milestone_ref', valueOld: '234', valueNew: '456', refs: { 234: 'Q1', 456: 'Q2' }, actorId: 5n, createdAt: '2026-05-24T12:01:00.000Z' },
  ];
  const csv = M.activityRowsToCsv(rows, { 5: 'Bob' });
  const lines = csv.split('\n');
  assert.equal(lines[0], 'timestamp,kind,card_id,card_type,card_title,item_id,item_title,actor,attribute,detail');
  assert.equal(lines.length, 3);
  assert.ok(lines[1].includes('"Fix, the bug"') && lines[1].includes(',9,Ship it,Gerrit,'), lines[1]);
  assert.ok(lines[2].includes('Bob changed milestone from Q1 to Q2'), 'refs resolve card_ref values');
});

test('Activity: no active project → a prompt, no query', async () => {
  const { dispatcher, api } = bootApi(activityTransport());
  inputs = [];
  const tree = new M.TreeNode({}, []); // scope.projectId unset
  M.installRouter(tree);
  const ctrl = M.Control.New('Activity', { type: 'Activity' }, { api, tree });
  ctrl.mount(new FakeElement('div'));
  await settle(dispatcher);

  assert.equal(inputs.length, 0, 'no activity query without a project');
  assert.ok(q(ctrl, '[data-activity-body]').textContent.length > 0, 'shows a placeholder line');
});
