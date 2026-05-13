/**
 * Pure helpers for the {@link TransitionBar} renderer (Gate 7 of
 * FLOW_AND_SCREEN_KERNEL.md §"<TransitionBar> replaces TerminalActionButton").
 *
 * Bucket derivation is total — every `(from_phase, to_phase)` of the 9-cell
 * matrix maps to exactly one named UI bucket. The renderer picks a default
 * shape per bucket per the spec table:
 *
 * | from.phase | to.phase | Bucket             |
 * |-----------|----------|--------------------|
 * | triage    | triage   | progress_triage    |
 * | triage    | active   | accept             |
 * | triage    | terminal | reject             |
 * | active    | triage   | defer              |
 * | active    | active   | progress           |
 * | active    | terminal | close              |
 * | terminal  | triage   | retriage           |
 * | terminal  | active   | reopen             |
 * | terminal  | terminal | recategorize       |
 *
 * Keeping this in a plain `.ts` module so the table can be unit-tested
 * via `describe.each` / `it.each` without spinning up a Svelte renderer
 * (the rest of the codebase tests components by extracting pure helpers
 * and asserting on them — see `task_detail_helpers.ts` for the pattern).
 */

import type { TransitionPhase, TransitionRow } from '../../reg/types.js';

/** One of nine UI buckets derived from `(from_phase, to_phase)`. */
export type TransitionBucket =
  | 'progress_triage'
  | 'accept'
  | 'reject'
  | 'defer'
  | 'progress'
  | 'close'
  | 'retriage'
  | 'reopen'
  | 'recategorize';

/** Ordered list of every bucket — useful for iteration / type-safe maps. */
export const ALL_BUCKETS: readonly TransitionBucket[] = [
  'progress_triage',
  'accept',
  'reject',
  'defer',
  'progress',
  'close',
  'retriage',
  'reopen',
  'recategorize',
] as const;

/**
 * Total function: map a transition's `(from_phase, to_phase)` pair to its
 * UI bucket. Spec table is the single source of truth.
 */
export function bucketOf(t: Pick<TransitionRow, 'from_phase' | 'to_phase'>): TransitionBucket {
  return bucketFor(t.from_phase, t.to_phase);
}

/** Standalone pair → bucket lookup (used by `bucketOf` and tests). */
export function bucketFor(
  fromPhase: TransitionPhase,
  toPhase: TransitionPhase,
): TransitionBucket {
  switch (fromPhase) {
    case 'triage':
      switch (toPhase) {
        case 'triage':
          return 'progress_triage';
        case 'active':
          return 'accept';
        case 'terminal':
          return 'reject';
      }
      break;
    case 'active':
      switch (toPhase) {
        case 'triage':
          return 'defer';
        case 'active':
          return 'progress';
        case 'terminal':
          return 'close';
      }
      break;
    case 'terminal':
      switch (toPhase) {
        case 'triage':
          return 'retriage';
        case 'active':
          return 'reopen';
        case 'terminal':
          return 'recategorize';
      }
      break;
  }
  // The TS exhaustiveness check above means this is unreachable; the
  // runtime fallback keeps the function total in case the server ever
  // emits a phase value not in the union (defensive — we already coerce
  // to 'active' in `asTransitionPhase` so this branch should never run).
  return 'progress';
}

/**
 * Sort a transition list within a single bucket: `sort_order` ascending,
 * then `label`, then `to_card_id` for total determinism.
 */
export function compareTransitions(a: TransitionRow, b: TransitionRow): number {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;
  if (a.to_card_id < b.to_card_id) return -1;
  if (a.to_card_id > b.to_card_id) return 1;
  return 0;
}

/** A record keyed by every bucket; each value is an array (possibly empty). */
export type BucketMap = Record<TransitionBucket, TransitionRow[]>;

function emptyBucketMap(): BucketMap {
  return {
    progress_triage: [],
    accept: [],
    reject: [],
    defer: [],
    progress: [],
    close: [],
    retriage: [],
    reopen: [],
    recategorize: [],
  };
}

/**
 * Bucket a transition list. Returns a record with one slot per bucket so
 * the renderer can read `m.close.length > 0` without `undefined` guards.
 * Within each slot the rows are sorted via {@link compareTransitions}.
 */
export function groupByBucket(transitions: readonly TransitionRow[]): BucketMap {
  const out = emptyBucketMap();
  for (const t of transitions) {
    out[bucketOf(t)].push(t);
  }
  for (const b of ALL_BUCKETS) {
    out[b].sort(compareTransitions);
  }
  return out;
}
