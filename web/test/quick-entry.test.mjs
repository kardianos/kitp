/**
 * QuickEntry — the global `n` fast-task-create overlay (#39).
 *
 * Drives the overlay on a REAL DOM (jsdom) — it spawns RefPickers (Combobox →
 * floating-ui) for assignee/tags + the "+ Add field" editors. A recording batch
 * transport + an injected chunk sink stand in for the server so no real network
 * is issued and every shipped sub-request can be asserted.
 *
 * Coverage:
 *   - `n` opens the overlay (the AppShell wires `quickCreateOpen` → open());
 *   - submit fires `card.insert` with the resolved default status + the project
 *     scope as parent;
 *   - tags + attachments coalesce: card.insert + tag.apply + attachment.create
 *     land in one batch after the pre-upload (file.create) pass;
 *   - Enter keeps the overlay open (clears for the next) / Mod+Enter closes /
 *     Esc cancels without submitting;
 *   - the success toast's Undo fires `card.delete` on the new task;
 *   - the default-create-status resolution chain (screen → flow → triage →
 *     active → error) — exercised through the pure resolver + end-to-end.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom, flushMicrotasks } from './ui-dom-setup.mjs';

let M;

const PROJECT_ID = 31n;
const NEW_CARD_ID = 900n;

before(async () => {
  installUiDom();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerQuickEntry();
  M.registerCombobox();
  M.registerRefPicker();
  M.registerDatePicker();
  M.registerFieldEditor(); // the "+ Add field" rows host one per picked attribute
  // For the AppShell-wiring test: register the shell + its outlet body controls.
  M.registerAppShell();
  M.registerScreenHost();
  M.registerScreenFilterBar();
  M.registerKanbanControls();
});

beforeEach(() => {
  document.body.replaceChildren();
  // Reset the URL to the projects landing + detach the router so each AppShell
  // mount derives a deterministic outlet.
  M._resetRouterForTest?.();
});

/** sha256 hex of bytes (the reference the mock chunk store computes). */
function sha256Hex(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/**
 * A batch transport that records every shipped sub-request + replies to the
 * specs the overlay touches: card.insert / tag.apply / attachment.create /
 * card.delete / card.search / card.select_with_attributes / the upload pipeline.
 */
function quickEntryHarness(opts = {}) {
  const sent = [];
  const seeded = new Set(opts.seededAddresses ?? []);
  const failInsert = opts.failInsert ?? false;

  function respond(sr) {
    sent.push(sr);
    const k = `${sr.endpoint}.${sr.action}`;
    const data = sr.data ?? {};
    switch (k) {
      case 'card.insert':
        if (failInsert) {
          return { id: sr.id, ok: false, error: { code: 'validation', message: 'nope' } };
        }
        return { id: sr.id, ok: true, data: { id: String(NEW_CARD_ID) } };
      case 'tag.apply':
        return { id: sr.id, ok: true, data: { ok: true, activity_id: '5001', removed_tag_ids: [] } };
      case 'attachment.create':
        return {
          id: sr.id,
          ok: true,
          data: {
            id: '9001',
            card_id: data.card_id,
            file_id: data.file_id,
            filename: 'f.txt',
            mime_type: 'text/plain',
            size_bytes: 3,
            thumb_file_id: '0',
            kind: 'other',
          },
        };
      case 'card.delete':
        return { id: sr.id, ok: true, data: { ok: true, activity_id: '5002' } };
      case 'cas.missing_chunks': {
        const missing = (data.addresses ?? []).filter((a) => !seeded.has(a));
        return { id: sr.id, ok: true, data: { missing } };
      }
      case 'file.create':
        return {
          id: sr.id,
          ok: true,
          data: {
            id: '7001',
            filename: data.filename,
            mime_type: data.mime_type,
            size_bytes: (data.chunks ?? []).reduce((a, c) => a + Number(c.size_bytes), 0),
          },
        };
      case 'card.select_with_attributes':
        return { id: sr.id, ok: true, data: { rows: opts.statusRows ?? [] } };
      case 'card.search':
        return { id: sr.id, ok: true, data: { rows: opts.searchRows ?? [] } };
      default:
        return { id: sr.id, ok: false, error: { code: 'unknown_handler', message: k } };
    }
  }

  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map(respond);
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
  // The attachment test injects an in-memory chunk POST sink via the overlay's
  // `_setPostChunkForTest` hook so no real fetch fires; this transport serves
  // the batch sub-requests (cas.missing_chunks / file.create / attachment.create).
  return { transport, sent };
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api);
  M.registerProjectSpecs(api); // card.insert
  M.registerAttachmentSpecs(api); // tag.apply / attachment.create / file.create / cas.missing_chunks
  M.registerFilterCardSpecs(api); // card.delete
  M.registerCardSearchSpec(api); // card.search (RefPicker)
  return { dispatcher, api };
}

/** Mount a QuickEntry against a fresh tree seeded with the project scope. */
function mountQuickEntry(api, config = {}) {
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(PROJECT_ID);
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const ctx = { api, tree, scope };
  const qe = M.Control.New(
    'QuickEntry',
    { type: 'QuickEntry', defaultCardType: 'task', projectScopePath: 'scope.projectId', ...config },
    ctx,
  );
  qe.mount(document.body);
  return { qe, tree };
}

async function settle(dispatcher) {
  for (let i = 0; i < 6; i++) await dispatcher.flushNow();
  await flushMicrotasks();
  for (let i = 0; i < 4; i++) await dispatcher.flushNow();
  M.flushSync?.();
}

function sentOf(sent, endpoint, action) {
  return sent.filter((sr) => sr.endpoint === endpoint && sr.action === action);
}

/* jsdom needs REAL Event objects (the light dom-shim accepted plain objects). */
function click(el) {
  el.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}
function setTitle(qe, value) {
  const t = qe.el.querySelector('[data-qe-title]');
  t.value = value;
  return t;
}
function keydown(target, key, opts = {}) {
  target.dispatchEvent(
    new globalThis.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }),
  );
}

/* -------------------------------------------------------------------------- */
/* `n` opens the overlay (via the AppShell's quickCreateOpen intent wiring).   */
/* -------------------------------------------------------------------------- */

test('the AppShell wires `n` / quickCreateOpen to open the overlay', () => {
  const { api } = bootApi(quickEntryHarness().transport);
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(PROJECT_ID);
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const ctx = { api, tree, scope };

  M.installRouter(tree);
  const shell = M.Control.New(
    'AppShell',
    {
      type: 'AppShell',
      boardConfig: { type: 'ScreenHost', screen: { slug: 'kanban', layout: 'kanban' } },
      quickEntryConfig: { type: 'QuickEntry', defaultCardType: 'task' },
    },
    ctx,
  );
  shell.mount(document.body);

  const overlays = shell.el.querySelectorAll('[data-control="QuickEntry"]');
  assert.equal(overlays.length, 1, 'the AppShell mounted ONE QuickEntry overlay');
  const overlay = overlays[0];
  assert.equal(overlay.style.display, 'none', 'overlay starts hidden');

  // The `n` hotkey raises quickCreateOpen; the shell wires it to open().
  shell.intent('quickCreateOpen');
  assert.equal(overlay.style.display, '', 'quickCreateOpen opened the overlay');
});

test('open() shows the overlay collapsed; "+ More details" reveals the region', () => {
  const { api } = bootApi(quickEntryHarness().transport);
  const { qe } = mountQuickEntry(api);
  assert.equal(qe.el.style.display, 'none', 'starts hidden');

  qe.open();
  assert.equal(qe.el.style.display, '', 'open() shows it');
  assert.ok(qe.el.querySelector('[data-qe-title]'), 'Title input present');
  assert.ok(qe.el.querySelector('[data-qe-description]'), 'Description input present');

  const region = qe.el.querySelector('[data-qe-more-region]');
  assert.equal(region.style.display, 'none', 'details collapsed by default');

  const more = qe.el.querySelector('[data-qe-more]');
  click(more);
  assert.equal(region.style.display, '', '"+ More details" reveals the region');
  assert.ok(qe.el.querySelector('[data-qe-assignee]'), 'assignee host shown');
  assert.ok(qe.el.querySelector('[data-qe-tags]'), 'tags host shown');
  assert.ok(qe.el.querySelector('[data-qe-dropzone]'), 'attachment dropzone shown');
  assert.ok(qe.el.querySelector('[data-qe-add-field]'), '"+ Add field" shown');
});

/* -------------------------------------------------------------------------- */
/* "+ Add field" rows host the shared FieldEditor (no bespoke per-type switch). */
/* -------------------------------------------------------------------------- */

test('"+ Add field" mounts a FieldEditor routed by the attr valueType', () => {
  const { api } = bootApi(quickEntryHarness().transport);
  const { qe } = mountQuickEntry(api, {
    attributePalette: [
      { name: 'priority', label: 'Priority', valueType: 'text' },
      { name: 'milestone', label: 'Milestone', valueType: 'card_ref', targetCardType: 'milestone' },
    ],
  });
  qe.open();
  click(qe.el.querySelector('[data-qe-more]')); // reveal details
  click(qe.el.querySelector('[data-qe-add-field]')); // add an empty row

  const select = qe.el.querySelector('[data-qe-attr-select]');
  assert.ok(select, 'an attribute select rendered');

  // Pick the text attr → a FieldEditor mounts, routed to a native text input.
  select.value = 'priority';
  select.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }));
  const editor = qe.el.querySelector('[data-control="FieldEditor"]');
  assert.ok(editor, 'a FieldEditor mounts in the value host');
  assert.equal(editor.dataset.fieldType, 'text', 'routed by valueType=text');
  assert.ok(editor.querySelector('[data-attr-input]'), 'native text input present');

  // Re-pick the card_ref attr → the editor re-routes to a RefPicker.
  select.value = 'milestone';
  select.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }));
  const reEditor = qe.el.querySelector('[data-control="FieldEditor"]');
  assert.equal(reEditor.dataset.fieldType, 'card_ref', 're-routed to card_ref');
  assert.ok(reEditor.querySelector('[data-control="RefPicker"]'), 'RefPicker hosted');
});

test('a committed "+ Add field" value rides the card.insert as an additional attribute', async () => {
  const statusRows = [
    { id: '200', card_type_name: 'status', phase: 'triage', attributes: { title: 'Triage', sort_order: 1 } },
  ];
  const { transport, sent } = quickEntryHarness({ statusRows });
  const { dispatcher, api } = bootApi(transport);
  const { qe } = mountQuickEntry(api, {
    attributePalette: [{ name: 'priority', label: 'Priority', valueType: 'text' }],
  });
  await settle(dispatcher);

  qe.open();
  setTitle(qe, 'Has a custom field');
  click(qe.el.querySelector('[data-qe-more]'));
  click(qe.el.querySelector('[data-qe-add-field]'));
  const select = qe.el.querySelector('[data-qe-attr-select]');
  select.value = 'priority';
  select.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }));

  // FieldEditor's text arm commits on blur — type then blur.
  const input = qe.el.querySelector('[data-control="FieldEditor"] [data-attr-input]');
  input.value = 'high';
  input.dispatchEvent(new globalThis.window.Event('blur', { bubbles: true }));

  click(qe.el.querySelector('[data-qe-add-close]'));
  await settle(dispatcher);

  const inserts = sentOf(sent, 'card', 'insert');
  assert.equal(inserts.length, 1, 'exactly one card.insert');
  assert.equal(inserts[0].data.attributes.priority, 'high', 'committed value rode the insert');
});

/* -------------------------------------------------------------------------- */
/* Submit fires card.insert with the resolved default status + project scope.  */
/* -------------------------------------------------------------------------- */

test('submit fires card.insert with the project scope as parent + resolved default status', async () => {
  // One triage status seeded → the chain resolves it (no screen/flow override).
  const statusRows = [
    { id: '201', card_type_name: 'status', phase: 'active', attributes: { title: 'Doing', sort_order: 2 } },
    { id: '200', card_type_name: 'status', phase: 'triage', attributes: { title: 'Triage', sort_order: 1 } },
  ];
  const { transport, sent } = quickEntryHarness({ statusRows });
  const { dispatcher, api } = bootApi(transport);
  const { qe } = mountQuickEntry(api);
  await settle(dispatcher); // the static quickEntryStatuses query lands candidates

  qe.open();
  qe.el.querySelector('[data-qe-title]').value = 'Write the docs';
  const addClose = qe.el.querySelector('[data-qe-add-close]');
  click(addClose);
  await settle(dispatcher);

  const inserts = sentOf(sent, 'card', 'insert');
  assert.equal(inserts.length, 1, 'exactly one card.insert');
  const data = inserts[0].data;
  assert.equal(data.card_type_name, 'task');
  assert.equal(data.title, 'Write the docs');
  assert.equal(data.parent_card_id, String(PROJECT_ID), 'parent scoped to the project');
  assert.equal(data.attributes.status, '200', 'first triage status stamped (chain step 3)');
});

test('Save & Edit saves the task then navigates to /task/:id', async () => {
  const statusRows = [
    { id: '201', card_type_name: 'status', phase: 'active', attributes: { title: 'Doing', sort_order: 2 } },
    { id: '200', card_type_name: 'status', phase: 'triage', attributes: { title: 'Triage', sort_order: 1 } },
  ];
  const { transport, sent } = quickEntryHarness({ statusRows });
  const { dispatcher, api } = bootApi(transport);
  const { qe, tree } = mountQuickEntry(api);
  M.installRouter(tree);
  await settle(dispatcher);

  qe.open();
  setTitle(qe, 'Open me');
  const editBtn = qe.el.querySelector('[data-qe-add-edit]');
  assert.ok(editBtn, 'a Save & Edit button is rendered');
  click(editBtn);
  await settle(dispatcher);

  // The task was saved.
  const inserts = sentOf(sent, 'card', 'insert');
  assert.equal(inserts.length, 1, 'exactly one card.insert');
  assert.equal(inserts[0].data.title, 'Open me');

  // And the router landed on the new task's detail route.
  const route = tree.at([...M.ROUTER_PATH]).peek();
  assert.equal(route.name, 'task', 'navigated to a task detail route');
  assert.equal(route.params.id, String(NEW_CARD_ID), 'route id is the new card id');
  // Overlay is closed (the navigate hands focus to the detail screen).
  assert.equal(qe.el.style.display, 'none', 'overlay closed after Save & Edit');
  M._resetRouterForTest();
});

test('submit stamps the screen base phase status (active board → first active)', async () => {
  // Same two statuses; a Board-style screen whose base phase is 'active' must
  // seed the first ACTIVE status (201), NOT the first triage (200).
  const statusRows = [
    { id: '201', card_type_name: 'status', phase: 'active', attributes: { title: 'Doing', sort_order: 2 } },
    { id: '200', card_type_name: 'status', phase: 'triage', attributes: { title: 'Triage', sort_order: 1 } },
  ];
  const { transport, sent } = quickEntryHarness({ statusRows });
  const { dispatcher, api } = bootApi(transport);
  const { qe, tree } = mountQuickEntry(api);
  // The ScreenHost seeds this leaf for the active screen; a Board has active on.
  tree.at(['screen', 'phaseToggles']).set([
    { label: 'Active', phase: 'active', defaultOn: true },
    { label: 'Closed', phase: 'terminal', defaultOn: false },
  ]);
  await settle(dispatcher);

  qe.open();
  qe.el.querySelector('[data-qe-title]').value = 'On a board';
  click(qe.el.querySelector('[data-qe-add-close]'));
  await settle(dispatcher);

  const data = sentOf(sent, 'card', 'insert')[0].data;
  assert.equal(data.attributes.status, '201', 'base phase active → first active status');
});

test('submit of a sub-task stamps first active regardless of screen base phase', async () => {
  // A triage-base screen + a "+ New sub-task" prefill → still first active (201).
  const statusRows = [
    { id: '201', card_type_name: 'status', phase: 'active', attributes: { title: 'Doing', sort_order: 2 } },
    { id: '200', card_type_name: 'status', phase: 'triage', attributes: { title: 'Triage', sort_order: 1 } },
  ];
  const { transport, sent } = quickEntryHarness({ statusRows });
  const { dispatcher, api } = bootApi(transport);
  const { qe, tree } = mountQuickEntry(api);
  tree.at(['screen', 'phaseToggles']).set([
    { label: 'Triage', phase: 'triage', defaultOn: true },
  ]);
  await settle(dispatcher);

  qe.open({
    prefill: {
      extraAttributes: [
        { name: 'parent_task', value: 42n },
        { name: 'parent_relationship', value: 'subtask' },
      ],
    },
  });
  qe.el.querySelector('[data-qe-title]').value = 'A sub-task';
  click(qe.el.querySelector('[data-qe-add-close]'));
  await settle(dispatcher);

  const data = sentOf(sent, 'card', 'insert')[0].data;
  assert.equal(data.attributes.status, '201', 'sub-task → first active even on a triage screen');
  assert.equal(data.attributes.parent_task, '42', 'sub-task link rides the insert');
});

test('no project scope → submit surfaces an inline error (no card.insert)', async () => {
  const { transport, sent } = quickEntryHarness();
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(null);
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const qe = M.Control.New('QuickEntry', { type: 'QuickEntry', defaultCardType: 'task' }, { api, tree, scope });
  qe.mount(document.body);

  qe.open();
  qe.el.querySelector('[data-qe-title]').value = 'Orphan task';
  const addClose = qe.el.querySelector('[data-qe-add-close]');
  click(addClose);
  await settle(dispatcher);

  const err = qe.el.querySelector('[data-qe-error]');
  assert.equal(err.style.display, '', 'an inline error is shown');
  assert.match(err.textContent, /Pick a project/);
  assert.equal(sentOf(sent, 'card', 'insert').length, 0, 'no insert fired without a parent');
});

/* -------------------------------------------------------------------------- */
/* Tags coalesce: card.insert + tag.apply land in the SAME batch.              */
/* -------------------------------------------------------------------------- */

test('tags coalesce: card.insert + tag.apply ride one batch after the insert resolves', async () => {
  const { transport, sent } = quickEntryHarness();
  const { dispatcher, api } = bootApi(transport);
  const { qe } = mountQuickEntry(api);

  qe.open();
  qe.el.querySelector('[data-qe-title]').value = 'Tagged task';
  // Inject tag selections through the public submission path: open details so
  // the tags picker mounts, then drive its multi onChange via the control's
  // internal tagIds (the RefPicker's chip add fires onChangeMulti).
  const more = qe.el.querySelector('[data-qe-more]');
  click(more);
  // Simulate the tags picker reporting two chosen tag ids.
  qe._setTagsForTest([301n, 302n]);

  const addClose = qe.el.querySelector('[data-qe-add-close]');
  click(addClose);
  await settle(dispatcher);

  assert.equal(sentOf(sent, 'card', 'insert').length, 1, 'one card.insert');
  const applies = sentOf(sent, 'tag', 'apply');
  assert.equal(applies.length, 2, 'one tag.apply per chosen tag');
  assert.deepEqual(
    applies.map((sr) => sr.data.target_card_id).sort(),
    [String(NEW_CARD_ID), String(NEW_CARD_ID)],
    'tags applied to the NEW card id',
  );
  assert.deepEqual(applies.map((sr) => sr.data.tag_card_id).sort(), ['301', '302']);
});

/* -------------------------------------------------------------------------- */
/* Attachments coalesce: pre-upload (file.create) THEN insert + attachment.    */
/* -------------------------------------------------------------------------- */

test('attachments coalesce: file uploads first, then card.insert + attachment.create', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const { transport, sent } = quickEntryHarness();
  const { dispatcher, api } = bootApi(transport);
  const { qe } = mountQuickEntry(api);

  qe.open();
  qe.el.querySelector('[data-qe-title]').value = 'With a file';

  // Queue a file + inject an in-memory chunk POST sink so no real fetch fires.
  const file = new globalThis.File([bytes], 'note.txt', { type: 'text/plain' });
  qe._queueFilesForTest([file]);
  qe._setPostChunkForTest((blob, onDone) => {
    void blob.arrayBuffer().then((buf) => {
      const u8 = new Uint8Array(buf);
      onDone({ address: sha256Hex(u8), sizeBytes: u8.length });
    });
  });

  const addClose = qe.el.querySelector('[data-qe-add-close]');
  click(addClose);
  await settle(dispatcher);

  // The file was materialised (file.create) BEFORE the bind.
  const fileCreates = sentOf(sent, 'file', 'create');
  assert.equal(fileCreates.length, 1, 'one file.create (pre-upload pass)');
  const inserts = sentOf(sent, 'card', 'insert');
  assert.equal(inserts.length, 1, 'one card.insert');
  const attaches = sentOf(sent, 'attachment', 'create');
  assert.equal(attaches.length, 1, 'one attachment.create');
  assert.equal(attaches[0].data.card_id, String(NEW_CARD_ID), 'bound to the new card');
  assert.equal(attaches[0].data.file_id, '7001', 'bound to the pre-uploaded file id');
});

/* -------------------------------------------------------------------------- */
/* Enter keeps open (clears) / Mod+Enter closes / Esc cancels.                 */
/* -------------------------------------------------------------------------- */

test('Enter submits and KEEPS the overlay open (clears the title for the next)', async () => {
  const { transport, sent } = quickEntryHarness();
  const { dispatcher, api } = bootApi(transport);
  const { qe } = mountQuickEntry(api);

  qe.open();
  const title = qe.el.querySelector('[data-qe-title]');
  title.value = 'First';
  keydown(title, 'Enter');
  await settle(dispatcher);

  assert.equal(sentOf(sent, 'card', 'insert').length, 1, 'Enter submitted');
  assert.equal(qe.el.style.display, '', 'overlay stays OPEN after Enter');
  assert.equal(title.value, '', 'title cleared for the next entry');
});

test('Mod+Enter submits and CLOSES the overlay', async () => {
  const { transport, sent } = quickEntryHarness();
  const { dispatcher, api } = bootApi(transport);
  const { qe } = mountQuickEntry(api);

  qe.open();
  const title = qe.el.querySelector('[data-qe-title]');
  title.value = 'Done';
  keydown(title, 'Enter', { ctrlKey: true });
  await settle(dispatcher);

  assert.equal(sentOf(sent, 'card', 'insert').length, 1, 'Mod+Enter submitted');
  assert.equal(qe.el.style.display, 'none', 'overlay CLOSED after Mod+Enter');
});

test('Esc cancels without submitting', async () => {
  const { transport, sent } = quickEntryHarness();
  const { dispatcher, api } = bootApi(transport);
  const { qe } = mountQuickEntry(api);

  qe.open();
  const title = qe.el.querySelector('[data-qe-title]');
  title.value = 'Abandoned';
  keydown(title, 'Escape');
  await settle(dispatcher);

  assert.equal(qe.el.style.display, 'none', 'Esc closed the overlay');
  assert.equal(sentOf(sent, 'card', 'insert').length, 0, 'no insert fired on cancel');
});

/* -------------------------------------------------------------------------- */
/* Success toast Undo fires card.delete on the new task.                       */
/* -------------------------------------------------------------------------- */

test('the success toast Undo fires card.delete on the new task', async () => {
  const { transport, sent } = quickEntryHarness();
  const { dispatcher, api } = bootApi(transport);
  const { qe } = mountQuickEntry(api);

  qe.open();
  qe.el.querySelector('[data-qe-title]').value = 'Undo me';
  const addClose = qe.el.querySelector('[data-qe-add-close]');
  click(addClose);
  await settle(dispatcher);

  assert.equal(sentOf(sent, 'card', 'insert').length, 1, 'created the task');
  const toast = document.body.querySelector('[data-qe-toast]');
  assert.ok(toast, 'a success toast appeared');
  assert.ok(toast.classList.contains('qe-toast--show'), 'toast is shown');

  const undo = toast.querySelector('[data-qe-toast-undo]');
  click(undo);
  await settle(dispatcher);

  const deletes = sentOf(sent, 'card', 'delete');
  assert.equal(deletes.length, 1, 'Undo fired one card.delete');
  assert.equal(deletes[0].data.card_id, String(NEW_CARD_ID), 'deleted the new card');
});

/* -------------------------------------------------------------------------- */
/* Default-create-status resolution chain (pure resolver).                     */
/* -------------------------------------------------------------------------- */

test('default-status chain: screen.default_create_status wins (step 1)', () => {
  const r = M.resolveDefaultCreateStatus({
    screenCard: { id: 1n, card_type_name: 'screen', attributes: { default_create_status: '777' } },
    flow: { id: 2n, default_create_status_id: 888n },
    candidateStatuses: [
      { id: 999n, card_type_name: 'status', phase: 'triage', attributes: { sort_order: 0 } },
    ],
  });
  assert.deepEqual(r, { statusCardId: 777n }, 'screen override beats flow + candidates');
});

test('default-status chain: flow default when no screen override (step 2)', () => {
  const r = M.resolveDefaultCreateStatus({
    screenCard: { id: 1n, card_type_name: 'screen', attributes: {} },
    flow: { id: 2n, default_create_status_id: 888n },
    candidateStatuses: [
      { id: 999n, card_type_name: 'status', phase: 'triage', attributes: { sort_order: 0 } },
    ],
  });
  assert.deepEqual(r, { statusCardId: 888n }, 'flow default beats candidates');
});

test('default-status chain: first triage by sort_order (step 3)', () => {
  const r = M.resolveDefaultCreateStatus({
    screenCard: null,
    flow: null,
    candidateStatuses: [
      { id: 11n, card_type_name: 'status', phase: 'active', attributes: { sort_order: 1 } },
      { id: 12n, card_type_name: 'status', phase: 'triage', attributes: { sort_order: 5 } },
      { id: 13n, card_type_name: 'status', phase: 'triage', attributes: { sort_order: 2 } },
    ],
  });
  assert.deepEqual(r, { statusCardId: 13n }, 'lowest-sort_order triage wins');
});

test('default-status chain: falls to first active when no triage (step 4)', () => {
  const r = M.resolveDefaultCreateStatus({
    screenCard: null,
    flow: null,
    candidateStatuses: [
      { id: 21n, card_type_name: 'status', phase: 'active', attributes: { sort_order: 9 } },
      { id: 22n, card_type_name: 'status', phase: 'active', attributes: { sort_order: 3 } },
    ],
  });
  assert.deepEqual(r, { statusCardId: 22n }, 'lowest-sort_order active wins');
});

test('default-status chain: bottoms out with flow_no_default', () => {
  const r = M.resolveDefaultCreateStatus({ screenCard: null, flow: null, candidateStatuses: [] });
  assert.equal(r.error, 'flow_no_default');
  assert.match(r.message, /no valid starting status/);
});

test('default-status chain: sub-task → first active, ignoring screen/flow/base (step 0)', () => {
  const r = M.resolveDefaultCreateStatus({
    // A screen override + flow default + a triage base phase are all present;
    // a sub-task must still land in the first ACTIVE status.
    screenCard: { id: 1n, card_type_name: 'screen', attributes: { default_create_status: '777' } },
    flow: { id: 2n, default_create_status_id: 888n },
    basePhase: 'triage',
    subtask: true,
    candidateStatuses: [
      { id: 31n, card_type_name: 'status', phase: 'triage', attributes: { sort_order: 0 } },
      { id: 32n, card_type_name: 'status', phase: 'active', attributes: { sort_order: 5 } },
      { id: 33n, card_type_name: 'status', phase: 'active', attributes: { sort_order: 2 } },
    ],
  });
  assert.deepEqual(r, { statusCardId: 33n }, 'sub-task uses lowest-sort_order active');
});

test('default-status chain: sub-task with no active falls through to triage', () => {
  const r = M.resolveDefaultCreateStatus({
    screenCard: null,
    flow: null,
    subtask: true,
    candidateStatuses: [
      { id: 41n, card_type_name: 'status', phase: 'triage', attributes: { sort_order: 1 } },
    ],
  });
  assert.deepEqual(r, { statusCardId: 41n }, 'sub-task falls through when no active exists');
});

test('default-status chain: base phase active beats first triage (step 3)', () => {
  const r = M.resolveDefaultCreateStatus({
    // No screen override, no flow; a Board-style screen (base phase = active)
    // must seed the first ACTIVE status even though a triage status exists.
    screenCard: null,
    flow: null,
    basePhase: 'active',
    candidateStatuses: [
      { id: 51n, card_type_name: 'status', phase: 'triage', attributes: { sort_order: 0 } },
      { id: 52n, card_type_name: 'status', phase: 'active', attributes: { sort_order: 7 } },
      { id: 53n, card_type_name: 'status', phase: 'active', attributes: { sort_order: 3 } },
    ],
  });
  assert.deepEqual(r, { statusCardId: 53n }, 'base phase active picks lowest-sort_order active');
});

test('default-status chain: base phase triage picks first triage (step 3)', () => {
  const r = M.resolveDefaultCreateStatus({
    screenCard: null,
    flow: null,
    basePhase: 'triage',
    candidateStatuses: [
      { id: 61n, card_type_name: 'status', phase: 'active', attributes: { sort_order: 0 } },
      { id: 62n, card_type_name: 'status', phase: 'triage', attributes: { sort_order: 4 } },
    ],
  });
  assert.deepEqual(r, { statusCardId: 62n }, 'base phase triage picks the triage status');
});

test('overlay surfaces flow_no_default inline when a task has no status source', async () => {
  // A screen card path is configured (so the chain runs) but it has no
  // default_create_status, no flow, and no candidates → the chain errors.
  const { transport, sent } = quickEntryHarness({ statusRows: [] });
  const { dispatcher, api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(PROJECT_ID);
  // Seed an empty screen card so hasSource is true but the chain bottoms out.
  tree.at(['quickEntry', 'screen']).set({ id: 5n, card_type_name: 'screen', attributes: {} });
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const qe = M.Control.New(
    'QuickEntry',
    { type: 'QuickEntry', defaultCardType: 'task', screenCardPath: 'quickEntry.screen' },
    { api, tree, scope },
  );
  qe.mount(document.body);
  await settle(dispatcher);

  qe.open();
  qe.el.querySelector('[data-qe-title]').value = 'Statusless';
  const addClose = qe.el.querySelector('[data-qe-add-close]');
  click(addClose);
  await settle(dispatcher);

  const err = qe.el.querySelector('[data-qe-error]');
  assert.equal(err.style.display, '', 'inline error shown');
  assert.match(err.textContent, /no valid starting status/);
  assert.equal(sentOf(sent, 'card', 'insert').length, 0, 'no insert when the chain errors');
});

/* -------------------------------------------------------------------------- */
/* Submission builders (pure).                                                 */
/* -------------------------------------------------------------------------- */

test('buildInsertAttributes merges default-status → assignee → prefill → additional', () => {
  const attrs = M.buildInsertAttributes({
    cardTypeName: 'task',
    title: 't',
    description: 'desc',
    defaultStatusCardId: 200n,
    prefill: { assigneeUserId: 50n, laneAttribute: { name: 'milestone', value: 9n } },
    additionalAttributes: [{ name: 'priority', value: 'high' }, { name: 'empty', value: '' }],
  });
  assert.equal(attrs.status, 200n);
  assert.equal(attrs.description, 'desc');
  assert.equal(attrs.assignee, 50n);
  assert.equal(attrs.milestone, 9n);
  assert.equal(attrs.priority, 'high');
  assert.equal('empty' in attrs, false, 'empty additional attribute dropped');
});

test('resolveParentForInsert: explicit > project-optional > scope > error', () => {
  assert.deepEqual(M.resolveParentForInsert('task', 7n, 31n), { parentCardId: 7n, error: null });
  assert.deepEqual(M.resolveParentForInsert('project', undefined, null), { parentCardId: null, error: null });
  assert.deepEqual(M.resolveParentForInsert('task', undefined, 31n), { parentCardId: 31n, error: null });
  const noScope = M.resolveParentForInsert('task', undefined, null);
  assert.equal(noScope.parentCardId, null);
  assert.match(noScope.error, /Pick a project/);
});
