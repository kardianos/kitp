/**
 * TagsEditor (#36) — applied-tag chips + the add-combobox over `tag` cards, on a
 * REAL DOM (jsdom, because it composes the Combobox/Popover/floating-ui).
 *
 * Coverage:
 *   - seeded tag ids render as chips with resolved labels (card.search { ids });
 *   - removing a chip fires `tag.remove { targetCardId, tagCardId }` and drops
 *     the chip OPTIMISTICALLY (before the round-trip);
 *   - applying a tag fires `tag.apply` and the chip appears OPTIMISTICALLY; the
 *     server's `removed_tag_ids` (mutual-exclusion) are reconciled out of the
 *     chip set.
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
  M.registerTagsEditor();
});

beforeEach(() => {
  document.body.replaceChildren();
});

/** Transport serving card.select_with_attributes (tag catalogue with colors) +
 *  tag.apply / tag.remove. The editor uses select_with_attributes (not search)
 *  because it needs each tag's `color` attribute, which search doesn't return. */
function tagsHarness(opts = {}) {
  const applies = [];
  const removes = [];
  // tagId → { path, color? }. Colors are the named palette tones the admin
  // Values screen sets; absent → the chip renders in the neutral default.
  const tagCards = opts.tagCards ?? {
    10: { path: 'priority/high', color: 'red' },
    11: { path: 'priority/low', color: 'green' },
    12: { path: 'area/api', color: 'blue' },
  };
  const removedOnApply = opts.removedOnApply ?? {}; // tagId → [removed ids]

  function respond(sr) {
    const k = `${sr.endpoint}.${sr.action}`;
    const data = sr.data ?? {};
    if (k === 'card.select_with_attributes') {
      // Treat the harness as project-scoped — the editor passes a
      // parent_card_id or omits it; we just return every tag either way.
      const rows = Object.keys(tagCards).map((id) => {
        const tag = tagCards[id];
        const attrs = { path: tag.path };
        if (tag.color !== undefined) attrs.color = tag.color;
        return {
          id,
          card_type_id: '9',
          card_type_name: 'tag',
          attributes: attrs,
        };
      });
      return { id: sr.id, ok: true, data: { rows } };
    }
    if (k === 'tag.apply') {
      applies.push(data);
      const removed = removedOnApply[String(data.tag_card_id)] ?? [];
      const result = { ok: true, activity_id: '900' };
      if (removed.length > 0) result.removed_tag_ids = removed.map(String);
      return { id: sr.id, ok: true, data: result };
    }
    if (k === 'tag.remove') {
      removes.push(data);
      return { id: sr.id, ok: true, data: { ok: true, activity_id: '901' } };
    }
    return { id: sr.id, ok: false, error: { code: 'unknown', message: `mock has no ${k}` } };
  }

  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      return { status: 200, text: JSON.stringify({ subresponses: req.subrequests.map(respond) }) };
    },
  };
  return { transport, applies, removes };
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api); // defines card.select_with_attributes
  M.registerAttachmentSpecs(api); // tag.apply / tag.remove
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
  const full = { type: 'TagsEditor', cardId: String(CARD_ID), ...cfg };
  const c = M.Control.New('TagsEditor', full, ctx);
  c.mount(document.createElement('div'));
  document.body.appendChild(c.el);
  return c;
}

/* -------------------------------------------------------------------------- */

test('TagsEditor: seeded tags render as chips with the SUFFIX label (slot strips the prefix)', async () => {
  const h = tagsHarness();
  const { dispatcher, api } = bootApi(h.transport);
  const c = mount(api, { initialTagIds: ['10', '12'] });
  await settle(dispatcher);

  // Two chips render — labels are the suffix after each tag's prefix ("/").
  const chips = [...c.el.querySelectorAll('[data-tag-chip]')];
  assert.equal(chips.length, 2, 'two chips (one per applied tag)');
  const labels = chips.map((ch) => ch.querySelector('.tags-editor__chip-label').textContent);
  assert.deepEqual(labels.sort(), ['api', 'high'], 'chip label is the suffix only (after the prefix slot)');

  // Each chip sits inside its prefix slot — there's one slot per known prefix.
  const slots = [...c.el.querySelectorAll('[data-tag-slot]')];
  const slotKeys = slots.map((s) => s.dataset.tagSlot);
  assert.ok(slotKeys.includes('area'), 'area slot rendered');
  assert.ok(slotKeys.includes('priority'), 'priority slot rendered');
  // priority/high (id 10) is the applied priority tag — it shows in the priority slot.
  const prioritySlot = slots.find((s) => s.dataset.tagSlot === 'priority');
  const priorityChip = prioritySlot.querySelector('[data-tag-chip]');
  assert.equal(priorityChip.dataset.tagChip, '10', 'the applied priority tag (10) shows in the priority slot');
  // Priority chips lead with the signal-bars indicator instead of wearing a
  // palette tone (the bars encode the level by shape).
  assert.equal(priorityChip.dataset.tagColor, undefined, 'priority chip wears no palette tone');
  const chipBars = priorityChip.querySelector('.priority-ind');
  assert.ok(chipBars, 'priority chip leads with the signal bars');
  assert.equal(chipBars.dataset.priority, 'high', 'bars carry the priority level');
  const areaSlot = slots.find((s) => s.dataset.tagSlot === 'area');
  const areaChip = areaSlot.querySelector('[data-tag-chip]');
  assert.equal(areaChip.dataset.tagColor, 'blue', 'area/api renders with its "blue" palette tone');
});

test('TagsEditor: removing a chip fires tag.remove + drops it optimistically', async () => {
  const h = tagsHarness();
  const { dispatcher, api } = bootApi(h.transport);
  const c = mount(api, { initialTagIds: ['10'], initialLabels: { 10: 'priority/high' } });
  await settle(dispatcher);

  const remove = c.el.querySelector('[data-tag-remove="10"]');
  assert.ok(remove, 'remove button present');
  remove.click();
  // Optimistic: chip gone immediately.
  assert.equal(c.el.querySelectorAll('[data-tag-chip]').length, 0, 'chip removed optimistically');
  await settle(dispatcher);

  assert.equal(h.removes.length, 1, 'tag.remove fired');
  assert.equal(h.removes[0].target_card_id.toString(), CARD_ID.toString());
  assert.equal(h.removes[0].tag_card_id.toString(), '10');
});

test('TagsEditor: applying a tag fires tag.apply + reconciles mutual-exclusion removals', async () => {
  // Applying 11 (priority/low) drops 10 (priority/high) via the root exclusion.
  const h = tagsHarness({ removedOnApply: { 11: [10] } });
  const { dispatcher, api } = bootApi(h.transport);
  const c = mount(api, { initialTagIds: ['10'], initialLabels: { 10: 'priority/high' } });
  await settle(dispatcher);

  // Drive the apply through the same path the add-combobox's onChange takes
  // (TS-private at compile time; a plain instance method at runtime). This is
  // exactly what selecting id 11 in the add menu invokes.
  c.applyTag(11n);
  // Optimistic: chip for 11 appears before the round-trip.
  assert.ok(
    [...c.el.querySelectorAll('[data-tag-chip]')].some((ch) => ch.dataset.tagChip === '11'),
    'applied chip appears optimistically',
  );
  await settle(dispatcher);

  assert.equal(h.applies.length, 1, 'tag.apply fired');
  assert.equal(h.applies[0].tag_card_id.toString(), '11');
  // Mutual-exclusion: 10 was reconciled out, 11 remains.
  const ids = [...c.el.querySelectorAll('[data-tag-chip]')].map((ch) => ch.dataset.tagChip);
  assert.deepEqual(ids.sort(), ['11'], 'priority/high dropped by exclusion; priority/low kept');
});
