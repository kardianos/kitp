/**
 * ProjectLayout — the `project` layout body (the Project DETAIL / overview).
 *
 * Registered as control type `Project`, which `shell/screen-host.ts` maps the
 * `project` layout to (`LAYOUT_TO_CONTROL.project = 'Project'`). Before this it
 * resolved to the NotFound placeholder; registering it makes a screen card with
 * `layout:'project'` (or a deep-link to `/project/:id` whose fallback layout is
 * `project`) paint the real overview.
 *
 * Ports the SHELL of the Svelte client's `ProjectDetailScreen.svelte`, re-
 * expressed against the `web/` framework:
 *
 *   - HEADER: the project title + its rendered (markdown) description + an
 *     actions strip — "Edit properties" (opens the {@link ProjectPropertiesPanel}
 *     slide-over), "+ New task" (a hook for #39 quick-entry; disabled with a
 *     title until it lands), and Export (#42) / Import (#41) HOOK buttons (each
 *     fires a `bus.emit` intent + logs a TODO — the two real flows land later).
 *   - TASK COLLECTION: the project's child tasks
 *     (`card.select_with_attributes` parentCardId=project) rendered as a simple
 *     selectable list. The screen reads the SHARED ScreenFilterBar's
 *     `screen.search` + `screen.predicate` leaves (the bar is mounted by the
 *     ScreenHost above this body) and narrows the loaded rows client-side
 *     (parity with the Svelte screen's `applyPredicateAndSort`, search-only +
 *     flat-AND predicate leaves — the common case the chips/Advanced editor
 *     build). Selecting a row navigates to `/task/:id`.
 *   - PER-PROJECT SCREEN NAV: the project's own `screen` cards rendered as tabs
 *     (each links to `/project/:id/screen/:slug`); the active slug is marked.
 *
 * Data flow is ZERO-PROMISE (the RefPicker / TaskDetail posture): every load
 * goes through `api.callByName(spec, input, onOk, { alive })`; no promise
 * crosses the control boundary and every onOk is gated by `isAlive()`. The
 * scoped-task reload re-fires when `scope.projectId` OR the filter leaves change
 * (a tracked effect that only READS those leaves and calls a load — a one-way
 * load, cascade-safe).
 *
 * Keyboard (web/design/hotkeys.md "Project detail", parity with the Svelte
 * screen): `n` new task (hook → quick-entry when #39 lands), `j`/`k` move the
 * task selection, `Enter` open the selected task (`/task/:id`), `e` edit
 * properties (open the panel), `/` focus the shared search.
 *
 * Reference (NOT imported): `client/src/screens/ProjectDetailScreen.svelte` +
 * `client/src/ui/widgets/ProjectPropertiesPanel.svelte`.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { HotkeyBinding } from '../core/hotkeys.js';
import type { ApiFault } from '../core/dispatch.js';
import { setMarkdown } from '../util/markdown-control.js';
import { navigate, taskUrl, screenUrl } from '../shell/router.js';
import { SPEC, type SelectWithAttributesOutput } from '../kanban/specs.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import { projectTitle, projectDescription } from '../projects/project-helpers.js';
import {
  readSlug,
  readTitle as readScreenTitle,
} from '../filter/screen-resolve.js';
import {
  type Predicate,
  isFlatAndOfLeaves,
  toWhereLeaves,
} from '../filter/predicate.js';
import { matchesLeaves } from './project-detail-helpers.js';
import type { ProjectPropertiesPanel } from './project-properties-panel.js';

/* -------------------------------------------------------------------------- */
/* Config + declaration-merged registry type.                                 */
/* -------------------------------------------------------------------------- */

export interface ProjectLayoutConfig extends BaseControlConfig {
  type: 'Project';
  /** Tree path holding the in-scope project id. Default 'scope.projectId'. */
  scopePath?: string[];
  /** card_type name for the scoped collection. Default 'task'. */
  taskCardType?: string;
  /** The active screen slug (for the per-project nav active mark). Default 'project'. */
  slug?: string;
  /**
   * Tree leaves the shared ScreenFilterBar drives. Defaults match the bar:
   * search → 'screen.search', predicate → 'screen.predicate'.
   */
  searchPath?: string[];
  predicatePath?: string[];
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    Project: ProjectLayoutConfig;
  }
}

/* -------------------------------------------------------------------------- */
/* Control.                                                                   */
/* -------------------------------------------------------------------------- */

export class ProjectLayout extends Control<ProjectLayoutConfig> {
  private readonly taskCardType: string;
  private readonly slug: string;

  /** The loaded project card (header source), or null while loading / absent. */
  private project: CardWithAttrs | null = null;
  /** The project's child tasks (the work view), in server order. */
  private tasks: CardWithAttrs[] = [];
  /** The project's own screen cards (per-project nav tabs). */
  private screens: CardWithAttrs[] = [];
  /** Keyboard selection index into the VISIBLE (filtered) task list. */
  private selectedIndex = 0;

  /* DOM regions held so loads can repaint without a full re-render. */
  private titleEl!: HTMLElement;
  private descEl!: HTMLElement;
  private navEl!: HTMLElement;
  private listEl!: HTMLElement;
  private emptyEl!: HTMLElement;
  private panelHost!: HTMLElement;
  /** The Export hook button — the anchor the ExportMenu popover positions against. */
  private exportBtn: HTMLButtonElement | null = null;

  /** The slide-over properties editor (spawned lazily on first open). */
  private propsPanel: ProjectPropertiesPanel | null = null;

  constructor(...args: ConstructorParameters<typeof Control<ProjectLayoutConfig>>) {
    super(...args);
    this.taskCardType = this.config.taskCardType ?? 'task';
    this.slug = this.config.slug ?? 'project';
  }

  private get scopePath(): string[] {
    return this.config.scopePath ?? ['scope', 'projectId'];
  }
  private get searchPath(): string[] {
    return this.config.searchPath ?? ['screen', 'search'];
  }
  private get predicatePath(): string[] {
    return this.config.predicatePath ?? ['screen', 'predicate'];
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'project-detail';
    el.dataset.control = 'Project';
    el.tabIndex = -1;
    return el;
  }

  protected render(): void {
    /* ------------------------------- fault -------------------------------- */
    const fault = document.createElement('div');
    fault.className = 'project-detail__fault';
    fault.dataset.projectFault = '';
    fault.style.display = 'none';

    /* ------------------------------- header ------------------------------- */
    const header = document.createElement('header');
    header.className = 'project-detail__header';
    header.dataset.region = 'project.header';

    const headTop = document.createElement('div');
    headTop.className = 'project-detail__header-top';

    const headText = document.createElement('div');
    headText.className = 'project-detail__header-text';

    const title = document.createElement('h1');
    title.className = 'project-detail__title';
    title.dataset.projectTitle = '';
    this.titleEl = title;

    const desc = document.createElement('div');
    desc.className = 'project-detail__desc md-body';
    desc.dataset.projectDesc = '';
    this.descEl = desc;

    headText.append(title, desc);

    /* ------------------------------ actions ------------------------------- */
    const actions = document.createElement('div');
    actions.className = 'project-detail__actions';

    const editBtn = this.actionButton('Edit properties', 'btn', 'projectEdit', () =>
      this.openProperties(),
    );
    // "+ New task" opens the global quick-entry overlay scoped to this project
    // (the project is passed as the new task's parent).
    const newBtn = this.actionButton('+ New task', 'btn btn-primary', 'projectNewTask', () =>
      this.onNewTask(),
    );
    newBtn.title = 'Quick-add a task in this project';

    // Export (#42): opens the ExportMenu (format + toggles) anchored to this
    // button, scoped to the project + the active screen predicate; the menu
    // triggers the same-origin projectexport GET download. Import (#41) is a
    // hook button that opens the CSV import wizard.
    const exportBtn = this.actionButton('Export', 'btn', 'projectExport', () =>
      this.onExport(),
    );
    exportBtn.setAttribute('aria-haspopup', 'menu');
    this.exportBtn = exportBtn;
    const importBtn = this.actionButton('Import', 'btn', 'projectImport', () =>
      this.onImport(),
    );

    actions.append(editBtn, newBtn, exportBtn, importBtn);
    headTop.append(headText, actions);
    header.append(headTop);

    /* ------------------------- per-project screen nav --------------------- */
    const nav = document.createElement('nav');
    nav.className = 'project-detail__nav';
    nav.dataset.projectNav = '';
    nav.setAttribute('aria-label', 'Project views');
    this.navEl = nav;
    header.append(nav);

    /* --------------------------- task collection -------------------------- */
    const collection = document.createElement('div');
    collection.className = 'project-detail__collection';
    collection.dataset.region = 'project.collection';

    const collLabel = document.createElement('div');
    collLabel.className = 'project-detail__section-label muted';
    collLabel.textContent = 'TASKS';

    const list = document.createElement('ul');
    list.className = 'project-detail__list scroll-y';
    list.dataset.projectTasksList = '';
    list.setAttribute('aria-label', 'Tasks');
    this.listEl = list;

    const empty = document.createElement('div');
    empty.className = 'project-detail__empty muted';
    empty.dataset.projectEmpty = '';
    empty.textContent = 'No tasks yet. Create the first task (press n when #39 lands).';
    empty.style.display = 'none';
    this.emptyEl = empty;

    collection.append(collLabel, list, empty);

    /* ----------------------- properties panel host ------------------------ */
    const panelHost = document.createElement('div');
    panelHost.className = 'project-detail__panel-host';
    panelHost.dataset.projectPanelHost = '';
    this.panelHost = panelHost;

    this.el.append(fault, header, collection, panelHost);

    /* ------------------------------ reactivity ---------------------------- */
    // Self-represented load fault.
    this.effect(() => {
      const f = this.fault.get();
      if (!f) {
        fault.style.display = 'none';
        fault.textContent = '';
        return;
      }
      fault.style.display = '';
      fault.textContent = `Failed to load project: ${describeFault(f)}`;
    }, 'project.fault');

    // Project + screen-nav reload on scope change. ONE-WAY: reads only the
    // scope leaf, fires zero-promise loads (their onOk repaint). Seeds the
    // initial paint too (the effect runs once on registration).
    this.effect(() => {
      const id = this.ctx.tree.at(this.scopePath).get<bigint | null>() ?? null;
      this.loadProject(id);
      this.loadScreens(id);
    }, 'project.scope');

    // Scoped task reload: re-fires on scope OR filter (search / predicate)
    // change, AND on an import-commit (the shared `import.refreshNonce` leaf the
    // AppShell bumps when the import wizard's commit lands new tasks). Reads
    // those leaves, fires the task load with a `where[]` built from a flat-AND
    // predicate + the search needle (mirrors the Grid's applyFilter); the onOk
    // repaints the list. One-way, cascade-safe.
    this.effect(() => {
      const id = this.ctx.tree.at(this.scopePath).get<bigint | null>() ?? null;
      const search = this.ctx.tree.at(this.searchPath).get<string>() ?? '';
      const predicate = this.ctx.tree.at(this.predicatePath).get<Predicate | null>() ?? null;
      // Track the import refresh nonce so a commit reloads the collection.
      this.ctx.tree.at(['import', 'refreshNonce']).get<number>();
      this.loadTasks(id, search, predicate);
    }, 'project.tasks');

    this.renderHeader();
    this.renderNav();
    this.renderList();
  }

  /* --------------------------------- loads ------------------------------- */

  /**
   * Load the focal project by id. `card.select_with_attributes` has no by-id
   * input, so we read the `project` card_type's rows and pick the matching id —
   * the same posture as TaskDetail's by-id load + the Svelte screen's
   * `pickTaskById`; the project set is small in v1.
   */
  private loadProject(id: bigint | null): void {
    if (id === null) {
      this.project = null;
      this.renderHeader();
      return;
    }
    this.ctx.api.callByName(
      SPEC.selectWithAttributes,
      { cardTypeName: 'project' },
      (out) => {
        const rows = (out as SelectWithAttributesOutput).rows ?? [];
        this.project = rows.find((r) => r.id === id) ?? null;
        this.renderHeader();
      },
      { alive: () => this.isAlive() },
    );
  }

  /** Load the project's own screen cards for the per-project nav tabs. */
  private loadScreens(id: bigint | null): void {
    if (id === null) {
      this.screens = [];
      this.renderNav();
      return;
    }
    this.ctx.api.callByName(
      SPEC.selectWithAttributes,
      { cardTypeName: 'screen', parentCardId: id },
      (out) => {
        this.screens = (out as SelectWithAttributesOutput).rows ?? [];
        this.renderNav();
      },
      { alive: () => this.isAlive() },
    );
  }

  /**
   * Load the project's child tasks, narrowed by the shared filter. The search
   * needle + a flat-AND predicate's leaves go to the query `where[]` (the same
   * shape the Grid sends; the server compiles them). A structured predicate
   * (OR / NOT / nesting) is applied CLIENT-side after the load via
   * {@link matchesLeaves} fallback — but for v1 the chips/Advanced common case
   * is flat-AND, which we push to the server. Stays idle until a project scopes.
   */
  private loadTasks(id: bigint | null, search: string, predicate: Predicate | null): void {
    if (id === null) {
      this.tasks = [];
      this.selectedIndex = 0;
      this.renderList();
      return;
    }
    const needle = search.trim();
    const where: Array<{ attr?: string; op?: string; value?: unknown; values?: unknown[] }> = [];
    if (needle.length > 0) where.push({ attr: 'title', op: 'contains', value: needle });
    // Flat-AND predicate leaves push to the server `where[]`. A structured tree
    // is left for the client-side narrow (rare; the chips build flat-AND).
    if (predicate !== null && isFlatAndOfLeaves(predicate)) {
      for (const lf of toWhereLeaves(predicate) ?? []) where.push(lf);
    }

    const input: Record<string, unknown> = {
      cardTypeName: this.taskCardType,
      parentCardId: id,
    };
    if (where.length > 0) input['where'] = where;

    this.ctx.api.callByName(
      SPEC.selectWithAttributes,
      input,
      (out) => {
        this.tasks = (out as SelectWithAttributesOutput).rows ?? [];
        this.selectedIndex = 0;
        this.renderList();
      },
      { alive: () => this.isAlive() },
    );
  }

  /* ------------------------------- header -------------------------------- */

  private titleText(): string {
    if (this.project === null) {
      const id = this.ctx.tree.at(this.scopePath).peek<bigint | null>() ?? null;
      return id === null ? 'Project' : `Project #${id.toString()}`;
    }
    return projectTitle(this.project);
  }

  private renderHeader(): void {
    this.titleEl.textContent = this.titleText();
    const d = this.project !== null ? projectDescription(this.project) : undefined;
    if (d !== undefined && d.length > 0) {
      this.descEl.classList.remove('muted');
      // The single sanctioned markdown → innerHTML sink (marked + DOMPurify).
      setMarkdown(this.descEl, d);
    } else {
      this.descEl.classList.add('muted');
      this.descEl.textContent = 'No description.';
    }
  }

  /* --------------------------- per-project nav --------------------------- */

  private renderNav(): void {
    this.navEl.replaceChildren();
    if (this.screens.length === 0) {
      this.navEl.style.display = 'none';
      return;
    }
    this.navEl.style.display = '';
    const id = this.ctx.tree.at(this.scopePath).peek<bigint | null>() ?? null;
    // Stable order: by title. Each tab links to /project/:id/screen/:slug; the
    // active slug carries an aria-current + a class. The project overview itself
    // (this layout) is the 'project' slug.
    const sorted = [...this.screens].sort((a, b) =>
      readScreenTitle(a).localeCompare(readScreenTitle(b)),
    );
    for (const screen of sorted) {
      const slug = readSlug(screen);
      if (slug === null) continue;
      const tab = document.createElement('a');
      tab.className = 'project-detail__tab';
      tab.dataset.projectTab = slug;
      tab.textContent = readScreenTitle(screen);
      if (slug === this.slug) {
        tab.classList.add('project-detail__tab--active');
        tab.setAttribute('aria-current', 'page');
      }
      if (id !== null) {
        const href = screenUrl(id, slug);
        tab.href = href;
        // Intercept to use the History-API router (one-way navigate, no reload).
        this.listen(tab, 'click', (ev) => {
          ev.preventDefault();
          navigate(href);
        });
      }
      this.navEl.append(tab);
    }
  }

  /* -------------------------- task collection ---------------------------- */

  /** The visible (filtered) task list — server already applied flat-AND/search;
   *  a structured predicate is narrowed here as a fallback. */
  private visibleTasks(): CardWithAttrs[] {
    const predicate = this.ctx.tree.at(this.predicatePath).peek<Predicate | null>() ?? null;
    if (predicate === null || isFlatAndOfLeaves(predicate)) return this.tasks;
    // Structured tree: best-effort client narrow over the flattened leaves.
    const leaves = toWhereLeaves(predicate);
    if (leaves === null) return this.tasks;
    return this.tasks.filter((t) => matchesLeaves(t, leaves));
  }

  private renderList(): void {
    this.listEl.replaceChildren();
    const visible = this.visibleTasks();
    if (this.selectedIndex > visible.length - 1) {
      this.selectedIndex = Math.max(0, visible.length - 1);
    }
    if (visible.length === 0) {
      this.emptyEl.style.display = '';
      this.listEl.style.display = 'none';
      // Tell the user whether it's "no tasks" or "filtered out".
      this.emptyEl.textContent =
        this.tasks.length === 0
          ? 'No tasks yet. Create the first task (press n when #39 lands).'
          : 'No tasks match this filter.';
      return;
    }
    this.emptyEl.style.display = 'none';
    this.listEl.style.display = '';
    visible.forEach((task, i) => this.listEl.append(this.renderRow(task, i)));
  }

  private renderRow(task: CardWithAttrs, index: number): HTMLElement {
    const li = document.createElement('li');
    li.className = 'project-detail__row';
    li.dataset.projectTaskRow = '';
    li.dataset.cardId = task.id.toString();
    li.tabIndex = 0;
    if (index === this.selectedIndex) li.classList.add('project-detail__row--selected');

    const idCell = document.createElement('span');
    idCell.className = 'project-detail__row-id muted';
    idCell.textContent = `#${task.id.toString()}`;

    const titleCell = document.createElement('span');
    titleCell.className = 'project-detail__row-title';
    const t = task.attributes['title'];
    titleCell.textContent = typeof t === 'string' && t.length > 0 ? t : '(untitled)';

    li.append(idCell, titleCell);

    this.listen(li, 'click', () => {
      this.selectedIndex = index;
      this.openTask(task.id);
    });
    this.listen(li, 'focus', () => {
      this.selectedIndex = index;
    });
    this.listen(li, 'keydown', (ev) => {
      const k = (ev as KeyboardEvent).key;
      if (k === 'Enter' || k === 'o') {
        ev.preventDefault();
        this.openTask(task.id);
      }
    });
    return li;
  }

  /** Navigate into a task detail (`/task/:id`) — one-way History write. */
  private openTask(id: bigint): void {
    navigate(taskUrl(id));
  }

  /* ------------------------------ keyboard ------------------------------- */

  override hotkeys(): readonly HotkeyBinding[] {
    return [
      { binding: 'n', label: 'New task', run: () => this.onNewTask() },
      { binding: ['j', 'ArrowDown'], label: 'Next task', run: () => this.moveSelection(+1) },
      { binding: ['k', 'ArrowUp'], label: 'Previous task', run: () => this.moveSelection(-1) },
      { binding: 'Enter', label: 'Open selected task', run: () => this.openSelected() },
      { binding: 'e', label: 'Edit properties', run: () => this.openProperties() },
      // "/" (focus search) is provided by the ScreenHost ancestor for every
      // search screen — no per-body binding needed.
      ...(this.config.hotkeys ?? []),
    ];
  }

  private moveSelection(delta: number): void {
    const visible = this.visibleTasks();
    if (visible.length === 0) {
      this.selectedIndex = 0;
      return;
    }
    let next = this.selectedIndex + delta;
    if (next < 0) next = 0;
    if (next > visible.length - 1) next = visible.length - 1;
    this.selectedIndex = next;
    this.renderList();
    // Focus the now-selected row so subsequent Enter / keys land on it.
    const rows = this.listEl.querySelectorAll<HTMLElement>('[data-project-task-row]');
    const row = rows[next];
    if (row && typeof (row as { focus?: () => void }).focus === 'function') row.focus();
  }

  private openSelected(): void {
    const sel = this.visibleTasks()[this.selectedIndex];
    if (sel !== undefined) this.openTask(sel.id);
  }

  /* ---------------------------- actions / hooks -------------------------- */

  /** Open the properties slide-over (spawned lazily, then reused). */
  private openProperties(): void {
    const id = this.ctx.tree.at(this.scopePath).peek<bigint | null>() ?? null;
    if (id === null) return;
    if (this.propsPanel === null) {
      this.propsPanel = this.spawn(
        'ProjectPropertiesPanel',
        {
          type: 'ProjectPropertiesPanel',
          // When the panel commits a title / description / attribute, repaint
          // the header from the updated project (it patches optimistically and
          // hands us the new card).
          onSaved: (updated: CardWithAttrs) => {
            if (!this.isAlive()) return;
            this.project = updated;
            this.renderHeader();
          },
        },
        this.panelHost,
      ) as ProjectPropertiesPanel;
    }
    this.propsPanel.open(id);
  }

  /** "+ New task" / `n`: open the global quick-entry overlay with this project
   *  as the new task's parent (the overlay also falls back to the project scope
   *  when no explicit parent is passed). */
  private onNewTask(): void {
    const id = this.ctx.tree.at(this.scopePath).peek<bigint | null>() ?? null;
    const detail: { parentCardId?: bigint } = {};
    if (id !== null) detail.parentCardId = id;
    this.ctx.bus?.emit('quickCreateOpen', detail);
  }

  /**
   * Export (#42): raise the `projectExport` intent carrying the in-scope
   * project id, the Export button (the popover anchor), and the active screen
   * predicate (so the export matches the filtered view). The AppShell mounts
   * ONE ExportMenu and wires this intent to open() — a DOM action, not a batch
   * spec, so it stays cascade-safe.
   */
  private onExport(): void {
    const id = this.ctx.tree.at(this.scopePath).peek<bigint | null>() ?? null;
    if (id === null || this.exportBtn === null) return;
    const predicate = this.ctx.tree.at(this.predicatePath).peek<Predicate | null>() ?? null;
    this.ctx.bus?.emit('projectExport', {
      projectId: id,
      anchor: this.exportBtn,
      predicate,
    });
  }

  /** Import (#41) hook button — open the CSV import wizard scoped to this
   *  project. The AppShell mounts ONE ImportWizard and wires the `projectImport`
   *  intent to open() (carrying the project id); on a successful commit the
   *  wizard raises `projectImportDone`, which this layout listens for to refresh
   *  the scoped task collection. */
  private onImport(): void {
    const id = this.ctx.tree.at(this.scopePath).peek<bigint | null>() ?? null;
    if (id === null) return;
    this.ctx.bus?.emit('projectImport', { projectId: id });
  }

  /* -------------------------------- helpers ------------------------------ */

  private actionButton(
    label: string,
    cls: string,
    dataKey: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `${cls} project-detail__action`;
    btn.dataset[dataKey] = '';
    btn.textContent = label;
    this.listen(btn, 'click', () => onClick());
    return btn;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers + registration.                                                     */
/* -------------------------------------------------------------------------- */

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

export function registerProjectLayout(): void {
  Control.register('Project', ProjectLayout);
}
