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
 *   - outlet: a content region into which a child (ScreenHost) mounts.
 *
 * Hierarchical hotkeys (web/design/hotkeys.md): the shell declares global-tier
 * chords (`g p`, `g a`, `g i`, `g g`, `g k`, `?`) in its config.hotkeys, raised
 * as INTENTS — never imperative API calls. The HotkeyController derives the
 * active binding set from the live control tree; the shell is the root scope.
 *
 * The project-scope Picker writes `scope.projectId` into the shell's scope
 * object; the Kanban's `{ signal: 'scope.projectId' }` query trigger reloads on
 * change. (Scope lives on the DataHost.scope, resolved by `{ from: 'scope.…' }`.)
 *
 * No promises; the shell only mounts children, toggles theme, and raises intents.
 */

import { Control, type BaseControlConfig, type ChildConfig } from '../core/control.js';
import type { QueryBinding } from '../core/data.js';
import type { HotkeyBinding } from '../core/hotkeys.js';
import { formatBinding } from '../core/hotkeys.js';
import { TEMPLATE_EXCLUSION_LEAF } from '../projects/project-helpers.js';

/**
 * The outlet views the shell swaps between (signal-driven, no router). Beyond
 * the projects landing + the per-project board, the shell hosts ADMIN views —
 * each a `MasterDetail` screen identified by `admin:<key>` (e.g.
 * `admin:contacts`, `admin:users`). The view-swap effect maps an `admin:*`
 * view through `adminConfigFor` (a config resolver the boot wiring supplies) to
 * a MasterDetail config and mounts it — so adding an admin screen is a new
 * config entry + a rail link, never new control logic.
 */
export type ShellView = 'projects' | 'board' | `admin:${string}`;

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
  /** Admin links. Each `view` is the `admin:<key>` outlet view it navigates to. */
  adminLinks?: Array<{ label: string; view: string }>;
  /**
   * Resolve an `admin:<key>` view to a body control config (a MasterDetail
   * config). Supplied by the boot wiring (main.ts) so the shell stays free of
   * any admin-screen knowledge — adding an admin screen is a new entry in this
   * resolver + a rail link, no shell change. Returns null for an unknown key
   * (→ the view-swap mounts nothing / falls back).
   */
  adminConfigFor?: (key: string) => ChildConfig | null;
  /**
   * Initial outlet view. Default 'projects' (the all-projects landing). The
   * shell swaps the outlet between the ProjectList ('projects') and the board
   * ScreenHost ('board') via the `shell.view` tree signal — no full router.
   */
  view?: ShellView;
  /**
   * The board view's body config (a ScreenHost descriptor). Mounted lazily
   * into the outlet when `shell.view === 'board'`. When absent, the shell
   * falls back to the first declarative child (so existing `children`-based
   * wiring still works).
   */
  boardConfig?: ChildConfig;
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

    // ADMIN section. Each link navigates to its `admin:<key>` outlet view via
    // the same `shell.view` swap the rest of the rail uses — the proof that an
    // admin screen is config + a link, never new routing logic.
    const adminLinks = cfg.adminLinks ?? [
      { label: 'Contacts', view: 'admin:contacts' },
      { label: 'Users…', view: 'admin:users' },
    ];
    rail.append(sectionLabel('ADMIN'));
    for (const l of adminLinks) {
      const link = railLink(l.label, '', () => this.ctx.tree.at(['shell', 'view']).set(l.view));
      link.dataset.adminView = l.view;
      rail.append(link);
    }

    // User chip (rail foot).
    const chip = document.createElement('div');
    chip.className = 'shell__user-chip';
    const avatar = document.createElement('span');
    avatar.className = 'shell__avatar';
    avatar.textContent = '⊙';
    const name = document.createElement('span');
    name.className = 'shell__user-name';
    name.textContent = cfg.user ?? 'System';
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

    /* ----------------------- view-driven outlet swap ------------------ */
    // The outlet swaps between the ProjectList ('projects') and the board
    // ScreenHost ('board') based on the `shell.view` tree signal — a minimal
    // signal-driven swap, NOT a full router. The effect READS only
    // shell.view (and shell.crumb-derived nothing else) and IMPERATIVELY
    // spawns/destroys the body control; it never writes a signal it tracks,
    // so the one-way-load cascade rule holds.
    const viewNode = this.ctx.tree.at(['shell', 'view']);
    if (viewNode.peek<ShellView | null>() == null) {
      viewNode.set(cfg.view ?? 'projects');
    }
    // The board body config: explicit `boardConfig`, else the first
    // declarative child (back-compat with the existing children wiring).
    const boardConfig: ChildConfig =
      cfg.boardConfig ?? (cfg.children ?? [])[0] ?? { type: 'ScreenHost' };

    let bodyControl: Control | null = null;
    let currentView: ShellView | null = null;
    this.effect(() => {
      const view = (viewNode.get<ShellView>() ?? 'projects') as ShellView;
      if (view === currentView) return; // Object.is-style guard at the view level
      currentView = view;
      // Tear down the previous body before mounting the next.
      if (bodyControl) {
        this.destroyChild(bodyControl);
        bodyControl = null;
      }
      if (view === 'projects') {
        bodyControl = this.spawn('ProjectList', { type: 'ProjectList' }, outlet);
        this.setCrumb('Projects', true);
      } else if (view.startsWith('admin:')) {
        // ADMIN view: resolve the `admin:<key>` to a MasterDetail config and
        // mount it. No admin-screen knowledge lives in the shell — the boot
        // wiring's `adminConfigFor` resolver owns the config. An unknown key
        // resolves to a NotFound placeholder (graceful degradation).
        const key = view.slice('admin:'.length);
        const adminCfg = cfg.adminConfigFor?.(key) ?? { type: `UnknownAdmin:${key}` };
        bodyControl = this.spawn(adminCfg.type, adminCfg, outlet);
        const crumb = (adminCfg as { title?: string }).title ?? 'Admin';
        this.setCrumb(crumb, true);
      } else {
        bodyControl = this.spawn(boardConfig.type, boardConfig, outlet);
        this.setCrumb(cfg.crumb ?? 'Kanban', false);
      }
    }, 'shell.view-swap');

    /* --------------------------- interactions -------------------------- */
    this.listen(collapse, 'click', () => this.el.classList.toggle('shell--rail-collapsed'));
    this.listen(themeBtn, 'click', () => {
      const next = currentTheme() === HTML_THEME_DARK ? HTML_THEME_LIGHT : HTML_THEME_DARK;
      setTheme(next);
      themeBtn.textContent = next === HTML_THEME_DARK ? '☀' : '☾';
    });
    this.listen(helpBtn, 'click', () => this.intent('toggleHelp'));
    this.listen(scopePicker, 'change', () => {
      this.scope.projectId = parseId(scopePicker.value);
      // Mirror into the tree so a `{ signal: 'scope.projectId' }` trigger that
      // (in a later wiring) reads a tree path also fires. We keep the canonical
      // scope on the scope object; the tree write is a one-way mirror.
      this.ctx.tree.at(['scope', 'projectId']).set(this.scope.projectId);
      this.intent('projectChanged', { projectId: this.scope.projectId });
    });

    /* --------------------------- nav intents --------------------------- */
    // Rail links + global `g _` chords raise these intents; the shell maps
    // them to the `shell.view` signal (the outlet swap). 'goProjects' lands
    // the all-projects view; the per-project screen chords land the board.
    // All are one-way tree writes outside any tracked effect (cascade-safe).
    const goView = (view: ShellView): void => {
      this.ctx.tree.at(['shell', 'view']).set(view);
    };
    this.registerIntent('goProjects', () => goView('projects'));
    this.registerIntent('goInbox', () => goView('board'));
    this.registerIntent('goGrid', () => goView('board'));
    this.registerIntent('goKanban', () => goView('board'));
    this.registerIntent('goProject', () => goView('board'));
  }

  /** Mount a body child into the outlet imperatively (used by boot wiring). */
  mountIntoOutlet(type: string, config: ChildConfig): Control {
    const outlet = this.el.querySelector<HTMLElement>('.shell__outlet');
    const host = outlet ?? this.el;
    return this.spawn(type, config, host);
  }
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
  ];
}

/** Re-export so callers can format a binding for a help overlay. */
export { formatBinding };

export function registerAppShell(): void {
  Control.register('AppShell', AppShell);
}
