/**
 * Unit coverage for the pure helpers backing `ActivityScreen.svelte`.
 *
 * The Svelte component itself is exercised at compile-smoke level (matches
 * the pattern established by `widgets.test.ts`) — the component depends on
 * `getDispatcher()`, the Svelte context, runes, and DOM, none of which the
 * Vitest node runner has. The interesting branching logic lives in
 * `applyFilters` / `paginatePayload`, both pure.
 *
 * Coverage:
 *   - applyFilters: empty filter, kinds narrowing, actor narrowing, date
 *     range narrowing, combination of all four.
 *   - paginatePayload: returns { before_activity_id, limit: 100 }.
 */

import { describe, expect, it } from 'vitest';

import type { ActivityRow } from '../../src/reg/types';
import {
  ACTIVITY_PAGE_SIZE,
  applyFilters,
  paginatePayload,
  type ActivityFilter,
} from '../../src/screens/activity_helpers';

/* -------------------------------------------------------------------------- */
/* Test fixtures                                                              */
/* -------------------------------------------------------------------------- */

function row(partial: Partial<ActivityRow>): ActivityRow {
  return {
    id: 1,
    card_id: 100,
    kind: 'card_create',
    actor_id: 1,
    created_at: '2026-05-04T12:00:00Z',
    ...partial,
  };
}

const SAMPLE_ROWS: ActivityRow[] = [
  row({ id: 5, kind: 'card_create', actor_id: 1, created_at: '2026-05-04T12:00:00Z' }),
  row({ id: 4, kind: 'attr_update', actor_id: 2, created_at: '2026-05-03T09:30:00Z' }),
  row({ id: 3, kind: 'comment',     actor_id: 1, created_at: '2026-05-02T18:15:00Z' }),
  row({ id: 2, kind: 'tag_apply',   actor_id: 3, created_at: '2026-04-30T08:00:00Z' }),
  row({ id: 1, kind: 'card_delete', actor_id: 2, created_at: '2026-04-15T22:45:00Z' }),
];

const NO_FILTER: ActivityFilter = {
  kinds: [],
  actorId: null,
  fromDate: null,
  toDate: null,
};

/* -------------------------------------------------------------------------- */
/* applyFilters                                                               */
/* -------------------------------------------------------------------------- */

describe('applyFilters', () => {
  it('returns every row when the filter is empty', () => {
    const out = applyFilters(SAMPLE_ROWS, NO_FILTER);
    expect(out).toHaveLength(SAMPLE_ROWS.length);
    expect(out.map((r) => r.id)).toEqual([5, 4, 3, 2, 1]);
  });

  it('returns an empty array when given an empty input list', () => {
    expect(applyFilters([], NO_FILTER)).toEqual([]);
  });

  it('preserves input ordering (newest-first stays newest-first)', () => {
    const reversed = [...SAMPLE_ROWS].reverse();
    const out = applyFilters(reversed, NO_FILTER);
    expect(out.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('narrows by a single kind', () => {
    const out = applyFilters(SAMPLE_ROWS, { ...NO_FILTER, kinds: ['comment'] });
    expect(out.map((r) => r.id)).toEqual([3]);
  });

  it('narrows by multiple kinds (OR within the kinds set)', () => {
    const out = applyFilters(SAMPLE_ROWS, {
      ...NO_FILTER,
      kinds: ['card_create', 'card_delete'],
    });
    expect(out.map((r) => r.id)).toEqual([5, 1]);
  });

  it('returns an empty array when no row matches any selected kind', () => {
    const out = applyFilters(SAMPLE_ROWS, {
      ...NO_FILTER,
      kinds: ['no_such_kind'],
    });
    expect(out).toEqual([]);
  });

  it('narrows by actorId', () => {
    const out = applyFilters(SAMPLE_ROWS, { ...NO_FILTER, actorId: 2 });
    expect(out.map((r) => r.id)).toEqual([4, 1]);
  });

  it('returns an empty array when no row matches the actorId', () => {
    expect(
      applyFilters(SAMPLE_ROWS, { ...NO_FILTER, actorId: 999 }),
    ).toEqual([]);
  });

  it('narrows by fromDate (inclusive lower bound)', () => {
    const out = applyFilters(SAMPLE_ROWS, {
      ...NO_FILTER,
      fromDate: '2026-05-01',
    });
    // Rows on/after 2026-05-01 — keeps 5, 4, 3; drops 2, 1.
    expect(out.map((r) => r.id)).toEqual([5, 4, 3]);
  });

  it('narrows by toDate (inclusive upper bound, end-of-day)', () => {
    const out = applyFilters(SAMPLE_ROWS, {
      ...NO_FILTER,
      toDate: '2026-05-03',
    });
    // Rows on/before 2026-05-03 23:59:59 — keeps 4, 3, 2, 1; drops 5.
    expect(out.map((r) => r.id)).toEqual([4, 3, 2, 1]);
  });

  it('narrows by a from..to date range, both bounds inclusive', () => {
    const out = applyFilters(SAMPLE_ROWS, {
      ...NO_FILTER,
      fromDate: '2026-05-02',
      toDate: '2026-05-04',
    });
    expect(out.map((r) => r.id)).toEqual([5, 4, 3]);
  });

  it('returns an empty array when the range excludes every row', () => {
    const out = applyFilters(SAMPLE_ROWS, {
      ...NO_FILTER,
      fromDate: '2030-01-01',
      toDate: '2030-12-31',
    });
    expect(out).toEqual([]);
  });

  it('AND-combines kinds + actorId + date range correctly', () => {
    // kinds={card_create,card_delete}, actor=2, range=2026-04-01..2026-04-30
    // Among rows: only id=1 (kind=card_delete, actor=2, 2026-04-15) qualifies.
    const out = applyFilters(SAMPLE_ROWS, {
      kinds: ['card_create', 'card_delete'],
      actorId: 2,
      fromDate: '2026-04-01',
      toDate: '2026-04-30',
    });
    expect(out.map((r) => r.id)).toEqual([1]);
  });

  it('treats an empty-string fromDate / toDate the same as null', () => {
    const out = applyFilters(SAMPLE_ROWS, {
      kinds: [],
      actorId: null,
      fromDate: '',
      toDate: '',
    });
    expect(out.map((r) => r.id)).toEqual([5, 4, 3, 2, 1]);
  });
});

/* -------------------------------------------------------------------------- */
/* paginatePayload                                                            */
/* -------------------------------------------------------------------------- */

describe('paginatePayload', () => {
  it('returns { before_activity_id: oldestRow.id, limit: 100 }', () => {
    const oldest = row({ id: 42 });
    expect(paginatePayload(oldest)).toEqual({
      before_activity_id: 42,
      limit: 100,
    });
  });

  it('uses the page-size constant for `limit`', () => {
    const oldest = row({ id: 1 });
    expect(paginatePayload(oldest).limit).toBe(ACTIVITY_PAGE_SIZE);
  });

  it('round-trips a large activity id', () => {
    const oldest = row({ id: 9_007_199_254_740_991 });
    expect(paginatePayload(oldest).before_activity_id).toBe(
      9_007_199_254_740_991,
    );
  });
});
