/**
 * Data-driven filter vocabulary — the group/chip axes for a card_type, derived
 * from the SERVER schema rather than a hardcoded list.
 *
 * The owner's rule: "group options are not hard coded, but fetched from
 * attributes in the DB for the project." So the available group axes + quick
 * chips for a screen come from the card_type's `card_ref` / `card_ref[]`
 * attribute_defs (via `attribute_def.select` → {@link schemaForCardType}),
 * NOT from a curated name list. The option VALUES for each axis come from
 * `card.select` on the target card_type (loaded by the ScreenFilterBar).
 *
 * Which refs count as a "value vocabulary" (a sensible group/filter axis) is
 * decided WITHOUT a hardcoded attribute denylist, using two structural signals
 * already on `card_type.select`:
 *   - exclude SELF-referential refs (target === the card_type) — that's
 *     hierarchy (`parent_task`), owned by the related-tasks panel, not a filter.
 *   - exclude refs to a CHILD CONTENT type (the target's `parent_card_type_id`
 *     is this card_type) — e.g. `comms` (card_ref[] → comm, a child of task) is
 *     a content thread, not an enumerable vocabulary.
 * Everything else (status, assignee, milestone_ref, component_ref, tags,
 * originator, …) is surfaced — exactly the project's own ref attributes.
 */

import { schemaForCardType } from './attribute-schema.js';
import type { AttributeDefRow } from '../admin/specs.js';

/** One group/chip axis resolved from a card_ref attribute_def. */
export interface RefAxis {
  /** Attribute name — the group-picker value AND the predicate leaf attr. */
  attr: string;
  /** Friendly label (from {@link friendlyLabel}). */
  label: string;
  /** Target card_type name whose cards are this axis's option vocabulary. */
  targetCardType: string;
  /** card_ref[] (multi) vs card_ref (single). */
  multi: boolean;
}

/** The fields of `card_type.select` this module reads. */
export interface CardTypeRow {
  id: string;
  name: string;
  parent_card_type_id?: string;
}

/**
 * The group/chip axes for [cardTypeName]: its `card_ref` / `card_ref[]`
 * attributes whose target is a value vocabulary (see the module doc for the two
 * structural exclusions). Order follows the schema's edge `ordering`.
 *
 * `cardTypes` is the `card_type.select` row set; when empty the child-content
 * exclusion is skipped (only the self-ref exclusion applies) so the axes still
 * resolve before that lookup lands.
 */
export function refAxesForCardType(
  defs: readonly AttributeDefRow[],
  cardTypes: readonly CardTypeRow[],
  cardTypeName: string,
): RefAxis[] {
  const self = cardTypes.find((c) => c.name === cardTypeName);
  const byName = new Map(cardTypes.map((c) => [c.name, c] as const));
  const out: RefAxis[] = [];
  for (const a of schemaForCardType(defs, cardTypeName)) {
    if (a.valueType !== 'card_ref' && a.valueType !== 'card_ref[]') continue;
    const target = a.targetCardType;
    if (target === undefined || target === '') continue;
    if (target === cardTypeName) continue; // self-referential hierarchy
    const t = byName.get(target);
    if (self !== undefined && t !== undefined && t.parent_card_type_id === self.id) {
      continue; // child content type of this card_type (e.g. comm under task)
    }
    out.push({
      attr: a.name,
      label: a.label,
      targetCardType: target,
      multi: a.valueType === 'card_ref[]',
    });
  }
  return out;
}
