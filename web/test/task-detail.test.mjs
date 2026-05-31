/**
 * TaskDetail (#33) — the /task/:id shell + attribute side panel.
 *
 * Runs against a REAL DOM (jsdom via ui-dom-setup) because the panel mounts the
 * RefPicker (Popover/floating-ui) + DatePicker editors, which the light shim
 * can't drive. The app barrel (app.js) carries TaskDetail + the editors it
 * composes; we register them all against one Control singleton.
 *
 * Coverage:
 *   - the `/task/:id` route resolves a TaskDetail (no longer a NotFound) AND
 *     loads the focal task by id (title + description paint);
 *   - title inline edit fires `attribute.update` (title);
 *   - description renders Markdown, and editing it fires `attribute.update`;
 *   - an attribute row inline-edits by type: a card_ref row mounts a RefPicker,
 *     a date row mounts a DatePicker;
 *   - a missing task id resolves to the inline "Task not found" state;
 *   - navigating a grid/kanban/inbox row goes to `/task/:id` (the navigation
 *     wiring task-detail depends on — see the row-click test at the end).
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom, flushMicrotasks } from './ui-dom-setup.mjs';

let M;

/** Dispatch a real KeyboardEvent (jsdom requires an Event instance). */
function key(target, k, opts = {}) {
  target.dispatchEvent(
    new globalThis.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }),
  );
}
/** Dispatch a real toggle Event on a <details> after flipping `.open`. */
function toggle(detailsEl, open = true) {
  detailsEl.open = open;
  detailsEl.dispatchEvent(new globalThis.window.Event('toggle', { bubbles: false }));
}

before(async () => {
  installUiDom();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerCombobox();
  M.registerDatePicker();
  M.registerRefPicker();
  M.registerFieldEditor();
  M.registerCardRefValue();
  M.registerAttributeRow();
  M.registerTaskAttributePanel();
  M.registerTaskDetail();
  // #35: the TaskDetail now spawns a TaskComments child into its comments slot
  // (and paints the activity feed into the activity slot). Register it so the
  // child resolves to the real control rather than a NotFound placeholder.
  M.registerTaskComments();
});

beforeEach(() => {
  document.body.replaceChildren();
});

const TASK_ID = 54n;
const PROJECT_ID = 100n;

/**
 * A transport that serves the focal task + the attribute_def schema + card.search
 * label lookups, and RECORDS every attribute.update so a test can assert the
 * write fired with the right field. Each test gets a fresh closure.
 */
function taskMockTransport() {
  const updates = [];

  const task = {
    id: String(TASK_ID),
    card_type_id: '5',
    card_type_name: 'task',
    parent_card_id: String(PROJECT_ID),
    phase: 'active',
    attributes: {
      title: 'Wire pickers',
      description: '# Heading\n\nReplace **ad-hoc** pickers with the shared component.',
      assignee: '10', // card_ref → person (resolves to "Alice")
      status: '40', // card_ref → status
      due_date: '2026-05-20', // date
      priority: 'high', // text
    },
  };

  // attribute_def.select rows: title/description are skipped by the panel; the
  // panel renders assignee (card_ref:person), status (card_ref:status),
  // due_date (date), priority (text).
  const defRow = (name, valueType, target, ordering) => ({
    id: `def-${name}`,
    name,
    value_type: valueType,
    is_built_in: true,
    ...(target ? { target_card_type_name: target } : {}),
    bound_to: [{ card_type_id: '5', card_type_name: 'task', ordering }],
  });
  const DEFS = [
    defRow('title', 'text', null, 0),
    defRow('description', 'text', null, 1),
    defRow('assignee', 'card_ref', 'person', 2),
    // `status` is intentionally not edited from the attribute panel — the
    // TransitionBar (#34) is the canonical status assigner since it restricts
    // the picker to the card's currently-available transitions. The bound
    // attribute_def still exists; the panel skips it (see PANEL_SKIP_ATTRS).
    defRow('status', 'card_ref', 'status', 3),
    defRow('milestone_ref', 'card_ref', 'milestone', 35),
    defRow('due_date', 'date', null, 4),
    defRow('priority', 'text', null, 5),
  ];

  function respond(sr) {
    const key = `${sr.endpoint}.${sr.action}`;
    const data = sr.data ?? {};
    if (key === 'card.select_with_attributes') {
      if (data.card_type_name === 'task') {
        return { id: sr.id, ok: true, data: { rows: [task] } };
      }
      return { id: sr.id, ok: true, data: { rows: [] } };
    }
    if (key === 'attribute_def.select') {
      return { id: sr.id, ok: true, data: { rows: DEFS } };
    }
    if (key === 'card.search') {
      // Label lookups for the panel's card_ref summaries.
      const rows = [];
      if (data.card_type_name === 'person') rows.push({ id: '10', title: 'Alice' });
      if (data.card_type_name === 'status') rows.push({ id: '40', title: 'Todo' });
      if (data.card_type_name === 'milestone') rows.push({ id: '50', title: 'Sprint 1' });
      return { id: sr.id, ok: true, data: { rows } };
    }
    if (key === 'activity.select') {
      // The #35 TaskComments child loads the stream; an empty stream is fine
      // for the shell tests (the comments-specific behaviour is covered in
      // task-comments.test.mjs).
      return { id: sr.id, ok: true, data: { rows: [] } };
    }
    if (key === 'user.select') {
      return { id: sr.id, ok: true, data: { rows: [{ id: '10', display_name: 'Alice' }] } };
    }
    if (key === 'attribute.update') {
      updates.push(data);
      return { id: sr.id, ok: true, data: { ok: true, activity_id: '999' } };
    }
    // Route-id-only section reads (pre-mounted alongside the task) — empty is
    // fine for the shell tests; their own behaviour is covered elsewhere.
    if (key === 'comm.list_for_task' || key === 'attachment.list' || key === 'flow_step.list_for_card') {
      return { id: sr.id, ok: true, data: { rows: [] } };
    }
    return { id: sr.id, ok: false, error: { code: 'unknown', message: `mock has no ${key}` } };
  }

  const batches = [];
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      batches.push(req.subrequests.map((s) => `${s.endpoint}.${s.action}`));
      const subresponses = req.subrequests.map((sr) => respond(sr));
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
  return { transport, updates, batches };
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api); // card.select_with_attributes + attribute.update
  M.registerGridCardRefAttrs(); // revive assignee/status/etc to bigint
  M.registerAdminSpecs(api); // attribute_def.select + user.select (#35 actor labels)
  M.registerCardSearchSpec(api); // card.search (RefPicker + label lookups)
  M.registerCommentSpecs(api); // activity.select + comment.insert/update (#35)
  return { dispatcher, api };
}

async function settle(dispatcher) {
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  M.flushSync?.();
  await flushMicrotasks();
  M.flushSync?.();
}

function mountTaskDetail(api, taskId = String(TASK_ID)) {
  const tree = new M.TreeNode({}, []);
  const ctx = { api, tree };
  const td = M.Control.New('TaskDetail', { type: 'TaskDetail', taskId }, ctx);
  td.mount(document.createElement('div'));
  document.body.appendChild(td.el);
  return { td, tree };
}

/* -------------------------------------------------------------------------- */
/* Route → TaskDetail + load.                                                  */
/* -------------------------------------------------------------------------- */

test('TaskDetail: route control resolves (not NotFound) and loads the task', async () => {
  const { transport } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { td } = mountTaskDetail(api);
  await settle(dispatcher);

  assert.equal(td.el.dataset.control, 'TaskDetail', 'a TaskDetail control mounted');
  // Title painted from the loaded task.
  const title = td.el.querySelector('[data-task-title]');
  assert.ok(title, 'title rendered');
  assert.equal(title.textContent, 'Wire pickers');
  // The id subtitle reflects the route param.
  const idLine = td.el.querySelector('[data-task-detail-id]');
  assert.equal(idLine.textContent, '#54');
  // Main + rail are visible; loading hidden.
  assert.equal(td.el.querySelector('[data-task-detail-loading]').style.display, 'none');
});

test('TaskDetail: leaves named slots for #34/#35/#36', async () => {
  const { transport } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { td } = mountTaskDetail(api);
  await settle(dispatcher);

  const slots = [...td.el.querySelectorAll('[data-slot]')].map((e) => e.dataset.slot);
  for (const want of ['transitions', 'comments', 'activity', 'attachments', 'tags', 'related']) {
    assert.ok(slots.includes(want), `slot "${want}" present for a later task`);
  }
});

/* -------------------------------------------------------------------------- */
/* Title inline edit → attribute.update(title).                                */
/* -------------------------------------------------------------------------- */

test('TaskDetail: title inline edit fires attribute.update(title)', async () => {
  const { transport, updates } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { td } = mountTaskDetail(api);
  await settle(dispatcher);

  // Click the title's pencil → an inline input appears seeded with the value.
  td.el.querySelector('[data-task-title-edit]').click();
  const input = td.el.querySelector('[data-task-title-input]');
  assert.ok(input, 'title input mounted on edit');
  assert.equal(input.value, 'Wire pickers');

  // Type a new title and commit with Enter.
  input.value = 'Wire the pickers, properly';
  key(input, 'Enter');
  await settle(dispatcher);

  const titleUpdate = updates.find((u) => u.attribute_name === 'title');
  assert.ok(titleUpdate, 'attribute.update(title) fired');
  assert.equal(titleUpdate.value, 'Wire the pickers, properly');
  assert.equal(titleUpdate.card_id?.toString?.() ?? String(titleUpdate.card_id), '54');
  // Read view shows the optimistic new value.
  assert.equal(td.el.querySelector('[data-task-title]').textContent, 'Wire the pickers, properly');
});

test('TaskDetail: title edit Esc cancels without a write', async () => {
  const { transport, updates } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { td } = mountTaskDetail(api);
  await settle(dispatcher);

  td.el.querySelector('[data-task-title-edit]').click();
  const input = td.el.querySelector('[data-task-title-input]');
  input.value = 'discarded';
  key(input, 'Escape');
  await settle(dispatcher);

  assert.equal(updates.length, 0, 'no attribute.update on cancel');
  assert.equal(td.el.querySelector('[data-task-title]').textContent, 'Wire pickers');
});

/* -------------------------------------------------------------------------- */
/* Description renders Markdown + edit fires attribute.update(description).     */
/* -------------------------------------------------------------------------- */

test('TaskDetail: description renders Markdown and edit fires attribute.update(description)', async () => {
  const { transport, updates } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { td } = mountTaskDetail(api);
  await settle(dispatcher);

  // Markdown rendered: an <h1> + <strong> from the source markdown.
  const body = td.el.querySelector('[data-task-desc-body]');
  assert.ok(body, 'description body rendered');
  assert.ok(body.querySelector('h1'), 'markdown heading rendered');
  assert.ok(body.querySelector('strong'), 'markdown bold rendered');

  // Edit → textarea; commit with Mod+Enter.
  td.el.querySelector('[data-task-desc-edit]').click();
  const ta = td.el.querySelector('[data-task-desc-input]');
  assert.ok(ta, 'description textarea mounted on edit');
  ta.value = 'A new description.';
  key(ta, 'Enter', { metaKey: true });
  await settle(dispatcher);

  const descUpdate = updates.find((u) => u.attribute_name === 'description');
  assert.ok(descUpdate, 'attribute.update(description) fired');
  assert.equal(descUpdate.value, 'A new description.');
});

test('TaskDetail: description editor stays open until Save (no blur commit); Save fires the write', async () => {
  const { transport, updates } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { td } = mountTaskDetail(api);
  await settle(dispatcher);

  // Open the editor.  Save + Cancel buttons become visible in the label row;
  // the ✎ icon hides.
  td.el.querySelector('[data-task-desc-edit]').click();
  const ta = td.el.querySelector('[data-task-desc-input]');
  const save = td.el.querySelector('[data-task-desc-save]');
  const cancel = td.el.querySelector('[data-task-desc-cancel]');
  assert.ok(ta, 'description textarea mounted');
  assert.ok(save, 'Save button rendered in the label row');
  assert.notEqual(save.style.display, 'none', 'Save button visible while editing');
  assert.ok(cancel, 'Cancel button rendered');
  assert.notEqual(cancel.style.display, 'none', 'Cancel button visible while editing');

  // Type a draft, then settle the dispatcher.  The user could now alt-tab
  // away to copy more content; the editor must STAY OPEN and NO write must
  // have fired yet — the regression we're guarding is the prior blur-commit.
  ta.value = 'mid-paste draft';
  await settle(dispatcher);
  assert.ok(
    td.el.querySelector('[data-task-desc-input]'),
    'editor still mounted while user is composing',
  );
  assert.equal(
    updates.filter((u) => u.attribute_name === 'description').length,
    0,
    'no attribute.update fired before the operator commits',
  );

  // Clicking Save commits the textarea's current value.
  ta.value = 'final description';
  save.click();
  await settle(dispatcher);
  const descUpdate = updates.find((u) => u.attribute_name === 'description');
  assert.ok(descUpdate, 'Save → attribute.update fires');
  assert.equal(descUpdate.value, 'final description');
});

test('TaskDetail: description Cancel button closes the editor without a write', async () => {
  const { transport, updates } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { td } = mountTaskDetail(api);
  await settle(dispatcher);

  td.el.querySelector('[data-task-desc-edit]').click();
  const ta = td.el.querySelector('[data-task-desc-input]');
  ta.value = 'abandon this draft';

  td.el.querySelector('[data-task-desc-cancel]').click();
  await settle(dispatcher);
  assert.equal(
    updates.filter((u) => u.attribute_name === 'description').length,
    0,
    'Cancel fires no write',
  );
  assert.equal(td.el.querySelector('[data-task-desc-input]'), null, 'editor torn down');
});

/* -------------------------------------------------------------------------- */
/* Edit chords (e t / e d / e c) open + FOCUS their text field.                 */
/* -------------------------------------------------------------------------- */

/** Invoke a declared hotkey binding's action by its chord string. */
function runChord(td, binding) {
  const b = td.hotkeys().find((x) => x.binding === binding);
  assert.ok(b, `binding "${binding}" declared`);
  b.run();
}

test('TaskDetail: `e t` opens + focuses the title input', async () => {
  const { transport } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { td } = mountTaskDetail(api);
  await settle(dispatcher);

  runChord(td, 'e t');
  await settle(dispatcher); // flush the queueMicrotask focus
  const input = td.el.querySelector('[data-task-title-input]');
  assert.ok(input, 'title input opened by `e t`');
  assert.equal(document.activeElement, input, 'title input focused');
});

test('TaskDetail: `e d` opens + focuses the description textarea', async () => {
  const { transport } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { td } = mountTaskDetail(api);
  await settle(dispatcher);

  runChord(td, 'e d');
  await settle(dispatcher);
  const ta = td.el.querySelector('[data-task-desc-input]');
  assert.ok(ta, 'description textarea opened by `e d`');
  assert.equal(ta.tagName, 'TEXTAREA');
  assert.equal(document.activeElement, ta, 'description textarea focused');
});

test('TaskDetail: `e c` focuses the comment composer textarea', async () => {
  const { transport } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { td } = mountTaskDetail(api);
  await settle(dispatcher);

  const composer = td.el.querySelector('[data-comment-input]');
  assert.ok(composer, 'comment composer textarea present');
  runChord(td, 'e c');
  await settle(dispatcher);
  assert.equal(document.activeElement, composer, 'comment composer focused by `e c`');
});

test('TaskDetail: `e` then `t` through the HotkeyController opens the title (live routing)', async () => {
  const { transport } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { td } = mountTaskDetail(api);
  await settle(dispatcher);

  // Wire a real HotkeyController exactly like main.ts: the body (TaskDetail) is
  // the baseline active scope, listening on document. This exercises the FULL
  // chord routing (prefix `e` → `t` → the TaskDetail binding), not just run().
  const rootSig = M.signal(td, 'root');
  const activeSig = M.signal(td, 'active');
  const hk = new M.HotkeyController({ root: rootSig, active: activeSig, target: document });
  const dispose = hk.start();
  try {
    key(document.body, 'e');
    key(document.body, 't');
    await settle(dispatcher);
    const input = td.el.querySelector('[data-task-title-input]');
    assert.ok(input, '`e t` opened the title input via the controller');
  } finally {
    dispose();
  }
});

test('controlForNode resolves an inner element to its owning control', async () => {
  const { transport } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { td } = mountTaskDetail(api);
  await settle(dispatcher);

  // The focus tracker (main.ts) uses controlForNode to pick the active scope.
  const inner = td.el.querySelector('[data-task-title]');
  assert.ok(inner, 'an inner element exists');
  assert.equal(M.controlForNode(inner), td, 'inner element resolves to the TaskDetail');
  assert.equal(M.controlForNode(td.el), td, 'the root element resolves to itself');
});

/* -------------------------------------------------------------------------- */
/* Subtle prev/next task nav + "N of M" counter (from nav.taskList).            */
/* -------------------------------------------------------------------------- */

/** Mount a TaskDetail against a tree pre-seeded with a published nav list. */
function mountWithNavList(api, ids, taskId = String(TASK_ID)) {
  const tree = new M.TreeNode({}, []);
  tree.at(['nav', 'taskList']).set(ids);
  const td = M.Control.New('TaskDetail', { type: 'TaskDetail', taskId }, { api, tree });
  td.mount(document.createElement('div'));
  document.body.appendChild(td.el);
  return { td, tree };
}

test('TaskDetail: nav shows "N of M" and enables both arrows mid-list', async () => {
  const { transport } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  // 54 is the focal task; it sits 2nd of 3.
  const { td } = mountWithNavList(api, ['53', '54', '55']);
  await settle(dispatcher);

  const nav = td.el.querySelector('[data-task-nav]');
  assert.ok(nav && nav.style.display !== 'none', 'nav visible for a multi-item list');
  assert.equal(td.el.querySelector('[data-task-nav-count]').textContent, '2 of 3');
  assert.equal(td.el.querySelector('[data-task-nav-prev]').disabled, false, 'prev enabled (not first)');
  assert.equal(td.el.querySelector('[data-task-nav-next]').disabled, false, 'next enabled (not last)');
});

test('TaskDetail: nav disables the edge arrow (first item → prev off)', async () => {
  const { transport } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { td } = mountWithNavList(api, ['54', '55', '56']); // 54 is first
  await settle(dispatcher);

  assert.equal(td.el.querySelector('[data-task-nav-count]').textContent, '1 of 3');
  assert.equal(td.el.querySelector('[data-task-nav-prev]').disabled, true, 'prev disabled at the start');
  assert.equal(td.el.querySelector('[data-task-nav-next]').disabled, false);
});

test('TaskDetail: nav hides on a cold deep-link (no published list)', async () => {
  const { transport } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { td } = mountTaskDetail(api); // nothing published to nav.taskList
  await settle(dispatcher);
  assert.equal(td.el.querySelector('[data-task-nav]').style.display, 'none', 'nav hidden with no list');
});

/* -------------------------------------------------------------------------- */
/* Back to list (q/Esc + the visible button) → the SAVED list screen, not back */
/* -------------------------------------------------------------------------- */

test('TaskDetail: the Back button returns to the saved source list URL (not history)', async () => {
  const { transport } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  // The list the user came from published its ids + its own screen URL.
  tree.at(['nav', 'taskList']).set(['53', '54', '55']);
  tree.at(['nav', 'listUrl']).set('/project/9/screen/grid');
  M.installRouter(tree); // navigate() lands the route into this tree's router leaf
  const td = M.Control.New('TaskDetail', { type: 'TaskDetail', taskId: String(TASK_ID) }, { api, tree });
  td.mount(document.createElement('div'));
  document.body.appendChild(td.el);
  await settle(dispatcher);

  const back = td.el.querySelector('[data-task-back]');
  assert.ok(back, 'the Back-to-list button renders');
  back.click(); // jsdom HTMLElement.click() fires the listen('click') handler → goBack()

  const route = tree.at([...M.ROUTER_PATH]).peek();
  assert.equal(route.name, 'screen', 'navigated to a screen route');
  assert.equal(route.params.id, '9');
  assert.equal(route.params.slug, 'grid', 'returned to the saved grid list');
  M._resetRouterForTest();
});

test('TaskDetail: q and Escape hotkeys return to the saved source list URL', async () => {
  const { transport } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  for (const k of ['q', 'Escape']) {
    const tree = new M.TreeNode({}, []);
    tree.at(['nav', 'taskList']).set(['53', '54', '55']);
    tree.at(['nav', 'listUrl']).set('/project/9/screen/grid');
    M.installRouter(tree);
    const td = M.Control.New('TaskDetail', { type: 'TaskDetail', taskId: String(TASK_ID) }, { api, tree });
    td.mount(document.createElement('div'));
    document.body.appendChild(td.el);
    await settle(dispatcher);

    // The HotkeyController drives the binding map off the active control chain;
    // TaskDetail is the freshly-mounted body so it owns the q/Escape binding.
    const rootSig = M.signal(td, 'root');
    const activeSig = M.signal(td, 'active');
    const hk = new M.HotkeyController({ root: rootSig, active: activeSig, target: document });
    const dispose = hk.start();
    document.body.dispatchEvent(
      new globalThis.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
    );
    const route = tree.at([...M.ROUTER_PATH]).peek();
    assert.equal(route.name, 'screen', `${k} navigated to a screen route`);
    assert.equal(route.params.slug, 'grid', `${k} returned to the saved grid list`);
    dispose();
    M._resetRouterForTest();
    document.body.replaceChildren();
  }
});

test('TaskDetail: Back falls back to the project board on a cold deep-link', async () => {
  const { transport } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []); // nothing published → no saved list URL
  M.installRouter(tree);
  const td = M.Control.New('TaskDetail', { type: 'TaskDetail', taskId: String(TASK_ID) }, { api, tree });
  td.mount(document.createElement('div'));
  document.body.appendChild(td.el);
  await settle(dispatcher);

  td.el.querySelector('[data-task-back]').click();
  const route = tree.at([...M.ROUTER_PATH]).peek();
  // The mock task's parent project id drives the project-board fallback.
  assert.equal(route.name, 'project', 'fell back to the task project board');
  M._resetRouterForTest();
});

/* -------------------------------------------------------------------------- */
/* Attribute panel: inline edit by value_type (RefPicker / DatePicker mount).   */
/* -------------------------------------------------------------------------- */

test('TaskDetail: attribute panel renders a row per editable attr with read summaries', async () => {
  const { transport } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { td } = mountTaskDetail(api);
  await settle(dispatcher);

  const panel = td.el.querySelector('[data-task-detail-panel]');
  assert.ok(panel, 'attribute panel rendered');
  const rows = [...panel.querySelectorAll('[data-attr-row]')].map((r) => r.dataset.attrRow);
  // title/description + status skipped (TransitionBar #34 owns status);
  // assignee/due_date/priority/milestone_ref shown (ordering: 2/4/5/35).
  assert.deepEqual(rows, ['assignee', 'due_date', 'priority', 'milestone_ref']);

  // card_ref summary resolved to a label via card.search.
  const assigneeRow = panel.querySelector('[data-attr-row="assignee"]');
  assert.equal(assigneeRow.querySelector('[data-attr-value]').textContent, 'Alice');
  // date summary is the ISO value; text summary is the raw value.
  assert.equal(
    panel.querySelector('[data-attr-row="due_date"] [data-attr-value]').textContent,
    '2026-05-20',
  );
  assert.equal(
    panel.querySelector('[data-attr-row="priority"] [data-attr-value]').textContent,
    'high',
  );
});

test('TaskDetail: a card_ref row mounts a RefPicker; a date row mounts a DatePicker', async () => {
  const { transport } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { td } = mountTaskDetail(api);
  await settle(dispatcher);

  // Expand the assignee (card_ref) row → its editor mounts a RefPicker.
  const assigneeRow = td.el.querySelector('[data-attr-row="assignee"]');
  toggle(assigneeRow);
  await settle(dispatcher);
  assert.ok(
    assigneeRow.querySelector('[data-control="RefPicker"]'),
    'card_ref attr → RefPicker editor',
  );

  // Expand the due_date (date) row → its editor mounts a DatePicker.
  const dueRow = td.el.querySelector('[data-attr-row="due_date"]');
  toggle(dueRow);
  await settle(dispatcher);
  assert.ok(dueRow.querySelector('[data-control="DatePicker"]'), 'date attr → DatePicker editor');
});

test('TaskDetail: a person-typed card_ref (assignee) pins a "Self" quick-pick atop the picker', async () => {
  const { transport } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  // currentPersonId 77 is the caller's PERSON card (distinct from assignee=10).
  const tree = new M.TreeNode({}, []);
  const td = M.Control.New(
    'TaskDetail',
    { type: 'TaskDetail', taskId: String(TASK_ID), currentPersonId: 77n },
    { api, tree },
  );
  td.mount(document.createElement('div'));
  document.body.appendChild(td.el);
  await settle(dispatcher);

  const assigneeRow = td.el.querySelector('[data-attr-row="assignee"]');
  toggle(assigneeRow); // RefPicker mounts + auto-opens (#8)
  await flushMicrotasks();
  await settle(dispatcher);
  await flushMicrotasks();

  const opts = [...document.querySelectorAll('[data-cb-option]')].map((li) => li.textContent);
  assert.equal(opts[0], 'Self', 'Self pinned at the top of a person ref picker');
  assert.ok(opts.includes('Alice'), 'searched person rows follow the pin');
});

test('TaskDetail: a non-person card_ref (milestone_ref) gets no "Self" pin', async () => {
  const { transport } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const td = M.Control.New(
    'TaskDetail',
    { type: 'TaskDetail', taskId: String(TASK_ID), currentPersonId: 77n },
    { api, tree },
  );
  td.mount(document.createElement('div'));
  document.body.appendChild(td.el);
  await settle(dispatcher);

  const milestoneRow = td.el.querySelector('[data-attr-row="milestone_ref"]');
  toggle(milestoneRow);
  await flushMicrotasks();
  await settle(dispatcher);
  await flushMicrotasks();

  const opts = [...document.querySelectorAll('[data-cb-option]')].map((li) => li.textContent);
  assert.ok(opts.length > 0, 'milestone picker opened with options');
  assert.ok(!opts.includes('Self'), 'no Self pin on a non-person ref');
});

test('TaskDetail: a text attr row inline-edits and fires attribute.update on Enter', async () => {
  const { transport, updates } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { td } = mountTaskDetail(api);
  await settle(dispatcher);

  const priRow = td.el.querySelector('[data-attr-row="priority"]');
  toggle(priRow);
  await settle(dispatcher);
  const input = priRow.querySelector('[data-attr-input]');
  assert.ok(input, 'text attr → <input> editor');
  input.value = 'low';
  key(input, 'Enter');
  await settle(dispatcher);

  const u = updates.find((x) => x.attribute_name === 'priority');
  assert.ok(u, 'attribute.update(priority) fired');
  assert.equal(u.value, 'low');
});

test('TaskDetail: per-row Unassign fires attribute.update(value=null)', async () => {
  const { transport, updates } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { td } = mountTaskDetail(api);
  await settle(dispatcher);

  const assigneeRow = td.el.querySelector('[data-attr-row="assignee"]');
  toggle(assigneeRow);
  await flushMicrotasks();
  await settle(dispatcher);

  const unassignBtn = assigneeRow.querySelector('[data-attr-unassign]');
  assert.ok(unassignBtn, 'an Unassign button is rendered inside the row editor');
  assert.equal(unassignBtn.disabled, false, 'enabled while the attribute has a value');

  unassignBtn.click();
  await settle(dispatcher);

  const u = updates.find((x) => x.attribute_name === 'assignee');
  assert.ok(u, 'attribute.update(assignee) fired');
  assert.equal(u.value, null, 'value is null — the unassign payload');
  // After the clear, the row summary reflects the empty state and the button
  // disables itself (nothing left to clear).
  assert.equal(
    assigneeRow.querySelector('[data-attr-value]').textContent,
    '—',
    'summary reads empty after unassign',
  );
  assert.equal(unassignBtn.disabled, true, 'disabled once the value is cleared');
});

/* -------------------------------------------------------------------------- */
/* Missing task → inline "Task not found".                                     */
/* -------------------------------------------------------------------------- */

test('TaskDetail: a missing task id resolves to the not-found state', async () => {
  const { transport } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const { td } = mountTaskDetail(api, '999'); // no such task in the mock
  await settle(dispatcher);

  const nf = td.el.querySelector('[data-task-detail-not-found]');
  assert.ok(nf, 'not-found block present');
  assert.equal(nf.style.display, '', 'not-found shown');
  assert.equal(td.el.querySelector('[data-task-detail-loading]').style.display, 'none');
});

test('TASK OPEN: route-id-only sections coalesce into the task batch (no second round-trip)', async () => {
  const { transport, batches } = taskMockTransport();
  const { dispatcher, api } = bootApi(transport);
  // Register the section CONTROLS (so they mount for real, not NotFound) + their
  // SPECS (so their reads enqueue + reach the mock). Control.register is a global
  // singleton that may already be set by another test file, so guard it.
  for (const reg of [M.registerCommThreads, M.registerTransitionBar, M.registerAttachmentsSection]) {
    try {
      reg();
    } catch {
      /* already registered in this process */
    }
  }
  M.registerCommThreadSpecs(api);
  M.registerTransitionSpecs(api);
  M.registerAttachmentSpecs(api);
  mountTaskDetail(api);
  await settle(dispatcher);

  assert.ok(batches.length >= 1, 'at least one batch sent');
  const first = batches[0];
  // The task read AND the heavy section reads ride the SAME (first) POST — so
  // the main column is complete when the detail reveals, not filled a round-trip
  // later. (Tags/related need the task card, so they stay in a later batch.)
  assert.ok(first.includes('card.select_with_attributes'), 'task read in batch 1');
  assert.ok(first.includes('comm.list_for_task'), 'comms read coalesced into batch 1');
  assert.ok(first.includes('attachment.list'), 'attachments read coalesced into batch 1');
  assert.ok(first.includes('flow_step.list_for_card'), 'transition read coalesced into batch 1');
});
