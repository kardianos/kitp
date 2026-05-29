// EnumManager (#3): the data-driven "Enums" admin screen. Lists only attributes
// flagged enum_managed + their target card_type's value-cards (scoped to the
// active project), with add / rename / remove via the existing card handlers.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
let FakeElement;

before(async () => {
  ({ FakeElement } = installDomShim());
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerEnumManager();
});

const PROJECT = 31n;

function recordingTransport() {
  const sent = { inserts: [], updates: [], deletes: [], milestoneReads: 0, milestoneOrders: [] };
  const milestones = [
    { id: '500', card_type_name: 'milestone', parent_card_id: '31', attributes: { title: 'Q1' } },
    { id: '501', card_type_name: 'milestone', parent_card_id: '31', attributes: { title: 'Q2' } },
  ];
  function respond(sr) {
    const k = `${sr.endpoint}.${sr.action}`;
    const data = sr.data ?? {};
    if (k === 'attribute_def.select') {
      return {
        id: sr.id, ok: true,
        data: { rows: [
          { id: 'd1', name: 'milestone_ref', value_type: 'card_ref', is_built_in: true, enum_managed: true, target_card_type_name: 'milestone', bound_to: [] },
          // status is NOT enum_managed → must not appear on the screen.
          { id: 'd2', name: 'status', value_type: 'card_ref', is_built_in: true, enum_managed: false, target_card_type_name: 'status', bound_to: [] },
        ] },
      };
    }
    if (k === 'card.select_with_attributes') {
      if (data.card_type_name === 'milestone') {
        sent.milestoneReads += 1;
        if (data.order !== undefined) sent.milestoneOrders.push(data.order);
        return { id: sr.id, ok: true, data: { rows: milestones } };
      }
      return { id: sr.id, ok: true, data: { rows: [] } };
    }
    // The control loads card_type.select to learn which managed types are
    // phase-bearing (uses_phase). None here → no phase UI for these tests.
    if (k === 'card_type.select') return { id: sr.id, ok: true, data: { rows: [] } };
    if (k === 'card.insert') { sent.inserts.push(data); return { id: sr.id, ok: true, data: { id: '502' } }; }
    if (k === 'attribute.update') { sent.updates.push(data); return { id: sr.id, ok: true, data: { ok: true } }; }
    if (k === 'card.delete') { sent.deletes.push(data); return { id: sr.id, ok: true, data: { ok: true } }; }
    return { id: sr.id, ok: false, error: { code: 'unknown', message: k } };
  }
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      return { status: 200, text: JSON.stringify({ subresponses: req.subrequests.map(respond) }) };
    },
  };
  transport.sent = sent;
  return transport;
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api); // card.select_with_attributes + attribute.update
  M.registerAdminSpecs(api); // attribute_def.select
  M.registerProjectSpecs(api); // card.insert
  M.registerFilterCardSpecs(api); // card.delete
  return { dispatcher, api };
}

async function settle(dispatcher) {
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  M.flushSync?.();
}

function mount(api) {
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(PROJECT);
  const ctrl = M.Control.New('EnumManager', { type: 'EnumManager' }, { api, tree });
  ctrl.mount(new FakeElement('div'));
  return { ctrl, tree };
}

test('EnumManager lists only enum_managed attributes + their value-cards (#3)', async () => {
  const transport = recordingTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mount(api);
  await settle(dispatcher);

  const groups = ctrl.el.querySelectorAll('[data-enum-group]');
  assert.equal(groups.length, 1, 'only the enum_managed attribute (milestone) shows; status does not');
  assert.equal(groups[0].dataset.enumGroup, 'milestone');
  const values = ctrl.el.querySelectorAll('[data-enum-value]');
  assert.equal(values.length, 2, 'both milestone value-cards render');
  const names = values.map((v) => v.querySelector('[data-enum-value-input]').value).sort();
  assert.deepEqual(names, ['Q1', 'Q2']);

  // The value-cards select must order by the sort_order ATTRIBUTE using the
  // `attributes.` prefix — a bare 'sort_order' is rejected by the server
  // ("unsupported order field"), which empties the screen. `title` follows as a
  // deterministic secondary key (value-cards with no sort_order all sort null →
  // NULLS LAST, and the select appends no final tiebreaker, so without it the
  // order is non-deterministic).
  assert.ok(transport.sent.milestoneOrders.length > 0, 'value-cards select carries an order');
  assert.deepEqual(transport.sent.milestoneOrders[0], [
    { field: 'attributes.sort_order', direction: 'ASC' },
    { field: 'attributes.title', direction: 'ASC' },
  ]);
});

test('EnumManager add fires card.insert under the active project', async () => {
  const transport = recordingTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mount(api);
  await settle(dispatcher);

  const input = ctrl.el.querySelector('[data-enum-add-input="milestone"]');
  input.value = 'Q3';
  input.dispatchEvent({ type: 'input', target: input });
  ctrl.el.querySelector('[data-enum-add="milestone"]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);

  assert.equal(transport.sent.inserts.length, 1, 'one card.insert fired');
  assert.equal(transport.sent.inserts[0].card_type_name, 'milestone');
  assert.equal(String(transport.sent.inserts[0].parent_card_id), '31', 'parented to the active project');
  assert.equal(transport.sent.inserts[0].title, 'Q3');
});

test('EnumManager rename fires attribute.update(title); remove fires card.delete', async () => {
  const transport = recordingTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mount(api);
  await settle(dispatcher);

  // Rename the first value-card.
  const firstInput = ctrl.el.querySelectorAll('[data-enum-value-input]')[0];
  firstInput.value = 'Quarter 1';
  firstInput.dispatchEvent({ type: 'blur', target: firstInput });
  await settle(dispatcher);
  assert.equal(transport.sent.updates.length, 1, 'one attribute.update fired');
  assert.equal(transport.sent.updates[0].attribute_name, 'title');
  assert.equal(transport.sent.updates[0].value, 'Quarter 1');

  // Remove a value-card (confirm() is undefined in the shim → treated as ok).
  ctrl.el.querySelector('[data-enum-remove="500"]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  assert.equal(transport.sent.deletes.length, 1, 'one card.delete fired');
  assert.equal(String(transport.sent.deletes[0].card_id), '500');
});

test('EnumManager add(tag): fills the required text edge (path) from the title', async () => {
  // The `tag` card_type has a REQUIRED `path` text edge besides title; a bare
  // card.insert {title} fails edge_violation. The control fills required text
  // edges from the entered title (schema-driven — no card_type hardcoded).
  const sent = { inserts: [] };
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => {
        const k = `${sr.endpoint}.${sr.action}`;
        const data = sr.data ?? {};
        if (k === 'attribute_def.select') {
          return {
            id: sr.id, ok: true,
            data: { rows: [
              { id: 't1', name: 'tags', value_type: 'card_ref[]', is_built_in: true, enum_managed: true, target_card_type_name: 'tag', bound_to: [] },
              // path: a REQUIRED text edge on tag → must be auto-filled.
              { id: 't2', name: 'path', value_type: 'text', is_built_in: true, enum_managed: false, bound_to: [{ card_type_id: '9', card_type_name: 'tag', is_required: true }] },
              // title: required too, but it has a dedicated field → must NOT be duplicated into attributes.
              { id: 't3', name: 'title', value_type: 'text', is_built_in: true, enum_managed: false, bound_to: [{ card_type_id: '9', card_type_name: 'tag', is_required: true }] },
            ] },
          };
        }
        if (k === 'card.select_with_attributes') return { id: sr.id, ok: true, data: { rows: [] } };
        if (k === 'card.insert') { sent.inserts.push(data); return { id: sr.id, ok: true, data: { id: '900' } }; }
        return { id: sr.id, ok: true, data: {} };
      });
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mount(api);
  await settle(dispatcher);

  const input = ctrl.el.querySelector('[data-enum-add-input="tag"]');
  assert.ok(input, 'the tag enum renders an add input');
  input.value = 'area/frontend';
  input.dispatchEvent({ type: 'input', target: input });
  ctrl.el.querySelector('[data-enum-add="tag"]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);

  assert.equal(sent.inserts.length, 1, 'one card.insert fired');
  assert.equal(sent.inserts[0].card_type_name, 'tag');
  assert.equal(sent.inserts[0].title, 'area/frontend', 'title rides top-level');
  assert.deepEqual(
    sent.inserts[0].attributes,
    { path: 'area/frontend' },
    'required path edge filled from the title; title not duplicated into attributes',
  );
});

test('EnumManager reorder: no ▲/▼ buttons (drag handle is the only reorder UI)', async () => {
  const { dispatcher, api } = bootApi(recordingTransport());
  const { ctrl } = mount(api);
  await settle(dispatcher);

  assert.equal(ctrl.el.querySelectorAll('[data-enum-move-up]').length, 0, 'no up arrows');
  assert.equal(ctrl.el.querySelectorAll('[data-enum-move-down]').length, 0, 'no down arrows');
  assert.ok(ctrl.el.querySelector('[data-enum-drag]'), 'the drag handle remains');
});

test('EnumManager add: refocuses the add input so the next value can be typed', async () => {
  const transport = recordingTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mount(api);
  await settle(dispatcher);

  const input = ctrl.el.querySelector('[data-enum-add-input="milestone"]');
  input.value = 'Q3';
  input.dispatchEvent({ type: 'input', target: input });
  ctrl.el.querySelector('[data-enum-add="milestone"]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);

  // The list repainted (a fresh input node); focus returned to it + draft cleared.
  const after = ctrl.el.querySelector('[data-enum-add-input="milestone"]');
  assert.equal(document.activeElement, after, 'add input refocused after the repaint');
  assert.equal(after.value, '', 'draft cleared, ready for the next value');
});

test('EnumManager reorder: dragging a value commits via the shared drop kit (#12)', async () => {
  const transport = recordingTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mount(api);
  await settle(dispatcher);

  // Order 500, 501. Drag the LAST value (501) by its handle and drop on the
  // values container — with no layout in the shim the drop slot resolves to 0
  // (front), so 501 moves to the top.
  const handle = ctrl.el.querySelector('[data-enum-drag="501"]');
  assert.ok(handle, 'each value renders a drag handle');
  const container = ctrl.el.querySelector('[data-enum-value]').parentNode;
  handle.dispatchEvent({ type: 'dragstart', target: handle, dataTransfer: { setData() {} } });
  container.dispatchEvent({ type: 'drop', target: container, clientY: 0 });
  await settle(dispatcher);

  const order = ctrl.el.querySelectorAll('[data-enum-value]').map((v) => v.dataset.enumValue);
  assert.deepEqual(order, ['501', '500'], 'drag-drop moved 501 to the front');
  const sorts = transport.sent.updates.filter((u) => u.attribute_name === 'sort_order');
  assert.ok(sorts.length >= 1, 'sort_order ladder persisted after the drag');
});

/* -------------------------------------------------------------------------- */
/* Grouped tags: path-root buckets + per-group single-select exclusivity.       */
/* -------------------------------------------------------------------------- */

// A tag card_type carries BOTH a `path` and a `root_exclusive_at` text edge →
// the EnumManager renders it grouped by path root with per-group exclusivity.
function groupedTagTransport() {
  const sent = { inserts: [], updates: [], deletes: [] };
  const tags = [
    { id: '700', card_type_name: 'tag', parent_card_id: '31', attributes: { title: 'priority/high', path: 'priority/high', root_exclusive_at: 'priority', sort_order: 10 } },
    { id: '701', card_type_name: 'tag', parent_card_id: '31', attributes: { title: 'priority/med', path: 'priority/med', root_exclusive_at: 'priority', sort_order: 20 } },
    { id: '702', card_type_name: 'tag', parent_card_id: '31', attributes: { title: 'area/frontend', path: 'area/frontend', sort_order: 30 } },
  ];
  function respond(sr) {
    const k = `${sr.endpoint}.${sr.action}`;
    const data = sr.data ?? {};
    if (k === 'attribute_def.select') {
      return { id: sr.id, ok: true, data: { rows: [
        { id: 'g1', name: 'tags', value_type: 'card_ref[]', is_built_in: true, enum_managed: true, target_card_type_name: 'tag', bound_to: [] },
        { id: 'g2', name: 'path', value_type: 'text', is_built_in: true, enum_managed: false, bound_to: [{ card_type_id: '9', card_type_name: 'tag', is_required: true }] },
        { id: 'g3', name: 'root_exclusive_at', value_type: 'text', is_built_in: true, enum_managed: false, bound_to: [{ card_type_id: '9', card_type_name: 'tag', is_required: false }] },
        { id: 'g4', name: 'title', value_type: 'text', is_built_in: true, enum_managed: false, bound_to: [{ card_type_id: '9', card_type_name: 'tag', is_required: true }] },
      ] } };
    }
    if (k === 'card.select_with_attributes') return { id: sr.id, ok: true, data: { rows: data.card_type_name === 'tag' ? tags : [] } };
    if (k === 'card_type.select') return { id: sr.id, ok: true, data: { rows: [] } };
    if (k === 'card.insert') { sent.inserts.push(data); return { id: sr.id, ok: true, data: { id: '900' } }; }
    if (k === 'attribute.update') { sent.updates.push(data); return { id: sr.id, ok: true, data: { ok: true } }; }
    if (k === 'card.delete') { sent.deletes.push(data); return { id: sr.id, ok: true, data: { ok: true } }; }
    return { id: sr.id, ok: false, error: { code: 'unknown', message: k } };
  }
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      return { status: 200, text: JSON.stringify({ subresponses: req.subrequests.map(respond) }) };
    },
  };
  transport.sent = sent;
  return transport;
}

test('Grouped tags: render one sub-group per path root with a single-select toggle', async () => {
  const { dispatcher, api } = bootApi(groupedTagTransport());
  const { ctrl } = mount(api);
  await settle(dispatcher);

  const groups = ctrl.el.querySelectorAll('[data-enum-subgroup]').map((g) => g.dataset.enumSubgroup).sort();
  assert.deepEqual(groups, ['area', 'priority'], 'tags bucketed by path root');
  // priority's members are both exclusive at 'priority' → toggle ON; area → OFF.
  assert.equal(ctrl.el.querySelector('[data-enum-exclusive="priority"]').checked, true, 'priority is single-select');
  assert.equal(ctrl.el.querySelector('[data-enum-exclusive="area"]').checked, false, 'area is not single-select');
});

test('Grouped tags: toggling a group ON sets root_exclusive_at on every member', async () => {
  const transport = groupedTagTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mount(api);
  await settle(dispatcher);

  const toggle = ctrl.el.querySelector('[data-enum-exclusive="area"]');
  toggle.checked = true;
  toggle.dispatchEvent({ type: 'change', target: toggle });
  await settle(dispatcher);

  const ex = transport.sent.updates.filter((u) => u.attribute_name === 'root_exclusive_at');
  assert.equal(ex.length, 1, 'one member updated');
  assert.equal(String(ex[0].card_id), '702');
  assert.equal(ex[0].value, 'area', 'root_exclusive_at set to the group root');
});

test('Grouped tags: toggling a group OFF clears root_exclusive_at on every member', async () => {
  const transport = groupedTagTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mount(api);
  await settle(dispatcher);

  const toggle = ctrl.el.querySelector('[data-enum-exclusive="priority"]');
  toggle.checked = false;
  toggle.dispatchEvent({ type: 'change', target: toggle });
  await settle(dispatcher);

  const ex = transport.sent.updates.filter((u) => u.attribute_name === 'root_exclusive_at');
  assert.equal(ex.length, 2, 'both priority members cleared');
  assert.deepEqual(ex.map((u) => u.value), ['', ''], 'exclusivity cleared');
});

test('Grouped tags: add to a single-select group prepends the root + inherits exclusivity', async () => {
  const transport = groupedTagTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mount(api);
  await settle(dispatcher);

  const input = ctrl.el.querySelector('[data-enum-add-group="priority"]');
  assert.ok(input, 'priority group has its own add input');
  input.value = 'low';
  input.dispatchEvent({ type: 'input', target: input });
  ctrl.el.querySelector('[data-enum-add-group-btn="priority"]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);

  assert.equal(transport.sent.inserts.length, 1, 'one card.insert fired');
  assert.equal(transport.sent.inserts[0].title, 'priority/low', 'path becomes root/typed');
  assert.deepEqual(
    transport.sent.inserts[0].attributes,
    { path: 'priority/low', root_exclusive_at: 'priority' },
    'new value carries the full path + inherits the group exclusivity',
  );
});

test('Grouped tags: add to a non-exclusive group does not set root_exclusive_at', async () => {
  const transport = groupedTagTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mount(api);
  await settle(dispatcher);

  const input = ctrl.el.querySelector('[data-enum-add-group="area"]');
  input.value = 'backend';
  input.dispatchEvent({ type: 'input', target: input });
  ctrl.el.querySelector('[data-enum-add-group-btn="area"]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);

  assert.deepEqual(transport.sent.inserts[0].attributes, { path: 'area/backend' }, 'no exclusivity inherited');
});

test('Grouped tags: "+ New group" adds a fresh empty bucket with its own add input', async () => {
  const { dispatcher, api } = bootApi(groupedTagTransport());
  const { ctrl } = mount(api);
  await settle(dispatcher);

  const ng = ctrl.el.querySelector('[data-enum-new-group="tag"]');
  ng.value = 'severity';
  ng.dispatchEvent({ type: 'input', target: ng });
  ctrl.el.querySelector('[data-enum-new-group-add="tag"]').dispatchEvent({ type: 'click' });
  M.flushSync?.();

  assert.ok(ctrl.el.querySelector('[data-enum-subgroup="severity"]'), 'the new group renders');
  assert.ok(ctrl.el.querySelector('[data-enum-add-group="severity"]'), 'with its own add input');
  // No card.insert yet — the bucket is client-side until its first value lands.
});

/* -------------------------------------------------------------------------- */
/* Status: enum_managed + phase-bearing (uses_phase). Manage Values curates    */
/* the status value set AND each value's phase (triage/active/terminal).        */
/* -------------------------------------------------------------------------- */

function statusTransport() {
  const sent = { inserts: [], setPhases: [] };
  const statuses = [
    { id: '600', card_type_name: 'status', parent_card_id: '31', phase: 'triage', attributes: { title: 'New idea', sort_order: 10 } },
    { id: '601', card_type_name: 'status', parent_card_id: '31', phase: 'active', attributes: { title: 'Doing', sort_order: 20 } },
  ];
  function respond(sr) {
    const k = `${sr.endpoint}.${sr.action}`;
    const data = sr.data ?? {};
    if (k === 'attribute_def.select') {
      return { id: sr.id, ok: true, data: { rows: [
        { id: 's1', name: 'status', value_type: 'card_ref', is_built_in: true, enum_managed: true, target_card_type_name: 'status', bound_to: [] },
      ] } };
    }
    if (k === 'card_type.select') {
      return { id: sr.id, ok: true, data: { rows: [
        { id: '8', name: 'status', allow_self_parent: false, is_built_in: true, uses_phase: true },
        { id: '9', name: 'milestone', allow_self_parent: false, is_built_in: true, uses_phase: false },
      ] } };
    }
    if (k === 'card.select_with_attributes') {
      return { id: sr.id, ok: true, data: { rows: data.card_type_name === 'status' ? statuses : [] } };
    }
    if (k === 'card.insert') { sent.inserts.push(data); return { id: sr.id, ok: true, data: { id: '602' } }; }
    if (k === 'card.set_phase') { sent.setPhases.push(data); return { id: sr.id, ok: true, data: { ok: true, activity_id: '1' } }; }
    if (k === 'attribute.update') return { id: sr.id, ok: true, data: { ok: true } };
    return { id: sr.id, ok: false, error: { code: 'unknown', message: k } };
  }
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      return { status: 200, text: JSON.stringify({ subresponses: req.subrequests.map(respond) }) };
    },
  };
  transport.sent = sent;
  return transport;
}

test('Status values: phase selector per value, card.set_phase on change, phase passed on add', async () => {
  const transport = statusTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mount(api);
  await settle(dispatcher);

  // Status renders as a managed group (it's enum_managed in this mock).
  assert.ok(ctrl.el.querySelector('[data-enum-group="status"]'), 'status renders as a managed enum');

  // Every status value row carries a phase select seeded to the card's phase.
  const rows = ctrl.el.querySelectorAll('[data-enum-value]');
  const rowPhases = rows.map((r) => r.querySelector('[data-enum-phase]')).filter(Boolean);
  assert.equal(rowPhases.length, 2, 'a phase select on each status value row');
  const doing = rows.find((r) => r.dataset.enumValue === '601');
  assert.equal(doing.querySelector('[data-enum-phase]').value, 'active', 'phase select reflects the value-card phase');

  // Change New idea (600) triage → terminal → fires card.set_phase.
  const newIdea = rows.find((r) => r.dataset.enumValue === '600');
  const sel = newIdea.querySelector('[data-enum-phase]');
  assert.equal(sel.value, 'triage');
  sel.value = 'terminal';
  sel.dispatchEvent({ type: 'change', target: sel });
  await settle(dispatcher);
  assert.equal(transport.sent.setPhases.length, 1, 'card.set_phase fired');
  assert.equal(String(transport.sent.setPhases[0].card_id), '600');
  assert.equal(transport.sent.setPhases[0].phase, 'terminal', 'chosen phase sent');

  // The add row carries a phase select (defaults active); adding threads it to card.insert.
  const addPhase = ctrl.el.querySelector('[data-enum-add-phase="status"]');
  assert.ok(addPhase, 'the add row has a phase select');
  assert.equal(addPhase.value, 'active', 'add phase defaults to active');
  addPhase.value = 'terminal';
  const addInput = ctrl.el.querySelector('[data-enum-add-input="status"]');
  addInput.value = 'Shipped';
  addInput.dispatchEvent({ type: 'input', target: addInput });
  ctrl.el.querySelector('[data-enum-add="status"]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  assert.equal(transport.sent.inserts.length, 1, 'card.insert fired');
  assert.equal(transport.sent.inserts[0].title, 'Shipped');
  assert.equal(transport.sent.inserts[0].phase, 'terminal', 'chosen phase passed to card.insert');
  assert.equal(String(transport.sent.inserts[0].parent_card_id), '31', 'parented to the active project');
});
