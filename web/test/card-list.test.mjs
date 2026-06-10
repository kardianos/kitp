/**
 * CardListBody — the generic config-driven list body, exercised as the `comms`
 * screen (cardType=comm, flow attr=comm_status). Proves it lists comm cards
 * (project-scoped) via the flow-derived `screen.cardType`, renders a phase-toned
 * comm_status badge + parent-task chip per row, and filters by comm_status phase
 * INDEPENDENTLY of task status (the attr-aware phase toggle composes a
 * comm_status has_phase leaf into screen.predicate, which the body queries with).
 *
 * The transport mocks card.select_with_attributes: it returns the status /
 * parent-task lookups, and for comm cards it honours a comm_status has_phase
 * leaf (where[] or tree) so the active/terminal filters return different rows.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom, flushMicrotasks } from './ui-dom-setup.mjs';

let M;

const PROJECT = 31n;

// Status value-cards (shared pool); the comm flow uses Open/In progress/Resolved.
const STATUSES = [
  { id: '54', phase: 'active', title: 'Open' },
  { id: '55', phase: 'active', title: 'In progress' },
  { id: '56', phase: 'terminal', title: 'Resolved' },
];
const STATUS_PHASE = Object.fromEntries(STATUSES.map((s) => [s.id, s.phase]));

// Two comms on task 59: one Open (active), one Resolved (terminal). 145 carries
// an explicit acked=false (needs ACK); 200 is acked. The acked=false leaf the
// "Needs ACK" flag toggle composes narrows to 145.
const COMMS = [
  { id: '145', parent_card_id: '59', comm_status: '54', title: 'Inquiry A', acked: false },
  { id: '200', parent_card_id: '59', comm_status: '56', title: 'Inquiry B', acked: true },
];

/** The comms-layout body config (the preset bodyConfigForLayout('comms') yields). */
const COMMS_CONFIG = {
  type: 'CardListBody',
  presentation: 'compact',
  parentChipCardType: 'task',
  flagAttr: 'acked',
  flagLabel: 'Needs ACK',
  openTarget: 'parent',
  order: [{ field: 'created_at', direction: 'DESC' }],
};

before(async () => {
  installUiDom();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerCardListBody();
});

beforeEach(() => {
  document.body.replaceChildren();
});

/** Collect comm_status has_phase values from a where[] / tree predicate. */
function phaseValues(data) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.children)) node.children.forEach(visit);
    if (node.attr === 'comm_status' && node.op === 'has_phase' && Array.isArray(node.values)) {
      out.push(...node.values);
    }
  };
  (data.where ?? []).forEach(visit);
  if (data.tree) visit(data.tree);
  return out;
}

/** True if the predicate carries an `acked eq false` leaf (the flag toggle). */
function hasNeedsAckLeaf(data) {
  let found = false;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.children)) node.children.forEach(visit);
    if (node.attr === 'acked' && node.op === 'eq' && Array.isArray(node.values) && node.values[0] === false) {
      found = true;
    }
  };
  (data.where ?? []).forEach(visit);
  if (data.tree) visit(data.tree);
  return found;
}

function harness() {
  function respond(sr) {
    const data = sr.data ?? {};
    if (`${sr.endpoint}.${sr.action}` !== 'card.select_with_attributes') {
      return { id: sr.id, ok: false, error: { code: 'unknown', message: sr.action } };
    }
    const ct = data.card_type_name;
    if (ct === 'status') {
      return {
        id: sr.id,
        ok: true,
        data: { rows: STATUSES.map((s) => ({ id: s.id, phase: s.phase, attributes: { title: s.title } })) },
      };
    }
    if (ct === 'task') {
      return { id: sr.id, ok: true, data: { rows: [{ id: '59', attributes: { title: 'Wire pickers' } }] } };
    }
    if (ct === 'comm') {
      const phases = phaseValues(data);
      const needsAck = hasNeedsAckLeaf(data);
      const rows = COMMS.filter(
        (c) => (phases.length === 0 || phases.includes(STATUS_PHASE[c.comm_status])) && (!needsAck || c.acked === false),
      ).map((c) => ({
        id: c.id,
        card_type_name: 'comm',
        parent_card_id: c.parent_card_id,
        attributes: { title: c.title, comm_status: Number(c.comm_status), acked: c.acked },
      }));
      return { id: sr.id, ok: true, data: { rows } };
    }
    return { id: sr.id, ok: true, data: { rows: [] } };
  }
  return {
    transport: {
      async send(body) {
        const req = JSON.parse(body);
        return { status: 200, text: JSON.stringify({ subresponses: req.subrequests.map(respond) }) };
      },
    },
  };
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api); // defines card.select_with_attributes (+ attribute.update)
  return { dispatcher, api };
}

async function settle(dispatcher) {
  for (let i = 0; i < 6; i++) await dispatcher.flushNow();
  await flushMicrotasks();
  for (let i = 0; i < 4; i++) await dispatcher.flushNow();
  await flushMicrotasks();
}

/** Mount the comms-configured CardListBody with the flow-derived leaves set. */
function mount(api, predicate, extra) {
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(PROJECT);
  tree.at(['screen', 'cardType']).set('comm'); // flow-derived (comm_status → comm)
  tree.at(['screen', 'phaseAttr']).set('comm_status'); // the lead-badge attr
  tree.at(['screen', 'predicate']).set(predicate);
  tree.at(['screen', 'search']).set('');
  tree.at(['screen', 'searchFields']).set(['title']);
  for (const [k, v] of Object.entries(extra ?? {})) tree.at(k.split('.')).set(v);
  // The host scope object `{ from: 'scope.projectId' }` query inputs read (the
  // `{ signal: 'scope.projectId' }` trigger watches the mirrored TREE leaf).
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const c = M.Control.New('CardListBody', COMMS_CONFIG, { api, tree, scope });
  c.mount(document.createElement('div'));
  document.body.appendChild(c.el);
  return { c, tree };
}

/** Filled (non-parked) rows in render order — parked pool slots are display:none. */
function filledRows(c) {
  return [...c.el.querySelectorAll('[data-card-row]')]
    .filter((r) => r.style.display !== 'none' && r.dataset.cardId)
    .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index));
}

test('CardListBody/comms: ACTIVE filter shows the open comm with a phase-toned badge + parent chip', async () => {
  const { dispatcher, api } = bootApi(harness().transport);
  const { c } = mount(api, M.withTopLevelPhases(null, ['active'], 'comm_status'));
  await settle(dispatcher);

  const rows = filledRows(c);
  assert.equal(rows.length, 1, 'one active comm row');
  assert.equal(rows[0].dataset.cardId, '145');
  const badge = rows[0].querySelector('[data-role="badge"]');
  assert.ok(badge, 'badge present');
  assert.equal(badge.dataset.phase, 'active');
  assert.equal(badge.textContent, 'Open');
  assert.match(rows[0].querySelector('.card-list__parent').textContent, /#59/);
});

test('CardListBody/comms: TERMINAL filter shows the resolved comm (independent of task status)', async () => {
  const { dispatcher, api } = bootApi(harness().transport);
  const { c } = mount(api, M.withTopLevelPhases(null, ['terminal'], 'comm_status'));
  await settle(dispatcher);

  const rows = filledRows(c);
  assert.equal(rows.length, 1, 'one terminal comm row');
  assert.equal(rows[0].dataset.cardId, '200');
  const badge = rows[0].querySelector('[data-role="badge"]');
  assert.equal(badge.dataset.phase, 'terminal');
  assert.equal(badge.textContent, 'Resolved');
});

test('CardListBody/comms: switching the comm_status phase filter re-queries (active → terminal)', async () => {
  const { dispatcher, api } = bootApi(harness().transport);
  const { c, tree } = mount(api, M.withTopLevelPhases(null, ['active'], 'comm_status'));
  await settle(dispatcher);
  assert.equal(filledRows(c)[0].dataset.cardId, '145');

  tree.at(['screen', 'predicate']).set(M.withTopLevelPhases(null, ['terminal'], 'comm_status'));
  await settle(dispatcher);
  const rows = filledRows(c);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dataset.cardId, '200');
});

test('CardListBody/comms: a bare numeric search surfaces the exact-id row first (jump to #ID)', async () => {
  const { dispatcher, api } = bootApi(harness().transport);
  // No predicate → both comms render in server order [145, 200].
  const { c, tree } = mount(api, null);
  await settle(dispatcher);
  assert.equal(filledRows(c)[0].dataset.cardId, '145', 'default order has 145 first');

  // Searching the bare id of the SECOND comm pulls it to the top.
  tree.at(['screen', 'search']).set('200');
  await settle(dispatcher);
  assert.equal(filledRows(c)[0].dataset.cardId, '200', 'exact-id match is first on a numeric search');
});

test('CardListBody/comms: the "Needs ACK" flag toggle composes acked=false into the query and narrows the list', async () => {
  const { dispatcher, api } = bootApi(harness().transport);
  // No phase predicate → both comms render initially.
  const { c } = mount(api, null);
  await settle(dispatcher);
  assert.equal(filledRows(c).length, 2, 'both comms render before the flag is engaged');

  const toggle = c.el.querySelector('[data-card-list-flag-filter]');
  assert.ok(toggle, 'Needs ACK toggle present (flagAttr configured)');
  assert.equal(toggle.textContent, 'Needs ACK');
  toggle.click(); // engage the flag — must recompute the where leaf, not just re-fire
  await settle(dispatcher);

  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  const rows = filledRows(c);
  assert.equal(rows.length, 1, 'only the unacked comm remains');
  assert.equal(rows[0].dataset.cardId, '145', 'comm 145 (acked=false) is the needs-ACK row');

  toggle.click(); // disengage — the acked leaf must drop back out
  await settle(dispatcher);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(filledRows(c).length, 2, 'both comms return when the flag is released');
});

test('CardListBody/comms: an empty result resolves to the empty message (not stuck on Loading)', async () => {
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      return {
        status: 200,
        text: JSON.stringify({
          subresponses: req.subrequests.map((sr) => {
            const ct = (sr.data ?? {}).card_type_name;
            if (ct === 'status')
              return { id: sr.id, ok: true, data: { rows: STATUSES.map((s) => ({ id: s.id, phase: s.phase, attributes: { title: s.title } })) } };
            return { id: sr.id, ok: true, data: { rows: [] } }; // no comms, no tasks
          }),
        }),
      };
    },
  };
  const { dispatcher, api } = bootApi(transport);
  const { c } = mount(api, M.withTopLevelPhases(null, ['active'], 'comm_status'));
  await settle(dispatcher);

  assert.equal(filledRows(c).length, 0, 'no rows');
  const empty = c.el.querySelector('[data-card-list-empty]');
  assert.equal(empty.style.display, '', 'empty placeholder visible');
  assert.equal(empty.textContent, 'Nothing in this view.', 'loaded-gate flipped off "Loading…"');
});

test('CardListBody/comms: restores the remembered logical cursor on (re)mount (by cardType+project)', async () => {
  const { dispatcher, api } = bootApi(harness().transport);
  // No phase leaf → both comms render; pre-seed the cursor as if a prior visit
  // opened comm 200 (keyed by cardType 'comm', not a layout slug).
  const { c } = mount(api, null, {
    [`session.cursor.comm.${PROJECT.toString()}`]: 200n,
  });
  await settle(dispatcher);

  const rows = filledRows(c);
  assert.equal(rows.length, 2, 'both comms rendered');
  const sel = rows.find((r) => r.classList.contains('card-list__row--selected'));
  assert.ok(sel, 'a row is highlighted on return');
  assert.equal(sel.dataset.cardId, '200', 'the REMEMBERED comm (not index 0) is the cursor');
});

/* ==========================================================================
 * CardListBody as the `list` (Inbox) screen — cardType=task, status flow.
 * Covers the personal-sorted task list: status badge + assignee column + id,
 * group-by, Shift+j/k personal-sort reorder, mine-only, and delegate.
 * ======================================================================== */

const USER = 7n;

/** The list-layout body config (the preset bodyConfigForLayout('list') yields),
 *  plus a test currentUserId so mine_only doesn't need an auth probe. */
const INBOX_CONFIG = {
  type: 'CardListBody',
  presentation: 'list',
  showId: true,
  loadTaskLookups: true,
  group: true,
  personalSort: true,
  delegate: true,
  viewToggles: true,
  currentUserId: USER,
  columns: [
    { attr: 'assignee', kind: 'ref', lookup: 'persons' },
    { attr: 'priority', kind: 'text' },
  ],
};

const TASK_STATUSES = [
  { id: '40', phase: 'active', title: 'Todo' },
  { id: '41', phase: 'active', title: 'Doing' },
];
const PERSONS = [
  { id: '80', title: 'alice' },
  { id: '81', title: 'bob' },
];
// Three tasks in personal order (sort 100/200/300); assignee alice/bob/alice.
const TASKS = [
  { id: '301', title: 'Wire pickers', status: '40', assignee: '80', personal_sort_order: 100 },
  { id: '302', title: 'API limits', status: '41', assignee: '81', personal_sort_order: 200 },
  { id: '303', title: 'Empty state', status: '40', assignee: '80', personal_sort_order: 300 },
];

function inboxHarness() {
  const sortSets = [];
  const agentSets = [];
  function respond(sr) {
    const key = `${sr.endpoint}.${sr.action}`;
    const data = sr.data ?? {};
    if (key === 'card.select_with_attributes') {
      const ct = data.card_type_name;
      if (ct === 'status') return ok(sr, TASK_STATUSES.map((s) => ({ id: s.id, phase: s.phase, attributes: { title: s.title } })));
      if (ct === 'person') return ok(sr, PERSONS.map((p) => ({ id: p.id, attributes: { title: p.title } })));
      if (ct === 'milestone' || ct === 'component') return ok(sr, []);
      if (ct === 'task') {
        const rows = TASKS.map((t) => ({
          id: t.id,
          card_type_name: 'task',
          attributes: { title: t.title, status: Number(t.status), assignee: Number(t.assignee) },
          personal_sort_order: t.personal_sort_order,
        }));
        return ok(sr, rows);
      }
      return ok(sr, []);
    }
    if (key === 'user.select') return { id: sr.id, ok: true, data: { rows: [{ id: '90', display_name: 'agent-x' }] } };
    if (key === 'user_card_agent.list') return { id: sr.id, ok: true, data: { rows: [] } };
    if (key === 'user_card_sort.set') {
      sortSets.push(data);
      return { id: sr.id, ok: true, data: { ok: true } };
    }
    if (key === 'user_card_agent.set') {
      agentSets.push(data);
      return { id: sr.id, ok: true, data: { ok: true } };
    }
    if (key === 'user_card_agent.clear') return { id: sr.id, ok: true, data: { ok: true, deleted: 1 } };
    return { id: sr.id, ok: false, error: { code: 'unknown', message: key } };
  }
  function ok(sr, rows) {
    return { id: sr.id, ok: true, data: { rows } };
  }
  return {
    sortSets,
    agentSets,
    transport: {
      async send(body) {
        const req = JSON.parse(body);
        return { status: 200, text: JSON.stringify({ subresponses: req.subrequests.map(respond) }) };
      },
    },
  };
}

function bootInbox(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api);
  M.registerInboxSpecs(api);
  M.registerAdminSpecs(api); // provides the user.select spec the agents query uses
  return { dispatcher, api };
}

function mountInbox(api, extra) {
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(PROJECT);
  tree.at(['screen', 'cardType']).set('task');
  tree.at(['screen', 'phaseAttr']).set('status');
  tree.at(['screen', 'predicate']).set(null);
  tree.at(['screen', 'search']).set('');
  tree.at(['screen', 'searchFields']).set(['title']);
  for (const [k, v] of Object.entries(extra ?? {})) tree.at(k.split('.')).set(v);
  const scope = { get projectId() { return tree.at(['scope', 'projectId']).peek() ?? null; } };
  const c = M.Control.New('CardListBody', INBOX_CONFIG, { api, tree, scope });
  c.mount(document.createElement('div'));
  document.body.appendChild(c.el);
  return { c, tree };
}

function runHotkey(c, label) {
  for (const b of c.hotkeys()) if (b.label === label) { b.run(); return true; }
  return false;
}

test('layoutToControlType maps list + comms → CardListBody (the unified body)', () => {
  assert.equal(M.layoutToControlType('list'), 'CardListBody');
  assert.equal(M.layoutToControlType('comms'), 'CardListBody');
});

test('CardListBody/inbox: renders tasks in personal order with id + status badge + assignee column', async () => {
  const { dispatcher, api } = bootInbox(inboxHarness().transport);
  const { c } = mountInbox(api);
  await settle(dispatcher);
  const rows = filledRows(c);
  assert.equal(rows.length, 3, 'three task rows');
  assert.equal(rows[0].dataset.cardId, '301');
  assert.equal(rows[0].querySelector('[data-role="id"]').textContent, '#301');
  // The #id is a real link to the task, and a trailing pop-out icon links there
  // too — both let the row open in a new tab without losing the in-place click.
  assert.equal(rows[0].querySelector('[data-role="id"]').getAttribute('href'), '/task/301');
  assert.equal(rows[0].querySelector('[data-role="popout"]').getAttribute('href'), '/task/301');
  assert.equal(rows[0].querySelector('[data-role="badge"]').textContent, 'Todo');
  assert.equal(rows[0].querySelector('[data-role="badge"]').dataset.phase, 'active');
  const cols = [...rows[0].querySelectorAll('[data-col]')].map((c) => `${c.dataset.col}=${c.textContent}`);
  assert.ok(cols.includes('assignee=alice'), `assignee column resolved (got ${cols})`);
});

test('CardListBody/inbox: GROUP picker (screen.groupAxis) buckets into header + row sections', async () => {
  const { dispatcher, api } = bootInbox(inboxHarness().transport);
  const { c, tree } = mountInbox(api);
  await settle(dispatcher);
  tree.at(['screen', 'groupAxis']).set({ attr: 'assignee', lookup: 'persons' });
  await settle(dispatcher);
  const headers = [...c.el.querySelectorAll('[data-card-group]')].filter((h) => h.style.display !== 'none');
  assert.ok(headers.length >= 2, `at least two assignee groups (got ${headers.length})`);
  const labels = headers.map((h) => h.querySelector('[data-role="group-label"]').textContent);
  assert.ok(labels.includes('alice') && labels.includes('bob'), `group labels resolved (got ${labels})`);
});

test('CardListBody/inbox: Shift+j reorder fires user_card_sort.set + optimistically reorders', async () => {
  const h = inboxHarness();
  const { dispatcher, api } = bootInbox(h.transport);
  const { c } = mountInbox(api);
  await settle(dispatcher);
  assert.equal(filledRows(c)[0].dataset.cardId, '301', 'task 301 starts on top');
  // Move the cursor row (index 0 = 301) down one.
  assert.ok(runHotkey(c, 'Move down'), 'Move down hotkey present');
  await settle(dispatcher);
  assert.ok(h.sortSets.length >= 1, 'a user_card_sort.set fired');
  assert.equal(filledRows(c)[0].dataset.cardId, '302', '302 is now on top (301 moved down)');
});

test('CardListBody/inbox: mine_only ANDs assignee = the signed-in user id', async () => {
  const sent = [];
  const base = inboxHarness();
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      for (const s of req.subrequests) if (s.data?.card_type_name === 'task') sent.push(s.data);
      return base.transport.send(body);
    },
  };
  const { dispatcher, api } = bootInbox(transport);
  mountInbox(api, { 'inbox.mineOnly': true });
  await settle(dispatcher);
  // The last task query carries an assignee = USER leaf (where[] or tree).
  const hasMine = (d) => JSON.stringify(d.where ?? d.tree ?? {}).includes('assignee') && JSON.stringify(d).includes(USER.toString());
  assert.ok(sent.some(hasMine), `task query ANDs assignee=${USER} (sent ${JSON.stringify(sent.map((d) => d.where ?? d.tree))})`);
});

test('CardListBody/inbox: delegate change fires user_card_agent.set', async () => {
  const h = inboxHarness();
  const { dispatcher, api } = bootInbox(h.transport);
  const { c } = mountInbox(api);
  await settle(dispatcher);
  const sel = filledRows(c)[0].querySelector('[data-role="delegate"]');
  assert.ok(sel, 'delegate select present');
  sel.value = '90';
  const ev = document.createEvent('Event');
  ev.initEvent('change', true, true);
  sel.dispatchEvent(ev);
  await settle(dispatcher);
  assert.equal(h.agentSets.length, 1, 'one user_card_agent.set fired');
  assert.equal(String(h.agentSets[0].card_id), '301');
  assert.equal(String(h.agentSets[0].agent_user_id), '90');
});
