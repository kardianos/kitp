import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
let FakeElement;

before(async () => {
  ({ FakeElement } = installDomShim());
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  // Register the real screen controls once (Control.register throws on dup).
  M.registerScreenFilterBar();
  M.registerScreenHost();
  M.registerInbox();
  M.registerInboxViewToggles();
});

beforeEach(() => {
  M._resetInboxDragState();
});

/**
 * Visible rows in the recycling virtualList = the pooled row nodes the body is
 * showing (display !== 'none'). The pool also holds parked nodes; tests assert
 * on the visible window + the data-card-id hook, never a node-per-row count.
 */
function visibleRows(inbox) {
  return inbox.el
    .querySelectorAll('[data-inbox-row]')
    .filter((r) => r.style.display !== 'none');
}

/* -------------------------------------------------------------------------- */
/* A recording transport for the Inbox: serves tasks (with personal_sort_order  */
/* TOP-LEVEL, only when with_personal_sort requested), persons, statuses, the   */
/* user.select agents read, and the three write endpoints — recording each      */
/* request so a test can assert the wire inputs. A write to FAULT_CARD forces a  */
/* per-row error so the optimistic-rollback path is testable.                    */
/* -------------------------------------------------------------------------- */

const FAULT_CARD = '777';

function recordingInboxTransport(opts = {}) {
  const sent = {
    taskInputs: [],
    sortSets: [],
    agentSets: [],
    agentClears: [],
  };
  const agents = opts.agents ?? [];
  // Existing delegations the server returns for user_card_agent.list.
  const routing = opts.routing ?? [];
  const row = (id, attrs, personalSort) => {
    const r = {
      id: String(id),
      card_type_id: '5',
      card_type_name: 'task',
      parent_card_id: '100',
      phase: 'active',
      attributes: attrs,
    };
    if (personalSort !== undefined && personalSort !== null) {
      r.personal_sort_order = personalSort;
    }
    return r;
  };
  // Three tasks. Personal sort: 201→100, 202→200, 203 unset (NULL). The server
  // would order ASC NULLS LAST → [201, 202, 203].
  const TASKS = [
    row(201n, { title: 'Wire pickers', status: '50', assignee: '70', priority: 'high' }, 100),
    row(202n, { title: 'API rate limits', status: '51', assignee: '71' }, 200),
    row(203n, { title: 'Triage backlog' }, null),
  ];
  const PERSONS = [
    { id: '70', card_type_id: '11', card_type_name: 'person', attributes: { title: 'Ada' } },
    { id: '71', card_type_id: '11', card_type_name: 'person', attributes: { title: 'Linus' } },
  ];
  const STATUSES = [
    { id: '50', card_type_id: '8', card_type_name: 'status', parent_card_id: '100', attributes: { title: 'Doing' } },
    { id: '51', card_type_id: '8', card_type_name: 'status', parent_card_id: '100', attributes: { title: 'To do' } },
  ];

  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => {
        const key = `${sr.endpoint}.${sr.action}`;
        const data = sr.data ?? {};
        if (key === 'card.select_with_attributes') {
          switch (data.card_type_name) {
            case 'task':
              sent.taskInputs.push(data);
              // Mirror the server: only emit personal_sort_order when requested.
              if (data.with_personal_sort === true) {
                return { id: sr.id, ok: true, data: { rows: TASKS } };
              }
              return {
                id: sr.id,
                ok: true,
                data: { rows: TASKS.map(({ personal_sort_order, ...rest }) => rest) },
              };
            case 'person':
              return { id: sr.id, ok: true, data: { rows: PERSONS } };
            case 'status':
              return { id: sr.id, ok: true, data: { rows: STATUSES } };
            default:
              return { id: sr.id, ok: true, data: { rows: [] } };
          }
        }
        if (key === 'user.select') {
          return { id: sr.id, ok: true, data: { rows: agents } };
        }
        if (key === 'user_card_sort.set') {
          sent.sortSets.push(data);
          if (String(data.card_id) === FAULT_CARD) {
            return { id: sr.id, ok: false, error: { code: 'forbidden', message: 'mock: forced sort failure' } };
          }
          return { id: sr.id, ok: true, data: { ok: true } };
        }
        if (key === 'user_card_agent.set') {
          sent.agentSets.push(data);
          return { id: sr.id, ok: true, data: { ok: true } };
        }
        if (key === 'user_card_agent.clear') {
          sent.agentClears.push(data);
          return { id: sr.id, ok: true, data: { ok: true, deleted: 1 } };
        }
        if (key === 'user_card_agent.list') {
          return { id: sr.id, ok: true, data: { rows: routing } };
        }
        return { id: sr.id, ok: false, error: { code: 'unknown_handler', message: `no ${key}` } };
      });
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
  transport.sent = sent;
  return transport;
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api);
  M.registerGridCardRefAttrs(); // status / assignee revive to bigint
  M.registerAdminSpecs(api); // provides the user.select spec the agents query uses
  M.registerInboxSpecs(api);
  return { dispatcher, api };
}

async function settle(dispatcher) {
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  M.flushSync?.();
}

// The signed-in identity the Inbox reads for mine_only + the agents scope.
// Lands at `auth.user` (the boot /auth/me probe shape) unless a test opts out
// via `{ noAuth: true }` (to exercise the unresolved-identity path).
const ME_ID = 70n; // matches person card 70 (Ada) so `assignee = me` is realistic

function bootInbox(transport, config = {}) {
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(100n);
  const { noAuth, ...inboxConfig } = config;
  if (noAuth !== true) {
    tree.at([...M.AUTH_USER_PATH]).set({
      userId: ME_ID,
      displayName: 'Ada',
      roles: ['worker'],
      isAdmin: false,
      isAgent: false,
      parentUserId: null,
    });
  }
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const ctx = { api, tree, scope };
  const inbox = M.Control.New('Inbox', { type: 'Inbox', ...inboxConfig }, ctx);
  inbox.mount(new FakeElement('div'));
  return { dispatcher, tree, inbox };
}

/* -------------------------------------------------------------------------- */
/* ScreenHost: the `list` layout resolves to the Inbox control (no NotFound).   */
/* -------------------------------------------------------------------------- */

test('layoutToControlType maps list → Inbox', () => {
  assert.equal(M.layoutToControlType('list'), 'Inbox');
});

test('ScreenHost dispatches a list screen to the Inbox control (not NotFound)', () => {
  const { api } = bootApi(recordingInboxTransport());
  const tree = new M.TreeNode({}, []);
  const ctx = { api, tree, scope: { projectId: null } };
  const host = M.Control.New(
    'ScreenHost',
    { type: 'ScreenHost', screen: { slug: 'inbox', layout: 'list', title: 'Inbox' }, filterBar: false, resolveScreen: false },
    ctx,
  );
  host.mount(new FakeElement('div'));

  const body = host.el.querySelector('.screen-host__body');
  assert.ok(body, 'body region rendered');
  assert.equal(body.dataset.layout, 'list');
  const inboxes = body.findByControl('Inbox');
  assert.equal(inboxes.length, 1, 'list layout resolved to an Inbox control');
  const nf = body.findByControl('NotFound');
  assert.equal(nf.length, 0, 'no NotFound placeholder for the list layout');
});

/* -------------------------------------------------------------------------- */
/* Load with_personal_sort + render rows in personal order.                     */
/* -------------------------------------------------------------------------- */

test('Inbox loads with with_personal_sort and renders rows in personal order', async () => {
  const transport = recordingInboxTransport();
  const { dispatcher, tree, inbox } = bootInbox(transport);
  await settle(dispatcher);

  // The tasks query carried with_personal_sort + the personal-sort order.
  assert.ok(transport.sent.taskInputs.length >= 1, 'tasks query fired');
  const taskInput = transport.sent.taskInputs[0];
  assert.equal(taskInput.with_personal_sort, true, 'with_personal_sort:true on the wire');
  assert.equal(taskInput.routed_to_me, undefined, 'routed_to_me omitted while toggle off');
  assert.deepEqual(
    taskInput.order,
    [
      { field: 'personal_sort_order', direction: 'ASC' },
      { field: 'created_at', direction: 'DESC' },
    ],
    'ordered by personal_sort_order then created_at',
  );

  // Rows landed with personal_sort_order revived to a top-level number.
  const rows = tree.at(['inbox', 'tasks']).peek();
  assert.equal(rows.length, 3, 'three tasks landed');
  const t201 = rows.find((r) => r.id === 201n);
  assert.equal(t201.personal_sort_order, 100, 'personal_sort_order decoded as a top-level field');
  assert.equal(rows.find((r) => r.id === 203n).personal_sort_order, undefined, 'NULL personal sort → undefined');

  // Rendered in personal order: 201 (100), 202 (200), then the NULL row 203 last.
  assert.deepEqual(
    visibleRows(inbox).map((r) => r.dataset.cardId),
    ['201', '202', '203'],
    'rows render in personal_sort_order (NULLS LAST)',
  );
  // The title + resolved assignee/status labels are present on the first row.
  const first = visibleRows(inbox)[0];
  assert.match(first.textContent, /Wire pickers/);
  assert.match(first.textContent, /Doing/, 'status label resolved from the lookup');
  assert.match(first.textContent, /Ada/, 'assignee label resolved from the persons lookup');
  // The personally-ordered row carries the brighter indicator class.
  assert.ok(first.classList.contains('inbox__row--ordered'), 'ordered rows flagged');
});

/* -------------------------------------------------------------------------- */
/* Manual reorder rewrites personal_sort_order via user_card_sort.set,          */
/* optimistically.                                                              */
/* -------------------------------------------------------------------------- */

test('Inbox reorder: drag row 203 to the top rewrites personal_sort_order optimistically', async () => {
  const transport = recordingInboxTransport();
  const { dispatcher, tree, inbox } = bootInbox(transport);
  await settle(dispatcher);

  // Drag 203 (unset personal sort, currently last) onto the first row (201).
  const rows = visibleRows(inbox);
  const r203 = rows.find((r) => r.dataset.cardId === '203');
  const r201 = rows.find((r) => r.dataset.cardId === '201');
  r203.dispatchEvent({ type: 'dragstart', target: r203 });
  r201.dispatchEvent({ type: 'drop', target: r201, clientY: 0 });

  // OPTIMISTIC: planPersonalReorder renumbers the whole list to (i+1)*100 with
  // 203 first → 203:100, 201:200, 202:300.
  const after = tree.at(['inbox', 'tasks']).peek();
  const byId = Object.fromEntries(after.map((r) => [r.id.toString(), r.personal_sort_order]));
  assert.equal(byId['203'], 100, '203 rewritten to slot 0 (100)');
  assert.equal(byId['201'], 200, '201 pushed to slot 1 (200)');
  assert.equal(byId['202'], 300, '202 pushed to slot 2 (300)');

  // The list re-ordered: 203 now renders first.
  assert.deepEqual(
    visibleRows(inbox).map((r) => r.dataset.cardId),
    ['203', '201', '202'],
    'optimistic reorder placed 203 first',
  );

  await settle(dispatcher);
  // One user_card_sort.set per affected card (all three changed value).
  const ids = transport.sent.sortSets.map((s) => String(s.card_id)).sort();
  assert.deepEqual(ids, ['201', '202', '203'], 'a user_card_sort.set fired per affected card');
  const sortFor = (id) => transport.sent.sortSets.find((s) => String(s.card_id) === id).sort_order;
  assert.equal(sortFor('203'), 100, 'wire sort_order for 203 is 100');
  assert.equal(sortFor('201'), 200, 'wire sort_order for 201 is 200');

  // The moved row settles into its new slot (#context); others don't.
  const movedRow = visibleRows(inbox).find((r) => r.dataset.cardId === '203');
  const otherRow = visibleRows(inbox).find((r) => r.dataset.cardId === '202');
  assert.ok(movedRow.classList.contains('inbox__row--settling'), 'moved row carries the settle class');
  assert.ok(!otherRow.classList.contains('inbox__row--settling'), 'an untouched row does not');
});

test('Inbox reorder: releasing in the gap (drop on the list container) commits (#22)', async () => {
  const transport = recordingInboxTransport();
  const { dispatcher, inbox } = bootInbox(transport);
  await settle(dispatcher);

  // Drag 201 (currently first) and release on the LIST CONTAINER, not a row —
  // i.e. in the insertion gap. Before the fix this did nothing (the drop only
  // listened on rows); now the container handler commits. With no layout in the
  // shim the geometric target resolves to "past the end", so 201 moves last.
  const r201 = visibleRows(inbox).find((r) => r.dataset.cardId === '201');
  const listBody = inbox.el.querySelector('[data-inbox-list]');
  assert.ok(listBody, 'the list container is present');
  r201.dispatchEvent({ type: 'dragstart', target: r201 });
  listBody.dispatchEvent({ type: 'drop', target: listBody, clientY: 9999 });

  assert.deepEqual(
    visibleRows(inbox).map((r) => r.dataset.cardId),
    ['202', '203', '201'],
    'gap drop committed: 201 moved to the end',
  );
  await settle(dispatcher);
  assert.ok(transport.sent.sortSets.length >= 1, 'user_card_sort.set fired for the gap drop');
});

test('Inbox reorder: dropping on the LAST row’s lower half moves the card to the end (#30)', async () => {
  const transport = recordingInboxTransport();
  const { dispatcher, inbox } = bootInbox(transport);
  await settle(dispatcher);

  // Drag the FIRST row (201) ONTO the last row (203). With a real rect, a drop
  // in 203's LOWER half must insert AFTER it (the end) — not before it (the old
  // bug, where a card could never pass the last row).
  const r201 = visibleRows(inbox).find((r) => r.dataset.cardId === '201');
  const r203 = visibleRows(inbox).find((r) => r.dataset.cardId === '203');
  // The shim has no layout; stub 203's rect so the midpoint check can resolve.
  r203.getBoundingClientRect = () => ({ top: 100, bottom: 140, height: 40, left: 0, right: 0, width: 0, x: 0, y: 100 });

  r201.dispatchEvent({ type: 'dragstart', target: r201 });
  r203.dispatchEvent({ type: 'drop', target: r203, clientY: 135 }); // lower half (>120 midpoint)

  assert.deepEqual(
    visibleRows(inbox).map((r) => r.dataset.cardId),
    ['202', '203', '201'],
    'drop on the last row’s lower half moved 201 to the END',
  );
  await settle(dispatcher);
  assert.ok(transport.sent.sortSets.length >= 1, 'user_card_sort.set fired');
});

test('Inbox reorder: dropping on a row’s upper half still inserts BEFORE it', async () => {
  const transport = recordingInboxTransport();
  const { dispatcher, inbox } = bootInbox(transport);
  await settle(dispatcher);

  // Drag the last row (203) onto 202's UPPER half → insert BEFORE 202.
  const r202 = visibleRows(inbox).find((r) => r.dataset.cardId === '202');
  const r203 = visibleRows(inbox).find((r) => r.dataset.cardId === '203');
  r202.getBoundingClientRect = () => ({ top: 100, bottom: 140, height: 40, left: 0, right: 0, width: 0, x: 0, y: 100 });

  r203.dispatchEvent({ type: 'dragstart', target: r203 });
  r202.dispatchEvent({ type: 'drop', target: r202, clientY: 105 }); // upper half (<120 midpoint)

  assert.deepEqual(
    visibleRows(inbox).map((r) => r.dataset.cardId),
    ['201', '203', '202'],
    'upper-half drop inserted 203 before 202',
  );
});

/* -------------------------------------------------------------------------- */
/* Animated drop placeholder (#5): a gliding bar shows the insertion gap.       */
/* -------------------------------------------------------------------------- */

test('Inbox: dragging a row shows the drop placeholder, hidden on dragend (#5)', async () => {
  const transport = recordingInboxTransport();
  const { dispatcher, inbox } = bootInbox(transport);
  await settle(dispatcher);

  const list = inbox.el.querySelectorAll('[data-inbox-list]')[0];
  const placeholder = list.querySelectorAll('[data-drop-placeholder]')[0];
  assert.ok(placeholder, 'a placeholder bar lives in the inbox list');
  assert.equal(placeholder.style.display, 'none', 'hidden at rest');

  const rows = visibleRows(inbox);
  const r203 = rows.find((r) => r.dataset.cardId === '203');
  r203.dispatchEvent({ type: 'dragstart', target: r203 });
  r203.dispatchEvent({ type: 'dragover', target: r203, clientY: 5 });
  assert.notEqual(placeholder.style.display, 'none', 'placeholder shown during dragover');

  r203.dispatchEvent({ type: 'dragend', target: r203 });
  assert.equal(placeholder.style.display, 'none', 'placeholder hidden on dragend');
});

test('Inbox: a task created elsewhere (tasks.createdNonce) refetches the list', async () => {
  const transport = recordingInboxTransport();
  const { dispatcher, tree } = bootInbox(transport);
  await settle(dispatcher);
  const before = transport.sent.taskInputs.length;

  const nonce = tree.at(['tasks', 'createdNonce']);
  nonce.set((nonce.peek() ?? 0) + 1);
  await settle(dispatcher);

  assert.ok(
    transport.sent.taskInputs.length > before,
    'createdNonce bump re-issued the inbox tasks query',
  );
});

/* -------------------------------------------------------------------------- */
/* Keyboard reorder (Shift+J path) → user_card_sort.set.                        */
/* -------------------------------------------------------------------------- */

test('Inbox keyboard reorder (moveDown) rewrites personal_sort_order via user_card_sort.set', async () => {
  const transport = recordingInboxTransport();
  const { dispatcher, tree, inbox } = bootInbox(transport);
  await settle(dispatcher);

  // Select the first row (201) then move it down one slot via the Shift+j
  // hotkey binding's run callback.
  const bindings = inbox.hotkeys();
  const moveDown = bindings.find((b) => Array.isArray(b.binding) && b.binding.includes('Shift+j'));
  assert.ok(moveDown, 'Shift+j reorder binding declared');
  // Click the first row to select it, then fire the binding.
  visibleRows(inbox)[0].dispatchEvent({ type: 'click', target: visibleRows(inbox)[0] });
  moveDown.run();

  // 201 moved to slot 1: order becomes 202, 201, 203 → personal 202:100, 201:200, 203:300.
  const after = tree.at(['inbox', 'tasks']).peek();
  const byId = Object.fromEntries(after.map((r) => [r.id.toString(), r.personal_sort_order]));
  assert.equal(byId['202'], 100);
  assert.equal(byId['201'], 200);
  assert.deepEqual(
    visibleRows(inbox).map((r) => r.dataset.cardId),
    ['202', '201', '203'],
    'keyboard reorder moved 201 down one slot',
  );

  await settle(dispatcher);
  assert.ok(transport.sent.sortSets.length >= 1, 'user_card_sort.set fired for the keyboard reorder');
});

/* -------------------------------------------------------------------------- */
/* Reorder optimistic ROLLBACK on a forced fault.                               */
/* -------------------------------------------------------------------------- */

test('Inbox reorder optimistic patch ROLLS BACK on a user_card_sort.set fault', async () => {
  const transport = recordingInboxTransport();
  const { dispatcher, tree, inbox } = bootInbox(transport);
  let topFault = null;
  dispatcher.onFault('sub_error', (f) => {
    topFault = f;
  });
  await settle(dispatcher);

  // Seed a fourth task whose id forces a fault, with a known personal sort.
  const seeded = tree.at(['inbox', 'tasks']).peek();
  const faulting = {
    id: BigInt(FAULT_CARD),
    card_type_id: 5n,
    card_type_name: 'task',
    attributes: { title: 'Doomed' },
    personal_sort_order: 50,
  };
  tree.at(['inbox', 'tasks']).set([faulting, ...seeded]);

  // Move the faulting card down — planPersonalReorder writes it (value changes
  // from 50), and the mock forces a fault on that card_id.
  inbox.intent('reorderRow', { cardId: BigInt(FAULT_CARD), sortOrder: 999 });

  // Optimistic patch applied first.
  const mid = tree.at(['inbox', 'tasks']).peek().find((r) => r.id === BigInt(FAULT_CARD));
  assert.equal(mid.personal_sort_order, 999, 'optimistic personal_sort_order applied before the fault');

  await settle(dispatcher);
  const final = tree.at(['inbox', 'tasks']).peek().find((r) => r.id === BigInt(FAULT_CARD));
  assert.equal(final.personal_sort_order, 50, 'rolled back to the pre-move personal_sort_order');
  assert.ok(topFault, 'the fault funneled to the central (top) handler');
});

/* -------------------------------------------------------------------------- */
/* mine_only uses the real signed-in user id (auth.user) for assignee = me.     */
/* -------------------------------------------------------------------------- */

test('Inbox mine_only ANDs assignee = the signed-in user id (auth.user)', async () => {
  const transport = recordingInboxTransport();
  const { dispatcher, tree } = bootInbox(transport); // auth.user landed with ME_ID
  await settle(dispatcher);
  const before = transport.sent.taskInputs.length;

  // The toggles live on the filter bar now (InboxViewToggles) and flip this
  // leaf; the Inbox reacts to it. Simulate the flip directly.
  tree.at(['inbox', 'mineOnly']).set(true);
  await settle(dispatcher);

  assert.ok(transport.sent.taskInputs.length > before, 'mine_only refired the tasks query');
  const last = transport.sent.taskInputs[transport.sent.taskInputs.length - 1];
  // The assignee = me leaf rides in where[] (flat-AND, no other predicate).
  assert.ok(Array.isArray(last.where), 'where[] present under mine_only');
  const mine = last.where.find((l) => l.attr === 'assignee' && l.op === '=');
  assert.ok(mine, 'assignee = me leaf added');
  // The bigint id is stringified on the wire (json:",string").
  assert.equal(String(mine.value), String(ME_ID), 'assignee value is the signed-in user id');
});

test('Inbox mine_only is a no-op leaf when the identity is unresolved', async () => {
  const transport = recordingInboxTransport();
  // noAuth: no auth.user landed → no resolvable identity.
  const { dispatcher, tree } = bootInbox(transport, { noAuth: true });
  await settle(dispatcher);

  tree.at(['inbox', 'mineOnly']).set(true);
  await settle(dispatcher);

  const last = transport.sent.taskInputs[transport.sent.taskInputs.length - 1];
  const hasMine =
    Array.isArray(last.where) && last.where.some((l) => l.attr === 'assignee' && l.op === '=');
  assert.equal(hasMine, false, 'no assignee leaf without a resolved identity');
});

test('Inbox agents query is scoped to the signed-in user (parent_user_id = me)', async () => {
  const agents = [{ id: '90', display_name: 'Scout (agent)', is_agent: true }];
  const transport = recordingInboxTransport({ agents });
  // Record the user.select inputs.
  const userSelects = [];
  const inner = transport.send.bind(transport);
  transport.send = async (body) => {
    const req = JSON.parse(body);
    for (const sr of req.subrequests) {
      if (`${sr.endpoint}.${sr.action}` === 'user.select') userSelects.push(sr.data ?? {});
    }
    return inner(body);
  };
  const { dispatcher, tree } = bootInbox(transport); // auth.user landed with ME_ID
  await settle(dispatcher);

  assert.ok(userSelects.length >= 1, 'user.select (agents) fired once the identity resolved');
  const u = userSelects[userSelects.length - 1];
  assert.equal(u.is_agent, true, 'is_agent:true on the agents query');
  assert.equal(String(u.parent_user_id), String(ME_ID), 'agents scoped to the signed-in user');
  // Agents landed → the picker is populated.
  assert.equal(tree.at(['inbox', 'agents']).peek().length, 1, 'the user’s agent landed');
});

/* -------------------------------------------------------------------------- */
/* Routed-to-me toggle sets routed_to_me:true on the query.                     */
/* -------------------------------------------------------------------------- */

test('Inbox routed-to-me toggle sets routed_to_me on the tasks query', async () => {
  const transport = recordingInboxTransport();
  const { dispatcher, tree, inbox } = bootInbox(transport);
  await settle(dispatcher);
  const before = transport.sent.taskInputs.length;

  // The filter-bar "Routed to me" toggle flips this leaf; the Inbox reacts.
  tree.at(['inbox', 'routedToMe']).set(true);
  await settle(dispatcher);

  assert.ok(transport.sent.taskInputs.length > before, 'toggle refired the tasks query');
  const last = transport.sent.taskInputs[transport.sent.taskInputs.length - 1];
  assert.equal(last.routed_to_me, true, 'routed_to_me:true on the wire after the toggle');
  // The agent-view banner is now visible.
  const banner = inbox.el.querySelector('[data-inbox-agent-banner]');
  assert.notEqual(banner.style.display, 'none', 'agent-view banner shown');
});

test('InboxViewToggles flips the inbox.mineOnly / inbox.routedToMe leaves (#13)', () => {
  const tree = new M.TreeNode({}, []);
  const ctrl = M.Control.New('InboxViewToggles', { type: 'InboxViewToggles' }, { tree });
  ctrl.mount(new FakeElement('div'));

  const mine = ctrl.el.querySelector('[data-inbox-toggle="inbox-mine-toggle"]');
  const routed = ctrl.el.querySelector('[data-inbox-toggle="inbox-routed-toggle"]');
  assert.ok(mine && routed, 'both toggle buttons render in the view-actions control');

  mine.dispatchEvent({ type: 'click', target: mine });
  M.flushSync?.();
  assert.equal(tree.at(['inbox', 'mineOnly']).peek(), true, 'click flips mineOnly on');
  assert.equal(mine.getAttribute('aria-pressed'), 'true', 'pressed state reflects the leaf');
  mine.dispatchEvent({ type: 'click', target: mine });
  M.flushSync?.();
  assert.equal(tree.at(['inbox', 'mineOnly']).peek(), false, 'second click flips it off');

  routed.dispatchEvent({ type: 'click', target: routed });
  M.flushSync?.();
  assert.equal(tree.at(['inbox', 'routedToMe']).peek(), true, 'routed-to-me flips its leaf');
});

/* -------------------------------------------------------------------------- */
/* Delegate-to-agent fires user_card_agent.set (and clear).                     */
/* -------------------------------------------------------------------------- */

test('Inbox delegate-to-agent fires user_card_agent.set; clearing fires user_card_agent.clear', async () => {
  const agents = [
    { id: '90', display_name: 'Scout (agent)', is_agent: true },
    { id: '91', display_name: 'Runner (agent)', is_agent: true },
  ];
  const transport = recordingInboxTransport({ agents });
  const { dispatcher, tree, inbox } = bootInbox(transport);
  await settle(dispatcher);

  // Agents landed → the per-row delegate <select> is visible with options.
  const agentList = tree.at(['inbox', 'agents']).peek();
  assert.equal(agentList.length, 2, 'two agents landed');
  const firstRow = visibleRows(inbox)[0];
  const sel = firstRow.querySelectorAll('[data-inbox-delegate]')[0];
  assert.ok(sel, 'delegate picker present');
  assert.notEqual(sel.style.display, 'none', 'delegate picker visible when agents exist');

  // Pick agent 90 for card 201 (the first row).
  sel.value = '90';
  sel.dispatchEvent({ type: 'change', target: sel });

  // Optimistic routing recorded.
  assert.equal(tree.at(['inbox', 'routing']).peek()['201'], 90n, 'optimistic routing set');
  await settle(dispatcher);
  assert.equal(transport.sent.agentSets.length, 1, 'one user_card_agent.set fired');
  assert.equal(String(transport.sent.agentSets[0].card_id), '201');
  assert.equal(String(transport.sent.agentSets[0].agent_user_id), '90');

  // Now clear it (select the blank option).
  sel.value = '';
  sel.dispatchEvent({ type: 'change', target: sel });
  assert.equal(tree.at(['inbox', 'routing']).peek()['201'], undefined, 'optimistic clear dropped the routing');
  await settle(dispatcher);
  assert.equal(transport.sent.agentClears.length, 1, 'one user_card_agent.clear fired');
  assert.equal(String(transport.sent.agentClears[0].card_id), '201');
});

test('Inbox loads existing routings via user_card_agent.list so a saved delegation survives reload (#12)', async () => {
  const agents = [{ id: '90', display_name: 'Scout (agent)', is_agent: true }];
  // The server already has card 201 routed to agent 90 (a prior delegation).
  const routing = [{ card_id: '201', agent_user_id: '90' }];
  const transport = recordingInboxTransport({ agents, routing });
  const { dispatcher, tree, inbox } = bootInbox(transport);
  await settle(dispatcher);

  // The routing query landed the saved delegation into inbox.routing (not just
  // an optimistic patch) — this is what was missing.
  assert.equal(tree.at(['inbox', 'routing']).peek()['201'], 90n, 'saved routing loaded from the server');
  // …and the per-row delegate picker reflects it.
  const firstRow = visibleRows(inbox)[0];
  const sel = firstRow.querySelectorAll('[data-inbox-delegate]')[0];
  assert.equal(String(sel.value), '90', 'delegate picker shows the loaded agent');
});

/* -------------------------------------------------------------------------- */
/* Delegate picker hides when no agents resolve (data gap).                     */
/* -------------------------------------------------------------------------- */

test('Inbox hides the delegate picker when no agents resolve', async () => {
  const transport = recordingInboxTransport({ agents: [] });
  const { dispatcher, inbox } = bootInbox(transport);
  await settle(dispatcher);
  const firstRow = visibleRows(inbox)[0];
  const sel = firstRow.querySelectorAll('[data-inbox-delegate]')[0];
  assert.equal(sel.style.display, 'none', 'delegate picker hidden with no agents');
});

/* -------------------------------------------------------------------------- */
/* The shared screen.predicate narrows the inbox tasks query (where[] / tree).   */
/* -------------------------------------------------------------------------- */

test('Inbox: the shared screen.predicate narrows the tasks query', async () => {
  const transport = recordingInboxTransport();
  const { dispatcher, tree } = bootInbox(transport);
  await settle(dispatcher);
  const before = transport.sent.taskInputs.length;

  tree.at(['screen', 'predicate']).set({
    kind: 'group',
    connective: 'and',
    children: [{ kind: 'leaf', attr: 'status', op: 'in', values: ['50'] }],
  });
  await settle(dispatcher);
  assert.ok(transport.sent.taskInputs.length > before, 'predicate change refired the tasks query');
  const last = transport.sent.taskInputs[transport.sent.taskInputs.length - 1];
  assert.deepEqual(last.where, [{ attr: 'status', op: 'in', values: ['50'] }], 'flat-AND → where[]');
  assert.equal(last.with_personal_sort, true, 'still requests personal sort under a filter');
});

/* -------------------------------------------------------------------------- */
/* Row click / Enter / o navigates into the task detail (`/task/:id`).          */
/* -------------------------------------------------------------------------- */

test('Inbox: clicking a row navigates to /task/:id (and selects it)', async () => {
  const transport = recordingInboxTransport();
  const { dispatcher, inbox } = bootInbox(transport);
  await settle(dispatcher);

  const row = visibleRows(inbox)[0];
  const id = row.dataset.cardId;
  row.dispatchEvent({ type: 'click', target: row });
  assert.equal(location.pathname, `/task/${id}`, 'row click navigated to the task detail');
  assert.equal(row.dataset.index, '0', 'and the row is the selected one');
});

test('Inbox: Enter / o on a focused row opens the task detail', async () => {
  const transport = recordingInboxTransport();
  const { dispatcher, inbox } = bootInbox(transport);
  await settle(dispatcher);

  const row = visibleRows(inbox)[1];
  const id = row.dataset.cardId;
  row.dispatchEvent({ type: 'keydown', key: 'o', target: row });
  assert.equal(location.pathname, `/task/${id}`, '`o` opened the task detail');
});

test('Inbox: a click on the delegate <select> does NOT navigate', async () => {
  const transport = recordingInboxTransport({ agents: [{ id: '900', display_name: 'Agent A' }] });
  const { dispatcher, inbox } = bootInbox(transport);
  await settle(dispatcher);
  // Reset the URL so we can detect an unwanted navigation.
  history.replaceState({ path: '/inbox-base' }, '', '/inbox-base');

  const row = visibleRows(inbox)[0];
  const sel = row.querySelectorAll('[data-role="delegate"]')[0];
  assert.ok(sel, 'delegate select present when agents exist');
  row.dispatchEvent({ type: 'click', target: sel });
  assert.equal(location.pathname, '/inbox-base', 'a delegate-select click did not navigate');
});
