/**
 * Pure helpers for the Comms screen + Task detail Comms section.
 *
 * Extracted into a plain `.ts` module so they can be unit-tested without
 * spinning up a Svelte component (the project has no
 * `@testing-library/svelte` dependency).
 *
 * Responsibilities:
 *   1. Compose dispatcher inputs for `comm.list_for_task` and
 *      `reply.post` (To: + Subject are derived server-side from
 *      comm.recipients + parent task title, so reply.post only ships
 *      the body).
 *   2. Sort replies oldest-first for the inline display, then slice
 *      the last N for the row variant.
 *   3. Compute a comm_status badge: title from the status lookup map +
 *      phase-based colour ('active' = blue, 'terminal' = green,
 *      'triage' = muted).
 */

import type { ReplyPostInput, CommListForTaskInput } from '../reg/types.js';
import type { ID, ReplyRow } from '../reg/types.js';

/** Build the dispatcher input for `comm.list_for_task`. */
export function commListForTaskPayload(taskId: ID): CommListForTaskInput {
  return { taskId };
}

/**
 * Build the dispatcher input for `reply.post`. The body is trimmed; the
 * composer's send button is disabled when the trimmed body is empty so
 * this helper assumes the caller has already validated. The To: list
 * and Subject line are derived server-side from comm.recipients and
 * the parent task's title — not supplied by the caller.
 */
export function replyPostPayload(commId: ID, body: string): ReplyPostInput {
  return { commId, body };
}

/**
 * Sort replies ascending by `created_at` (oldest first). Stable on ties
 * by id ascending so paginated rows render in a deterministic order
 * across renders.
 */
export function sortRepliesAsc(rows: readonly ReplyRow[]): ReplyRow[] {
  return [...rows].sort((a, b) => {
    if (a.created_at !== b.created_at) {
      return a.created_at < b.created_at ? -1 : 1;
    }
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

/**
 * Return the last `n` replies in chronological order, with the most
 * recent reply last. Used by the row variant on the Comms screen — the
 * full reply chain renders on the Task detail page.
 */
export function lastNReplies(rows: readonly ReplyRow[], n: number): ReplyRow[] {
  const sorted = sortRepliesAsc(rows);
  if (sorted.length <= n) return sorted;
  return sorted.slice(sorted.length - n);
}

/** Closed set of phase values mirrored from `TransitionPhase`. */
export type CommStatusPhase = 'triage' | 'active' | 'terminal';

/**
 * Pick the badge tone for a comm_status value. Mirrors the kernel's
 * three-phase classification used elsewhere (TransitionBar buckets).
 *
 * `'active'` → blue, `'terminal'` → green, `'triage'` → muted. Unknown
 * phases fall back to the muted tone so we never blank-render.
 */
export function commStatusTone(phase: CommStatusPhase | string): 'blue' | 'green' | 'muted' {
  if (phase === 'active') return 'blue';
  if (phase === 'terminal') return 'green';
  return 'muted';
}

/**
 * Resolve a comm_status value-card id to its display title via a lookup
 * map (typically built from the status card list the screen already
 * loads). Falls back to `#<id>` so the badge always has SOMETHING to
 * render.
 */
export function commStatusLabel(
  commStatus: ID,
  titles: Record<string, string>,
): string {
  const key = commStatus.toString();
  if (commStatus === 0n) return '';
  return titles[key] ?? `#${key}`;
}
