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
 *
 * The Grid's BULK actions add two NON-card write specs the bulk-action bar fans
 * out across the selected card set:
 *   - task.move   (db/schema/functions/task_move_batch.sql)
 *       in : { card_id, new_project_id, new_status_id?, new_milestone_id?,
 *              new_component_id?, new_tag_ids?, subtask_strategy? } (snake_case)
 *       out: { moved_card_ids, broken_child_ids?, resolved_status_id }
 *   - task.purge  (db/schema/functions/task_purge_batch.sql)
 *       in : { card_id }
 *       out: { ok, purged_card_ids, purged_reply_body_ids? }
 * Both are batch handlers — one call per selected card, coalesced into one POST
 * by the dispatcher's microtask flush (the same coalescing the kanban reorder
 * relies on). ids ride as JSON strings (bigint) and revive on the way back.
 */

import type { Api } from '../core/api.js';
import { registerCardRefAttr } from '../core/dispatch.js';

/** Spec keys the bulk-action bar fires (addressed by the declarative actions). */
export const GRID_SPEC = {
  taskMove: 'task.move',
  taskPurge: 'task.purge',
} as const;

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

/* -------------------------------------------------------------------------- */
/* Bulk-action write specs (task.move / task.purge).                           */
/* -------------------------------------------------------------------------- */

export interface TaskMoveInput {
  cardId: bigint;
  newProjectId: bigint;
  /** Omit / 0 → server picks the destination's first intake status. */
  newStatusId?: bigint;
  newMilestoneId?: bigint;
  newComponentId?: bigint;
  newTagIds?: bigint[];
  /** 'cascade' (default) carries descendants; 'break' leaves them behind. */
  subtaskStrategy?: 'cascade' | 'break';
}
export interface TaskMoveOutput {
  movedCardIds: bigint[];
  brokenChildIds: bigint[];
  resolvedStatusId: bigint;
}

export interface TaskPurgeInput {
  cardId: bigint;
}
export interface TaskPurgeOutput {
  ok: boolean;
  purgedCardIds: bigint[];
  purgedReplyBodyIds: bigint[];
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function asIdArray(v: unknown): bigint[] {
  if (!Array.isArray(v)) return [];
  const out: bigint[] = [];
  for (const x of v) {
    if (typeof x === 'bigint') out.push(x);
    else if (typeof x === 'number' && Number.isInteger(x)) out.push(BigInt(x));
    else if (typeof x === 'string' && /^-?\d+$/.test(x)) out.push(BigInt(x));
  }
  return out;
}
function asId(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
}

/**
 * Register the bulk-action write specs against `api`. Call once at boot, AFTER
 * `registerKanbanSpecs(api)` (independent of it, but main.ts groups the spec
 * registrars). Idempotent-by-presence is NOT assumed here — call exactly once.
 */
export function registerGridBulkSpecs(api: Api): void {
  api.define<TaskMoveInput, TaskMoveOutput>({
    endpoint: 'task',
    action: 'move',
    encode: (i) => {
      const m: Record<string, unknown> = {
        card_id: i.cardId,
        new_project_id: i.newProjectId,
      };
      if (i.newStatusId !== undefined && i.newStatusId !== 0n) m['new_status_id'] = i.newStatusId;
      if (i.newMilestoneId !== undefined && i.newMilestoneId !== 0n) {
        m['new_milestone_id'] = i.newMilestoneId;
      }
      if (i.newComponentId !== undefined && i.newComponentId !== 0n) {
        m['new_component_id'] = i.newComponentId;
      }
      if (i.newTagIds !== undefined && i.newTagIds.length > 0) m['new_tag_ids'] = i.newTagIds;
      if (i.subtaskStrategy !== undefined) m['subtask_strategy'] = i.subtaskStrategy;
      return m;
    },
    decode: (raw): TaskMoveOutput => {
      const j = asObj(raw);
      return {
        movedCardIds: asIdArray(j['moved_card_ids']),
        brokenChildIds: asIdArray(j['broken_child_ids']),
        resolvedStatusId: asId(j['resolved_status_id']),
      };
    },
  });

  api.define<TaskPurgeInput, TaskPurgeOutput>({
    endpoint: 'task',
    action: 'purge',
    encode: (i) => ({ card_id: i.cardId }),
    decode: (raw): TaskPurgeOutput => {
      const j = asObj(raw);
      return {
        ok: j['ok'] === true,
        purgedCardIds: asIdArray(j['purged_card_ids']),
        purgedReplyBodyIds: asIdArray(j['purged_reply_body_ids']),
      };
    },
  });
}
