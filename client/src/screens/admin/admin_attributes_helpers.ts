/**
 * Pure helpers for `AdminAttributesScreen`.
 *
 * Extracted as a TypeScript module so they can be unit-tested without a
 * Svelte component-mount runtime (vitest is node-only here). Helpers:
 *
 *   - `applyAttrSearch`     case-insensitive substring filter on `name`.
 *   - `groupDefs`           partition by `is_built_in` (built-in vs custom).
 *   - `boundMatrix`         derive the right-pane "Bound to" rows: for each
 *                           card_type, surface (bound, ordering, required).
 *   - `validateNewAttr`     validate the create-mode draft: name + value_type
 *                           required; ref:* requires a referenced card type.
 *                           (Enum options are added post-creation through the
 *                           edit pane — the server has no options-on-insert
 *                           path, so the create form has no place for them.)
 *   - `parseRefCardType`    strip the `ref:` prefix from a value_type label.
 */

import type {
  AttributeDefRow,
  CardTypeRow,
} from '../../reg/types.js';

// ----------------------------------------------------------------------------
// Search + grouping
// ----------------------------------------------------------------------------

/** Case-insensitive substring match on `name`. Empty / whitespace-only returns
 *  the input verbatim. */
export function applyAttrSearch(
  defs: readonly AttributeDefRow[],
  search: string,
): AttributeDefRow[] {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) return defs.slice();
  const out: AttributeDefRow[] = [];
  for (const d of defs) {
    if (d.name.toLowerCase().includes(needle)) out.push(d);
  }
  return out;
}

export interface GroupedDefs {
  builtIn: AttributeDefRow[];
  custom: AttributeDefRow[];
}

/** Partition by `is_built_in`. Preserves input order within each bucket. */
export function groupDefs(defs: readonly AttributeDefRow[]): GroupedDefs {
  const builtIn: AttributeDefRow[] = [];
  const custom: AttributeDefRow[] = [];
  for (const d of defs) {
    if (d.is_built_in) builtIn.push(d);
    else custom.push(d);
  }
  return { builtIn, custom };
}

// ----------------------------------------------------------------------------
// Right-pane "Bound to" matrix
// ----------------------------------------------------------------------------

export interface MatrixRow {
  cardType: CardTypeRow;
  bound: boolean;
  ordering: number;
  required: boolean;
}

/**
 * For each card_type, return whether the def is bound to it, its ordering
 * (0 if not bound), and required flag (false if not bound).
 *
 * If `def` is null, every row reports `bound=false`.
 */
export function boundMatrix(
  cardTypes: readonly CardTypeRow[],
  def: AttributeDefRow | null,
): MatrixRow[] {
  const byId = new Map<bigint, { ordering: number; required: boolean }>();
  if (def) {
    for (const b of def.bound_to) {
      byId.set(b.card_type_id, {
        ordering: b.ordering,
        required: b.is_required,
      });
    }
  }
  const out: MatrixRow[] = [];
  for (const ct of cardTypes) {
    const hit = byId.get(ct.id);
    out.push({
      cardType: ct,
      bound: hit !== undefined,
      ordering: hit?.ordering ?? 0,
      required: hit?.required ?? false,
    });
  }
  return out;
}

// ----------------------------------------------------------------------------
// New-attribute validation
// ----------------------------------------------------------------------------

export interface NewAttrDraft {
  name: string;
  valueType: string;
  refCardType?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Record<string, string>;
}

/**
 * Validate the create-mode draft. Returns `{ ok, errors }` where `errors` is
 * keyed by field name (`name`, `valueType`, `refCardType`).
 *
 *   - `name`:        non-empty after trim
 *   - `valueType`:   non-empty after trim
 *   - `ref:<type>`:  refCardType non-empty (matching what's after the colon)
 */
export function validateNewAttr(draft: NewAttrDraft): ValidationResult {
  const errors: Record<string, string> = {};
  if (draft.name.trim() === '') {
    errors.name = 'Name is required';
  }
  const vt = draft.valueType.trim();
  if (vt === '') {
    errors.valueType = 'Value type is required';
  }
  if (vt.startsWith('ref:')) {
    const inline = vt.slice(4).trim();
    const explicit = (draft.refCardType ?? '').trim();
    if (inline === '' && explicit === '') {
      errors.refCardType = 'Pick a referenced card type';
    }
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * Resolve the referenced card_type name from an attribute_def's wire
 * fields. Returns `null` for non-ref types.
 *
 *   parseRefCardType('ref:milestone')                       -> 'milestone'
 *   parseRefCardType('card_ref', 'person')                  -> 'person'
 *   parseRefCardType('card_ref[]', 'tag')                   -> 'tag'
 *   parseRefCardType('text')                                -> null
 *   parseRefCardType('ref:')                                -> null
 *
 * The server seeds card_ref attribute_defs with `target_card_type_name`
 * already resolved — the helper uses it when present rather than
 * inferring anything from the attribute name. `ref:<type>` continues to
 * work for client-side normalised types.
 */
export function parseRefCardType(
  valueType: string,
  targetCardTypeName?: string,
): string | null {
  if (valueType.startsWith('ref:')) {
    const t = valueType.slice(4).trim();
    return t === '' ? null : t;
  }
  if (valueType === 'card_ref' || valueType === 'card_ref[]') {
    const t = (targetCardTypeName ?? '').trim();
    return t === '' ? null : t;
  }
  return null;
}

/** True if any card under `cards` has a non-null value for `attrName`. Used
 *  to lock the value_type combobox once any value has been written. */
export function defHasAnyValues(
  attrName: string,
  cards: readonly { attributes: Record<string, unknown> }[],
): boolean {
  for (const c of cards) {
    const v = c.attributes[attrName];
    if (v !== undefined && v !== null) return true;
  }
  return false;
}
