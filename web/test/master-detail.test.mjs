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

function adminTransport({ persons = 32, users = 30 } = {}) {
  // Records the most recent person-list query input so a test can inspect the
  // where[]/tree the predicate filter feeds into the list query.
  const sent = { personInputs: [] };
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
  M.registerAdminSpecs(api); // user.list_with_roles + user.select + attribute_def.select
  M.registerFilterSpecs(api); // idempotent: attribute_def.select already defined above
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

  // Users has NO updateSpec → no update action (read-only viewer).
  const users = M.usersScreen();
  assert.ok(users.queries.some((q) => q.spec === 'user.list_with_roles'));
  assert.equal(users.actions.length, 0, 'read-only screen has no editField action');
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

test('Users: the same control loads a non-card source + renders roles as badges', async () => {
  const { dispatcher, api } = bootApi(adminTransport({ users: 30 }));
  const { ctrl, tree } = mountMD(api, M.usersScreen());
  await settle(dispatcher);

  const items = tree.at(['admin', 'users', 'items']).peek();
  assert.equal(items.length, 30, '30 user rows landed');

  const rows = visibleRows(ctrl.el);
  assert.match(rows[0].textContent, /User 01/);
  assert.match(rows[0].textContent, /user1@example.com/);

  // Select user 01 (2 roles: worker, admin) → badges render read-only.
  const id = rows[0].dataset.mdId;
  rows[0].dispatchEvent({ type: 'click' });
  M.flushSync?.();
  assert.equal(tree.at(['admin', 'users', 'selectedId']).peek(), id);

  const badgesField = fieldByName(ctrl.el, 'roles');
  const badges = badgesField.querySelector('[data-role="badges"]');
  assert.ok(badges, 'badges container rendered');
  assert.match(badges.textContent, /worker/);
  assert.match(badges.textContent, /admin/);
  // No editable input in a read-only users detail.
  assert.equal(ctrl.el.querySelector('[data-role="input"]'), null, 'users detail has no editable inputs');
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

test('listQuery: NON-card admin config (Users) does NOT thread where/tree + fires on mount', () => {
  const cfg = M.usersScreen(); // no predicateFilter
  const list = cfg.queries.find((q) => q.name === 'list');
  assert.equal(list.when ?? 'mount', 'mount', 'no listVersion trigger');
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
