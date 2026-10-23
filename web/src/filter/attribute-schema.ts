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
import { LINK_KINDS, LINK_STATES } from '../task-detail/link-specs.js';
import { type Op, type ValueType, opsForValueType } from './predicate.js';

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
  /**
   * Known values for a text attribute whose values are open slugs (a link's
   * state / kind). The editor offers them in a picker, with the set ops
   * (`in` / `not in`) beside `is` / `is not`. A stored value outside the list
   * still shows and round-trips.
   */
  choices?: ReadonlyArray<{ value: string; label: string }>;
  /** The operators this field takes, when narrower than its value type's set
   *  (the derived task fields below). */
  ops?: readonly Op[];
  /** False for a field the Sort-by picker must not offer. */
  sortable?: boolean;
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

/** Known values per text attribute name — see {@link AttrSchema.choices}. */
export const ATTR_CHOICES: Readonly<Record<string, ReadonlyArray<{ value: string; label: string }>>> = {
  link_state: Object.entries(LINK_STATES).map(([value, info]) => ({ value, label: info.label })),
  link_kind: Object.entries(LINK_KINDS).map(([value, info]) => ({ value, label: info.label })),
};

/**
 * Build one {@link AttrSchema} from a raw `attribute_def` row. The
 * `target_card_type_name` is carried onto `targetCardType` for ref types; a
 * text attr's known values ({@link ATTR_CHOICES}) onto `choices`.
 */
export function attrSchemaFromDef(def: AttributeDefRow): AttrSchema {
  const valueType = normalizeValueType(def.value_type);
  const out: AttrSchema = {
    name: def.name,
    label: friendlyLabel(def.name),
    valueType,
  };
  const choices = ATTR_CHOICES[def.name];
  if (valueType === 'text' && choices !== undefined) out.choices = choices;
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

/** Synthetic, every-card date fields (top-level card columns, not attributes).
 *  Their only meaningful predicate op is the past-window `withinLastDays`.
 *  Surfaced by the FILTER editor (resolveSchema) only — NOT by the attribute-
 *  editing panels (TaskDetail / project properties), which edit real attrs. */
export const TOP_LEVEL_TIMESTAMP_FIELDS: readonly AttrSchema[] = [
  { name: 'last_activity_at', label: 'Last activity', valueType: 'timestamp' },
  { name: 'created_at', label: 'Created', valueType: 'timestamp' },
];

/**
 * Derived fields a card_type's FILTER offers: values the server computes from
 * the card's related cards rather than stores as attributes, filtered and
 * sorted by name like the top-level timestamps. A task's approvals (from its
 * open approval requests, see approval_open.sql):
 *   - approval_state       how its requests stand — votes missing / a reject
 *                          vote / all approved / none open
 *   - approval_waiting_on  "Vote needed from": a request asks them and they
 *                          haven't voted ("Me" = the viewer)
 *   - approval_asked_at    when the oldest open request was made
 */
export const DERIVED_FILTER_FIELDS: Readonly<Record<string, readonly AttrSchema[]>> = {
  task: [
    {
      name: 'approval_state',
      label: 'Approval votes',
      valueType: 'text',
      choices: [
        { value: 'open', label: 'Votes missing' },
        { value: 'rejected', label: 'Has a reject vote' },
        { value: 'approved', label: 'All approved' },
        { value: 'none', label: 'No open request' },
      ],
      ops: ['eq', 'ne', 'in', 'notIn'],
    },
    {
      name: 'approval_waiting_on',
      label: 'Vote needed from',
      valueType: 'card_ref[]',
      targetCardType: 'person',
      ops: ['in', 'notIn'],
      sortable: false,
    },
    { name: 'approval_asked_at', label: 'Approval asked', valueType: 'timestamp' },
  ],
};

/** Whether [name] is a top-level field (a card timestamp or a derived field)
 *  rather than an attribute — what `card.select_with_attributes` orders by
 *  name instead of `attributes.<name>`. */
export function isTopLevelField(name: string): boolean {
  return (
    TOP_LEVEL_TIMESTAMP_FIELDS.some((a) => a.name === name) ||
    Object.values(DERIVED_FILTER_FIELDS).some((fields) => fields.some((a) => a.name === name))
  );
}

/**
 * Child card types a card_type's FILTER reaches through the `<child>.<attr>`
 * leaf path, which the server compiles to "has a live <child> card whose
 * <attr> …" (e.g. `link.link_state = merged`: "has a merged link").
 */
export const CHILD_FILTER_TYPES: Readonly<Record<string, readonly string[]>> = {
  task: ['link'],
};

/**
 * The `<child>.<attr>` filter fields for [cardTypeName]: every attribute bound
 * to each of its {@link CHILD_FILTER_TYPES}, labelled by the child ("Link
 * state" for `link.link_state`; the attr's own `<child>_` prefix is dropped).
 */
export function childFieldsForCardType(
  defs: readonly AttributeDefRow[],
  cardTypeName: string,
): AttrSchema[] {
  const out: AttrSchema[] = [];
  for (const child of CHILD_FILTER_TYPES[cardTypeName] ?? []) {
    const prefix = `${child}_`;
    for (const a of schemaForCardType(defs, child)) {
      const own = a.name.startsWith(prefix) ? a.name.slice(prefix.length) : a.name;
      out.push({
        ...a,
        name: `${child}.${a.name}`,
        label: `${friendlyLabel(child)} ${friendlyLabel(own).toLowerCase()}`,
      });
    }
  }
  return out;
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
  // A {cardType} filter schema = the card_type's attributes, its child cards'
  // attributes (`link.link_state`, …), its derived fields (a task's approvals)
  // PLUS the every-card top-level timestamps (last_activity_at / created_at),
  // so a view can filter e.g. "has a merged link" / "vote needed from me" /
  // "last activity within 15 days" / "closed within 15 days".
  return [
    ...schemaForCardType(defs, source.cardType),
    ...childFieldsForCardType(defs, source.cardType),
    ...(DERIVED_FILTER_FIELDS[source.cardType] ?? []),
    ...TOP_LEVEL_TIMESTAMP_FIELDS,
  ];
}

/** The ops a text attr with known {@link AttrSchema.choices} offers. */
const CHOICE_OPS: readonly Op[] = ['eq', 'ne', 'in', 'notIn', 'exists', 'notExists'];

/** The operators the editor offers for [a]: its own `ops`, else its
 *  value_type's set, or the picker-friendly set when it carries `choices`. */
export function opsForAttr(a: AttrSchema): readonly Op[] {
  if (a.ops !== undefined) return a.ops;
  return a.choices !== undefined ? CHOICE_OPS : opsForValueType(a.valueType);
}

/** Look up one schema entry by attribute name. */
export function findAttr(schema: readonly AttrSchema[], name: string): AttrSchema | undefined {
  return schema.find((a) => a.name === name);
}
