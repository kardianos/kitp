/**
 * Unit coverage for the InboxScreen helpers.
 *
 * Vitest runs in node-only mode here (no jsdom), so the .svelte component
 * itself is exercised by a compile-smoke import. The bulk of the coverage
 * lives on the extracted helpers in `src/screens/inbox_helpers.ts`:
 *   - computeNewSortOrder(rows, dropIndex)
 *   - move(visibleLen, current, delta)
 *   - planReorder(rows, movedID, insertAt)
 */

import { describe, expect, it } from 'vitest';

import type { CardWithAttrs } from '../../src/reg/types.js';
import {
  computeNewSortOrder,
  move,
  planReorder,
  SORT_ORDER_STEP,
} from '../../src/screens/inbox_helpers.js';

/* -------------------------------------------------------------------------- */
/* fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function row(id: bigint, sort: number | undefined): CardWithAttrs {
  const r: CardWithAttrs = {
    id,
    card_type_id: 1n,
    card_type_name: 'task',
    attributes: { title: `Task ${id}` },
  };
  if (sort !== undefined) r.personal_sort_order = sort;
  return r;
}

/* -------------------------------------------------------------------------- */
/* computeNewSortOrder                                                        */
/* -------------------------------------------------------------------------- */

describe('computeNewSortOrder', () => {
  it('returns 0 for an empty list', () => {
    expect(computeNewSortOrder([], 0)).toBe(0);
    expect(computeNewSortOrder([], 5)).toBe(0);
  });

  it('top: returns first - STEP when first has a personal sort', () => {
    const rs = [row(1n, 200), row(2n, 300)];
    expect(computeNewSortOrder(rs, 0)).toBe(100);
  });

  it('top: returns STEP - STEP when first has no personal sort', () => {
    const rs = [row(1n, undefined), row(2n, undefined)];
    // (first ?? STEP) - STEP === 0
    expect(computeNewSortOrder(rs, 0)).toBe(0);
  });

  it('top: negative dropIndex still resolves to top slot', () => {
    const rs = [row(1n, 200)];
    expect(computeNewSortOrder(rs, -1)).toBe(100);
  });

  it('bottom: returns last + STEP when last has a personal sort', () => {
    const rs = [row(1n, 200), row(2n, 350)];
    expect(computeNewSortOrder(rs, 2)).toBe(450);
  });

  it('bottom: returns 0 + STEP when last is nullish', () => {
    const rs = [row(1n, 200), row(2n, undefined)];
    // (last ?? 0) + STEP === 100
    expect(computeNewSortOrder(rs, 2)).toBe(SORT_ORDER_STEP);
  });

  it('bottom: dropIndex past the end snaps to the bottom slot', () => {
    const rs = [row(1n, 200)];
    expect(computeNewSortOrder(rs, 99)).toBe(300);
  });

  it('between A and B: returns midpoint when both have personal sort', () => {
    const rs = [row(1n, 100), row(2n, 300)];
    expect(computeNewSortOrder(rs, 1)).toBe(200);
  });

  it('between with A nullish: returns b - STEP', () => {
    const rs = [row(1n, undefined), row(2n, 500)];
    expect(computeNewSortOrder(rs, 1)).toBe(400);
  });

  it('between with B nullish: returns a + STEP', () => {
    const rs = [row(1n, 100), row(2n, undefined)];
    expect(computeNewSortOrder(rs, 1)).toBe(200);
  });

  it('between both nullish: returns dropIndex * STEP (stable fallback)', () => {
    const rs = [row(1n, undefined), row(2n, undefined), row(3n, undefined)];
    expect(computeNewSortOrder(rs, 1)).toBe(100);
    expect(computeNewSortOrder(rs, 2)).toBe(200);
  });

  it('matches the Dart `_newSortOrderAt` for a typical 3-row reorder', () => {
    // Drop card C (currently at index 2) into slot 1 (between A and B).
    const rs = [row(1n, 100), row(2n, 200)];
    // Between A (100) and B (200): midpoint 150.
    expect(computeNewSortOrder(rs, 1)).toBe(150);
  });
});

/* -------------------------------------------------------------------------- */
/* move                                                                       */
/* -------------------------------------------------------------------------- */

describe('move', () => {
  it('clamps to 0 when delta would push below 0', () => {
    expect(move(5, 0, -1)).toBe(0);
    expect(move(5, 2, -10)).toBe(0);
  });

  it('clamps to visibleLen - 1 when delta would push past the end', () => {
    expect(move(5, 4, 1)).toBe(4);
    expect(move(5, 2, 99)).toBe(4);
  });

  it('returns 0 when visibleLen is 0', () => {
    expect(move(0, 0, 1)).toBe(0);
    expect(move(0, 5, -3)).toBe(0);
  });

  it('moves by delta within bounds', () => {
    expect(move(5, 1, 1)).toBe(2);
    expect(move(5, 3, -2)).toBe(1);
    expect(move(5, 2, 0)).toBe(2);
  });

  it('handles a single-row list', () => {
    expect(move(1, 0, 1)).toBe(0);
    expect(move(1, 0, -1)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* planReorder                                                                */
/* -------------------------------------------------------------------------- */

describe('planReorder', () => {
  it('move-down on an all-NULL list renumbers every affected row', () => {
    // The bug this fixes: with NULLS LAST sort, a single-row sort_order
    // write doesn't visibly move the top row down, because every
    // sibling NULL still ranks AFTER the new numeric value.
    //
    // Plan must rewrite EVERY row in the new order so the moved row's
    // predecessors carry sort_orders less than its own.
    const rs = [row(1n, undefined), row(2n, undefined), row(3n, undefined)];
    // Move row 1 (origIdx 0) to slot 1 in `without` (between row 2 and
    // row 3). New order: [row 2, row 1, row 3].
    const updates = planReorder(rs, 1n, 1);
    expect(updates).toEqual([
      { cardId: 2n, sortOrder: 100 },
      { cardId: 1n, sortOrder: 200 },
      { cardId: 3n, sortOrder: 300 },
    ]);
  });

  it('move-up on an all-NULL list also renumbers from index 0', () => {
    const rs = [row(1n, undefined), row(2n, undefined), row(3n, undefined)];
    // Move row 2 (origIdx 1) to slot 0. New order: [row 2, row 1, row 3].
    const updates = planReorder(rs, 2n, 0);
    expect(updates).toEqual([
      { cardId: 2n, sortOrder: 100 },
      { cardId: 1n, sortOrder: 200 },
      { cardId: 3n, sortOrder: 300 },
    ]);
  });

  it('steady state where sort_orders already match new positions writes nothing', () => {
    // Every row already at its desired sort_order, no shuffle.
    const rs = [row(1n, 100), row(2n, 200), row(3n, 300)];
    const updates = planReorder(rs, 1n, 0);
    expect(updates).toEqual([]);
  });

  it('swap of two adjacent rows in steady state writes only the swapped pair', () => {
    const rs = [row(1n, 100), row(2n, 200), row(3n, 300)];
    // Move row 1 to slot 1 in `without`. New order: [row 2, row 1, row 3].
    const updates = planReorder(rs, 1n, 1);
    // Only the two swapped rows differ from desired; row 3 stays at 300.
    expect(updates).toEqual([
      { cardId: 2n, sortOrder: 100 },
      { cardId: 1n, sortOrder: 200 },
    ]);
  });

  it('move to tail rewrites only the moved row when others already line up', () => {
    const rs = [row(1n, 100), row(2n, 200), row(3n, 300)];
    // Move row 1 to the bottom. New order: [row 2, row 3, row 1].
    const updates = planReorder(rs, 1n, 2);
    expect(updates).toEqual([
      { cardId: 2n, sortOrder: 100 },
      { cardId: 3n, sortOrder: 200 },
      { cardId: 1n, sortOrder: 300 },
    ]);
  });

  it('returns [] when movedID is not in the list', () => {
    const rs = [row(1n, 100), row(2n, 200)];
    expect(planReorder(rs, 99n, 0)).toEqual([]);
  });

  it('clamps insertAt outside [0, len] gracefully', () => {
    const rs = [row(1n, undefined), row(2n, undefined)];
    // insertAt = 99 → clamped to 1 (without.length); moved row goes to tail.
    const updates = planReorder(rs, 1n, 99);
    expect(updates).toEqual([
      { cardId: 2n, sortOrder: 100 },
      { cardId: 1n, sortOrder: 200 },
    ]);
    // insertAt = -3 → clamped to 0; moved row goes to head, no-op since
    // it's already there.
    expect(planReorder(rs, 1n, -3)).toEqual([
      { cardId: 1n, sortOrder: 100 },
      { cardId: 2n, sortOrder: 200 },
    ]);
  });

  it('mixed null/non-null state renumbers the rows whose values disagree', () => {
    // row 1 has the wrong sort_order for position 0; row 2 is null.
    const rs = [row(1n, 999), row(2n, undefined)];
    const updates = planReorder(rs, 2n, 0);
    // New order: [row 2, row 1]. Both need updating.
    expect(updates).toEqual([
      { cardId: 2n, sortOrder: 100 },
      { cardId: 1n, sortOrder: 200 },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* compile smoke for the .svelte component                                    */
/* -------------------------------------------------------------------------- */

describe('InboxScreen import', () => {
  it('module loads', async () => {
    const m = await import('../../src/screens/InboxScreen.svelte');
    expect(m.default).toBeDefined();
  });
});
