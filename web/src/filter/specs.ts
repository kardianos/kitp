/**
 * PredicateFilter spec registration.
 *
 * The structured filter editor sources its attribute schema (for the
 * `{ cardType }` config form) from `attribute_def.select` — the SAME spec the
 * admin Attributes screen registers (`admin/specs.ts` `registerAdminSpecs`).
 * The decoder shape matches the Go handler verbatim: `{ rows: AttributeDefRow[] }`
 * where each row carries `name`, `value_type`, `target_card_type_name?`, and
 * the `bound_to` card_type edges the editor filters on.
 *
 * Registration is IDEMPOTENT-by-presence: `api.define` throws on a duplicate
 * key, so we register `attribute_def.select` only when it isn't already in the
 * registry (admin boot may have registered it first; standalone PredicateFilter
 * use registers it here). The decode mirrors `decodeAttributeDefRow` in
 * `admin/specs.ts`.
 */

import type { Api } from '../core/api.js';
import type {
  AttributeDefRow,
  AttributeDefBoundCardType,
  AttributeDefListOutput,
} from '../admin/specs.js';

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (v === null || v === undefined) return '';
  return String(v);
}
function asStrOpt(v: unknown): string | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  return asStr(v);
}
function asBool(v: unknown): boolean {
  return v === true;
}
function asNumOpt(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function decodeBound(j: Record<string, unknown>): AttributeDefBoundCardType {
  const out: AttributeDefBoundCardType = {
    card_type_id: asStr(j['card_type_id']),
    card_type_name: asStr(j['card_type_name']),
  };
  if (j['is_required'] !== undefined) out.is_required = asBool(j['is_required']);
  if (j['is_built_in'] !== undefined) out.is_built_in = asBool(j['is_built_in']);
  const ord = asNumOpt(j['ordering']);
  if (ord !== undefined) out.ordering = ord;
  return out;
}

function decodeRow(j: Record<string, unknown>): AttributeDefRow {
  const out: AttributeDefRow = {
    id: asStr(j['id']),
    name: asStr(j['name']),
    value_type: asStr(j['value_type']),
    is_built_in: asBool(j['is_built_in']),
    bound_to: asArray(j['bound_to']).map((b) => decodeBound(asObj(b))),
  };
  const tgt = asStrOpt(j['target_card_type_name']);
  if (tgt !== undefined) out.target_card_type_name = tgt;
  return out;
}

/**
 * Register the `attribute_def.select` spec the PredicateFilter's `{ cardType }`
 * schema source reads — only if it isn't already registered (the admin specs
 * may have registered it first). Safe to call after `registerAdminSpecs`.
 */
export function registerFilterSpecs(api: Api): void {
  if (api.registry.has({ endpoint: 'attribute_def', action: 'select' })) return;
  api.define<Record<string, never>, AttributeDefListOutput>({
    endpoint: 'attribute_def',
    action: 'select',
    encode: () => ({}),
    decode: (raw): AttributeDefListOutput => ({
      rows: asArray(asObj(raw)['rows']).map((r) => decodeRow(asObj(r))),
    }),
  });
}
