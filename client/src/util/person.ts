/**
 * Person card classification helpers.
 *
 * `person_kind` (text attribute) is the discriminator:
 *   - `'contact'` — materialised from an email address; appears only
 *     in comm recipient pickers, never in assignee pickers.
 *   - `'member'` — default for hand-created person cards (dev team,
 *     manual admin inserts). Eligible for assignment.
 *   - missing / any other value — treated as assignable (back-compat
 *     for person cards that predate the kind attribute).
 */

import type { CardWithAttrs } from '../reg/types.js';

export function isContactPerson(p: CardWithAttrs): boolean {
  return p.attributes['person_kind'] === 'contact';
}

/**
 * True when the person is eligible for assignment dropdowns. Use to
 * filter the full `persons` list at each picker call site — never to
 * filter the master list, since the name lookup for already-assigned
 * tasks still needs to resolve contact cards (if any survived a
 * reclassification).
 */
export function isAssignablePerson(p: CardWithAttrs): boolean {
  return !isContactPerson(p);
}
