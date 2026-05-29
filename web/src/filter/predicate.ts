/**
 * Predicate AST + op-catalog for the structured PredicateFilter.
 *
 * Lifted from the Svelte client's `client/src/filter/predicate.ts` and
 * re-expressed against the `web/` framework conventions. NOTHING here imports
 * from `client/` or touches the DOM / signals — these are pure functions
 * exercised directly by `node --test`.
 *
 * A {@link Predicate} is either:
 *   - {@link PredicateLeaf}:  `<attr> <op> <value(s)>`
 *   - {@link PredicateGroup}: `(child1) AND (child2)` (or OR / NOT)
 *
 * Both shapes are JSON-round-trippable so a predicate can flow into saved
 * views, URLs, and across the wire to `card.select_with_attributes` (`tree:`
 * field). {@link toWire} produces EXACTLY the shape
 * `db/schema/functions/card_compile_predicate.sql` consumes; {@link fromWire}
 * is its inverse.
 *
 * NOT groups must have exactly one child; {@link fromWire} enforces that
 * invariant on decode (the editor enforces it on edit). Empty AND groups are
 * vacuously true; empty OR groups are vacuously false (the SQL compiler
 * agrees — see the empty-children dispatch in card_compile_predicate.sql).
 */

/* -------------------------------------------------------------------------- */
/* Operators                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Operators understood by every layer (UI -> wire -> server SQL). The set
 * matches the op dispatch in `card_compile_predicate.sql` 1:1.
 */
export type Op =
  | 'eq'
  | 'ne'
  | 'in'
  | 'notIn'
  | 'exists'
  | 'notExists'
  | 'contains'
  | 'notTerminal'
  | 'hasPhase'
  | 'parentStatusPhase'
  | 'snippet'
  | 'beforeToday'
  | 'withinDays'
  | 'withinLastDays';

/**
 * Wire-string for each operator. These values MUST match the `op` field the
 * SQL compiler dispatches on (`db/schema/functions/card_compile_predicate.sql`).
 * Don't rename keys/values — they're the wire contract.
 */
export const OP_TO_WIRE: Readonly<Record<Op, string>> = {
  eq: '=',
  ne: '!=',
  in: 'in',
  notIn: 'not in',
  exists: 'exists',
  notExists: 'not exists',
  contains: 'contains',
  notTerminal: 'not terminal',
  hasPhase: 'has_phase',
  parentStatusPhase: 'parent_status_phase',
  snippet: 'snippet',
  beforeToday: 'before_today',
  withinDays: 'within_days',
  withinLastDays: 'within_last_days',
};

const WIRE_TO_OP: Readonly<Record<string, Op>> = {
  '=': 'eq',
  eq: 'eq',
  '!=': 'ne',
  ne: 'ne',
  in: 'in',
  'not in': 'notIn',
  exists: 'exists',
  'not exists': 'notExists',
  contains: 'contains',
  'not terminal': 'notTerminal',
  has_phase: 'hasPhase',
  parent_status_phase: 'parentStatusPhase',
  snippet: 'snippet',
  before_today: 'beforeToday',
  within_days: 'withinDays',
  within_last_days: 'withinLastDays',
};

/** Returns the wire string for [op]. Inverse of {@link opFromWire}. */
export function opToWire(op: Op): string {
  return OP_TO_WIRE[op];
}

/**
 * Parses a wire string into an {@link Op}. Accepts both the v1 aliases
 * (`=` / `eq`, `!=` / `ne`) the SQL compiler normalises. Throws on unknown
 * operators so server-issued JSON cannot silently smuggle in an operator the
 * client cannot render.
 */
export function opFromWire(s: string): Op {
  const v = WIRE_TO_OP[s];
  if (v === undefined) {
    throw new Error(`unknown predicate operator: ${JSON.stringify(s)}`);
  }
  return v;
}

/** Whether [op] takes no value, a single value, or a list. */
export type OpArity = 'none' | 'single' | 'multi';

export function opArity(op: Op): OpArity {
  switch (op) {
    case 'eq':
    case 'ne':
    case 'contains':
    case 'snippet':
    case 'withinDays':
    case 'withinLastDays':
      return 'single';
    case 'in':
    case 'notIn':
    case 'hasPhase':
    case 'parentStatusPhase':
      return 'multi';
    case 'exists':
    case 'notExists':
    case 'notTerminal':
    case 'beforeToday':
      return 'none';
  }
}

/**
 * Friendly display label for an op in the operator selector. Pure label data;
 * the wire string (`=`, `not in`, `has_phase`, ...) is what crosses the
 * network — this is only the editor's display text.
 */
export const OP_LABELS: Readonly<Record<Op, string>> = {
  eq: 'is',
  ne: 'is not',
  in: 'is any of',
  notIn: 'is none of',
  exists: 'is set',
  notExists: 'is not set',
  contains: 'contains',
  notTerminal: 'is open',
  hasPhase: 'has phase',
  parentStatusPhase: "parent's status is",
  snippet: 'named filter',
  beforeToday: 'is before today',
  withinDays: 'within next (days)',
  withinLastDays: 'within last (days)',
};

export function opLabel(op: Op): string {
  return OP_LABELS[op];
}

/* -------------------------------------------------------------------------- */
/* Value types + op-catalog keyed by value_type                               */
/* -------------------------------------------------------------------------- */

/**
 * The well-known value-type discriminators an attribute schema may carry.
 * `card_ref` / `card_ref[]` mirror the server's `attribute_def.value_type`
 * tokens; the others are scalar JSON types. The catalog below keys the
 * allowed operators on these tokens.
 */
export type ValueType = 'text' | 'number' | 'bool' | 'date' | 'timestamp' | 'card_ref' | 'card_ref[]';

/**
 * The op-catalog: which operators each value_type exposes in the editor, and
 * (via {@link opArity}) how many values each op carries. Shared across the
 * quick-filter bar and the tree editor so the same attribute exposes the same
 * affordances everywhere.
 *
 *   - text:        eq / ne / contains / exists / notExists
 *   - number:      eq / ne / exists / notExists
 *   - bool:        eq / ne / exists / notExists
 *   - date:        eq / ne / exists / notExists / beforeToday / withinDays
 *   - card_ref:    eq / ne / in / notIn / hasPhase / exists / notExists
 *   - card_ref[]:  in / notIn / hasPhase / exists / notExists
 *
 * `hasPhase` dereferences the ref target and matches its `phase` column — only
 * meaningful for refs, never scalars. The relative-date ops are scoped to
 * `date` so every other attribute's operator list stays short.
 */
export const OPS_BY_VALUE_TYPE: Readonly<Record<ValueType, readonly Op[]>> = {
  text: ['eq', 'ne', 'contains', 'exists', 'notExists'],
  number: ['eq', 'ne', 'exists', 'notExists'],
  bool: ['eq', 'ne', 'exists', 'notExists'],
  date: ['eq', 'ne', 'exists', 'notExists', 'beforeToday', 'withinDays', 'withinLastDays'],
  // Top-level card timestamps (last_activity_at / created_at) — only the
  // past-window relative op is meaningful (they always exist; the equality /
  // ISO-text ops target attribute_values, which these aren't).
  timestamp: ['withinLastDays'],
  card_ref: ['eq', 'ne', 'in', 'notIn', 'hasPhase', 'exists', 'notExists'],
  'card_ref[]': ['in', 'notIn', 'hasPhase', 'exists', 'notExists'],
};

/**
 * The reserved dynamic value token for a person-typed card_ref filter
 * (assignee / originator) meaning "the current viewer". Stored verbatim in a
 * leaf's `values` (and persisted in saved filters) so a shared screen resolves
 * PER-VIEWER; the server's `_resolve_me_tokens` pre-pass rewrites it to the
 * caller's person card id at query time. The client never resolves it (keeping
 * filters portable across users).
 */
export const ME_REF_TOKEN = '@me';

/**
 * Operators allowed for [valueType]. Unknown value types fall back to the
 * `text` op set so a leaf still edits (matching the Svelte ValueInput's text
 * fallback for unrecognised types).
 */
export function opsForValueType(valueType: string): readonly Op[] {
  return OPS_BY_VALUE_TYPE[valueType as ValueType] ?? OPS_BY_VALUE_TYPE.text;
}

/* -------------------------------------------------------------------------- */
/* Phases (closed set for has_phase / parent_status_phase / not terminal)     */
/* -------------------------------------------------------------------------- */

/**
 * Closed set of `phase` values understood by `has_phase` (the SQL compiler
 * rejects anything else). Surfaced as a type + a runtime array so the editor
 * can render checkboxes without hard-coding the list.
 */
export type Phase = 'triage' | 'active' | 'terminal';
export const PHASES: readonly Phase[] = ['triage', 'active', 'terminal'] as const;
export function isPhase(v: unknown): v is Phase {
  return v === 'triage' || v === 'active' || v === 'terminal';
}

/* -------------------------------------------------------------------------- */
/* AST                                                                        */
/* -------------------------------------------------------------------------- */

export interface PredicateLeaf {
  kind: 'leaf';
  attr: string;
  op: Op;
  /** Single-value ops use values[0]; multi-value ops use values; no-value ops omit. */
  values?: unknown[];
}

export interface PredicateGroup {
  kind: 'group';
  connective: 'and' | 'or' | 'not';
  children: Predicate[];
}

export type Predicate = PredicateLeaf | PredicateGroup;

/* -------------------------------------------------------------------------- */
/* Wire encode / decode                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The wire shape of a predicate node — exactly what `card_compile_predicate.sql`
 * consumes. A group emits `{ connective, children }`; a leaf emits
 * `{ attr, op, values? }` (op as the wire string via {@link OP_TO_WIRE}).
 * Empty `values` arrays are omitted so `exists` / `not exists` payloads stay
 * minimal (matching the SQL compiler's no-value ops).
 *
 * This is structurally compatible with {@link CardWherePredicate}: a wire leaf
 * IS a `CardWherePredicate`, and a `CardWherePredicate[]` is the flat top-level
 * AND the `where[]` field carries.
 */
export interface WireNode {
  // Group fields.
  connective?: 'and' | 'or' | 'not';
  children?: WireNode[];
  // Leaf fields.
  attr?: string;
  op?: string;
  value?: unknown;
  values?: unknown[];
  /** Compound v1 shape `{ and: [...] }` the legacy where[] also accepts. */
  and?: WireNode[];
}

/**
 * Encode a {@link Predicate} to its wire shape (`tree` field on
 * `card.select_with_attributes`). Inverse of {@link fromWire}.
 */
export function toWire(p: Predicate): WireNode {
  if (p.kind === 'leaf') {
    const m: WireNode = { attr: p.attr, op: OP_TO_WIRE[p.op] };
    if (p.values !== undefined && p.values.length > 0) {
      m.values = p.values.slice();
    }
    return m;
  }
  return {
    connective: p.connective,
    children: p.children.map(toWire),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Inverse of {@link toWire}. Decodes a wire node (group or leaf, including the
 * v1 single-`value` and `{ and: [...] }` shapes) into a {@link Predicate}.
 * Throws on unknown shapes / operators so server drift surfaces immediately.
 */
export function fromWire(raw: unknown): Predicate {
  if (!isPlainObject(raw)) {
    throw new Error('predicate wire node must be an object');
  }

  // Connective group.
  if ('connective' in raw && raw.connective !== undefined && raw.connective !== '') {
    const c = raw.connective;
    if (c !== 'and' && c !== 'or' && c !== 'not') {
      throw new Error(`unknown group connective: ${JSON.stringify(c)}`);
    }
    const children = decodeChildren(raw.children);
    if (c === 'not' && children.length !== 1) {
      throw new Error(`NOT group must have exactly one child (got ${children.length})`);
    }
    return { kind: 'group', connective: c, children };
  }

  // v1 compound shape: { and: [...] }.
  if ('and' in raw && Array.isArray(raw.and)) {
    return { kind: 'group', connective: 'and', children: decodeChildren(raw.and) };
  }

  // Leaf.
  const attrRaw = raw.attr;
  if (typeof attrRaw !== 'string') {
    throw new Error('leaf attr must be a string');
  }
  const opRaw = raw.op;
  // Default op '=' matches the SQL compiler's COALESCE(node->>'op', '=').
  const op = opFromWire(typeof opRaw === 'string' && opRaw !== '' ? opRaw : '=');
  const leaf: PredicateLeaf = { kind: 'leaf', attr: attrRaw, op };
  // v2 `values` takes precedence; fall back to v1 single `value`.
  if (raw.values !== undefined && raw.values !== null) {
    if (!Array.isArray(raw.values)) {
      throw new Error('leaf values must be an array');
    }
    leaf.values = raw.values.slice();
  } else if ('value' in raw && raw.value !== undefined) {
    leaf.values = [raw.value];
  }
  return leaf;
}

function decodeChildren(raw: unknown): Predicate[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('group children must be an array');
  }
  return raw.map(fromWire);
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `true` when [p] is structurally valid: NOT groups carry exactly one child,
 * leaves carry a non-empty attr, and (for non-`none`-arity ops) the editor is
 * free to leave the value empty (an empty value compiles to a vacuous leaf
 * server-side, never an error). Recurses into every child.
 */
export function isValid(p: Predicate): boolean {
  if (p.kind === 'leaf') {
    return p.attr.length > 0;
  }
  if (p.connective === 'not' && p.children.length !== 1) return false;
  return p.children.every(isValid);
}

/* -------------------------------------------------------------------------- */
/* Flat-AND helpers (backward-compat with the where[] field)                  */
/* -------------------------------------------------------------------------- */

/**
 * `true` when [p] is a flat top-level AND of leaves — the shape the quick
 * `where[]` field can carry. A bare leaf also qualifies.
 */
export function isFlatAndOfLeaves(p: Predicate): boolean {
  if (p.kind === 'leaf') return true;
  if (p.connective !== 'and') return false;
  return p.children.every((c) => c.kind === 'leaf');
}

/**
 * Project [p] to a flat `CardWherePredicate[]` (the `where[]` wire field), when
 * it is a flat AND of leaves (or a single leaf). Returns null otherwise — the
 * caller should fall back to the v2 `tree` field. Each emitted leaf is the wire
 * shape, structurally a {@link CardWherePredicate}.
 */
export function toWhereLeaves(p: Predicate): CardWherePredicate[] | null {
  if (!isFlatAndOfLeaves(p)) return null;
  if (p.kind === 'leaf') return [toWire(p) as CardWherePredicate];
  return p.children.map((c) => toWire(c) as CardWherePredicate);
}

/**
 * Wrap [leaves] in a top-level AND group. Single-leaf input returns the leaf
 * itself (no needless wrapper); empty input returns an empty AND group
 * (vacuously true). Inverse-ish of {@link toWhereLeaves} for the editor seed.
 */
export function fromWhereLeaves(leaves: CardWherePredicate[]): Predicate {
  const parsed = leaves.map((l) => fromWire(l) as PredicateLeaf);
  if (parsed.length === 1) return parsed[0]!;
  return { kind: 'group', connective: 'and', children: parsed };
}

/* -------------------------------------------------------------------------- */
/* Quick-chip leaves (top-level `attr in [...]` slots in the root AND)         */
/* -------------------------------------------------------------------------- */

/**
 * The quick-filter chips own one TOP-LEVEL leaf per attribute in the root AND
 * group of `screen.predicate`. These helpers find / upsert / remove that leaf
 * WITHOUT disturbing the rest of the tree (the Advanced editor's nested groups,
 * other attrs' chip leaves, the search leaf, …), so the quick chips and the
 * Advanced editor edit ONE consistent predicate.
 *
 * "Top-level" means: a bare leaf for [attr], or a direct child leaf of a root
 * AND group whose `attr` matches. Nested-group leaves (inside an OR / NOT the
 * Advanced editor built) are intentionally NOT touched — those are the Advanced
 * surface's domain, and a chip only manages the flat AND slot.
 */

/** A normalised view of the root: the connective + its direct children. */
interface RootView {
  /** True when the predicate is already (or normalises to) a top-level AND. */
  isAnd: boolean;
  /** The direct children to treat as the flat AND members. */
  children: Predicate[];
}

/** Project any predicate into a root-AND view (a bare leaf becomes `[leaf]`). */
function rootView(p: Predicate | null): RootView {
  if (p === null) return { isAnd: true, children: [] };
  if (p.kind === 'leaf') return { isAnd: true, children: [p] };
  if (p.connective === 'and') return { isAnd: true, children: p.children.slice() };
  // A top-level OR / NOT — wrap it so a chip leaf ANDs alongside the whole tree.
  return { isAnd: false, children: [p] };
}

/** Re-assemble a root view's children into a {@link Predicate} (or null). */
function fromRootChildren(children: Predicate[]): Predicate | null {
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { kind: 'group', connective: 'and', children };
}

/**
 * The TOP-LEVEL leaf for [attr] in [p] (a bare matching leaf, or a direct AND
 * child leaf), or null. Used by the chips to read their current selection back
 * out of the shared predicate — so an edit from ANY surface (Advanced, a named
 * filter, another chip) reflects in the chip's active state.
 */
export function topLevelLeafForAttr(p: Predicate | null, attr: string): PredicateLeaf | null {
  if (p === null) return null;
  // `has_phase` leaves are the phase-scope toggle's slot (see {@link
  // topLevelPhases}); a chip owns the value-membership leaf for [attr], so we
  // skip a same-attr `has_phase` leaf here and the two coexist.
  if (p.kind === 'leaf') return p.attr === attr && p.op !== 'hasPhase' ? p : null;
  if (p.connective !== 'and') return null;
  for (const c of p.children) {
    if (c.kind === 'leaf' && c.attr === attr && c.op !== 'hasPhase') return c;
  }
  return null;
}

/**
 * Replace (or append) the top-level leaf for [newLeaf.attr] in [p]. Any other
 * top-level leaf for the same attr is dropped first (so a chip owns exactly one
 * slot); the rest of the tree is preserved verbatim. A non-AND root (OR / NOT)
 * is wrapped so the new leaf ANDs alongside it. Backward-compatible with the
 * flat-AND `where[]` shape: a flat-AND input stays flat-AND.
 */
export function upsertTopLevelLeaf(p: Predicate | null, newLeaf: PredicateLeaf): Predicate {
  const { children } = rootView(p);
  // Drop the existing value-membership leaf for this attr, but PRESERVE a
  // same-attr `has_phase` leaf — that's the phase-scope toggle's slot, managed
  // by {@link withTopLevelPhases}, so a chip pick never clobbers it.
  const kept = children.filter((c) => !(c.kind === 'leaf' && c.attr === newLeaf.attr && c.op !== 'hasPhase'));
  kept.push(newLeaf);
  return fromRootChildren(kept) as Predicate; // non-empty: we just pushed one
}

/**
 * Drop the top-level leaf for [attr] from [p]. Returns null when the predicate
 * becomes empty. Nested-group leaves for [attr] are left untouched (Advanced's
 * domain). Inverse of {@link upsertTopLevelLeaf} for the clear-X / empty pick.
 */
export function removeTopLevelLeaf(p: Predicate | null, attr: string): Predicate | null {
  if (p === null) return null;
  const { children } = rootView(p);
  // Preserve a same-attr `has_phase` leaf (the phase-scope toggle's slot).
  const kept = children.filter((c) => !(c.kind === 'leaf' && c.attr === attr && c.op !== 'hasPhase'));
  return fromRootChildren(kept);
}

/* -------------------------------------------------------------------------- */
/* Phase-scope toggle slot — a single top-level `<attr> has_phase [phases]`     */
/* leaf (OR-semantics over the phase set). Read/written by the filter bar's     */
/* phase toggles; coexists with the value-membership chip leaf for the same     */
/* attr (the chip helpers above skip `has_phase`).                              */
/* -------------------------------------------------------------------------- */

/** The selected phases from the top-level `<attr> has_phase […]` leaf (default
 *  attr 'status'), or [] when no phase scope is active. */
export function topLevelPhases(p: Predicate | null, attr = 'status'): Phase[] {
  if (p === null) return [];
  const { children } = rootView(p);
  for (const c of children) {
    if (c.kind === 'leaf' && c.attr === attr && c.op === 'hasPhase') {
      return (c.values ?? []).filter((v): v is Phase => (PHASES as readonly string[]).includes(v as string));
    }
  }
  return [];
}

/** Set the top-level `<attr> has_phase [phases]` leaf (empty → remove it),
 *  preserving every other top-level leaf (incl. an `<attr> in […]` chip). */
export function withTopLevelPhases(
  p: Predicate | null,
  phases: readonly Phase[],
  attr = 'status',
): Predicate | null {
  const { children } = rootView(p);
  const kept = children.filter((c) => !(c.kind === 'leaf' && c.attr === attr && c.op === 'hasPhase'));
  if (phases.length > 0) kept.push(leaf(attr, 'hasPhase', phases.slice()));
  return fromRootChildren(kept);
}

/* -------------------------------------------------------------------------- */
/* Constructor helpers                                                        */
/* -------------------------------------------------------------------------- */

export function leaf(attr: string, op: Op, values?: unknown[]): PredicateLeaf {
  const l: PredicateLeaf = { kind: 'leaf', attr, op };
  if (values !== undefined && values.length > 0) l.values = values.slice();
  return l;
}

export function group(connective: 'and' | 'or' | 'not', children: Predicate[]): PredicateGroup {
  return { kind: 'group', connective, children: children.slice() };
}

export function andOf(children: Predicate[]): PredicateGroup {
  return group('and', children);
}
export function orOf(children: Predicate[]): PredicateGroup {
  return group('or', children);
}
export function notOf(child: Predicate): PredicateGroup {
  return group('not', [child]);
}

/** An empty root group (vacuously-true AND) the editor seeds when there's no predicate. */
export function emptyRoot(): PredicateGroup {
  return { kind: 'group', connective: 'and', children: [] };
}

/* -------------------------------------------------------------------------- */
/* applySearchFilter — the shared search + Advanced predicate composer the    */
/* Kanban / Grid / Inbox `applyFilter` methods all dispatch to.               */
/* -------------------------------------------------------------------------- */

/** The fields the user may search across. The server's `contains` op
 *  special-cases `comments` (it joins against `comment_body`), so the wire
 *  carries the same attribute names verbatim — no client-side rewrite. */
export const SEARCH_FIELD_VALUES = ['title', 'description', 'comments'] as const;
export type SearchField = (typeof SEARCH_FIELD_VALUES)[number];
const SEARCH_FIELDS_SET: ReadonlySet<string> = new Set(SEARCH_FIELD_VALUES as readonly string[]);

/**
 * Project the shared search needle + the chosen search fields + the Advanced
 * structured predicate down to the `card.select_with_attributes` wire fields
 * (`where[]` / `tree`).
 *
 * Single-field search (e.g. just title) compose into the flat `where[]` so the
 * common case stays as cheap as before. A multi-field search (title +
 * description, …) wraps the needle in an OR group and rides the v2 `tree`
 * field; the user's structured predicate is ANDed in alongside it.
 *
 * Empty inputs return `undefined` for each leaf so the encoder omits them.
 */
export function applySearchFilter(
  search: string,
  fields: readonly string[],
  predicate: Predicate | null,
): { where: WireNode[] | undefined; tree: WireNode | undefined } {
  const needle = search.trim();
  const validFields = needle === ''
    ? []
    : fields.filter((f): f is SearchField => SEARCH_FIELDS_SET.has(f));
  // Fall back to title when the caller passed an empty / unknown set but DID
  // type a query — otherwise the search input would be silently inert.
  const effective = needle === '' ? [] : validFields.length > 0 ? validFields : ['title'];

  // Build the search clause. The v2 `tree` field's Go-side leaf struct only
  // carries `Values []` (plural) — the singular `value` key is silently dropped
  // on unmarshal, which surfaces as "contains: missing value" from the
  // predicate compiler. The v1 `where[]` Predicate struct still accepts both,
  // so the where-leaf path may stay singular; the tree-leaf path must use
  // the plural form. The SQL fallback compiler (card_compile_predicate.sql)
  // handles both shapes — only the Go path is strict.
  let searchLeaves: WireNode[] = [];
  let searchTree: WireNode | null = null;
  if (effective.length === 1) {
    searchLeaves = [{ attr: effective[0], op: 'contains', value: needle }];
  } else if (effective.length > 1) {
    searchTree = {
      connective: 'or',
      children: effective.map((attr) => ({ attr, op: 'contains', values: [needle] })),
    };
  }

  // The Go server uses `tree` when set and IGNORES `where[]`. So whenever we
  // emit a `tree`, the search leaves must ride INSIDE it — they can't sit in
  // `where[]` alongside. Tree-leaf shape requires `values: [...]` (plural);
  // the {searchTree} branch already builds that, and the single-field branch
  // re-shapes its leaf to the plural form before merging into a tree below.
  const singleSearchLeafAsTree: WireNode | null =
    effective.length === 1
      ? { attr: effective[0], op: 'contains', values: [needle] }
      : null;
  const searchClauseForTree: WireNode | null = searchTree ?? singleSearchLeafAsTree;

  if (predicate === null) {
    if (searchTree !== null) return { where: undefined, tree: searchTree };
    return { where: searchLeaves.length > 0 ? searchLeaves : undefined, tree: undefined };
  }
  if (isFlatAndOfLeaves(predicate)) {
    const userLeaves = (toWhereLeaves(predicate) ?? []) as WireNode[];
    if (searchTree !== null) {
      // Multi-field search: ride on tree, AND-fold the (plural-leaf) user
      // predicate alongside it. (We could rebuild user leaves via toWire to
      // guarantee the plural shape, but toWhereLeaves already calls toWire.)
      const tree: WireNode = {
        connective: 'and',
        children: [searchTree, ...userLeaves.map((l) => ({ ...l }))],
      };
      return { where: undefined, tree };
    }
    const combined = [...searchLeaves, ...userLeaves];
    return { where: combined.length > 0 ? combined : undefined, tree: undefined };
  }
  // Structured (non flat-AND) predicate → must use `tree`; the search clause
  // joins it under a top-level AND so the Go-side ignored-`where` rule doesn't
  // silently drop the needle.
  const userTree = toWire(predicate);
  if (searchClauseForTree !== null) {
    return {
      where: undefined,
      tree: { connective: 'and', children: [searchClauseForTree, userTree] },
    };
  }
  return { where: undefined, tree: userTree };
}

/* -------------------------------------------------------------------------- */
/* CardWherePredicate — backward-compatible re-export                         */
/* -------------------------------------------------------------------------- */

/**
 * A single `card.select_with_attributes` `where` predicate leaf — the wire
 * shape the server compiles via `card_compile_predicate.sql`. This is the same
 * structure {@link WireNode} carries for a leaf, kept as its own name because
 * existing call sites (`kanban/specs.ts`, the Grid, `projects/project-helpers.ts`,
 * the admin import) import `CardWherePredicate` and pass `op:'!='` /
 * `op:'contains'` leaves directly. Keeping it a permissive `op?: string`,
 * `value?`/`values?`, `and?` shape preserves every existing call.
 *
 * `op:'!='` compiles to a `NOT EXISTS` sub-query so a card that never had the
 * attribute written still passes the filter.
 *
 * Re-exported from `projects/project-helpers.ts` so the historical import path
 * keeps working; this module is now the source of truth for the type.
 */
export interface CardWherePredicate {
  attr?: string;
  op?: string;
  value?: unknown;
  values?: unknown[];
  /** When set, all sub-predicates AND together; the leaf fields are ignored. */
  and?: CardWherePredicate[];
}
