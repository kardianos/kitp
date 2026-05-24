/**
 * Grid spec registration. The Grid reuses the SHARED
 * `card.select_with_attributes` spec (registered by `registerKanbanSpecs`) for
 * its tasks read AND every lookup read (persons / statuses / milestones /
 * components / tags) — they're all the same `card.select_with_attributes`
 * handler, branched server-side on `card_type_name`. So there is no new wire
 * spec to declare here.
 *
 * What the Grid DOES need is bigint revival of every card_ref attribute it
 * keys on. The dispatcher revives id-shaped keys (`*_id`) automatically, but a
 * plain attribute like `assignee` / `status` / `priority` / `tags` looks like a
 * scalar on the wire — it only revives to bigint when the attribute name is
 * registered (the documented Svelte-client gotcha: an un-primed card_ref attr
 * arrives as a `number`/`string`, and `===` against a `bigint` row id silently
 * fails). `milestone_ref` is already primed by `registerKanbanSpecs`; we add
 * the rest here. `registerCardRefAttr` is idempotent (Set-backed), so priming
 * `milestone_ref` again is harmless.
 *
 * Call once at boot, AFTER `registerKanbanSpecs(api)` (which defines the shared
 * spec). Re-priming card_ref attrs needs no `api` handle.
 */

import { registerCardRefAttr } from '../core/dispatch.js';

/** The card_ref attributes the Grid keys on (label resolution + future filters). */
export function registerGridCardRefAttrs(): void {
  // Scalar card_ref attrs (single bigint id on the wire).
  registerCardRefAttr('assignee', false);
  registerCardRefAttr('status', false);
  registerCardRefAttr('milestone_ref', false); // idempotent with kanban
  registerCardRefAttr('component_ref', false);
  // `tags` is a card_ref[] — array revival.
  registerCardRefAttr('tags', true);
}
