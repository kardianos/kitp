/**
 * Pure helpers for the TransitionBar (#34) renderer — ported from the Svelte
 * client's `client/src/ui/widgets/transition_bar_buckets.ts` (reference only;
 * NOT imported across the package boundary).
 *
 * Bucket derivation is total — every `(from_phase, to_phase)` of the 9-cell
 * phase matrix maps to exactly one named UI bucket. The renderer picks a
 * default shape + styling tone per bucket per the spec table:
 *
 * | from.phase | to.phase | Bucket           | Tone     |
 * |------------|----------|------------------|----------|
 * | triage     | triage   | progress_triage  | neutral  |
 * | triage     | active   | accept           | positive |
 * | triage     | terminal | reject           | danger   |
 * | active     | triage   | defer            | neutral  |
 * | active     | active   | progress         | accent   |
 * | active     | terminal | close            | danger   |
 * | terminal   | triage   | retriage         | neutral  |
 * | terminal   | active   | reopen           | positive |
 * | terminal   | terminal | recategorize     | neutral  |
 *
 * Kept as a plain `.ts` module so the table can be unit-tested directly without
 * spinning up the control (matches the codebase's pure-helper test posture).
 */

/** The three flow phases a card / value-card can sit in. */
export type TransitionPhase = 'triage' | 'active' | 'terminal';

/** Coerce an arbitrary wire phase string to the union (defaults to 'active'). */
export function asTransitionPhase(raw: unknown): TransitionPhase {
  return raw === 'triage' || raw === 'terminal' ? raw : 'active';
}

/**
 * One available transition row — the decoded `flow_step.list_for_card` shape.
 * ids are bigint (revived on the wire); labels/phases drive the UI.
 */
export interface TransitionRow {
  /** flow_step id. */
  id: bigint;
  flowId: bigint;
  flowName: string;
  attributeDefId: bigint;
  /** Typically `'status'` — the attribute_def the parent flow is bound to. */
  attributeDefName: string;
  fromCardId: bigint;
  fromLabel: string;
  fromPhase: TransitionPhase;
  toCardId: bigint;
  toLabel: string;
  toPhase: TransitionPhase;
  /** Transition button label authored on the flow_step row. */
  label: string;
  /** 0n means no role gate. */
  requiresRoleId: bigint;
  /** Empty string when no role gate. */
  requiresRoleName: string;
  /** Display order within the UI bucket. */
  sortOrder: number;
  /** True if the calling actor's roles satisfy `requiresRoleId` (server bit). */
  allowed: boolean;
}

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

/** Visual tone a bucket maps to — drives the button's CSS modifier. */
export type BucketTone = 'positive' | 'danger' | 'accent' | 'neutral';

/** The tone per bucket (single source for the renderer's styling switch). */
export const BUCKET_TONE: Record<TransitionBucket, BucketTone> = {
  progress_triage: 'neutral',
  accept: 'positive',
  reject: 'danger',
  defer: 'neutral',
  progress: 'accent',
  close: 'danger',
  retriage: 'neutral',
  reopen: 'positive',
  recategorize: 'neutral',
};

/**
 * Total function: map a transition's `(from_phase, to_phase)` pair to its UI
 * bucket. The spec table is the single source of truth.
 */
export function bucketOf(t: Pick<TransitionRow, 'fromPhase' | 'toPhase'>): TransitionBucket {
  return bucketFor(t.fromPhase, t.toPhase);
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
  // Unreachable given the union exhaustiveness above; the runtime fallback keeps
  // the function total if the server ever emits a phase outside the union (we
  // already coerce in `asTransitionPhase`).
  return 'progress';
}

/**
 * Sort a transition list within a single bucket: `sortOrder` ascending, then
 * `label`, then `toCardId` for total determinism.
 */
export function compareTransitions(a: TransitionRow, b: TransitionRow): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;
  if (a.toCardId < b.toCardId) return -1;
  if (a.toCardId > b.toCardId) return 1;
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
 * Bucket a transition list. Returns a record with one slot per bucket so the
 * renderer can read `m.close.length > 0` without `undefined` guards. Within each
 * slot rows are sorted via {@link compareTransitions}.
 */
export function groupByBucket(transitions: readonly TransitionRow[]): BucketMap {
  const out = emptyBucketMap();
  for (const t of transitions) out[bucketOf(t)].push(t);
  for (const b of ALL_BUCKETS) out[b].sort(compareTransitions);
  return out;
}

/** True when the bar has at least one transition to show. */
export function hasAnyTransition(m: BucketMap): boolean {
  return ALL_BUCKETS.some((b) => m[b].length > 0);
}
