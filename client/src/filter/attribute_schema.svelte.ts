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

import type { Dispatcher } from '../dispatch/dispatcher.js';
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
}

/** UI-side description of one filterable attribute. */
export interface FilterAttribute {
  /** Wire field name (e.g. `'status'`, `'assignee'`). */
  name: string;
  /** User-facing label (defaults to `name` when the schema has no override). */
  label: string;
  /**
   * Value type discriminator. The well-known set is `'text' | 'number' |
   * 'bool' | 'date' | 'enum'`; any string starting with `'ref:'` (e.g.
   * `'ref:milestone'`) is also accepted and rendered via a Combobox.
   * Unknown types fall through to the text input.
   */
  valueType: 'text' | 'number' | 'bool' | 'date' | 'enum' | string;
  /** Pre-resolved options for enum / ref types; undefined for free inputs. */
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
  if (valueType === 'enum' || valueType.startsWith('ref:')) {
    return ['eq', 'ne', 'in', 'notIn', 'exists', 'notExists'];
  }
  // text / number / date / unknown
  return ['eq', 'ne', 'exists', 'notExists'];
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
   * - For enum types, options come from the def's `options` field.
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

    const valueType = def.value_type;
    const fa: FilterAttribute = {
      name: def.name,
      label: def.name, // server-side `attribute_def` has no label column today;
      // screens override via a local map until that lands.
      valueType,
      ops: defaultOpsForType(valueType),
    };

    if (valueType === 'enum') {
      const opts = def.options ?? [];
      if (opts.length > 0) {
        fa.options = opts.map((o) => ({ value: o.value, label: o.label }));
      }
    } else if (valueType.startsWith('ref:') && refResolver !== undefined) {
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
/* Re-exports for the value input                                             */
/* -------------------------------------------------------------------------- */

export { defaultOpsForType };
