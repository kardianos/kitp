/**
 * Default-create-status resolution (Gate 6 of FLOW_AND_SCREEN_KERNEL).
 *
 * QuickEntry pulls the new task's status by walking, in order:
 *
 *   1. screen.default_create_status              ← per-screen override (card_ref → status)
 *   2. flow.default_create_status_id             ← per-flow default
 *   3. first status with phase='triage'  by sort_order
 *   4. first status with phase='active'  by sort_order
 *   5. fail with code='flow_no_default'
 *
 * The resolver is intentionally pure: callers gather the inputs (screen
 * card, optional flow row, candidate status cards) and feed them in. The
 * function returns either the resolved status card id or a structured
 * error suitable for surfacing via toast.
 *
 * No I/O lives here. Wiring lives in QuickEntryOverlay / the screen
 * containers that already have these values in memory.
 */

import type { CardWithAttrs, ID } from '../reg/types.js';

/**
 * Subset of the server's `flow.list` row shape this module needs. We
 * deliberately do NOT import a `FlowRow` from `reg/types` — no client
 * flow handlers exist yet — and instead declare the minimal contract
 * here so screens passing the value can build it without depending on
 * the wider flow registration arriving.
 *
 * `default_create_status_id` matches the server's int64 → bigint
 * convention (with 0n meaning "unset"; the server's wire encoder omits
 * the zero value when serialising).
 */
export interface FlowRow {
  id: ID;
  attribute_def_id: ID;
  scope_card_id: ID;
  /** 0n / undefined when no per-flow default is set. */
  default_create_status_id?: ID;
}

/** Inputs for the resolver. */
export interface ResolveDefaultCreateStatusOpts {
  /** The screen the user is on (may be null / undefined when there's
   *  no screen scope, e.g. an MCP / external caller). */
  screenCard?: CardWithAttrs | null;
  /** The flow bound via `screen.flow_ref` (may be null when no flow). */
  flow?: FlowRow | null;
  /**
   * Every status card in the project (or the wider candidate set
   * available to the resolver), with phase + sort_order. The function
   * sorts the inputs internally so callers do not need to pre-sort.
   */
  candidateStatuses: CardWithAttrs[];
}

/** Successful resolution: the status card id to stamp on the new task. */
export interface ResolveDefaultCreateStatusOk {
  statusCardId: ID;
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
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Read the `sort_order` attribute as a finite number (NaN-safe), with
 * Number.POSITIVE_INFINITY as the fallback so unsorted rows sink to
 * the back rather than jumping to the front.
 */
function readSortOrder(c: CardWithAttrs): number {
  const v = c.attributes['sort_order'];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // Some pipelines hand us sort_order as a string (the wire encoder
  // serialises numbers as JSON numbers, but tests / fixtures vary);
  // accept a string-of-digits to keep the resolver permissive.
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Read the `default_create_status` attribute off a screen card. The
 * value lives as a `card_ref` so the wire shape is a bigint id, but we
 * accept number / string-of-digits as defensive forms (the dispatcher
 * normalises ids, fixtures sometimes don't).
 */
function readScreenDefaultStatus(
  screenCard: CardWithAttrs | null | undefined,
): ID | null {
  if (!screenCard) return null;
  const v = screenCard.attributes['default_create_status'];
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) {
    try {
      return BigInt(v);
    } catch {
      /* fall through */
    }
  }
  return null;
}

/**
 * Pick the lowest-sort_order candidate with the given phase. Ties on
 * sort_order break on id (ascending) so the result is deterministic.
 * Returns null when no candidate matches.
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
    if (s === bestSort && best !== null && c.id < best.id) {
      best = c;
    }
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the status card id a fresh `card.insert` should stamp.
 * Returns the chosen id, or `{ error: 'flow_no_default', message }` if
 * the chain bottoms out without a candidate.
 *
 * The caller threads the result into `card.insert`'s `attributes`
 * payload as `{ status: <statusCardId> }`. The server validates it as a
 * normal required-edge attribute.
 */
export function resolveDefaultCreateStatus(
  opts: ResolveDefaultCreateStatusOpts,
): ResolveDefaultCreateStatusResult {
  // 1. screen.default_create_status
  const screenDefault = readScreenDefaultStatus(opts.screenCard);
  if (screenDefault !== null) {
    return { statusCardId: screenDefault };
  }

  // 2. flow.default_create_status_id (treat 0n / undefined as "unset")
  const flowDefault = opts.flow?.default_create_status_id;
  if (typeof flowDefault === 'bigint' && flowDefault !== 0n) {
    return { statusCardId: flowDefault };
  }

  // 3. First triage by sort_order.
  const triage = firstByPhase(opts.candidateStatuses, 'triage');
  if (triage !== null) {
    return { statusCardId: triage.id };
  }

  // 4. First active by sort_order.
  const active = firstByPhase(opts.candidateStatuses, 'active');
  if (active !== null) {
    return { statusCardId: active.id };
  }

  // 5. Bottom-out — surface a friendly error.
  return {
    error: 'flow_no_default',
    message:
      'This project has no valid starting status. Add one in Admin → Statuses.',
  };
}
