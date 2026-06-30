/**
 * AppShell — the persistent frame around every signed-in screen, per the
 * refreshed mock (web/design/mock-kanban.md frame + controls-and-rules.md
 * `AppShell`). Three parts:
 *
 *   - topbar: the workspace-title brand + rail-collapse chevron `‹` (left); a
 *     project-scope Picker (`[Default Project ▾]` / `[All projects ▾]`) +
 *     breadcrumb crumb (center); a right cluster of IconButtons — theme toggle
 *     `☾`/`☀` (writes `data-theme` on <html>, R8), instructions `ⓘ`
 *     ("About this screen"), keyboard-shortcuts help `?`.
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
import { logout } from './logout.js';
import {
  ROUTER_PATH,
  navigate,
  matchRoute,
  adminUrl,
  screenUrl,
  type RouteMatch,
} from './router.js';
import { WORKSPACE_TITLE_PATH, COMMS_BELL_URL_PATH, DEFAULT_WORKSPACE_TITLE } from './config-specs.js';
import { readSlug, readTitle } from '../filter/screen-resolve.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import {
  COMM_UNSEEN_COUNT_SPEC,
  type CommUnseenCountInput,
  type CommUnseenCountOutput,
} from '../task-detail/comm-specs.js';
import { icon, setIcon, type IconName } from '../ui/icons.js';
import { loadWorkflowStatusIds } from '../ui/workflow-statuses.js';

export interface ProjectScopeOption {
  /** bigint id as a string ('' = all projects). */
  id: string;
  label: string;
  /** The project's `description` attribute, carried so the ✎ editor (which
   *  reads the same `shell.projects` path) can prefill without a refetch. */
  description?: string;
}

/** One DEFAULT-PROJECT rail link, derived from a `screen` card. `hotkey` (the
 *  card's single-char `hotkey` attr) wires the `g <hotkey>` navigation chord. */
interface ScopeLink {
  slug: string;
  label: string;
  chord: string;
  hotkey?: string;
}

export interface AppShellConfig extends BaseControlConfig {
  /**
   * Static brand fallback. Normally UNSET: the header shows the operator-set
   * WORKSPACE TITLE from `config.workspaceTitle` (config.get), falling back to
   * the neutral 'Workspace'. A test may pin a value here; 'kitp' is never a
   * default. */
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
  scopeLinks?: Array<{ slug: string; label: string; chord: string }>;
  /** Admin links. Each `key` is the `/admin/:key` route segment it navigates to.
   *  `minRole` (default 'admin') gates who sees the link — 'manager' also shows
   *  it to a manager (e.g. "Manage values"); the route guard matches. `section`
   *  places the link under the WORKSPACE (global) or PROJECT (active-project-
   *  scoped) rail heading; default 'workspace'. */
  adminLinks?: Array<{
    label: string;
    key: string;
    minRole?: 'admin' | 'manager';
    section?: 'workspace' | 'project';
  }>;
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
  /** Current help topic key (route-derived), threaded to the HelpOverlay so it
   *  loads the server's contextual markdown. */
  helpTopic?: () => string | null;
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
  /** The rail's DEFAULT-PROJECT links container, rebuilt from the active
   *  project's screen cards (data-driven nav — see loadScopeLinks). */
  private scopeLinksHost: HTMLElement | null = null;
  /** Rail admin sub-sections (WORKSPACE / PROJECT): each section's chrome
   *  (heading + list) + its per-link role gates. A section shows iff ANY of its
   *  links is visible to the current identity. */
  private adminSections: Array<{
    chrome: HTMLElement[];
    gates: Array<{ el: HTMLElement; minRole: 'admin' | 'manager' }>;
  }> = [];

  /** Notification bell: the button + its count badge, plus poll state. The
   *  baseline is the create-activity id of the newest received comm the user
   *  has "seen" (persisted per-user in localStorage); the badge shows how many
   *  arrived after it. See startCommPoll. */
  private bellBtn: HTMLButtonElement | null = null;
  private bellBadgeEl: HTMLElement | null = null;
  private commSeenBaseline = 0n;
  private commLatest = 0n;
  private commStorageKey: string | null = null;
  private commPollTimer: ReturnType<typeof setInterval> | null = null;
  private commPollStarted = false;
  private static readonly COMM_POLL_MS = 45_000;

  /** Expose the scope so the boot wiring can hand it to descendants' ctx. */
  scopeObject(): { projectId: bigint | null } {
    return this.scope;
  }

  /**
   * Boot hook: called with the route's body control each time the outlet
   * (re)mounts one. The boot wiring sets the hotkey "active" scope to it so a
   * screen's chords (TaskDetail `e _`, etc.) are live immediately on navigation,
   * before any click/focus. Optional — unset in tests.
   */
  onBodyMount?: (body: Control) => void;

  /** Update the breadcrumb crumb. The rail's DEFAULT PROJECT scope section
   *  visibility is owned by a reactive effect on the route + `scope.projectId`
   *  (see render → 'shell.scopeSection'), not here, so it follows a scope set
   *  AFTER the route renders — e.g. the task detail publishing its project. */
  private setCrumb(crumb: string): void {
    if (this.crumbEl) this.crumbEl.textContent = crumb ? `/ ${crumb}` : '';
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
      if (rows.length === 0) {
        // Loaded, but there are no (non-template) projects. REPLACE the
        // "Loading projects…" seed with an empty list — otherwise the seed
        // sticks and the picker reads "Loading projects…" forever, and the
        // /projects ProjectList (which reads this same `shell.projects` leaf)
        // shows a phantom loading row instead of its empty-state. The picker
        // renders a "No projects" placeholder for an empty list (below).
        // Nothing to scope to, so scope.projectId is left as-is.
        this.ctx.tree.at(['shell', 'projects']).set([]);
        return;
      }
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
      // Pick the active project: the persisted last-used one (if still present),
      // else the configured defaultProjectLabel, else the first. There is ALWAYS
      // an active project once any exist. We only adopt the default when nothing
      // is in scope yet — a deep-link to /project/:id (or any route that already
      // set scope) wins, so landing never clobbers it.
      const persisted = readActiveProject();
      const def =
        (persisted ? opts.find((o) => o.id === persisted) : undefined) ??
        (cfg.defaultProjectLabel ? opts.find((o) => o.label === cfg.defaultProjectLabel) : undefined) ??
        opts[0];
      if (def && this.scope.projectId === null) {
        this.setScope(parseId(def.id));
      }
      // Replace the Picker options (the reactive effect re-renders the <select>).
      this.ctx.tree.at(['shell', 'projects']).set(opts);
    });

    /* ----------------------------- topbar ----------------------------- */
    const topbar = document.createElement('header');
    topbar.className = 'shell__topbar';
    topbar.dataset.region = 'shell.topbar';

    // The header brand shows the operator-set WORKSPACE TITLE. It reads the
    // `config.workspaceTitle` leaf reactively (loadServerConfig lands it from
    // config.get after boot); before it lands — and when no title is configured
    // — it falls back to a static `cfg.brand` (tests) or the neutral
    // 'Workspace'. The old 'kitp' brand is never shown.
    const brand = document.createElement('strong');
    brand.className = 'shell__brand';
    brand.dataset.brand = '';
    const workspaceTitleNode = this.ctx.tree.at([...WORKSPACE_TITLE_PATH]);
    this.effect(() => {
      const t = workspaceTitleNode.get<string>();
      const text = typeof t === 'string' && t.trim() !== '' ? t.trim() : (cfg.brand ?? DEFAULT_WORKSPACE_TITLE);
      brand.textContent = text;
    }, 'shell.brand');

    const collapse = iconButton('chevron-left', 'Collapse rail');
    collapse.classList.add('shell__collapse');

    // Project-scope Picker (native <select>; the Picker common control lands later).
    // Options render reactively from the tree path the live `card.select` projects
    // query writes (see landProjects); a static `cfg.projects` seeds it before the
    // query lands (and is the whole story in unit tests, which inject no projects
    // query result).
    // The picker is a PROJECT SWITCHER — it lists only real projects (there is
    // always an active one); it never offers an "all projects" choice. Before
    // the live query lands it shows a neutral "Loading…" placeholder.
    const scopePicker = document.createElement('select');
    scopePicker.className = 'shell__scope-picker';
    scopePicker.dataset.scopePicker = '';
    const seed = cfg.projects ?? [{ id: '', label: 'Loading projects…' }];
    this.ctx.tree.at(['shell', 'projects']).set(seed);
    const projectsNode = this.ctx.tree.at(['shell', 'projects']);
    this.effect(() => {
      const opts = (projectsNode.get<ProjectScopeOption[]>() ?? []) as ProjectScopeOption[];
      // Reactive on the scope leaf so the <select> reflects the active project
      // after navigation (setScope), not just when the options change.
      const pid = this.ctx.tree.at(['scope', 'projectId']).get<bigint | null>() ?? null;
      const selected = pid === null ? '' : pid.toString();
      const frag = document.createDocumentFragment();
      if (opts.length === 0) {
        // Loaded with no projects: a non-selectable "No projects" placeholder
        // so the <select> never sits blank or stuck on the "Loading projects…"
        // seed. (The seed itself still shows while the query is in flight.)
        const ph = document.createElement('option');
        ph.value = '';
        ph.textContent = 'No projects';
        ph.disabled = true;
        ph.selected = true;
        frag.append(ph);
      } else {
        for (const p of opts) {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = p.label;
          if (p.id === selected) opt.selected = true;
          frag.append(opt);
        }
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
    const themeBtn = iconButton(currentTheme() === HTML_THEME_DARK ? 'sun' : 'moon', 'Toggle theme');
    themeBtn.dataset.themeToggle = '';
    // Instructions ("About this screen"): opens the help overlay, which renders
    // the current screen's authored instructions markdown, then an <hr>, then
    // the live keyboard-shortcut cheatsheet. Previously a dead "▥ Toggle panel"
    // button; now wired to the same `toggleHelp` intent the `?` chord raises.
    const instructionsBtn = iconButton('info', 'About this screen');
    instructionsBtn.dataset.instructionsToggle = '';
    const helpBtn = iconButton({ text: '?' }, 'Keyboard shortcuts');
    helpBtn.dataset.helpToggle = '';

    // Notification bell: a count badge for newly received comms. Clicking opens
    // the global Activity view and marks the current latest as seen.
    const bell = iconButton('mail', 'No new messages');
    bell.classList.add('iconbtn--bell');
    bell.dataset.commsBell = '';
    const badge = document.createElement('span');
    badge.className = 'iconbtn__badge';
    badge.dataset.commsBadge = '';
    badge.style.display = 'none';
    bell.append(badge);
    this.bellBtn = bell;
    this.bellBadgeEl = badge;
    this.listen(bell, 'click', () => {
      this.goToCommsScreen();
      this.markCommsSeen();
    });

    right.append(bell, themeBtn, instructionsBtn, helpBtn);

    topbar.append(collapse, brand, scopePicker, crumb, right);

    /* ------------------------------ rail ------------------------------ */
    const rail = document.createElement('nav');
    rail.className = 'shell__rail';
    rail.dataset.region = 'shell.rail';

    // Global links.
    rail.append(railLink('Projects', 'g p', () => this.intent('goProjects')));
    rail.append(railLink('Activity', 'g a', () => this.intent('goActivity')));

    // DEFAULT PROJECT scope section. Links are PURELY DATA-DRIVEN off the
    // active project's `screen` cards — no hardcoded Inbox/Grid/Kanban slugs
    // (a project with no inbox-hotkey screen had its `g i` chord land
    // /screen/inbox via a stale hardcoded entry; both are gone). `cfg.scopeLinks`
    // is a test seam to inject links; otherwise we start empty and wait for
    // `loadScopeLinks` to publish from the project's screen cards.
    const fallbackLinks = cfg.scopeLinks ?? [];
    const scopeHeading = sectionLabel('TASKS');
    const scopeLinksHost = document.createElement('div');
    scopeLinksHost.className = 'shell__scope-links';
    scopeLinksHost.dataset.region = 'shell.scopeLinks';
    rail.append(scopeHeading, scopeLinksHost);
    // The show/hide effect toggles the heading + the whole links host together.
    this.scopeSectionEls = [scopeHeading, scopeLinksHost];
    this.scopeLinksHost = scopeLinksHost;
    this.renderScopeLinks(fallbackLinks.map((l) => ({ slug: l.slug, label: l.label, chord: l.chord })));
    this.loadScopeLinks();
    this.startCommPoll();

    // ADMIN: split into WORKSPACE (global) + PROJECT (active-project-scoped)
    // sub-sections. Each link NAVIGATES to its `/admin/:key` route via the
    // History-API router (the outlet effect resolves `:key` through
    // `adminConfigFor` — no routing logic here). Each is a collapsible
    // disclosure (default collapsed). ROLE-GATING toggles inline `display` per
    // link + per section (the effect below); the router's requireAdmin guard
    // backs it up for typed `/admin/*` URLs.
    const adminLinks = cfg.adminLinks ?? [
      { label: 'Contacts', key: 'contacts' },
      { label: 'Users…', key: 'users' },
    ];
    this.adminSections = [];
    const workspaceLinks = adminLinks.filter((l) => (l.section ?? 'workspace') === 'workspace');
    const projectLinks = adminLinks.filter((l) => l.section === 'project');
    if (projectLinks.length > 0) this.buildAdminSection(rail, 'PROJECT', projectLinks);
    if (workspaceLinks.length > 0) this.buildAdminSection(rail, 'WORKSPACE', workspaceLinks);

    // Per-link + per-section role gate. An admin sees every link; a manager sees
    // only links flagged minRole:'manager' (e.g. "Manage values"); a plain worker
    // sees none. A section's chrome (heading + list) shows iff ANY of its links
    // is visible. One-way read of the identity leaf (the boot /auth/me probe
    // lands it), writes only DOM — cascade-safe.
    const authUserNode = this.ctx.tree.at([...AUTH_USER_PATH]);
    this.effect(() => {
      const user = authUserNode.get<AuthUser | undefined>();
      const isAdmin = user?.isAdmin === true;
      const roles = user?.roles ?? [];
      for (const section of this.adminSections) {
        let anyVisible = false;
        for (const { el, minRole } of section.gates) {
          const show = isAdmin || (minRole === 'manager' && roles.includes('manager'));
          el.style.display = show ? '' : 'none';
          if (show) anyVisible = true;
        }
        for (const el of section.chrome) el.style.display = anyVisible ? '' : 'none';
      }
    }, 'shell.adminSection');

    // Load the active project's task-flow status set into scope.workflowStatusIds
    // (one owner) so every status surface scopes its Linear-style icon ramp to
    // the same statuses the kanban shows — see ui/workflow-statuses.ts.
    this.effect(() => {
      const pid = this.ctx.tree.at(['scope', 'projectId']).get<bigint | null>() ?? null;
      loadWorkflowStatusIds(this.ctx, pid, () => this.isAlive());
    }, 'shell.workflowStatuses');

    // User chip (rail foot) — a button that expands a menu with Account + Logout.
    const userWrap = document.createElement('div');
    userWrap.className = 'shell__user';
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'shell__user-chip';
    chip.dataset.userChip = '';
    chip.setAttribute('aria-haspopup', 'menu');
    chip.setAttribute('aria-expanded', 'false');
    const avatar = document.createElement('span');
    avatar.className = 'shell__avatar';
    avatar.append(icon('circle-user'));
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
    caret.append(icon('chevron-down', 14));
    chip.append(avatar, name, caret);

    // The expanding menu (Account / Logout), hidden until the chip is clicked.
    const menu = document.createElement('div');
    menu.className = 'shell__user-menu';
    menu.dataset.userMenu = '';
    menu.style.display = 'none';
    const setMenuOpen = (open: boolean): void => {
      menu.style.display = open ? '' : 'none';
      chip.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    const accountBtn = document.createElement('button');
    accountBtn.type = 'button';
    accountBtn.className = 'shell__user-menu-item';
    accountBtn.dataset.userMenuAccount = '';
    accountBtn.textContent = 'Account';
    this.listen(accountBtn, 'click', () => {
      setMenuOpen(false);
      navigate('/account');
    });
    // "My Agents" — every signed-in user manages their own agents (the screen +
    // server scope them to the owner). Distinct from the admin-only, all-users
    // Agents screen under the ADMIN rail section.
    const agentsBtn = document.createElement('button');
    agentsBtn.type = 'button';
    agentsBtn.className = 'shell__user-menu-item';
    agentsBtn.dataset.userMenuAgents = '';
    agentsBtn.textContent = 'My Agents';
    this.listen(agentsBtn, 'click', () => {
      setMenuOpen(false);
      navigate('/agents');
    });
    const logoutBtn = document.createElement('button');
    logoutBtn.type = 'button';
    logoutBtn.className = 'shell__user-menu-item';
    logoutBtn.dataset.userMenuLogout = '';
    logoutBtn.textContent = 'Log out';
    this.listen(logoutBtn, 'click', () => {
      setMenuOpen(false);
      logout();
    });
    menu.append(accountBtn, agentsBtn, logoutBtn);

    this.listen(chip, 'click', () => setMenuOpen(menu.style.display === 'none'));
    // Dismiss on outside-click / Esc (document-tier; cleaned up on destroy).
    const onDocDown = (e: Event): void => {
      if (!userWrap.contains?.(e.target as Node)) setMenuOpen(false);
    };
    const onDocKey = (e: Event): void => {
      if ((e as KeyboardEvent).key === 'Escape') setMenuOpen(false);
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('pointerdown', onDocDown, true);
      document.addEventListener('keydown', onDocKey, true);
      this.onDestroy(() => {
        document.removeEventListener('pointerdown', onDocDown, true);
        document.removeEventListener('keydown', onDocKey, true);
      });
    }

    userWrap.append(chip, menu);
    rail.append(userWrap);

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
      // Make the freshly-mounted body the active hotkey scope (boot wiring).
      this.onBodyMount?.(bodyControl);
      // Screen-mount transition: re-add the enter class so the new body rises
      // in (the forced reflow restarts the CSS animation; reduced-motion zeroes
      // its duration, and jsdom ignores animations entirely).
      outlet.classList.remove('shell__outlet--enter');
      void outlet.offsetWidth;
      outlet.classList.add('shell__outlet--enter');
    }, 'shell.outlet');

    // DEFAULT PROJECT scope-section visibility — REACTIVE on `scope.projectId`
    // alone. Post-#9 a project is ALWAYS active, so the section shows on every
    // route (projects landing / admin included) — the project's screen config is
    // never lost from the rail. Driving it off the leaf means it also reveals
    // when scope is set AFTER the route paints — e.g. the TaskDetail publishing
    // its parent project on load (incl. a cold deep-link).
    const scopeIdNode = this.ctx.tree.at(['scope', 'projectId']);
    this.effect(() => {
      const pid = scopeIdNode.get<bigint | null>() ?? null;
      // The project screen-nav stays visible whenever a project is active —
      // which (post-#9) is on every route, since a project is always selected —
      // so the project's screen configuration is never lost from the rail. It's
      // hidden only before the first project resolves (cold boot) or on a cold
      // task deep-link before scope is published.
      const show = pid !== null;
      for (const el of this.scopeSectionEls) el.style.display = show ? '' : 'none';
    }, 'shell.scopeSection');

    /* --------------------------- interactions -------------------------- */
    this.listen(collapse, 'click', () => this.el.classList.toggle('shell--rail-collapsed'));
    this.listen(themeBtn, 'click', () => {
      const next = currentTheme() === HTML_THEME_DARK ? HTML_THEME_LIGHT : HTML_THEME_DARK;
      setTheme(next);
      setIcon(themeBtn, next === HTML_THEME_DARK ? 'sun' : 'moon');
    });
    this.listen(helpBtn, 'click', () => this.intent('toggleHelp'));
    this.listen(instructionsBtn, 'click', () => this.intent('toggleInstructions'));
    this.listen(scopePicker, 'change', () => {
      const id = parseId(scopePicker.value);
      // The scope picker is a project SWITCHER. STAY ON THE SAME SCREEN: if the
      // current route is a screen, carry its slug to the new project so a switch
      // doesn't snap you back to the board every time. The ScreenHost resolves
      // that slug's card in the new project; when the new project has NO such
      // screen it redirects to that project's default (first) screen rather than
      // erroring (see ScreenHost.onScreenResolved). Off a screen route (projects
      // list / admin / a task), land on the project's default board. The route
      // effect mirrors `scope.projectId` from the route, so the body's
      // `{ signal }` query refires.
      if (id === null) return;
      const route = this.ctx.tree.at([...ROUTER_PATH]).peek<RouteMatch>() ?? null;
      const slug = route !== null && route.name === 'screen' ? route.params['slug'] : undefined;
      navigate(slug !== undefined && slug !== '' ? screenUrl(id, slug) : `/project/${id.toString()}`);
      this.intent('projectChanged', { projectId: id });
    });

    /* --------------------------- nav intents --------------------------- */
    // Only GLOBAL routes have intent handlers here: 'goProjects' (the
    // all-projects list) and 'goActivity' (the active-project activity feed).
    // Per-screen navigation is purely DATA-DRIVEN — `loadScopeLinks` publishes
    // each project's screen cards into `shell.screenLinks`, and a rail click /
    // `g <hotkey>` chord calls `goScreenSlug(l.slug)` directly. There is no
    // `goInbox`/`goGrid`/`goKanban` intent (those used to hardcode a slug even
    // for projects whose screen cards didn't carry that hotkey).
    this.registerIntent('goProjects', () => navigate('/projects'));
    this.registerIntent('goActivity', () => navigate('/activity'));

    /* --------------------------- help overlay -------------------------- */
    // The `toggleHelp` intent (raised by the `?`/`Mod+/` chord AND the topbar
    // `?` button) was previously DEAD — nothing handled it. Mount a hidden
    // HelpOverlay into the shell root and toggle it here. Open/close is a pure
    // DOM toggle inside the control (no signal write), so it stays cascade-safe.
    const help = this.spawn(
      'HelpOverlay',
      { type: 'HelpOverlay', snapshot: cfg.helpSnapshot, topic: cfg.helpTopic } as ChildConfig,
      this.el,
    ) as HelpOverlay;
    // `?` / `Mod+/` + the `?` button → KEYBOARD SHORTCUTS only. The ⓘ button →
    // the screen's INSTRUCTIONS, then an <hr>, then the shortcuts. Two distinct
    // surfaces over the one overlay control.
    this.registerIntent('toggleHelp', () => help.toggle({ instructions: false }));
    this.registerIntent('toggleInstructions', () => help.toggle({ instructions: true }));

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
   * Build one collapsible admin sub-section (WORKSPACE / PROJECT) into the rail:
   * a disclosure heading + its links, recording the section's chrome + per-link
   * role gates for the visibility effect. The heading text doubles as the
   * `data-admin-section` / `data-admin-toggle` key ('workspace' | 'project').
   */
  /** Rebuild the DEFAULT-PROJECT rail links from a resolved screen list. Each
   *  link navigates to `/project/:id/screen/:slug` (live scope at click time). */
  private renderScopeLinks(links: ReadonlyArray<ScopeLink>): void {
    const host = this.scopeLinksHost;
    if (host === null) return;
    host.replaceChildren();
    for (const l of links) {
      const link = railLink(l.label, l.chord, () => this.goScreenSlug(l.slug));
      link.dataset.slug = l.slug;
      host.append(link);
    }
  }

  /** Navigate to a screen slug under the live project scope (rail link click). */
  private goScreenSlug(slug: string): void {
    const id = this.ctx.tree.at(['scope', 'projectId']).peek<bigint | null>();
    navigate(id == null ? '/projects' : screenUrl(id, slug));
  }

  /**
   * Global hotkeys = the static shell chords (config.hotkeys: `g p`, `g a`, `?`,
   * `n`, …) PLUS a DATA-DRIVEN `g <hotkey>` per screen card, so a screen's
   * `hotkey` attribute (e.g. an Archive screen's `a`) jumps to it via `g a`.
   * Read reactively from `shell.screenLinks` (published by loadScopeLinks), so
   * the binding set tracks the active project's screens; appended AFTER the
   * static chords so a screen's chord shadows a same-key global one (deriveBindings
   * keeps the last entry at a given depth). The HotkeyController's binding map is
   * a computed over this, so it recomputes when the screens load / the project
   * switches.
   */
  override hotkeys(): readonly HotkeyBinding[] {
    const base = this.config.hotkeys ?? [];
    const links = (this.ctx.tree.at(['shell', 'screenLinks']).get<ScopeLink[]>() ?? []) as ScopeLink[];
    const dynamic: HotkeyBinding[] = [];
    for (const l of links) {
      if (l.hotkey === undefined || l.hotkey === '') continue;
      dynamic.push({
        binding: `g ${l.hotkey}`,
        label: `Go to ${l.label}`,
        run: () => this.goScreenSlug(l.slug),
      });
    }
    return [...base, ...dynamic];
  }

  /**
   * Load the active project's `screen` cards and rebuild the rail's scope links
   * from them (sorted by `sort_order`, label = title, chord = `g <hotkey>`), so
   * a newly-created screen shows up in the nav. Reactive on `scope.projectId`;
   * a project with no screen cards keeps whatever's rendered (the fallback).
   */
  /* ----------------------- notification bell poll ---------------------- */

  /**
   * Start the new-received-comms poll once the current user resolves. The
   * baseline (newest "seen" received-comm activity id) persists per-user in
   * localStorage so unread survives reloads; first run on a device seeds it to
   * the current latest (so history isn't shown as new). Inert when the
   * comm.unseen_count spec isn't registered (test harnesses).
   */
  private startCommPoll(): void {
    const api = this.ctx.api;
    if (!api?.registry?.has({ endpoint: 'comm', action: 'unseen_count' })) return;
    this.effect(() => {
      const u = this.ctx.tree.at(['auth', 'user']).get<{ userId: bigint | null }>();
      const uid = u?.userId ?? null;
      if (uid === null || this.commPollStarted) return;
      this.commPollStarted = true;
      this.beginCommPoll(uid);
    });
  }

  private beginCommPoll(userId: bigint): void {
    this.commStorageKey = `kitp.comms.seen.${userId.toString()}`;
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(this.commStorageKey);
    } catch {
      stored = null;
    }
    if (stored !== null && /^\d+$/.test(stored)) {
      this.commSeenBaseline = BigInt(stored);
      this.pollComms(false);
    } else {
      // First run on this device — seed the baseline to the current latest so
      // pre-existing comms don't all show as "new".
      this.pollComms(true);
    }
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (this.isAlive()) this.pollComms(false);
    }, AppShell.COMM_POLL_MS);
    // Don't let the poll keep a process alive (lets node --test exit); no-op in
    // browsers where setInterval returns a number.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.commPollTimer = timer;
    this.onDestroy(() => {
      if (this.commPollTimer !== null) {
        clearInterval(this.commPollTimer);
        this.commPollTimer = null;
      }
    });
  }

  /** One unseen-count round-trip. seed=true adopts the response's latest as the
   *  baseline (badge cleared); otherwise the count drives the badge. */
  private pollComms(seed: boolean): void {
    const input: CommUnseenCountInput = {};
    if (!seed) input.sinceActivityId = this.commSeenBaseline;
    this.ctx.api.callByName(COMM_UNSEEN_COUNT_SPEC, input, (out) => {
      if (!this.isAlive()) return;
      const o = (out ?? {}) as CommUnseenCountOutput;
      this.commLatest = o.latestActivityId ?? 0n;
      if (seed) {
        this.commSeenBaseline = this.commLatest;
        this.persistBaseline();
        this.paintBell(0);
      } else {
        this.paintBell(o.unseenCount ?? 0);
      }
    });
  }

  /** Bell click target. PRECEDENCE:
   *    1. Operator-set workspace URL (`config.commsBellUrl`, env
   *       `KITP_COMMS_BELL_URL`) — workspace-configurable destination.
   *    2. The active project's Comms screen (slug 'comms') when defined.
   *    3. The global `/activity` feed.
   *  The bell counts across all projects, so this is a best-effort landing.
   */
  private goToCommsScreen(): void {
    const configured = this.ctx.tree.at([...COMMS_BELL_URL_PATH]).peek<string>() ?? '';
    if (configured !== '') {
      navigate(configured);
      return;
    }
    const pid = this.ctx.tree.at(['scope', 'projectId']).peek<bigint | null>() ?? null;
    if (pid !== null) {
      const links = this.ctx.tree.at(['shell', 'screenLinks']).peek<Array<{ slug: string }>>() ?? [];
      if (links.some((l) => l.slug === 'comms')) {
        navigate(screenUrl(pid, 'comms'));
        return;
      }
    }
    navigate('/activity');
  }

  /** Bell click — adopt the latest seen id, clear the badge, persist. */
  private markCommsSeen(): void {
    this.commSeenBaseline = this.commLatest;
    this.persistBaseline();
    this.paintBell(0);
  }

  private persistBaseline(): void {
    if (this.commStorageKey === null) return;
    try {
      localStorage.setItem(this.commStorageKey, this.commSeenBaseline.toString());
    } catch {
      // localStorage unavailable (private mode / tests) — the in-memory
      // baseline still works for the session.
    }
  }

  private paintBell(count: number): void {
    const badge = this.bellBadgeEl;
    const btn = this.bellBtn;
    if (badge === null || btn === null) return;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.style.display = '';
      btn.classList.add('iconbtn--alert');
      btn.title = `${count} new message${count === 1 ? '' : 's'} — view activity`;
      btn.setAttribute('aria-label', btn.title);
    } else {
      badge.textContent = '';
      badge.style.display = 'none';
      btn.classList.remove('iconbtn--alert');
      btn.title = 'No new messages';
      btn.setAttribute('aria-label', btn.title);
    }
  }

  private loadScopeLinks(): void {
    const scopeIdNode = this.ctx.tree.at(['scope', 'projectId']);
    this.effect(() => {
      const pid = scopeIdNode.get<bigint | null>() ?? null;
      // Also refire when the admin Screens screen bumps this nonce (a screen was
      // renamed / added / removed), so the nav reflects the edit without a reload.
      this.ctx.tree.at(['shell', 'navRefresh']).get();
      if (pid === null) return;
      this.ctx.api.callByName(
        'card.select_with_attributes',
        { cardTypeName: 'screen', parentCardId: pid, order: [{ field: 'attributes.sort_order', direction: 'ASC' }] },
        (out) => {
          if (!this.isAlive()) return;
          const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
          if (rows.length === 0) {
            // No screen cards for this project — render an empty rail (and
            // empty `screenLinks`) so a previous project's links don't linger
            // when switching to one that genuinely has none.
            this.renderScopeLinks([]);
            this.ctx.tree.at(['shell', 'screenLinks']).set([]);
            return;
          }
          // Sort by the `sort_order` attribute client-side (don't rely on the
          // server honouring the order hint); unsorted rows sink to the back.
          const ord = (r: CardWithAttrs): number => {
            const v = r.attributes['sort_order'];
            return typeof v === 'number' && Number.isFinite(v) ? v : Number.POSITIVE_INFINITY;
          };
          const links = rows
            .slice()
            .sort((a, b) => ord(a) - ord(b))
            .map((r): ScopeLink | null => {
              const slug = readSlug(r);
              if (slug === null) return null;
              const hk = r.attributes['hotkey'];
              const hotkey = typeof hk === 'string' ? hk : '';
              const chord = hotkey !== '' ? `g ${hotkey}` : '';
              return { slug, label: readTitle(r), chord, hotkey };
            })
            .filter((l): l is ScopeLink => l !== null);
          this.renderScopeLinks(links);
          // Publish for AppShell.hotkeys() so each screen's `hotkey` wires up
          // its `g <hotkey>` navigation chord (data-driven, project-specific).
          // An empty `links` array (no slugs at all) lands an empty rail —
          // matches the rows-empty branch above so a previous project's links
          // don't linger.
          this.ctx.tree.at(['shell', 'screenLinks']).set(links);
        },
        { alive: () => this.isAlive() },
      );
    }, 'shell.scopeLinks');
  }

  private buildAdminSection(
    rail: HTMLElement,
    label: string,
    links: ReadonlyArray<{ label: string; key: string; minRole?: 'admin' | 'manager' }>,
  ): void {
    const sectionKey = label.toLowerCase();
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'shell__section-toggle muted';
    toggle.dataset.adminSection = sectionKey;
    toggle.dataset.adminToggle = sectionKey;
    toggle.setAttribute('aria-expanded', 'false');
    const lbl = document.createElement('span');
    lbl.textContent = label;
    const caret = document.createElement('span');
    caret.className = 'shell__section-caret';
    caret.append(icon('chevron-right', 14));
    toggle.append(lbl, caret);

    const list = document.createElement('div');
    list.className = 'shell__admin-list shell__admin-list--collapsed';
    list.dataset.adminSection = sectionKey;
    list.dataset.adminList = sectionKey;

    const gates: Array<{ el: HTMLElement; minRole: 'admin' | 'manager' }> = [];
    for (const l of links) {
      const link = railLink(l.label, '', () => navigate(adminUrl(l.key)));
      link.dataset.adminKey = l.key;
      list.append(link);
      gates.push({ el: link, minRole: l.minRole ?? 'admin' });
    }

    rail.append(toggle, list);
    // Expand/collapse — a pure DOM toggle (no signal write), cascade-safe.
    this.listen(toggle, 'click', () => {
      const collapsed = list.classList.toggle('shell__admin-list--collapsed');
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      setIcon(caret, collapsed ? 'chevron-right' : 'chevron-down', 14);
    });
    this.adminSections.push({ chrome: [toggle, list], gates });
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
        // Do NOT clear scope here: a project is always active, so the all-
        // projects list still shows the active project in the header + rail nav
        // (the user switches via the header picker; this screen is for per-
        // project view/edit/import/export + creating projects).
        this.setCrumb('Projects');
        return this.spawn('ProjectList', { type: 'ProjectList' }, outlet);
      }
      case 'project': {
        // Bare `/project/:id` (no slug) = the project's DEFAULT board. There is
        // no hard-coded default screen: the ScreenHost's `defaultScreen` mode
        // loads the project's screen cards, picks the FIRST by sort_order, and
        // redirects to it (so the URL / presets / nav key off the real slug).
        this.setScope(parseId(route.params['id']));
        this.setCrumb('');
        const cfg: ChildConfig = {
          ...boardConfig,
          type: boardConfig.type,
          screen: { slug: '', layout: 'unknown' },
          defaultScreen: true,
          resolveScreen: false,
        };
        return this.spawn(cfg.type, cfg, outlet);
      }
      case 'screen': {
        const id = parseId(route.params['id']);
        this.setScope(id);
        // `/project/:id/screen/:slug`: the ScreenHost resolves the project's real
        // `screen` card by slug and dispatches its body off the card's `layout`
        // (no slug→layout seed — no slug is privileged; a neutral loading body
        // shows until it resolves). We do NOT carry the board's kanban bodyConfig.
        const slug = route.params['slug'] ?? 'kanban';
        const screen = { slug, layout: 'unknown', title: capitalise(slug) };
        const cfg: ChildConfig = {
          ...boardConfig,
          type: boardConfig.type,
          screen,
          resolveScreen: true,
        };
        this.setCrumb(screen.title);
        return this.spawn(cfg.type, cfg, outlet);
      }
      case 'task': {
        // The DEFAULT PROJECT screen-nav stays visible on the task detail: the
        // TaskDetail publishes the task's parent project into `scope.projectId`
        // once it loads, and the 'shell.scopeSection' effect reveals the section
        // reactively (works on a cold deep-link too, where no project was in
        // scope at route-render time).
        this.setCrumb(`Task #${route.params['id'] ?? ''}`);
        return this.spawn(
          'TaskDetail',
          { type: 'TaskDetail', taskId: route.params['id'] } as ChildConfig,
          outlet,
        );
      }
      case 'activity': {
        // The active-project activity feed. Reads `scope.projectId` (always
        // set), so scope is left intact — the rail nav stays on the project.
        this.setCrumb('Activity');
        return this.spawn('Activity', { type: 'Activity' } as ChildConfig, outlet);
      }
      case 'account': {
        // The signed-in user's read-only profile (rail user-menu → Account).
        this.setCrumb('Account');
        return this.spawn('AccountPage', { type: 'AccountPage' } as ChildConfig, outlet);
      }
      case 'agents': {
        // Per-user "My Agents" (rail user-menu → /agents): the owner-scoped
        // Agents control, reachable by any signed-in user. Resolved through the
        // same config seam via a fixed personal key, so the shell holds no
        // screen knowledge (mirrors the 'admin' case). Null (identity not yet
        // resolved) falls through to the NotFound placeholder.
        const myAgents = this.config.adminConfigFor?.('my_agents');
        if (myAgents) {
          this.setCrumb((myAgents as { title?: string }).title ?? 'My Agents');
          return this.spawn(myAgents.type, myAgents, outlet);
        }
        this.setCrumb('Not found');
        return this.spawn(
          `NoRoute:${route.path}`,
          { type: `NoRoute:${route.path}`, path: route.path } as ChildConfig,
          outlet,
        );
      }
      case 'admin': {
        // Resolve `/admin/:key` to a MasterDetail config via the boot resolver.
        // No admin-screen knowledge lives in the shell. An unknown key resolves
        // to a NotFound placeholder (graceful degradation).
        const key = route.params['key'] ?? '';
        const adminCfg = this.config.adminConfigFor?.(key) ?? { type: `UnknownAdmin:${key}` };
        this.setCrumb((adminCfg as { title?: string }).title ?? 'Admin');
        return this.spawn(adminCfg.type, adminCfg, outlet);
      }
      case 'notfound':
      default: {
        this.setCrumb('Not found');
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
    // Persist the active project so the next load restores it (the picker is
    // the normal switcher; there's no "all projects" scope to fall back to).
    if (id !== null) writeActiveProject(id.toString());
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
    case 'activity':
      return 'activity';
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

/** Icon buttons take an IconName; `{ text }` keeps letter-like glyphs (the
 *  `?` help button) as plain text. */
function iconButton(name: IconName | { text: string }, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'iconbtn';
  if (typeof name === 'string') b.append(icon(name));
  else b.textContent = name.text;
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
  writeStoredTheme(theme);
}

/** localStorage key for the user's chosen theme ('dark' | 'light'). */
const THEME_KEY = 'kitp.theme';

/** The persisted theme choice, or null when unset / blocked / invalid. */
function readStoredTheme(): string | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === HTML_THEME_DARK || v === HTML_THEME_LIGHT ? v : null;
  } catch {
    return null;
  }
}

/** Persist the chosen theme so the next load restores it. Best-effort. */
function writeStoredTheme(theme: string): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // no store (private mode / no DOM) — persistence is a nice-to-have.
  }
}

/**
 * Apply the persisted theme to `<html>` before the shell renders, so a user who
 * chose dark mode doesn't load into the light default. No stored choice leaves
 * the document's default (`data-theme="light"` in index.html) untouched. Called
 * once at boot, ahead of mounting (CSP forbids an inline pre-paint script, so a
 * single repaint on the deferred module is the best we can do). Idempotent.
 */
export function applyStoredTheme(): void {
  const stored = readStoredTheme();
  if (stored !== null) setTheme(stored);
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

/** localStorage key for the last-active project id (the always-active scope). */
const ACTIVE_PROJECT_KEY = 'kitp.activeProject';

/** The persisted last-active project id (digits only), or null. Guarded so a
 *  missing/blocked localStorage (private mode, no DOM) degrades to no-op. */
function readActiveProject(): string | null {
  try {
    const v = localStorage.getItem(ACTIVE_PROJECT_KEY);
    return v !== null && /^\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Persist the active project id so the next load restores it. Best-effort. */
function writeActiveProject(id: string): void {
  try {
    localStorage.setItem(ACTIVE_PROJECT_KEY, id);
  } catch {
    // no store (private mode / no DOM) — persistence is a nice-to-have.
  }
}

/**
 * Build the default global-tier hotkey chords as INTENT-raising bindings.
 * NO per-screen chords (Inbox / Grid / Kanban) live here — every screen's
 * `g <hotkey>` is derived from its own `hotkey` attribute by
 * `AppShell.hotkeys()` reading the data-driven `shell.screenLinks`. A project
 * with no screen carrying `hotkey='i'` therefore has NO `g i` chord; this used
 * to navigate to `inbox` regardless because of a hardcoded entry — removed.
 */
export function shellHotkeys(emit: (intent: string) => void): HotkeyBinding[] {
  return [
    { binding: 'g p', label: 'Go to Projects', run: () => emit('goProjects') },
    { binding: 'g a', label: 'Go to Activity', run: () => emit('goActivity') },
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
