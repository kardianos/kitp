/**
 * `card.search` API spec — declared up front and registered via `api.define`,
 * addressed by the declarative data layer through its `card.search` string key.
 *
 * This is the backing query for every card_ref editor (RefPicker single +
 * multi): a typeahead/id lookup over cards of one card_type, optionally scoped
 * to a parent card, returning lightweight `{ id, title }` rows for the picker
 * menu.
 *
 * Wire shape (db/schema/functions/card_search_batch.sql):
 *   in : { card_type_name, query?, ids?, parent_card_id?, limit? }   (snake_case)
 *   out: { rows: [{ id: "<bigint>", title }] }   — `id` is a JSON string; the
 *        dispatcher revives it to bigint (the key matches its id-shaped rule),
 *        and the decode here is defensive about either form.
 *
 * The encoder takes the framework's camelCase input object and emits the
 * server's snake_case keys (same posture as kanban/specs.ts). Only set keys
 * are forwarded — an absent `query` means "list newest cards of this type",
 * an absent `parentCardId` means "no parent scope".
 */

import type { Api } from '../core/api.js';

/* -------------------------------------------------------------------------- */
/* Spec key (addressed by RefPicker's callByName).                            */
/* -------------------------------------------------------------------------- */

export const CARD_SEARCH_SPEC = 'card.search';

/* -------------------------------------------------------------------------- */
/* Input/output types (the camelCase surface RefPicker assembles).            */
/* -------------------------------------------------------------------------- */

export interface CardSearchInput {
  /** Required: the card_type to search within (e.g. 'milestone', 'contact'). */
  cardTypeName: string;
  /** Optional typeahead query: ILIKE on title OR exact id match. */
  query?: string;
  /** Optional explicit id set to resolve (e.g. hydrate current selections). */
  ids?: bigint[];
  /** Optional parent-card scope (only direct children of this card). */
  parentCardId?: bigint;
  /** Optional row cap (server clamps 1..200, default 50). */
  limit?: number;
}

/** One search hit — the minimal shape a ref editor needs to render an option. */
export interface CardSearchRow {
  id: bigint;
  title: string;
}

export interface CardSearchOutput {
  rows: CardSearchRow[];
}

/* -------------------------------------------------------------------------- */
/* Decode helpers (defensive, no exceptions on missing fields).               */
/* -------------------------------------------------------------------------- */

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
/** Coerce a wire id (bigint after revival, or number/string) to bigint. */
function asId(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
}
function asStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (v === null || v === undefined) return '';
  return String(v);
}

function decodeRow(j: Record<string, unknown>): CardSearchRow {
  return { id: asId(j['id']), title: asStr(j['title']) };
}

/* -------------------------------------------------------------------------- */
/* Registration.                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Register the `card.search` spec against `api`. Call once at boot, BEFORE any
 * RefPicker mounts (the data layer / `callByName` resolves the spec by key at
 * fire time). Idempotent-by-presence: `api.define` throws on a duplicate key,
 * so skip if it's already registered (e.g. a test harness registered it first).
 */
export function registerCardSearchSpec(api: Api): void {
  if (api.registry.has({ endpoint: 'card', action: 'search' })) return;
  api.define<CardSearchInput, CardSearchOutput>({
    endpoint: 'card',
    action: 'search',
    encode: (i) => {
      const m: Record<string, unknown> = { card_type_name: i.cardTypeName };
      if (i.query !== undefined && i.query !== '') m['query'] = i.query;
      if (i.ids !== undefined && i.ids.length > 0) m['ids'] = i.ids;
      if (i.parentCardId !== undefined) m['parent_card_id'] = i.parentCardId;
      if (i.limit !== undefined) m['limit'] = i.limit;
      return m;
    },
    decode: (raw): CardSearchOutput => ({
      rows: asArray(asObj(raw)['rows']).map((r) => decodeRow(asObj(r))),
    }),
  });
}
