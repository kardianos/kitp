import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';

let M;

before(async () => {
  const outdir = await buildTestBundles();
  // The pure predicate model lives in the app barrel (no DOM needed here).
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
