import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
before(async () => {
  // The app barrel now (via TaskDetail) transitively imports the markdown sink,
  // whose DOMPurify hook registers at import-eval and needs a window/document.
  // The light shim satisfies that init guard (no markdown is rendered here).
  installDomShim();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
});

/** Build a CardWithAttrs fixture in the web model shape. */
function card(id, attrs) {
  return { id, card_type_id: 5n, card_type_name: 'task', attributes: attrs };
}

/* -------------------------------------------------------------------------- */
/* bucketByColumn.                                                             */
/* -------------------------------------------------------------------------- */

test('bucketByColumn: groups by axis value; unset lands in UNSET_KEY', () => {
  const { bucketByColumn, UNSET_KEY } = M;
  const cards = [
    card(1n, { milestone_ref: 32n }),
    card(2n, { milestone_ref: 32n }),
    card(3n, { milestone_ref: 33n }),
    card(4n, {}), // unset
  ];
  const b = bucketByColumn(cards, 'milestone_ref');
  assert.deepEqual(
    b['32'].map((c) => c.id),
    [1n, 2n],
  );
  assert.deepEqual(
    b['33'].map((c) => c.id),
    [3n],
  );
  assert.deepEqual(
    b[UNSET_KEY].map((c) => c.id),
    [4n],
  );
});

test('bucketKeyOf: 42n / 42 / "42" all key to "42" (boot-order-safe)', () => {
  const { bucketKeyOf, UNSET_KEY } = M;
  assert.equal(bucketKeyOf(42n), '42');
  assert.equal(bucketKeyOf(42), '42');
  assert.equal(bucketKeyOf('42'), '42');
  assert.equal(bucketKeyOf(null), UNSET_KEY);
  assert.equal(bucketKeyOf(undefined), UNSET_KEY);
  assert.equal(bucketKeyOf(''), UNSET_KEY);
});

test('asAttrId: coerces bigint / int / digit-string to bigint; rejects malformed', () => {
  // The dispatcher's id-revival is hand-keyed by attribute name, so any
  // un-primed card_ref attr (e.g. originator) arrives as a digit-string. The
  // Grid / Inbox / TaskDetail consumers must all coerce the same way so a new
  // card_ref attr works without a one-off registration.
  const { asAttrId } = M;
  assert.equal(asAttrId(42n), 42n, 'bigint passes through');
  assert.equal(asAttrId(42), 42n, 'int → bigint');
  assert.equal(asAttrId('42'), 42n, 'digit-string → bigint (the originator wire form)');
  assert.equal(asAttrId(null), null);
  assert.equal(asAttrId(undefined), null);
  assert.equal(asAttrId(''), null);
  assert.equal(asAttrId('foo'), null);
  assert.equal(asAttrId(-1), null, 'non-positive rejected');
  assert.equal(asAttrId(0), null);
  assert.equal(asAttrId(1.5), null, 'non-integer rejected');
});

/* -------------------------------------------------------------------------- */
/* columnOrder.                                                                */
/* -------------------------------------------------------------------------- */

test('columnOrder: value-card ids first, extra seen keys, trailing UNSET', () => {
  const { columnOrder, UNSET_KEY } = M;
  const order = columnOrder([32n, 33n, 34n], ['33', '99', UNSET_KEY]);
  // value-card ids in given order, then the extra key 99, then unset last.
  assert.deepEqual(order, ['32', '33', '34', '99', UNSET_KEY]);
});

test('columnOrder: empty project still shows every known column + unset', () => {
  const { columnOrder, UNSET_KEY } = M;
  assert.deepEqual(columnOrder([32n, 33n], []), ['32', '33', UNSET_KEY]);
});

/* -------------------------------------------------------------------------- */
/* planSortRewrite + computeMoveBatch.                                         */
/* -------------------------------------------------------------------------- */

test('planSortRewrite: rewrites destination cell to canonical spacing, omits unchanged', () => {
  const { planSortRewrite, SORT_ORDER_STEP } = M;
  const dest = [card(1n, { sort_order: 100 }), card(2n, { sort_order: 200 })];
  const moved = card(3n, { sort_order: 999 });
  // Drop at the top (slot 0): order becomes [3,1,2] → desired 100/200/300.
  const updates = planSortRewrite(dest, moved, 0);
  // card 3 -> 100 (changed), card 1 -> 200 (changed), card 2 -> 300 (changed)
  assert.deepEqual(updates, [
    { cardId: 3n, sortOrder: 1 * SORT_ORDER_STEP },
    { cardId: 1n, sortOrder: 2 * SORT_ORDER_STEP },
    { cardId: 2n, sortOrder: 3 * SORT_ORDER_STEP },
  ]);
});

test('planSortRewrite: drop at bottom keeps already-canonical cards untouched', () => {
  const { planSortRewrite } = M;
  const dest = [card(1n, { sort_order: 100 })];
  const moved = card(2n, { sort_order: 999 });
  // order [1,2] → desired 100/200. card1 already 100 (omitted); card2 -> 200.
  const updates = planSortRewrite(dest, moved, 1);
  assert.deepEqual(updates, [{ cardId: 2n, sortOrder: 200 }]);
});

test('computeMoveBatch: emits sort ops + a column change when key differs', () => {
  const { computeMoveBatch } = M;
  const moved = card(3n, { milestone_ref: 32n, sort_order: 999 });
  const ops = computeMoveBatch(
    moved,
    33n, // target column = milestone 33
    [{ cardId: 3n, sortOrder: 100 }],
    'milestone_ref',
  );
  assert.deepEqual(ops, [
    { cardId: 3n, attributeName: 'sort_order', value: 100 },
    { cardId: 3n, attributeName: 'milestone_ref', value: 33n },
  ]);
});

test('computeMoveBatch: same-column drop emits NO column change (only sorts)', () => {
  const { computeMoveBatch } = M;
  const moved = card(3n, { milestone_ref: 32n });
  const ops = computeMoveBatch(moved, 32n, [{ cardId: 3n, sortOrder: 100 }], 'milestone_ref');
  assert.deepEqual(ops, [{ cardId: 3n, attributeName: 'sort_order', value: 100 }]);
});

test('computeMoveBatch: move to UNSET column clears the attribute (null value)', () => {
  const { computeMoveBatch } = M;
  const moved = card(3n, { milestone_ref: 32n });
  const ops = computeMoveBatch(moved, null, [], 'milestone_ref');
  assert.deepEqual(ops, [{ cardId: 3n, attributeName: 'milestone_ref', value: null }]);
});

/* -------------------------------------------------------------------------- */
/* sortByOrder.                                                                */
/* -------------------------------------------------------------------------- */

test('sortByOrder: ASC by sort_order, id tie-break, nulls last', () => {
  const { sortByOrder } = M;
  const cards = [
    card(5n, {}), // null sort -> last
    card(2n, { sort_order: 200 }),
    card(1n, { sort_order: 100 }),
    card(3n, { sort_order: 200 }), // tie with id 2 -> id order
  ];
  const sorted = sortByOrder([...cards]).map((c) => c.id);
  assert.deepEqual(sorted, [1n, 2n, 3n, 5n]);
});
