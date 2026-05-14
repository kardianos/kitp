/**
 * Attribute schema for the filter UI.
 *
 * Two purposes:
 *   1. Describe a single filterable attribute as a {@link FilterAttribute}
 *      — name, label, value type, allowed operators, and (for enum / ref
 *      types) the option list rendered into the value picker.
 *   2. Cache the server-issued `attribute_def` rows so every screen shares
 *      one fetch (Svelte 5 rune store; populated by
 *      {@link AttributeSchemaCache.load}).
 *
 * Companion to `predicate.ts`. The shape here intentionally avoids
 * reaching into the predicate AST so screens that only need value
 * pickers don't pull the whole filter editor surface into their bundle.
 */

import { type Dispatcher, registerCardRefAttr } from '../dispatch/dispatcher.js';
import { attributeDefSelect } from '../reg/handlers.js';
import type {
  AttributeDefRow,
  AttributeDefSelectInput,
  AttributeDefSelectOutput,
} from '../reg/types.js';
import type { Op } from './predicate.js';

/* -------------------------------------------------------------------------- */
/* FilterAttribute                                                            */
/* -------------------------------------------------------------------------- */

/** One option in an enum- or ref-typed value picker. */
export interface FilterAttributeOption {
  value: unknown;
  label: string;
  /**
   * Mirrors `card.phase === 'terminal'` for ref:* options. UI uses
   * this to drive the "Hide closed X" toggle in the filter bar and
   * to surface terminal actions ("Close", "Cancel") on cards.
   */
  isTerminal?: boolean;
}

/** UI-side description of one filterable attribute. */
export interface FilterAttribute {
  /** Wire field name (e.g. `'status'`, `'assignee'`). */
  name: string;
  /** User-facing label (defaults to `name` when the schema has no override). */
  label: string;
  /**
   * Value type discriminator. The well-known set is `'text' | 'number' |
   * 'bool' | 'date'`; any string starting with `'ref:'` (e.g.
   * `'ref:milestone'`) is also accepted and rendered via a Combobox.
   * Unknown types fall through to the text input.
   */
  valueType: 'text' | 'number' | 'bool' | 'date' | string;
  /** Pre-resolved options for ref:* types; undefined for free inputs. */
  options?: FilterAttributeOption[];
  /** Operators this attribute supports in the filter UI. */
  ops: Op[];
}

/**
 * Default operator set per value type. Shared across the filter bar and
 * the tree editor so the same attribute exposes the same affordances
 * everywhere.
 */
function defaultOpsForType(valueType: string): Op[] {
  if (valueType === 'bool') {
    return ['eq', 'ne', 'exists', 'notExists'];
  }
  if (valueType.startsWith('ref:')) {
    // `hasPhase` dereferences the ref and matches against the target
    // card's `phase` column — only meaningful for refs, never for
    // scalars. Server validates `value ∈ {triage|active|terminal}`.
    return ['eq', 'ne', 'in', 'notIn', 'hasPhase', 'exists', 'notExists'];
  }
  // text / number / date / unknown
  return ['eq', 'ne', 'exists', 'notExists'];
}

/**
 * Translate the server's legacy value_type tokens (`user_ref`, `card_ref`)
 * into the client's `ref:<card_type>` shape that {@link FilterAttribute}
 * consumers (notably ValueInput) expect. `card_ref` is ambiguous on its own;
 * we infer the target card type from a `<name>_ref` attribute name when we
 * can, and fall back to the generic `ref:card` so the Combobox renderer at
 * least kicks in.
 */
// Translate the server's value_type token into the client's
// `ref:<card_type>` shape (which the Combobox renderer keys on).
// For card_ref / card_ref[] we use the explicit target_card_type
// name carried on the def — no name-suffix or special-case inference.
// Primitive types pass through unchanged.
function normalizeValueType(rawType: string, targetCardTypeName: string | undefined): string {
  if (rawType === 'card_ref' || rawType === 'card_ref[]') {
    if (targetCardTypeName !== undefined && targetCardTypeName !== '') {
      return `ref:${targetCardTypeName}`;
    }
    return 'ref:card';
  }
  if (rawType === 'user_ref') return 'ref:user'; // legacy compat
  return rawType;
}

/**
 * Build a user-facing label from a raw attribute name. Strips a trailing
 * `_ref` (since the affordance — Combobox vs. text — already conveys "this
 * is a reference"), splits on underscores, and title-cases each token. So
 * `milestone_ref` → `Milestone`, `created_at` → `Created At`.
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

/* -------------------------------------------------------------------------- */
/* AttributeSchemaCache (rune store)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Server-driven cache of `attribute_def` rows. One instance is created at
 * the App root and provided via Svelte context. The first `load()` call
 * triggers a single batched `attribute_def.select` request; subsequent
 * calls are no-ops once `loaded` is true.
 *
 * Components observe `defs` / `loaded` reactively (the `$state` runes
 * already implement fine-grained subscription).
 */
export class AttributeSchemaCache {
  /** All known attribute defs — empty until `load()` resolves. */
  defs = $state<AttributeDefRow[]>([]);
  /** `true` once a successful load has completed. */
  loaded = $state(false);
  /** Single in-flight load promise; deduped so concurrent callers share it. */
  private loading: Promise<void> | null = null;

  constructor(private readonly dispatcher: Dispatcher) {}

  /**
   * Fetch the attribute_def list once. Calls after the first resolve
   * short-circuit. Concurrent callers share the same in-flight promise.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loading !== null) return this.loading;
    const p = this.dispatcher
      .request<AttributeDefSelectInput, AttributeDefSelectOutput>({
        endpoint: attributeDefSelect.endpoint,
        action: attributeDefSelect.action,
      })
      .then((out) => {
        this.defs = out.rows;
        // Teach the dispatcher to revive card_ref attribute values as
        // bigints. Idempotent — re-registering is a no-op on the
        // underlying Set. Covers both built-in defs (status, assignee,
        // …) and any custom attribute_def an admin has added since the
        // last load.
        for (const def of out.rows) {
          if (def.value_type === 'card_ref') registerCardRefAttr(def.name, false);
          else if (def.value_type === 'card_ref[]') registerCardRefAttr(def.name, true);
        }
        this.loaded = true;
      })
      .finally(() => {
        this.loading = null;
      });
    this.loading = p;
    return p;
  }

  /** Lookup a raw def row by its `name`. */
  defByName(name: string): AttributeDefRow | undefined {
    return this.defs.find((d) => d.name === name);
  }

  /**
   * Build a {@link FilterAttribute} for [name].
   *
   * - Returns `null` if the def isn't loaded yet (caller should `load()`
   *   first or render a loading state).
   * - For `ref:<card_type_name>` types, options come from [refResolver]
   *   (callers pre-fetch via `card.select_with_attributes`); when the
   *   resolver is absent or returns `[]`, options are simply omitted.
   */
  toFilterAttribute(
    name: string,
    refResolver?: (cardTypeName: string) => FilterAttributeOption[],
  ): FilterAttribute | null {
    const def = this.defByName(name);
    if (def === undefined) return null;

    const valueType = normalizeValueType(def.value_type, def.target_card_type_name);
    const fa: FilterAttribute = {
      name: def.name,
      label: friendlyLabel(def.name),
      valueType,
      ops: defaultOpsForType(valueType),
    };

    if (valueType.startsWith('ref:') && refResolver !== undefined) {
      const cardTypeName = valueType.slice('ref:'.length);
      const resolved = refResolver(cardTypeName);
      if (resolved.length > 0) {
        fa.options = resolved;
      }
    }

    return fa;
  }
}

/* -------------------------------------------------------------------------- */
/* Shared singleton                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Process-wide schema cache. Created lazily on first call so the
 * dispatcher reference can be supplied at boot. Every screen that
 * used to instantiate its own AttributeSchemaCache now reads from
 * the singleton, which means the bigint-revival registration runs
 * once and the preload in main.ts seeds it before the first batched
 * data fetch ever runs.
 */
let _shared: AttributeSchemaCache | null = null;
export function sharedSchemaCache(dispatcher: Dispatcher): AttributeSchemaCache {
  if (_shared === null) _shared = new AttributeSchemaCache(dispatcher);
  return _shared;
}

/** Test hook: reset the singleton so a fresh `dispatcher` can be wired in. */
export function resetSharedSchemaCache(): void {
  _shared = null;
}

/* -------------------------------------------------------------------------- */
/* Re-exports for the value input                                             */
/* -------------------------------------------------------------------------- */

export { defaultOpsForType };
