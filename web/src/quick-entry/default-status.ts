/**
 * Default-create-status resolution — the chain QuickEntry walks to stamp a new
 * task's status (Gate 6 of FLOW_AND_SCREEN_KERNEL).
 *
 * Port of `client/src/quick_entry/default_status.svelte.ts` (NOT imported),
 * re-expressed against the `web/` card model (bigint ids + a plain attributes
 * record — {@link CardWithAttrs}). The walk, in order:
 *
 *   1. screen.default_create_status   ← per-screen override (card_ref → status)
 *   2. flow.default_create_status_id  ← per-flow default
 *   3. first status with phase='triage'  by sort_order
 *   4. first status with phase='active'  by sort_order
 *   5. fail with code='flow_no_default'
 *
 * The resolver is intentionally PURE: callers gather the inputs (the active
 * screen card, an optional flow row, the project's candidate status cards) and
 * feed them in. It returns the resolved status card id or a structured error
 * suitable for a toast. No I/O, no DOM — exercised directly by `node --test`.
 */

import type { CardWithAttrs } from '../kanban/kanban-helpers.js';

/**
 * The subset of a `flow.list` row the resolver needs. Declared locally (no flow
 * read exists in the web client yet) so a caller can build it from whatever it
 * has in memory. `default_create_status_id === 0n` / undefined means "unset"
 * (the server's wire encoder omits the zero value).
 */
export interface FlowRow {
  id: bigint;
  /** 0n / undefined when no per-flow default is set. */
  default_create_status_id?: bigint;
}

/** Inputs for {@link resolveDefaultCreateStatus}. */
export interface ResolveDefaultCreateStatusOpts {
  /** The active screen card (null when there's no screen scope). */
  screenCard?: CardWithAttrs | null;
  /** The flow bound via `screen.flow_ref` (null when none). */
  flow?: FlowRow | null;
  /**
   * Every candidate status card in scope, each carrying its `phase` +
   * `sort_order`. Sorted internally — callers needn't pre-sort.
   */
  candidateStatuses: CardWithAttrs[];
}

/** Success: the status card id to stamp on the new task. */
export interface ResolveDefaultCreateStatusOk {
  statusCardId: bigint;
}

/** Failure: the chain bottomed out without producing a status. */
export interface ResolveDefaultCreateStatusError {
  error: 'flow_no_default';
  message: string;
}

export type ResolveDefaultCreateStatusResult =
  | ResolveDefaultCreateStatusOk
  | ResolveDefaultCreateStatusError;

/* -------------------------------------------------------------------------- */
/* Internals.                                                                  */
/* -------------------------------------------------------------------------- */

/** Read `sort_order` as a finite number; unsorted rows sink to the back. */
function readSortOrder(c: CardWithAttrs): number {
  const v = c.attributes['sort_order'];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Read a screen card's `default_create_status` (a card_ref → status id). The
 * wire ships card_ref ids as JSON strings; tolerate bigint / number / digits.
 */
function readScreenDefaultStatus(
  screenCard: CardWithAttrs | null | undefined,
): bigint | null {
  if (!screenCard) return null;
  return toId(screenCard.attributes['default_create_status']);
}

/**
 * Lowest-sort_order candidate with `phase`; ties break on id (ascending) for a
 * deterministic result. Null when none match.
 */
function firstByPhase(
  candidates: CardWithAttrs[],
  phase: 'triage' | 'active',
): CardWithAttrs | null {
  let best: CardWithAttrs | null = null;
  let bestSort = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    if (c.phase !== phase) continue;
    const s = readSortOrder(c);
    if (s < bestSort) {
      best = c;
      bestSort = s;
      continue;
    }
    if (s === bestSort && best !== null && c.id < best.id) best = c;
  }
  return best;
}

/** Coerce a wire id (bigint / number / digits-string) to bigint, else null. */
function toId(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v === 0n ? null : v;
  if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) {
    try {
      const n = BigInt(v);
      return n === 0n ? null : n;
    } catch {
      return null;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Public API.                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the status card id a fresh task `card.insert` should stamp, walking
 * the screen → flow → triage → active chain. Returns the chosen id, or
 * `{ error: 'flow_no_default', message }` when the chain bottoms out.
 */
export function resolveDefaultCreateStatus(
  opts: ResolveDefaultCreateStatusOpts,
): ResolveDefaultCreateStatusResult {
  // 1. screen.default_create_status
  const screenDefault = readScreenDefaultStatus(opts.screenCard);
  if (screenDefault !== null) return { statusCardId: screenDefault };

  // 2. flow.default_create_status_id (0n / undefined → unset)
  const flowDefault = opts.flow?.default_create_status_id;
  if (typeof flowDefault === 'bigint' && flowDefault !== 0n) {
    return { statusCardId: flowDefault };
  }

  // 3. First triage by sort_order.
  const triage = firstByPhase(opts.candidateStatuses, 'triage');
  if (triage !== null) return { statusCardId: triage.id };

  // 4. First active by sort_order.
  const active = firstByPhase(opts.candidateStatuses, 'active');
  if (active !== null) return { statusCardId: active.id };

  // 5. Bottom-out — a friendly error for the toast.
  return {
    error: 'flow_no_default',
    message:
      'This project has no valid starting status. Add one in Admin → Statuses.',
  };
}
