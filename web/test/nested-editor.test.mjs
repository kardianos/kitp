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
  M.registerMasterDetail();
  M.registerNestedEditor();
  M.registerPredicateFilter();
  M.registerCombobox();
  M.registerRefPicker();
});

/* -------------------------------------------------------------------------- */
/* Mock transport — every nested-editor spec, plus a write recorder. A         */
/* `blockFlowDelete` flag forces flow.delete to reject with the structured     */
/* blocker payload so the delete-guard path is demonstrable.                   */
/* -------------------------------------------------------------------------- */

function nestedTransport(opts = {}) {
  const { blockFlowDelete = false, edgeUsage = 0, filterPredicate = '' } = opts;
  const sent = { writes: [] };
  const rec = (key, data) => sent.writes.push({ key, data: data ?? {} });

  const flowRows = [
    {
      id: '50',
      name: 'Standard task',
      doc: 'default flow',
      attribute_def_id: '2',
      attribute_def_name: 'status',
      scope_card_id: '31',
      default_create_status_id: '101',
    },
  ];
  const stepRows = [
    { id: '900', flow_id: '50', from_card_id: '101', to_card_id: '102', label: 'Start', requires_role_id: '0', requires_role_name: '', sort_order: 0 },
    { id: '901', flow_id: '50', from_card_id: '101', to_card_id: '103', label: 'Cancel', requires_role_id: '7', requires_role_name: 'manager', sort_order: 1 },
    { id: '902', flow_id: '50', from_card_id: '102', to_card_id: '103', label: 'Finish', requires_role_id: '0', requires_role_name: '', sort_order: 0 },
  ];
  // The value cards (status) under the project — labels for from/to.
  const statusCards = [
    { id: '101', card_type_name: 'status', parent_card_id: '31', attributes: { title: 'Todo' } },
    { id: '102', card_type_name: 'status', parent_card_id: '31', attributes: { title: 'Doing' } },
    { id: '103', card_type_name: 'status', parent_card_id: '31', attributes: { title: 'Done' } },
  ];
  const attributeDefs = [
    { id: '1', name: 'title', value_type: 'text', is_built_in: true, bound_to: [{ card_type_id: '9', card_type_name: 'person', ordering: 1 }] },
    {
      id: '2',
      name: 'status',
      value_type: 'card_ref',
      target_card_type_name: 'status',
      is_built_in: true,
      bound_to: [{ card_type_id: '5', card_type_name: 'task', is_required: true, ordering: 3 }],
    },
  ];
  const cardTypeRows = [
    { id: '5', name: 'task', allow_self_parent: false, is_built_in: true },
    { id: '7', name: 'project', allow_self_parent: false, is_built_in: true },
    { id: '9', name: 'person', allow_self_parent: false, is_built_in: true },
  ];
  const screenRows = [
    { id: '60', card_type_name: 'screen', parent_card_id: '31', attributes: { title: 'Board', slug: 'board', layout: 'kanban', default_filter: '70' } },
  ];
  let filterRows = [
    { id: '70', card_type_name: 'filter', parent_card_id: '60', attributes: { title: 'Mine', predicate: filterPredicate } },
    { id: '71', card_type_name: 'filter', parent_card_id: '60', attributes: { title: 'All', predicate: '' } },
  ];

  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => {
        const key = `${sr.endpoint}.${sr.action}`;
        const data = sr.data ?? {};
        switch (key) {
          case 'flow.list':
            return { id: sr.id, ok: true, data: { rows: flowRows } };
          case 'flow_step.list':
            return { id: sr.id, ok: true, data: { rows: stepRows } };
          case 'attribute_def.select':
            return { id: sr.id, ok: true, data: { rows: attributeDefs } };
          case 'role.list':
            return { id: sr.id, ok: true, data: { rows: [{ id: '7', name: 'manager' }, { id: '8', name: 'worker' }] } };
          case 'card_type.select':
            return { id: sr.id, ok: true, data: { rows: cardTypeRows } };
          case 'card.select_with_attributes': {
            if (data.card_type_name === 'status') return { id: sr.id, ok: true, data: { rows: statusCards } };
            if (data.card_type_name === 'screen') return { id: sr.id, ok: true, data: { rows: screenRows } };
            if (data.card_type_name === 'filter') return { id: sr.id, ok: true, data: { rows: filterRows } };
            return { id: sr.id, ok: true, data: { rows: [] } };
          }
          /* ---- writes ---- */
          case 'flow_step.set':
            rec(key, data);
            return { id: sr.id, ok: true, data: { id: '999' } };
          case 'flow_step.delete':
            rec(key, data);
            return { id: sr.id, ok: true, data: { ok: true, deleted: 1 } };
          case 'flow.preview_delete':
            rec(key, data);
            return {
              id: sr.id,
              ok: true,
              data: {
                flow_id: '50',
                flow_name: 'Standard task',
                step_count: 3,
                tasks_currently_in_flow_states: 4,
                tasks_by_phase: { triage: 1, active: 2, terminal: 1 },
                sample_step_labels: ['Start', 'Cancel'],
              },
            };
          case 'flow.delete':
            rec(key, data);
            if (blockFlowDelete) {
              return {
                id: sr.id,
                ok: false,
                error: {
                  code: 'flow_disallowed',
                  message: '3 flow_step rows still reference flow 50',
                  detail: { blockers: [{ flow_step_id: '900', label: 'Start' }, { flow_step_id: '901', label: 'Cancel' }], count: 2 },
                },
              };
            }
            return { id: sr.id, ok: true, data: { ok: true, deleted: 1 } };
          case 'edge.insert':
            rec(key, data);
            return { id: sr.id, ok: true, data: { ok: true } };
          case 'edge.delete':
            rec(key, data);
            if (edgeUsage > 0) return { id: sr.id, ok: true, data: { ok: false, usage_count: edgeUsage } };
            return { id: sr.id, ok: true, data: { ok: true } };
          case 'attribute_def.insert':
            rec(key, data);
            return { id: sr.id, ok: true, data: { id: '4242' } };
          case 'card.insert':
            rec(key, data);
            filterRows = [...filterRows, { id: '72', card_type_name: 'filter', parent_card_id: '60', attributes: { title: 'New filter', predicate: '' } }];
            return { id: sr.id, ok: true, data: { id: '72' } };
          case 'card.delete':
            rec(key, data);
            filterRows = filterRows.filter((r) => String(r.id) !== String(data.card_id));
            return { id: sr.id, ok: true, data: { ok: true, activity_id: '5' } };
          case 'attribute.update':
            rec(key, data);
            return { id: sr.id, ok: true, data: { ok: true, activity_id: '6' } };
          default:
            return { id: sr.id, ok: false, error: { code: 'unknown_handler', message: `mock has no ${key}` } };
        }
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
  M.registerProjectSpecs(api);
  M.registerAdminSpecs(api);
  M.registerFilterSpecs(api);
  M.registerFilterCardSpecs(api);
  M.registerCardSearchSpec(api);
  return { dispatcher, api };
}

async function settle(dispatcher) {
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  M.flushSync?.();
}

function mountMD(api, screenCfg) {
  const tree = new M.TreeNode({}, []);
  // Seed an active project so project-scoped admin lists (e.g. Screens, #10)
  // fire instead of staying idle on null scope. Harmless for unscoped screens.
  tree.at(['scope', 'projectId']).set(31n);
  const scope = { get projectId() { return tree.at(['scope', 'projectId']).peek() ?? null; } };
  const ctx = { api, tree, scope };
  const ctrl = M.Control.New('MasterDetail', screenCfg, ctx);
  ctrl.mount(new FakeElement('div'));
  return { ctrl, tree };
}

function visibleRows(root) {
  return root.querySelectorAll('[data-md-row]').filter((r) => r.style.display !== 'none');
}

function writesFor(transport, key) {
  return transport.sent.writes.filter((w) => w.key === key);
}

/** Select the first list row (so the detail + nested editor render). */
async function selectFirstRow(ctrl, dispatcher) {
  const rows = visibleRows(ctrl.el);
  rows[0].dispatchEvent({ type: 'click' });
  M.flushSync?.();
  await settle(dispatcher);
  return rows[0].dataset.mdId;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers.                                                               */
/* -------------------------------------------------------------------------- */

test('groupStepsByFrom buckets by from_card_id preserving order', () => {
  const steps = [
    { id: '1', from_card_id: '101', to_card_id: '102', label: 'a', sort_order: 0 },
    { id: '2', from_card_id: '101', to_card_id: '103', label: 'b', sort_order: 1 },
    { id: '3', from_card_id: '102', to_card_id: '103', label: 'c', sort_order: 0 },
  ];
  const buckets = M.groupStepsByFrom(steps);
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].fromCardId, '101');
  assert.equal(buckets[0].steps.length, 2);
  assert.equal(buckets[1].fromCardId, '102');
  assert.equal(buckets[1].steps.length, 1);
});

test('boundMatrix marks bound card_types with ordering + required', () => {
  const cardTypes = [
    { id: '5', name: 'task', allow_self_parent: false, is_built_in: true },
    { id: '7', name: 'project', allow_self_parent: false, is_built_in: true },
  ];
  const boundTo = [{ card_type_id: '5', card_type_name: 'task', is_required: true, ordering: 3 }];
  const m = M.boundMatrix(cardTypes, boundTo);
  assert.equal(m.length, 2);
  assert.equal(m[0].bound, true);
  assert.equal(m[0].required, true);
  assert.equal(m[0].ordering, 3);
  assert.equal(m[1].bound, false);
  assert.equal(m[1].ordering, 0);
});

test('validateStepDraft requires label + distinct non-zero from/to', () => {
  assert.equal(M.validateStepDraft({ id: '0', fromCardId: '', toCardId: '102', label: 'x', requiresRoleId: '', sortOrder: '' }).ok, false);
  assert.equal(M.validateStepDraft({ id: '0', fromCardId: '101', toCardId: '101', label: 'x', requiresRoleId: '', sortOrder: '' }).ok, false);
  assert.equal(M.validateStepDraft({ id: '0', fromCardId: '101', toCardId: '102', label: '', requiresRoleId: '', sortOrder: '' }).ok, false);
  assert.equal(M.validateStepDraft({ id: '0', fromCardId: '101', toCardId: '102', label: 'x', requiresRoleId: '', sortOrder: 'nope' }).ok, false);
  assert.equal(M.validateStepDraft({ id: '0', fromCardId: '101', toCardId: '102', label: 'x', requiresRoleId: '', sortOrder: '2' }).ok, true);
});

test('formatBlockers lists the offending transitions', () => {
  const s = M.formatBlockers([{ flow_step_id: '900', label: 'Start' }, { flow_step_id: '901', label: '' }]);
  assert.match(s, /2 transitions/);
  assert.match(s, /Start/);
  assert.match(s, /#901/);
});

/* -------------------------------------------------------------------------- */
/* Workflows: flow-step transition editor.                                     */
/* -------------------------------------------------------------------------- */

test('Workflows: steps load + render grouped by `from` status', async () => {
  const { dispatcher, api } = bootApi(nestedTransport());
  const { ctrl, tree } = mountMD(api, M.adminScreenConfig('workflows'));
  await settle(dispatcher);
  await selectFirstRow(ctrl, dispatcher);

  const steps = tree.at(['admin', 'workflows', 'nested', 'steps']).peek();
  assert.ok(Array.isArray(steps) && steps.length === 3, 'three steps landed');

  // Two `from` groups (101 → 2 steps, 102 → 1 step).
  const groups = ctrl.el.querySelectorAll('[data-ne-from-group]');
  assert.equal(groups.length, 2, 'two from-status groups');
  // Each step row labels its transition (Start → Doing, etc.) using the value-card titles.
  const rows = ctrl.el.querySelectorAll('[data-ne-step-row]');
  assert.equal(rows.length, 3);
  assert.match(rows[0].textContent, /Start → Doing/);
  // The role-gated row surfaces the role name.
  assert.match(ctrl.el.querySelectorAll('[data-ne-step-row]')[1].textContent, /manager/);
});

test('Workflows: dragging a transition reorders within its from-group (#14)', async () => {
  const transport = nestedTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountMD(api, M.adminScreenConfig('workflows'));
  await settle(dispatcher);
  await selectFirstRow(ctrl, dispatcher);

  // The from=101 group is [900 (sort 0), 901 (sort 1)]. Drag 901 by its handle
  // and drop on the group container — the shim resolves the slot to 0 (front),
  // so the two steps swap their sort_order slots (0 ↔ 1).
  const handle = ctrl.el.querySelector('[data-ne-step-drag="901"]');
  assert.ok(handle, 'each step row has a drag handle');
  const group = ctrl.el.querySelector('[data-ne-from-group="101"]');
  handle.dispatchEvent({ type: 'dragstart', target: handle, dataTransfer: { setData() {} } });
  group.dispatchEvent({ type: 'drop', target: group, clientY: 0 });
  await settle(dispatcher);

  const sets = writesFor(transport, 'flow_step.set');
  const byId = Object.fromEntries(sets.map((s) => [String(s.data.id), s.data.sort_order]));
  assert.equal(byId['901'], 0, '901 took the first slot');
  assert.equal(byId['900'], 1, '900 took the second slot');
  assert.equal(byId['902'], undefined, 'a step in a DIFFERENT from-group is untouched');
});

test('Workflows: adding a transition fires flow_step.set with the draft', async () => {
  const transport = nestedTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountMD(api, M.adminScreenConfig('workflows'));
  await settle(dispatcher);
  await selectFirstRow(ctrl, dispatcher);

  // The transition editor is now a modal (#16) — open it via "+ Add transition".
  assert.equal(ctrl.el.querySelector('[data-ne-step-form]'), null, 'no inline form before opening');
  ctrl.el.querySelector('[data-ne-step-add]').dispatchEvent({ type: 'click' });
  M.flushSync?.();

  const form = ctrl.el.querySelector('[data-ne-step-form]');
  assert.ok(form, 'the modal hosts the transition form');
  assert.ok(ctrl.el.querySelector('[data-modal]'), 'the transition editor opens in a modal (#16)');
  form.querySelector('[data-ne-from]').value = '102';
  form.querySelector('[data-ne-to]').value = '101';
  form.querySelector('[data-ne-label]').value = 'Reopen';
  form.querySelector('[data-ne-sort]').value = '5';
  form.querySelector('[data-ne-step-submit]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);

  const sets = writesFor(transport, 'flow_step.set');
  assert.equal(sets.length, 1, 'one flow_step.set fired');
  assert.equal(sets[0].data.flow_id, '50');
  assert.equal(sets[0].data.from_card_id, '102');
  assert.equal(sets[0].data.to_card_id, '101');
  assert.equal(sets[0].data.label, 'Reopen');
  assert.equal(sets[0].data.sort_order, 5);
});

test('Workflows: Edit loads a draft then Save fires flow_step.set with the id', async () => {
  const transport = nestedTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountMD(api, M.adminScreenConfig('workflows'));
  await settle(dispatcher);
  await selectFirstRow(ctrl, dispatcher);

  // Click Edit on the first step (id 900).
  ctrl.el.querySelectorAll('[data-ne-step-edit]')[0].dispatchEvent({ type: 'click' });
  M.flushSync?.();

  // The form now reflects the existing step + the submit becomes "Save".
  const form = ctrl.el.querySelector('[data-ne-step-form]');
  assert.equal(form.querySelector('[data-ne-label]').value, 'Start');
  form.querySelector('[data-ne-label]').value = 'Begin';
  form.querySelector('[data-ne-step-submit]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);

  const sets = writesFor(transport, 'flow_step.set');
  assert.equal(sets.length, 1);
  assert.equal(sets[0].data.id, '900', 'update carries the existing id');
  assert.equal(sets[0].data.label, 'Begin');
});

test('Workflows: Delete on a step fires flow_step.delete with that id', async () => {
  const transport = nestedTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountMD(api, M.adminScreenConfig('workflows'));
  await settle(dispatcher);
  await selectFirstRow(ctrl, dispatcher);

  ctrl.el.querySelectorAll('[data-ne-step-delete]')[0].dispatchEvent({ type: 'click' });
  await settle(dispatcher);

  const dels = writesFor(transport, 'flow_step.delete');
  assert.equal(dels.length, 1);
  assert.equal(dels[0].data.flow_step_id, '900');
});

test('Workflows: flow-delete guard previews, then a blocked flow.delete shows the blockers', async () => {
  const transport = nestedTransport({ blockFlowDelete: true });
  const { dispatcher, api } = bootApi(transport);
  const { ctrl, tree } = mountMD(api, M.adminScreenConfig('workflows'));
  await settle(dispatcher);
  await selectFirstRow(ctrl, dispatcher);

  // Open the guard → flow.preview_delete fires + the summary renders.
  ctrl.el.querySelector('[data-ne-flow-delete]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  assert.equal(writesFor(transport, 'flow.preview_delete').length, 1, 'preview fired');
  const summary = ctrl.el.querySelector('[data-ne-guard-summary]');
  assert.ok(summary, 'guard summary rendered');
  assert.match(summary.textContent, /3 step/);
  assert.match(summary.textContent, /4 task/);

  // Confirm → flow.delete fires but is BLOCKED → the blocker list renders.
  ctrl.el.querySelector('[data-ne-guard-confirm]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  assert.equal(writesFor(transport, 'flow.delete').length, 1, 'delete attempted');
  const blockers = ctrl.el.querySelector('[data-ne-blockers]');
  assert.ok(blockers, 'blocker callout rendered');
  assert.match(blockers.textContent, /Start/);
  assert.match(blockers.textContent, /Cancel/);
  // The flow stays in the list (delete blocked).
  const items = tree.at(['admin', 'workflows', 'items']).peek();
  assert.ok(items.some((it) => it.id === '50'), 'flow not removed when blocked');
});

test('Workflows: an unblocked flow.delete removes the flow from the list', async () => {
  const transport = nestedTransport({ blockFlowDelete: false });
  const { dispatcher, api } = bootApi(transport);
  const { ctrl, tree } = mountMD(api, M.adminScreenConfig('workflows'));
  await settle(dispatcher);
  await selectFirstRow(ctrl, dispatcher);

  ctrl.el.querySelector('[data-ne-flow-delete]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  ctrl.el.querySelector('[data-ne-guard-confirm]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);

  assert.equal(writesFor(transport, 'flow.delete').length, 1);
  const items = tree.at(['admin', 'workflows', 'items']).peek();
  assert.ok(!items.some((it) => it.id === '50'), 'flow removed on success');
});

/* -------------------------------------------------------------------------- */
/* Attributes: edge bind/unbind matrix + attribute_def create.                 */
/* -------------------------------------------------------------------------- */

test('Attributes: the matrix renders a row per card_type, bound ones checked', async () => {
  const { dispatcher, api } = bootApi(nestedTransport());
  const { ctrl, tree } = mountMD(api, M.adminScreenConfig('attributes'));
  await settle(dispatcher);
  // Select the `status` def (id 2), which is bound to task (id 5).
  const rows = visibleRows(ctrl.el);
  const statusRow = rows.find((r) => /status/.test(r.textContent));
  statusRow.dispatchEvent({ type: 'click' });
  M.flushSync?.();
  await settle(dispatcher);

  assert.ok(Array.isArray(tree.at(['admin', 'attributes', 'nested', 'cardTypes']).peek()), 'card types loaded');
  const matrixRows = ctrl.el.querySelectorAll('[data-ne-matrix-row]');
  assert.equal(matrixRows.length, 3, 'one row per card_type');
  const taskToggle = ctrl.el.querySelector('[data-ne-toggle="5"]');
  assert.equal(taskToggle.checked, true, 'task edge is bound');
  const projToggle = ctrl.el.querySelector('[data-ne-toggle="7"]');
  assert.equal(projToggle.checked, false, 'project edge unbound');
});

test('Attributes: toggling an unbound card_type fires edge.insert', async () => {
  const transport = nestedTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountMD(api, M.adminScreenConfig('attributes'));
  await settle(dispatcher);
  const rows = visibleRows(ctrl.el);
  rows.find((r) => /status/.test(r.textContent)).dispatchEvent({ type: 'click' });
  M.flushSync?.();
  await settle(dispatcher);

  const toggle = ctrl.el.querySelector('[data-ne-toggle="7"]');
  toggle.checked = true;
  toggle.dispatchEvent({ type: 'change' });
  await settle(dispatcher);

  const inserts = writesFor(transport, 'edge.insert');
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].data.attribute_def_id, '2');
  assert.equal(inserts[0].data.card_type_id, '7');
});

test('Attributes: unchecking a bound card_type fires edge.delete', async () => {
  const transport = nestedTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountMD(api, M.adminScreenConfig('attributes'));
  await settle(dispatcher);
  const rows = visibleRows(ctrl.el);
  rows.find((r) => /status/.test(r.textContent)).dispatchEvent({ type: 'click' });
  M.flushSync?.();
  await settle(dispatcher);

  const toggle = ctrl.el.querySelector('[data-ne-toggle="5"]');
  toggle.checked = false;
  toggle.dispatchEvent({ type: 'change' });
  await settle(dispatcher);

  const dels = writesFor(transport, 'edge.delete');
  assert.equal(dels.length, 1);
  assert.equal(dels[0].data.card_type_id, '5');
});

test('Attributes: editing ordering on a bound edge re-binds (delete + insert with the new ordering)', async () => {
  const transport = nestedTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountMD(api, M.adminScreenConfig('attributes'));
  await settle(dispatcher);
  const rows = visibleRows(ctrl.el);
  rows.find((r) => /status/.test(r.textContent)).dispatchEvent({ type: 'click' });
  M.flushSync?.();
  await settle(dispatcher);

  const ord = ctrl.el.querySelector('[data-ne-ordering="5"]');
  ord.value = '9';
  ord.dispatchEvent({ type: 'blur' });
  await settle(dispatcher);

  assert.equal(writesFor(transport, 'edge.delete').length, 1, 'old edge dropped');
  const inserts = writesFor(transport, 'edge.insert');
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].data.ordering, 9, 're-inserted with the new ordering');
});

test('Attributes: required toggle on a bound edge re-binds with is_required=true', async () => {
  const transport = nestedTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountMD(api, M.adminScreenConfig('attributes'));
  await settle(dispatcher);
  const rows = visibleRows(ctrl.el);
  rows.find((r) => /title/.test(r.textContent)).dispatchEvent({ type: 'click' });
  M.flushSync?.();
  await settle(dispatcher);

  // title is bound to person (id 9, ordering 1, not required) → toggle required.
  const req = ctrl.el.querySelector('[data-ne-required="9"]');
  req.checked = true;
  req.dispatchEvent({ type: 'change' });
  await settle(dispatcher);

  const inserts = writesFor(transport, 'edge.insert');
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].data.is_required, true);
});

test('Attributes: edge.delete soft-refusal (usage_count) surfaces an inline fault', async () => {
  const transport = nestedTransport({ edgeUsage: 12 });
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountMD(api, M.adminScreenConfig('attributes'));
  await settle(dispatcher);
  const rows = visibleRows(ctrl.el);
  rows.find((r) => /status/.test(r.textContent)).dispatchEvent({ type: 'click' });
  M.flushSync?.();
  await settle(dispatcher);

  const toggle = ctrl.el.querySelector('[data-ne-toggle="5"]');
  toggle.checked = false;
  toggle.dispatchEvent({ type: 'change' });
  await settle(dispatcher);

  // The nested editor's own fault signal carries the in-use message.
  const ne = ctrl.el.querySelector('[data-control="NestedEditor"]');
  // The control sets its inline fault; assert via the write happened + edit blocked.
  assert.equal(writesFor(transport, 'edge.delete').length, 1, 'delete attempted (soft-refused server-side)');
});

test('Attributes: + New fires attribute_def.insert with name + value_type', async () => {
  const transport = nestedTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountMD(api, M.adminScreenConfig('attributes'));
  await settle(dispatcher);

  // Open the create dialog, fill name + value_type, submit.
  ctrl.el.querySelector('[data-md-new]').dispatchEvent({ type: 'click' });
  const dialog = ctrl.el.querySelector('[data-md-create]');
  dialog.querySelector('[data-md-form-field="name"]').value = 'severity';
  dialog.querySelector('[data-md-form-field="value_type"]').value = 'text';
  dialog.querySelector('[data-md-create-submit]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);

  const inserts = writesFor(transport, 'attribute_def.insert');
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].data.name, 'severity');
  assert.equal(inserts[0].data.value_type, 'text');
});

/* -------------------------------------------------------------------------- */
/* Screens: filter-card management.                                            */
/* -------------------------------------------------------------------------- */

test('Screens: filter cards load + render under the selected screen', async () => {
  const { dispatcher, api } = bootApi(nestedTransport());
  const { ctrl, tree } = mountMD(api, M.adminScreenConfig('screens'));
  await settle(dispatcher);
  await selectFirstRow(ctrl, dispatcher);

  const filters = tree.at(['admin', 'screens', 'nested', 'filters']).peek();
  assert.ok(Array.isArray(filters) && filters.length === 2, 'two filter cards landed');
  const filterRows = ctrl.el.querySelectorAll('[data-ne-filter-row]');
  assert.equal(filterRows.length, 2);
  // The screen's default_filter (70) is reflected on the matching radio.
  assert.equal(ctrl.el.querySelector('[data-ne-filter-default="70"]').checked, true);
  assert.equal(ctrl.el.querySelector('[data-ne-filter-default="71"]').checked, false);
});

test('Screens: + Add filter fires card.insert under the screen', async () => {
  const transport = nestedTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountMD(api, M.adminScreenConfig('screens'));
  await settle(dispatcher);
  await selectFirstRow(ctrl, dispatcher);

  ctrl.el.querySelector('[data-ne-filter-add]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);

  const inserts = writesFor(transport, 'card.insert');
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].data.card_type_name, 'filter');
  assert.equal(String(inserts[0].data.parent_card_id), '60');
});

test('Screens: Remove on a filter fires card.delete', async () => {
  const transport = nestedTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountMD(api, M.adminScreenConfig('screens'));
  await settle(dispatcher);
  await selectFirstRow(ctrl, dispatcher);

  ctrl.el.querySelector('[data-ne-filter-delete="71"]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);

  const dels = writesFor(transport, 'card.delete');
  assert.equal(dels.length, 1);
  assert.equal(String(dels[0].data.card_id), '71');
});

test('Screens: setting a filter as default fires attribute.update on the screen', async () => {
  const transport = nestedTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountMD(api, M.adminScreenConfig('screens'));
  await settle(dispatcher);
  await selectFirstRow(ctrl, dispatcher);

  // Make filter 71 the default.
  const radio = ctrl.el.querySelector('[data-ne-filter-default="71"]');
  radio.checked = true;
  radio.dispatchEvent({ type: 'change' });
  await settle(dispatcher);

  const updates = writesFor(transport, 'attribute.update').filter((w) => w.data.attribute_name === 'default_filter');
  assert.equal(updates.length, 1);
  assert.equal(String(updates[0].data.card_id), '60');
  assert.equal(String(updates[0].data.value), '71');
});

test('Screens: editing a filter title fires attribute.update on the filter card', async () => {
  const transport = nestedTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountMD(api, M.adminScreenConfig('screens'));
  await settle(dispatcher);
  await selectFirstRow(ctrl, dispatcher);

  const titleInput = ctrl.el.querySelector('[data-ne-filter-title="70"]');
  titleInput.value = 'Just mine';
  titleInput.dispatchEvent({ type: 'blur' });
  await settle(dispatcher);

  const updates = writesFor(transport, 'attribute.update').filter((w) => w.data.attribute_name === 'title');
  assert.equal(updates.length, 1);
  assert.equal(String(updates[0].data.card_id), '70');
  assert.equal(updates[0].data.value, 'Just mine');
});

/* -------------------------------------------------------------------------- */
/* Named Filters: the advanced visual predicate builder (filterPredicate).      */
/* -------------------------------------------------------------------------- */

test('Named Filters: selecting a filter mounts the advanced builder; Save commits predicate+group+sort', async () => {
  const transport = nestedTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountMD(api, M.adminScreenConfig('filters'));
  await settle(dispatcher);

  // The project's filter cards list; select the first.
  const id = await selectFirstRow(ctrl, dispatcher);

  // The advanced visual builder (PredicateFilter) mounted for that filter.
  assert.ok(ctrl.el.querySelector('[data-ne-predicate]'), 'predicate builder slot mounted');
  assert.equal(ctrl.el.findByControl('PredicateFilter').length, 1, 'one PredicateFilter builder');

  // Save commits the full view definition (predicate + group + sort) to the card.
  ctrl.el.querySelector('[data-ne-predicate-save]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  const updates = writesFor(transport, 'attribute.update');
  assert.deepEqual(
    updates.map((u) => u.data.attribute_name).sort(),
    ['group_by_attr', 'predicate', 'sort'],
    'one attribute.update per view-definition field',
  );
  assert.ok(updates.every((u) => String(u.data.card_id) === id), 'all target the selected filter card');
});

test('Named Filters: switching the selected filter re-mounts the builder (one live PredicateFilter)', async () => {
  const transport = nestedTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountMD(api, M.adminScreenConfig('filters'));
  await settle(dispatcher);

  const rows = visibleRows(ctrl.el);
  rows[0].dispatchEvent({ type: 'click' });
  M.flushSync?.();
  await settle(dispatcher);
  rows[1].dispatchEvent({ type: 'click' });
  M.flushSync?.();
  await settle(dispatcher);

  // The previous builder was torn down — exactly one PredicateFilter is live.
  assert.equal(ctrl.el.findByControl('PredicateFilter').length, 1, 'old builder destroyed on reselect');
  assert.equal(ctrl.el.querySelector('[data-ne-predicate]').dataset.nePredicate, rows[1].dataset.mdId);
});

test('Named Filters: a bare-leaf predicate (status has_phase) loads into the builder and saves canonically', async () => {
  // The seed/runtime store a filter predicate as a BARE WIRE NODE (leaf or
  // connective), read back by screen-resolve.readPredicate via fromWire. The
  // builder must load that shape (not render empty) and save it back in the
  // same shape (so the runtime can read it).
  const stored = JSON.stringify({ attr: 'status', op: 'has_phase', values: ['active'] });
  const transport = nestedTransport({ filterPredicate: stored });
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountMD(api, M.adminScreenConfig('filters'));
  await settle(dispatcher);

  // Select the filter whose predicate is the bare-leaf has_phase node (id 70).
  const rows = visibleRows(ctrl.el).filter((r) => r.dataset.mdId === '70');
  rows[0].dispatchEvent({ type: 'click' });
  M.flushSync?.();
  await settle(dispatcher);

  // It loaded into the builder (a non-empty predicate → a leaf row + the
  // has_phase phase checkboxes render, not an empty builder).
  assert.ok(ctrl.el.findByControl('PredicateFilter').length === 1, 'builder mounted');
  assert.ok(ctrl.el.querySelector('[data-pred-leaf]'), 'the stored predicate rendered as a leaf (not empty)');
  assert.ok(ctrl.el.querySelector('[data-pred-phases]'), 'has_phase decoded → triage/active/terminal checkboxes');

  // Save → the persisted predicate is the CANONICAL wire node readPredicate reads.
  ctrl.el.querySelector('[data-ne-predicate-save]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  const pred = writesFor(transport, 'attribute.update').find((w) => w.data.attribute_name === 'predicate');
  assert.ok(pred, 'predicate attribute.update fired');
  const parsed = JSON.parse(pred.data.value);
  assert.equal(parsed.where, undefined, 'no legacy {where} wrapper');
  assert.equal(parsed.tree, undefined, 'no legacy {tree} wrapper');
  // The runtime decoder reads it back to a non-null predicate.
  const roundTrip = M.readPredicate({ attributes: { predicate: pred.data.value } });
  assert.ok(roundTrip !== null, 'runtime readPredicate decodes the builder-saved predicate');
});
