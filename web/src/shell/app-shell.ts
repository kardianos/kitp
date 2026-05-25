/**
 * AppShell — the persistent frame around every signed-in screen, per the
 * refreshed mock (web/design/mock-kanban.md frame + controls-and-rules.md
 * `AppShell`). Three parts:
 *
 *   - topbar: brand `kitp` + rail-collapse chevron `‹` (left); a project-scope
 *     Picker (`[Default Project ▾]` / `[All projects ▾]`) + breadcrumb crumb
 *     (center); a right cluster of IconButtons — theme toggle `☾`/`☀` (writes
 *     `data-theme` on <html>, R8), panel toggle `▥`, help `?`.
 *   - rail: global links (Projects `g p`, Activity `g a`) with right-aligned
 *     muted chord hints; a DEFAULT PROJECT scope section (Inbox `g i`, Grid
 *     `g g`, Kanban `g k`, Project detail); an ADMIN section; a foot user chip.
 *     Collapses to icon-width via the topbar chevron.
 *   - outlet: a content region into which the ROUTE-DERIVED body mounts.
 *
 * Routing (web/src/shell/router.ts): the route is the source of truth. The
 * outlet effect READS the router's route leaf (`router.route`) and derives the
 * body control + scope from it — one-way (it never writes a signal it tracks).
 * Rail links / the scope picker / project selection / `g _` chords all call
 * `navigate(path)`, which writes History + the route leaf; back/forward replay
 * via popstate. This replaced the old `shell.view` signal swap.
 *
 * Hierarchical hotkeys (web/design/hotkeys.md): the shell declares global-tier
 * chords (`g p`, `g a`, `g i`, `g g`, `g k`, `?`) in its config.hotkeys, raised
 * as INTENTS — never imperative API calls. The HotkeyController derives the
 * active binding set from the live control tree; the shell is the root scope.
 *
 * The route effect mirrors the route's `:id` into `scope.projectId` (the tree
 * leaf the Kanban's `{ signal: 'scope.projectId' }` query trigger reloads on);
 * the scope picker navigates to `/project/:id` rather than writing scope
 * directly. (Scope is resolved by `{ from: 'scope.…' }` inputs in descendants.)
 *
 * No promises; the shell only mounts children, toggles theme, navigates, and
 * raises intents.
 */

import { Control, type BaseControlConfig, type ChildConfig } from '../core/control.js';
import type { QueryBinding } from '../core/data.js';
import type { HotkeyBinding, ResolvedBinding } from '../core/hotkeys.js';
import { formatBinding } from '../core/hotkeys.js';
import { HelpOverlay } from './help-overlay.js';
import type { QuickEntry } from '../quick-entry/quick-entry.js';
import type { ImportWizard } from '../import/import-wizard.js';
import type { ExportMenu } from '../export/export-menu.js';
import { TEMPLATE_EXCLUSION_LEAF } from '../projects/project-helpers.js';
import { AUTH_USER_PATH, type AuthUser } from '../auth/auth-state.js';
import {
  ROUTER_PATH,
  navigate,
  matchRoute,
  screenLayoutForSlug,
  adminUrl,
  screenUrl,
  type RouteMatch,
} from './router.js';

export interface ProjectScopeOption {
  /** bigint id as a string ('' = all projects). */
  id: string;
  label: string;
  /** The project's `description` attribute, carried so the ✎ editor (which
   *  reads the same `shell.projects` path) can prefill without a refetch. */
  description?: string;
}

export interface AppShellConfig extends BaseControlConfig {
  /** Brand text. Default 'kitp'. */
  brand?: string;
  /** Breadcrumb crumb for the current screen, e.g. 'Kanban'. */
  crumb?: string;
  /** Project-scope Picker options. Used as a static fallback / initial seed
   *  before the live `card.select` projects query lands (or in tests). */
  projects?: ProjectScopeOption[];
  /** Initially-selected project id (string; '' = all). */
  projectId?: string;
  /**
   * When the live projects query lands, prefer the project whose title equals
   * this label as the default scope (falls back to the first project). Lets the
   * board mount against a project that actually has tasks + milestones without
   * hard-coding a seed id.
   */
  defaultProjectLabel?: string;
  /** Signed-in user label for the rail foot chip. */
  user?: string;
  /** Nav links for the scope section (slug + label + chord). */
  scopeLinks?: Array<{ slug: string; label: string; chord: string; intent: string }>;
  /** Admin links. Each `key` is the `/admin/:key` route segment it navigates to. */
  adminLinks?: Array<{ label: string; key: string }>;
  /**
   * Resolve an admin route `:key` to a body control config (a MasterDetail
   * config). Supplied by the boot wiring (main.ts) so the shell stays free of
   * any admin-screen knowledge — adding an admin screen is a new entry in this
   * resolver + a rail link, no shell change. Returns null for an unknown key
   * (→ the outlet renders its NotFound placeholder).
   */
  adminConfigFor?: (key: string) => ChildConfig | null;
  /**
   * The board / per-project screen body config (a ScreenHost descriptor).
   * Mounted into the outlet when the route is `/project/:id` or
   * `/project/:id/screen/:slug`. The shell injects the route-derived
   * `screen.layout` (slug→layout) so the SAME ScreenHost descriptor serves
   * every screen slug. When absent, the shell falls back to the first
   * declarative child (back-compat with the existing children wiring).
   */
  boardConfig?: ChildConfig;
  /**
   * Provider for the live keyboard-binding snapshot — wired to the boot's
   * `HotkeyController.snapshot()` (created after the shell mounts, so this is
   * a closure over the controller). Threaded into the HelpOverlay so the `?`
   * overlay lists exactly the bindings active for the current scope chain.
   */
  helpSnapshot?: () => Map<string, ResolvedBinding>;
  /**
   * The global quick-entry overlay config (a QuickEntry descriptor). Mounted
   * ONCE into the shell root and toggled by the `quickCreateOpen` intent (the
   * `n` hotkey from any task screen + the per-column / "+ New task"
   * affordances). Absent → no overlay is mounted (the intent is a no-op).
   */
  quickEntryConfig?: ChildConfig;
  /**
   * The CSV import-wizard config (an ImportWizard descriptor). Mounted ONCE into
   * the shell root and opened by the `projectImport` intent (the Project
   * detail's Import hook button, carrying `{ projectId }`). Absent → no wizard
   * is mounted (the intent is a no-op).
   */
  importWizardConfig?: ChildConfig;
  /**
   * The project-export menu config (an ExportMenu descriptor). Mounted ONCE
   * into the shell root and opened by the `projectExport` intent (the Project
   * detail's Export hook button, carrying `{ projectId, anchor, predicate? }`).
   * Absent → no menu is mounted (the intent is a no-op).
   */
  exportMenuConfig?: ChildConfig;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    AppShell: AppShellConfig;
  }
}

const HTML_THEME_LIGHT = 'light';
const HTML_THEME_DARK = 'dark';

export class AppShell extends Control<AppShellConfig> {
  /**
   * The shell's scope object — resolved by `{ from: 'scope.projectId' }` inputs
   * in descendant data tables. We override the DataHost scope (see dataScope())
   * so the Kanban's project-scoped query reads it. `projectId` is a bigint or
   * null (revived from the Picker's string value).
   */
  private readonly scope: { projectId: bigint | null } = { projectId: null };

  /** Breadcrumb element + rail scope-section, toggled by the active view. */
  private crumbEl: HTMLElement | null = null;
  private scopeSectionEls: HTMLElement[] = [];
  /** Rail ADMIN-section elements (heading + links), shown only for an admin. */
  private adminSectionEls: HTMLElement[] = [];

  /** Expose the scope so the boot wiring can hand it to descendants' ctx. */
  scopeObject(): { projectId: bigint | null } {
    return this.scope;
  }

  /** Update the breadcrumb crumb; when `allProjects`, hide the rail's
   *  DEFAULT PROJECT scope section (per the Projects mock — only Projects /
   *  Activity / ADMIN show when scope = all projects). */
  private setCrumb(crumb: string, allProjects: boolean): void {
    if (this.crumbEl) this.crumbEl.textContent = crumb ? `/ ${crumb}` : '';
    for (const el of this.scopeSectionEls) {
      el.style.display = allProjects ? 'none' : '';
    }
  }

  /**
   * CLASS-STATIC binding table: load the real project cards on mount and feed
   * the scope Picker. Uses select_with_attributes (NOT the lighter card.select,
   * which returns title:null) so each option gets the project's real `title`
   * attribute as its label. The result lands in the `landProjects` handler,
   * which renders the options, picks a default, and writes scope.projectId —
   * driving the descendant Kanban's `{ signal: 'scope.projectId' }` query. This
   * proves the project → scope → board data path end-to-end against live kitpd.
   */
  static override queries: readonly QueryBinding[] = [
    {
      name: 'projects',
      spec: 'card.select_with_attributes',
      when: 'mount',
      // Ship the `is_template != true` leaf so TEMPLATE projects are excluded
      // from the result. Because the list + the scope <select> both read the
      // SAME `shell.projects` path this query lands, the exclusion covers BOTH
      // surfaces at once (parity with the Svelte TEMPLATE_EXCLUSION_LEAF). The
      // `!=`→NOT EXISTS semantics keep projects that never had `is_template`
      // written — that's intended.
      input: {
        cardTypeName: { lit: 'project' },
        where: { lit: [TEMPLATE_EXCLUSION_LEAF] },
      },
      result: { method: 'landProjects' },
      onError: 'self',
    },
  ];

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'shell';
    el.dataset.control = 'AppShell';
    return el;
  }

  protected render(): void {
    const cfg = this.config;
    this.scope.projectId = parseId(cfg.projectId);

    // Named sink for the live projects query (registered before mount() wires
    // the data layer). Decoded rows are card.select_with_attributes rows; the
    // label is the project's `title` attribute (id fallback if missing).
    this.handler('landProjects', (out) => {
      const rows =
        ((out ?? {}) as { rows?: Array<{ id: bigint; attributes?: Record<string, unknown> }> })
          .rows ?? [];
      if (rows.length === 0) return;
      const opts: ProjectScopeOption[] = rows.map((r) => {
        const t = r.attributes?.['title'];
        const d = r.attributes?.['description'];
        const opt: ProjectScopeOption = {
          id: r.id.toString(),
          label: typeof t === 'string' && t.length > 0 ? t : `#${r.id.toString()}`,
        };
        // Carry the description so the ✎ editor can prefill from the same path.
        if (typeof d === 'string' && d.trim().length > 0) opt.description = d.trim();
        return opt;
      });
      // Default: the project matching defaultProjectLabel, else the first.
      const want = cfg.defaultProjectLabel;
      const def = (want ? opts.find((o) => o.label === want) : undefined) ?? opts[0];
      if (def) {
        this.scope.projectId = parseId(def.id);
        // Canonical scope lives on the tree path the descendant Kanban watches.
        this.ctx.tree.at(['scope', 'projectId']).set(this.scope.projectId);
      }
      // Replace the Picker options (the reactive effect re-renders the <select>).
      this.ctx.tree.at(['shell', 'projects']).set(opts);
    });

    /* ----------------------------- topbar ----------------------------- */
    const topbar = document.createElement('header');
    topbar.className = 'shell__topbar';
    topbar.dataset.region = 'shell.topbar';

    const brand = document.createElement('strong');
    brand.className = 'shell__brand';
    brand.textContent = cfg.brand ?? 'kitp';

    const collapse = iconButton('‹', 'Collapse rail');
    collapse.classList.add('shell__collapse');

    // Project-scope Picker (native <select>; the Picker common control lands later).
    // Options render reactively from the tree path the live `card.select` projects
    // query writes (see landProjects); a static `cfg.projects` seeds it before the
    // query lands (and is the whole story in unit tests, which inject no projects
    // query result).
    const scopePicker = document.createElement('select');
    scopePicker.className = 'shell__scope-picker';
    scopePicker.dataset.scopePicker = '';
    const seed = cfg.projects ?? [{ id: '', label: 'All projects' }];
    this.ctx.tree.at(['shell', 'projects']).set(seed);
    const projectsNode = this.ctx.tree.at(['shell', 'projects']);
    this.effect(() => {
      const opts = (projectsNode.get<ProjectScopeOption[]>() ?? []) as ProjectScopeOption[];
      const selected = this.scope.projectId === null ? '' : this.scope.projectId.toString();
      const frag = document.createDocumentFragment();
      for (const p of opts) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.label;
        if (p.id === selected) opt.selected = true;
        frag.append(opt);
      }
      scopePicker.replaceChildren(frag);
      scopePicker.value = selected;
    }, 'shell.scope-picker');

    const crumb = document.createElement('span');
    crumb.className = 'shell__crumb muted';
    crumb.dataset.crumb = '';
    crumb.textContent = cfg.crumb ? `/ ${cfg.crumb}` : '';
    this.crumbEl = crumb;

    const right = document.createElement('div');
    right.className = 'shell__topbar-right';
    const themeBtn = iconButton(currentTheme() === HTML_THEME_DARK ? '☀' : '☾', 'Toggle theme');
    themeBtn.dataset.themeToggle = '';
    const panelBtn = iconButton('▥', 'Toggle panel');
    const helpBtn = iconButton('?', 'Keyboard shortcuts');
    helpBtn.dataset.helpToggle = '';
    right.append(themeBtn, panelBtn, helpBtn);

    topbar.append(collapse, brand, scopePicker, crumb, right);

    /* ------------------------------ rail ------------------------------ */
    const rail = document.createElement('nav');
    rail.className = 'shell__rail';
    rail.dataset.region = 'shell.rail';

    // Global links.
    rail.append(railLink('Projects', 'g p', () => this.intent('goProjects')));
    rail.append(railLink('Activity', 'g a', () => this.intent('goActivity')));

    // DEFAULT PROJECT scope section.
    const scopeLinks = cfg.scopeLinks ?? [
      { slug: 'inbox', label: 'Inbox', chord: 'g i', intent: 'goInbox' },
      { slug: 'grid', label: 'Grid', chord: 'g g', intent: 'goGrid' },
      { slug: 'kanban', label: 'Kanban', chord: 'g k', intent: 'goKanban' },
      { slug: 'project', label: 'Project detail', chord: '', intent: 'goProject' },
    ];
    const scopeHeading = sectionLabel('DEFAULT PROJECT');
    rail.append(scopeHeading);
    this.scopeSectionEls = [scopeHeading];
    for (const l of scopeLinks) {
      const link = railLink(l.label, l.chord, () => this.intent(l.intent));
      link.dataset.slug = l.slug;
      rail.append(link);
      this.scopeSectionEls.push(link);
    }

    // ADMIN section. Each link NAVIGATES to its `/admin/:key` route via the
    // History-API router — the same one-way navigate the rest of the rail uses.
    // The proof that an admin screen is config + a link, never new routing
    // logic: the outlet effect resolves `:key` through `adminConfigFor`.
    //
    // Role-gated: the whole section (heading + links) only shows when the
    // signed-in user is an admin. We collect its elements and an effect reads
    // `auth.user` reactively (the boot /auth/me probe lands it) to toggle their
    // display — a one-way read of the identity leaf, cascade-safe. The router's
    // requireAdmin guard backs this up so a typed `/admin/*` URL is redirected
    // for a non-admin even though the rail link is hidden.
    const adminLinks = cfg.adminLinks ?? [
      { label: 'Contacts', key: 'contacts' },
      { label: 'Users…', key: 'users' },
    ];
    const adminHeading = sectionLabel('ADMIN');
    adminHeading.dataset.adminSection = '';
    rail.append(adminHeading);
    this.adminSectionEls = [adminHeading];
    for (const l of adminLinks) {
      const link = railLink(l.label, '', () => navigate(adminUrl(l.key)));
      link.dataset.adminKey = l.key;
      link.dataset.adminSection = '';
      rail.append(link);
      this.adminSectionEls.push(link);
    }
    // Hide the ADMIN section until/unless the identity resolves to an admin.
    const authUserNode = this.ctx.tree.at([...AUTH_USER_PATH]);
    this.effect(() => {
      const user = authUserNode.get<AuthUser | undefined>();
      const show = user?.isAdmin === true;
      for (const el of this.adminSectionEls) el.style.display = show ? '' : 'none';
    }, 'shell.adminSection');

    // User chip (rail foot).
    const chip = document.createElement('div');
    chip.className = 'shell__user-chip';
    const avatar = document.createElement('span');
    avatar.className = 'shell__avatar';
    avatar.textContent = '⊙';
    const name = document.createElement('span');
    name.className = 'shell__user-name';
    name.dataset.userName = '';
    name.textContent = cfg.user ?? 'System';
    // Reflect the real signed-in display name once the /auth/me probe lands
    // (reactive read of the same identity leaf the ADMIN section watches).
    this.effect(() => {
      const user = this.ctx.tree.at([...AUTH_USER_PATH]).get<AuthUser | undefined>();
      const dn = user?.displayName ?? '';
      name.textContent = dn.length > 0 ? dn : (cfg.user ?? 'System');
    }, 'shell.userChip');
    const caret = document.createElement('span');
    caret.className = 'shell__user-caret muted';
    caret.textContent = '▾';
    chip.append(avatar, name, caret);
    rail.append(chip);

    /* ----------------------------- outlet ----------------------------- */
    const outlet = document.createElement('main');
    outlet.className = 'shell__outlet';
    outlet.dataset.region = 'shell.outlet';

    this.el.append(topbar, rail, outlet);

    /* ----------------------- route-driven outlet ---------------------- */
    // The outlet derives ENTIRELY from the router's route leaf (router.route).
    // The route is the source of truth; this effect READS the leaf and
    // IMPERATIVELY spawns/destroys the body control. It NEVER writes a signal
    // it tracks (navigation is a one-way `navigate()` from a click / hotkey /
    // popstate, outside this effect), so the one-way cascade rule holds.
    //
    // Seed the leaf from the live URL if no route has landed yet (so a shell
    // mounted before installRouter — e.g. a unit test — still renders). The
    // app's installRouter lands the deep-link route at boot.
    const routeNode = this.ctx.tree.at([...ROUTER_PATH]);
    if (routeNode.peek<RouteMatch | null>() == null) {
      const initial = typeof location !== 'undefined' ? location.pathname : '/';
      routeNode.set(matchRoute(initial));
    }
    // The board body config: explicit `boardConfig`, else the first
    // declarative child (back-compat with the existing children wiring).
    const boardConfig: ChildConfig =
      cfg.boardConfig ?? (cfg.children ?? [])[0] ?? { type: 'ScreenHost' };

    let bodyControl: Control | null = null;
    let renderedKey: string | null = null;
    this.effect(() => {
      const route = (routeNode.get<RouteMatch>() ?? matchRoute('/')) as RouteMatch;
      // A stable identity for the current outlet content: a screen re-render is
      // only needed when the route name / params that drive the body change.
      // (scope.projectId is mirrored separately and watched by the board's own
      // query trigger — we don't re-spawn the ScreenHost on a scope change.)
      const key = outletKey(route);
      if (key === renderedKey) return;
      renderedKey = key;
      // Tear down the previous body before mounting the next.
      if (bodyControl) {
        this.destroyChild(bodyControl);
        bodyControl = null;
      }
      bodyControl = this.renderRoute(route, boardConfig, outlet);
    }, 'shell.outlet');

    /* --------------------------- interactions -------------------------- */
    this.listen(collapse, 'click', () => this.el.classList.toggle('shell--rail-collapsed'));
    this.listen(themeBtn, 'click', () => {
      const next = currentTheme() === HTML_THEME_DARK ? HTML_THEME_LIGHT : HTML_THEME_DARK;
      setTheme(next);
      themeBtn.textContent = next === HTML_THEME_DARK ? '☀' : '☾';
    });
    this.listen(helpBtn, 'click', () => this.intent('toggleHelp'));
    this.listen(scopePicker, 'change', () => {
      const id = parseId(scopePicker.value);
      // The scope picker is now a NAV control: picking a project navigates to
      // its default screen (`/project/:id`); picking "all projects" goes to
      // `/projects`. The route effect sets `scope.projectId` from the route, so
      // the board's `{ signal: 'scope.projectId' }` query trigger refires. We
      // raise `projectChanged` for any listener that wants the raw id.
      navigate(id === null ? '/projects' : `/project/${id.toString()}`);
      this.intent('projectChanged', { projectId: id });
    });

    /* --------------------------- nav intents --------------------------- */
    // Rail links + global `g _` chords raise these intents; the shell maps each
    // to a NAVIGATE call (History-API router). 'goProjects' lands the
    // all-projects list; the per-project screen chords build a
    // `/project/:id/screen/:slug` URL from the CURRENT project scope (the
    // route is the source of truth — these read the live scope leaf at fire
    // time). All are one-way navigations outside any tracked effect.
    const goScreen = (slug: string): void => {
      const id = this.ctx.tree.at(['scope', 'projectId']).peek<bigint | null>();
      // No project in scope yet → fall back to the projects list (nothing to
      // screen against). Once a project resolves the chord lands its screen.
      navigate(id == null ? '/projects' : screenUrl(id, slug));
    };
    this.registerIntent('goProjects', () => navigate('/projects'));
    this.registerIntent('goInbox', () => goScreen('inbox'));
    this.registerIntent('goGrid', () => goScreen('grid'));
    this.registerIntent('goKanban', () => goScreen('kanban'));
    this.registerIntent('goProject', () => goScreen('project'));

    /* --------------------------- help overlay -------------------------- */
    // The `toggleHelp` intent (raised by the `?`/`Mod+/` chord AND the topbar
    // `?` button) was previously DEAD — nothing handled it. Mount a hidden
    // HelpOverlay into the shell root and toggle it here. Open/close is a pure
    // DOM toggle inside the control (no signal write), so it stays cascade-safe.
    const help = this.spawn(
      'HelpOverlay',
      { type: 'HelpOverlay', snapshot: cfg.helpSnapshot } as ChildConfig,
      this.el,
    ) as HelpOverlay;
    this.registerIntent('toggleHelp', () => help.toggle());

    /* -------------------------- quick-entry overlay ------------------------ */
    // The global `n` fast-task-create overlay. Mounted ONCE into the shell root
    // (like the HelpOverlay); the `quickCreateOpen` intent — raised by the `n`
    // hotkey on any task screen + the kanban column `+` / project "+ New task"
    // affordances — opens it scoped to the current project. The opener's detail
    // (parentCardId / prefill) is forwarded to open(). A DOM toggle inside the
    // control (no signal write), so it stays cascade-safe.
    if (cfg.quickEntryConfig) {
      const qe = this.spawn(cfg.quickEntryConfig.type, cfg.quickEntryConfig, this.el) as QuickEntry;
      this.registerIntent('quickCreateOpen', (detail) => qe.open(detail));
      this.registerIntent('quickCreateClose', () => qe.close());
    }

    /* --------------------------- import wizard -------------------------- */
    // The CSV import wizard, mounted ONCE into the shell root (like the
    // quick-entry overlay). The Project detail's Import hook raises the
    // `projectImport` intent with `{ projectId }`; the shell opens the wizard
    // scoped to that project. A DOM toggle inside the control (no signal write),
    // so it stays cascade-safe. On a successful commit the wizard raises
    // `projectImportDone` — re-broadcast as an intent so the focal project body
    // (which listens) can refresh its tasks.
    if (cfg.importWizardConfig) {
      const wiz = this.spawn(cfg.importWizardConfig.type, cfg.importWizardConfig, this.el) as ImportWizard;
      this.registerIntent('projectImport', (detail) => wiz.open(detail));
      this.registerIntent('projectImportClose', () => wiz.close());
    }

    /* --------------------------- export menu --------------------------- */
    // The project-export dropdown, mounted ONCE into the shell root (like the
    // import wizard). The Project detail's Export hook raises the
    // `projectExport` intent with `{ projectId, anchor, predicate? }`; the
    // shell opens the menu anchored to the Export button. Choosing a format +
    // toggles triggers a same-origin GET download (a DOM/navigation action,
    // not a batch spec), so it stays cascade-safe.
    if (cfg.exportMenuConfig) {
      const xm = this.spawn(cfg.exportMenuConfig.type, cfg.exportMenuConfig, this.el) as ExportMenu;
      this.registerIntent('projectExport', (detail) => xm.open(detail));
      this.registerIntent('projectExportClose', () => xm.closeMenu());
    }
    // A commit lands new tasks: bump the shared `import.refreshNonce` leaf so any
    // project body watching it reloads its scoped task collection. A one-way
    // write outside any tracked effect (cascade-safe). Registered regardless of
    // whether a wizard is mounted so the intent is never dead.
    this.registerIntent('projectImportDone', () => {
      const node = this.ctx.tree.at(['import', 'refreshNonce']);
      node.set((node.peek<number>() ?? 0) + 1);
    });
  }

  /**
   * Spawn the outlet body for a matched route. The route is the source of
   * truth: this maps `route.name` → a body control, sets `scope.projectId`
   * from the route's `:id` (for project / screen routes), and derives the
   * ScreenHost layout from the route's `:slug` via `screenLayoutForSlug`
   * (the #29 seam). Pure spawn — the route leaf was already read by the caller
   * effect; this writes only DOM + the scope mirror (a leaf no caller effect
   * tracks), so the one-way cascade rule holds.
   */
  private renderRoute(route: RouteMatch, boardConfig: ChildConfig, outlet: HTMLElement): Control {
    switch (route.name) {
      case 'projects': {
        this.setScope(null);
        this.setCrumb('Projects', true);
        return this.spawn('ProjectList', { type: 'ProjectList' }, outlet);
      }
      case 'project':
      case 'screen': {
        const id = parseId(route.params['id']);
        this.setScope(id);
        // The default screen for `/project/:id` is the board (kanban for now);
        // `/project/:id/screen/:slug` SEEDS the body from the slug→layout
        // fallback (#29), then the ScreenHost resolves the project's real
        // `screen` card by slug and re-dispatches its body off the card's
        // `layout` attribute. We do NOT carry the board's kanban `bodyConfig`
        // across (that would pin every slug to Kanban).
        const slug = route.name === 'screen' ? (route.params['slug'] ?? 'kanban') : 'kanban';
        const layout = route.name === 'screen' ? screenLayoutForSlug(slug) : 'kanban';
        const screen = { slug, layout, title: capitalise(slug) };
        // Carry over the board descriptor's NON-screen fields (e.g. the
        // declarative `children` that prove NotFound degradation), but replace
        // the screen with the route-derived one. `resolveScreen` switches on the
        // host's real screen-card resolution (off in unit tests via boardConfig).
        const cfg: ChildConfig = {
          ...boardConfig,
          type: boardConfig.type,
          screen,
          resolveScreen: true,
        };
        this.setCrumb(screen.title, false);
        return this.spawn(cfg.type, cfg, outlet);
      }
      case 'task': {
        // #33 builds the real task-detail screen; for now a visible stub via
        // the NotFound placeholder (graceful degradation, never throws).
        this.setCrumb(`Task #${route.params['id'] ?? ''}`, true);
        return this.spawn(
          'TaskDetail',
          { type: 'TaskDetail', taskId: route.params['id'] } as ChildConfig,
          outlet,
        );
      }
      case 'admin': {
        // Resolve `/admin/:key` to a MasterDetail config via the boot resolver.
        // No admin-screen knowledge lives in the shell. An unknown key resolves
        // to a NotFound placeholder (graceful degradation).
        const key = route.params['key'] ?? '';
        const adminCfg = this.config.adminConfigFor?.(key) ?? { type: `UnknownAdmin:${key}` };
        this.setCrumb((adminCfg as { title?: string }).title ?? 'Admin', true);
        return this.spawn(adminCfg.type, adminCfg, outlet);
      }
      case 'notfound':
      default: {
        this.setCrumb('Not found', true);
        return this.spawn(
          `NoRoute:${route.path}`,
          { type: `NoRoute:${route.path}`, path: route.path } as ChildConfig,
          outlet,
        );
      }
    }
  }

  /**
   * Mirror the route-derived project id into the scope object + the
   * `scope.projectId` tree leaf the board's query trigger watches. A one-way
   * write (no caller effect reads scope.projectId), so cascade-safe.
   */
  private setScope(id: bigint | null): void {
    this.scope.projectId = id;
    this.ctx.tree.at(['scope', 'projectId']).set(id);
  }

  /** Mount a body child into the outlet imperatively (used by boot wiring). */
  mountIntoOutlet(type: string, config: ChildConfig): Control {
    const outlet = this.el.querySelector<HTMLElement>('.shell__outlet');
    const host = outlet ?? this.el;
    return this.spawn(type, config, host);
  }
}

/**
 * The outlet-content identity for a route — the route name plus the params
 * that determine WHICH body control + config the outlet shows. The scope id
 * is INCLUDED for project/screen routes (navigating between two projects' same
 * screen re-spawns the ScreenHost so its mount-time scope is fresh), and the
 * slug for screen routes. Used to skip a redundant re-spawn when the route
 * object identity changes but the meaningful key does not.
 */
function outletKey(route: RouteMatch): string {
  switch (route.name) {
    case 'project':
      return `project:${route.params['id'] ?? ''}`;
    case 'screen':
      return `screen:${route.params['id'] ?? ''}:${route.params['slug'] ?? ''}`;
    case 'task':
      return `task:${route.params['id'] ?? ''}`;
    case 'admin':
      return `admin:${route.params['key'] ?? ''}`;
    default:
      return route.name;
  }
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/* -------------------------------------------------------------------------- */
/* DOM helpers (textContent only).                                            */
/* -------------------------------------------------------------------------- */

function iconButton(glyph: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'iconbtn';
  b.textContent = glyph;
  b.title = title;
  b.setAttribute('aria-label', title);
  return b;
}

function railLink(label: string, chord: string, onClick: () => void): HTMLElement {
  const a = document.createElement('button');
  a.type = 'button';
  a.className = 'shell__link';
  const text = document.createElement('span');
  text.textContent = label;
  a.append(text);
  if (chord) {
    const hint = document.createElement('span');
    hint.className = 'shell__chord muted';
    // Display the chord as the design shows it (the raw `g p` form).
    hint.textContent = chord;
    a.append(hint);
  }
  a.addEventListener('click', onClick);
  return a;
}

function sectionLabel(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'shell__section-label muted';
  el.textContent = text;
  return el;
}

function currentTheme(): string {
  if (typeof document === 'undefined' || !document.documentElement) return HTML_THEME_LIGHT;
  return document.documentElement.getAttribute('data-theme') ?? HTML_THEME_LIGHT;
}

function setTheme(theme: string): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.setAttribute('data-theme', theme);
}

function parseId(raw: string | undefined): bigint | null {
  if (!raw || raw === '') return null;
  if (!/^-?\d+$/.test(raw)) return null;
  try {
    const n = BigInt(raw);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

/** Build the default global-tier hotkey chords as INTENT-raising bindings. */
export function shellHotkeys(emit: (intent: string) => void): HotkeyBinding[] {
  return [
    { binding: 'g p', label: 'Go to Projects', run: () => emit('goProjects') },
    { binding: 'g a', label: 'Go to Activity', run: () => emit('goActivity') },
    { binding: 'g i', label: 'Go to Inbox', run: () => emit('goInbox') },
    { binding: 'g g', label: 'Go to Grid', run: () => emit('goGrid') },
    { binding: 'g k', label: 'Go to Kanban', run: () => emit('goKanban') },
    { binding: ['?', 'Mod+/'], label: 'Keyboard shortcuts', run: () => emit('toggleHelp') },
    // Global `n` opens the quick-entry overlay scoped to the current project.
    // Task screens (kanban/grid/inbox) layer their own `n` over this to pass a
    // column/project prefill; ProjectList's deeper `n` shadows it (project
    // create) on the all-projects landing.
    { binding: 'n', label: 'New task', run: () => emit('quickCreateOpen') },
  ];
}

/** Re-export so callers can format a binding for a help overlay. */
export { formatBinding };

export function registerAppShell(): void {
  Control.register('AppShell', AppShell);
}
