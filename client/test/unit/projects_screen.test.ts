/**
 * Unit coverage for the ProjectsScreen pure helpers.
 *
 * The vitest runner is node-only (no jsdom), so the .svelte component is
 * not mounted here — we exercise the extracted helpers in
 * `src/screens/projects_helpers.ts`. Real-DOM coverage of the screen
 * itself lands with the e2e journey suite (task #6 of the migration
 * plan).
 *
 * Coverage targets per task #12:
 *   1. `searchAndFilter` — empty search returns all rows; substring
 *      match is case-insensitive; predicate narrows further; predicate
 *      = null leaves search-only results.
 *   2. `move` clamps `current + delta` into `[0, max(visibleLen-1, 0)]`.
 *   3. `buildInitialBatch()` returns exactly three sub-requests
 *      matching the locked initial-batch contract — and
 *      `initialBatchCount` mirrors that count.
 */

import { describe, expect, it } from 'vitest';

import { andOf, eq } from '../../src/filter/predicate.js';
import type { CardWithAttrs } from '../../src/reg/types.js';
import {
  buildInitialBatch,
  initialBatchCount,
  move,
  searchAndFilter,
} from '../../src/screens/projects_helpers.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function project(
  id: bigint,
  title: string,
  attrs: Record<string, unknown> = {},
): CardWithAttrs {
  return {
    id,
    card_type_id: 1n,
    card_type_name: 'project',
    attributes: { title, ...attrs },
  };
}

const FIXTURES: CardWithAttrs[] = [
  project(1n, 'Apollo', { status: 'active' }),
  project(2n, 'Borealis', { status: 'archived' }),
  project(3n, 'Cassiopeia', { status: 'active' }),
  project(4n, 'Draco', {}),
];

/* -------------------------------------------------------------------------- */
/* searchAndFilter                                                            */
/* -------------------------------------------------------------------------- */

describe('searchAndFilter', () => {
  it('returns every project when search is empty and predicate is null', () => {
    const out = searchAndFilter(FIXTURES, '', null);
    expect(out.map((p) => p.id)).toEqual([1n, 2n, 3n, 4n]);
  });

  it('whitespace-only search behaves like empty search', () => {
    const out = searchAndFilter(FIXTURES, '   ', null);
    expect(out.map((p) => p.id)).toEqual([1n, 2n, 3n, 4n]);
  });

  it('substring match is case-insensitive against attributes.title', () => {
    expect(searchAndFilter(FIXTURES, 'apollo', null).map((p) => p.id)).toEqual([1n]);
    expect(searchAndFilter(FIXTURES, 'APOLLO', null).map((p) => p.id)).toEqual([1n]);
    expect(searchAndFilter(FIXTURES, 'a', null).map((p) => p.id)).toEqual([
      1n, 2n, 3n, 4n,
    ]);
  });

  it('search returns [] when no titles include the needle', () => {
    expect(searchAndFilter(FIXTURES, 'zenith', null)).toEqual([]);
  });

  it('predicate = null + non-empty search returns search-only result', () => {
    const out = searchAndFilter(FIXTURES, 'cas', null);
    expect(out.map((p) => p.id)).toEqual([3n]);
  });

  it('predicate (single leaf) narrows the substring-matched set', () => {
    // search="" + status='active' → Apollo, Cassiopeia
    const out = searchAndFilter(FIXTURES, '', eq('status', 'active'));
    expect(out.map((p) => p.id)).toEqual([1n, 3n]);
  });

  it('predicate (flat AND of leaves) is conjunctive', () => {
    // status='active' AND status='active' (degenerate — still narrows correctly).
    const both = andOf([eq('status', 'active'), eq('status', 'active')]);
    const out = searchAndFilter(FIXTURES, '', both);
    expect(out.map((p) => p.id)).toEqual([1n, 3n]);
  });

  it('search and predicate apply together (intersection)', () => {
    // search='a' (matches all four), predicate status='archived' (matches Borealis).
    const out = searchAndFilter(FIXTURES, 'a', eq('status', 'archived'));
    expect(out.map((p) => p.id)).toEqual([2n]);
  });

  it('predicate exists / notExists discriminates on attribute presence', () => {
    const exists = { kind: 'leaf', attr: 'status', op: 'exists' } as const;
    const notExists = { kind: 'leaf', attr: 'status', op: 'notExists' } as const;
    expect(searchAndFilter(FIXTURES, '', exists).map((p) => p.id)).toEqual([
      1n, 2n, 3n,
    ]);
    expect(searchAndFilter(FIXTURES, '', notExists).map((p) => p.id)).toEqual([
      4n,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* move                                                                       */
/* -------------------------------------------------------------------------- */

describe('move', () => {
  it('clamps to lower bound (0)', () => {
    expect(move(5, 0, -1)).toBe(0);
    expect(move(5, 2, -10)).toBe(0);
  });

  it('clamps to upper bound (visibleLen - 1)', () => {
    expect(move(5, 4, +1)).toBe(4);
    expect(move(5, 0, +99)).toBe(4);
  });

  it('moves by delta within bounds', () => {
    expect(move(5, 0, +1)).toBe(1);
    expect(move(5, 3, -1)).toBe(2);
    expect(move(5, 2, +2)).toBe(4);
  });

  it('returns 0 for an empty list', () => {
    expect(move(0, 0, +1)).toBe(0);
    expect(move(0, 5, -3)).toBe(0);
  });

  it('returns 0 for a single-row list', () => {
    expect(move(1, 0, +1)).toBe(0);
    expect(move(1, 0, -1)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* buildInitialBatch                                                          */
/* -------------------------------------------------------------------------- */

describe('buildInitialBatch', () => {
  it('returns exactly three sub-requests', () => {
    const batch = buildInitialBatch();
    expect(batch).toHaveLength(3);
    expect(initialBatchCount).toBe(3);
    expect(batch.length).toBe(initialBatchCount);
  });

  it('covers card.select_with_attributes, attribute_def.select, user.select', () => {
    const batch = buildInitialBatch();
    const keys = batch.map((b) => `${b.endpoint}.${b.action}`).sort();
    expect(keys).toEqual([
      'attribute_def.select',
      'card.select_with_attributes',
      'user.select',
    ]);
  });
});
