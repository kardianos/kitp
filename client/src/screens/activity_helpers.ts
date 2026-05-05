/**
 * Pure helpers used by `ActivityScreen.svelte`.
 *
 * Kept in a separate module so they can be unit-tested without spinning up
 * a Svelte component (the test suite does not include
 * `@testing-library/svelte`, so component-level tests are out of scope).
 */

import type { ActivityRow } from '../reg/types.js';

/** Filter spec applied client-side to the list of activity rows. */
export interface ActivityFilter {
  /** Selected kinds; an empty array means "all kinds". */
  kinds: string[];
  /** Actor user-id to filter by, or null for "any actor". */
  actorId: number | null;
  /** ISO yyyy-mm-dd lower bound (inclusive); null means unbounded. */
  fromDate: string | null;
  /** ISO yyyy-mm-dd upper bound (inclusive); null means unbounded. */
  toDate: string | null;
}

/** Wire payload for an `activity.select` "load more" call. */
export interface PaginatePayload {
  before_activity_id: number;
  limit: number;
}

/** Default page size for both the initial fetch and "Load more". */
export const ACTIVITY_PAGE_SIZE = 100;

/**
 * Apply a client-side filter to a list of {@link ActivityRow}s.
 *
 * All four filter dimensions AND together. An empty `kinds` array means
 * "no kind restriction"; a null `actorId` / `fromDate` / `toDate` means
 * the dimension does not narrow the result.
 *
 * Date comparison is done lexicographically against `created_at` (the
 * server emits RFC3339 / ISO-8601 timestamps which sort correctly as
 * strings). The bounds are inclusive on both ends; `toDate` is widened
 * to the end of the day so e.g. picking `2026-05-04` matches a row with
 * `created_at = '2026-05-04T23:59:59Z'`.
 */
export function applyFilters(
  rows: ActivityRow[],
  filter: ActivityFilter,
): ActivityRow[] {
  const { kinds, actorId, fromDate, toDate } = filter;
  // End-of-day for the upper bound so the picker behaves intuitively.
  const upperBound =
    toDate !== null && toDate !== '' ? `${toDate}T23:59:59.999Z` : null;
  const lowerBound =
    fromDate !== null && fromDate !== '' ? `${fromDate}T00:00:00.000Z` : null;

  const kindSet = kinds.length > 0 ? new Set(kinds) : null;

  return rows.filter((r) => {
    if (kindSet !== null && !kindSet.has(r.kind)) return false;
    if (actorId !== null && r.actor_id !== actorId) return false;
    if (lowerBound !== null && r.created_at < lowerBound) return false;
    if (upperBound !== null && r.created_at > upperBound) return false;
    return true;
  });
}

/**
 * Build the pagination payload for `activity.select`'s "Load more" path.
 * The cursor is exclusive: rows with id < `before_activity_id` follow.
 */
export function paginatePayload(oldestRow: ActivityRow): PaginatePayload {
  return { before_activity_id: oldestRow.id, limit: ACTIVITY_PAGE_SIZE };
}
