/**
 * Pure helpers for the Comms screen + Task detail Comms section.
 *
 * Extracted into a plain `.ts` module so they can be unit-tested without
 * spinning up a Svelte component (the project has no
 * `@testing-library/svelte` dependency).
 *
 * Responsibilities:
 *   1. Compose dispatcher inputs for `comm.list_for_task` and
 *      `reply.post`.
 *   2. Derive the default reply composer fields from the comm's last
 *      reply (To: from the most recent received-direction reply; Subject:
 *      with a "Re: " prefix when missing).
 *   3. Sort replies oldest-first for the inline display, then slice the
 *      last N for the row variant.
 *   4. Compute a comm_status badge: title from the status lookup map +
 *      phase-based colour ('active' = blue, 'terminal' = green, 'triage' =
 *      muted).
 */

import type { ReplyPostInput, CommListForTaskInput } from '../reg/types.js';
import type {
  CommRow,
  ID,
  ReplyRow,
} from '../reg/types.js';

/** Build the dispatcher input for `comm.list_for_task`. */
export function commListForTaskPayload(taskId: ID): CommListForTaskInput {
  return { taskId };
}

/** Build the dispatcher input for `reply.post`. The body is trimmed; the
 *  composer's send button is disabled when the trimmed body is empty so
 *  this helper assumes the caller has already validated. */
export function replyPostPayload(
  commId: ID,
  to: string,
  subject: string,
  body: string,
): ReplyPostInput {
  const out: ReplyPostInput = { commId, to, body };
  if (subject !== '') out.subject = subject;
  return out;
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

/**
 * Derive the default `To:` field for a fresh reply composer.
 *
 * Strategy: walk the replies newest-first and return the first
 * `received` reply's `from` field. Falls back to the last outbound
 * reply's `to` so a thread with only outbound mail still gets a useful
 * default. Empty string when the comm has no replies yet (the operator
 * must type the recipient by hand in that case).
 */
export function defaultReplyTo(replies: readonly ReplyRow[]): string {
  const newestFirst = [...sortRepliesAsc(replies)].reverse();
  for (const r of newestFirst) {
    if (r.delivery_status === 'received' && r.from !== '') return r.from;
  }
  for (const r of newestFirst) {
    if (r.to !== '') return r.to;
  }
  return '';
}

/**
 * Derive the default `Subject:` field for a fresh reply composer.
 *
 * Strategy: take the most-recent reply's subject and ensure it starts
 * with "Re: " (case-insensitive). Replies on a thread with no prior
 * subject default to the comm's title with a "Re: " prefix.
 */
export function defaultReplySubject(
  comm: { title: string },
  replies: readonly ReplyRow[],
): string {
  const newestFirst = [...sortRepliesAsc(replies)].reverse();
  const base =
    newestFirst.find((r) => r.subject !== '')?.subject ?? comm.title ?? '';
  if (base === '') return '';
  // Already prefixed (any case, optionally with whitespace): leave alone.
  if (/^re:\s/i.test(base)) return base;
  return `Re: ${base}`;
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
