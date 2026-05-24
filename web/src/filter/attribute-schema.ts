/**
 * Attribute-schema model for the structured PredicateFilter.
 *
 * Describes the filterable attributes of a card_type as a flat
 * {@link AttrSchema}[] — `{ name, label, valueType, targetCardType? }`. The
 * editor reads this to populate the attribute selector, derive each leaf's
 * operator list (via the op-catalog in `predicate.ts`), and choose a value
 * editor by `valueType`.
 *
 * Two ways a host supplies the schema (see {@link SchemaSource}):
 *   1. A literal `AttrSchema[]` — when the host already knows the attributes.
 *   2. `{ cardType }` — the editor sources rows from `attribute_def.select`
 *      (the admin spec) and filters to the defs bound to that card_type's
 *      edges, building one {@link AttrSchema} per def.
 *
 * For `card_ref` / `card_ref[]` attrs, the def's `target_card_type_name` is
 * recorded as {@link AttrSchema.targetCardType} so the editor can load option
 * cards (via `card.select_with_attributes` on that card_type) for the ref
 * picker.
 *
 * Lifted from the Svelte client's `attribute_schema.svelte.ts` — the
 * `normalizeValueType` / `friendlyLabel` logic ports verbatim; the rune
 * cache class is dropped (the `web/` editor sources rows declaratively through
 * the data layer and builds the schema with the pure helpers here).
 */

import type { AttributeDefRow } from '../admin/specs.js';
import { type ValueType } from './predicate.js';

/* -------------------------------------------------------------------------- */
/* AttrSchema                                                                 */
/* -------------------------------------------------------------------------- */

/** UI-side description of one filterable attribute. */
export interface AttrSchema {
  /** Wire field name (e.g. `'status'`, `'assignee'`, `'due_date'`). */
  name: string;
  /** User-facing label. Defaults to a title-cased form of `name`. */
  label: string;
  /**
   * Value-type discriminator. Drives the operator list (op-catalog) and the
   * value editor. The well-known set is the {@link ValueType} union; unknown
   * tokens fall through to the text editor + text op set.
   */
  valueType: ValueType | string;
  /**
   * For `card_ref` / `card_ref[]`: the target card_type's name, so the editor
   * can load option cards (`card.select_with_attributes` on this card_type).
   * Undefined for scalar value types.
   */
  targetCardType?: string;
}

/**
 * How a PredicateFilter host supplies its attribute schema:
 *   - a literal list of {@link AttrSchema} rows, OR
 *   - `{ cardType }`, sourced from `attribute_def.select` at fire time.
 */
export type SchemaSource = AttrSchema[] | { cardType: string };

/* -------------------------------------------------------------------------- */
/* Pure builders                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Build a user-facing label from a raw attribute name. Strips a trailing
 * `_ref` (the value editor already conveys "this is a reference"), splits on
 * underscores, and title-cases each token: `milestone_ref` -> `Milestone`,
 * `created_at` -> `Created At`. Ports the Svelte `friendlyLabel`.
 */
export function friendlyLabel(name: string): string {
  let n = name;
  if (n.endsWith('_ref')) n = n.slice(0, -'_ref'.length);
  if (n === '') return name;
  return n
    .split('_')
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

/**
 * Normalise a server `attribute_def.value_type` token into a client
 * {@link ValueType}. `card_ref` / `card_ref[]` pass through unchanged (the
 * target card_type rides separately on {@link AttrSchema.targetCardType});
 * `user_ref` is treated as a `card_ref` (legacy compat). Primitive tokens
 * (`text` / `number` / `bool` / `date`) pass through; anything else stays as-is
 * so the editor's unknown-type fallback kicks in.
 */
export function normalizeValueType(rawType: string): ValueType | string {
  if (rawType === 'card_ref' || rawType === 'card_ref[]') return rawType;
  if (rawType === 'user_ref') return 'card_ref'; // legacy compat
  return rawType;
}

/**
 * Build one {@link AttrSchema} from a raw `attribute_def` row. The
 * `target_card_type_name` is carried onto `targetCardType` for ref types.
 */
export function attrSchemaFromDef(def: AttributeDefRow): AttrSchema {
  const valueType = normalizeValueType(def.value_type);
  const out: AttrSchema = {
    name: def.name,
    label: friendlyLabel(def.name),
    valueType,
  };
  if (
    (valueType === 'card_ref' || valueType === 'card_ref[]') &&
    def.target_card_type_name !== undefined &&
    def.target_card_type_name !== ''
  ) {
    out.targetCardType = def.target_card_type_name;
  }
  return out;
}

/**
 * Build the filterable {@link AttrSchema}[] for a card_type from a list of raw
 * `attribute_def` rows (the `attribute_def.select` output). Keeps only the defs
 * bound to [cardTypeName] (via the def's `bound_to` edges) and maps each to an
 * {@link AttrSchema}, sorted by the bound edge's `ordering` then label so the
 * selector is stable. Pure — exercised directly by `node --test`.
 */
export function schemaForCardType(
  defs: readonly AttributeDefRow[],
  cardTypeName: string,
): AttrSchema[] {
  const bound: Array<{ schema: AttrSchema; ordering: number }> = [];
  for (const def of defs) {
    const edge = def.bound_to.find((b) => b.card_type_name === cardTypeName);
    if (edge === undefined) continue;
    bound.push({
      schema: attrSchemaFromDef(def),
      ordering: edge.ordering ?? Number.MAX_SAFE_INTEGER,
    });
  }
  bound.sort((a, b) => {
    if (a.ordering !== b.ordering) return a.ordering - b.ordering;
    return a.schema.label.localeCompare(b.schema.label);
  });
  return bound.map((b) => b.schema);
}

/**
 * Resolve a {@link SchemaSource} to a concrete {@link AttrSchema}[] given the
 * loaded `attribute_def` rows. A literal list passes through; a `{ cardType }`
 * source is built via {@link schemaForCardType}. The editor calls this once the
 * `attribute_def.select` rows have landed (an empty `defs` yields an empty
 * schema for the `{ cardType }` case — the editor then renders an empty
 * attribute selector rather than throwing).
 */
export function resolveSchema(
  source: SchemaSource,
  defs: readonly AttributeDefRow[],
): AttrSchema[] {
  if (Array.isArray(source)) return source;
  return schemaForCardType(defs, source.cardType);
}

/** Look up one schema entry by attribute name. */
export function findAttr(schema: readonly AttrSchema[], name: string): AttrSchema | undefined {
  return schema.find((a) => a.name === name);
}
