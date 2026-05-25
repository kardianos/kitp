/**
 * Inbox-specific API specs — the per-user reorder write + the delegate-to-agent
 * pair. Declared up front and registered via `api.define`, addressed by the
 * declarative data layer through their `endpoint.action` string key. They
 * target the REAL `/api/v1/batch` wire and match the Go handlers' shapes:
 *
 *   - user_card_sort.set   (db/schema/functions/user_card_sort_set_batch.sql)
 *       in : { card_id, sort_order }   — user_id is stamped server-side from the
 *            actor; the client never supplies it.
 *       out: { ok }
 *   - user_card_agent.set  (db/schema/functions/user_card_agent_set_batch.sql)
 *       in : { card_id, agent_user_id } — agent_user_id must be an agent owned
 *            by the actor (server validates ownership per-row).
 *       out: { ok }
 *   - user_card_agent.clear (db/schema/functions/user_card_agent_unset_batch.sql)
 *       in : { card_id }                — idempotent delete of the routing row.
 *       out: { ok, deleted }
 *
 * The card.select_with_attributes read the Inbox uses (with `with_personal_sort`
 * / `routed_to_me`) is the shared kanban spec — see kanban/specs.ts. This file
 * only adds the three write specs the Inbox is the sole client of.
 *
 * Encoders emit the server's snake_case keys; decoders normalise into the small
 * `{ ok }` shapes below. No bigint ids on the output, so nothing to revive.
 */

import type { Api } from '../core/api.js';

export const INBOX_SPEC = {
  userCardSortSet: 'user_card_sort.set',
  userCardAgentSet: 'user_card_agent.set',
  userCardAgentClear: 'user_card_agent.clear',
} as const;

export interface UserCardSortSetInput {
  cardId: bigint;
  /** The new personal sort order (the synthetic `(i+1)*STEP` value). */
  sortOrder: number;
}
export interface UserCardSortSetOutput {
  ok: boolean;
}

export interface UserCardAgentSetInput {
  cardId: bigint;
  /** The agent user_account id to route the card to (must be owned by actor). */
  agentUserId: bigint;
}
export interface UserCardAgentSetOutput {
  ok: boolean;
}

export interface UserCardAgentClearInput {
  cardId: bigint;
}
export interface UserCardAgentClearOutput {
  ok: boolean;
  deleted: number;
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/**
 * Register the three Inbox write specs against `api`. Call once at boot.
 * Idempotent-by-presence is NOT assumed here — call exactly once (like
 * registerKanbanSpecs); `api.define` registers afresh each call.
 */
export function registerInboxSpecs(api: Api): void {
  api.define<UserCardSortSetInput, UserCardSortSetOutput>({
    endpoint: 'user_card_sort',
    action: 'set',
    encode: (i) => ({ card_id: i.cardId, sort_order: i.sortOrder }),
    decode: (raw): UserCardSortSetOutput => ({ ok: asObj(raw)['ok'] === true }),
  });

  api.define<UserCardAgentSetInput, UserCardAgentSetOutput>({
    endpoint: 'user_card_agent',
    action: 'set',
    encode: (i) => ({ card_id: i.cardId, agent_user_id: i.agentUserId }),
    decode: (raw): UserCardAgentSetOutput => ({ ok: asObj(raw)['ok'] === true }),
  });

  api.define<UserCardAgentClearInput, UserCardAgentClearOutput>({
    endpoint: 'user_card_agent',
    // The Go-side action name stays `clear` (the SQL function is
    // user_card_agent_unset_batch, but the wire action is clear).
    action: 'clear',
    encode: (i) => ({ card_id: i.cardId }),
    decode: (raw): UserCardAgentClearOutput => {
      const j = asObj(raw);
      const deleted = typeof j['deleted'] === 'number' ? (j['deleted'] as number) : 0;
      return { ok: j['ok'] === true, deleted };
    },
  });
}
