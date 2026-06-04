/**
 * `flow_step.list_for_card` API spec — the read backing the TransitionBar (#34).
 *
 * Declared up front and registered via `api.define`, addressed by the
 * declarative data layer through its `flow_step.list_for_card` string key.
 * Targets the REAL `/api/v1/batch` wire and matches the Go handler verbatim
 * (db/schema/functions/flow_step_list_for_card_batch.sql).
 *
 * Wire shape:
 *   in : { card_id }                                   (snake_case)
 *   out: { rows: [{ id, flow_id, flow_name, attribute_def_id, attribute_def_name,
 *                   from_card_id, from_label, from_phase, to_card_id, to_label,
 *                   to_phase, label, requires_role_id, requires_role_name,
 *                   sort_order, allowed }] }
 *        — every id field is a JSON string; the dispatcher revives the
 *          id-shaped keys (`*_id`) to bigint, and the decode here is defensive
 *          about either form. One row per flow_step the card may currently fire
 *          on a flow-bound attribute (typically `status`).
 *
 * The encoder takes the camelCase input the bar assembles and emits the
 * server's `card_id`; the decoder normalises each row into the camelCase
 * `TransitionRow` the bucket helpers + renderer consume.
 */

import type { Api } from '../core/api.js';
import {
  asTransitionPhase,
  type TransitionRow,
} from './transition-buckets.js';

/* -------------------------------------------------------------------------- */
/* Spec key (addressed by the bar's callByName).                               */
/* -------------------------------------------------------------------------- */

export const FLOW_STEP_LIST_FOR_CARD_SPEC = 'flow_step.list_for_card';

/* -------------------------------------------------------------------------- */
/* Input/output types (the camelCase surface the bar assembles / consumes).    */
/* -------------------------------------------------------------------------- */

export interface FlowStepListForCardInput {
  /** The focal card whose available transitions are requested. */
  cardId: bigint;
}

export interface FlowStepListForCardOutput {
  rows: TransitionRow[];
}

/* -------------------------------------------------------------------------- */
/* Decode helpers (defensive, no exceptions on missing fields).                */
/* -------------------------------------------------------------------------- */

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
/** Coerce a wire id (bigint after revival, or number/string) to bigint. */
function asId(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
}
function asStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (v === null || v === undefined) return '';
  return String(v);
}
function asNum(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

function decodeRow(j: Record<string, unknown>): TransitionRow {
  return {
    id: asId(j['id']),
    flowId: asId(j['flow_id']),
    flowName: asStr(j['flow_name']),
    attributeDefId: asId(j['attribute_def_id']),
    attributeDefName: asStr(j['attribute_def_name']),
    fromCardId: asId(j['from_card_id']),
    fromLabel: asStr(j['from_label']),
    fromPhase: asTransitionPhase(j['from_phase']),
    toCardId: asId(j['to_card_id']),
    toLabel: asStr(j['to_label']),
    toPhase: asTransitionPhase(j['to_phase']),
    label: asStr(j['label']),
    requiresRoleId: asId(j['requires_role_id']),
    requiresRoleName: asStr(j['requires_role_name']),
    sortOrder: asNum(j['sort_order']),
    standalone: j['standalone'] === true,
    allowed: j['allowed'] === true,
  };
}

/* -------------------------------------------------------------------------- */
/* Registration.                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Register the `flow_step.list_for_card` spec against `api`. Call once at boot,
 * BEFORE any TransitionBar mounts. Idempotent-by-presence: `api.define` throws
 * on a duplicate key, so skip if it's already registered (e.g. a test harness
 * registered it first).
 */
export function registerTransitionSpecs(api: Api): void {
  if (api.registry.has({ endpoint: 'flow_step', action: 'list_for_card' })) return;
  api.define<FlowStepListForCardInput, FlowStepListForCardOutput>({
    endpoint: 'flow_step',
    action: 'list_for_card',
    encode: (i) => ({ card_id: i.cardId }),
    decode: (raw): FlowStepListForCardOutput => ({
      rows: asArray(asObj(raw)['rows']).map((r) => decodeRow(asObj(r))),
    }),
  });
}
