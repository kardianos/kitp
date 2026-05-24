/**
 * Boot entry — the first REAL screen vertical slice.
 *
 * Assembles AppShell → ScreenHost(kanban) → Kanban entirely from a declarative
 * config tree via `Control.New`, driven by the declarative ZERO-PROMISE data
 * layer. Replaces the old `proof` demo wiring while KEEPING the load-bearing
 * NotFound behaviour demonstrably working: the kanban screen config declares a
 * child of an UNREGISTERED type (`SparkleChart`) which renders the visible
 * NotFound placeholder rather than crashing the page.
 *
 * Data wiring (all declarative, addressed by spec key):
 *   - card.select_with_attributes → tasks for the in-scope project (Kanban
 *     static query, refires on scope.projectId).
 *   - card.select               → the axis value-cards (milestones).
 *   - attribute.update          → the optimistic move (Kanban static action,
 *     intent 'moveTask').
 *
 * Backend mode: register the specs against the REAL /api/v1/batch wire, but
 * keep USE_REAL_BACKEND=false so automated verification runs against the mock
 * transport seeded with REALISTIC canned responses (one project, 6 tasks across
 * 3 milestones + unset, shaped exactly like the real handlers — bigint ids as
 * strings, attributes object). Flip USE_REAL_BACKEND=true to hit live kitpd.
 *
 * NO promises, no `.then`, no `await` anywhere in this file or any control. The
 * framework owns the async; everything here is pre-registered callbacks +
 * intents.
 */

import { signal } from './core/signal.js';
import { tree } from './core/tree.js';
import { Dispatcher, fetchTransport, type ApiFault, type Transport } from './core/dispatch.js';
import { Api } from './core/api.js';
import { Control, type ControlContext } from './core/control.js';
import './core/not-found.js'; // side effect: installs the NotFound factory path
import { HotkeyController, activeControlSignal } from './core/hotkeys.js';
import { registerKanbanSpecs } from './kanban/specs.js';
import { registerKanbanControls } from './kanban/kanban.js';
import { registerGridCardRefAttrs } from './grid/specs.js';
import { registerGrid } from './grid/grid.js';
import { registerTagChip } from './grid/tag-chip.js';
import { registerScreenFilterBar } from './shell/screen-filter-bar.js';
import { registerScreenHost } from './shell/screen-host.js';
import { registerAppShell, shellHotkeys, type AppShell } from './shell/app-shell.js';
import { registerProjectList } from './projects/project-list.js';
import { registerProjectSpecs } from './projects/specs.js';
import { registerMasterDetail, type MasterDetailConfig } from './admin/master-detail.js';
import { registerAdminSpecs } from './admin/specs.js';
import { adminScreenConfig, ADMIN_VIEWS, type AdminView } from './admin/screens.js';
import { registerPredicateFilter } from './filter/predicate-filter.js';
import { registerFilterSpecs } from './filter/specs.js';

/** Rail-link labels for each admin view key (the rail is derived from these). */
const ADMIN_LINK_LABELS: Record<AdminView, string> = {
  contacts: 'Contacts',
  users: 'Users',
  projects: 'Projects',
  screens: 'Screens',
  filters: 'Named Filters',
  attributes: 'Attributes',
  workflows: 'Workflows',
  roles: 'Roles',
  agents: 'Agents',
  comm_channels: 'Comm Channels',
  activity_sinks: 'Activity Sinks',
  comm_log: 'Comm Log',
};
import { mockTransport } from './kanban/mock-data.js';

/** Flip to true to hit the live kitpd at /api/v1/batch (cookie-auth, SSO). */
const USE_REAL_BACKEND = true;

/**
 * SSO-ONLY auth: the SPA renders NO login screen. On an auth failure the only
 * public surface is a full-page bounce to this start endpoint. See
 * ARCHITECTURE.md §12 for the server contract this client assumes.
 */
const SSO_START_PATH = '/api/v1/auth/oidc/start';

function boot(): void {
  const transport: Transport = USE_REAL_BACKEND ? fetchTransport('') : mockTransport();
  const dispatcher = new Dispatcher({ transport });
  const api = new Api(dispatcher);

  // ---- Centralized fault funnel (registered ONCE at boot) ----
  // This is the TOP-LEVEL handler `onError: 'top'` bindings rely on. Faults
  // surface as a minimal, unobtrusive fixed-corner toast (auto-dismiss +
  // dismissible) — NOT a full toast system, just the single funnel sink.
  const faultToast = createFaultToast();
  const showFault = (fault: ApiFault): void => {
    const msg = describeFault(fault);
    // eslint-disable-next-line no-console
    console.warn('[fault]', msg);
    faultToast.show(msg);
  };
  dispatcher.onFault('network', showFault);
  dispatcher.onFault('http', showFault);
  dispatcher.onFault('decode', showFault);
  dispatcher.onFault('sub_error', showFault);
  dispatcher.onFault('aborted', showFault);

  // ---- SSO-ONLY auth bounce: a 401 (or auth 403) bounces the whole page ----
  dispatcher.onFault('http', (f) => {
    if (f.status === 401 || f.status === 403) bounceToSso();
  });

  // ---- Register the REAL API specs (declared up front, by endpoint.action) ----
  registerKanbanSpecs(api);
  registerProjectSpecs(api);
  // Admin (Users) specs. Contacts reuse the kanban card.select_with_attributes
  // + attribute.update specs, so only the non-card user.* reads are new.
  registerAdminSpecs(api);
  // The PredicateFilter sources its `{ cardType }` schema from
  // attribute_def.select — idempotent: skips if registerAdminSpecs already
  // defined it. Safe to call after registerAdminSpecs.
  registerFilterSpecs(api);
  // The Grid reuses the shared card.select_with_attributes spec; this only
  // primes the extra card_ref attrs it keys on (assignee/status/component_ref/
  // tags) so their ids revive to bigint. Must run AFTER registerKanbanSpecs.
  registerGridCardRefAttrs();

  // ---- Register the real screen controls ----
  registerAppShell();
  registerScreenHost();
  registerScreenFilterBar();
  registerKanbanControls();
  registerTagChip();
  registerGrid();
  registerProjectList();
  // The reusable structured filter editor. Hosted by ScreenFilterBar (task
  // screens) + MasterDetail (card-backed admin screens); idempotent register.
  registerPredicateFilter();
  // The ONE reusable admin search-list-detail control. Contacts + Users are
  // each just a config object passed to it (admin/screens.ts) — no per-screen
  // control code.
  registerMasterDetail();

  // ---- Shared project scope ----
  // The Kanban's `{ from: 'scope.projectId' }` reads this object (peek at fire
  // time) and its `{ signal: 'scope.projectId' }` trigger watches the TREE path
  // 'scope.projectId'. The AppShell's live `projects` query (card.select_with_
  // attributes) lands the real projects, default-selects one, and writes the
  // tree leaf — which refires the board's scoped queries. We seed the leaf null
  // so the canonical scope is the tree path the picker drives.
  tree.at(['scope', 'projectId']).set(null);
  const scope: Record<string, unknown> = {
    get projectId(): bigint | null {
      return tree.at(['scope', 'projectId']).peek<bigint | null>() ?? null;
    },
  };

  // ---- A tiny intent bus: the AppShell raises nav/help intents ----
  let shell: AppShell | null = null;
  const bus = {
    emit(type: string, detail?: unknown): void {
      shell?.intent(type, detail);
    },
  };

  const ctx: ControlContext = { api, tree, bus, scope };

  // ---- The whole UI as ONE declarative config tree ----
  // AppShell (root scope, global hotkeys). The outlet LANDS on the all-projects
  // ProjectList (view 'projects'); selecting a project (or a `g k`/`g i`/`g g`
  // chord) flips `shell.view` to 'board' and the outlet swaps to the
  // ScreenHost(kanban) → Kanban below. The board config also declares an
  // UNKNOWN child type to prove NotFound graceful degradation still works.
  const appConfig = {
    type: 'AppShell' as const,
    brand: 'kitp',
    crumb: 'Kanban',
    // Land on the all-projects list; the scope picker drives `scope.projectId`
    // and the board view reads it.
    view: 'projects' as const,
    // The Picker options load live from the backend (AppShell `projects` query);
    // this static seed is just the placeholder shown for the instant before the
    // query lands. `defaultProjectLabel` picks which loaded project becomes the
    // initial scope (the demo project that has tasks + milestones).
    projects: [{ id: '', label: 'Loading projects…' }],
    defaultProjectLabel: 'Default Project',
    user: 'System',
    // ADMIN rail links → `admin:<key>` outlet views. The resolver below maps a
    // key to the MasterDetail config; the shell mounts it via the same view
    // swap the board uses. Adding an admin screen = a link + a config entry +
    // an `adminScreenConfig` case (the case lives in admin/screens.ts). Every
    // link is derived from the canonical `ADMIN_VIEWS` list so the rail + the
    // resolver can never drift.
    adminLinks: ADMIN_VIEWS.map((v) => ({ label: ADMIN_LINK_LABELS[v], view: `admin:${v}` })),
    // The resolver guards on the known view set so an unknown `admin:<key>`
    // returns null → the AppShell renders its NotFound placeholder (preserved).
    adminConfigFor: (key: string): MasterDetailConfig | null =>
      (ADMIN_VIEWS as string[]).includes(key) ? adminScreenConfig(key as AdminView) : null,
    // Global-tier hotkeys raised as intents (derived, hierarchical).
    hotkeys: shellHotkeys((intent) => bus.emit(intent)),
    // The board view's body, mounted lazily when shell.view === 'board'.
    boardConfig: {
      type: 'ScreenHost',
      target: 'outlet',
      screen: {
        slug: 'kanban',
        layout: 'kanban',
        title: 'Kanban',
        bodyConfig: { type: 'Kanban' },
      },
      // The kanban screen also declares an UNKNOWN child type so the
      // NotFound placeholder renders (graceful degradation, never throws).
      children: [
        { type: 'SparkleChart', seriesPath: 'analytics.sparkline', smoothing: 0.4 },
      ],
    },
  };

  const root = Control.New('AppShell', appConfig, ctx);
  const mountEl = document.getElementById('root');
  if (!mountEl) throw new Error('#root missing');
  root.mount(mountEl);
  shell = root as AppShell;

  // ---- Hierarchical hotkeys: derive from the live control tree ----
  const rootSig = signal<Control | null>(root, 'root-control');
  const activeSig = activeControlSignal(root);
  const hotkeys = new HotkeyController({ root: rootSig, active: activeSig });
  hotkeys.start();

  function bounceToSso(): void {
    const redirect = encodeURIComponent(location.pathname + location.search);
    location.assign(`${SSO_START_PATH}?redirect=${redirect}`);
  }

  // eslint-disable-next-line no-console
  console.info(
    'kitp web booted: AppShell → ScreenHost(kanban) → Kanban. Tasks + milestones ' +
      'load on mount; drag a card between columns for an optimistic move. The ' +
      "kanban screen's unknown 'SparkleChart' child renders a NotFound placeholder.",
  );
}

function describeFault(f: ApiFault): string {
  switch (f.kind) {
    case 'sub_error':
      return `sub_error[${f.code}]: ${f.message}`;
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

/**
 * The single fault-surface element: a minimal fixed-corner toast the
 * centralized funnel routes every fault to. Deliberately NOT a full toast
 * stack — one reused element, auto-dismissed after a few seconds and
 * dismissible via its × button. Styled by `.fault-toast*` in styles.css.
 */
interface FaultToast {
  show(message: string): void;
}
function createFaultToast(): FaultToast {
  if (typeof document === 'undefined') {
    return { show() {} };
  }
  const el = document.createElement('div');
  el.className = 'fault-toast';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');

  const dot = document.createElement('span');
  dot.className = 'fault-toast__dot';
  dot.setAttribute('aria-hidden', 'true');

  const msg = document.createElement('span');
  msg.className = 'fault-toast__msg';

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'fault-toast__close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';

  el.append(dot, msg, close);
  document.body.append(el);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const hide = (): void => {
    el.classList.remove('fault-toast--show');
  };
  close.addEventListener('click', () => {
    if (timer !== undefined) clearTimeout(timer);
    hide();
  });

  return {
    show(message: string): void {
      msg.textContent = message;
      msg.title = message;
      el.classList.add('fault-toast--show');
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(hide, 6000);
    },
  };
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}
