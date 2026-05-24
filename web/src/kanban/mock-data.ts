/**
 * Mock transport for automated verification — speaks the EXACT /api/v1/batch
 * wire shape so the encode/decode/revive path is the real thing; only the
 * network sink is faked. Seeded with REALISTIC canned data shaped exactly like
 * the Go handlers return:
 *
 *   - one project (DEMO_PROJECT_ID).
 *   - three milestones (M1/M2/M3) under the project + an `(unset)` bucket.
 *   - six tasks across the three milestones + one with no milestone, each with
 *     a `title`, `sort_order`, and (where set) a `milestone_ref` attribute.
 *
 * Wire conventions matched verbatim (see db/schema/functions/*_batch.sql +
 * server/internal/api/sqlfunc.go):
 *   - int64 ids cross the wire as JSON STRINGS (Go `json:",string"`); the
 *     dispatcher revives id-shaped fields (and the registered `milestone_ref`
 *     card_ref attr) to bigint.
 *   - card.select_with_attributes → { rows: [{ id, card_type_id,
 *     card_type_name, parent_card_id, phase?, attributes:{...} }] }.
 *   - card.select → { rows: [{ id, card_type_id, card_type_name,
 *     parent_card_id, title }] } (title null in that lighter read; the mock
 *     supplies titles so the columns get readable labels).
 *   - attribute.update → { ok:true, activity_id } (per-row success), or a
 *     per-row error envelope for the forced-fault case.
 *
 * Flip USE_REAL_BACKEND=true in main.ts to bypass this and hit live kitpd.
 */

import type { Transport, SubResponse } from '../core/dispatch.js';

/** The seeded demo project id. */
export const DEMO_PROJECT_ID = 100n;

/** Value-card (milestone) ids. */
const M1 = 32n;
const M2 = 33n;
const M3 = 34n;

const CT_TASK = 5n; // card_type_id for 'task'
const CT_MILESTONE = 7n; // card_type_id for 'milestone'
const CT_PROJECT = 1n; // card_type_id for 'project'

/** Card id used by tests to force an attribute.update fault. */
export const FAULT_CARD_ID = 999n;

/** The id the mock returns for a successful card.insert (project create). */
export const CREATED_PROJECT_ID = 500n;

/** A create whose title is exactly this forces a card.insert fault so the
 *  optimistic-add rollback path is demonstrable in tests. */
export const FAULT_CREATE_TITLE = '__force_create_fault__';

interface MockTaskSeed {
  id: bigint;
  title: string;
  sortOrder: number;
  milestone: bigint | null;
}

/** The canned task set: 6 across M1/M2/M3 + one unset. */
const TASK_SEED: MockTaskSeed[] = [
  { id: 201n, title: 'Wire pickers', sortOrder: 100, milestone: M1 },
  { id: 202n, title: 'API rate limits', sortOrder: 200, milestone: M1 },
  { id: 203n, title: 'Dark mode polish', sortOrder: 100, milestone: M2 },
  { id: 204n, title: 'Drag-drop board', sortOrder: 200, milestone: M2 },
  { id: 205n, title: 'Export to CSV', sortOrder: 100, milestone: M3 },
  { id: 206n, title: 'Triage backlog', sortOrder: 100, milestone: null },
];

/** Encode a task seed as the wire row card.select_with_attributes returns. */
function taskRow(t: MockTaskSeed): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    title: t.title,
    sort_order: t.sortOrder,
  };
  // milestone_ref crosses the wire as a JSON string (id), revived to bigint.
  if (t.milestone !== null) attributes['milestone_ref'] = t.milestone.toString();
  return {
    id: t.id.toString(),
    card_type_id: CT_TASK.toString(),
    card_type_name: 'task',
    parent_card_id: DEMO_PROJECT_ID.toString(),
    phase: 'active',
    attributes,
  };
}

/**
 * Encode a milestone as the wire row card.select_with_attributes returns: the
 * title rides in the `attributes` object (NOT a top-level `title` field — that
 * lighter card.select read returns title:null). Mirrors the real handler so the
 * Kanban axis labels come from attributes.title.
 */
function milestoneRow(id: bigint, title: string): Record<string, unknown> {
  return {
    id: id.toString(),
    card_type_id: CT_MILESTONE.toString(),
    card_type_name: 'milestone',
    parent_card_id: DEMO_PROJECT_ID.toString(),
    attributes: { title },
  };
}

/** Encode a project as card.select_with_attributes returns it (title in attrs). */
function projectRow(id: bigint, title: string): Record<string, unknown> {
  return {
    id: id.toString(),
    card_type_id: CT_PROJECT.toString(),
    card_type_name: 'project',
    attributes: { title },
  };
}

const MILESTONES: Array<Record<string, unknown>> = [
  milestoneRow(M1, 'M1'),
  milestoneRow(M2, 'M2'),
  milestoneRow(M3, 'M3'),
];

interface WireSubRequest {
  id: string;
  endpoint: string;
  action: string;
  data?: unknown;
}

/**
 * Build the mock transport. A fresh closure per call so tests get isolated
 * state. The seeded tasks are immutable on the mock side — the client's
 * optimistic patch + re-bucket is what reflects a move; a subsequent reload
 * would converge on server truth (out of scope for the mock).
 */
export function mockTransport(): Transport {
  return {
    async send(body: string): Promise<{ status: number; text: string }> {
      const req = JSON.parse(body) as { subrequests: WireSubRequest[] };
      const subresponses: SubResponse[] = req.subrequests.map((sr) => respond(sr));
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
}

function respond(sr: WireSubRequest): SubResponse {
  const key = `${sr.endpoint}.${sr.action}`;
  if (key === 'card.select_with_attributes') {
    // Branch on card_type_name exactly as the real handler's filter does: tasks,
    // milestone value-cards (axis), and projects (the shell scope Picker) are all
    // loaded through this read in the live wiring.
    const data = (sr.data ?? {}) as { card_type_name?: string };
    if (data.card_type_name === 'milestone') {
      return { id: sr.id, ok: true, data: { rows: MILESTONES } };
    }
    if (data.card_type_name === 'project') {
      return { id: sr.id, ok: true, data: { rows: [projectRow(DEMO_PROJECT_ID, 'Default Project')] } };
    }
    return { id: sr.id, ok: true, data: { rows: TASK_SEED.map(taskRow) } };
  }
  if (key === 'card.select') {
    // Lighter read still registered; the shell projects query lands titles via
    // select_with_attributes now, so card.select returns the title-less shape
    // (title:null) the real handler emits. Kept for any caller that uses it.
    const data = (sr.data ?? {}) as { card_type_name?: string };
    if (data.card_type_name === 'project') {
      return {
        id: sr.id,
        ok: true,
        data: { rows: [{ id: DEMO_PROJECT_ID.toString(), card_type_id: CT_PROJECT.toString(), card_type_name: 'project', title: null }] },
      };
    }
    return { id: sr.id, ok: true, data: { rows: [] } };
  }
  if (key === 'card.insert') {
    // Project create (or any insert). A title equal to FAULT_CREATE_TITLE
    // forces a per-row error so the optimistic-add rollback path is testable;
    // otherwise return the canned new-card id (wire string, revived to bigint).
    const data = (sr.data ?? {}) as { title?: string };
    if (data.title === FAULT_CREATE_TITLE) {
      return {
        id: sr.id,
        ok: false,
        error: { code: 'validation', message: 'mock: forced create failure' },
      };
    }
    return { id: sr.id, ok: true, data: { id: CREATED_PROJECT_ID.toString() } };
  }
  if (key === 'attribute.update') {
    const data = (sr.data ?? {}) as { card_id?: string };
    // Forced-fault hook: a write targeting FAULT_CARD_ID always fails so the
    // optimistic-rollback path is demonstrable.
    if (data.card_id === FAULT_CARD_ID.toString()) {
      return {
        id: sr.id,
        ok: false,
        error: { code: 'flow_disallowed', message: 'mock: forced move failure' },
      };
    }
    return { id: sr.id, ok: true, data: { ok: true, activity_id: '70001' } };
  }
  return {
    id: sr.id,
    ok: false,
    error: { code: 'unknown_handler', message: `mock has no ${key}` },
  };
}
