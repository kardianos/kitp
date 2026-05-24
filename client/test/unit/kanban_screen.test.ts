/**
 * Unit coverage for the KanbanScreen pure helpers.
 *
 * Vitest runs node-only (no jsdom), so the .svelte component is not
 * mounted here — we exercise the extracted helpers in
 * `src/screens/kanban_helpers.ts`. Real-DOM coverage of the screen
 * itself lands with the e2e journey suite.
 *
 * Coverage targets:
 *   1. `groupCardsByColumn` — buckets by attribute value; nulls go to ''.
 *   2. `groupCardsByLane`   — same shape, on a different attribute.
 *   3. `planSortRewrite`    — rewrites the destination cell's sort_orders.
 *   4. `computeMoveBatch`   — combines sort + column + lane ops.
 *   5. `nextColumnIndex`    — clamps to [0, columnsLen-1].
 */

import { describe, expect, it } from 'vitest';

import type { CardWithAttrs } from '../../src/reg/types.js';
import {
  computeMoveBatch,
  groupCardsByColumn,
  groupCardsByLane,
  nextColumnIndex,
  planSortRewrite,
  SORT_ORDER_STEP,
  sortByOrder,
  type SortUpdate,
  type UpdateOp,
} from '../../src/screens/kanban_helpers.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function task(
  id: bigint,
  attrs: Record<string, unknown> = {},
): CardWithAttrs {
  return {
    id,
    card_type_id: 2n,
    card_type_name: 'task',
    phase: 'active',
    attributes: { ...attrs },
  };
}

/* -------------------------------------------------------------------------- */
/* groupCardsByColumn                                                         */
/* -------------------------------------------------------------------------- */

describe('groupCardsByColumn', () => {
  it('buckets by string-valued attribute', () => {
    const cards = [
      task(1n, { status: 'todo' }),
      task(2n, { status: 'doing' }),
      task(3n, { status: 'todo' }),
      task(4n, { status: 'done' }),
    ];
    const out = groupCardsByColumn(cards, 'status');
    expect(Object.keys(out).sort()).toEqual(['doing', 'done', 'todo']);
    expect(out['todo']?.map((c) => c.id)).toEqual([1n, 3n]);
    expect(out['doing']?.map((c) => c.id)).toEqual([2n]);
    expect(out['done']?.map((c) => c.id)).toEqual([4n]);
  });

  it('buckets nulls / undefined into the empty-string bucket', () => {
    const cards = [
      task(1n, { status: 'todo' }),
      task(2n, { status: null }),
      task(3n, {}), // status missing entirely
      task(4n, { status: 'todo' }),
    ];
    const out = groupCardsByColumn(cards, 'status');
    expect(out['todo']?.map((c) => c.id)).toEqual([1n, 4n]);
    expect(out['']?.map((c) => c.id)).toEqual([2n, 3n]);
  });

  it('stringifies numeric / boolean attribute values', () => {
    const cards = [
      task(1n, { assignee: 7 }),
      task(2n, { assignee: 7 }),
      task(3n, { assignee: 9 }),
    ];
    const out = groupCardsByColumn(cards, 'assignee');
    expect(out['7']?.map((c) => c.id)).toEqual([1n, 2n]);
    expect(out['9']?.map((c) => c.id)).toEqual([3n]);
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
      task(1n, { assignee: 7n, status: 'todo' }),
      task(2n, { assignee: 9n, status: 'doing' }),
      task(3n, { assignee: 7n, status: 'doing' }),
    ];
    const out = groupCardsByLane(cards, 'assignee');
    expect(out['7']?.map((c) => c.id)).toEqual([1n, 3n]);
    expect(out['9']?.map((c) => c.id)).toEqual([2n]);
  });

  it('puts cards with no lane attribute into the empty-string bucket', () => {
    const cards = [task(1n, {}), task(2n, { assignee: 7 })];
    const out = groupCardsByLane(cards, 'assignee');
    expect(out['']?.map((c) => c.id)).toEqual([1n]);
    expect(out['7']?.map((c) => c.id)).toEqual([2n]);
  });
});

/* -------------------------------------------------------------------------- */
/* planSortRewrite                                                            */
/* -------------------------------------------------------------------------- */

describe('planSortRewrite', () => {
  const STEP = SORT_ORDER_STEP;

  it('drops the moved card into an empty cell with sort_order = STEP', () => {
    const moved = task(42n, {});
    expect(planSortRewrite([], moved, 0)).toEqual([
      { cardId: 42n, sortOrder: STEP },
    ]);
  });

  it('renumbers every card whose existing sort_order does not match its slot', () => {
    // destStack already canonical: 100, 200, 300. Insert moved at top.
    const moved = task(42n, {});
    const destStack = [
      task(1n, { sort_order: STEP }),
      task(2n, { sort_order: 2 * STEP }),
      task(3n, { sort_order: 3 * STEP }),
    ];
    // Final order: [42, 1, 2, 3] → slots 100, 200, 300, 400.
    // Only 42 (new) and 1 (was 100, now 200) and 2 (was 200, now 300)
    // and 3 (was 300, now 400) change — all four need a rewrite.
    expect(planSortRewrite(destStack, moved, 0)).toEqual([
      { cardId: 42n, sortOrder: STEP },
      { cardId: 1n, sortOrder: 2 * STEP },
      { cardId: 2n, sortOrder: 3 * STEP },
      { cardId: 3n, sortOrder: 4 * STEP },
    ]);
  });

  it('emits ONE op (just the moved card) when appending to a canonical cell', () => {
    const moved = task(42n, {});
    const destStack = [
      task(1n, { sort_order: STEP }),
      task(2n, { sort_order: 2 * STEP }),
    ];
    // Final order: [1, 2, 42] → slots 100, 200, 300.
    // Only 42 needs a write; 1 and 2 already match.
    expect(planSortRewrite(destStack, moved, destStack.length)).toEqual([
      { cardId: 42n, sortOrder: 3 * STEP },
    ]);
  });

  it('emits TWO ops for a simple middle swap in a canonical cell', () => {
    // Move card 1 from position 0 to between 2 and 3.
    // destStack (without moved): [2, 3] at 200, 300.
    // Insert moved (id=1) at slot 1 → final [2, 1, 3] → slots 100, 200, 300.
    // 2: was 200 now 100 → write. 1: gets 200 → write. 3: was 300 stays 300.
    const moved = task(1n, { sort_order: STEP });
    const destStack = [
      task(2n, { sort_order: 2 * STEP }),
      task(3n, { sort_order: 3 * STEP }),
    ];
    expect(planSortRewrite(destStack, moved, 1)).toEqual([
      { cardId: 2n, sortOrder: STEP },
      { cardId: 1n, sortOrder: 2 * STEP },
    ]);
  });

  it('rewrites every card in an all-NULL cell (regression: NULL siblings)', () => {
    // The bug the inbox's planReorder doc comment calls out: halfway
    // math produced a numeric value while siblings stayed NULL, and
    // ASC NULLS LAST sorted the moved card before the unranked rest.
    // Rewriting every slot fixes it.
    const moved = task(42n, {});
    const destStack = [task(1n, {}), task(2n, {})];
    // Final order: [1, 42, 2] → slots 100, 200, 300.
    expect(planSortRewrite(destStack, moved, 1)).toEqual([
      { cardId: 1n, sortOrder: STEP },
      { cardId: 42n, sortOrder: 2 * STEP },
      { cardId: 2n, sortOrder: 3 * STEP },
    ]);
  });

  it('clamps an out-of-range slot to the tail', () => {
    const moved = task(42n, {});
    const destStack = [task(1n, { sort_order: STEP })];
    expect(planSortRewrite(destStack, moved, 999)).toEqual([
      { cardId: 42n, sortOrder: 2 * STEP },
    ]);
  });

  it('clamps a negative slot to the head', () => {
    const moved = task(42n, {});
    const destStack = [task(1n, { sort_order: 2 * STEP })];
    // Final: [42, 1] → slots 100, 200. 42 new, 1 already matches.
    expect(planSortRewrite(destStack, moved, -3)).toEqual([
      { cardId: 42n, sortOrder: STEP },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* computeMoveBatch                                                           */
/* -------------------------------------------------------------------------- */

describe('computeMoveBatch', () => {
  /** Convenience: a single SortUpdate for [card], sortOrder = [v]. */
  function sortFor(cardId: bigint, v: number): SortUpdate[] {
    return [{ cardId, sortOrder: v }];
  }

  it('changing only sort returns ONE op (sort_order)', () => {
    const card = task(42n, { status: 'doing', sort_order: 100 });
    const ops: UpdateOp[] = computeMoveBatch(
      card,
      'doing', // same column value
      null, // no lane axis
      sortFor(42n, 150),
      'status',
      null, // lane disabled
    );
    expect(ops).toEqual([
      { cardId: 42n, attributeName: 'sort_order', value: 150 },
    ]);
  });

  it('changing column + sort returns TWO ops', () => {
    const card = task(42n, { status: 'doing', sort_order: 100 });
    const ops = computeMoveBatch(
      card,
      'review',
      null,
      sortFor(42n, 150),
      'status',
      null,
    );
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({
      cardId: 42n,
      attributeName: 'sort_order',
      value: 150,
    });
    expect(ops[1]).toEqual({
      cardId: 42n,
      attributeName: 'status',
      value: 'review',
    });
  });

  it('changing column + lane + sort returns THREE ops', () => {
    const card = task(42n, {
      status: 'doing',
      assignee: 7n,
      sort_order: 100,
    });
    const ops = computeMoveBatch(
      card,
      'review',
      9,
      sortFor(42n, 150),
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
      cardId: 42n,
      attributeName: 'status',
      value: 'review',
    });
    expect(ops[2]).toEqual({
      cardId: 42n,
      attributeName: 'assignee',
      value: 9,
    });
  });

  it('fans the sortUpdates array out into one op per entry', () => {
    // Multi-card rewrite case — the moved card and one renumbered neighbour.
    const card = task(42n, { status: 'doing', sort_order: 100 });
    const ops = computeMoveBatch(
      card,
      'doing',
      null,
      [
        { cardId: 42n, sortOrder: 200 },
        { cardId: 7n, sortOrder: 300 },
      ],
      'status',
      null,
    );
    expect(ops).toEqual([
      { cardId: 42n, attributeName: 'sort_order', value: 200 },
      { cardId: 7n, attributeName: 'sort_order', value: 300 },
    ]);
  });

  it('omits column op when the column value did not change', () => {
    const card = task(42n, { status: 'doing', sort_order: 100 });
    const ops = computeMoveBatch(
      card,
      'doing',
      null,
      sortFor(42n, 200),
      'status',
      null,
    );
    expect(ops.map((o) => o.attributeName)).toEqual(['sort_order']);
  });

  it('omits lane op when the lane axis is null even if value differs', () => {
    const card = task(42n, { status: 'doing', assignee: 7n, sort_order: 100 });
    const ops = computeMoveBatch(
      card,
      'review',
      9,
      sortFor(42n, 150),
      'status',
      null,
    );
    expect(ops).toHaveLength(2);
    expect(ops.map((o) => o.attributeName)).toEqual(['sort_order', 'status']);
  });

  it('omits lane op when the lane value did not change', () => {
    const card = task(42n, {
      status: 'doing',
      assignee: 7n,
      sort_order: 100,
    });
    const ops = computeMoveBatch(
      card,
      'review',
      7,
      sortFor(42n, 150),
      'status',
      'assignee',
    );
    expect(ops).toHaveLength(2);
    expect(ops.map((o) => o.attributeName)).toEqual(['sort_order', 'status']);
  });

  it('emits zero sort ops when the rewrite plan is empty (column-only move)', () => {
    // The destination cell was already canonical and the moved card kept
    // its slot — planSortRewrite returns []. Only the column change lands.
    const card = task(42n, { status: 'doing', sort_order: 200 });
    const ops = computeMoveBatch(card, 'review', null, [], 'status', null);
    expect(ops.map((o) => o.attributeName)).toEqual(['status']);
  });

  it('emits a clear-attribute write when the target column is null', () => {
    const card = task(42n, { status: 'doing', sort_order: 100 });
    const ops = computeMoveBatch(
      card,
      null,
      null,
      sortFor(42n, 150),
      'status',
      null,
    );
    expect(ops).toHaveLength(2);
    expect(ops[1]).toEqual({
      cardId: 42n,
      attributeName: 'status',
      value: null,
    });
  });

  it('does not emit a column op when both current and target are unset', () => {
    // Card has no `status` attr; target value is null. Both bucket to ''.
    const card = task(42n, { sort_order: 100 });
    const ops = computeMoveBatch(
      card,
      null,
      null,
      sortFor(42n, 150),
      'status',
      null,
    );
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
      task(3n, { sort_order: 200 }),
      task(1n, {}),
      task(2n, { sort_order: 100 }),
      task(4n, {}),
      task(5n, { sort_order: 200 }),
    ]);
    expect(out.map((c) => c.id)).toEqual([2n, 3n, 5n, 1n, 4n]);
  });
});
