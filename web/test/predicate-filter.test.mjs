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
  M.registerPredicateFilter();
});

/* -------------------------------------------------------------------------- */
/* Test fixtures: a literal schema + helpers to mount + drive the editor.      */
/* -------------------------------------------------------------------------- */

const SCHEMA = [
  { name: 'title', label: 'Title', valueType: 'text' },
  { name: 'priority', label: 'Priority', valueType: 'number' },
  { name: 'due_date', label: 'Due Date', valueType: 'date' },
  { name: 'is_template', label: 'Is Template', valueType: 'bool' },
  { name: 'milestone_ref', label: 'Milestone', valueType: 'card_ref', targetCardType: 'milestone' },
  { name: 'tags', label: 'Tags', valueType: 'card_ref[]', targetCardType: 'tag' },
];

/** A standalone ctx with a fresh tree (no api needed for a literal schema). */
function literalCtx() {
  const tree = new M.TreeNode({}, []);
  // No DataController calls fire for a literal schema (no defs query), but the
  // host surface needs an api object present; a stub callByName is never hit.
  const api = { callByName: () => '' };
  return { ctx: { api, tree }, tree };
}

function mount(config, ctx) {
  const c = M.Control.New('PredicateFilter', config, ctx);
  const host = new FakeElement('div');
  c.mount(host);
  M.flushSync?.();
  return c;
}

/** Fire a 'change' on a <select>-shaped FakeElement after setting its value. */
function setSelect(el, value) {
  el.value = value;
  el.dispatchEvent({ type: 'change' });
  M.flushSync?.();
}

/** Fire an 'input' on an <input>-shaped FakeElement after setting its value. */
function setInput(el, value) {
  el.value = value;
  el.dispatchEvent({ type: 'input' });
  M.flushSync?.();
}

function leafRows(root) {
  return root.querySelectorAll('[data-pred-leaf]');
}
function groupBoxes(root) {
  return root.querySelectorAll('[data-pred-group]');
}

/* -------------------------------------------------------------------------- */
/* Mount.                                                                      */
/* -------------------------------------------------------------------------- */

test('PredicateFilter mounts a root group with no leaves + writes null', () => {
  const { ctx, tree } = literalCtx();
  const c = mount(
    { type: 'PredicateFilter', valuePath: 'screen.filter', schema: SCHEMA },
    ctx,
  );
  // One group (the root), no leaves yet.
  assert.equal(groupBoxes(c.el).length, 1);
  assert.equal(leafRows(c.el).length, 0);
  // Empty AND root => no predicate written (null) at the value path.
  assert.equal(c.currentPredicate(), null);
});

/* -------------------------------------------------------------------------- */
/* add leaf -> set attr -> set op -> set value, all landing at valuePath.      */
/* -------------------------------------------------------------------------- */

test('add-leaf seeds the first schema attr + its default op', () => {
  const { ctx, tree } = literalCtx();
  const c = mount(
    { type: 'PredicateFilter', valuePath: 'screen.filter', schema: SCHEMA },
    ctx,
  );
  const addLeaf = c.el.querySelector('[data-pred-add-leaf]');
  addLeaf.dispatchEvent({ type: 'click' });
  M.flushSync?.();

  assert.equal(leafRows(c.el).length, 1, 'one leaf row added');
  // First schema attr is `title` (text) -> default op `eq`.
  const wire = c.currentWire();
  assert.deepEqual(wire, {
    connective: 'and',
    children: [{ attr: 'title', op: '=' }],
  });
});

test('set-attr to a card_ref switches op list; set-op to in; set value via ref picker', () => {
  const { ctx, tree } = literalCtx();
  // Pre-load milestone options at the configured options path.
  tree.at(['screen', 'filterOptions']).set({
    milestone: [
      { value: '32', label: 'M1' },
      { value: '33', label: 'M2' },
    ],
  });
  const c = mount(
    {
      type: 'PredicateFilter',
      valuePath: 'screen.filter',
      schema: SCHEMA,
      optionsPath: 'screen.filterOptions',
    },
    ctx,
  );
  c.el.querySelector('[data-pred-add-leaf]').dispatchEvent({ type: 'click' });
  M.flushSync?.();

  // Change the attribute to the card_ref milestone_ref.
  setSelect(c.el.querySelector('[data-pred-attr]'), 'milestone_ref');
  // The operator selector now offers `in` (card_ref op set).
  const opSel = c.el.querySelector('[data-pred-op]');
  const opValues = opSel.children.map((o) => o.value);
  assert.ok(opValues.includes('in'), 'card_ref op list includes in');
  assert.ok(opValues.includes('hasPhase'), 'card_ref op list includes hasPhase');

  // Switch op to `in` (multi) -> a multi ref <select> appears with the options.
  setSelect(opSel, 'in');
  const ref = c.el.querySelector('[data-pred-ref]');
  assert.ok(ref, 'ref picker rendered');
  assert.equal(ref.multiple, true, 'in => multi-select');
  // Options came from the lookup path.
  const refOptionValues = ref.children.map((o) => o.value);
  assert.deepEqual(refOptionValues, ['32', '33']);

  // Pick two options (set .selected on the option nodes, fire change).
  ref.children[0].selected = true;
  ref.children[1].selected = true;
  ref.dispatchEvent({ type: 'change' });
  M.flushSync?.();

  assert.deepEqual(c.currentWire(), {
    connective: 'and',
    children: [{ attr: 'milestone_ref', op: 'in', values: ['32', '33'] }],
  });
});

test('text leaf: typing a value lands a contains predicate', () => {
  const { ctx } = literalCtx();
  const c = mount(
    { type: 'PredicateFilter', valuePath: 'screen.filter', schema: SCHEMA },
    ctx,
  );
  c.el.querySelector('[data-pred-add-leaf]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  // Default attr=title (text). Switch op to contains, then type.
  setSelect(c.el.querySelector('[data-pred-op]'), 'contains');
  setInput(c.el.querySelector('[data-pred-value]').querySelector('input'), 'urgent');
  assert.deepEqual(c.currentWire(), {
    connective: 'and',
    children: [{ attr: 'title', op: 'contains', values: ['urgent'] }],
  });
});

/* -------------------------------------------------------------------------- */
/* exists-op leaf emits no value.                                              */
/* -------------------------------------------------------------------------- */

test('exists-op leaf renders no value editor + emits no values on the wire', () => {
  const { ctx } = literalCtx();
  const c = mount(
    { type: 'PredicateFilter', valuePath: 'screen.filter', schema: SCHEMA },
    ctx,
  );
  c.el.querySelector('[data-pred-add-leaf]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  // title supports exists. Switch op to exists.
  setSelect(c.el.querySelector('[data-pred-op]'), 'exists');
  // The value slot shows the "no value" marker, no input.
  assert.ok(c.el.querySelector('[data-pred-novalue]'), 'no-value marker shown');
  assert.equal(c.el.querySelector('[data-pred-value]').querySelector('input'), null, 'no value input');
  assert.deepEqual(c.currentWire(), {
    connective: 'and',
    children: [{ attr: 'title', op: 'exists' }],
  });
});

/* -------------------------------------------------------------------------- */
/* has_phase multi-checkbox.                                                   */
/* -------------------------------------------------------------------------- */

test('hasPhase renders triage/active/terminal checkboxes; toggling lands phases', () => {
  const { ctx } = literalCtx();
  const c = mount(
    { type: 'PredicateFilter', valuePath: 'screen.filter', schema: SCHEMA },
    ctx,
  );
  c.el.querySelector('[data-pred-add-leaf]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  setSelect(c.el.querySelector('[data-pred-attr]'), 'milestone_ref');
  setSelect(c.el.querySelector('[data-pred-op]'), 'hasPhase');

  const phaseBox = c.el.querySelector('[data-pred-phases]');
  assert.ok(phaseBox, 'phase picker shown');
  const checks = phaseBox.querySelectorAll('input');
  assert.equal(checks.length, 3, 'triage/active/terminal');
  // Toggle the first (triage) and third (terminal).
  checks[0].checked = true;
  checks[0].dispatchEvent({ type: 'change' });
  checks[2].checked = true;
  checks[2].dispatchEvent({ type: 'change' });
  M.flushSync?.();

  assert.deepEqual(c.currentWire(), {
    connective: 'and',
    children: [{ attr: 'milestone_ref', op: 'has_phase', values: ['triage', 'terminal'] }],
  });
});

/* -------------------------------------------------------------------------- */
/* add group / change connective / remove.                                     */
/* -------------------------------------------------------------------------- */

test('add-group nests a child group; change connective to OR; remove it', () => {
  const { ctx } = literalCtx();
  const c = mount(
    { type: 'PredicateFilter', valuePath: 'screen.filter', schema: SCHEMA },
    ctx,
  );
  // Add a nested group.
  c.el.querySelector('[data-pred-add-group]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  assert.equal(groupBoxes(c.el).length, 2, 'root + one nested group');

  // The root's connective <select> is the first one; switch the ROOT to OR.
  const connSelects = c.el.querySelectorAll('[data-pred-connective]');
  setSelect(connSelects[0], 'or');
  assert.equal(c.currentPredicate().connective, 'or', 'root connective is OR');

  // Add a leaf into the nested group, then verify the tree shape.
  const nestedAddLeaf = c.el.querySelectorAll('[data-pred-add-leaf]')[1];
  nestedAddLeaf.dispatchEvent({ type: 'click' });
  M.flushSync?.();
  assert.equal(leafRows(c.el).length, 1, 'one leaf inside the nested group');
  const wire = c.currentWire();
  assert.equal(wire.connective, 'or');
  assert.equal(wire.children.length, 1);
  assert.equal(wire.children[0].connective, 'and');
  assert.equal(wire.children[0].children.length, 1);

  // Remove the nested group (its own remove button).
  c.el.querySelector('[data-pred-remove-group]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  assert.equal(groupBoxes(c.el).length, 1, 'nested group removed');
  // Empty OR root is vacuously-false (matches nothing) — meaningfully distinct
  // from "no filter"; only an empty AND collapses to null. So the OR root stays.
  assert.deepEqual(c.currentWire(), { connective: 'or', children: [] });
});

test('remove-leaf drops the leaf from its group', () => {
  const { ctx } = literalCtx();
  const c = mount(
    { type: 'PredicateFilter', valuePath: 'screen.filter', schema: SCHEMA },
    ctx,
  );
  const addLeaf = c.el.querySelector('[data-pred-add-leaf]');
  addLeaf.dispatchEvent({ type: 'click' });
  M.flushSync?.();
  addLeaf.dispatchEvent({ type: 'click' });
  M.flushSync?.();
  assert.equal(leafRows(c.el).length, 2);

  c.el.querySelector('[data-pred-remove-leaf]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  assert.equal(leafRows(c.el).length, 1, 'one leaf removed');
});

/* -------------------------------------------------------------------------- */
/* Seeding from an existing predicate at valuePath.                            */
/* -------------------------------------------------------------------------- */

test('seeds the editor from an existing predicate AST at valuePath', () => {
  const { ctx, tree } = literalCtx();
  tree.at(['screen', 'filter']).set({
    kind: 'group',
    connective: 'and',
    children: [{ kind: 'leaf', attr: 'priority', op: 'eq', values: [3] }],
  });
  const c = mount(
    { type: 'PredicateFilter', valuePath: 'screen.filter', schema: SCHEMA },
    ctx,
  );
  assert.equal(leafRows(c.el).length, 1, 'seeded leaf rendered');
  assert.deepEqual(c.currentWire(), {
    connective: 'and',
    children: [{ attr: 'priority', op: '=', values: [3] }],
  });
});

/* -------------------------------------------------------------------------- */
/* { cardType } schema source via attribute_def.select.                        */
/* -------------------------------------------------------------------------- */

test('{ cardType } schema sources attributes from attribute_def.select', async () => {
  const tree = new M.TreeNode({}, []);
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => {
        if (`${sr.endpoint}.${sr.action}` === 'attribute_def.select') {
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
                  bound_to: [{ card_type_id: '5', card_type_name: 'task', ordering: 1 }],
                },
                {
                  id: '2',
                  name: 'milestone_ref',
                  value_type: 'card_ref',
                  target_card_type_name: 'milestone',
                  is_built_in: true,
                  bound_to: [{ card_type_id: '5', card_type_name: 'task', ordering: 2 }],
                },
              ],
            },
          };
        }
        return { id: sr.id, ok: false, error: { code: 'x', message: 'no' } };
      });
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerFilterSpecs(api);
  const ctx = { api, tree };

  const c = mount(
    { type: 'PredicateFilter', valuePath: 'screen.filter', schema: { cardType: 'task' } },
    ctx,
  );
  // Defs fetch fires on mount via the data layer; settle it.
  await dispatcher.flushNow();
  M.flushSync?.();

  // Add a leaf — its attribute selector should now offer the sourced attrs.
  c.el.querySelector('[data-pred-add-leaf]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  const attrSel = c.el.querySelector('[data-pred-attr]');
  const names = attrSel.children.map((o) => o.value);
  assert.deepEqual(names, ['title', 'milestone_ref'], 'attrs sourced from attribute_def.select');
});

/* -------------------------------------------------------------------------- */
/* The universal view builder: group-by + sort-by sections (#4).               */
/* -------------------------------------------------------------------------- */

test('PredicateFilter: groupPath renders a group-by select that writes the attr name', () => {
  const { ctx, tree } = literalCtx();
  const c = mount(
    { type: 'PredicateFilter', valuePath: 'screen.filter', schema: SCHEMA, groupPath: 'screen.group', sortPath: 'screen.sort' },
    ctx,
  );
  const groupSel = c.el.querySelector('[data-pred-group-select]');
  assert.ok(groupSel, 'group-by select present when groupPath is set');
  // Only card_ref (single) attrs are groupable: No group + Milestone.
  const opts = groupSel.children.map((o) => o.value);
  assert.deepEqual(opts, ['', 'milestone_ref']);
  setSelect(groupSel, 'milestone_ref');
  assert.equal(tree.at(['screen', 'group']).peek(), 'milestone_ref');
});

test('PredicateFilter: sortPath adds/edits/removes sort rows writing { attr, dir }[]', () => {
  const { ctx, tree } = literalCtx();
  const c = mount(
    { type: 'PredicateFilter', valuePath: 'screen.filter', schema: SCHEMA, sortPath: 'screen.sort' },
    ctx,
  );
  const add = c.el.querySelector('[data-pred-sort-add]');
  assert.ok(add, '+ sort present when sortPath is set');
  add.dispatchEvent({ type: 'click' });
  M.flushSync?.();
  // The first schema attr (title) seeds the new row, ascending.
  assert.deepEqual(tree.at(['screen', 'sort']).peek(), [{ attr: 'title', dir: 'asc' }]);

  setSelect(c.el.querySelector('[data-pred-sort-field]'), 'priority');
  setSelect(c.el.querySelector('[data-pred-sort-dir]'), 'desc');
  assert.deepEqual(tree.at(['screen', 'sort']).peek(), [{ attr: 'priority', dir: 'desc' }]);

  c.el.querySelector('[data-pred-sort-remove]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  assert.equal(tree.at(['screen', 'sort']).peek(), null, 'removing the last row clears to null');
});

test('PredicateFilter: no group/sort sections without the paths (back-compat)', () => {
  const { ctx } = literalCtx();
  const c = mount({ type: 'PredicateFilter', valuePath: 'screen.filter', schema: SCHEMA }, ctx);
  assert.equal(c.el.querySelector('[data-pred-groupby]'), null);
  assert.equal(c.el.querySelector('[data-pred-sortby]'), null);
});
