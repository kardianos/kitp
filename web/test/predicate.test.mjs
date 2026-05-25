import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;

before(async () => {
  // The pure predicate model needs no DOM, but the app barrel now (via
  // TaskDetail) transitively pulls in the markdown sink, whose DOMPurify hook
  // registers at import-eval — that needs a window/document to exist. The light
  // shim satisfies the init guard (no markdown is rendered in this file).
  installDomShim();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
});

/* -------------------------------------------------------------------------- */
/* toWire / fromWire round-trip — must match card_compile_predicate.sql.       */
/* -------------------------------------------------------------------------- */

test('toWire produces the card_compile_predicate group/leaf shape', () => {
  const { andOf, orOf, notOf, leaf, toWire } = M;
  // (status in [40,41]) AND (NOT (assignee = 10)) OR (due_date before_today)
  const tree = orOf([
    andOf([
      leaf('status', 'in', [40, 41]),
      notOf(leaf('assignee', 'eq', [10])),
    ]),
    leaf('due_date', 'beforeToday'),
  ]);

  const wire = toWire(tree);
  assert.deepEqual(wire, {
    connective: 'or',
    children: [
      {
        connective: 'and',
        children: [
          { attr: 'status', op: 'in', values: [40, 41] },
          { connective: 'not', children: [{ attr: 'assignee', op: '=', values: [10] }] },
        ],
      },
      // before_today is a no-value op: `values` omitted.
      { attr: 'due_date', op: 'before_today' },
    ],
  });
});

test('toWire omits empty values for no-value ops (exists / notExists)', () => {
  const { leaf, toWire } = M;
  assert.deepEqual(toWire(leaf('milestone_ref', 'exists')), {
    attr: 'milestone_ref',
    op: 'exists',
  });
  assert.deepEqual(toWire(leaf('milestone_ref', 'notExists', [])), {
    attr: 'milestone_ref',
    op: 'not exists',
  });
});

test('fromWire is the inverse of toWire (group + leaf)', () => {
  const { andOf, notOf, leaf, toWire, fromWire } = M;
  const tree = andOf([
    leaf('title', 'contains', ['urgent']),
    notOf(leaf('priority', 'eq', ['high'])),
    leaf('due_date', 'withinDays', [3]),
  ]);
  const back = fromWire(toWire(tree));
  assert.deepEqual(back, tree);
});

test('fromWire accepts the v1 single-value `value` shape', () => {
  const { fromWire } = M;
  const p = fromWire({ attr: 'is_template', op: '!=', value: true });
  assert.deepEqual(p, { kind: 'leaf', attr: 'is_template', op: 'ne', values: [true] });
});

test('fromWire accepts the v1 compound { and: [...] } shape', () => {
  const { fromWire } = M;
  const p = fromWire({ and: [{ attr: 'status', op: '=', value: 'open' }] });
  assert.equal(p.kind, 'group');
  assert.equal(p.connective, 'and');
  assert.equal(p.children.length, 1);
  assert.deepEqual(p.children[0], { kind: 'leaf', attr: 'status', op: 'eq', values: ['open'] });
});

test('fromWire rejects a NOT group without exactly one child', () => {
  const { fromWire } = M;
  assert.throws(() => fromWire({ connective: 'not', children: [] }), /exactly one child/);
  assert.throws(
    () =>
      fromWire({
        connective: 'not',
        children: [
          { attr: 'a', op: '=' },
          { attr: 'b', op: '=' },
        ],
      }),
    /exactly one child/,
  );
});

test('fromWire rejects unknown operators', () => {
  const { fromWire } = M;
  assert.throws(() => fromWire({ attr: 'x', op: 'wobble' }), /unknown predicate operator/);
});

/* -------------------------------------------------------------------------- */
/* op-catalog keyed by value_type.                                             */
/* -------------------------------------------------------------------------- */

test('op-catalog: card_ref allows in + hasPhase, not contains', () => {
  const { opsForValueType } = M;
  const ops = opsForValueType('card_ref');
  assert.ok(ops.includes('in'));
  assert.ok(ops.includes('hasPhase'));
  assert.ok(!ops.includes('contains'));
});

test('op-catalog: card_ref[] is multi-only (in/notIn/hasPhase) — no eq', () => {
  const { opsForValueType } = M;
  const ops = opsForValueType('card_ref[]');
  assert.ok(ops.includes('in'));
  assert.ok(ops.includes('notIn'));
  assert.ok(ops.includes('hasPhase'));
  assert.ok(!ops.includes('eq'));
});

test('op-catalog: text allows contains; date allows beforeToday + withinDays', () => {
  const { opsForValueType } = M;
  assert.ok(opsForValueType('text').includes('contains'));
  assert.ok(!opsForValueType('text').includes('beforeToday'));
  const date = opsForValueType('date');
  assert.ok(date.includes('beforeToday'));
  assert.ok(date.includes('withinDays'));
});

test('op-catalog: unknown value_type falls back to the text op set', () => {
  const { opsForValueType, OPS_BY_VALUE_TYPE } = M;
  assert.deepEqual(opsForValueType('mystery'), OPS_BY_VALUE_TYPE.text);
});

test('opArity matches the value-count contract', () => {
  const { opArity } = M;
  assert.equal(opArity('exists'), 'none');
  assert.equal(opArity('notExists'), 'none');
  assert.equal(opArity('beforeToday'), 'none');
  assert.equal(opArity('eq'), 'single');
  assert.equal(opArity('contains'), 'single');
  assert.equal(opArity('withinDays'), 'single');
  assert.equal(opArity('in'), 'multi');
  assert.equal(opArity('notIn'), 'multi');
  assert.equal(opArity('hasPhase'), 'multi');
});

/* -------------------------------------------------------------------------- */
/* Flat-AND helpers (where[] backward-compat).                                 */
/* -------------------------------------------------------------------------- */

test('toWhereLeaves projects a flat AND of leaves to where[]; null otherwise', () => {
  const { andOf, orOf, leaf, toWhereLeaves } = M;
  const flat = andOf([leaf('status', 'eq', ['open']), leaf('priority', 'ne', ['low'])]);
  assert.deepEqual(toWhereLeaves(flat), [
    { attr: 'status', op: '=', values: ['open'] },
    { attr: 'priority', op: '!=', values: ['low'] },
  ]);
  // A single leaf qualifies.
  assert.deepEqual(toWhereLeaves(leaf('x', 'exists')), [{ attr: 'x', op: 'exists' }]);
  // An OR is not flat-AND-of-leaves.
  assert.equal(toWhereLeaves(orOf([leaf('a', 'eq', [1])])), null);
});

test('fromWhereLeaves seeds an AND group (or a bare leaf) from where[]', () => {
  const { fromWhereLeaves } = M;
  const one = fromWhereLeaves([{ attr: 'is_template', op: '!=', value: true }]);
  assert.deepEqual(one, { kind: 'leaf', attr: 'is_template', op: 'ne', values: [true] });
  const two = fromWhereLeaves([
    { attr: 'a', op: '=', value: 1 },
    { attr: 'b', op: 'in', values: [2, 3] },
  ]);
  assert.equal(two.kind, 'group');
  assert.equal(two.connective, 'and');
  assert.equal(two.children.length, 2);
});

/* -------------------------------------------------------------------------- */
/* Quick-chip top-level leaf helpers (the chips' merge into screen.predicate).  */
/* -------------------------------------------------------------------------- */

test('upsertTopLevelLeaf: appends a chip leaf to null → bare leaf', () => {
  const { upsertTopLevelLeaf, leaf } = M;
  const next = upsertTopLevelLeaf(null, leaf('status', 'in', ['40', '41']));
  assert.deepEqual(next, { kind: 'leaf', attr: 'status', op: 'in', values: ['40', '41'] });
});

test('upsertTopLevelLeaf: replaces the existing top-level leaf for the same attr', () => {
  const { upsertTopLevelLeaf, leaf } = M;
  const cur = leaf('status', 'in', ['40']);
  const next = upsertTopLevelLeaf(cur, leaf('status', 'in', ['40', '41']));
  // Still a single bare leaf (replaced, not duplicated).
  assert.deepEqual(next, { kind: 'leaf', attr: 'status', op: 'in', values: ['40', '41'] });
});

test('upsertTopLevelLeaf: composes a chip leaf AND alongside an existing leaf for another attr', () => {
  const { upsertTopLevelLeaf, leaf } = M;
  const cur = leaf('milestone_ref', 'in', ['32']); // an Advanced/other-chip leaf
  const next = upsertTopLevelLeaf(cur, leaf('status', 'in', ['40']));
  assert.equal(next.kind, 'group');
  assert.equal(next.connective, 'and');
  assert.deepEqual(next.children, [
    { kind: 'leaf', attr: 'milestone_ref', op: 'in', values: ['32'] },
    { kind: 'leaf', attr: 'status', op: 'in', values: ['40'] },
  ]);
});

test('upsertTopLevelLeaf: replaces only the matching child inside an AND group', () => {
  const { upsertTopLevelLeaf, andOf, leaf } = M;
  const cur = andOf([leaf('milestone_ref', 'in', ['32']), leaf('status', 'in', ['40'])]);
  const next = upsertTopLevelLeaf(cur, leaf('status', 'eq', ['41']));
  assert.deepEqual(next.children, [
    { kind: 'leaf', attr: 'milestone_ref', op: 'in', values: ['32'] },
    { kind: 'leaf', attr: 'status', op: 'eq', values: ['41'] },
  ]);
});

test('upsertTopLevelLeaf: a top-level OR is preserved — the chip leaf ANDs alongside the whole tree', () => {
  const { upsertTopLevelLeaf, orOf, leaf } = M;
  const cur = orOf([leaf('title', 'contains', ['a']), leaf('title', 'contains', ['b'])]);
  const next = upsertTopLevelLeaf(cur, leaf('status', 'in', ['40']));
  assert.equal(next.kind, 'group');
  assert.equal(next.connective, 'and');
  assert.equal(next.children.length, 2);
  assert.equal(next.children[0], cur, 'the OR subtree is left untouched as an AND child');
  assert.deepEqual(next.children[1], { kind: 'leaf', attr: 'status', op: 'in', values: ['40'] });
});

test('removeTopLevelLeaf: drops the chip leaf; collapses to null / a bare leaf', () => {
  const { removeTopLevelLeaf, upsertTopLevelLeaf, andOf, leaf } = M;
  // Sole leaf → null.
  assert.equal(removeTopLevelLeaf(leaf('status', 'in', ['40']), 'status'), null);
  // One of two → the surviving bare leaf.
  const two = andOf([leaf('milestone_ref', 'in', ['32']), leaf('status', 'in', ['40'])]);
  assert.deepEqual(removeTopLevelLeaf(two, 'status'), {
    kind: 'leaf',
    attr: 'milestone_ref',
    op: 'in',
    values: ['32'],
  });
  // Removing a missing attr is a no-op-shaped result (kept children).
  const kept = removeTopLevelLeaf(leaf('milestone_ref', 'in', ['32']), 'status');
  assert.deepEqual(kept, { kind: 'leaf', attr: 'milestone_ref', op: 'in', values: ['32'] });
  // Round-trip: upsert then remove returns to the original predicate shape.
  const base = leaf('milestone_ref', 'in', ['32']);
  const withChip = upsertTopLevelLeaf(base, leaf('status', 'in', ['40']));
  assert.deepEqual(removeTopLevelLeaf(withChip, 'status'), base);
});

test('topLevelLeafForAttr: finds a bare/AND-child leaf; ignores nested-group leaves', () => {
  const { topLevelLeafForAttr, andOf, orOf, leaf } = M;
  assert.deepEqual(topLevelLeafForAttr(leaf('status', 'in', ['40']), 'status'), {
    kind: 'leaf',
    attr: 'status',
    op: 'in',
    values: ['40'],
  });
  const grp = andOf([leaf('milestone_ref', 'in', ['32']), leaf('status', 'eq', ['41'])]);
  assert.equal(topLevelLeafForAttr(grp, 'status').op, 'eq');
  // A leaf buried in a nested OR is NOT a top-level leaf (Advanced's domain).
  const nested = andOf([orOf([leaf('status', 'eq', ['40'])])]);
  assert.equal(topLevelLeafForAttr(nested, 'status'), null);
  assert.equal(topLevelLeafForAttr(null, 'status'), null);
});

/* -------------------------------------------------------------------------- */
/* Attribute-schema model.                                                     */
/* -------------------------------------------------------------------------- */

test('schemaForCardType filters to bound defs + carries targetCardType for refs', () => {
  const { schemaForCardType } = M;
  const defs = [
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
    {
      id: '3',
      name: 'tags',
      value_type: 'card_ref[]',
      target_card_type_name: 'tag',
      is_built_in: true,
      bound_to: [{ card_type_id: '5', card_type_name: 'task', ordering: 3 }],
    },
    {
      // Bound to a different card type — excluded.
      id: '4',
      name: 'channel_status',
      value_type: 'text',
      is_built_in: true,
      bound_to: [{ card_type_id: '9', card_type_name: 'comm_channel', ordering: 1 }],
    },
  ];
  const schema = schemaForCardType(defs, 'task');
  assert.deepEqual(
    schema.map((s) => s.name),
    ['title', 'milestone_ref', 'tags'],
    'only task-bound defs, ordered by edge ordering',
  );
  const mref = schema.find((s) => s.name === 'milestone_ref');
  assert.equal(mref.valueType, 'card_ref');
  assert.equal(mref.targetCardType, 'milestone');
  assert.equal(mref.label, 'Milestone', 'friendly label strips _ref + title-cases');
  const tags = schema.find((s) => s.name === 'tags');
  assert.equal(tags.valueType, 'card_ref[]');
  assert.equal(tags.targetCardType, 'tag');
});

test('resolveSchema passes a literal list through unchanged', () => {
  const { resolveSchema } = M;
  const lit = [{ name: 'a', label: 'A', valueType: 'text' }];
  assert.equal(resolveSchema(lit, []), lit);
});
