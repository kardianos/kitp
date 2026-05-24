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
import type { ActionBinding, InputSpec, QueryBinding } from '../core/data.js';
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
    /** Row field accessors (dotted, into the row's `raw`). */
    row: { title: string; subtitle?: string; badge?: string };
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
  };
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
/* Binding builders — turn a config into declarative query/action tables.      */
/* -------------------------------------------------------------------------- */

/**
 * Build the list QueryBinding for a config. Fires on mount, lands rows in the
 * `landItems` handler (which normalises + writes `<scopeKey>.items`). Errors
 * self-represent (inline list fault).
 */
export function listQuery(cfg: MasterDetailConfig): QueryBinding {
  const hasPredicate = cfg.list.predicateFilter !== undefined;
  const q: QueryBinding = {
    name: 'list',
    // With a structured predicate filter, the list query refires on a
    // `<scopeKey>.listVersion` leaf the control bumps when the predicate changes
    // (a one-way query-version trigger, the same shape the task screens use).
    // Without one, the configured trigger (default 'mount') stands.
    spec: cfg.list.spec,
    when: hasPredicate ? { signal: `${cfg.scopeKey}.listVersion` } : (cfg.list.when ?? 'mount'),
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
    onError: 'top',
  };
}

/* -------------------------------------------------------------------------- */
/* The control.                                                                */
/* -------------------------------------------------------------------------- */

const DEFAULT_ROW_HEIGHT = 56;

export class MasterDetail extends Control<MasterDetailConfig> {
  private vlist: VirtualListHandle | null = null;

  private get itemsPath(): string[] {
    return `${this.config.scopeKey}.items`.split('.');
  }
  private get selectedPath(): string[] {
    return `${this.config.scopeKey}.selectedId`.split('.');
  }
  private get searchPath(): string[] {
    return `${this.config.scopeKey}.search`.split('.');
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

    /* ------------------------------ panes ----------------------------- */
    const listPane = document.createElement('div');
    listPane.className = 'masterdetail__list-pane';

    const heading = document.createElement('div');
    heading.className = 'masterdetail__heading';
    const h1 = document.createElement('h1');
    h1.className = 'masterdetail__title';
    h1.textContent = cfg.title;
    heading.append(h1);

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

    this.el.append(listPane, detailPane);

    /* --------------------------- reactivity --------------------------- */
    const itemsNode = this.ctx.tree.at(this.itemsPath);
    const searchNode = this.ctx.tree.at(this.searchPath);
    const selectedNode = this.ctx.tree.at(this.selectedPath);
    if (itemsNode.peek() === undefined) itemsNode.set([]);
    if (searchNode.peek<string>() === undefined) searchNode.set('');
    if (selectedNode.peek() === undefined) selectedNode.set(null);

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
        return searchField ? filterItems(all, searchField, needle) : all;
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
      const has = (searchField ? filterItems(all, searchField, needle) : all).length > 0;
      empty.style.display = has ? 'none' : '';
      list.style.display = has ? '' : 'none';
    }, 'masterdetail.empty');

    // The detail pane re-renders whenever the selection OR the items change
    // (an optimistic edit patches the items leaf → the detail reflects it).
    this.effect(() => {
      const sel = selectedNode.get<string | null>();
      const all = (itemsNode.get<MasterDetailItem[]>() ?? []) as MasterDetailItem[];
      this.renderDetail(detailPane, sel ?? null, all);
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
      const b = cfg.list.row.badge ? fieldText(it.raw, cfg.list.row.badge) : '';
      badge.textContent = b;
      badge.style.display = b ? '' : 'none';
    }
  }

  /** Write the selection to the TREE (recycling-safe). The list + detail effects
   *  both read `<scopeKey>.selectedId` and repaint. One-way write, cascade-safe. */
  private select(id: string): void {
    this.ctx.tree.at(this.selectedPath).set(id);
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

    const header = document.createElement('h2');
    header.className = 'masterdetail__detail-title';
    header.dataset.mdDetailTitle = '';
    header.textContent = fieldText(item.raw, cfg.detail.titleField) || '(untitled)';
    frag.append(header);

    for (const f of cfg.detail.fields) {
      frag.append(this.buildField(item, f));
    }

    host.replaceChildren(frag);
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
}

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                    */
/* -------------------------------------------------------------------------- */

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
  const action = updateAction(cfg);
  const actions: ActionBinding[] = [...(action ? [action] : []), ...(cfg.actions ?? [])];
  return { ...cfg, queries, actions };
}

export function registerMasterDetail(): void {
  Control.register('MasterDetail', MasterDetail);
}
