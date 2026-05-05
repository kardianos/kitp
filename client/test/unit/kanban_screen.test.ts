/**
 * Unit coverage for the KanbanScreen pure helpers.
 *
 * Vitest runs node-only (no jsdom), so the .svelte component is not
 * mounted here — we exercise the extracted helpers in
 * `src/screens/kanban_helpers.ts`. Real-DOM coverage of the screen
 * itself lands with the e2e journey suite (task #6 of the migration
 * plan, kanban_drag.ts).
 *
 * Coverage targets per task #15:
 *   1. `groupCardsByColumn` — buckets by attribute value; nulls go to ''.
 *   2. `groupCardsByLane`   — same shape, on a different attribute.
 *   3. `computeNewSortOrder` — empty / top / bottom / between / nulls.
 *   4. `computeMoveBatch`   — 1 / 2 / 3 op count and payload shape.
 *   5. `nextColumnIndex`    — clamps to [0, columnsLen-1].
 */

import { describe, expect, it } from 'vitest';

import type { CardWithAttrs } from '../../src/reg/types.js';
import {
  computeMoveBatch,
  computeNewSortOrder,
  groupCardsByColumn,
  groupCardsByLane,
  nextColumnIndex,
  SORT_ORDER_STEP,
  sortByOrder,
  type UpdateOp,
} from '../../src/screens/kanban_helpers.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function task(
  id: number,
  attrs: Record<string, unknown> = {},
): CardWithAttrs {
  return {
    id,
    card_type_id: 2,
    card_type_name: 'task',
    attributes: { ...attrs },
  };
}

/* -------------------------------------------------------------------------- */
/* groupCardsByColumn                                                         */
/* -------------------------------------------------------------------------- */

describe('groupCardsByColumn', () => {
  it('buckets by string-valued attribute', () => {
    const cards = [
      task(1, { status: 'todo' }),
      task(2, { status: 'doing' }),
      task(3, { status: 'todo' }),
      task(4, { status: 'done' }),
    ];
    const out = groupCardsByColumn(cards, 'status');
    expect(Object.keys(out).sort()).toEqual(['doing', 'done', 'todo']);
    expect(out['todo']?.map((c) => c.id)).toEqual([1, 3]);
    expect(out['doing']?.map((c) => c.id)).toEqual([2]);
    expect(out['done']?.map((c) => c.id)).toEqual([4]);
  });

  it('buckets nulls / undefined into the empty-string bucket', () => {
    const cards = [
      task(1, { status: 'todo' }),
      task(2, { status: null }),
      task(3, {}), // status missing entirely
      task(4, { status: 'todo' }),
    ];
    const out = groupCardsByColumn(cards, 'status');
    expect(out['todo']?.map((c) => c.id)).toEqual([1, 4]);
    expect(out['']?.map((c) => c.id)).toEqual([2, 3]);
  });

  it('stringifies numeric / boolean attribute values', () => {
    const cards = [
      task(1, { assignee: 7 }),
      task(2, { assignee: 7 }),
      task(3, { assignee: 9 }),
    ];
    const out = groupCardsByColumn(cards, 'assignee');
    expect(out['7']?.map((c) => c.id)).toEqual([1, 2]);
    expect(out['9']?.map((c) => c.id)).toEqual([3]);
  });

  it('returns an empty record for an empty input list', () => {
    expect(groupCardsByColumn([], 'status')).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* groupCardsByLane                                                           */
/* -------------------------------------------------------------------------- */

describe('groupCardsByLane', () => {
  it('buckets the lane axis the same way as the column axis', () => {
    const cards = [
      task(1, { assignee: 7, status: 'todo' }),
      task(2, { assignee: 9, status: 'doing' }),
      task(3, { assignee: 7, status: 'doing' }),
    ];
    const out = groupCardsByLane(cards, 'assignee');
    expect(out['7']?.map((c) => c.id)).toEqual([1, 3]);
    expect(out['9']?.map((c) => c.id)).toEqual([2]);
  });

  it('puts cards with no lane attribute into the empty-string bucket', () => {
    const cards = [task(1, {}), task(2, { assignee: 7 })];
    const out = groupCardsByLane(cards, 'assignee');
    expect(out['']?.map((c) => c.id)).toEqual([1]);
    expect(out['7']?.map((c) => c.id)).toEqual([2]);
  });
});

/* -------------------------------------------------------------------------- */
/* computeNewSortOrder                                                        */
/* -------------------------------------------------------------------------- */

describe('computeNewSortOrder', () => {
  it('returns 0 for an empty stack', () => {
    expect(computeNewSortOrder([], 0)).toBe(0);
    expect(computeNewSortOrder([], 5)).toBe(0);
  });

  it('top of stack: first.sort_order - STEP', () => {
    const stack = [
      task(1, { sort_order: 200 }),
      task(2, { sort_order: 300 }),
    ];
    expect(computeNewSortOrder(stack, 0)).toBe(100);
    // Negative slotIndex behaves like top-of-stack.
    expect(computeNewSortOrder(stack, -1)).toBe(100);
  });

  it('bottom of stack: last.sort_order + STEP', () => {
    const stack = [
      task(1, { sort_order: 100 }),
      task(2, { sort_order: 200 }),
    ];
    expect(computeNewSortOrder(stack, 2)).toBe(300);
    // Past the end behaves like bottom-of-stack.
    expect(computeNewSortOrder(stack, 99)).toBe(300);
  });

  it('between two cards: arithmetic mean', () => {
    const stack = [
      task(1, { sort_order: 100 }),
      task(2, { sort_order: 200 }),
      task(3, { sort_order: 300 }),
    ];
    expect(computeNewSortOrder(stack, 1)).toBe(150);
    expect(computeNewSortOrder(stack, 2)).toBe(250);
  });

  it('between with nullish prev: next - STEP', () => {
    const stack = [
      task(1, {}), // no sort_order
      task(2, { sort_order: 200 }),
    ];
    expect(computeNewSortOrder(stack, 1)).toBe(100);
  });

  it('between with nullish next: prev + STEP', () => {
    const stack = [
      task(1, { sort_order: 100 }),
      task(2, {}), // no sort_order
    ];
    expect(computeNewSortOrder(stack, 1)).toBe(200);
  });

  it('between two nullish cards: slotIndex * STEP fallback', () => {
    const stack = [task(1, {}), task(2, {}), task(3, {})];
    expect(computeNewSortOrder(stack, 1)).toBe(SORT_ORDER_STEP);
    expect(computeNewSortOrder(stack, 2)).toBe(2 * SORT_ORDER_STEP);
  });

  it('top of an all-nullish stack: 0 ((STEP ?? STEP) - STEP)', () => {
    // (first.sort_order ?? STEP) - STEP === 0 when sort_order is missing.
    const stack = [task(1, {}), task(2, {})];
    expect(computeNewSortOrder(stack, 0)).toBe(0);
  });

  it('bottom of an all-nullish stack: +STEP (last ?? 0) + STEP', () => {
    const stack = [task(1, {}), task(2, {})];
    expect(computeNewSortOrder(stack, 2)).toBe(SORT_ORDER_STEP);
  });
});

/* -------------------------------------------------------------------------- */
/* computeMoveBatch                                                           */
/* -------------------------------------------------------------------------- */

describe('computeMoveBatch', () => {
  it('changing only sort returns ONE op (sort_order)', () => {
    const card = task(42, { status: 'doing', sort_order: 100 });
    const ops: UpdateOp[] = computeMoveBatch(
      card,
      'doing', // same column value
      null, // no lane axis
      150, // new sort
      'status',
      null, // lane disabled
    );
    expect(ops).toEqual([
      { cardId: 42, attributeName: 'sort_order', value: 150 },
    ]);
  });

  it('changing column + sort returns TWO ops', () => {
    const card = task(42, { status: 'doing', sort_order: 100 });
    const ops = computeMoveBatch(card, 'review', null, 150, 'status', null);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({
      cardId: 42,
      attributeName: 'sort_order',
      value: 150,
    });
    expect(ops[1]).toEqual({
      cardId: 42,
      attributeName: 'status',
      value: 'review',
    });
  });

  it('changing column + lane + sort returns THREE ops', () => {
    const card = task(42, {
      status: 'doing',
      assignee: 7,
      sort_order: 100,
    });
    const ops = computeMoveBatch(
      card,
      'review',
      9,
      150,
      'status',
      'assignee',
    );
    expect(ops).toHaveLength(3);
    expect(ops.map((o) => o.attributeName)).toEqual([
      'sort_order',
      'status',
      'assignee',
    ]);
    expect(ops[1]).toEqual({
      cardId: 42,
      attributeName: 'status',
      value: 'review',
    });
    expect(ops[2]).toEqual({
      cardId: 42,
      attributeName: 'assignee',
      value: 9,
    });
  });

  it('omits column op when the column value did not change', () => {
    const card = task(42, { status: 'doing', sort_order: 100 });
    const ops = computeMoveBatch(card, 'doing', null, 200, 'status', null);
    expect(ops.map((o) => o.attributeName)).toEqual(['sort_order']);
  });

  it('omits lane op when the lane axis is null even if value differs', () => {
    const card = task(42, { status: 'doing', assignee: 7, sort_order: 100 });
    // laneAttrName=null disables the lane axis entirely.
    const ops = computeMoveBatch(card, 'review', 9, 150, 'status', null);
    expect(ops).toHaveLength(2);
    expect(ops.map((o) => o.attributeName)).toEqual(['sort_order', 'status']);
  });

  it('omits lane op when the lane value did not change', () => {
    const card = task(42, {
      status: 'doing',
      assignee: 7,
      sort_order: 100,
    });
    const ops = computeMoveBatch(card, 'review', 7, 150, 'status', 'assignee');
    expect(ops).toHaveLength(2);
    expect(ops.map((o) => o.attributeName)).toEqual(['sort_order', 'status']);
  });

  it('omits sort op when the existing sort_order already equals the target', () => {
    const card = task(42, { status: 'doing', sort_order: 200 });
    // Drop computed exactly the same value (same slot, no neighbours moved).
    const ops = computeMoveBatch(card, 'review', null, 200, 'status', null);
    expect(ops.map((o) => o.attributeName)).toEqual(['status']);
  });

  it('emits a clear-attribute write when the target column is null', () => {
    const card = task(42, { status: 'doing', sort_order: 100 });
    const ops = computeMoveBatch(card, null, null, 150, 'status', null);
    expect(ops).toHaveLength(2);
    expect(ops[1]).toEqual({
      cardId: 42,
      attributeName: 'status',
      value: null,
    });
  });

  it('does not emit a column op when both current and target are unset', () => {
    // Card has no `status` attr; target value is null. Both bucket to ''.
    const card = task(42, { sort_order: 100 });
    const ops = computeMoveBatch(card, null, null, 150, 'status', null);
    expect(ops.map((o) => o.attributeName)).toEqual(['sort_order']);
  });
});

/* -------------------------------------------------------------------------- */
/* nextColumnIndex                                                            */
/* -------------------------------------------------------------------------- */

describe('nextColumnIndex', () => {
  it('clamps to lower bound (0)', () => {
    expect(nextColumnIndex(0, 4, -1)).toBe(0);
    expect(nextColumnIndex(2, 4, -10)).toBe(0);
  });

  it('clamps to upper bound (columnsLen - 1)', () => {
    expect(nextColumnIndex(3, 4, +1)).toBe(3);
    expect(nextColumnIndex(0, 4, +99)).toBe(3);
  });

  it('moves by direction within bounds', () => {
    expect(nextColumnIndex(0, 4, +1)).toBe(1);
    expect(nextColumnIndex(2, 4, -1)).toBe(1);
    expect(nextColumnIndex(1, 4, +2)).toBe(3);
  });

  it('returns 0 for an empty / single-column board', () => {
    expect(nextColumnIndex(0, 0, +1)).toBe(0);
    expect(nextColumnIndex(0, 1, +1)).toBe(0);
    expect(nextColumnIndex(0, 1, -1)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* sortByOrder (auxiliary, but exercised by the screen)                       */
/* -------------------------------------------------------------------------- */

describe('sortByOrder', () => {
  it('orders by sort_order ASC with id tie-breaker, nulls last', () => {
    const out = sortByOrder([
      task(3, { sort_order: 200 }),
      task(1, {}),
      task(2, { sort_order: 100 }),
      task(4, {}),
      task(5, { sort_order: 200 }),
    ]);
    expect(out.map((c) => c.id)).toEqual([2, 3, 5, 1, 4]);
  });
});
