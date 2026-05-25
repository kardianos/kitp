/**
 * Saved-filter card specs — the writes the FilterPresetSelector / ScreenFilterbar
 * issue to manage `filter` cards.
 *
 * Three of the four operations reuse specs registered elsewhere:
 *   - load   → card.select_with_attributes  (registerKanbanSpecs)
 *   - save   → card.insert                  (registerProjectSpecs)
 *   - set-default / rename → attribute.update (registerKanbanSpecs)
 *
 * Only `card.delete` is new, so this module registers just that (idempotent-by-
 * presence: `api.define` throws on a duplicate key, so we skip if it's already
 * there). Matches the Go handler / Svelte `cardDelete` shape verbatim:
 *
 *   - card.delete
 *       in : { card_id }   (wire string)
 *       out: { ok, activity_id }
 */

import type { Api } from '../core/api.js';

export interface CardDeleteInput {
  cardId: bigint;
}
export interface CardDeleteOutput {
  ok: boolean;
  activityId: bigint;
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function asId(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
}

/**
 * Register the `card.delete` spec the saved-filter Delete action issues. Safe
 * to call after the other registrars; idempotent-by-presence.
 */
export function registerFilterCardSpecs(api: Api): void {
  if (api.registry.has({ endpoint: 'card', action: 'delete' })) return;
  api.define<CardDeleteInput, CardDeleteOutput>({
    endpoint: 'card',
    action: 'delete',
    encode: (i) => ({ card_id: i.cardId }),
    decode: (raw): CardDeleteOutput => {
      const j = asObj(raw);
      return { ok: j['ok'] === true, activityId: asId(j['activity_id']) };
    },
  });
}
