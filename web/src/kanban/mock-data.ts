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

/** Value-card (status) ids — the GROUP=Status axis. */
const S_TODO = 40n;
const S_DOING = 41n;
const S_DONE = 42n;

/** Value-card (component) ids — the GROUP=Component axis. */
const C_API = 60n;
const C_UI = 61n;

/** Value-card (person) ids — the GROUP=Assignee axis. */
const P_ADA = 70n;
const P_LIN = 71n;

const CT_TASK = 5n; // card_type_id for 'task'
const CT_MILESTONE = 7n; // card_type_id for 'milestone'
const CT_STATUS = 8n; // card_type_id for 'status'
const CT_COMPONENT = 10n; // card_type_id for 'component'
const CT_PERSON = 11n; // card_type_id for 'person'
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
  /** status value-card id (GROUP=Status axis); null → the `(unset)` column. */
  status?: bigint | null;
  /** component value-card id (GROUP=Component axis). */
  component?: bigint | null;
  /** person value-card id (GROUP=Assignee axis). */
  assignee?: bigint | null;
}

/**
 * The canned task set: 6 across M1/M2/M3 + one unset (the milestone axis), each
 * ALSO carrying a `status` (+ some a component / assignee) so the GROUP picker
 * can re-key the board by any of those axes and still show populated columns.
 */
const TASK_SEED: MockTaskSeed[] = [
  { id: 201n, title: 'Wire pickers', sortOrder: 100, milestone: M1, status: S_DOING, component: C_UI, assignee: P_ADA },
  { id: 202n, title: 'API rate limits', sortOrder: 200, milestone: M1, status: S_TODO, component: C_API, assignee: P_LIN },
  { id: 203n, title: 'Dark mode polish', sortOrder: 100, milestone: M2, status: S_DOING, component: C_UI, assignee: P_ADA },
  { id: 204n, title: 'Drag-drop board', sortOrder: 200, milestone: M2, status: S_TODO, component: C_UI },
  { id: 205n, title: 'Export to CSV', sortOrder: 100, milestone: M3, status: S_DONE, component: C_API, assignee: P_LIN },
  { id: 206n, title: 'Triage backlog', sortOrder: 100, milestone: null, status: null },
];

/** Encode a task seed as the wire row card.select_with_attributes returns. */
function taskRow(t: MockTaskSeed): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    title: t.title,
    sort_order: t.sortOrder,
  };
  // Each card_ref crosses the wire as a JSON string (id), revived to bigint by
  // the dispatcher's registered card_ref attrs.
  if (t.milestone !== null) attributes['milestone_ref'] = t.milestone.toString();
  if (t.status !== undefined && t.status !== null) attributes['status'] = t.status.toString();
  if (t.component !== undefined && t.component !== null) {
    attributes['component_ref'] = t.component.toString();
  }
  if (t.assignee !== undefined && t.assignee !== null) attributes['assignee'] = t.assignee.toString();
  return {
    id: t.id.toString(),
    card_type_id: CT_TASK.toString(),
    card_type_name: 'task',
    parent_card_id: DEMO_PROJECT_ID.toString(),
    phase: 'active',
    attributes,
  };
}

/** Encode a generic value-card (status / component / person) as the wire row
 *  card.select_with_attributes returns — title rides in the attributes object. */
function valueCardRow(id: bigint, cardTypeId: bigint, cardTypeName: string, title: string): Record<string, unknown> {
  return {
    id: id.toString(),
    card_type_id: cardTypeId.toString(),
    card_type_name: cardTypeName,
    parent_card_id: DEMO_PROJECT_ID.toString(),
    attributes: { title },
  };
}

const STATUSES: Array<Record<string, unknown>> = [
  valueCardRow(S_TODO, CT_STATUS, 'status', 'To do'),
  valueCardRow(S_DOING, CT_STATUS, 'status', 'Doing'),
  valueCardRow(S_DONE, CT_STATUS, 'status', 'Done'),
];
const COMPONENTS: Array<Record<string, unknown>> = [
  valueCardRow(C_API, CT_COMPONENT, 'component', 'API'),
  valueCardRow(C_UI, CT_COMPONENT, 'component', 'UI'),
];
const PERSONS: Array<Record<string, unknown>> = [
  valueCardRow(P_ADA, CT_PERSON, 'person', 'Ada Lovelace'),
  valueCardRow(P_LIN, CT_PERSON, 'person', 'Linus T.'),
];

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

/* -------------------------------------------------------------------------- */
/* Screen + saved-filter cards — the view-system backbone (#29).               */
/* A 'kanban' screen card under the demo project + two saved `filter` cards so  */
/* the FilterPresetSelector populates and the default-filter-on-first-visit     */
/* path has data to apply.                                                      */
/* -------------------------------------------------------------------------- */

const SCREEN_KANBAN_ID = 700n;
const FILTER_OPEN_ID = 810n; // "Open work" — the default filter
const FILTER_BLOCKED_ID = 811n; // "Blocked"
const CT_SCREEN = 20n;
const CT_FILTER = 21n;
const CT_PREDICATE_SNIPPET = 22n;

/** predicate_snippet card ids — reusable predicate fragments the "Named"
 *  multi-select toggles (the snippet leaf carries the id; the server expands). */
const SNIPPET_MY_OPEN_ID = 900n; // "My open work"
const SNIPPET_API_ID = 901n; // "API component"

/** The kanban screen card: slug 'kanban', layout 'kanban', default → Open work. */
const SCREENS: Array<Record<string, unknown>> = [
  {
    id: SCREEN_KANBAN_ID.toString(),
    card_type_id: CT_SCREEN.toString(),
    card_type_name: 'screen',
    parent_card_id: DEMO_PROJECT_ID.toString(),
    attributes: {
      title: 'Kanban',
      slug: 'kanban',
      layout: 'kanban',
      default_filter: FILTER_OPEN_ID.toString(),
    },
  },
];

/** Two saved filter cards under the kanban screen. */
const FILTERS: Array<Record<string, unknown>> = [
  {
    id: FILTER_OPEN_ID.toString(),
    card_type_id: CT_FILTER.toString(),
    card_type_name: 'filter',
    parent_card_id: SCREEN_KANBAN_ID.toString(),
    attributes: {
      title: 'Open work',
      // A flat-AND not-terminal leaf — the common "hide closed" saved view.
      predicate: JSON.stringify({ attr: 'status', op: 'not terminal' }),
    },
  },
  {
    id: FILTER_BLOCKED_ID.toString(),
    card_type_id: CT_FILTER.toString(),
    card_type_name: 'filter',
    parent_card_id: SCREEN_KANBAN_ID.toString(),
    attributes: {
      title: 'Doing',
      predicate: JSON.stringify({ attr: 'status', op: 'in', values: [S_DOING.toString()] }),
      group_by_attr: 'status',
    },
  },
];

/**
 * Two predicate_snippet cards under the demo project so the ScreenFilterBar's
 * "Named" multi-select populates. The `predicate` attribute holds the JSON
 * fragment the snippet stands for — but the CLIENT never expands it: picking a
 * snippet emits a `{op:'snippet', values:[<id>]}` leaf the server expands +
 * cycle-guards. The fragments here exist so the row is shaped like the real
 * card; the menu only reads `title`.
 */
const PREDICATE_SNIPPETS: Array<Record<string, unknown>> = [
  {
    id: SNIPPET_MY_OPEN_ID.toString(),
    card_type_id: CT_PREDICATE_SNIPPET.toString(),
    card_type_name: 'predicate_snippet',
    parent_card_id: DEMO_PROJECT_ID.toString(),
    attributes: {
      title: 'My open work',
      predicate: JSON.stringify({
        connective: 'and',
        children: [
          { attr: 'status', op: 'not terminal' },
          { attr: 'assignee', op: 'in', values: [P_ADA.toString()] },
        ],
      }),
    },
  },
  {
    id: SNIPPET_API_ID.toString(),
    card_type_id: CT_PREDICATE_SNIPPET.toString(),
    card_type_name: 'predicate_snippet',
    parent_card_id: DEMO_PROJECT_ID.toString(),
    attributes: {
      title: 'API component',
      predicate: JSON.stringify({ attr: 'component_ref', op: 'in', values: [C_API.toString()] }),
    },
  },
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
    if (data.card_type_name === 'status') {
      return { id: sr.id, ok: true, data: { rows: STATUSES } };
    }
    if (data.card_type_name === 'component') {
      return { id: sr.id, ok: true, data: { rows: COMPONENTS } };
    }
    if (data.card_type_name === 'person') {
      return { id: sr.id, ok: true, data: { rows: PERSONS } };
    }
    if (data.card_type_name === 'project') {
      return { id: sr.id, ok: true, data: { rows: [projectRow(DEMO_PROJECT_ID, 'Default Project')] } };
    }
    if (data.card_type_name === 'screen') {
      return { id: sr.id, ok: true, data: { rows: SCREENS } };
    }
    if (data.card_type_name === 'filter') {
      return { id: sr.id, ok: true, data: { rows: FILTERS } };
    }
    if (data.card_type_name === 'predicate_snippet') {
      return { id: sr.id, ok: true, data: { rows: PREDICATE_SNIPPETS } };
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
  if (key === 'card.delete') {
    // Saved-filter delete (the view-system Delete action) — canned success.
    return { id: sr.id, ok: true, data: { ok: true, activity_id: '70003' } };
  }
  if (key === 'attribute_def.select') {
    // The Advanced PredicateFilter (mounted by the ScreenFilterBar) sources its
    // `{ cardType: 'task' }` schema from this read. A minimal task attribute set
    // so the editor has something to filter on (and the demo emits no fault).
    return {
      id: sr.id,
      ok: true,
      data: {
        rows: [
          { id: '1', name: 'status', value_type: 'card_ref', target_card_type_name: 'status', is_built_in: true, bound_to: [{ card_type_id: CT_TASK.toString(), card_type_name: 'task', ordering: 1 }] },
          { id: '2', name: 'milestone_ref', value_type: 'card_ref', target_card_type_name: 'milestone', is_built_in: true, bound_to: [{ card_type_id: CT_TASK.toString(), card_type_name: 'task', ordering: 2 }] },
          { id: '3', name: 'component_ref', value_type: 'card_ref', target_card_type_name: 'component', is_built_in: true, bound_to: [{ card_type_id: CT_TASK.toString(), card_type_name: 'task', ordering: 3 }] },
          { id: '4', name: 'assignee', value_type: 'card_ref', target_card_type_name: 'person', is_built_in: true, bound_to: [{ card_type_id: CT_TASK.toString(), card_type_name: 'task', ordering: 4 }] },
          { id: '5', name: 'title', value_type: 'text', is_built_in: true, bound_to: [{ card_type_id: CT_TASK.toString(), card_type_name: 'task', ordering: 5 }] },
        ],
      },
    };
  }
  return {
    id: sr.id,
    ok: false,
    error: { code: 'unknown_handler', message: `mock has no ${key}` },
  };
}
