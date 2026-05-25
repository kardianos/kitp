/**
 * RelatedTasksPanel (#36) — parent chip + relationship + children, on a REAL DOM
 * (jsdom, because the parent picker composes the RefPicker/Combobox/floating-ui).
 *
 * Coverage:
 *   - children load via `card.select_with_attributes` with a
 *     `parent_task = me` predicate and render with their relationship pills;
 *   - "Set parent" → picking a task + Save fires `attribute.update(parent_task)`
 *     AND `attribute.update(parent_relationship)` (the chip appears optimistically);
 *   - the parent relationship dropdown commits `attribute.update(parent_relationship)`;
 *   - Remove clears both attrs via `attribute.update` (parent chip → "Set parent").
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom, flushMicrotasks } from './ui-dom-setup.mjs';

let M;

const CARD_ID = 54n;

before(async () => {
  installUiDom();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerCombobox();
  M.registerRefPicker();
  M.registerRelatedTasksPanel();
});

beforeEach(() => {
  document.body.replaceChildren();
});

function taskRow(id, title, parentTask, relationship) {
  const attributes = { title };
  if (parentTask !== undefined) attributes.parent_task = String(parentTask);
  if (relationship !== undefined) attributes.parent_relationship = relationship;
  return { id: String(id), card_type_id: '5', card_type_name: 'task', attributes };
}

/** Transport serving card.select_with_attributes (children) + card.search +
 *  attribute.update (records every write). */
function relatedHarness(opts = {}) {
  const updates = [];
  const children = opts.children ?? [];
  const tasks = opts.tasks ?? { 80: 'Epic A', 81: 'Epic B' };

  function respond(sr) {
    const k = `${sr.endpoint}.${sr.action}`;
    const data = sr.data ?? {};
    if (k === 'card.select_with_attributes') {
      // The children query carries a parent_task = me predicate.
      return { id: sr.id, ok: true, data: { rows: children } };
    }
    if (k === 'card.search') {
      let rows;
      if (Array.isArray(data.ids) && data.ids.length > 0) {
        rows = data.ids.map((id) => ({ id: String(id), title: tasks[String(id)] ?? `Task ${id}` }));
      } else {
        rows = Object.keys(tasks).map((id) => ({ id, title: tasks[id] }));
      }
      return { id: sr.id, ok: true, data: { rows } };
    }
    if (k === 'attribute.update') {
      updates.push(data);
      return { id: sr.id, ok: true, data: { ok: true, activity_id: '900' } };
    }
    return { id: sr.id, ok: false, error: { code: 'unknown', message: `mock has no ${k}` } };
  }

  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      return { status: 200, text: JSON.stringify({ subresponses: req.subrequests.map(respond) }) };
    },
  };
  return { transport, updates };
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api); // card.select_with_attributes + attribute.update
  M.registerCardSearchSpec(api);
  M.registerAttachmentSpecs(api); // primes parent_task card_ref revival
  return { dispatcher, api };
}

async function settle(dispatcher) {
  for (let i = 0; i < 5; i++) await dispatcher.flushNow();
  await flushMicrotasks();
  for (let i = 0; i < 3; i++) await dispatcher.flushNow();
  await flushMicrotasks();
}

function mount(api, cfg = {}) {
  const tree = new M.TreeNode({}, []);
  const ctx = { api, tree };
  const full = { type: 'RelatedTasksPanel', cardId: String(CARD_ID), ...cfg };
  const c = M.Control.New('RelatedTasksPanel', full, ctx);
  c.mount(document.createElement('div'));
  document.body.appendChild(c.el);
  return c;
}

/* -------------------------------------------------------------------------- */

test('RelatedTasksPanel: children load via parent_task predicate + render with pills', async () => {
  const h = relatedHarness({
    children: [taskRow(91, 'Sub one', CARD_ID, 'subtask'), taskRow(92, 'Sub two', CARD_ID, 'blocker')],
  });
  const { dispatcher, api } = bootApi(h.transport);
  const c = mount(api);
  await settle(dispatcher);

  const rows = [...c.el.querySelectorAll('[data-related-child-row]')];
  assert.equal(rows.length, 2, 'two children');
  const labelEl = c.el.querySelector('[data-related-children-label]');
  assert.match(labelEl.textContent, /Children \(2\)/, 'children count shown');
  const pills = [...c.el.querySelectorAll('[data-related-child-pill]')].map((p) => p.textContent);
  assert.deepEqual(pills.sort(), ['Blocker', 'Sub-task'], 'relationship pills rendered');
});

test('RelatedTasksPanel: Set parent fires attribute.update(parent_task)+(parent_relationship)', async () => {
  const h = relatedHarness({ children: [] });
  const { dispatcher, api } = bootApi(h.transport);
  const c = mount(api);
  await settle(dispatcher);

  // Open the picker.
  c.el.querySelector('[data-related-set-parent]').click();
  await flushMicrotasks();
  assert.ok(c.el.querySelector('[data-related-parent-picker]'), 'parent picker opened');

  // Drive the RefPicker pick through the same path its onChange takes, then Save.
  c.setParent(80n, 'blocker');
  // Optimistic: the chip shows the picked parent.
  await flushMicrotasks();
  assert.ok(c.el.querySelector('[data-related-parent-chip]'), 'parent chip appears optimistically');
  await settle(dispatcher);

  const fields = h.updates.map((u) => ({ name: u.attribute_name, value: u.value }));
  assert.ok(
    fields.some((f) => f.name === 'parent_task' && f.value?.toString() === '80'),
    'attribute.update(parent_task = 80) fired',
  );
  assert.ok(
    fields.some((f) => f.name === 'parent_relationship' && f.value === 'blocker'),
    'attribute.update(parent_relationship = blocker) fired',
  );
});

test('RelatedTasksPanel: the relationship dropdown commits parent_relationship', async () => {
  const h = relatedHarness({ children: [] });
  const { dispatcher, api } = bootApi(h.transport);
  const c = mount(api, { parentTaskId: '80', parentRelationship: 'subtask', parentLabel: 'Epic A' });
  await settle(dispatcher);

  const select = c.el.querySelector('[data-related-parent-rel]');
  assert.ok(select, 'parent relationship dropdown present');
  select.value = 'related';
  select.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }));
  await settle(dispatcher);

  assert.ok(
    h.updates.some((u) => u.attribute_name === 'parent_relationship' && u.value === 'related'),
    'relationship change committed',
  );
});

test('RelatedTasksPanel: Remove clears parent_task + parent_relationship', async () => {
  const h = relatedHarness({ children: [] });
  const { dispatcher, api } = bootApi(h.transport);
  const c = mount(api, { parentTaskId: '80', parentRelationship: 'subtask', parentLabel: 'Epic A' });
  await settle(dispatcher);

  c.el.querySelector('[data-related-remove-parent]').click();
  // Optimistic: chip gone → "Set parent" shows.
  await flushMicrotasks();
  assert.ok(c.el.querySelector('[data-related-set-parent]'), 'reverts to Set-parent optimistically');
  await settle(dispatcher);

  const cleared = h.updates.filter((u) => u.value === null).map((u) => u.attribute_name);
  assert.ok(cleared.includes('parent_task'), 'parent_task cleared');
  assert.ok(cleared.includes('parent_relationship'), 'parent_relationship cleared');
});
