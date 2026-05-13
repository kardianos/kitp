/**
 * Vitest suite for the GridScreen logic helpers in
 * `src/screens/grid_helpers.ts`. The Svelte component itself imports cleanly
 * (smoke import below); component-mount coverage will arrive with the e2e
 * pass that drives a real browser.
 *
 * Coverage targets per task #14 of the migration plan:
 *   1. `cycleSort`           — null → asc; asc → desc; desc → null;
 *                              switching column → asc on new column.
 *   2. `buildOrderClauses`   — empty array when null, single clause when set.
 *   3. `applyFilterToTree`   — pass-through if predicate is null; otherwise
 *                              convert via `predicateToJson`, wrapping bare
 *                              leaves in a one-child AND group.
 */

import { describe, expect, it } from 'vitest';

import {
  andOf,
  eq,
  in_,
  predicateToJson,
  type Predicate,
} from '../../src/filter/predicate.js';
import {
  applyFilterToTree,
  buildOrderClauses,
  cycleSort,
  type SortState,
} from '../../src/screens/grid_helpers.js';

/* -------------------------------------------------------------------------- */
/* cycleSort                                                                  */
/* -------------------------------------------------------------------------- */

describe('cycleSort', () => {
  it('returns asc on the clicked field when no sort is active', () => {
    expect(cycleSort(null, 'attributes.title')).toEqual({
      field: 'attributes.title',
      direction: 'asc',
    });
  });

  it('cycles asc → desc on the same column', () => {
    const cur: SortState = { field: 'attributes.title', direction: 'asc' };
    expect(cycleSort(cur, 'attributes.title')).toEqual({
      field: 'attributes.title',
      direction: 'desc',
    });
  });

  it('cycles desc → null (off) on the same column', () => {
    const cur: SortState = { field: 'attributes.title', direction: 'desc' };
    expect(cycleSort(cur, 'attributes.title')).toBeNull();
  });

  it('switches to asc on a new column when a different column is active', () => {
    const cur: SortState = { field: 'attributes.title', direction: 'desc' };
    expect(cycleSort(cur, 'created_at')).toEqual({
      field: 'created_at',
      direction: 'asc',
    });
  });

  it('switches to asc when current is asc on a different column', () => {
    const cur: SortState = { field: 'attributes.status', direction: 'asc' };
    expect(cycleSort(cur, 'attributes.assignee')).toEqual({
      field: 'attributes.assignee',
      direction: 'asc',
    });
  });

  it('cycles deterministically through asc → desc → null → asc', () => {
    let s: SortState | null = null;
    s = cycleSort(s, 'created_at');
    expect(s).toEqual({ field: 'created_at', direction: 'asc' });
    s = cycleSort(s, 'created_at');
    expect(s).toEqual({ field: 'created_at', direction: 'desc' });
    s = cycleSort(s, 'created_at');
    expect(s).toBeNull();
    s = cycleSort(s, 'created_at');
    expect(s).toEqual({ field: 'created_at', direction: 'asc' });
  });
});

/* -------------------------------------------------------------------------- */
/* buildOrderClauses                                                          */
/* -------------------------------------------------------------------------- */

describe('buildOrderClauses', () => {
  it('returns an empty array when no sort is active', () => {
    expect(buildOrderClauses(null)).toEqual([]);
  });

  it('returns a single ASC clause when sort is asc', () => {
    expect(
      buildOrderClauses({ field: 'attributes.title', direction: 'asc' }),
    ).toEqual([{ field: 'attributes.title', direction: 'ASC' }]);
  });

  it('returns a single DESC clause when sort is desc', () => {
    expect(
      buildOrderClauses({ field: 'created_at', direction: 'desc' }),
    ).toEqual([{ field: 'created_at', direction: 'DESC' }]);
  });

  it('uppercases direction (server expects ASC/DESC, not asc/desc)', () => {
    const out = buildOrderClauses({
      field: 'attributes.status',
      direction: 'asc',
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.direction).toBe('ASC');
  });
});

/* -------------------------------------------------------------------------- */
/* applyFilterToTree                                                          */
/* -------------------------------------------------------------------------- */

describe('applyFilterToTree', () => {
  it('returns the base tree unchanged when predicate is null', () => {
    const base = { connective: 'and', children: [] };
    expect(applyFilterToTree(null, base)).toBe(base);
  });

  it('returns undefined when both predicate and base tree are absent', () => {
    expect(applyFilterToTree(null, undefined)).toBeUndefined();
  });

  it('wraps a bare leaf in a one-child AND group', () => {
    const leaf = eq('status', 'todo');
    const tree = applyFilterToTree(leaf, undefined);
    expect(tree).toEqual({
      connective: 'and',
      children: [predicateToJson(leaf)],
    });
  });

  it('emits a group predicate verbatim via predicateToJson', () => {
    const grp: Predicate = andOf([
      eq('status', 'doing'),
      in_('assignee', [1, 2]),
    ]);
    expect(applyFilterToTree(grp, undefined)).toEqual(predicateToJson(grp));
  });

  it('drops the base tree when an explicit predicate is provided', () => {
    // applyFilterToTree replaces the base when a predicate is supplied —
    // the base is only used as a passthrough when the user has no filter.
    const base = { connective: 'and', children: [] };
    const leaf = eq('status', 'done');
    const tree = applyFilterToTree(leaf, base);
    expect(tree).not.toBe(base);
    expect(tree).toEqual({
      connective: 'and',
      children: [predicateToJson(leaf)],
    });
  });

  it('round-trips through predicateToJson for a NOT group', () => {
    const grp: Predicate = {
      kind: 'group',
      connective: 'not',
      children: [eq('status', 'done')],
    };
    expect(applyFilterToTree(grp, undefined)).toEqual(predicateToJson(grp));
  });
});

/* -------------------------------------------------------------------------- */
/* Smoke import                                                               */
/* -------------------------------------------------------------------------- */

describe('GridLayout smoke import', () => {
  it('imports cleanly (component compiles)', async () => {
    const mod = await import('../../src/screens/GridLayout.svelte');
    expect(mod.default).toBeDefined();
  });
});
