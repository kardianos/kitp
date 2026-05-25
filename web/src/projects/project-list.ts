/**
 * ProjectList — the all-projects landing (web/design/mock-secondary.md
 * "Projects (switcher + manager)"). Renders, per the refreshed mock:
 *
 *   - a breadcrumb ("All projects") + an H1 "Projects" with a primary
 *     "+ New project" action;
 *   - a search Field ("Search projects… (press / to focus)") that filters the
 *     list client-side by title (the project set is small + fully resident);
 *   - one row per project: title + an "open tasks: —" subtitle (a documented
 *     dash placeholder for v1 — per-project open counts are not loaded yet, in
 *     deliberate parity with the Svelte ProjectsScreen) + a trailing ✎ edit
 *     IconButton that opens the shared project-properties editor.
 *   - a quick-entry dialog (the shared project-properties FORM: Title + a
 *     "+ More details" disclosure with a real Description textarea + Add &
 *     Another / Add & Close) raised by `+ New project` / the `n` hotkey.
 *
 * Data reuse (NO duplicate fetch): AppShell already runs a `projects` query
 * (`card.select_with_attributes`, card_type_name='project', shipping the
 * `is_template != true` leaf so templates are excluded) and lands the rows at
 * the shared `shell.projects` tree path to drive its scope <select>.
 * ProjectList READS that same path reactively — it declares no projects query
 * of its own, so the picker + the list never diverge and there is no second
 * batch round-trip. (Tests seed `shell.projects` directly.)
 *
 * Navigation: selecting a project fires `selectProject`, which `navigate()`s to
 * `/project/:id` (the History-API router). The AppShell's route effect derives
 * the board outlet from the new route AND mirrors `:id` into `scope.projectId`
 * (the tree path Kanban's `{ signal: 'scope.projectId' }` watches). The
 * navigation happens in a plain handler — never inside a tracked effect — so
 * the one-way-load cascade rule holds.
 *
 * Create-project: the `createProject` action fires `card.insert`
 * (card_type_name='project', title, optional `attributes.description`) with an
 * OPTIMISTIC add to `shell.projects` (a temp-id row) that auto-rolls-back on
 * fault (onError 'top'); on success the temp row's id is patched to the
 * server-returned id. Because the picker reads the same path, the new project
 * appears in both the list and the scope <select> with no extra wiring.
 *
 * Edit-project: the ✎ affordance opens the SAME shared properties form,
 * prefilled from the row's current `{ label, description }`. On save we fire one
 * `attribute.update` per CHANGED field (`editTitle` / `editDescription`); each
 * optimistically patches the matching row in `shell.projects` and auto-rolls
 * back on fault (onError 'top'). The row + the scope <select> reflect the
 * rename immediately.
 *
 * All wiring is DECLARATIVE (static queries/actions + DataController). NO
 * promises, no `await`, no `call(...)` in this control body.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { ActionBinding } from '../core/data.js';
import type { HotkeyBinding } from '../core/hotkeys.js';
import type { ApiFault } from '../core/dispatch.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import { SPEC as KANBAN_SPEC } from '../kanban/specs.js';
import { virtualList, type VirtualListHandle } from '../core/virtual-list.js';
import { navigate, projectUrl } from '../shell/router.js';
import { PROJECT_SPEC } from './specs.js';
import { clampIndex, projectDescription, projectTitle } from './project-helpers.js';

/**
 * Fixed virtual-list row height (px) for a project row: a comfortable card with
 * a title line + a meta/subtitle line + generous --space-3 padding. Mirror this
 * in `.projects__row { height }` so the recycling pool tiles exactly.
 */
const PROJECT_ROW_HEIGHT = 64;

export interface ProjectListConfig extends BaseControlConfig {
  type: 'ProjectList';
  /** Tree path the project rows live at. Default 'shell.projects'. */
  projectsPath?: string;
  /** Tree path the search string lives at. Default 'projects.search'. */
  searchPath?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    ProjectList: ProjectListConfig;
  }
}

/** Optimistic temp-id seed: a fresh negative bigint per pending create so two
 *  quick adds don't collide. (Real ids are positive; negatives never clash.) */
let optimisticSeq = -1n;
function nextOptimisticId(): bigint {
  const id = optimisticSeq;
  optimisticSeq -= 1n;
  return id;
}

/* -------------------------------------------------------------------------- */
/* ProjectList control.                                                        */
/* -------------------------------------------------------------------------- */

export class ProjectList extends Control<ProjectListConfig> {
  private selectedIndex = 0;
  /** The id of the most recent optimistic row, so the success sink can patch
   *  it to the real returned id. One in flight at a time is plenty for v1. */
  private pendingOptimisticId: bigint | null = null;
  /** The recycling virtualList over the visible (filtered) project rows. */
  private vlist: VirtualListHandle | null = null;
  /** The current visible (filtered) options, kept so keyboard nav + select can
   *  resolve an index → option without re-filtering, and so `update` reads the
   *  right item. Refreshed by the single list effect on every data/search/
   *  selection change. */
  private visible: ProjectOption[] = [];

  private get projectsPath(): string[] {
    return (this.config.projectsPath ?? 'shell.projects').split('.');
  }
  private get searchPath(): string[] {
    return (this.config.searchPath ?? 'projects.search').split('.');
  }

  /**
   * CLASS-STATIC action table.
   *
   *   - `createProject` (card.insert) — optimistic add of a temp-id row +
   *     auto-rollback on fault; success swaps the temp id for the real id.
   *   - `editTitle` / `editDescription` (attribute.update, REUSING the kanban
   *     spec) — optimistic in-place patch of the matching `shell.projects` row
   *     + auto-rollback on fault. The ✎ editor fires only the changed one(s).
   *
   * All three patch the shared `shell.projects` path, so the list AND the scope
   * <select> reflect the change immediately (they read the same leaf).
   */
  static override actions: readonly ActionBinding[] = [
    {
      intent: 'createProject',
      spec: PROJECT_SPEC.cardInsert,
      input: {
        cardTypeName: { lit: 'project' },
        title: { payload: 'title' },
        // Resolves to undefined when no description was entered; the encode
        // drops empty attribute maps so a bare project still posts no attrs.
        attributes: { payload: 'attributes' },
      },
      optimistic: {
        // Written by the control before the action fires (see fireCreate); the
        // patch appends a temp-id project row so the list + picker show it now.
        path: 'shell.projects',
        patch: (current, payload): ProjectOption[] => {
          const rows = Array.isArray(current) ? (current as ProjectOption[]) : [];
          const p = (payload ?? {}) as {
            title?: string;
            optimisticId?: bigint;
            attributes?: { description?: string };
          };
          if (typeof p.title !== 'string' || p.title.length === 0) return rows;
          const id = p.optimisticId ?? nextOptimisticId();
          const row: ProjectOption = { id: id.toString(), label: p.title, pending: true };
          const desc = p.attributes?.description;
          if (typeof desc === 'string' && desc.length > 0) row.description = desc;
          return [...rows, row];
        },
      },
      result: { method: 'landCreated' },
      onError: 'top',
    },
    {
      intent: 'editTitle',
      spec: KANBAN_SPEC.attributeUpdate,
      input: {
        cardId: { payload: 'cardId' },
        attributeName: { lit: 'title' },
        value: { payload: 'value' },
      },
      optimistic: {
        path: 'shell.projects',
        patch: (current, payload): ProjectOption[] =>
          patchRowField(current, payload, 'label'),
      },
      onError: 'top',
    },
    {
      intent: 'editDescription',
      spec: KANBAN_SPEC.attributeUpdate,
      input: {
        cardId: { payload: 'cardId' },
        attributeName: { lit: 'description' },
        value: { payload: 'value' },
      },
      optimistic: {
        path: 'shell.projects',
        patch: (current, payload): ProjectOption[] =>
          patchRowField(current, payload, 'description'),
      },
      onError: 'top',
    },
  ];

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'projects';
    el.dataset.control = 'ProjectList';
    el.tabIndex = -1;
    return el;
  }

  protected render(): void {
    // Success sink: replace the pending temp-id row with the real id (title +
    // description already correct). Keeps the just-created project selectable.
    this.handler('landCreated', (out) => {
      const realId = ((out ?? {}) as { id?: bigint }).id;
      const tempId = this.pendingOptimisticId;
      this.pendingOptimisticId = null;
      if (realId === undefined || tempId === null) return;
      const node = this.ctx.tree.at(this.projectsPath);
      const rows = (node.peek<ProjectOption[]>() ?? []) as ProjectOption[];
      node.set(
        rows.map((r) => {
          if (r.id !== tempId.toString()) return r;
          const promoted: ProjectOption = { id: realId.toString(), label: r.label };
          if (r.description) promoted.description = r.description;
          return promoted;
        }),
      );
    });

    /* ----------------------------- header ----------------------------- */
    const breadcrumb = document.createElement('div');
    breadcrumb.className = 'projects__breadcrumb muted';
    breadcrumb.dataset.breadcrumb = '';
    breadcrumb.textContent = 'All projects';

    const headerRow = document.createElement('div');
    headerRow.className = 'projects__header';
    const h1 = document.createElement('h1');
    h1.className = 'projects__title';
    h1.textContent = 'Projects';
    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'btn btn-primary projects__new';
    newBtn.dataset.newProject = '';
    newBtn.textContent = '+ New project';
    headerRow.append(h1, newBtn);

    /* ----------------------------- search ----------------------------- */
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'projects__search';
    search.dataset.projectsSearch = '';
    search.placeholder = 'Search projects… (press / to focus)';
    search.setAttribute('aria-label', 'Search projects');

    /* ------------------------------ list ------------------------------ */
    const fault = document.createElement('div');
    fault.className = 'projects__fault';
    fault.style.display = 'none';

    // The list is the virtualList scroll viewport (a positioned, overflow-y
    // box). Its recycling row pool lives inside; a sibling empty-state node is
    // toggled when there are no matching projects.
    const list = document.createElement('ul');
    list.className = 'projects__list scroll-y';
    list.dataset.projectsList = '';

    const empty = document.createElement('li');
    empty.className = 'projects__empty muted';
    empty.dataset.projectsEmpty = '';
    empty.textContent = 'No projects yet. Create your first project to get started.';
    empty.style.display = 'none';

    this.el.append(breadcrumb, headerRow, search, fault, list, empty);

    // The shared project-properties dialog host (hidden until opened). It
    // serves BOTH `+ New project` (create) and the per-row ✎ (edit).
    const dialog = this.buildDialog();
    this.el.append(dialog.root);

    /* -------------------------- reactivity --------------------------- */
    const projectsNode = this.ctx.tree.at(this.projectsPath);
    const searchNode = this.ctx.tree.at(this.searchPath);
    searchNode.set(searchNode.peek<string>() ?? '');

    // Inline self-represented load fault (onError: 'self' on any future read).
    this.effect(() => {
      const f = this.fault.get();
      if (!f) {
        fault.style.display = 'none';
        fault.textContent = '';
        return;
      }
      fault.style.display = '';
      fault.textContent = `Failed to load projects: ${describeFault(f)}`;
    }, 'projects.fault');

    // A selection-tick leaf the virtualList's data() reads so a selection move
    // (a one-way tree write outside any tracked effect) re-windows + repaints
    // the visible rows. Selection itself stays in `this.selectedIndex` and is
    // applied per row in update() by comparing to the row's index.
    const selTick = this.ctx.tree.at(['projects', 'selTick']);
    if (selTick.peek<number>() === undefined) selTick.set(0);

    // The recycling virtualList over the filtered project rows. data() reads
    // the projects leaf, the search leaf, AND the selection tick so the single
    // effect re-renders on any of them. It recomputes `this.visible` (the
    // filtered set) so keyboard nav + update() resolve indices against the same
    // snapshot. create(el) builds the row shell ONCE per pool slot; update(el,
    // p, i) swaps content + sets every data-* hook and the selected/pending
    // classes from the ITEM + the index (never node state — rows recycle).
    this.vlist = virtualList<ProjectOption>({
      container: list,
      rowHeight: PROJECT_ROW_HEIGHT,
      data: () => {
        const all = (projectsNode.get<ProjectOption[]>() ?? []) as ProjectOption[];
        const needle = searchNode.get<string>() ?? '';
        selTick.get(); // subscribe so a selection move re-renders the window
        const visible = filterOptions(all, needle);
        if (this.selectedIndex > visible.length - 1) {
          this.selectedIndex = Math.max(0, visible.length - 1);
        }
        this.visible = visible;
        return visible;
      },
      // NO key: a project row's CONTENT can change while its id + slot index
      // stay fixed (an optimistic title/description edit, a selection move, the
      // pending→committed flip). The virtualList's key-skip fast path is only
      // safe when content is a pure function of item identity; here it isn't, so
      // we let update() run for every visible slot on each render (cheap text +
      // class swaps) and never miss an out-of-band content change.
      create: (el) => this.buildRowShell(el),
      update: (el, p, index) => this.fillRow(el, p, index),
      name: 'projects.list',
    });
    this.onDestroy(() => this.vlist?.dispose());

    // Empty-state toggle: reads the same two leaves, shows the placeholder when
    // no project matches. Cascade-safe (reads leaves, writes only DOM).
    this.effect(() => {
      const all = (projectsNode.get<ProjectOption[]>() ?? []) as ProjectOption[];
      const needle = searchNode.get<string>() ?? '';
      const has = filterOptions(all, needle).length > 0;
      empty.style.display = has ? 'none' : '';
      list.style.display = has ? '' : 'none';
    }, 'projects.empty');

    /* -------------------------- interactions ------------------------- */
    this.listen(newBtn, 'click', () => this.intent('quickCreateOpen'));
    this.listen(search, 'input', () => {
      this.ctx.tree.at(this.searchPath).set(search.value);
    });
    // Enter on the search input opens the first visible project (the obvious
    // match), ArrowDown drops focus into the list — parity with the Svelte
    // screen's onSearchKeydown.
    this.listen(search, 'keydown', (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key === 'Enter') {
        const first = this.visibleProjects()[0];
        if (first) {
          e.preventDefault();
          this.selectProject(first.id);
        }
      }
    });

    // The `/` hotkey raises 'focusSearch'; stash the focus fn for that intent.
    this.focusSearchFn = () => {
      focusEl(search);
      if (typeof (search as { select?: () => void }).select === 'function') {
        (search as unknown as { select: () => void }).select();
      }
    };
    this.dialog = dialog;
    this.registerIntentHandlers(dialog);
  }

  /* ----------------------------- list render ---------------------------- */

  /**
   * Build ONE pooled row's DOM (virtualList `create`) — runs once per pool
   * slot, never per project. The open button (title + desc + meta) and the ✎
   * edit button are built empty; `fillRow` swaps their content + the row's
   * data-* hooks per project. The click handlers DON'T capture a project: the
   * node recycles, so they resolve the CURRENT project from `data-project-id`
   * (set by fillRow) against the live `this.visible` snapshot.
   */
  private buildRowShell(li: HTMLElement): void {
    li.className = 'projects__row';
    li.dataset.projectRow = '';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'projects__open';
    open.dataset.projectOpen = '';

    const titleEl = document.createElement('span');
    titleEl.className = 'projects__row-title';
    titleEl.dataset.role = 'title';

    const descEl = document.createElement('p');
    descEl.className = 'projects__row-desc muted';
    descEl.dataset.role = 'desc';

    const meta = document.createElement('span');
    meta.className = 'projects__row-meta muted';
    meta.dataset.role = 'meta';
    // v1 placeholder: per-project open-task counts are not loaded yet — the
    // literal dash is intentional parity with the Svelte ProjectsScreen.
    meta.textContent = 'open tasks: —';

    open.append(titleEl, descEl, meta);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'iconbtn projects__edit';
    edit.dataset.projectEdit = '';
    edit.textContent = '✎';
    edit.title = 'Edit project properties';

    li.append(open, edit);

    // Handlers resolve the row's CURRENT project from the node's data-project-id
    // (set per fill) — not a captured item, because the node is recycled.
    this.listen(open, 'click', () => {
      const id = li.dataset.projectId;
      if (id !== undefined) this.selectProject(id);
    });
    this.listen(open, 'focus', () => {
      const id = li.dataset.projectId;
      const i = id === undefined ? -1 : this.visible.findIndex((o) => o.id === id);
      if (i >= 0) this.selectSelection(i);
    });
    this.listen(edit, 'click', (ev) => {
      ev.stopPropagation();
      const id = li.dataset.projectId;
      const p = id === undefined ? undefined : this.visible.find((o) => o.id === id);
      if (p) this.openEditor(p);
    });
  }

  /**
   * Swap a pooled row's content for `p` at `index` (virtualList `update`).
   * Every data-* hook, the title/description/meta text, and the selected /
   * pending classes are (re)applied from the ITEM + index — never read from
   * node state, because the node recycles to a different project on scroll.
   */
  private fillRow(li: HTMLElement, p: ProjectOption, index: number): void {
    li.dataset.projectId = p.id;
    li.classList.remove('projects__row--selected', 'projects__row--pending');
    if (index === this.selectedIndex) li.classList.add('projects__row--selected');
    if (p.pending) li.classList.add('projects__row--pending');

    const title = childByRole(li, 'title');
    if (title) title.textContent = p.label;

    const desc = childByRole(li, 'desc');
    if (desc) {
      if (p.description) {
        desc.textContent = p.description;
        desc.style.display = '';
      } else {
        desc.textContent = '';
        desc.style.display = 'none';
      }
    }

    const edit = childByData(li, 'projectEdit') as HTMLButtonElement | null;
    if (edit) {
      edit.setAttribute('aria-label', `Edit project "${p.label}"`);
      // A pending (not-yet-persisted) row has no real card id to update against.
      edit.disabled = p.pending === true;
    }
  }

  /* ----------------------------- navigation ----------------------------- */

  /**
   * Land on a project: NAVIGATE to its route (`/project/:id`). The History-API
   * router writes the route leaf; the AppShell's route effect derives the
   * outlet (the board) AND mirrors `:id` into `scope.projectId` (the tree path
   * Kanban watches). A one-way navigation outside any tracked effect, so the
   * one-way-load rule holds. A pending (optimistic, not-yet-persisted) row is
   * not selectable.
   */
  private selectProject(idStr: string): void {
    const id = parseId(idStr);
    if (id === null) return;
    navigate(projectUrl(id));
  }

  private visibleProjects(): ProjectOption[] {
    const all = (this.ctx.tree.at(this.projectsPath).peek<ProjectOption[]>() ?? []) as ProjectOption[];
    const needle = this.ctx.tree.at(this.searchPath).peek<string>() ?? '';
    return filterOptions(all, needle);
  }

  /** Set the selected index and bump the selection tick so the virtualList
   *  re-renders the visible window with the new selected row highlighted. A
   *  one-way tree write outside any tracked effect (cascade-safe). */
  private selectSelection(index: number): void {
    if (index === this.selectedIndex) return;
    this.selectedIndex = index;
    this.bumpSelTick();
  }

  private bumpSelTick(): void {
    const node = this.ctx.tree.at(['projects', 'selTick']);
    node.set((node.peek<number>() ?? 0) + 1);
  }

  private moveSelection(delta: number): void {
    const visible = this.visibleProjects();
    const next = clampIndex(visible.length, this.selectedIndex, delta);
    this.selectedIndex = next;
    this.bumpSelTick();
    // Focus the open button of the now-selected row if it's in the rendered
    // window (a recycled pool node may not exist for an off-window index; the
    // re-render above still scrolls selection into the highlighted state).
    const rows = this.el.querySelectorAll<HTMLElement>('[data-project-row]');
    for (const r of rows) {
      if (r.dataset.projectId === visible[next]?.id) {
        const openBtn = r.querySelector('[data-project-open]');
        if (openBtn) focusEl(openBtn);
        break;
      }
    }
  }

  private openSelected(): void {
    const sel = this.visibleProjects()[this.selectedIndex];
    if (sel) this.selectProject(sel.id);
  }

  /* ----------------------- shared properties dialog --------------------- */

  /** Stashed by render() so intents (`quickCreateOpen`) reach the live dialog. */
  private dialog: PropertiesDialog | null = null;

  private registerIntentHandlers(dialog: PropertiesDialog): void {
    // Hotkeys raise these intents; the DataController also listens for
    // 'createProject' / 'editTitle' / 'editDescription' (the static actions).
    // We register the UI-only intents the control owns.
    this.registerIntent('quickCreateOpen', () => dialog.openCreate());
    this.registerIntent('quickCreateClose', () => dialog.close());
    this.registerIntent('selectNext', () => this.moveSelection(+1));
    this.registerIntent('selectPrev', () => this.moveSelection(-1));
    this.registerIntent('openSelected', () => this.openSelected());
    this.registerIntent('focusSearch', () => {
      const fn = this.findFocusSearch();
      if (fn) fn();
    });
  }

  /** Open the shared form in EDIT mode for a row, prefilled from its option. */
  private openEditor(p: ProjectOption): void {
    if (p.pending) return; // no real card id yet
    const id = parseId(p.id);
    if (id === null) return;
    this.dialog?.openEdit(id, p.label, p.description ?? '');
  }

  /** The render() closure stashes a focus-the-search-input fn here. */
  private focusSearchFn: (() => void) | null = null;
  private findFocusSearch(): (() => void) | null {
    return this.focusSearchFn;
  }

  /**
   * Control-owned hotkeys (web/design/hotkeys.md "Projects" scope), bound to
   * `this.intent(...)` so a key never calls the API directly — it raises an
   * intent the action/handler consumes. Hierarchically derived by the live-tree
   * HotkeyController; the ProjectList is the active screen scope here.
   */
  override hotkeys(): readonly HotkeyBinding[] {
    return [
      { binding: 'n', label: 'New project', run: () => this.intent('quickCreateOpen') },
      { binding: ['j'], label: 'Next project', run: () => this.intent('selectNext') },
      { binding: ['k'], label: 'Previous project', run: () => this.intent('selectPrev') },
      { binding: 'Enter', label: 'Open selected', run: () => this.intent('openSelected') },
      { binding: '/', label: 'Focus search', run: () => this.intent('focusSearch') },
      ...(this.config.hotkeys ?? []),
    ];
  }

  /**
   * Build the ONE shared "project properties" dialog (title + description),
   * driven into either CREATE or EDIT mode. The framework's common-control
   * intent: `+ New project` and the per-row ✎ raise the same form.
   *
   *   - CREATE: footer shows Add & Another / Add & Close; Add fires the
   *     `createProject` action (card.insert).
   *   - EDIT:   footer shows Save; Save fires `editTitle` / `editDescription`
   *     (attribute.update) for ONLY the changed fields.
   */
  private buildDialog(): PropertiesDialog {
    const root = document.createElement('div');
    root.className = 'qe-dialog';
    root.dataset.quickEntry = '';
    root.style.display = 'none';

    const panel = document.createElement('div');
    panel.className = 'qe-dialog__panel';

    const heading = document.createElement('h2');
    heading.className = 'qe-dialog__title';
    heading.textContent = 'New project';

    /* --- Title field --- */
    const titleLabel = document.createElement('label');
    titleLabel.className = 'qe-dialog__field';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'qe-dialog__label';
    titleSpan.textContent = 'Title';
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'qe-dialog__input';
    titleInput.dataset.qeTitle = '';
    titleInput.placeholder = 'Project title';
    titleLabel.append(titleSpan, titleInput);

    /* --- "+ More details" disclosure → real Description textarea --- */
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'qe-dialog__more';
    more.dataset.qeMore = '';
    more.textContent = '+ More details';

    const moreRegion = document.createElement('div');
    moreRegion.className = 'qe-dialog__more-region';
    moreRegion.dataset.qeMoreRegion = '';
    moreRegion.style.display = 'none';

    const descLabel = document.createElement('label');
    descLabel.className = 'qe-dialog__field';
    const descSpan = document.createElement('span');
    descSpan.className = 'qe-dialog__label';
    descSpan.textContent = 'Description';
    const descInput = document.createElement('textarea');
    descInput.className = 'qe-dialog__input qe-dialog__textarea';
    descInput.dataset.qeDescription = '';
    descInput.rows = 4;
    descInput.placeholder = 'Add a description… (optional)';
    descLabel.append(descSpan, descInput);
    moreRegion.append(descLabel);

    const hint = document.createElement('div');
    hint.className = 'qe-dialog__hint muted';

    /* --- Footer (CREATE: Add & Another / Add & Close; EDIT: Save) --- */
    const footer = document.createElement('div');
    footer.className = 'qe-dialog__footer';
    const another = document.createElement('button');
    another.type = 'button';
    another.className = 'btn qe-dialog__another';
    another.dataset.qeAddAnother = '';
    another.textContent = 'Add & Another';
    const primary = document.createElement('button');
    primary.type = 'button';
    primary.className = 'btn btn-primary qe-dialog__close';
    primary.dataset.qeAddClose = '';
    primary.textContent = 'Add & Close';
    footer.append(another, primary);

    panel.append(heading, titleLabel, more, moreRegion, hint, footer);
    root.append(panel);

    /* --- mode state --- */
    let mode: 'create' | 'edit' = 'create';
    let editId: bigint | null = null;
    let origTitle = '';
    let origDesc = '';

    const showDesc = (open: boolean): void => {
      moreRegion.style.display = open ? '' : 'none';
      more.textContent = open ? '− Less details' : '+ More details';
    };

    const applyMode = (): void => {
      if (mode === 'create') {
        heading.textContent = 'New project';
        another.style.display = '';
        primary.textContent = 'Add & Close';
        primary.dataset.qeAddClose = '';
        delete primary.dataset.qeSave;
        hint.textContent =
          'Press Enter to add another · Ctrl+Enter to add and close · Esc to cancel';
      } else {
        heading.textContent = 'Edit project';
        another.style.display = 'none';
        primary.textContent = 'Save';
        primary.dataset.qeSave = '';
        delete primary.dataset.qeAddClose;
        hint.textContent = 'Ctrl+Enter to save · Esc to cancel';
      }
    };

    const dialog: PropertiesDialog = {
      root,
      openCreate: () => {
        mode = 'create';
        editId = null;
        origTitle = '';
        origDesc = '';
        titleInput.value = '';
        descInput.value = '';
        showDesc(false);
        applyMode();
        root.style.display = '';
        focusEl(titleInput);
      },
      openEdit: (id, title, description) => {
        mode = 'edit';
        editId = id;
        origTitle = title;
        origDesc = description;
        titleInput.value = title;
        descInput.value = description;
        // Auto-expand the details region when there's an existing description.
        showDesc(description.length > 0);
        applyMode();
        root.style.display = '';
        focusEl(titleInput);
      },
      close: () => {
        root.style.display = 'none';
      },
      isOpen: () => root.style.display !== 'none',
    };

    // "+ More details" disclosure toggle.
    this.listen(more, 'click', () => {
      showDesc(moreRegion.style.display === 'none');
    });

    /* --- CREATE: Add & Another / Add & Close --- */
    const add = (keepOpen: boolean): void => {
      const title = titleInput.value.trim();
      if (title.length === 0) {
        focusEl(titleInput);
        return;
      }
      this.fireCreate(title, descInput.value.trim());
      if (keepOpen) {
        titleInput.value = '';
        descInput.value = '';
        showDesc(false);
        focusEl(titleInput);
      } else {
        dialog.close();
      }
    };

    /* --- EDIT: Save (fires attribute.update per CHANGED field) --- */
    const save = (): void => {
      if (editId === null) return;
      const title = titleInput.value.trim();
      // Title stays required: an empty title is rejected (no-op, keep focus).
      if (title.length === 0) {
        focusEl(titleInput);
        return;
      }
      const desc = descInput.value.trim();
      this.fireEdit(editId, { title, description: desc }, { title: origTitle, description: origDesc });
      dialog.close();
    };

    const commitPrimary = (): void => {
      if (mode === 'create') add(false);
      else save();
    };

    this.listen(another, 'click', () => add(true));
    this.listen(primary, 'click', () => commitPrimary());

    // Keyboard: Esc = cancel. Title Enter (create) = add another, Mod+Enter =
    // commit. In edit mode Enter on the title commits; Mod+Enter in the
    // description commits (parity with the Svelte panel's onDescKey).
    this.listen(titleInput, 'keydown', (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key === 'Escape') {
        e.preventDefault();
        dialog.close();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (mode === 'create') {
          add(!(e.metaKey || e.ctrlKey));
        } else {
          save();
        }
      }
    });
    this.listen(descInput, 'keydown', (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key === 'Escape') {
        e.preventDefault();
        dialog.close();
        return;
      }
      // Mod+Enter commits from the description field (textarea Enter = newline).
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        commitPrimary();
      }
    });

    return dialog;
  }

  /**
   * Fire the declarative create action. We mint the optimistic temp id HERE
   * (so the success sink can find + patch the right row) and pass it in the
   * payload; the action's optimistic patch appends a row with that id, then
   * card.insert fires. On fault the tree transaction auto-rolls-back. A
   * non-empty description rides as `attributes.description`.
   */
  private fireCreate(title: string, description: string): void {
    const optimisticId = nextOptimisticId();
    this.pendingOptimisticId = optimisticId;
    const payload: {
      title: string;
      optimisticId: bigint;
      attributes?: { description: string };
    } = { title, optimisticId };
    if (description.length > 0) payload.attributes = { description };
    this.intent('createProject', payload);
  }

  /**
   * Fire one `attribute.update` per CHANGED field. Title and description are
   * independent updates (the server's attribute.update sets one attribute per
   * call); each optimistically patches the matching `shell.projects` row and
   * rolls back on fault. Unchanged fields are skipped.
   */
  private fireEdit(
    cardId: bigint,
    next: { title: string; description: string },
    prev: { title: string; description: string },
  ): void {
    if (next.title !== prev.title) {
      this.intent('editTitle', { cardId, value: next.title });
    }
    if (next.description !== prev.description) {
      this.intent('editDescription', { cardId, value: next.description });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Row option model + helpers.                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The shape ProjectList renders. It is INTENTIONALLY the superset of two
 * sources written to `shell.projects`:
 *   - AppShell's `landProjects` writes `{ id, label, description? }` (id as
 *     string, label from the project's `title` attribute) — the scope-picker
 *     option shape.
 *   - This control's optimistic patches append/patch `{ id, label,
 *     description?, pending? }`.
 * Reading the same path, the list + the scope <select> stay in lockstep.
 */
export interface ProjectOption {
  id: string;
  label: string;
  description?: string;
  pending?: boolean;
}

/**
 * Optimistic patch shared by the edit actions: replace `field` ('label' for a
 * title rename, 'description' for the description) on the row whose id matches
 * the payload's `cardId`. An empty new description clears the field (drops the
 * `description` key). Pure over the current leaf + payload.
 */
function patchRowField(
  current: unknown,
  payload: unknown,
  field: 'label' | 'description',
): ProjectOption[] {
  const rows = Array.isArray(current) ? (current as ProjectOption[]) : [];
  const p = (payload ?? {}) as { cardId?: bigint; value?: unknown };
  if (p.cardId === undefined) return rows;
  const targetId = p.cardId.toString();
  const value = typeof p.value === 'string' ? p.value : '';
  return rows.map((r) => {
    if (r.id !== targetId) return r;
    if (field === 'label') return { ...r, label: value };
    // description: drop the key when cleared so the row renders no subtitle.
    const next = { ...r };
    if (value.length > 0) next.description = value;
    else delete next.description;
    return next;
  });
}

/** Coerce whatever landed at `shell.projects` into ProjectOption rows + filter
 *  by the search needle (case-insensitive substring over the label). Accepts
 *  both the AppShell option shape and raw card.select_with_attributes rows so
 *  the control is robust to either being landed at the path. */
function filterOptions(rows: ProjectOption[], needle: string): ProjectOption[] {
  const opts = rows.map(toOption).filter((o): o is ProjectOption => o !== null);
  const n = needle.trim().toLowerCase();
  if (n.length === 0) return opts;
  return opts.filter((o) => o.label.toLowerCase().includes(n));
}

function toOption(row: unknown): ProjectOption | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  // AppShell option shape: { id: string, label: string }.
  if (typeof r['label'] === 'string' && r['id'] !== undefined) {
    const opt: ProjectOption = { id: String(r['id']), label: r['label'] as string };
    if (typeof r['description'] === 'string') opt.description = r['description'];
    if (r['pending'] === true) opt.pending = true;
    return opt;
  }
  // Raw card row shape: { id, attributes: { title, description? } }.
  if ('attributes' in r) {
    const card = row as CardWithAttrs;
    const opt: ProjectOption = { id: card.id.toString(), label: projectTitle(card) };
    const desc = projectDescription(card);
    if (desc) opt.description = desc;
    return opt;
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

/** Walk a node's descendants for the first with `dataset.role === role`.
 *  Works against both real DOM (HTMLCollection) and the test shim (array). */
function childByRole(root: HTMLElement, role: string): HTMLElement | null {
  return descend(root, (el) => el.dataset?.role === role);
}

/** Walk a node's descendants for the first with the given dataset key present. */
function childByData(root: HTMLElement, key: string): HTMLElement | null {
  return descend(root, (el) => el.dataset != null && key in el.dataset);
}

function descend(root: HTMLElement, pred: (el: HTMLElement) => boolean): HTMLElement | null {
  const kids = root.children;
  for (let i = 0; i < kids.length; i++) {
    const el = kids[i] as HTMLElement;
    if (pred(el)) return el;
    const found = descend(el, pred);
    if (found) return found;
  }
  return null;
}

/** Focus an element if it supports focus (the test DOM shim has no focus). */
function focusEl(el: unknown): void {
  if (el && typeof (el as { focus?: () => void }).focus === 'function') {
    (el as { focus: () => void }).focus();
  }
}

function parseId(raw: string): bigint | null {
  if (!/^-?\d+$/.test(raw)) return null;
  try {
    const n = BigInt(raw);
    return n > 0n ? n : null; // pending temp ids are negative → not selectable
  } catch {
    return null;
  }
}

interface PropertiesDialog {
  root: HTMLElement;
  /** Open in CREATE mode (blank form). */
  openCreate(): void;
  /** Open in EDIT mode for a project, prefilled with its title + description. */
  openEdit(id: bigint, title: string, description: string): void;
  close(): void;
  isOpen(): boolean;
}

/* -------------------------------------------------------------------------- */
/* Hotkeys + registration.                                                     */
/* -------------------------------------------------------------------------- */

export function registerProjectList(): void {
  Control.register('ProjectList', ProjectList);
}
