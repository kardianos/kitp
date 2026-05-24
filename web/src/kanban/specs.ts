/**
 * Real API specs for the Kanban vertical slice — declared up front and
 * registered via `api.define`, addressed by the declarative data layer through
 * their `endpoint.action` string key. These target the REAL `/api/v1/batch`
 * wire and match the Go handlers' input/output shapes verbatim:
 *
 *   - card.select_with_attributes  (db/schema/functions/card_select_with_attributes_batch.sql)
 *       in : { card_type_name, parent_card_id?, order?, limit? }   (snake_case)
 *       out: { rows: [{ id, card_type_id, card_type_name, parent_card_id?,
 *                       phase?, attributes:{...} }] }   — ids are JSON strings,
 *            revived to bigint by the dispatcher.
 *   - card.select  (db/schema/functions/card_select_batch.sql)
 *       in : { card_type_name?, parent_card_id? }
 *       out: { rows: [{ id, card_type_id, card_type_name, parent_card_id?, title:null }] }
 *   - attribute.update  (db/schema/functions/attribute_update_batch.sql)
 *       in : { card_id, attribute_name, value }
 *       out: { ok, activity_id, prev_value? }
 *
 * The encoders take the framework's camelCase input objects (assembled by the
 * declarative InputSpec resolver) and emit the server's snake_case keys — the
 * same posture as the Svelte client's `handlers.ts`. The decoders normalise the
 * decoded rows into the `web/` card model (see kanban-helpers.ts). bigint
 * revival of the wire ids happens in the dispatcher; the `milestone_ref`
 * card_ref attribute is registered there too so its value revives to bigint.
 */

import type { Api } from '../core/api.js';
import { registerCardRefAttr } from '../core/dispatch.js';
import type { CardWithAttrs } from './kanban-helpers.js';
import type { CardWherePredicate } from '../projects/project-helpers.js';
import type { WireNode } from '../filter/predicate.js';

/* -------------------------------------------------------------------------- */
/* Spec keys (addressed by the declarative binding tables).                    */
/* -------------------------------------------------------------------------- */

export const SPEC = {
  selectWithAttributes: 'card.select_with_attributes',
  select: 'card.select',
  attributeUpdate: 'attribute.update',
} as const;

/* -------------------------------------------------------------------------- */
/* Input/output types (the camelCase surface the data table assembles).        */
/* -------------------------------------------------------------------------- */

export interface SelectWithAttributesInput {
  cardTypeName: string;
  parentCardId?: bigint;
  /**
   * Flat-AND predicate leaves (compiled server-side by
   * `card_compile_predicate.sql`). User-facing project lists ship the
   * `is_template != true` leaf here (see projects/project-helpers.ts).
   */
  where?: CardWherePredicate[];
  /**
   * A full v2 predicate tree (`card_compile_predicate.sql`'s `tree` field) for
   * filters that aren't a flat AND of leaves — OR/NOT groups, nesting. Hosts
   * project a flat-AND `Predicate` to `where[]` (composing with the title-search
   * leaf) and fall back to `tree` only for the structured cases the PredicateFilter
   * builds. `where` and `tree` are mutually exclusive in practice; if both are set
   * the server ANDs them (the encoder forwards both verbatim).
   */
  tree?: WireNode;
  order?: Array<{ field: string; direction?: string }>;
  limit?: number;
}
export interface SelectWithAttributesOutput {
  rows: CardWithAttrs[];
}

export interface SelectInput {
  cardTypeName?: string;
  parentCardId?: bigint;
}
export interface CardRow {
  id: bigint;
  card_type_id: bigint;
  card_type_name: string;
  parent_card_id?: bigint;
  title?: string | null;
}
export interface SelectOutput {
  rows: CardRow[];
}

export interface AttributeUpdateInput {
  cardId: bigint;
  attributeName: string;
  value: unknown;
}
export interface AttributeUpdateOutput {
  ok: boolean;
  activityId: bigint;
  prevValue?: unknown;
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
function asIdOpt(v: unknown): bigint | undefined {
  if (v === null || v === undefined) return undefined;
  return asId(v);
}

function decodeCardWithAttrs(j: Record<string, unknown>): CardWithAttrs {
  const phaseRaw = j['phase'];
  const phase: CardWithAttrs['phase'] =
    phaseRaw === 'triage' || phaseRaw === 'terminal' || phaseRaw === 'active'
      ? phaseRaw
      : undefined;
  const out: CardWithAttrs = {
    id: asId(j['id']),
    card_type_id: asId(j['card_type_id']),
    card_type_name: typeof j['card_type_name'] === 'string' ? j['card_type_name'] : '',
    attributes: asObj(j['attributes']),
  };
  const parent = asIdOpt(j['parent_card_id']);
  if (parent !== undefined) out.parent_card_id = parent;
  if (phase !== undefined) out.phase = phase;
  return out;
}

function decodeCardRow(j: Record<string, unknown>): CardRow {
  const out: CardRow = {
    id: asId(j['id']),
    card_type_id: asId(j['card_type_id']),
    card_type_name: typeof j['card_type_name'] === 'string' ? j['card_type_name'] : '',
  };
  const parent = asIdOpt(j['parent_card_id']);
  if (parent !== undefined) out.parent_card_id = parent;
  if (typeof j['title'] === 'string') out.title = j['title'];
  return out;
}

/* -------------------------------------------------------------------------- */
/* Registration.                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Register the three real specs against `api`. Call once at boot, BEFORE any
 * control mounts (the data layer resolves specs by key at fire time). Also
 * primes the dispatcher's card_ref attribute registry so the kanban axis
 * attribute (`milestone_ref`) revives its value to bigint regardless of boot
 * ordering — the exact silent bug the Svelte client hit.
 */
export function registerKanbanSpecs(api: Api): void {
  // Axis attribute is a card_ref → revive its value to bigint on the wire.
  registerCardRefAttr('milestone_ref', false);

  api.define<SelectWithAttributesInput, SelectWithAttributesOutput>({
    endpoint: 'card',
    action: 'select_with_attributes',
    encode: (i) => {
      const m: Record<string, unknown> = { card_type_name: i.cardTypeName };
      if (i.parentCardId !== undefined) m['parent_card_id'] = i.parentCardId;
      // Forward the predicate leaves verbatim — same `where` field the Go
      // handler + Svelte client use (e.g. the `is_template != true` exclusion).
      if (i.where !== undefined && i.where.length > 0) m['where'] = i.where;
      // The structured v2 predicate tree (OR/NOT/nested). Forwarded verbatim;
      // the server compiles it via card_compile_predicate.sql's `tree` field.
      if (i.tree !== undefined && i.tree !== null) m['tree'] = i.tree;
      if (i.order !== undefined && i.order.length > 0) m['order'] = i.order;
      if (i.limit !== undefined) m['limit'] = i.limit;
      return m;
    },
    decode: (raw): SelectWithAttributesOutput => ({
      rows: asArray(asObj(raw)['rows']).map((r) => decodeCardWithAttrs(asObj(r))),
    }),
  });

  api.define<SelectInput, SelectOutput>({
    endpoint: 'card',
    action: 'select',
    encode: (i) => {
      const m: Record<string, unknown> = {};
      if (i.cardTypeName !== undefined) m['card_type_name'] = i.cardTypeName;
      if (i.parentCardId !== undefined) m['parent_card_id'] = i.parentCardId;
      return m;
    },
    decode: (raw): SelectOutput => ({
      rows: asArray(asObj(raw)['rows']).map((r) => decodeCardRow(asObj(r))),
    }),
  });

  api.define<AttributeUpdateInput, AttributeUpdateOutput>({
    endpoint: 'attribute',
    action: 'update',
    encode: (i) => ({
      card_id: i.cardId,
      attribute_name: i.attributeName,
      // value is always present: the server distinguishes "missing key" (no-op)
      // from "null" (clear the attribute).
      value: i.value === undefined ? null : i.value,
    }),
    decode: (raw): AttributeUpdateOutput => {
      const j = asObj(raw);
      const out: AttributeUpdateOutput = {
        ok: j['ok'] === true,
        activityId: asId(j['activity_id']),
      };
      if (j['prev_value'] !== undefined && j['prev_value'] !== null) {
        out.prevValue = j['prev_value'];
      }
      return out;
    },
  });
}
