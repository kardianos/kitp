/**
 * MasterDetail — the reusable, config-driven search-list-detail admin screen.
 *
 * The PRIORITY is reuse: ONE control most admin screens can be built from
 * with ONLY a config object — no bespoke per-screen control code. Two panes
 * fill the outlet:
 *
 *   - LEFT (~320px): a search Field on top + a recycling `virtualList` of rows
 *     rendered from `list.row` (title / subtitle / badge field names). The
 *     search is a client-side case-insensitive substring filter over
 *     `list.search.field`.
 *   - RIGHT (flex:1): the detail pane. Renders `detail.fields` for the selected
 *     item — `readonly`/`badges` are read-only; `text`/`textarea`/`select` are
 *     inline-editable and fire `detail.updateSpec` OPTIMISTICALLY (auto-rollback
 *     on fault, onError 'top'). Empty selection shows `detail.empty`.
 *
 * SELECTION lives in the TREE (recycling-safe): a row click writes
 * `<scopeKey>.selectedId`; the list's single render effect reads it to mark the
 * selected row; the detail pane reads the selected item by id from
 * `<scopeKey>.items`. NO selection state lives on the recycled row DOM nodes —
 * `update()` re-derives the selected class from the item id + the tree on every
 * window render, so a recycled node never carries a stale highlight.
 *
 * DATA is fully declarative. The list query and every editable-field update are
 * driven by `BaseControlConfig.queries` / `actions` BUILT FROM THE CONFIG at
 * registration of the instance (see `masterDetailScreen(...)`), so the control
 * body contains NO `call(...)`, no `await`, no promise. The list result lands at
 * `<scopeKey>.items` via the `landItems` handler (which normalises rows to a
 * uniform `{ id, raw }` shape so both card rows and plain user rows work).
 *
 * This is generalised from ProjectList's search + selection + properties-form
 * pattern, but it is NON-card-source agnostic: the row + field accessors read
 * dotted paths off whatever the spec returns (`attributes.title` for a card,
 * `display_name` for a user), so the SAME control serves card and non-card
 * entities (proven by the Contacts + Users configs).
 */

import {
  Control,
  type BaseControlConfig,
} from '../core/control.js';
import { resolveInput, type ActionBinding, type InputSpec, type QueryBinding } from '../core/data.js';
import type { RecordFormScreenConfig } from './record-form.js';
import type { ApiFault } from '../core/dispatch.js';
import { virtualList, type VirtualListHandle } from '../core/virtual-list.js';
import type { CardWherePredicate } from '../projects/project-helpers.js';
import {
  type Predicate,
  type WireNode,
  isFlatAndOfLeaves,
  toWhereLeaves,
  toWire,
} from '../filter/predicate.js';

/* -------------------------------------------------------------------------- */
/* Config contract.                                                            */
/* -------------------------------------------------------------------------- */

/** A static option list, or a tree path the options are read from. */
export type FieldOptions =
  | Array<{ value: string; label: string }>
  | { fromPath: string };

/* -------------------------------------------------------------------------- */
/* Create / delete / detail-action config (generic, opt-in per screen).        */
/* -------------------------------------------------------------------------- */

/**
 * One field in a create (or detail-action) form. `name` is the PAYLOAD key the
 * declarative `input` InputSpec reads via `{ payload: name }`; `kind` chooses
 * the editor (text | select). `required` gates the submit. `optionsLabel`
 * lets a select show a placeholder option for the empty value.
 */
export interface MasterDetailFormField {
  name: string;
  label: string;
  kind: 'text' | 'select';
  options?: FieldOptions;
  required?: boolean;
  placeholder?: string;
  /**
   * Route this field into the payload's `attributes` object (under `name`)
   * instead of a top-level payload key — so a card.insert create can set extra
   * card attributes (e.g. a screen's `layout` / `slug`) via
   * `input: { attributes: { payload: 'attributes' } }`.
   */
  attribute?: boolean;
}

/**
 * Generic create config. A "+ New" button opens a dialog of `fields`; submit
 * fires the `create` intent with the collected payload (the declarative
 * `actionSpec` action reads it via `input`), OPTIMISTICALLY appending a row to
 * `<scopeKey>.items` built by `optimisticRow` (auto-rollback on fault). The
 * server-returned id (read at `resultIdField`) promotes the temp row.
 */
export interface MasterDetailCreate {
  /** Spec key the create fires (e.g. 'card.insert', 'person.create'). */
  spec: string;
  /** Declarative input map (payload → wire). Reads the dialog payload. */
  input: InputSpec;
  /** The dialog's fields. Their `name`s are the payload keys. */
  fields: MasterDetailFormField[];
  /** Dialog heading. Default 'New item'. */
  title?: string;
  /** "+ New" button label. Default '+ New'. */
  buttonLabel?: string;
  /**
   * Build the optimistic row's `raw` object from the submitted payload. The
   * control wraps it in `{ id: <tempId>, raw }`. Default: a card-shaped row
   * `{ id, attributes: { title } }` from the payload's `title` field.
   */
  optimisticRaw?: (payload: Record<string, unknown>) => Record<string, unknown>;
  /** Dotted field in the success result carrying the new id (default 'id'). */
  resultIdField?: string;
}

/**
 * Generic delete config. A Delete button in the detail pane fires the `delete`
 * intent with `{ id }` for the selected row, OPTIMISTICALLY removing it from
 * `<scopeKey>.items` (auto-rollback on fault).
 */
export interface MasterDetailDelete {
  /** Spec key the delete fires (e.g. 'card.delete'). */
  spec: string;
  /** Declarative input map (payload → wire). Reads `{ payload: 'id' }`. */
  input: InputSpec;
  /** Confirm prompt text; absent → no confirm gate (deletes immediately). */
  confirm?: string;
  /** Delete button label. Default 'Delete'. */
  buttonLabel?: string;
}

/**
 * A detail-pane action button that raises a GLOBAL (bus) intent for the selected
 * item — e.g. Import / Export a project (the AppShell's `projectImport` /
 * `projectExport` intents). The MasterDetail emits `{ projectId, anchor }` where
 * `projectId` is the selected item's id (bigint) and `anchor` is the button
 * (popover-anchored intents like projectExport use it).
 */
export interface MasterDetailDetailAction {
  /** Button label. */
  label: string;
  /** The bus intent to raise (e.g. 'projectImport' / 'projectExport'). */
  intent: string;
  /** Optional button class (default 'btn'). */
  className?: string;
}

/**
 * A detail-pane relation editor section (Users role assign/revoke + person
 * link/unlink). Renders a list of the selected row's existing relations (read
 * from `listField`) each with a Revoke/Remove button, plus an optional inline
 * "+ Add" form. Each action fires a declarative spec via an intent and then
 * RELOADS the affected row (the list query refires) so the detail reflects the
 * server truth.
 */
export interface MasterDetailRelation {
  /** Section heading (e.g. 'Roles', 'Linked person'). */
  title: string;
  /** Dotted accessor (into the row's raw) for the existing relations array. */
  listField?: string;
  /**
   * For a SINGULAR relation (e.g. a user's linked person card): a dotted
   * accessor for the single value. When present + non-empty, one row renders
   * with that value + the remove button; absent → '— (none)'. Mutually
   * exclusive with `listField`.
   */
  valueField?: string;
  /** Per-relation label field (dotted, into each relation entry). */
  itemLabel?: string;
  /** A second muted label field (e.g. the scope project title). */
  itemSubLabel?: string;
  /** The remove intent + spec + its declarative input (payload → wire). */
  remove?: { intent: string; spec: string; label?: string; input: InputSpec };
  /** Inline add form: an intent + spec + fields + its declarative input. */
  add?: {
    intent: string;
    spec: string;
    label?: string;
    fields: MasterDetailFormField[];
    input: InputSpec;
  };
}

/** One detail-pane field descriptor. */
export interface MasterDetailField {
  /** Dotted accessor INTO the row's `raw` object, e.g. 'attributes.title'. */
  name: string;
  /** Field label shown in the detail pane. */
  label: string;
  /**
   * How the field renders:
   *   - 'text'     single-line inline-editable input
   *   - 'textarea' multi-line inline-editable textarea
   *   - 'readonly' read-only value
   *   - 'select'   inline-editable <select> (needs `options`)
   *   - 'badges'   read-only chip list (value is an array; each item rendered
   *                via `badgeLabel`/`badgeField` or stringified)
   */
  kind: 'text' | 'textarea' | 'readonly' | 'select' | 'badges';
  /** When true (and kind is text/textarea/select) the field fires updateSpec. */
  editable?: boolean;
  /** Options for kind:'select' — a static list or a `{ fromPath }` tree path. */
  options?: FieldOptions;
  /**
   * For kind:'badges' whose array items are objects: the dotted field to show
   * per item (e.g. 'role_name'). Items that are strings render verbatim.
   */
  badgeField?: string;
}

export interface MasterDetailConfig extends BaseControlConfig {
  type: 'MasterDetail';
  /** Screen title shown above the list pane. */
  title: string;
  /** Tree namespace holding `<scopeKey>.items` + `<scopeKey>.selectedId`. */
  scopeKey: string;
  /**
   * Optional dotted tree path bumped (as a +1 nonce) after any successful
   * create / edit / delete. Lets another control react to this screen's writes
   * — e.g. the admin Screens screen sets `shell.navRefresh` so the data-driven
   * sidebar nav reloads when a screen is renamed / added / removed.
   */
  refreshNonce?: string;
  /**
   * Auxiliary option lists to load on mount, so a select field's
   * `options: { fromPath }` is DATA-DRIVEN from the server rather than hardcoded
   * (e.g. the role-assign select loads `role.list` instead of a literal role
   * list). Each entry calls `spec` and lands `{value,label}[]` (mapped from
   * `valueField`/`labelField`) at the dotted tree path `landAt`.
   */
  prefetch?: Array<{
    spec: string;
    /** Optional declarative input (InputSpec). With `scoped`, `{ from: 'scope.projectId' }`
     *  resolves at fire time and the fetch re-runs on a project switch. */
    input?: InputSpec;
    /** When true, resolve `input` via the tree/scope and refetch on a project
     *  switch — for project-scoped option lists (e.g. the active project's screens). */
    scoped?: boolean;
    landAt: string;
    valueField: string;
    labelField: string;
  }>;
  list: {
    /** Query spec key (e.g. 'card.select_with_attributes', 'user.list_with_roles'). */
    spec: string;
    /** Declarative input for the list query. */
    input?: InputSpec;
    /**
     * When the list query fires. Default 'mount'. Project-scoped admin reads
     * (comm channels / logs / activity sinks) pass `{ signal: 'scope.projectId' }`
     * so the list refires when the shared project scope changes — same posture
     * as the kanban board. Threaded straight through to the list QueryBinding;
     * the control body is unchanged.
     */
    when?: QueryBinding['when'];
    /**
     * Suppress the fire when any of these resolved input fields is null/undefined.
     * Project-scoped reads list the scope-derived field (e.g. `projectId`) so the
     * screen stays idle until a project resolves. Threaded through to the
     * QueryBinding's `skipWhenNull`.
     */
    skipWhenNull?: string[];
    /** Fixed row height (px). Default 56. */
    rowHeight?: number;
    /** Client-side substring filter config. */
    search?: { field: string; placeholder?: string };
    /** Client-side row predicate: keep only rows where it returns true (applied
     *  before the search filter). E.g. the Attributes screen hides built-ins. */
    rowFilter?: (raw: Record<string, unknown>) => boolean;
    /**
     * Row field accessors (dotted, into the row's `raw`). `badge` is either a
     * dotted field (rendered verbatim) or `{ field, labels }` — a data-driven
     * value→label map (case-insensitive on the stringified value). With a map,
     * an unmapped/empty value hides the badge — e.g. `is_template` →
     * `{ field: 'attributes.is_template', labels: { true: 'Template' } }` shows
     * "Template" only for templates, never a bare "TRUE".
     */
    row: { title: string; subtitle?: string; badge?: string | { field: string; labels?: Record<string, string> } };
    /**
     * Optional STRUCTURED predicate filter, mounted above the list. ONLY for
     * card-backed admin screens (the list spec is `card.select_with_attributes`,
     * which accepts `where[]` / `tree`). When set, a {@link PredicateFilter} over
     * `cardType` mounts above the list; its predicate is ANDed into the list
     * query (flat AND → `where[]`; structured → the v2 `tree` field). Absent on
     * non-card admin screens (flow.list / role.list / …) — those get no filter.
     *
     * `optionsPath` (when set) is forwarded to the editor's `optionsPath` so its
     * card_ref pickers read `Record<targetCardType, {value,label}[]>` lookups the
     * host pre-loaded. The default is `<scopeKey>.predicateOptions`.
     */
    predicateFilter?: { cardType: string; optionsPath?: string };
  };
  detail: {
    /** Dotted accessor for the detail header title. */
    titleField: string;
    /** Placeholder shown when nothing is selected. */
    empty?: string;
    fields: MasterDetailField[];
    /**
     * Editable fields fire this spec (e.g. 'attribute.update') with input
     * `{ cardId, attributeName, value }` — optimistic patch + rollback.
     */
    updateSpec?: string;
    /**
     * Optional relation editors rendered below the fields (Users role
     * assign/revoke + person link/unlink). Each mutates the selected row and
     * reloads it after — see {@link MasterDetailRelation}.
     */
    relations?: MasterDetailRelation[];
    /**
     * Optional richer nested-collection editor rendered below the fields
     * (Workflows flow-step transitions, Attributes edge matrix, Screens filter
     * cards). Mounts a `NestedEditor` of the given `kind` into the detail pane;
     * it watches THIS screen's `<scopeKey>.selectedId` + `<scopeKey>.items` and
     * fires its own reads/writes. `scopeKey` is the editor's own tree namespace
     * (default `<screen scopeKey>.nested`). See `admin/nested-editor.ts`.
     */
    nested?: {
      kind:
        | 'flowSteps'
        | 'edgeMatrix'
        | 'screenFilters'
        | 'commChannelConfig'
        | 'activitySinkConfig'
        | 'agentTokens'
        | 'roleMappings';
      scopeKey?: string;
    };
    /**
     * Optional generic RecordForm editor rendered below the fields — the
     * config-driven replacement for a bespoke `nested` editor. Mounts a
     * `RecordForm` that watches THIS screen's `<scopeKey>.selectedId` +
     * `.items`, renders the field table, and owns save + list refresh. See
     * `admin/record-form.ts`; the Comm Channels screen is the first adopter.
     */
    form?: RecordFormScreenConfig;
    /**
     * Detail-pane action buttons that raise a GLOBAL (bus) intent for the
     * selected item — e.g. the Projects screen's Import / Export, reusing the
     * AppShell's `projectImport` / `projectExport` intents. The emitted payload
     * carries the selected item's id as `projectId` (bigint) + the button as
     * `anchor` (popover-anchored intents like projectExport use it). Hidden for
     * a pending (un-persisted) row.
     */
    actions?: MasterDetailDetailAction[];
  };
  /**
   * Opt-in generic create affordance ("+ New" button → dialog → optimistic
   * add). Card-backed screens use `card.insert`; Contacts uses `person.create`.
   */
  create?: MasterDetailCreate;
  /**
   * Opt-in generic delete affordance (a Delete button on the selected detail →
   * optimistic remove). Card-backed screens use `card.delete`.
   */
  delete?: MasterDetailDelete;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    MasterDetail: MasterDetailConfig;
  }
}

/* -------------------------------------------------------------------------- */
/* Uniform row model.                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The normalised item shape stored at `<scopeKey>.items`. `id` is a canonical
 * STRING (compared as strings everywhere, sidestepping the bigint-revival
 * boot-ordering pitfall the Svelte client hit); `raw` is the decoded server row
 * the field accessors read dotted paths out of.
 */
export interface MasterDetailItem {
  id: string;
  raw: Record<string, unknown>;
}

/** Read a dotted path out of a plain object (no reactivity). */
export function readPath(obj: unknown, dotted: string): unknown {
  if (dotted === '') return obj;
  let cur: unknown = obj;
  for (const seg of dotted.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Coerce a dotted-path value to a display string ('' for null/undefined). */
export function fieldText(raw: Record<string, unknown>, dotted: string): string {
  const v = readPath(raw, dotted);
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  return String(v);
}

/**
 * Normalise one decoded server row into a `MasterDetailItem`. The id is read
 * from `row.id` (card rows + user rows both carry it) and stringified.
 */
export function normaliseRow(row: unknown): MasterDetailItem | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const idRaw = r['id'];
  if (idRaw === null || idRaw === undefined) return null;
  return { id: String(idRaw), raw: r };
}

/** Filter items by a case-insensitive substring over `searchField`. */
export function filterItems(
  items: readonly MasterDetailItem[],
  searchField: string,
  needle: string,
): MasterDetailItem[] {
  const n = needle.trim().toLowerCase();
  if (n.length === 0) return [...items];
  return items.filter((it) => fieldText(it.raw, searchField).toLowerCase().includes(n));
}

/* -------------------------------------------------------------------------- */
/* Optimistic temp ids — a fresh negative bigint per pending create. Real ids   */
/* are positive, so a negative temp id never collides with a server id; it is   */
/* rendered as a string in the uniform item model (selection compares strings). */
/* -------------------------------------------------------------------------- */

let optimisticSeq = -1n;
function nextOptimisticId(): string {
  const id = optimisticSeq;
  optimisticSeq -= 1n;
  return id.toString();
}

/* -------------------------------------------------------------------------- */
/* Binding builders — turn a config into declarative query/action tables.      */
/* -------------------------------------------------------------------------- */

/**
 * Build the list QueryBinding for a config. Fires on mount, lands rows in the
 * `landItems` handler (which normalises + writes `<scopeKey>.items`). Errors
 * self-represent (inline list fault).
 */
export function needsReloadTrigger(cfg: MasterDetailConfig): boolean {
  // The relation actions (Users role/person) RELOAD the list after mutating a
  // row, so a non-predicate, non-scoped screen still needs the `listVersion`
  // trigger to refire. Create/delete are optimistic (no reload), but harmless to
  // include — the trigger fires once on mount either way.
  return (cfg.detail.relations?.length ?? 0) > 0;
}

export function listQuery(cfg: MasterDetailConfig): QueryBinding {
  const hasPredicate = cfg.list.predicateFilter !== undefined;
  // A predicate filter, OR a screen whose detail-relation actions reload the
  // list, drives the list query off the `<scopeKey>.listVersion` leaf the
  // control bumps. Project-scoped screens keep their `{ signal: scope }` trigger
  // (none of them carry relations in this pass), so they're unaffected.
  const useVersion = hasPredicate || needsReloadTrigger(cfg);
  const q: QueryBinding = {
    name: 'list',
    // With a structured predicate filter, the list query refires on a
    // `<scopeKey>.listVersion` leaf the control bumps when the predicate changes
    // (a one-way query-version trigger, the same shape the task screens use).
    // Without one, the configured trigger (default 'mount') stands.
    spec: cfg.list.spec,
    when: useVersion ? { signal: `${cfg.scopeKey}.listVersion` } : (cfg.list.when ?? 'mount'),
    result: { method: 'landItems' },
    onError: 'self',
  };
  if (hasPredicate) {
    // AND the predicate into the list query: where[] (flat AND) / tree (v2). The
    // control's effect resolves these leaves at fire time from the editor's
    // predicate (see applyPredicate). Merge with any static input the config set.
    q.input = {
      ...(cfg.list.input ?? {}),
      where: { from: `${cfg.scopeKey}.where` },
      tree: { from: `${cfg.scopeKey}.tree` },
    };
  } else if (cfg.list.input) {
    q.input = cfg.list.input;
  }
  if (cfg.list.skipWhenNull) q.skipWhenNull = cfg.list.skipWhenNull;
  return q;
}

/**
 * Build the update ActionBinding for editable fields. Fires on the
 * 'editField' intent with payload `{ id, attributeName, value }`; patches the
 * matching `<scopeKey>.items` row in place (optimistic) and rolls back on
 * fault. Returns `null` when no `updateSpec` is configured (read-only screen).
 */
export function updateAction(cfg: MasterDetailConfig): ActionBinding | null {
  const spec = cfg.detail.updateSpec;
  if (!spec) return null;
  const itemsPath = `${cfg.scopeKey}.items`;
  return {
    intent: 'editField',
    spec,
    input: {
      cardId: { payload: 'id' },
      attributeName: { payload: 'attributeName' },
      value: { payload: 'value' },
    },
    optimistic: {
      path: itemsPath,
      patch: (current, payload): MasterDetailItem[] => {
        const rows = Array.isArray(current) ? (current as MasterDetailItem[]) : [];
        const p = (payload ?? {}) as { id?: string; attributeName?: string; value?: unknown };
        const { id, attributeName, value } = p;
        if (id === undefined || attributeName === undefined) return rows;
        return rows.map((it) => {
          if (it.id !== id) return it;
          // attribute.update sets ONE attribute under `attributes.<name>` for a
          // card row; for a flat row (no `attributes`) patch the top-level key.
          const raw = { ...it.raw };
          if (raw['attributes'] && typeof raw['attributes'] === 'object') {
            raw['attributes'] = {
              ...(raw['attributes'] as Record<string, unknown>),
              [attributeName]: value,
            };
          } else {
            raw[attributeName] = value;
          }
          return { id: it.id, raw };
        });
      },
    },
    result: { method: 'afterWrite' }, // bump refreshNonce on edit success (no-op if unset)
    onError: 'top',
  };
}

/** Default card-shaped optimistic raw from a payload: the `title` field plus any
 *  `attribute`-flagged fields the create folded into `payload.attributes` (so
 *  the optimistic row shows e.g. the screen's layout badge before the reload). */
function defaultOptimisticRaw(payload: Record<string, unknown>): Record<string, unknown> {
  const title = payload['title'];
  const attrs = payload['attributes'];
  return {
    attributes: {
      title: typeof title === 'string' ? title : '',
      ...(attrs && typeof attrs === 'object' ? (attrs as Record<string, unknown>) : {}),
    },
  };
}

/**
 * Build the create ActionBinding. Fires on the 'createItem' intent with the
 * dialog payload (which carries an `__optimisticId`). Optimistically appends a
 * temp-id row to `<scopeKey>.items` (built by the config's `optimisticRaw`),
 * auto-rolls-back on fault, and on success promotes the temp id to the
 * server-returned id via the 'landCreated' handler. Returns null when no
 * create is configured.
 */
export function createAction(cfg: MasterDetailConfig): ActionBinding | null {
  const create = cfg.create;
  if (!create) return null;
  const itemsPath = `${cfg.scopeKey}.items`;
  const buildRaw = create.optimisticRaw ?? defaultOptimisticRaw;
  return {
    intent: 'createItem',
    spec: create.spec,
    input: create.input,
    optimistic: {
      path: itemsPath,
      patch: (current, payload): MasterDetailItem[] => {
        const rows = Array.isArray(current) ? (current as MasterDetailItem[]) : [];
        const p = (payload ?? {}) as Record<string, unknown>;
        const id = typeof p['__optimisticId'] === 'string' ? (p['__optimisticId'] as string) : nextOptimisticId();
        const raw = { ...buildRaw(p) };
        raw['id'] = id;
        return [...rows, { id, raw }];
      },
    },
    result: { method: 'landCreated' },
    onError: 'top',
  };
}

/**
 * Build the delete ActionBinding. Fires on the 'deleteItem' intent with
 * `{ id }`; optimistically removes the matching `<scopeKey>.items` row and
 * rolls back on fault. Returns null when no delete is configured.
 */
export function deleteAction(cfg: MasterDetailConfig): ActionBinding | null {
  const del = cfg.delete;
  if (!del) return null;
  const itemsPath = `${cfg.scopeKey}.items`;
  return {
    intent: 'deleteItem',
    spec: del.spec,
    input: del.input,
    optimistic: {
      path: itemsPath,
      patch: (current, payload): MasterDetailItem[] => {
        const rows = Array.isArray(current) ? (current as MasterDetailItem[]) : [];
        const id = (payload ?? {}) as { id?: string };
        if (id.id === undefined) return rows;
        return rows.filter((it) => it.id !== id.id);
      },
    },
    result: { method: 'afterWrite' }, // bump refreshNonce on delete success (no-op if unset)
    onError: 'top',
  };
}

/**
 * Build the declarative actions for the detail relations (Users role
 * assign/revoke + person unlink). Each relation's add/remove fires its own
 * intent → spec; on success the 'reloadList' handler refires the list query so
 * the mutated row reflects the server truth (these aren't simple in-place
 * patches — a role grant can collapse a duplicate, an unlink touches a
 * sibling table). NO optimistic patch: the reload is the source of truth.
 */
export function relationActions(cfg: MasterDetailConfig): ActionBinding[] {
  const rels = cfg.detail.relations;
  if (!rels) return [];
  const out: ActionBinding[] = [];
  for (const rel of rels) {
    if (rel.add) {
      out.push({
        intent: rel.add.intent,
        spec: rel.add.spec,
        input: rel.add.input,
        result: { method: 'reloadList' },
        onError: 'top',
      });
    }
    if (rel.remove) {
      out.push({
        intent: rel.remove.intent,
        spec: rel.remove.spec,
        input: rel.remove.input,
        result: { method: 'reloadList' },
        onError: 'top',
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* The control.                                                                */
/* -------------------------------------------------------------------------- */

const DEFAULT_ROW_HEIGHT = 56;

export class MasterDetail extends Control<MasterDetailConfig> {
  private vlist: VirtualListHandle | null = null;
  /** The create dialog (built when `config.create` is set), or null. */
  private createDialog: CreateDialog | null = null;
  /** Id of the most recent optimistic create so the success sink promotes it. */
  private pendingCreateId: string | null = null;

  private get itemsPath(): string[] {
    return `${this.config.scopeKey}.items`.split('.');
  }
  private get selectedPath(): string[] {
    return `${this.config.scopeKey}.selectedId`.split('.');
  }
  private get searchPath(): string[] {
    return `${this.config.scopeKey}.search`.split('.');
  }

  /** Visible list rows: the config `rowFilter` (if any), then the search needle. */
  private visibleItems(
    all: MasterDetailItem[],
    searchField: string | undefined,
    needle: string,
  ): MasterDetailItem[] {
    const rf = this.config.list.rowFilter;
    const kept = rf ? all.filter((it) => rf(it.raw)) : all;
    return searchField ? filterItems(kept, searchField, needle) : kept;
  }
  private get predicatePath(): string[] {
    return `${this.config.scopeKey}.predicate`.split('.');
  }
  private get whereFilterPath(): string[] {
    return `${this.config.scopeKey}.where`.split('.');
  }
  private get treeFilterPath(): string[] {
    return `${this.config.scopeKey}.tree`.split('.');
  }
  private get listVersionPath(): string[] {
    return `${this.config.scopeKey}.listVersion`.split('.');
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'masterdetail';
    el.dataset.control = 'MasterDetail';
    el.tabIndex = -1;
    return el;
  }

  protected render(): void {
    const cfg = this.config;
    const rowHeight = cfg.list.rowHeight ?? DEFAULT_ROW_HEIGHT;

    // Data-driven auxiliary option lists (e.g. role.list → the role-assign
    // select; the active project's screens → the named-filter parent picker).
    // Lands {value,label}[] at `landAt` for a select field's `options:{fromPath}`.
    // Static entries fetch once; `scoped` entries resolve `input` (so
    // `{from:'scope.projectId'}` works) + refetch on a project switch. One-way.
    const runPrefetch = (pf: NonNullable<MasterDetailConfig['prefetch']>[number], input: Record<string, unknown>): void => {
      this.ctx.api.callByName(
        pf.spec,
        input,
        (out) => {
          if (!this.isAlive()) return;
          const rows = extractRows(out);
          const opts = rows.map((r) => ({
            value: String(readPath(r, pf.valueField) ?? ''),
            label: String(readPath(r, pf.labelField) ?? ''),
          }));
          this.ctx.tree.at(pf.landAt.split('.')).set(opts);
        },
        { alive: () => this.isAlive() },
      );
    };
    for (const pf of cfg.prefetch ?? []) {
      if (pf.scoped === true) {
        // Re-resolve + refetch whenever the active project changes.
        this.effect(() => {
          this.ctx.tree.at(['scope', 'projectId']).get();
          runPrefetch(pf, resolveInput(pf.input, { tree: this.ctx.tree, config: {} }));
        }, `masterDetail.prefetch.${pf.landAt}`);
      } else {
        runPrefetch(pf, resolveInput(pf.input, { tree: this.ctx.tree, config: {} }));
      }
    }

    // The list query lands its rows here: NORMALISE every decoded row to a
    // uniform { id, raw } and write `<scopeKey>.items` (one tree write outside
    // any tracked effect — cascade-safe). Handles both `{ rows: [...] }` and a
    // bare array result so it is source-agnostic.
    this.handler('landItems', (out) => {
      const rowsRaw = extractRows(out);
      const items = rowsRaw
        .map(normaliseRow)
        .filter((it): it is MasterDetailItem => it !== null);
      this.ctx.tree.at(this.itemsPath).set(items);
    });

    // Create success sink: promote the pending optimistic temp-id row to the
    // server-returned id (read at the config's `resultIdField`, default 'id').
    // Closes the dialog if it's still open. The optimistic txn already committed
    // before this fires (DataController commits then deliverResult).
    this.handler('landCreated', (out) => {
      const tempId = this.pendingCreateId;
      this.pendingCreateId = null;
      if (tempId === null) return;
      const idField = cfg.create?.resultIdField ?? 'id';
      const realId = readPath(out, idField);
      const node = this.ctx.tree.at(this.itemsPath);
      const rows = (node.peek<MasterDetailItem[]>() ?? []) as MasterDetailItem[];
      const realIdStr = realId === null || realId === undefined ? null : String(realId);
      if (realIdStr === null || realIdStr === '' || realIdStr === '0') return;
      node.set(
        rows.map((it) => {
          if (it.id !== tempId) return it;
          const raw = { ...it.raw, id: realIdStr };
          return { id: realIdStr, raw };
        }),
      );
      // Admin screens: just call the server again — replace the optimistic
      // (payload-shaped) row with the canonical server row so every column /
      // detail field is correct (no "(untitled)", no per-screen optimisticRaw
      // guesswork needed).
      this.reloadListFromServer();
      this.bumpRefresh(); // a new row may belong in a dependent view (e.g. the nav)
    });

    // Edit / delete success sink: bump the optional refreshNonce so a dependent
    // view reacts (e.g. the sidebar nav reloads after a screen is renamed /
    // removed). A no-op when `refreshNonce` isn't configured.
    this.handler('afterWrite', () => this.bumpRefresh());

    // Relation reload sink: bump the listVersion leaf so the list query refires
    // and the mutated row reflects server truth. A one-way tree write (outside
    // any tracked effect) — cascade-safe.
    this.handler('reloadList', () => this.bumpListVersion());

    /* ------------------------------ panes ----------------------------- */
    const listPane = document.createElement('div');
    listPane.className = 'masterdetail__list-pane';

    const heading = document.createElement('div');
    heading.className = 'masterdetail__heading';
    const h1 = document.createElement('h1');
    h1.className = 'masterdetail__title';
    h1.textContent = cfg.title;
    heading.append(h1);

    // The "+ New" create affordance (opt-in via config.create). Opens a dialog
    // of the configured fields → fires the declarative `createItem` action
    // (optimistic add). Built once; the dialog host is appended to the section.
    if (cfg.create) {
      const newBtn = document.createElement('button');
      newBtn.type = 'button';
      newBtn.className = 'btn btn-primary masterdetail__new';
      newBtn.dataset.mdNew = '';
      newBtn.textContent = cfg.create.buttonLabel ?? '+ New';
      heading.append(newBtn);
      this.listen(newBtn, 'click', () => this.createDialog?.open());
    }

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'masterdetail__search';
    search.dataset.mdSearch = '';
    search.placeholder = cfg.list.search?.placeholder ?? 'Search…';
    search.setAttribute('aria-label', `Search ${cfg.title}`);

    const fault = document.createElement('div');
    fault.className = 'masterdetail__fault';
    fault.style.display = 'none';

    // The list scroll viewport (positioned + overflow-y, the visible scrollbar
    // from the .scroll-y utility); the recycling row pool tiles inside it.
    const list = document.createElement('ul');
    list.className = 'masterdetail__list scroll-y';
    list.dataset.mdList = '';

    const empty = document.createElement('li');
    empty.className = 'masterdetail__list-empty muted';
    empty.dataset.mdListEmpty = '';
    empty.textContent = 'No matching items.';
    empty.style.display = 'none';

    listPane.append(heading, search, fault, list, empty);

    // Optional STRUCTURED predicate filter (card-backed screens only). Mounted
    // above the search; its predicate is ANDed into the list query (see the
    // applyPredicate effect + listQuery's where[]/tree inputs).
    this.mountPredicateFilter(listPane, search);

    const detailPane = document.createElement('div');
    detailPane.className = 'masterdetail__detail-pane scroll-y';
    detailPane.dataset.mdDetail = '';

    // The scalar-field detail body that `renderDetail` rewrites on each
    // selection/items change. A persistent nested-editor host (when configured)
    // sits BELOW it so the spawned NestedEditor child survives detail repaints.
    const detailFields = document.createElement('div');
    detailFields.className = 'masterdetail__detail-fields';
    detailFields.dataset.mdDetailFields = '';
    detailPane.append(detailFields);

    // The editable RecordForm (when configured) sits ABOVE any nested editor —
    // e.g. Workflows shows its name/description/default-create fields first,
    // then the flow-step transition list below.
    if (cfg.detail.form) {
      const formHost = document.createElement('div');
      formHost.className = 'masterdetail__form';
      formHost.dataset.mdForm = '';
      detailPane.append(formHost);
      this.spawn(
        'RecordForm',
        { ...cfg.detail.form, type: 'RecordForm', parentScope: cfg.scopeKey, scopeKey: `${cfg.scopeKey}.form` },
        formHost,
      );
    }

    if (cfg.detail.nested) {
      const nestedHost = document.createElement('div');
      nestedHost.className = 'masterdetail__nested';
      nestedHost.dataset.mdNested = '';
      detailPane.append(nestedHost);
      this.spawn(
        'NestedEditor',
        {
          type: 'NestedEditor',
          kind: cfg.detail.nested.kind,
          parentScope: cfg.scopeKey,
          scopeKey: cfg.detail.nested.scopeKey ?? `${cfg.scopeKey}.nested`,
        },
        nestedHost,
      );
    }

    this.el.append(listPane, detailPane);

    // Build the create dialog host (hidden until opened) when create is set.
    if (cfg.create) {
      this.createDialog = this.buildCreateDialog(cfg.create);
      this.el.append(this.createDialog.root);
    }

    /* --------------------------- reactivity --------------------------- */
    const itemsNode = this.ctx.tree.at(this.itemsPath);
    const searchNode = this.ctx.tree.at(this.searchPath);
    const selectedNode = this.ctx.tree.at(this.selectedPath);
    if (itemsNode.peek() === undefined) itemsNode.set([]);
    if (searchNode.peek<string>() === undefined) searchNode.set('');
    if (selectedNode.peek() === undefined) selectedNode.set(null);
    // Seed the listVersion driver for a non-predicate screen whose detail
    // relations reload the list (mountPredicateFilter seeds it on card screens).
    if (cfg.list.predicateFilter === undefined && needsReloadTrigger(cfg)) {
      const v = this.ctx.tree.at(this.listVersionPath);
      if (v.peek<number>() === undefined) v.set(0);
    }

    // Inline self-represented list fault (onError 'self' on the list query).
    this.effect(() => {
      const f = this.fault.get();
      if (!f) {
        fault.style.display = 'none';
        fault.textContent = '';
        return;
      }
      fault.style.display = '';
      fault.textContent = `Failed to load ${cfg.title}: ${describeFault(f)}`;
    }, 'masterdetail.fault');

    const searchField = cfg.list.search?.field;

    // The recycling virtualList over the filtered items. The single data()
    // reads the items leaf, the search leaf, AND the selectedId leaf so a
    // selection change re-windows + repaints (the selected highlight is a pure
    // function of the item id + the tree, applied per row in update()).
    this.vlist = virtualList<MasterDetailItem>({
      container: list,
      rowHeight,
      data: () => {
        const all = (itemsNode.get<MasterDetailItem[]>() ?? []) as MasterDetailItem[];
        const needle = searchNode.get<string>() ?? '';
        selectedNode.get(); // subscribe so a selection move re-renders the window
        return this.visibleItems(all, searchField, needle);
      },
      // NO key: a row's selected class can change while its id + slot stay
      // fixed, so update() must run for every visible slot on each render.
      create: (el) => this.buildRowShell(el),
      update: (el, it) => this.fillRow(el, it),
      name: `masterdetail.${cfg.scopeKey}.list`,
    });
    this.onDestroy(() => this.vlist?.dispose());

    // Empty-state toggle (reads the same two leaves, writes only DOM).
    this.effect(() => {
      const all = (itemsNode.get<MasterDetailItem[]>() ?? []) as MasterDetailItem[];
      const needle = searchNode.get<string>() ?? '';
      const has = this.visibleItems(all, searchField, needle).length > 0;
      empty.style.display = has ? 'none' : '';
      list.style.display = has ? '' : 'none';
    }, 'masterdetail.empty');

    // The detail FIELDS re-render whenever the selection OR the items change
    // (an optimistic edit patches the items leaf → the detail reflects it). The
    // nested editor (when configured) is a persistent child host below; it is
    // NOT cleared here and watches the selection itself.
    this.effect(() => {
      const sel = selectedNode.get<string | null>();
      const all = (itemsNode.get<MasterDetailItem[]>() ?? []) as MasterDetailItem[];
      this.renderDetail(detailFields, sel ?? null, all);
    }, 'masterdetail.detail');

    /* -------------------------- interactions ------------------------- */
    if (searchField) {
      this.listen(search, 'input', () => {
        this.ctx.tree.at(this.searchPath).set(search.value);
      });
    } else {
      search.style.display = 'none';
    }
  }

  /* ----------------------------- list render ---------------------------- */

  /** Build ONE pooled row's DOM (virtualList create) — once per pool slot. */
  private buildRowShell(li: HTMLElement): void {
    li.className = 'masterdetail__row';
    li.dataset.mdRow = '';

    const main = document.createElement('div');
    main.className = 'masterdetail__row-main';

    const titleEl = document.createElement('span');
    titleEl.className = 'masterdetail__row-title';
    titleEl.dataset.role = 'title';

    const subtitleEl = document.createElement('span');
    subtitleEl.className = 'masterdetail__row-subtitle muted';
    subtitleEl.dataset.role = 'subtitle';

    main.append(titleEl, subtitleEl);

    const badge = document.createElement('span');
    badge.className = 'masterdetail__row-badge';
    badge.dataset.role = 'badge';
    badge.style.display = 'none';

    li.append(main, badge);

    // The click handler resolves the row's CURRENT item from data-md-id (set
    // per fill) against the live visible snapshot — the node is recycled.
    this.listen(li, 'click', () => {
      const id = li.dataset.mdId;
      if (id !== undefined) this.select(id);
    });
  }

  /** Swap a pooled row's content for `it` (virtualList update). Selected class
   *  derived from the tree's selectedId — never node state (rows recycle). */
  private fillRow(li: HTMLElement, it: MasterDetailItem): void {
    const cfg = this.config;
    li.dataset.mdId = it.id;
    const selected = (this.ctx.tree.at(this.selectedPath).peek<string | null>() ?? null) === it.id;
    li.classList.remove('masterdetail__row--selected');
    if (selected) li.classList.add('masterdetail__row--selected');

    const title = childByRole(li, 'title');
    if (title) title.textContent = fieldText(it.raw, cfg.list.row.title) || '(untitled)';

    const subtitle = childByRole(li, 'subtitle');
    if (subtitle) {
      const sub = cfg.list.row.subtitle ? fieldText(it.raw, cfg.list.row.subtitle) : '';
      subtitle.textContent = sub;
      subtitle.style.display = sub ? '' : 'none';
    }

    const badge = childByRole(li, 'badge');
    if (badge) {
      const b = badgeTextFor(cfg.list.row.badge, it.raw);
      badge.textContent = b;
      badge.style.display = b ? '' : 'none';
    }
  }

  /** Write the selection to the TREE (recycling-safe). The list + detail effects
   *  both read `<scopeKey>.selectedId` and repaint. One-way write, cascade-safe. */
  private select(id: string): void {
    this.ctx.tree.at(this.selectedPath).set(id);
  }

  /* --------------------------- create / delete -------------------------- */

  /** Bump the listVersion leaf so the `{ signal }` list query refires. */
  private bumpListVersion(): void {
    const node = this.ctx.tree.at(this.listVersionPath);
    node.set((node.peek<number>() ?? 0) + 1);
  }

  /**
   * Re-issue the list read and land items — the "just call the server again"
   * refresh after a create. Admin screens are low-traffic, so the extra
   * round-trip buys correctness for free: the optimistic row (which carries
   * only the create payload's fields) is replaced by the canonical server row,
   * so a flat-row screen never shows a stale "(untitled)". Works regardless of
   * the list's trigger; honours `skipWhenNull` so it never fires unscoped. */
  private reloadListFromServer(): void {
    const cfg = this.config;
    const input = resolveInput(cfg.list.input, {
      tree: this.ctx.tree,
      config: cfg as unknown as Record<string, unknown>,
      ...(this.ctx.scope ? { scope: this.ctx.scope } : {}),
    });
    for (const f of cfg.list.skipWhenNull ?? []) {
      if (input[f] === null || input[f] === undefined) return;
    }
    this.ctx.api.callByName(
      cfg.list.spec,
      input,
      (out) => {
        if (!this.isAlive()) return;
        const items = extractRows(out)
          .map(normaliseRow)
          .filter((it): it is MasterDetailItem => it !== null);
        this.ctx.tree.at(this.itemsPath).set(items);
      },
      { alive: () => this.isAlive() },
    );
  }

  /** Bump the optional cross-control refresh nonce after a write (no-op unless
   *  `config.refreshNonce` is set). A one-way tree write — cascade-safe. */
  private bumpRefresh(): void {
    const path = this.config.refreshNonce;
    if (path === undefined || path === '') return;
    const node = this.ctx.tree.at(path.split('.'));
    node.set((node.peek<number>() ?? 0) + 1);
  }

  /**
   * Fire the declarative `createItem` action. Mint the optimistic temp id HERE
   * (so the success sink promotes the right row) and ride it on the payload as
   * `__optimisticId`; the optimistic patch appends a row with that id, then the
   * spec fires. On fault the tree txn auto-rolls-back.
   */
  private fireCreate(payload: Record<string, unknown>): void {
    const optimisticId = nextOptimisticId();
    this.pendingCreateId = optimisticId;
    this.intent('createItem', { ...payload, __optimisticId: optimisticId });
  }

  /** Fire the declarative `deleteItem` action for the selected row. */
  private fireDelete(id: string): void {
    // Clear the selection so the detail pane returns to its empty state once
    // the optimistic removal lands (the removed id is no longer in items).
    if ((this.ctx.tree.at(this.selectedPath).peek<string | null>() ?? null) === id) {
      this.ctx.tree.at(this.selectedPath).set(null);
    }
    this.intent('deleteItem', { id });
  }

  /* ------------------------- predicate filter --------------------------- */

  /**
   * Mount the optional structured PredicateFilter (card-backed screens only) at
   * the top of the list pane, seed its query-driver leaves, and wire the one-way
   * effect that projects the edited predicate into the list query's where[]/tree
   * leaves + bumps the `<scopeKey>.listVersion` trigger. No-op when the config
   * omits `predicateFilter`.
   */
  private mountPredicateFilter(listPane: HTMLElement, before: HTMLElement): void {
    const pf = this.config.list.predicateFilter;
    if (pf === undefined) return;

    // Seed the query-driver leaves BEFORE the data layer wires (render runs
    // before mount() wires it). Object.is gate makes a re-seed a no-op.
    this.ctx.tree.at(this.whereFilterPath).set(undefined);
    this.ctx.tree.at(this.treeFilterPath).set(undefined);
    const versionNode = this.ctx.tree.at(this.listVersionPath);
    if (versionNode.peek<number>() === undefined) versionNode.set(0);

    const panel = document.createElement('div');
    panel.className = 'masterdetail__predicate';
    panel.dataset.mdPredicate = '';
    // Place the filter above the search field.
    listPane.insertBefore(panel, before);

    const optionsPath = pf.optionsPath ?? `${this.config.scopeKey}.predicateOptions`;
    this.spawn(
      'PredicateFilter',
      {
        type: 'PredicateFilter',
        valuePath: this.predicatePath.join('.'),
        schema: { cardType: pf.cardType },
        optionsPath,
      },
      panel,
    );

    // One-way driver: read ONLY the predicate leaf, write ONLY where/tree/version
    // (never back into a watched dep). Refires the list query on a predicate edit.
    this.effect(() => {
      const predicate = this.ctx.tree.at(this.predicatePath).get<Predicate | null>() ?? null;
      this.applyPredicate(predicate);
      const node = this.ctx.tree.at(this.listVersionPath);
      node.set((node.peek<number>() ?? 0) + 1);
    }, 'masterdetail.predicateWatch');
  }

  /**
   * Project the edited predicate to the list query's `where[]` / `tree` leaves.
   * Flat AND of leaves → `where[]`; structured (OR / NOT / nested) → the v2
   * `tree` field. Empty / null → both undefined so the encoder omits them.
   */
  private applyPredicate(predicate: Predicate | null): void {
    let where: CardWherePredicate[] | undefined;
    let tree: WireNode | undefined;
    if (predicate === null) {
      where = undefined;
    } else if (isFlatAndOfLeaves(predicate)) {
      const leaves = toWhereLeaves(predicate) ?? [];
      where = leaves.length > 0 ? leaves : undefined;
    } else {
      tree = toWire(predicate);
    }
    this.ctx.tree.at(this.whereFilterPath).set(where);
    this.ctx.tree.at(this.treeFilterPath).set(tree);
  }

  /* ---------------------------- detail render --------------------------- */

  /**
   * Render the detail pane for the selected item id. Empty selection (or a
   * stale id no longer present) shows the `detail.empty` placeholder. Each
   * field renders per its `kind`; editable text/textarea/select fields fire the
   * `editField` intent on commit (the declarative update action consumes it).
   */
  private renderDetail(host: HTMLElement, selectedId: string | null, items: readonly MasterDetailItem[]): void {
    const cfg = this.config;
    // When a RecordForm owns the detail pane, it renders the full editable
    // surface (incl. the title/name) below — so the scalar header + readonly
    // fields here would just duplicate it. Leave the scalar host empty.
    if (cfg.detail.form) {
      host.replaceChildren();
      return;
    }
    const item = selectedId === null ? undefined : items.find((it) => it.id === selectedId);

    if (!item) {
      const placeholder = document.createElement('div');
      placeholder.className = 'masterdetail__empty muted';
      placeholder.dataset.mdEmpty = '';
      placeholder.textContent = cfg.detail.empty ?? 'Select an item to see its details.';
      host.replaceChildren(placeholder);
      return;
    }

    const frag = document.createDocumentFragment();

    // Header row: the title + (when delete is configured + the row is real) a
    // Delete action on the right.
    const headerRow = document.createElement('div');
    headerRow.className = 'masterdetail__detail-header';
    const header = document.createElement('h2');
    header.className = 'masterdetail__detail-title';
    header.dataset.mdDetailTitle = '';
    header.textContent = fieldText(item.raw, cfg.detail.titleField) || '(untitled)';
    headerRow.append(header);
    if (cfg.delete) headerRow.append(this.buildDeleteButton(cfg.delete, item));
    frag.append(headerRow);

    for (const f of cfg.detail.fields) {
      frag.append(this.buildField(item, f));
    }

    // Relation editors (Users role assign/revoke + person unlink).
    for (const rel of cfg.detail.relations ?? []) {
      frag.append(this.buildRelation(item, rel));
    }

    // Detail action buttons (e.g. Projects → Import / Export). Hidden for a
    // pending (un-persisted) row, which has no server id to act on.
    const actions = cfg.detail.actions ?? [];
    if (actions.length > 0 && !isPendingId(item.id)) {
      const actionsRow = document.createElement('div');
      actionsRow.className = 'masterdetail__detail-actions';
      actionsRow.dataset.mdActions = '';
      for (const a of actions) actionsRow.append(this.buildDetailAction(a, item));
      frag.append(actionsRow);
    }

    host.replaceChildren(frag);
  }

  /** A detail-pane action button: raises the configured bus intent for the
   *  selected item, carrying `{ projectId, anchor }`. */
  private buildDetailAction(action: MasterDetailDetailAction, item: MasterDetailItem): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = action.className ?? 'btn';
    btn.dataset.mdAction = action.intent;
    btn.textContent = action.label;
    this.listen(btn, 'click', () => {
      if (!/^\d+$/.test(item.id)) return; // pending / non-numeric id → no-op
      this.ctx.bus?.emit(action.intent, { projectId: BigInt(item.id), anchor: btn });
    });
    return btn;
  }

  /** The detail-pane Delete button: confirms (if configured) then fires the
   *  declarative `deleteItem` action for the selected row. A pending optimistic
   *  row (negative id) has no server id, so the delete is disabled for it. */
  private buildDeleteButton(del: MasterDetailDelete, item: MasterDetailItem): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-danger masterdetail__delete';
    btn.dataset.mdDelete = '';
    btn.textContent = del.buttonLabel ?? 'Delete';
    btn.disabled = isPendingId(item.id);
    this.listen(btn, 'click', () => {
      if (isPendingId(item.id)) return;
      if (del.confirm) {
        const ok = typeof confirm === 'function' ? confirm(del.confirm) : true;
        if (!ok) return;
      }
      this.fireDelete(item.id);
    });
    return btn;
  }

  /** Build one detail field row per its kind. */
  private buildField(item: MasterDetailItem, f: MasterDetailField): HTMLElement {
    const row = document.createElement('div');
    row.className = 'masterdetail__field';
    row.dataset.mdField = f.name;

    const label = document.createElement('label');
    label.className = 'masterdetail__field-label muted';
    label.textContent = f.label;
    row.append(label);

    const editable = f.editable === true && this.config.detail.updateSpec !== undefined;

    if (f.kind === 'badges') {
      row.append(this.buildBadges(item, f));
      return row;
    }
    if (f.kind === 'readonly' || !editable) {
      const val = document.createElement('div');
      val.className = 'masterdetail__field-value';
      val.dataset.role = 'value';
      val.textContent = fieldText(item.raw, f.name) || '—';
      row.append(val);
      return row;
    }
    if (f.kind === 'select') {
      row.append(this.buildSelect(item, f));
      return row;
    }
    // text / textarea — inline-editable.
    row.append(this.buildInput(item, f));
    return row;
  }

  private buildInput(item: MasterDetailItem, f: MasterDetailField): HTMLElement {
    const el =
      f.kind === 'textarea'
        ? document.createElement('textarea')
        : document.createElement('input');
    el.className = 'masterdetail__field-input';
    el.dataset.role = 'input';
    const current = fieldText(item.raw, f.name);
    if (el.tagName === 'TEXTAREA') {
      (el as HTMLTextAreaElement).rows = 3;
      el.value = current;
    } else {
      (el as HTMLInputElement).type = 'text';
      el.value = current;
    }

    // Commit on blur OR Enter (single-line) / Mod+Enter (textarea). Only fires
    // when the value actually changed — no needless write on a focus pass.
    const commit = (): void => {
      const next = el.value;
      if (next === current) return;
      this.fireEdit(item.id, attributeNameOf(f), next);
    };
    this.listen(el, 'blur', commit);
    this.listen(el, 'keydown', (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key === 'Escape') {
        el.value = current;
        if (typeof (el as { blur?: () => void }).blur === 'function') (el as HTMLElement).blur();
        return;
      }
      if (e.key === 'Enter') {
        const isTextarea = el.tagName === 'TEXTAREA';
        if (!isTextarea || e.metaKey || e.ctrlKey) {
          e.preventDefault();
          commit();
        }
      }
    });
    return el;
  }

  private buildSelect(item: MasterDetailItem, f: MasterDetailField): HTMLElement {
    const sel = document.createElement('select');
    sel.className = 'masterdetail__field-select';
    sel.dataset.role = 'select';
    const current = fieldText(item.raw, f.name);
    for (const o of this.resolveOptions(f)) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === current) opt.selected = true;
      sel.append(opt);
    }
    sel.value = current;
    this.listen(sel, 'change', () => {
      if (sel.value === current) return;
      this.fireEdit(item.id, attributeNameOf(f), sel.value);
    });
    return sel;
  }

  private buildBadges(item: MasterDetailItem, f: MasterDetailField): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'masterdetail__badges';
    wrap.dataset.role = 'badges';
    const arr = readPath(item.raw, f.name);
    const list = Array.isArray(arr) ? arr : [];
    if (list.length === 0) {
      const none = document.createElement('span');
      none.className = 'masterdetail__field-value muted';
      none.textContent = '—';
      wrap.append(none);
      return wrap;
    }
    for (const entry of list) {
      const chip = document.createElement('span');
      chip.className = 'masterdetail__badge';
      chip.textContent = badgeText(entry, f.badgeField);
      wrap.append(chip);
    }
    return wrap;
  }

  /** Resolve a select field's options — static list or a `{ fromPath }` tree path. */
  private resolveOptions(f: MasterDetailField): Array<{ value: string; label: string }> {
    const opts = f.options;
    if (!opts) return [];
    if (Array.isArray(opts)) return opts;
    const v = this.ctx.tree.at(opts.fromPath.split('.')).peek();
    return Array.isArray(v) ? (v as Array<{ value: string; label: string }>) : [];
  }

  /** Fire the declarative update action for an edited field. */
  private fireEdit(id: string, attributeName: string, value: unknown): void {
    this.intent('editField', { id, attributeName, value });
  }

  /* --------------------------- relation editors ------------------------- */

  /**
   * Build one relation section for the selected row (Users role assign/revoke +
   * person unlink). Renders the existing relations from `rel.listField` (each
   * with a Remove/Revoke button) plus an optional inline add form. Every action
   * carries the selected row's id on its payload (`id`) so the declarative
   * input can map it to the wire (e.g. `user_id`).
   */
  private buildRelation(item: MasterDetailItem, rel: MasterDetailRelation): HTMLElement {
    const section = document.createElement('div');
    section.className = 'masterdetail__relation';
    section.dataset.mdRelation = rel.title;

    const label = document.createElement('div');
    label.className = 'masterdetail__field-label muted';
    label.textContent = rel.title;
    section.append(label);

    const listEl = document.createElement('ul');
    listEl.className = 'masterdetail__relation-list';
    listEl.dataset.mdRelationList = '';

    if (rel.valueField) {
      // SINGULAR relation (e.g. linked person): one row when the value is set.
      const value = fieldText(item.raw, rel.valueField);
      if (value === '') {
        listEl.append(noneRow());
      } else {
        // Synthesise an entry so buildRelationRow shows the value + remove btn.
        listEl.append(this.buildRelationRow(item, rel, { __value: value }, value));
      }
    } else {
      // LIST relation (e.g. roles): one row per existing entry.
      const entries = rel.listField ? readPath(item.raw, rel.listField) : undefined;
      const arr = Array.isArray(entries) ? entries : [];
      if (arr.length === 0) {
        listEl.append(noneRow());
      } else {
        for (const entry of arr) {
          listEl.append(this.buildRelationRow(item, rel, entry as Record<string, unknown>));
        }
      }
    }
    section.append(listEl);

    // Inline add form.
    if (rel.add) section.append(this.buildRelationAdd(item, rel, rel.add));
    return section;
  }

  /** One existing-relation row: a label (+ optional sub-label) + a Revoke btn. */
  private buildRelationRow(
    item: MasterDetailItem,
    rel: MasterDetailRelation,
    entry: Record<string, unknown>,
    labelOverride?: string,
  ): HTMLElement {
    const li = document.createElement('li');
    li.className = 'masterdetail__relation-row';
    li.dataset.mdRelationRow = '';

    const text = document.createElement('span');
    text.className = 'masterdetail__relation-label';
    const main = labelOverride ?? (rel.itemLabel ? fieldText(entry, rel.itemLabel) : '');
    text.textContent = main || '(unnamed)';
    li.append(text);

    if (rel.itemSubLabel) {
      const sub = fieldText(entry, rel.itemSubLabel);
      if (sub) {
        const subEl = document.createElement('span');
        subEl.className = 'masterdetail__relation-sub muted';
        subEl.textContent = sub;
        li.append(subEl);
      }
    }

    if (rel.remove) {
      const remove = rel.remove;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn masterdetail__relation-remove';
      btn.dataset.mdRelationRemove = '';
      btn.textContent = remove.label ?? 'Revoke';
      this.listen(btn, 'click', () => {
        // Payload: the selected row id + the entry fields the input maps from.
        this.intent(remove.intent, { id: item.id, entry, ...entry });
      });
      li.append(btn);
    }
    return li;
  }

  /** The inline "+ Add" form for a relation (e.g. assign role + scope). */
  private buildRelationAdd(
    item: MasterDetailItem,
    rel: MasterDetailRelation,
    add: NonNullable<MasterDetailRelation['add']>,
  ): HTMLElement {
    const form = document.createElement('div');
    form.className = 'masterdetail__relation-add';
    form.dataset.mdRelationAdd = rel.title;

    const inputs = new Map<string, HTMLElement>();
    for (const f of add.fields) {
      inputs.set(f.name, this.buildFormField(form, f));
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn masterdetail__relation-submit';
    btn.dataset.mdRelationSubmit = '';
    btn.textContent = add.label ?? '+ Add';
    this.listen(btn, 'click', () => {
      const payload: Record<string, unknown> = { id: item.id };
      let missingRequired = false;
      for (const f of add.fields) {
        const el = inputs.get(f.name);
        const value = el ? readControlValue(el) : '';
        if (f.required === true && value === '') missingRequired = true;
        payload[f.name] = value;
      }
      if (missingRequired) return;
      this.intent(add.intent, payload);
      // Reset the form fields after a fire (selection-driven reload repaints).
      for (const f of add.fields) {
        const el = inputs.get(f.name);
        if (el) (el as { value?: string }).value = '';
      }
    });
    form.append(btn);
    return form;
  }

  /* ----------------------------- create dialog -------------------------- */

  /**
   * Build the create dialog (a simple modal of the configured fields). Submit
   * collects the field values into a payload and fires `fireCreate` (the
   * declarative `createItem` action with optimistic add). Required-field gating
   * keeps focus; Esc/Cancel closes.
   */
  private buildCreateDialog(create: MasterDetailCreate): CreateDialog {
    const root = document.createElement('div');
    root.className = 'qe-dialog masterdetail__create-dialog';
    root.dataset.mdCreate = '';
    root.style.display = 'none';

    const panel = document.createElement('div');
    panel.className = 'qe-dialog__panel';

    const heading = document.createElement('h2');
    heading.className = 'qe-dialog__title';
    heading.textContent = create.title ?? 'New item';
    panel.append(heading);

    const inputs = new Map<string, HTMLElement>();
    for (const f of create.fields) {
      inputs.set(f.name, this.buildFormField(panel, f, 'qe-dialog'));
    }

    const footer = document.createElement('div');
    footer.className = 'qe-dialog__footer';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn masterdetail__create-cancel';
    cancel.dataset.mdCreateCancel = '';
    cancel.textContent = 'Cancel';
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'btn btn-primary masterdetail__create-submit';
    submit.dataset.mdCreateSubmit = '';
    submit.textContent = 'Create';
    footer.append(cancel, submit);
    panel.append(footer);
    root.append(panel);

    const dialog: CreateDialog = {
      root,
      open: () => {
        for (const f of create.fields) {
          const el = inputs.get(f.name);
          if (el) (el as { value?: string }).value = '';
        }
        root.style.display = '';
        const first = inputs.get(create.fields[0]?.name ?? '');
        if (first && typeof (first as { focus?: () => void }).focus === 'function') {
          (first as { focus: () => void }).focus();
        }
      },
      close: () => {
        root.style.display = 'none';
      },
    };

    const commit = (): void => {
      const payload: Record<string, unknown> = {};
      const attributes: Record<string, unknown> = {};
      let missingRequired = false;
      for (const f of create.fields) {
        const el = inputs.get(f.name);
        const value = el ? readControlValue(el) : '';
        if (f.required === true && value === '') missingRequired = true;
        // `attribute` fields collect into payload.attributes (so a card.insert
        // create can set layout / slug / …); the rest stay top-level.
        if (f.attribute === true) attributes[f.name] = value;
        else payload[f.name] = value;
      }
      if (Object.keys(attributes).length > 0) payload['attributes'] = attributes;
      if (missingRequired) {
        const firstReq = create.fields.find((f) => f.required === true);
        const el = firstReq ? inputs.get(firstReq.name) : undefined;
        if (el && typeof (el as { focus?: () => void }).focus === 'function') {
          (el as { focus: () => void }).focus();
        }
        return;
      }
      this.fireCreate(payload);
      dialog.close();
    };

    this.listen(cancel, 'click', () => dialog.close());
    this.listen(submit, 'click', () => commit());
    return dialog;
  }

  /**
   * Build one form field (text or select) into `host`, returning the editable
   * element (input/select) the form reads its value from. `cls` namespaces the
   * field/label classes (default 'masterdetail__form').
   */
  private buildFormField(host: HTMLElement, f: MasterDetailFormField, cls = 'masterdetail__form'): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = `${cls}__field`;
    const span = document.createElement('span');
    span.className = `${cls}__label`;
    span.textContent = f.label;
    wrap.append(span);

    let el: HTMLElement;
    if (f.kind === 'select') {
      const sel = document.createElement('select');
      sel.className = `${cls}__input`;
      sel.dataset.mdFormField = f.name;
      // Repaint the option set from the field's options. Preserves the current
      // selection across repaints (no-op if it's gone).
      const repaint = (): void => {
        const prev = (sel as { value?: string }).value ?? '';
        sel.replaceChildren();
        if (f.required !== true) {
          const blank = document.createElement('option');
          blank.value = '';
          blank.textContent = f.placeholder ?? '— none —';
          sel.append(blank);
        }
        for (const o of this.resolveFormOptions(f)) {
          const opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.label;
          sel.append(opt);
        }
        (sel as { value?: string }).value = prev;
      };
      const opts = f.options;
      if (opts && !Array.isArray(opts)) {
        // Data-driven (`{ fromPath }`): the option list is loaded by a PREFETCH
        // whose result lands AFTER mount. Subscribe to the path so the <select>
        // populates the moment the prefetch lands (a build-time peek would catch
        // an empty list and never refill). Writes only DOM — cascade-safe.
        const fromPath = opts.fromPath;
        this.effect(() => {
          this.ctx.tree.at(fromPath.split('.')).get(); // subscribe
          repaint();
        }, `md.formField.${cls}.${f.name}`);
      } else {
        repaint();
      }
      el = sel;
    } else {
      const input = document.createElement('input');
      (input as HTMLInputElement).type = 'text';
      input.className = `${cls}__input`;
      input.dataset.mdFormField = f.name;
      if (f.placeholder) (input as HTMLInputElement).placeholder = f.placeholder;
      el = input;
    }
    wrap.append(el);
    host.append(wrap);
    return el;
  }

  /** Resolve a form field's select options — static list or a `{ fromPath }`. */
  private resolveFormOptions(f: MasterDetailFormField): Array<{ value: string; label: string }> {
    const opts = f.options;
    if (!opts) return [];
    if (Array.isArray(opts)) return opts;
    const v = this.ctx.tree.at(opts.fromPath.split('.')).peek();
    return Array.isArray(v) ? (v as Array<{ value: string; label: string }>) : [];
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                    */
/* -------------------------------------------------------------------------- */

/** The create dialog handle (open/close). */
interface CreateDialog {
  root: HTMLElement;
  open(): void;
  close(): void;
}

/** A pending optimistic row carries a negative temp id; it has no server id. */
function isPendingId(id: string): boolean {
  return id.startsWith('-');
}

/** The '— (none)' placeholder row for an empty relation list. */
function noneRow(): HTMLElement {
  const none = document.createElement('li');
  none.className = 'masterdetail__field-value muted';
  none.dataset.mdRelationNone = '';
  none.textContent = '— (none)';
  return none;
}

/** Read the string value off a built form control (input/select). */
function readControlValue(el: HTMLElement): string {
  const v = (el as { value?: unknown }).value;
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

/** Pull the rows array out of a list result (`{ rows: [...] }` or bare array). */
function extractRows(out: unknown): unknown[] {
  if (Array.isArray(out)) return out;
  if (out && typeof out === 'object') {
    const rows = (out as Record<string, unknown>)['rows'];
    if (Array.isArray(rows)) return rows;
  }
  return [];
}

/**
 * The attribute name the update spec targets for a field. For card rows the
 * field accessor is `attributes.<name>`, so strip the `attributes.` prefix to
 * recover the attribute name `attribute.update` expects; otherwise use the
 * field name verbatim (a flat-row update).
 */
function attributeNameOf(f: MasterDetailField): string {
  return f.name.startsWith('attributes.') ? f.name.slice('attributes.'.length) : f.name;
}

/**
 * Resolve a list row's badge text from the `row.badge` config: a verbatim field
 * value, or a `{ field, labels }` value→label map (case-insensitive on the
 * stringified value; an unmapped/empty value → '' so the badge hides).
 */
function badgeTextFor(
  badge: string | { field: string; labels?: Record<string, string> } | undefined,
  raw: Record<string, unknown>,
): string {
  if (badge === undefined) return '';
  if (typeof badge === 'string') return fieldText(raw, badge);
  const value = fieldText(raw, badge.field);
  if (badge.labels === undefined) return value;
  const key = value.toLowerCase();
  for (const [k, label] of Object.entries(badge.labels)) {
    if (k.toLowerCase() === key) return label;
  }
  return '';
}

/** Render one badge entry: a string verbatim, or an object's `badgeField`. */
function badgeText(entry: unknown, badgeField?: string): string {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && badgeField) {
    const v = readPath(entry, badgeField);
    if (typeof v === 'string') return v;
    if (v !== null && v !== undefined) return String(v);
  }
  return String(entry);
}

function childByRole(root: HTMLElement, role: string): HTMLElement | null {
  const kids = root.children;
  for (let i = 0; i < kids.length; i++) {
    const el = kids[i] as HTMLElement;
    if (el.dataset?.role === role) return el;
    const found = childByRole(el, role);
    if (found) return found;
  }
  return null;
}

function describeFault(f: ApiFault): string {
  switch (f.kind) {
    case 'sub_error':
      return `${f.code}: ${f.message}`;
    case 'http':
      return `http ${f.status}`;
    case 'network':
      return `network: ${f.message}`;
    case 'decode':
      return `decode: ${f.message}`;
    case 'aborted':
      return `aborted: ${f.reason}`;
  }
}

/* -------------------------------------------------------------------------- */
/* Screen-config factory.                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Turn a MasterDetailConfig into a ready-to-mount config object with its
 * declarative `queries` + `actions` BUILT FROM THE CONFIG. This is the ONLY
 * thing each admin screen needs: pass the config, get a config the AppShell can
 * mount with NO per-screen control code. The list query + the editable-field
 * update action are derived here, merged onto the instance config's binding
 * tables by the DataController at mount.
 */
export function masterDetailScreen(cfg: MasterDetailConfig): MasterDetailConfig {
  const queries: QueryBinding[] = [listQuery(cfg), ...(cfg.queries ?? [])];
  const update = updateAction(cfg);
  const create = createAction(cfg);
  const del = deleteAction(cfg);
  const actions: ActionBinding[] = [
    ...(update ? [update] : []),
    ...(create ? [create] : []),
    ...(del ? [del] : []),
    ...relationActions(cfg),
    ...(cfg.actions ?? []),
  ];
  return { ...cfg, queries, actions };
}

export function registerMasterDetail(): void {
  Control.register('MasterDetail', MasterDetail);
}
