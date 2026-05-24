/**
 * Real API spec for project creation — `card.insert` — declared up front and
 * registered via `api.define`, addressed by the declarative data layer through
 * its `endpoint.action` string key. Targets the REAL `/api/v1/batch` wire and
 * matches the Go handler's input/output shape verbatim
 * (server/internal/dom/card/insert.go + db/schema/functions/card_insert_batch.sql):
 *
 *   - card.insert
 *       in : { card_type_name, parent_card_id?, title, attributes?, phase? }
 *            (snake_case; parent_card_id + the int64 id are wire strings)
 *       out: { id }   — the new card's bigint id (wire `json:",string"`,
 *            revived to bigint by the dispatcher).
 *
 * The encoder takes the framework's camelCase input object (assembled by the
 * declarative InputSpec resolver) and emits the server's snake_case keys —
 * same posture as the Svelte client's `handlers.ts`. A new project is a
 * TOP-LEVEL card: NO parent_card_id is sent (the Go handler only runs the
 * per-project scope checks when a parent exists), and the standard
 * project-template graph-copy fires server-side post-insert.
 */

import type { Api } from '../core/api.js';

/* -------------------------------------------------------------------------- */
/* Spec key (addressed by the declarative binding tables).                     */
/* -------------------------------------------------------------------------- */

export const PROJECT_SPEC = {
  cardInsert: 'card.insert',
} as const;

/* -------------------------------------------------------------------------- */
/* Input/output types (the camelCase surface the data table assembles).        */
/* -------------------------------------------------------------------------- */

export interface CardInsertInput {
  cardTypeName: string;
  /** Omitted for top-level cards (projects). */
  parentCardId?: bigint;
  title: string;
  /** Optional extra attribute name → JSON value map. */
  attributes?: Record<string, unknown>;
  /** Optional initial phase (triage|active|terminal). */
  phase?: string;
}

export interface CardInsertOutput {
  id: bigint;
}

/* -------------------------------------------------------------------------- */
/* Decode helpers (defensive, no exceptions on missing fields).                */
/* -------------------------------------------------------------------------- */

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
/** Coerce a wire id (bigint after revival, or number/string) to bigint. */
function asId(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
}

/* -------------------------------------------------------------------------- */
/* Registration.                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Register the `card.insert` spec against `api`. Call once at boot, BEFORE any
 * control mounts. Idempotent-safe only once per Api (api.define throws on a
 * duplicate key, matching the kanban specs' contract).
 */
export function registerProjectSpecs(api: Api): void {
  api.define<CardInsertInput, CardInsertOutput>({
    endpoint: 'card',
    action: 'insert',
    encode: (i) => {
      const m: Record<string, unknown> = {
        card_type_name: i.cardTypeName,
        title: i.title,
      };
      if (i.parentCardId !== undefined) m['parent_card_id'] = i.parentCardId;
      if (i.attributes !== undefined && Object.keys(i.attributes).length > 0) {
        m['attributes'] = i.attributes;
      }
      if (i.phase !== undefined && i.phase !== '') m['phase'] = i.phase;
      return m;
    },
    decode: (raw): CardInsertOutput => ({ id: asId(asObj(raw)['id']) }),
  });
}
