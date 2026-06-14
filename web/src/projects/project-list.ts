/**
 * ProjectList — the all-projects landing (web/design/mock-secondary.md
 * "Projects (switcher + manager)"). Renders, per the refreshed mock:
 *
 *   - a breadcrumb ("All projects") + an H1 "Projects" with a primary
 *     "+ New project" action;
 *   - a search Field ("Search projects… (press / to focus)") that filters the
 *     list client-side by title (the project set is small + fully resident);
 *   - one row per project: title + description (no per-project task count —
 *     never sourced from the server, and a permanent "—" placeholder was just
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
import { RichEditor } from '../editor/rich-editor.js';
import type { ActionBinding, QueryBinding } from '../core/data.js';
import type { HotkeyBinding } from '../core/hotkeys.js';
import type { ApiFault } from '../core/dispatch.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import { SPEC as KANBAN_SPEC } from '../kanban/specs.js';
import { virtualList, type VirtualListHandle } from '../core/virtual-list.js';
import { navigate, projectUrl } from '../shell/router.js';
import { PROJECT_SPEC } from './specs.js';
import { clampIndex, projectDescription, projectTitle, TEMPLATE_INCLUSION_LEAF } from './project-helpers.js';

import { icon } from '../ui/icons.js';
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
  /** Tree path the (template-only) supplementary rows live at.
   *  Default 'shell.projectTemplates'. */
  templatesPath?: string;
  /** Tree path the "show templates" toggle lives at.
   *  Default 'projects.showTemplates'. */
  showTemplatesPath?: string;
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
  private get templatesPath(): string[] {
    return (this.config.templatesPath ?? 'shell.projectTemplates').split('.');
  }
  private get showTemplatesPath(): string[] {
    return (this.config.showTemplatesPath ?? 'projects.showTemplates').split('.');
  }

  /**
   * The rows to show: the real projects at `projectsPath` (template-free, from
   * the AppShell query) plus the template-only rows at `templatesPath` ONLY when
   * the "show templates" toggle is on. Reads via `.get()` so the caller's effect
   * subscribes (data() + the empty-state effect).
   */
  private combinedRows(): ProjectOption[] {
    const base = (this.ctx.tree.at(this.projectsPath).get<ProjectOption[]>() ?? []) as ProjectOption[];
    const showT = this.ctx.tree.at(this.showTemplatesPath).get<boolean>() ?? false;
    if (!showT) return base;
    const tmpl = (this.ctx.tree.at(this.templatesPath).get<ProjectOption[]>() ?? []) as ProjectOption[];
    return [...base, ...tmpl];
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
  /**
   * Supplementary TEMPLATE-only query (#7). The AppShell `projects` query ships
   * `is_template != true`, so `shell.projects` is template-free; this loads the
   * templates separately (once, on mount) into `shell.projectTemplates`. The
   * list folds them in only while the "show templates" toggle is on, so the
   * scope <select> (which reads `shell.projects`) is unaffected.
   */
  static override queries: readonly QueryBinding[] = [
    {
      name: 'templates',
      spec: 'card.select_with_attributes',
      when: 'mount',
      input: {
        cardTypeName: { lit: 'project' },
        where: { lit: [TEMPLATE_INCLUSION_LEAF] },
      },
      result: { method: 'landTemplates' },
      onError: 'self',
    },
  ];

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
    // Create a REAL project from a CHOSEN template (project.stamp). The default
    // template path stays on `createProject` (card.insert auto-stamps the
    // standard template); this fires only when the user picks a specific one.
    {
      intent: 'stampProject',
      spec: PROJECT_SPEC.projectStamp,
      input: {
        templateProjectId: { payload: 'templateProjectId' },
        name: { payload: 'title' },
        description: { payload: 'description' },
        isTemplate: { lit: false },
      },
      optimistic: {
        path: 'shell.projects',
        patch: (current, payload): ProjectOption[] => appendPending(current, payload, false),
      },
      result: { method: 'landStamped' },
      onError: 'top',
    },
    // Create a TEMPLATE by copying another template (project.stamp, is_template=true).
    {
      intent: 'stampTemplate',
      spec: PROJECT_SPEC.projectStamp,
      input: {
        templateProjectId: { payload: 'templateProjectId' },
        name: { payload: 'title' },
        description: { payload: 'description' },
        isTemplate: { lit: true },
      },
      optimistic: {
        path: 'shell.projectTemplates',
        patch: (current, payload): ProjectOption[] => appendPending(current, payload, true),
      },
      result: { method: 'landTemplateStamped' },
      onError: 'top',
    },
    // Create a BLANK template (card.insert with is_template=true; the server
    // suppresses the auto-stamp for templates so nothing is copied).
    {
      intent: 'createTemplate',
      spec: PROJECT_SPEC.cardInsert,
      input: {
        cardTypeName: { lit: 'project' },
        title: { payload: 'title' },
        attributes: { payload: 'attributes' },
      },
      optimistic: {
        path: 'shell.projectTemplates',
        patch: (current, payload): ProjectOption[] => appendPending(current, payload, true),
      },
      result: { method: 'landTemplateCreated' },
      onError: 'top',
    },
    // Soft-delete a real project (card.delete). The optimistic patch drops the
    // row from `shell.projects`; on fault the tree transaction auto-restores it.
    {
      intent: 'deleteProject',
      spec: PROJECT_SPEC.cardDelete,
      input: { cardId: { payload: 'cardId' } },
      optimistic: {
        path: 'shell.projects',
        patch: (current, payload): ProjectOption[] => removeRow(current, payload),
      },
      onError: 'top',
    },
    // Soft-delete a template project — same spec, but the row lives in the
    // separate `shell.projectTemplates` leaf (mirrors the create/stamp split).
    {
      intent: 'deleteTemplate',
      spec: PROJECT_SPEC.cardDelete,
      input: { cardId: { payload: 'cardId' } },
      optimistic: {
        path: 'shell.projectTemplates',
        patch: (current, payload): ProjectOption[] => removeRow(current, payload),
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
    // Success sinks: replace the pending temp-id row with the real id, in the
    // path the create/stamp optimistically wrote. card.insert returns `id`;
    // project.stamp returns `new_project_id` (decoded to `newProjectId`).
    this.handler('landCreated', (out) =>
      this.promoteTemp(this.projectsPath, ((out ?? {}) as { id?: bigint }).id),
    );
    this.handler('landStamped', (out) =>
      this.promoteTemp(this.projectsPath, ((out ?? {}) as { newProjectId?: bigint }).newProjectId),
    );
    this.handler('landTemplateCreated', (out) =>
      this.promoteTemp(this.templatesPath, ((out ?? {}) as { id?: bigint }).id),
    );
    this.handler('landTemplateStamped', (out) =>
      this.promoteTemp(this.templatesPath, ((out ?? {}) as { newProjectId?: bigint }).newProjectId),
    );

    // Land the supplementary template rows as ProjectOptions flagged
    // isTemplate (so fillRow can badge them). Written to the templates path the
    // list folds in only when the toggle is on.
    this.handler('landTemplates', (out) => {
      const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
      const opts: ProjectOption[] = rows.map((r) => {
        const opt: ProjectOption = { id: r.id.toString(), label: projectTitle(r), isTemplate: true };
        const desc = projectDescription(r);
        if (desc) opt.description = desc;
        return opt;
      });
      this.ctx.tree.at(this.templatesPath).set(opts);
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
    // "Show templates" toggle — folds the template projects into the list
    // (they're hidden by default). Reflects the `projects.showTemplates` leaf.
    const showTemplates = document.createElement('button');
    showTemplates.type = 'button';
    showTemplates.className = 'btn projects__show-templates';
    showTemplates.dataset.showTemplates = '';
    showTemplates.textContent = 'Show templates';
    showTemplates.setAttribute('aria-pressed', 'false');

    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'btn btn-primary projects__new';
    newBtn.dataset.newProject = '';
    newBtn.textContent = '+ New project';
    headerRow.append(h1, showTemplates, newBtn);

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
    const searchNode = this.ctx.tree.at(this.searchPath);
    searchNode.set(searchNode.peek<string>() ?? '');

    // "Show templates" toggle state: seed off, reflect the leaf on the button.
    const showTemplatesNode = this.ctx.tree.at(this.showTemplatesPath);
    if (showTemplatesNode.peek<boolean>() === undefined) showTemplatesNode.set(false);
    this.effect(() => {
      const on = showTemplatesNode.get<boolean>() ?? false;
      showTemplates.classList.toggle('projects__show-templates--active', on);
      showTemplates.setAttribute('aria-pressed', on ? 'true' : 'false');
      showTemplates.textContent = on ? 'Hide templates' : 'Show templates';
    }, 'projects.showTemplates');

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
        const all = this.combinedRows(); // real projects + (toggle ? templates)
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
      const all = this.combinedRows();
      const needle = searchNode.get<string>() ?? '';
      const has = filterOptions(all, needle).length > 0;
      empty.style.display = has ? 'none' : '';
      list.style.display = has ? '' : 'none';
    }, 'projects.empty');

    /* -------------------------- interactions ------------------------- */
    this.listen(newBtn, 'click', () => this.intent('quickCreateOpen'));
    this.listen(showTemplates, 'click', () => {
      const node = this.ctx.tree.at(this.showTemplatesPath);
      node.set(!(node.peek<boolean>() ?? false));
    });
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

    // Template badge — a SIBLING of the title (fillRow sets title.textContent,
    // which would clobber a child). Shown only for template rows.
    const badge = document.createElement('span');
    badge.className = 'projects__row-badge';
    badge.dataset.role = 'badge';
    badge.textContent = 'Template';
    badge.style.display = 'none';

    const descEl = document.createElement('p');
    descEl.className = 'projects__row-desc muted';
    descEl.dataset.role = 'desc';

    // The Svelte ProjectsScreen used to show an "open tasks: —" placeholder
    // because per-project open counts were never wired (no server query
    // sourced it). Removed: a permanent dash adds visual noise without
    // information. If/when card.count_by_project lands, drop a real count in.
    open.append(titleEl, badge, descEl);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'iconbtn projects__edit';
    edit.dataset.projectEdit = '';
    edit.append(icon('pencil', 14));
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

    const badge = childByRole(li, 'badge');
    if (badge) badge.style.display = p.isTemplate ? '' : 'none';

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
    const base = (this.ctx.tree.at(this.projectsPath).peek<ProjectOption[]>() ?? []) as ProjectOption[];
    const showT = this.ctx.tree.at(this.showTemplatesPath).peek<boolean>() ?? false;
    const tmpl = showT
      ? ((this.ctx.tree.at(this.templatesPath).peek<ProjectOption[]>() ?? []) as ProjectOption[])
      : [];
    const needle = this.ctx.tree.at(this.searchPath).peek<string>() ?? '';
    return filterOptions(showT ? [...base, ...tmpl] : base, needle);
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
    this.dialog?.openEdit(id, p.label, p.description ?? '', p.isTemplate === true);
  }

  /**
   * Soft-delete a project from the EDIT dialog (replaces the removed admin
   * Projects screen's delete). Templates live in a separate leaf, so route to
   * the matching intent; the optimistic patch drops the row + auto-rolls-back
   * on fault. A confirm guards the destructive action.
   */
  private fireDelete(id: bigint, isTemplate: boolean): void {
    this.intent(isTemplate ? 'deleteTemplate' : 'deleteProject', { cardId: id });
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
    // Markdown description editor (same WYSIWYG component as the task
    // description). Mod+Enter commits the dialog's primary action; Escape
    // closes. `commitPrimary` / `dialog` are referenced lazily (defined below)
    // and only invoked at event time.
    const descEditor = new RichEditor({
      value: '',
      placeholder: 'Add a description… (optional)',
      minRows: 4,
      editableClassName: 'qe-dialog__input qe-dialog__textarea',
      editableAttrs: { 'data-qe-description': '' },
      onCommit: () => commitPrimary(),
      onCancel: () => dialog.close(),
    });
    this.onDestroy(() => descEditor.destroy());
    descLabel.append(descSpan, descEditor.el);
    moreRegion.append(descLabel);

    /* --- Template controls (CREATE mode only) --- */
    const tmplRegion = document.createElement('div');
    tmplRegion.className = 'qe-dialog__template-region';
    tmplRegion.dataset.qeTemplateRegion = '';

    const isTmplLabel = document.createElement('label');
    isTmplLabel.className = 'qe-dialog__checkbox';
    const isTmpl = document.createElement('input');
    isTmpl.type = 'checkbox';
    isTmpl.dataset.qeIsTemplate = '';
    const isTmplSpan = document.createElement('span');
    isTmplSpan.textContent = 'Create as template';
    isTmplLabel.append(isTmpl, isTmplSpan);

    const copyLabel = document.createElement('label');
    copyLabel.className = 'qe-dialog__field';
    const copySpan = document.createElement('span');
    copySpan.className = 'qe-dialog__label';
    copySpan.textContent = 'Copy from template';
    const copySel = document.createElement('select');
    copySel.className = 'qe-dialog__input';
    copySel.dataset.qeTemplate = '';
    copyLabel.append(copySpan, copySel);

    tmplRegion.append(isTmplLabel, copyLabel);

    // (Re)build the template <select>: a context-sensitive first option
    // (real → "Standard (default)"; template → "(blank)") then one option per
    // loaded template. Preserves the current selection when still valid.
    const rebuildTemplateOptions = (): void => {
      const tmpls = (this.ctx.tree.at(this.templatesPath).peek<ProjectOption[]>() ?? []) as ProjectOption[];
      const cur = copySel.value;
      const first = document.createElement('option');
      first.value = '';
      first.textContent = isTmpl.checked ? '(blank — no copy)' : 'Standard template (default)';
      const opts: HTMLOptionElement[] = [first];
      for (const t of tmpls) {
        const o = document.createElement('option');
        o.value = t.id;
        o.textContent = t.label;
        opts.push(o);
      }
      copySel.replaceChildren(...opts);
      copySel.value = cur;
    };

    const hint = document.createElement('div');
    hint.className = 'qe-dialog__hint muted';

    /* --- Footer (CREATE: Add & Another / Add & Close; EDIT: Delete · Save) --- */
    const footer = document.createElement('div');
    footer.className = 'qe-dialog__footer';
    // Left-aligned destructive action — EDIT mode only (replaces the removed
    // admin Projects screen's delete). A confirm guards it.
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-danger qe-dialog__delete';
    del.dataset.qeDelete = '';
    del.textContent = 'Delete project';
    del.style.marginRight = 'auto';
    del.style.display = 'none';
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
    footer.append(del, another, primary);

    panel.append(heading, titleLabel, more, moreRegion, tmplRegion, hint, footer);
    root.append(panel);

    // Keep the template <select> in sync with the loaded templates + the
    // checkbox label. Reads the templates leaf reactively; one-way (DOM only).
    this.effect(() => {
      this.ctx.tree.at(this.templatesPath).get();
      rebuildTemplateOptions();
    }, 'projects.dialogTemplates');
    this.listen(isTmpl, 'change', () => rebuildTemplateOptions());

    /* --- mode state --- */
    let mode: 'create' | 'edit' = 'create';
    let editId: bigint | null = null;
    let editIsTemplate = false;
    let origTitle = '';
    let origDesc = '';

    const showDesc = (open: boolean): void => {
      moreRegion.style.display = open ? '' : 'none';
      more.textContent = open ? '− Less details' : '+ More details';
    };

    const applyMode = (): void => {
      // Template controls are a create-only concern (edit just renames fields).
      tmplRegion.style.display = mode === 'create' ? '' : 'none';
      // Delete is an edit-only, destructive action.
      del.style.display = mode === 'edit' ? '' : 'none';
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
        del.textContent = editIsTemplate ? 'Delete template' : 'Delete project';
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
        descEditor.setValue('', true);
        isTmpl.checked = false;
        rebuildTemplateOptions();
        copySel.value = '';
        showDesc(false);
        applyMode();
        root.style.display = '';
        focusEl(titleInput);
      },
      openEdit: (id, title, description, isTemplate) => {
        mode = 'edit';
        editId = id;
        editIsTemplate = isTemplate;
        origTitle = title;
        origDesc = description;
        titleInput.value = title;
        descEditor.setValue(description, true);
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
      this.fireCreate(title, descEditor.getValue().trim(), isTmpl.checked, copySel.value);
      if (keepOpen) {
        titleInput.value = '';
        descEditor.setValue('', true);
        isTmpl.checked = false;
        rebuildTemplateOptions();
        copySel.value = '';
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
      const desc = descEditor.getValue().trim();
      this.fireEdit(editId, { title, description: desc }, { title: origTitle, description: origDesc });
      dialog.close();
    };

    const commitPrimary = (): void => {
      if (mode === 'create') add(false);
      else save();
    };

    this.listen(another, 'click', () => add(true));
    this.listen(primary, 'click', () => commitPrimary());
    this.listen(del, 'click', () => {
      if (editId === null) return;
      const what = editIsTemplate ? 'template' : 'project';
      const ok =
        typeof confirm === 'function'
          ? confirm(`Delete this ${what}? This cannot be undone.`)
          : true;
      if (!ok) return;
      this.fireDelete(editId, editIsTemplate);
      dialog.close();
    });

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
    // (Description Esc/Mod+Enter are handled by the editor's own keymap above.)

    return dialog;
  }

  /**
   * Fire the declarative create action. We mint the optimistic temp id HERE
   * (so the success sink can find + patch the right row) and pass it in the
   * payload; the action's optimistic patch appends a row with that id, then
   * card.insert fires. On fault the tree transaction auto-rolls-back. A
   * non-empty description rides as `attributes.description`.
   */
  private fireCreate(
    title: string,
    description: string,
    asTemplate: boolean,
    templateId: string,
  ): void {
    const optimisticId = nextOptimisticId();
    this.pendingOptimisticId = optimisticId;
    const hasTemplate = /^-?\d+$/.test(templateId) && BigInt(templateId) > 0n;

    if (asTemplate) {
      // Creating a TEMPLATE: copy a chosen template, or a blank one.
      if (hasTemplate) {
        this.intent('stampTemplate', {
          title,
          description,
          optimisticId,
          templateProjectId: BigInt(templateId),
        });
      } else {
        const attributes: Record<string, unknown> = { is_template: true };
        if (description.length > 0) attributes['description'] = description;
        this.intent('createTemplate', { title, optimisticId, attributes });
      }
      return;
    }

    // Creating a REAL project. A specific template → project.stamp; otherwise
    // the default card.insert path (which auto-stamps the standard template).
    if (hasTemplate) {
      this.intent('stampProject', {
        title,
        description,
        optimisticId,
        templateProjectId: BigInt(templateId),
      });
    } else {
      const payload: { title: string; optimisticId: bigint; attributes?: { description: string } } = {
        title,
        optimisticId,
      };
      if (description.length > 0) payload.attributes = { description };
      this.intent('createProject', payload);
    }
  }

  /** Promote the in-flight optimistic temp row to its server id in `path`
   *  (shared by every create/stamp success sink). */
  private promoteTemp(path: string[], realId: bigint | undefined): void {
    const tempId = this.pendingOptimisticId;
    this.pendingOptimisticId = null;
    if (realId === undefined || tempId === null) return;
    const node = this.ctx.tree.at(path);
    const rows = (node.peek<ProjectOption[]>() ?? []) as ProjectOption[];
    node.set(
      rows.map((r) => {
        if (r.id !== tempId.toString()) return r;
        const promoted: ProjectOption = { id: realId.toString(), label: r.label };
        if (r.description) promoted.description = r.description;
        if (r.isTemplate) promoted.isTemplate = true;
        return promoted;
      }),
    );
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
  /** True for a template project (badged in the list; folded in by the toggle). */
  isTemplate?: boolean;
}

/**
 * Optimistic patch shared by the edit actions: replace `field` ('label' for a
 * title rename, 'description' for the description) on the row whose id matches
 * the payload's `cardId`. An empty new description clears the field (drops the
 * `description` key). Pure over the current leaf + payload.
 */
/** Optimistic-append a pending project row from a create/stamp payload. Reads
 *  the title + an optional description (top-level `description` for stamp, or
 *  `attributes.description` for card.insert) + the minted optimisticId; flags
 *  the row `isTemplate` when it belongs on the templates path. */
function appendPending(current: unknown, payload: unknown, isTemplate: boolean): ProjectOption[] {
  const rows = Array.isArray(current) ? (current as ProjectOption[]) : [];
  const p = (payload ?? {}) as {
    title?: string;
    optimisticId?: bigint;
    description?: string;
    attributes?: { description?: string };
  };
  if (typeof p.title !== 'string' || p.title.length === 0) return rows;
  const id = p.optimisticId ?? nextOptimisticId();
  const row: ProjectOption = { id: id.toString(), label: p.title, pending: true };
  const desc = p.description ?? p.attributes?.description;
  if (typeof desc === 'string' && desc.length > 0) row.description = desc;
  if (isTemplate) row.isTemplate = true;
  return [...rows, row];
}

/** Drop the row whose id matches `payload.cardId` (the optimistic delete). */
function removeRow(current: unknown, payload: unknown): ProjectOption[] {
  const rows = Array.isArray(current) ? (current as ProjectOption[]) : [];
  const p = (payload ?? {}) as { cardId?: bigint };
  if (p.cardId === undefined) return rows;
  const targetId = p.cardId.toString();
  return rows.filter((r) => r.id !== targetId);
}

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
    if (r['isTemplate'] === true) opt.isTemplate = true;
    return opt;
  }
  // Raw card row shape: { id, attributes: { title, description? } }.
  if ('attributes' in r) {
    const card = row as CardWithAttrs;
    const opt: ProjectOption = { id: card.id.toString(), label: projectTitle(card) };
    const desc = projectDescription(card);
    if (desc) opt.description = desc;
    if (card.attributes?.['is_template'] === true) opt.isTemplate = true;
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
  openEdit(id: bigint, title: string, description: string, isTemplate: boolean): void;
  close(): void;
  isOpen(): boolean;
}

/* -------------------------------------------------------------------------- */
/* Hotkeys + registration.                                                     */
/* -------------------------------------------------------------------------- */

export function registerProjectList(): void {
  Control.register('ProjectList', ProjectList);
}
