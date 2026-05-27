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
  // Register the controls once (Control.register throws on dup). The card-backed
  // admin screens now mount a PredicateFilter, so it must be registered too.
  M.registerMasterDetail();
  M.registerPredicateFilter();
});

/* -------------------------------------------------------------------------- */
/* Admin mock transport — person cards + user rows, shaped like the Go         */
/* handlers (ids as JSON strings; card rows nest attrs under `attributes`).    */
/* A target card/title forces a per-row error so the optimistic-rollback path  */
/* is demonstrable.                                                            */
/* -------------------------------------------------------------------------- */

const FAULT_CARD_ID = '888';

/** Build ≥30 person card rows so the list scrolls. */
function personRows(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      id: (1000 + i).toString(),
      card_type_id: '9',
      card_type_name: 'person',
      parent_card_id: '1',
      attributes: {
        title: `Person ${String(i).padStart(2, '0')}`,
        email: `person${i}@example.com`,
        person_kind: i % 3 === 0 ? 'contact' : 'member',
      },
    });
  }
  return rows;
}

/** Build ≥30 user rows with roles (the user.list_with_roles shape). */
function userRows(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      id: (2000 + i).toString(),
      display_name: `User ${String(i).padStart(2, '0')}`,
      email: `user${i}@example.com`,
      is_agent: i % 5 === 0,
      roles:
        i % 2 === 0
          ? [{ role_name: 'manager', scope_project_id: '31', scope_project_title: 'Default Project' }]
          : [{ role_name: 'worker' }, { role_name: 'admin' }],
    });
  }
  return rows;
}

function adminTransport({ persons = 32, users = 30, failWrites = false } = {}) {
  // Records the most recent person-list query input so a test can inspect the
  // where[]/tree the predicate filter feeds into the list query, plus every
  // write request so create/delete/role tests can assert the wire shape.
  const sent = { personInputs: [], writes: [] };
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => {
        const key = `${sr.endpoint}.${sr.action}`;
        if (key === 'card.select_with_attributes') {
          const data = sr.data ?? {};
          if (data.card_type_name === 'person') {
            sent.personInputs.push(data);
            return { id: sr.id, ok: true, data: { rows: personRows(persons) } };
          }
          return { id: sr.id, ok: true, data: { rows: [] } };
        }
        if (key === 'user.list_with_roles') {
          return { id: sr.id, ok: true, data: { rows: userRows(users) } };
        }
        // ---- Write specs (create / delete / role / unlink). ----
        if (key === 'card.insert') {
          sent.writes.push({ key, data: sr.data ?? {} });
          if (failWrites) return { id: sr.id, ok: false, error: { code: 'forbidden', message: 'mock create fault' } };
          return { id: sr.id, ok: true, data: { id: '7777' } };
        }
        if (key === 'card.delete') {
          sent.writes.push({ key, data: sr.data ?? {} });
          if (failWrites) return { id: sr.id, ok: false, error: { code: 'value_referenced_by_flow', message: 'mock delete fault' } };
          return { id: sr.id, ok: true, data: { ok: true, activity_id: '90100' } };
        }
        if (key === 'person.create') {
          sent.writes.push({ key, data: sr.data ?? {} });
          if (failWrites) return { id: sr.id, ok: false, error: { code: 'conflict', message: 'mock create fault' } };
          return { id: sr.id, ok: true, data: { person_card_id: '8888', user_account_id: sr.data?.tier === 'user' ? '5555' : '0' } };
        }
        if (key === 'user_role.set') {
          sent.writes.push({ key, data: sr.data ?? {} });
          return { id: sr.id, ok: true, data: { ok: true, user_role_id: '4242' } };
        }
        if (key === 'user_role.revoke') {
          sent.writes.push({ key, data: sr.data ?? {} });
          return { id: sr.id, ok: true, data: { ok: true, deleted: 1 } };
        }
        if (key === 'user.unlink_person') {
          sent.writes.push({ key, data: sr.data ?? {} });
          return { id: sr.id, ok: true, data: { deleted: true } };
        }
        if (key === 'attribute_def.select') {
          // The PredicateFilter's `{ cardType }` schema source. Two person
          // attrs bound to the person card_type (title text + person_kind text).
          return {
            id: sr.id,
            ok: true,
            data: {
              rows: [
                {
                  id: '1',
                  name: 'title',
                  value_type: 'text',
                  is_built_in: true,
                  bound_to: [{ card_type_id: '9', card_type_name: 'person', ordering: 1 }],
                },
                {
                  id: '2',
                  name: 'person_kind',
                  value_type: 'text',
                  is_built_in: true,
                  bound_to: [{ card_type_id: '9', card_type_name: 'person', ordering: 2 }],
                },
              ],
            },
          };
        }
        if (key === 'attribute.update') {
          const data = sr.data ?? {};
          if (String(data.card_id) === FAULT_CARD_ID) {
            return { id: sr.id, ok: false, error: { code: 'flow_disallowed', message: 'mock fault' } };
          }
          return { id: sr.id, ok: true, data: { ok: true, activity_id: '90001' } };
        }
        return { id: sr.id, ok: false, error: { code: 'unknown_handler', message: `mock has no ${key}` } };
      });
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
  // Attach the recorder so a test can read `transport.sent.personInputs` while
  // existing callers keep passing the transport object straight to bootApi.
  transport.sent = sent;
  return transport;
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api); // card.select_with_attributes + attribute.update
  M.registerProjectSpecs(api); // card.insert (create)
  M.registerAdminSpecs(api); // user.* reads + person.create + user_role.set/revoke + user.unlink_person
  M.registerFilterSpecs(api); // idempotent: attribute_def.select already defined above
  M.registerFilterCardSpecs(api); // card.delete (idempotent-by-presence)
  return { dispatcher, api };
}

async function settle(dispatcher) {
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  M.flushSync?.();
}

/** Mount a MasterDetail against a fresh tree from a built screen config. */
function mountMD(api, screenCfg) {
  const tree = new M.TreeNode({}, []);
  const ctx = { api, tree };
  const ctrl = M.Control.New('MasterDetail', screenCfg, ctx);
  ctrl.mount(new FakeElement('div'));
  return { ctrl, tree };
}

function visibleRows(root) {
  return root.querySelectorAll('[data-md-row]').filter((r) => r.style.display !== 'none');
}

/** Find a detail field row by its `data-md-field` value (the shim's `[attr]`
 *  selector matches presence only, so filter on the dataset value here). */
function fieldByName(root, name) {
  return root.querySelectorAll('[data-md-field]').find((el) => el.dataset.mdField === name) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers.                                                               */
/* -------------------------------------------------------------------------- */

test('normaliseRow stringifies the id; filterItems substring-matches a dotted field', () => {
  const a = M.normaliseRow({ id: 1001n, attributes: { title: 'Alice' } });
  assert.equal(a.id, '1001');
  assert.equal(M.fieldText(a.raw, 'attributes.title'), 'Alice');

  const items = [a, M.normaliseRow({ id: 1002, attributes: { title: 'Bob' } })];
  const hit = M.filterItems(items, 'attributes.title', 'ali');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].id, '1001');
});

test('masterDetailScreen builds a list query + (when updateSpec set) an update action', () => {
  const contacts = M.contactsScreen();
  assert.ok(contacts.queries.some((q) => q.spec === 'card.select_with_attributes'));
  assert.ok(contacts.actions.some((a) => a.intent === 'editField' && a.spec === 'attribute.update'));

  // Users has NO updateSpec → no editField action, but it DOES carry the
  // detail-relation actions (role assign/revoke + person unlink).
  const users = M.usersScreen();
  assert.ok(users.queries.some((q) => q.spec === 'user.list_with_roles'));
  assert.ok(!users.actions.some((a) => a.intent === 'editField'), 'no inline editField action');
  assert.ok(users.actions.some((a) => a.intent === 'assignRole' && a.spec === 'user_role.set'));
  assert.ok(users.actions.some((a) => a.intent === 'revokeRole' && a.spec === 'user_role.revoke'));
  assert.ok(users.actions.some((a) => a.intent === 'unlinkPerson' && a.spec === 'user.unlink_person'));
});

/* -------------------------------------------------------------------------- */
/* List loads + renders rows.                                                  */
/* -------------------------------------------------------------------------- */

test('Contacts: list loads (≥30) and renders rows from list.row accessors', async () => {
  const { dispatcher, api } = bootApi(adminTransport({ persons: 32 }));
  const { ctrl, tree } = mountMD(api, M.contactsScreen());
  await settle(dispatcher);

  const items = tree.at(['admin', 'contacts', 'items']).peek();
  assert.ok(Array.isArray(items) && items.length === 32, '32 person items landed');

  const rows = visibleRows(ctrl.el);
  assert.ok(rows.length > 0 && rows.length < 32, 'only a window of pooled rows is visible (recycling)');
  // The first visible row shows the title + email subtitle.
  assert.match(rows[0].textContent, /Person 01/);
  assert.match(rows[0].textContent, /person1@example.com/);
});

/* -------------------------------------------------------------------------- */
/* Search filters.                                                             */
/* -------------------------------------------------------------------------- */

test('Contacts: search filters the list client-side', async () => {
  const { dispatcher, api } = bootApi(adminTransport({ persons: 32 }));
  const { ctrl, tree } = mountMD(api, M.contactsScreen());
  await settle(dispatcher);

  const search = ctrl.el.querySelector('[data-md-search]');
  search.value = 'Person 07';
  search.dispatchEvent({ type: 'input' });
  M.flushSync?.();

  // The search leaf reflects the input; the visible window narrows to the match.
  assert.equal(tree.at(['admin', 'contacts', 'search']).peek(), 'Person 07');
  const rows = visibleRows(ctrl.el);
  assert.equal(rows.length, 1, 'one match for "Person 07"');
  assert.match(rows[0].textContent, /Person 07/);
});

/* -------------------------------------------------------------------------- */
/* Select sets <scopeKey>.selectedId + detail renders the item.                */
/* -------------------------------------------------------------------------- */

test('Contacts: clicking a row sets selectedId in the tree + the detail renders it', async () => {
  const { dispatcher, api } = bootApi(adminTransport({ persons: 32 }));
  const { ctrl, tree } = mountMD(api, M.contactsScreen());
  await settle(dispatcher);

  // Detail starts on the empty placeholder.
  assert.ok(ctrl.el.querySelector('[data-md-empty]'), 'empty placeholder before selection');

  const rows = visibleRows(ctrl.el);
  const firstId = rows[0].dataset.mdId;
  rows[0].dispatchEvent({ type: 'click' });
  M.flushSync?.();

  // Selection lives in the TREE (recycling-safe).
  assert.equal(tree.at(['admin', 'contacts', 'selectedId']).peek(), firstId);
  // The detail title + a field value render the selected item.
  const detailTitle = ctrl.el.querySelector('[data-md-detail-title]');
  assert.ok(detailTitle, 'detail title rendered');
  assert.match(detailTitle.textContent, /Person 01/);
  // The clicked row carries the selected class (derived from the tree, not node state).
  assert.ok(rows[0].classList.contains('masterdetail__row--selected'));
});

/* -------------------------------------------------------------------------- */
/* An editable field fires the update optimistically.                          */
/* -------------------------------------------------------------------------- */

test('Contacts: editing the Name field fires attribute.update optimistically', async () => {
  const { dispatcher, api } = bootApi(adminTransport({ persons: 32 }));
  const { ctrl, tree } = mountMD(api, M.contactsScreen());
  await settle(dispatcher);

  const rows = visibleRows(ctrl.el);
  const id = rows[0].dataset.mdId; // '1001'
  rows[0].dispatchEvent({ type: 'click' });
  M.flushSync?.();

  // The Name field is the first text input in the detail pane.
  const nameField = fieldByName(ctrl.el, 'attributes.title');
  const input = nameField.querySelector('[data-role="input"]');
  input.value = 'Renamed Person';
  input.dispatchEvent({ type: 'blur' });
  M.flushSync?.();

  // OPTIMISTIC: the items leaf reflects the new title BEFORE the server responds.
  const itemsAfterOptimistic = tree.at(['admin', 'contacts', 'items']).peek();
  const patched = itemsAfterOptimistic.find((it) => it.id === id);
  assert.equal(patched.raw.attributes.title, 'Renamed Person', 'optimistic patch applied');

  await settle(dispatcher); // server commits (success in the mock)
  const itemsAfterCommit = tree.at(['admin', 'contacts', 'items']).peek();
  assert.equal(
    itemsAfterCommit.find((it) => it.id === id).raw.attributes.title,
    'Renamed Person',
    'edit persisted after commit',
  );
});

test('Contacts: a forced fault rolls back the optimistic edit', async () => {
  const { dispatcher, api } = bootApi(adminTransport({ persons: 32 }));
  const { ctrl, tree } = mountMD(api, M.contactsScreen());
  await settle(dispatcher);

  // Seed a selectable item whose id is the fault id, then select + edit it.
  const items = tree.at(['admin', 'contacts', 'items']).peek().slice();
  items.unshift({ id: FAULT_CARD_ID, raw: { id: FAULT_CARD_ID, attributes: { title: 'Faulty', email: 'f@x.com', person_kind: 'member' } } });
  tree.at(['admin', 'contacts', 'items']).set(items);
  M.flushSync?.();

  tree.at(['admin', 'contacts', 'selectedId']).set(FAULT_CARD_ID);
  M.flushSync?.();

  const nameField = fieldByName(ctrl.el, 'attributes.title');
  const input = nameField.querySelector('[data-role="input"]');
  input.value = 'Will roll back';
  input.dispatchEvent({ type: 'blur' });
  M.flushSync?.();

  // Optimistic value present before the response.
  assert.equal(
    tree.at(['admin', 'contacts', 'items']).peek().find((it) => it.id === FAULT_CARD_ID).raw.attributes.title,
    'Will roll back',
  );

  await settle(dispatcher); // server returns a per-row error → auto-rollback
  assert.equal(
    tree.at(['admin', 'contacts', 'items']).peek().find((it) => it.id === FAULT_CARD_ID).raw.attributes.title,
    'Faulty',
    'optimistic edit rolled back on fault',
  );
});

/* -------------------------------------------------------------------------- */
/* Users config mounts (NON-card source) + read-only roles badges.            */
/* -------------------------------------------------------------------------- */

test('Users: the same control loads a non-card source + renders roles as relation rows', async () => {
  const { dispatcher, api } = bootApi(adminTransport({ users: 30 }));
  const { ctrl, tree } = mountMD(api, M.usersScreen());
  await settle(dispatcher);

  const items = tree.at(['admin', 'users', 'items']).peek();
  assert.equal(items.length, 30, '30 user rows landed');

  const rows = visibleRows(ctrl.el);
  assert.match(rows[0].textContent, /User 01/);
  assert.match(rows[0].textContent, /user1@example.com/);

  // Select user 01 (2 roles: worker, admin) → role relation rows render.
  const id = rows[0].dataset.mdId;
  rows[0].dispatchEvent({ type: 'click' });
  M.flushSync?.();
  assert.equal(tree.at(['admin', 'users', 'selectedId']).peek(), id);

  // The Roles relation section lists worker + admin as relation rows.
  const relRows = ctrl.el.querySelectorAll('[data-md-relation-row]');
  const relText = relRows.map((r) => r.textContent).join(' ');
  assert.match(relText, /worker/);
  assert.match(relText, /admin/);
  // The detail DOES carry the inline "+ Assign role" form (role select).
  assert.ok(ctrl.el.querySelector('[data-md-relation-add]'), 'assign-role form rendered');
});

test('Both configs mount through Control.New as registered MasterDetail controls', async () => {
  const { dispatcher, api } = bootApi(adminTransport());
  const c = mountMD(api, M.contactsScreen());
  const u = mountMD(api, M.usersScreen());
  await settle(dispatcher);
  assert.equal(c.ctrl.el.findByControl('MasterDetail').length >= 0, true);
  assert.equal(c.ctrl.type, 'MasterDetail');
  assert.equal(u.ctrl.type, 'MasterDetail');
  // Distinct scope namespaces so two screens never collide in the tree.
  assert.ok(c.tree.at(['admin', 'contacts', 'items']).peek());
  assert.ok(u.tree.at(['admin', 'users', 'items']).peek());
});

/* -------------------------------------------------------------------------- */
/* Workflows create: implicit project + populated governing-attribute select.  */
/* -------------------------------------------------------------------------- */

test('Workflows list is scoped to the active project (like every admin screen)', () => {
  const wf = M.WORKFLOWS_SCREEN;
  assert.deepEqual(wf.list.input.scopeCardId, { from: 'scope.projectId' });
  assert.deepEqual(wf.list.when, { signal: 'scope.projectId' });
  assert.deepEqual(wf.list.skipWhenNull, ['scopeCardId']);

  // The scope is threaded into the compiled flow.list QueryBinding.
  const compiled = M.adminScreenConfig('workflows');
  const listQ = compiled.queries.find((q) => q.spec === 'flow.list');
  assert.ok(listQ, 'compiled flow.list query present');
  assert.deepEqual(listQ.when, { signal: 'scope.projectId' });
  assert.deepEqual(listQ.skipWhenNull, ['scopeCardId']);
});

test('Named Filters: list scoped by enclosing project + detail uses the advanced builder', () => {
  const nf = M.NAMED_FILTERS_SCREEN;
  // Scoped to the active project via the enclosing-project filter (filter cards
  // are grandchildren of the project, so projectId — not parentCardId).
  assert.deepEqual(nf.list.input.projectId, { from: 'scope.projectId' });
  assert.deepEqual(nf.list.when, { signal: 'scope.projectId' });
  assert.deepEqual(nf.list.skipWhenNull, ['projectId']);
  // The predicate is edited with the visual builder, not a readonly JSON field.
  assert.equal(nf.detail.nested.kind, 'filterPredicate');
  assert.ok(!nf.detail.fields.some((f) => f.name === 'attributes.predicate' && f.kind === 'readonly'));
});

test('Workflows create: the project is implicit (no field; scoped from scope.projectId)', () => {
  const wf = M.WORKFLOWS_SCREEN;
  // No Project select field — the scope is implicit.
  assert.ok(
    !wf.create.fields.some((f) => f.name === 'scope_card_id'),
    'no manual Project field in the create form',
  );
  // The governed attribute is still a select sourced from a prefetched list.
  const attrField = wf.create.fields.find((f) => f.name === 'attribute_def_id');
  assert.ok(attrField && attrField.options && 'fromPath' in attrField.options, 'attribute select has fromPath options');
  // scopeCardId flows from the active project scope, not the payload.
  assert.deepEqual(wf.create.input.scopeCardId, { from: 'scope.projectId' });
  // Only the attribute_def prefetch remains (no project option list).
  assert.equal(wf.prefetch.length, 1);
  assert.equal(wf.prefetch[0].landAt, 'admin.workflows.attrOptions');
});

test('MasterDetail create select populates AFTER its prefetch lands (reactive options)', async () => {
  // Reproduces the bug: the dialog builds on mount, but the option list is
  // loaded by a prefetch that resolves a round-trip LATER. A one-time peek at
  // build time would catch an empty list and never refill — the select must
  // repopulate reactively when the prefetch lands.
  const cfg = M.masterDetailScreen({
    type: 'MasterDetail',
    title: 'WF',
    scopeKey: 'wf',
    prefetch: [
      { spec: 'attribute_def.select', landAt: 'wf.attrOptions', valueField: 'id', labelField: 'name' },
    ],
    list: { spec: 'attribute_def.select', row: { title: 'name' } },
    create: {
      spec: 'flow.set',
      title: 'New workflow',
      resultIdField: 'id',
      fields: [
        { name: 'name', label: 'Name', kind: 'text', required: true },
        { name: 'attribute_def_id', label: 'Governs attribute', kind: 'select', required: true, options: { fromPath: 'wf.attrOptions' } },
      ],
      input: { name: { payload: 'name' }, scopeCardId: { from: 'scope.projectId' }, attributeDefId: { payload: 'attribute_def_id' } },
    },
    detail: { titleField: 'name', empty: 'Select one.', fields: [{ name: 'name', label: 'Name', kind: 'readonly' }] },
  });
  const { dispatcher, api } = bootApi(adminTransport());
  const { ctrl } = mountMD(api, cfg);

  const attrSelect = () =>
    ctrl.el.querySelectorAll('[data-md-form-field]').find((e) => e.dataset.mdFormField === 'attribute_def_id');
  // Before the prefetch lands the select is empty (the bug's starting state).
  assert.equal(attrSelect().children.length, 0, 'select starts empty (prefetch not yet landed)');

  await settle(dispatcher);

  // Once the attribute_def.select prefetch lands, the select repopulates — the
  // mock returns two attribute defs (title, person_kind). Required field → no
  // blank placeholder, so exactly two options.
  assert.equal(attrSelect().children.length, 2, 'select populated reactively after the prefetch landed');
});

/* -------------------------------------------------------------------------- */
/* Structured predicate filter on card-backed admin screens (#20).             */
/* -------------------------------------------------------------------------- */

/** Fire a 'change' on a <select>-shaped node after setting its value. */
function setSelect(el, value) {
  el.value = value;
  el.dispatchEvent({ type: 'change' });
  M.flushSync?.();
}
/** Fire an 'input' on an <input>-shaped node after setting its value. */
function setInput(el, value) {
  el.value = value;
  el.dispatchEvent({ type: 'input' });
  M.flushSync?.();
}

test('listQuery: predicateFilter set → query refires on listVersion + carries where/tree inputs', () => {
  const cfg = M.adminScreenConfig('contacts'); // card-backed, predicateFilter:{cardType:'person'}
  const list = cfg.queries.find((q) => q.name === 'list');
  assert.ok(list, 'list query built');
  assert.deepEqual(list.when, { signal: 'admin.contacts.listVersion' }, 'fires on the listVersion leaf');
  assert.ok(list.input && 'where' in list.input && 'tree' in list.input, 'where[] + tree threaded');
  assert.deepEqual(list.input.where, { from: 'admin.contacts.where' });
  assert.deepEqual(list.input.tree, { from: 'admin.contacts.tree' });
});

test('listQuery: NON-card admin config (Users) does NOT thread where/tree', () => {
  const cfg = M.usersScreen(); // no predicateFilter
  const list = cfg.queries.find((q) => q.name === 'list');
  // Users carries detail relations that reload the list, so it fires on the
  // listVersion signal (a non-predicate reload trigger) rather than 'mount'.
  assert.deepEqual(list.when, { signal: 'admin.users.listVersion' }, 'reload trigger on listVersion');
  assert.ok(!list.input || !('where' in list.input), 'no where[] threaded on a non-card screen');
});

test('MasterDetail (card-backed): mounts the PredicateFilter above the search', async () => {
  const { dispatcher, api } = bootApi(adminTransport({ persons: 4 }));
  const { ctrl } = mountMD(api, M.contactsScreen());
  await settle(dispatcher);

  // The structured filter mounted.
  const pf = ctrl.el.findByControl('PredicateFilter');
  assert.equal(pf.length, 1, 'exactly one PredicateFilter mounted on the card-backed screen');
  // It lives inside the dedicated panel in the list pane.
  assert.ok(ctrl.el.querySelector('[data-md-predicate]'), 'predicate panel rendered');
});

test('MasterDetail (non-card): Users screen does NOT mount a PredicateFilter', async () => {
  const { dispatcher, api } = bootApi(adminTransport());
  const { ctrl } = mountMD(api, M.usersScreen());
  await settle(dispatcher);
  assert.equal(ctrl.el.findByControl('PredicateFilter').length, 0, 'no filter on a non-card screen');
  assert.equal(ctrl.el.querySelector('[data-md-predicate]'), null, 'no predicate panel');
});

test('MasterDetail: a built predicate feeds the list query where[] (flat AND) + refires it', async () => {
  const transport = adminTransport({ persons: 4 });
  const { dispatcher, api } = bootApi(transport);
  const { ctrl, tree } = mountMD(api, M.contactsScreen());
  await settle(dispatcher);

  const firesBefore = transport.sent.personInputs.length;

  // Build a leaf in the editor: person_kind is 'text' → default op 'eq'; switch
  // op to contains + type a value so the predicate is a flat AND of one leaf.
  const pf = ctrl.el.findByControl('PredicateFilter')[0];
  pf.querySelector('[data-pred-add-leaf]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  setSelect(pf.querySelector('[data-pred-attr]'), 'person_kind');
  setSelect(pf.querySelector('[data-pred-op]'), 'contains');
  setInput(pf.querySelector('[data-pred-value]').querySelector('input'), 'member');
  await settle(dispatcher);

  // The predicate landed as a flat-AND where[] on the list query input.
  const last = transport.sent.personInputs[transport.sent.personInputs.length - 1];
  assert.deepEqual(
    last.where,
    [{ attr: 'person_kind', op: 'contains', values: ['member'] }],
    'flat-AND predicate fed the list query where[]',
  );
  assert.equal(last.tree, undefined, 'no tree input for a flat-AND predicate');
  assert.ok(transport.sent.personInputs.length > firesBefore, 'predicate edit refired the list query');

  // The where leaf also lives at <scopeKey>.where for the declarative input.
  assert.deepEqual(tree.at(['admin', 'contacts', 'where']).peek(), [
    { attr: 'person_kind', op: 'contains', values: ['member'] },
  ]);
});

test('MasterDetail: a structured (OR) predicate feeds the v2 tree input, not where[]', async () => {
  const transport = adminTransport({ persons: 4 });
  const { dispatcher, api } = bootApi(transport);
  const { ctrl, tree } = mountMD(api, M.contactsScreen());
  await settle(dispatcher);

  const pf = ctrl.el.findByControl('PredicateFilter')[0];
  // Make the root an OR group, then add a leaf → no longer a flat AND of leaves.
  const conn = pf.querySelectorAll('[data-pred-connective]')[0];
  setSelect(conn, 'or');
  pf.querySelector('[data-pred-add-leaf]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  setSelect(pf.querySelector('[data-pred-attr]'), 'person_kind');
  setSelect(pf.querySelector('[data-pred-op]'), 'contains');
  setInput(pf.querySelector('[data-pred-value]').querySelector('input'), 'contact');
  await settle(dispatcher);

  const last = transport.sent.personInputs[transport.sent.personInputs.length - 1];
  assert.deepEqual(
    last.tree,
    { connective: 'or', children: [{ attr: 'person_kind', op: 'contains', values: ['contact'] }] },
    'structured predicate fed the v2 tree input',
  );
  assert.equal(last.where, undefined, 'no where[] for a structured tree');
  assert.ok(tree.at(['admin', 'contacts', 'tree']).peek(), 'tree leaf set');
});

/* -------------------------------------------------------------------------- */
/* Generic create / delete config contract (card-backed + person).            */
/* -------------------------------------------------------------------------- */

/** Fill the create dialog's fields by their data-md-form-field name. */
function fillCreateDialog(ctrl, values) {
  const dialog = ctrl.el.querySelector('[data-md-create]');
  for (const [name, value] of Object.entries(values)) {
    const field = dialog.querySelectorAll('[data-md-form-field]').find((el) => el.dataset.mdFormField === name);
    if (field) {
      field.value = value;
      field.dispatchEvent({ type: 'input' });
    }
  }
  return dialog;
}

test('masterDetailScreen wires create + delete actions for card-backed screens', () => {
  for (const view of ['projects', 'screens', 'filters']) {
    const cfg = M.adminScreenConfig(view);
    assert.ok(cfg.actions.some((a) => a.intent === 'createItem' && a.spec === 'card.insert'), `${view} create → card.insert`);
    assert.ok(cfg.actions.some((a) => a.intent === 'deleteItem' && a.spec === 'card.delete'), `${view} delete → card.delete`);
  }
  // Contacts creates via person.create + deletes via card.delete.
  const contacts = M.adminScreenConfig('contacts');
  assert.ok(contacts.actions.some((a) => a.intent === 'createItem' && a.spec === 'person.create'));
  assert.ok(contacts.actions.some((a) => a.intent === 'deleteItem' && a.spec === 'card.delete'));
});

test('Projects: "+ New" fires card.insert optimistically + the row appears, then promotes to the real id', async () => {
  const transport = adminTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl, tree } = mountMD(api, M.adminScreenConfig('projects'));
  await settle(dispatcher);

  const before = (tree.at(['admin', 'projects', 'items']).peek() ?? []).length;

  // Open the create dialog, fill the title, submit.
  ctrl.el.querySelector('[data-md-new]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  fillCreateDialog(ctrl, { title: 'New Apollo' });
  ctrl.el.querySelector('[data-md-create-submit]').dispatchEvent({ type: 'click' });
  M.flushSync?.();

  // OPTIMISTIC: a temp-id row appears immediately (negative id), before the flush.
  let items = tree.at(['admin', 'projects', 'items']).peek();
  assert.equal(items.length, before + 1, 'optimistic row added');
  const optimistic = items[items.length - 1];
  assert.ok(optimistic.id.startsWith('-'), 'optimistic row carries a negative temp id');
  assert.equal(M.fieldText(optimistic.raw, 'attributes.title'), 'New Apollo');

  await settle(dispatcher); // the request reaches the transport + server commits

  // The wire carried the card.insert with the project card_type + title.
  const w = transport.sent.writes.find((x) => x.key === 'card.insert');
  assert.ok(w, 'card.insert fired');
  assert.equal(w.data.card_type_name, 'project');
  assert.equal(w.data.title, 'New Apollo');

  // Temp id promoted to the server-returned id.
  items = tree.at(['admin', 'projects', 'items']).peek();
  const promoted = items.find((it) => it.id === '7777');
  assert.ok(promoted, 'temp row promoted to the server-returned id');
  assert.equal(M.fieldText(promoted.raw, 'attributes.title'), 'New Apollo');
});

test('Screens: "+ New" sends the required layout + slug in attributes (New Screen fix #18)', async () => {
  const transport = adminTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl, tree } = mountMD(api, M.adminScreenConfig('screens'));
  tree.at(['scope', 'projectId']).set(100n); // screens parent under the active project
  await settle(dispatcher);

  ctrl.el.querySelector('[data-md-new]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  // A screen card REQUIRES title + layout + slug — the create now collects all
  // three (title-only used to fail an edge_violation).
  fillCreateDialog(ctrl, { title: 'Backlog', layout: 'grid', slug: 'backlog' });
  ctrl.el.querySelector('[data-md-create-submit]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  await settle(dispatcher);

  const w = transport.sent.writes.find((x) => x.key === 'card.insert');
  assert.ok(w, 'card.insert fired');
  assert.equal(w.data.card_type_name, 'screen');
  assert.equal(w.data.title, 'Backlog', 'title rides top-level');
  assert.deepEqual(
    w.data.attributes,
    { layout: 'grid', slug: 'backlog' },
    'layout + slug ride in attributes (the required edges)',
  );
});

test('Projects: create fault rolls back the optimistic add', async () => {
  const transport = adminTransport({ failWrites: true });
  const { dispatcher, api } = bootApi(transport);
  const { ctrl, tree } = mountMD(api, M.adminScreenConfig('projects'));
  await settle(dispatcher);

  const before = (tree.at(['admin', 'projects', 'items']).peek() ?? []).length;
  ctrl.el.querySelector('[data-md-new]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  fillCreateDialog(ctrl, { title: 'Doomed' });
  ctrl.el.querySelector('[data-md-create-submit]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  assert.equal(tree.at(['admin', 'projects', 'items']).peek().length, before + 1, 'optimistic add present');

  await settle(dispatcher); // server faults → rollback
  assert.equal(tree.at(['admin', 'projects', 'items']).peek().length, before, 'optimistic add rolled back on fault');
});

test('Projects: required title gates the submit (no card.insert fires)', async () => {
  const transport = adminTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountMD(api, M.adminScreenConfig('projects'));
  await settle(dispatcher);

  ctrl.el.querySelector('[data-md-new]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  // Submit with an empty title.
  ctrl.el.querySelector('[data-md-create-submit]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  await settle(dispatcher);
  assert.equal(transport.sent.writes.filter((w) => w.key === 'card.insert').length, 0, 'no insert with an empty required title');
});

test('Projects: deleting the selected row fires card.delete + the row leaves (optimistic)', async () => {
  const transport = adminTransport();
  const { dispatcher, api } = bootApi(transport);
  const { ctrl, tree } = mountMD(api, M.adminScreenConfig('projects'));
  await settle(dispatcher);

  // Seed one real project row + select it (the mock projects list returns []).
  tree.at(['admin', 'projects', 'items']).set([
    { id: '7001', raw: { id: '7001', attributes: { title: 'Apollo' } } },
  ]);
  tree.at(['admin', 'projects', 'selectedId']).set('7001');
  M.flushSync?.();

  const del = ctrl.el.querySelector('[data-md-delete]');
  assert.ok(del, 'delete button rendered on the selected detail');
  del.dispatchEvent({ type: 'click' });
  M.flushSync?.();

  // OPTIMISTIC: the row left the list immediately.
  assert.equal(tree.at(['admin', 'projects', 'items']).peek().find((it) => it.id === '7001'), undefined, 'row removed optimistically');

  await settle(dispatcher); // the request reaches the transport + server commits
  const w = transport.sent.writes.find((x) => x.key === 'card.delete');
  assert.ok(w, 'card.delete fired');
  assert.equal(String(w.data.card_id), '7001');
  assert.equal(tree.at(['admin', 'projects', 'items']).peek().find((it) => it.id === '7001'), undefined, 'row stays deleted on commit');
});

test('Projects: a delete fault rolls the row back into the list', async () => {
  const transport = adminTransport({ failWrites: true });
  const { dispatcher, api } = bootApi(transport);
  const { ctrl, tree } = mountMD(api, M.adminScreenConfig('projects'));
  await settle(dispatcher);

  tree.at(['admin', 'projects', 'items']).set([
    { id: '7001', raw: { id: '7001', attributes: { title: 'Apollo' } } },
  ]);
  tree.at(['admin', 'projects', 'selectedId']).set('7001');
  M.flushSync?.();

  ctrl.el.querySelector('[data-md-delete]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  assert.equal(tree.at(['admin', 'projects', 'items']).peek().length, 0, 'optimistically removed');

  await settle(dispatcher); // fault → rollback
  const items = tree.at(['admin', 'projects', 'items']).peek();
  assert.equal(items.length, 1, 'row rolled back into the list on fault');
  assert.equal(items[0].id, '7001');
});

/* -------------------------------------------------------------------------- */
/* Contacts create via person.create — the user tier passes through.           */
/* -------------------------------------------------------------------------- */

test('Contacts: "+ New" with the user tier fires person.create carrying tier=user + email', async () => {
  const transport = adminTransport({ persons: 4 });
  const { dispatcher, api } = bootApi(transport);
  const { ctrl, tree } = mountMD(api, M.contactsScreen());
  await settle(dispatcher);

  const before = tree.at(['admin', 'contacts', 'items']).peek().length;
  ctrl.el.querySelector('[data-md-new]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  fillCreateDialog(ctrl, { title: 'Grace Hopper', email: 'grace@example.com', tier: 'user' });
  ctrl.el.querySelector('[data-md-create-submit]').dispatchEvent({ type: 'click' });
  M.flushSync?.();

  // OPTIMISTIC add.
  assert.equal(tree.at(['admin', 'contacts', 'items']).peek().length, before + 1, 'optimistic person row added');

  await settle(dispatcher); // the request reaches the transport + promotes to 8888

  // The wire carried person.create with the tier + email passed through.
  const w = transport.sent.writes.find((x) => x.key === 'person.create');
  assert.ok(w, 'person.create fired');
  assert.equal(w.data.tier, 'user', 'user tier passed through');
  assert.equal(w.data.title, 'Grace Hopper');
  assert.equal(w.data.email, 'grace@example.com');

  const promoted = tree.at(['admin', 'contacts', 'items']).peek().find((it) => it.id === '8888');
  assert.ok(promoted, 'temp row promoted to the returned person_card_id');
});

test('Contacts: a contact-tier create omits email but still passes the tier', async () => {
  const transport = adminTransport({ persons: 4 });
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountMD(api, M.contactsScreen());
  await settle(dispatcher);

  ctrl.el.querySelector('[data-md-new]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  fillCreateDialog(ctrl, { title: 'Inbound Only', tier: 'contact' });
  ctrl.el.querySelector('[data-md-create-submit]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  await settle(dispatcher);

  const w = transport.sent.writes.find((x) => x.key === 'person.create');
  assert.ok(w, 'person.create fired');
  assert.equal(w.data.tier, 'contact');
  assert.equal(w.data.email, undefined, 'no email key when blank');
});

/* -------------------------------------------------------------------------- */
/* Users role assign / revoke + unlink-person (detail-pane relations).         */
/* -------------------------------------------------------------------------- */

test('Users: "+ Assign role" fires user_role.set (scoped) + reloads the row', async () => {
  const transport = adminTransport({ users: 4 });
  const { dispatcher, api } = bootApi(transport);
  const { ctrl, tree } = mountMD(api, M.usersScreen());
  await settle(dispatcher);

  const rows = visibleRows(ctrl.el);
  const id = rows[0].dataset.mdId;
  rows[0].dispatchEvent({ type: 'click' });
  M.flushSync?.();

  const addForm = ctrl.el.querySelector('[data-md-relation-add]');
  assert.ok(addForm, 'the assign-role form rendered');
  const fields = addForm.querySelectorAll('[data-md-form-field]');
  const roleSel = fields.find((el) => el.dataset.mdFormField === 'role_name');
  const scopeInput = fields.find((el) => el.dataset.mdFormField === 'scope_project_id');
  roleSel.value = 'manager';
  roleSel.dispatchEvent({ type: 'change' });
  scopeInput.value = '31';
  scopeInput.dispatchEvent({ type: 'input' });
  const v = tree.at(['admin', 'users', 'listVersion']).peek();
  addForm.querySelector('[data-md-relation-submit]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  await settle(dispatcher);

  const w = transport.sent.writes.find((x) => x.key === 'user_role.set');
  assert.ok(w, 'user_role.set fired');
  assert.equal(String(w.data.user_id), id, 'the selected user id');
  assert.equal(w.data.role_name, 'manager');
  assert.equal(String(w.data.scope_project_id), '31', 'scoped to the entered project');

  // After success the list reloads (listVersion bumped → user.list_with_roles refires).
  assert.ok(tree.at(['admin', 'users', 'listVersion']).peek() > v, 'list reloaded after assign');
});

test('Users: assigning a role without a scope sends an unscoped (global) grant', async () => {
  const transport = adminTransport({ users: 4 });
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountMD(api, M.usersScreen());
  await settle(dispatcher);

  const rows = visibleRows(ctrl.el);
  rows[0].dispatchEvent({ type: 'click' });
  M.flushSync?.();

  const addForm = ctrl.el.querySelector('[data-md-relation-add]');
  const roleSel = addForm.querySelectorAll('[data-md-form-field]').find((el) => el.dataset.mdFormField === 'role_name');
  roleSel.value = 'worker';
  roleSel.dispatchEvent({ type: 'change' });
  addForm.querySelector('[data-md-relation-submit]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  await settle(dispatcher);

  const w = transport.sent.writes.find((x) => x.key === 'user_role.set');
  assert.ok(w, 'user_role.set fired');
  assert.equal(w.data.role_name, 'worker');
  // The optional empty scope field resolves to '' which the encoder drops.
  assert.equal(w.data.scope_project_id, undefined, 'no scope key → a global grant');
});

test('Users: a per-role Revoke fires user_role.revoke with that role + scope', async () => {
  const transport = adminTransport({ users: 4 });
  const { dispatcher, api } = bootApi(transport);
  const { ctrl } = mountMD(api, M.usersScreen());
  await settle(dispatcher);

  // User 02 is even → a single scoped 'manager' role (scope_project_id '31').
  const rows = visibleRows(ctrl.el);
  const userRow = rows.find((r) => /User 02/.test(r.textContent));
  userRow.dispatchEvent({ type: 'click' });
  M.flushSync?.();

  const revoke = ctrl.el.querySelector('[data-md-relation-remove]');
  assert.ok(revoke, 'a Revoke button rendered for the existing role');
  revoke.dispatchEvent({ type: 'click' });
  M.flushSync?.();
  await settle(dispatcher);

  const w = transport.sent.writes.find((x) => x.key === 'user_role.revoke');
  assert.ok(w, 'user_role.revoke fired');
  assert.equal(w.data.role_name, 'manager');
  assert.equal(String(w.data.scope_project_id), '31', 'the scoped grant is targeted');
});

test('Users: Unlink person fires user.unlink_person for the user account', async () => {
  // Seed a user with a linked person_card_id so the singular relation renders.
  const transport = adminTransport({ users: 4 });
  const { dispatcher, api } = bootApi(transport);
  const { ctrl, tree } = mountMD(api, M.usersScreen());
  await settle(dispatcher);

  const items = tree.at(['admin', 'users', 'items']).peek().slice();
  items.unshift({ id: '2999', raw: { id: '2999', display_name: 'Linked User', email: 'l@x.com', is_agent: false, roles: [], person_card_id: '6001' } });
  tree.at(['admin', 'users', 'items']).set(items);
  tree.at(['admin', 'users', 'selectedId']).set('2999');
  M.flushSync?.();

  // The Linked person section shows the person card id + an Unlink button.
  const personSection = ctrl.el.querySelectorAll('[data-md-relation]').find((s) => s.dataset.mdRelation === 'Linked person');
  assert.ok(personSection, 'Linked person section rendered');
  assert.match(personSection.textContent, /6001/, 'shows the linked person card id');
  const unlink = personSection.querySelector('[data-md-relation-remove]');
  assert.ok(unlink, 'Unlink button rendered when a person is linked');
  unlink.dispatchEvent({ type: 'click' });
  M.flushSync?.();
  await settle(dispatcher);

  const w = transport.sent.writes.find((x) => x.key === 'user.unlink_person');
  assert.ok(w, 'user.unlink_person fired');
  assert.equal(String(w.data.user_account_id), '2999', 'the selected user account id');
});

test('Users: a user with no linked person shows the "— (none)" placeholder + no Unlink', async () => {
  const transport = adminTransport({ users: 4 });
  const { dispatcher, api } = bootApi(transport);
  const { ctrl, tree } = mountMD(api, M.usersScreen());
  await settle(dispatcher);

  const rows = visibleRows(ctrl.el);
  rows[0].dispatchEvent({ type: 'click' });
  M.flushSync?.();

  const personSection = ctrl.el.querySelectorAll('[data-md-relation]').find((s) => s.dataset.mdRelation === 'Linked person');
  assert.ok(personSection.querySelector('[data-md-relation-none]'), 'none placeholder shown');
  assert.equal(personSection.querySelector('[data-md-relation-remove]'), null, 'no Unlink without a link');
});
