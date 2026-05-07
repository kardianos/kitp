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
  const byId = new Map<number, { ordering: number; required: boolean }>();
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
 * Strip the `ref:` prefix from a value_type label, returning just the
 * card_type name. Returns `null` for non-ref types.
 *
 *   parseRefCardType('ref:milestone')                    -> 'milestone'
 *   parseRefCardType('text')                             -> null
 *   parseRefCardType('ref:')                             -> null   (empty target)
 *   parseRefCardType('card_ref', 'milestone_ref')        -> 'milestone' (legacy)
 *   parseRefCardType('user_ref')                         -> null (not a card type)
 *
 * Server seed uses the legacy `card_ref` / `user_ref` tokens; the optional
 * `attrName` lets callers infer the target card type from a `<name>_ref`
 * convention so the admin Value-cards pane lights up for built-ins.
 */
export function parseRefCardType(
  valueType: string,
  attrName?: string,
): string | null {
  if (valueType.startsWith('ref:')) {
    const t = valueType.slice(4).trim();
    return t === '' ? null : t;
  }
  if (valueType === 'card_ref' && attrName !== undefined && attrName.endsWith('_ref')) {
    const target = attrName.slice(0, -'_ref'.length).trim();
    return target === '' ? null : target;
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
