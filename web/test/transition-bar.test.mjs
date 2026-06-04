/**
 * TransitionBar (#34) — the Task-detail status changer.
 *
 * Runs against a REAL DOM (jsdom via ui-dom-setup) because the bar mounts the
 * Popover (floating-ui) for its dropdown menus. The app barrel (app.js) carries
 * the TransitionBar + the specs + bucket helpers; we register them against one
 * Control singleton.
 *
 * Coverage:
 *   - the bucket table maps every (from_phase, to_phase) pair to its UI bucket;
 *   - `flow_step.list_for_card` loads + the bar renders the transitions bucketed
 *     (accept/reject inline buttons, progress Status ▾ dropdown);
 *   - clicking a transition fires `attribute.update(status → to_card_id)`
 *     optimistically and re-loads the available steps;
 *   - a not-`allowed` step renders disabled with the "Needs <role>" hint;
 *   - a `flow_disallowed` response renders the V13 rejection banner with the
 *     `available[]` entries as live retry buttons that fire the chosen step;
 *   - the bar mounts into the TaskDetail's `transitions` slot.
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
  M.registerCombobox();
  M.registerDatePicker();
  M.registerRefPicker();
  M.registerTransitionBar();
  M.registerTaskDetail();
  // #35: the TaskDetail spawns a TaskComments child; register it so the
  // TaskDetail-mounts-the-bar test resolves the real child (not a placeholder).
  M.registerTaskComments();
});

beforeEach(() => {
  document.body.replaceChildren();
});

const CARD_ID = 54n;
const PROJECT_ID = 100n;

/* Status value-cards (ids) used across the flow_step rows. */
const TRIAGE_ID = '20'; // phase: triage
const TODO_ID = '30'; // phase: active  (current `from`)
const DOING_ID = '31'; // phase: active
const DONE_ID = '40'; // phase: terminal
const WONTFIX_ID = '41'; // phase: terminal

/**
 * A flow_step row in the wire shape `flow_step_list_for_card_batch.sql` emits.
 * ids are JSON strings; the dispatcher revives the `*_id` keys to bigint.
 */
function step(id, fromId, fromPhase, toId, toLabel, toPhase, label, opts = {}) {
  return {
    id: String(id),
    flow_id: '5',
    flow_name: 'Task flow',
    attribute_def_id: '7',
    attribute_def_name: 'status',
    from_card_id: String(fromId),
    from_label: 'Todo',
    from_phase: fromPhase,
    to_card_id: String(toId),
    to_label: toLabel,
    to_phase: toPhase,
    label,
    requires_role_id: opts.requiresRoleId ?? '0',
    requires_role_name: opts.requiresRoleName ?? '',
    sort_order: opts.sortOrder ?? 0,
    standalone: opts.standalone ?? false,
    allowed: opts.allowed ?? true,
  };
}

/**
 * Steps available when the card sits in TODO (active): a standalone "Close"
 * button (standalone=true), plus two non-standalone steps that fold into the
 * overflow "Status ▾" dropdown — a progress move (Start work) and a role-gated
 * close (Won't fix). Exercises buttons, the grouped dropdown, and role-gating in
 * one fixture. After firing, the reload returns a single standalone step.
 */
function todoSteps() {
  return [
    step(101, TODO_ID, 'active', DOING_ID, 'Doing', 'active', 'Start work', { sortOrder: 0, standalone: false }),
    step(102, TODO_ID, 'active', DONE_ID, 'Done', 'terminal', 'Close', { sortOrder: 1, standalone: true }),
    step(103, TODO_ID, 'active', WONTFIX_ID, "Won't fix", 'terminal', "Won't fix", {
      sortOrder: 2,
      standalone: false,
      requiresRoleId: '9',
      requiresRoleName: 'manager',
      allowed: false,
    }),
  ];
}

/** Steps available after moving to DOING — one standalone close button. */
function doingSteps() {
  return [step(104, DOING_ID, 'active', DONE_ID, 'Done', 'terminal', 'Close', { sortOrder: 0, standalone: true })];
}

/**
 * Transport serving flow_step.list_for_card + attribute.update. The reload after
 * a fire returns `doingSteps()` so the optimistic reload is observable. A
 * `failNext` flag makes the next attribute.update return the V13 flow_disallowed
 * envelope. Records every attribute.update.
 */
function barMockTransport(opts = {}) {
  const updates = [];
  const state = { listCall: 0, failNext: opts.failNext === true };

  function flowReject(srId) {
    return {
      id: srId,
      ok: false,
      error: {
        code: 'flow_disallowed',
        message: 'Todo → Done is not a valid move.',
        detail: {
          from: { id: TODO_ID, label: 'Todo', phase: 'active' },
          attempted_to: { id: DONE_ID, label: 'Done', phase: 'terminal' },
          available: [
            {
              step_id: '101',
              to: { id: DOING_ID, label: 'Doing', phase: 'active' },
              label: 'Start work',
              your_role_allows: true,
              requires_role: null,
            },
            {
              step_id: '103',
              to: { id: WONTFIX_ID, label: "Won't fix", phase: 'terminal' },
              label: "Won't fix",
              your_role_allows: false,
              requires_role: 'manager',
            },
          ],
        },
      },
    };
  }

  function respond(sr) {
    const key = `${sr.endpoint}.${sr.action}`;
    const data = sr.data ?? {};
    if (key === 'flow_step.list_for_card') {
      state.listCall += 1;
      // First load = todoSteps; every reload after a successful move = doingSteps.
      const rows = state.listCall === 1 ? todoSteps() : doingSteps();
      return { id: sr.id, ok: true, data: { rows } };
    }
    if (key === 'attribute.update') {
      if (state.failNext) {
        state.failNext = false;
        return flowReject(sr.id);
      }
      updates.push(data);
      return { id: sr.id, ok: true, data: { ok: true, activity_id: '999' } };
    }
    return { id: sr.id, ok: false, error: { code: 'unknown', message: `mock has no ${key}` } };
  }

  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => respond(sr));
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
  return { transport, updates, state };
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api); // attribute.update
  M.registerTransitionSpecs(api); // flow_step.list_for_card
  return { dispatcher, api };
}

async function settle(dispatcher) {
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  await flushMicrotasks();
}

function mountBar(api, extra = {}) {
  const tree = new M.TreeNode({}, []);
  const ctx = { api, tree };
  const bar = M.Control.New(
    'TransitionBar',
    { type: 'TransitionBar', cardId: String(CARD_ID), statusAttr: 'status', ...extra },
    ctx,
  );
  bar.mount(document.createElement('div'));
  document.body.appendChild(bar.el);
  return { bar, tree };
}

/* -------------------------------------------------------------------------- */
/* Bucket table (pure helper).                                                 */
/* -------------------------------------------------------------------------- */

test('TransitionBar: the (from,to) phase pair maps to the right UI bucket', () => {
  assert.equal(M.bucketFor('triage', 'triage'), 'progress_triage');
  assert.equal(M.bucketFor('triage', 'active'), 'accept');
  assert.equal(M.bucketFor('triage', 'terminal'), 'reject');
  assert.equal(M.bucketFor('active', 'triage'), 'defer');
  assert.equal(M.bucketFor('active', 'active'), 'progress');
  assert.equal(M.bucketFor('active', 'terminal'), 'close');
  assert.equal(M.bucketFor('terminal', 'triage'), 'retriage');
  assert.equal(M.bucketFor('terminal', 'active'), 'reopen');
  assert.equal(M.bucketFor('terminal', 'terminal'), 'recategorize');
});

/* -------------------------------------------------------------------------- */
/* Load + bucketed render.                                                     */
/* -------------------------------------------------------------------------- */

test('TransitionBar: loads flow_step.list_for_card and renders the standalone button + overflow dropdown', async () => {
  const { transport } = barMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { bar } = mountBar(api);
  await settle(dispatcher);

  // standalone=true (Close) → its own button, toned by its close bucket.
  const closeBtn = bar.el.querySelector('[data-testid="transition-close"]');
  assert.ok(closeBtn, 'standalone close step → its own button');
  assert.equal(closeBtn.textContent, 'Close');
  assert.equal(closeBtn.dataset.stepId, '102');

  // standalone=false (Start work + Won't fix) → folded into one overflow dropdown.
  assert.ok(
    bar.el.querySelector('[data-testid="transition-menu-toggle"]'),
    'non-standalone steps → overflow "Status ▾" dropdown',
  );
});

/* -------------------------------------------------------------------------- */
/* Fire optimistically → attribute.update(status → to_id) + reload.            */
/* -------------------------------------------------------------------------- */

test('TransitionBar: clicking a transition fires attribute.update(status → to) and reloads', async () => {
  const { transport, updates, state } = barMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { bar } = mountBar(api);
  await settle(dispatcher);

  assert.equal(state.listCall, 1, 'initial load fired once');

  // The standalone Close button moves status → DONE (terminal).
  bar.el.querySelector('[data-testid="transition-close"]').click();
  await settle(dispatcher);

  const u = updates.find((x) => x.attribute_name === 'status');
  assert.ok(u, 'attribute.update(status) fired');
  assert.equal(u.card_id?.toString?.() ?? String(u.card_id), '54');
  assert.equal(u.value?.toString?.() ?? String(u.value), DONE_ID, 'value = the step to_card_id');

  // Optimistic reload: a second flow_step.list_for_card fired after success.
  assert.ok(state.listCall >= 2, 'available steps reloaded after the move');
  // The reloaded set (doingSteps) is one standalone button, no overflow menu.
  assert.equal(
    bar.el.querySelector('[data-testid="transition-menu-toggle"]'),
    null,
    'overflow dropdown gone after reload',
  );
  assert.ok(bar.el.querySelector('[data-testid="transition-close"]'), 'standalone close button after reload');
});

/* -------------------------------------------------------------------------- */
/* Role-gating: not-allowed step is disabled + shows the role hint.            */
/* -------------------------------------------------------------------------- */

test('TransitionBar: a not-allowed step renders disabled with the required-role hint', async () => {
  const { transport } = barMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { bar } = mountBar(api);
  await settle(dispatcher);

  // The "Won't fix" close step (id 103) is role-gated (manager) and
  // non-standalone → it lives in the overflow "Status ▾" dropdown. Open it and
  // inspect the disabled item.
  const toggle = bar.el.querySelector('[data-testid="transition-menu-toggle"]');
  assert.ok(toggle, 'overflow dropdown toggle present');
  toggle.click();
  await flushMicrotasks();

  const items = [...document.querySelectorAll('[data-testid="transition-menu-item"]')];
  const gated = items.find((el) => el.dataset.stepId === '103');
  assert.ok(gated, "the role-gated Won't fix item rendered");
  assert.equal(gated.disabled, true, 'role-gated step is disabled');
  const hint = gated.querySelector('[data-role-hint]');
  assert.ok(hint, 'role hint present');
  assert.equal(hint.textContent, 'Needs manager');
});

/* -------------------------------------------------------------------------- */
/* V13 rejection banner + live retry buttons.                                  */
/* -------------------------------------------------------------------------- */

test('TransitionBar: a flow_disallowed response renders the rejection banner with retry buttons', async () => {
  const { transport, updates, state } = barMockTransport({ failNext: true });
  const { dispatcher, api } = bootApi(transport);
  const { bar } = mountBar(api);
  await settle(dispatcher);

  // Fire the standalone Close button → the mock returns the V13 envelope.
  bar.el.querySelector('[data-testid="transition-close"]').click();
  await settle(dispatcher);

  // No write recorded (the reject came back), and the banner is pinned to the bar.
  assert.equal(updates.length, 0, 'no successful write on a flow reject');
  const banner = bar.el.querySelector('[data-testid="transition-banner"]');
  assert.ok(banner, 'V13 rejection banner rendered on the bar (self route)');

  // The available[] entries are live retry buttons; the manager-gated one is
  // disabled with its role hint, the allowed one fires the matching transition.
  const actions = [...banner.querySelectorAll('[data-testid="transition-banner-action"]')];
  assert.equal(actions.length, 2, 'one retry button per available[] entry');
  const gated = actions.find((el) => el.dataset.stepId === '103');
  assert.equal(gated.disabled, true, 'role-locked available entry disabled');
  assert.ok(gated.querySelector('[data-role-hint]'), 'role hint on the locked retry');

  const retry = actions.find((el) => el.dataset.stepId === '101');
  assert.ok(retry, 'allowed retry button present');
  const before = state.listCall;
  retry.click(); // fires step 101 (Start work → Doing)
  await settle(dispatcher);

  const u = updates.find((x) => x.attribute_name === 'status');
  assert.ok(u, 'clicking a retry button fires the chosen transition');
  assert.equal(u.value?.toString?.() ?? String(u.value), DOING_ID, 'fired the retry step to_id');
  assert.ok(state.listCall > before, 'reload fired after the successful retry');
  assert.equal(
    bar.el.querySelector('[data-testid="transition-banner"]'),
    null,
    'banner cleared on a successful fire',
  );
});

/* -------------------------------------------------------------------------- */
/* Mounts into the TaskDetail transitions slot.                                */
/* -------------------------------------------------------------------------- */

test('TransitionBar: TaskDetail mounts it into the transitions slot', async () => {
  // A transport that serves the task load + the bar's flow_step list.
  const updates = [];
  const task = {
    id: String(CARD_ID),
    card_type_id: '5',
    card_type_name: 'task',
    parent_card_id: String(PROJECT_ID),
    phase: 'active',
    attributes: { title: 'Wire the bar', status: TODO_ID },
  };
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => {
        const key = `${sr.endpoint}.${sr.action}`;
        const data = sr.data ?? {};
        if (key === 'card.select_with_attributes') {
          return {
            id: sr.id,
            ok: true,
            data: { rows: data.card_type_name === 'task' ? [task] : [] },
          };
        }
        if (key === 'attribute_def.select') {
          return {
            id: sr.id,
            ok: true,
            data: {
              rows: [
                {
                  id: 'def-status',
                  name: 'status',
                  value_type: 'card_ref',
                  is_built_in: true,
                  target_card_type_name: 'status',
                  bound_to: [{ card_type_id: '5', card_type_name: 'task', ordering: 0 }],
                },
              ],
            },
          };
        }
        if (key === 'card.search') return { id: sr.id, ok: true, data: { rows: [] } };
        // #35 TaskComments child reads (empty stream is fine for this test).
        if (key === 'activity.select') return { id: sr.id, ok: true, data: { rows: [] } };
        if (key === 'user.select') return { id: sr.id, ok: true, data: { rows: [] } };
        if (key === 'flow_step.list_for_card') {
          return { id: sr.id, ok: true, data: { rows: todoSteps() } };
        }
        if (key === 'attribute.update') {
          updates.push(data);
          return { id: sr.id, ok: true, data: { ok: true, activity_id: '1' } };
        }
        return { id: sr.id, ok: false, error: { code: 'unknown', message: key } };
      });
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };

  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api);
  M.registerGridCardRefAttrs();
  M.registerAdminSpecs(api);
  M.registerCardSearchSpec(api);
  M.registerTransitionSpecs(api);
  M.registerCommentSpecs(api); // #35 TaskComments child reads/writes

  const tree = new M.TreeNode({}, []);
  const td = M.Control.New('TaskDetail', { type: 'TaskDetail', taskId: String(CARD_ID) }, { api, tree });
  td.mount(document.createElement('div'));
  document.body.appendChild(td.el);
  await settle(dispatcher);
  await settle(dispatcher);

  const slot = td.el.querySelector('[data-slot="transitions"]');
  assert.ok(slot, 'transitions slot present');
  const bar = slot.querySelector('[data-control="TransitionBar"]');
  assert.ok(bar, 'TransitionBar mounted into the transitions slot');
  assert.ok(
    bar.querySelector('[data-testid="transition-close"]'),
    'the mounted bar rendered its loaded transitions',
  );
});
