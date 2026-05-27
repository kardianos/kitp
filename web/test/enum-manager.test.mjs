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
  // ("unsupported order field"), which empties the screen.
  assert.ok(transport.sent.milestoneOrders.length > 0, 'value-cards select carries an order');
  assert.deepEqual(transport.sent.milestoneOrders[0], [{ field: 'attributes.sort_order', direction: 'ASC' }]);
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

test('EnumManager reorder: ▼ moves a value down and persists a sort_order ladder', async () => {
  const transport = recordingTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mount(api);
  await settle(dispatcher);

  // Initial order Q1(500), Q2(501): the first row can't move up, the last down.
  let order = ctrl.el.querySelectorAll('[data-enum-value]').map((v) => v.dataset.enumValue);
  assert.deepEqual(order, ['500', '501'], 'values render in sort_order');
  assert.equal(ctrl.el.querySelector('[data-enum-move-up="500"]').disabled, true, 'first row: up disabled');
  assert.equal(ctrl.el.querySelector('[data-enum-move-down="501"]').disabled, true, 'last row: down disabled');

  // Move Q1 down.
  ctrl.el.querySelector('[data-enum-move-down="500"]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);

  // Optimistic repaint into the new order.
  order = ctrl.el.querySelectorAll('[data-enum-value]').map((v) => v.dataset.enumValue);
  assert.deepEqual(order, ['501', '500'], 'rows repainted in the new order');

  // sort_order persisted as a 10,20 ladder over the new order (one coalesced batch).
  const sorts = transport.sent.updates.filter((u) => u.attribute_name === 'sort_order');
  assert.equal(sorts.length, 2, 'sort_order written for each reindexed card');
  const byCard = Object.fromEntries(sorts.map((u) => [String(u.card_id), u.value]));
  assert.equal(byCard['501'], 10, 'the card now first gets the lowest sort_order');
  assert.equal(byCard['500'], 20);
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
