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
import { loadAuthUser } from './auth/auth-state.js';
import { Dispatcher, fetchTransport, type ApiFault, type Transport } from './core/dispatch.js';
import { Api } from './core/api.js';
import { Control, type ControlContext } from './core/control.js';
import './core/not-found.js'; // side effect: installs the NotFound factory path
import './util/markdown-control.js'; // side effect: registers the Markdown control + sink
import { HotkeyController, activeControlSignal } from './core/hotkeys.js';
import { registerKanbanSpecs } from './kanban/specs.js';
import { registerKanbanControls } from './kanban/kanban.js';
import { registerGridCardRefAttrs, registerGridBulkSpecs } from './grid/specs.js';
import { registerGrid } from './grid/grid.js';
import { registerBulkActionBar } from './grid/bulk-action-bar.js';
import { registerTagChip } from './grid/tag-chip.js';
import { registerInbox } from './inbox/inbox.js';
import { registerInboxSpecs } from './inbox/specs.js';
import { registerScreenFilterBar } from './shell/screen-filter-bar.js';
import { registerScreenHost } from './shell/screen-host.js';
import { registerAppShell, shellHotkeys, type AppShell } from './shell/app-shell.js';
import { installRouter } from './shell/router.js';
import { registerHelpOverlay, type HotkeySnapshot } from './shell/help-overlay.js';
import { registerProjectList } from './projects/project-list.js';
import { registerProjectSpecs } from './projects/specs.js';
import { registerProjectLayout } from './project-detail/project-layout.js';
import { registerProjectPropertiesPanel } from './project-detail/project-properties-panel.js';
import { registerMasterDetail, type MasterDetailConfig } from './admin/master-detail.js';
import { registerNestedEditor } from './admin/nested-editor.js';
import { registerAdminSpecs } from './admin/specs.js';
import { adminScreenConfig, ADMIN_VIEWS, type AdminView } from './admin/screens.js';
import { registerPredicateFilter } from './filter/predicate-filter.js';
import { registerQuickChips } from './filter/quick-chips.js';
import { registerNamedFilters } from './filter/named-filters.js';
import { registerFilterSpecs } from './filter/specs.js';
import { registerFilterPresetSelector } from './filter/filter-preset-selector.js';
import { registerFilterCardSpecs } from './filter/filter-card-specs.js';
import { registerCombobox } from './ui/combobox.js';
import { registerDatePicker } from './ui/datepicker.js';
import { registerRefPicker } from './ui/ref-picker.js';
import { registerCardSearchSpec } from './ui/specs.js';
import { registerTaskDetail } from './task-detail/task-detail.js';
import { registerTransitionBar } from './task-detail/transition-bar.js';
import { registerTransitionSpecs } from './task-detail/specs.js';
import { registerTaskComments } from './task-detail/task-comments.js';
import { registerCommentSpecs } from './task-detail/comment-specs.js';
import { registerAttachmentSpecs } from './task-detail/attachment-specs.js';
import { registerAttachmentsSection } from './task-detail/attachments-section.js';
import { registerTagsEditor } from './task-detail/tags-editor.js';
import { registerRelatedTasksPanel } from './task-detail/related-tasks-panel.js';
import { registerQuickEntry } from './quick-entry/quick-entry.js';
import { registerImportWizard } from './import/import-wizard.js';
import { registerImportSpecs } from './import/specs.js';
import { registerExportMenu } from './export/export-menu.js';

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
  // Inbox write specs: user_card_sort.set (manual reorder) + user_card_agent.
  // set/clear (delegate-to-agent). The Inbox's read reuses the kanban
  // card.select_with_attributes spec with the with_personal_sort / routed_to_me
  // flags. Must run before the Inbox control mounts.
  registerInboxSpecs(api);
  // Admin (Users) specs. Contacts reuse the kanban card.select_with_attributes
  // + attribute.update specs, so only the non-card user.* reads are new.
  registerAdminSpecs(api);
  // The PredicateFilter sources its `{ cardType }` schema from
  // attribute_def.select — idempotent: skips if registerAdminSpecs already
  // defined it. Safe to call after registerAdminSpecs.
  registerFilterSpecs(api);
  // The saved-filter Delete action's `card.delete` spec (load/save/set-default/
  // rename reuse already-registered specs). Idempotent-by-presence.
  registerFilterCardSpecs(api);
  // The Grid reuses the shared card.select_with_attributes spec; this only
  // primes the extra card_ref attrs it keys on (assignee/status/component_ref/
  // tags) so their ids revive to bigint. Must run AFTER registerKanbanSpecs.
  registerGridCardRefAttrs();
  // The Grid's bulk-action bar fans `task.move` / `task.purge` out across the
  // selected card set (one batch). Register the two write specs once at boot.
  registerGridBulkSpecs(api);
  // The card.search spec backs every card_ref editor (RefPicker single+multi):
  // a typeahead/id lookup over one card_type, returning { id, title } rows.
  // Idempotent-by-presence; registered before any RefPicker mounts.
  registerCardSearchSpec(api);
  // The TransitionBar (#34) reads `flow_step.list_for_card` for the focal
  // task's available workflow transitions. Idempotent-by-presence; registered
  // before the TaskDetail mounts the bar.
  registerTransitionSpecs(api);
  // The #35 comments + activity feed reads `activity.select` and writes
  // `comment.insert` / `comment.update`. Idempotent-by-presence; registered
  // before the TaskDetail mounts its TaskComments control. The feed's actor
  // labels reuse the already-registered `user.select` (registerAdminSpecs).
  registerCommentSpecs(api);
  // The #36 attachments control reads `attachment.list`, writes `file.create` /
  // `attachment.create` / `attachment.delete` + `cas.missing_chunks` (the upload
  // pipeline); the tags editor writes `tag.apply` / `tag.remove`. Also primes the
  // `parent_task` / `tags` card_ref attrs so their values revive to bigint.
  // Idempotent-by-presence; registered before the TaskDetail mounts its #36 slots.
  registerAttachmentSpecs(api);
  // The #41 CSV import wizard reads/writes `project.import.upload` /
  // `.set_mapping` / `.preview` / `.commit`; the CSV reaches the server by file
  // id, so it reuses the already-registered `file.create` / `cas.missing_chunks`
  // CAS pipeline (registerAttachmentSpecs, above) for the upload. Idempotent-by-
  // presence; registered before the AppShell mounts the wizard.
  registerImportSpecs(api);

  // ---- Register the real screen controls ----
  registerAppShell();
  // The keyboard-shortcuts (`?`) overlay the AppShell mounts to handle the
  // (formerly dead) `toggleHelp` intent.
  registerHelpOverlay();
  registerScreenHost();
  registerScreenFilterBar();
  registerKanbanControls();
  registerTagChip();
  registerGrid();
  // The Grid's selection-driven bulk-action bar (assign / move / purge); the
  // Grid spawns it as a child below the table.
  registerBulkActionBar();
  // The Inbox (list layout body). ScreenHost maps `list` → 'Inbox'; registering
  // it makes a `list` screen resolve here instead of the NotFound placeholder.
  registerInbox();
  registerProjectList();
  // The `project` layout body: the Project detail / overview. ScreenHost maps
  // `project` → 'Project'; registering it makes a screen card with
  // layout:'project' (or a deep-link whose fallback layout is `project`)
  // resolve here instead of the NotFound placeholder. Header (title + markdown
  // description + Edit/+New/Export/Import actions), per-project screen nav, and
  // the project-scoped task collection (reads the shared ScreenFilterBar leaves).
  registerProjectLayout();
  // Its slide-over properties editor (title/description + project-bound
  // attribute editors → attribute.update, optimistic), spawned by the layout's
  // "Edit properties" action / `e` hotkey.
  registerProjectPropertiesPanel();
  // The reusable structured filter editor. Hosted by ScreenFilterBar (task
  // screens) + MasterDetail (card-backed admin screens); idempotent register.
  registerPredicateFilter();
  // The pinned per-attribute quick-filter chips row the ScreenFilterBar mounts
  // (Status / Assignee / Milestone / Component / Tags). Each chip toggles a
  // top-level `attr in [...]` leaf in the SAME 'screen.predicate' tree the
  // Advanced editor + named filters edit; idempotent register.
  registerQuickChips();
  // The "Named" multi-select the ScreenFilterBar mounts in the chips row —
  // toggles reusable predicate-fragment leaves (`snippet` op → predicate_snippet
  // cards) on the SAME 'screen.predicate' tree; the server expands the snippet
  // id leaf + cycle-guards. Idempotent register.
  registerNamedFilters();
  // The saved-view picker the ScreenFilterBar mounts in row 1 (lists the
  // screen's `filter` cards; picking one applies its predicate + group).
  registerFilterPresetSelector();
  // The ONE reusable admin search-list-detail control. Contacts + Users are
  // each just a config object passed to it (admin/screens.ts) — no per-screen
  // control code.
  registerMasterDetail();
  // The richer nested-collection editors the card-backed admin detail panes
  // spawn: flow-step transitions (Workflows), the edge bind/unbind matrix
  // (Attributes), and the screen filter-card manager (Screens).
  registerNestedEditor();
  // The reusable anchored-UI primitives. Combobox (typeahead select) +
  // DatePicker compose the shared Popover helper (the one floating-ui impl).
  // Consumed by the upcoming ref-pickers, quick filters, and attribute editors;
  // registered here so they're available as declarative control types.
  registerCombobox();
  registerDatePicker();
  // The card_ref attribute editor (single + multi). A thin shell over Combobox
  // whose async loader fires card.search; the editor every card_ref attribute
  // (assignee/status/milestone/component/tags/recipients/parent_task) mounts.
  registerRefPicker();
  // The /task/:id detail screen shell (#33): two-column layout, title +
  // description inline edit, and the attribute side panel (inline edit by
  // value_type — RefPicker for card_refs, DatePicker for dates). Registers
  // the `TaskDetail` control the AppShell spawns for the `task` route; leaves
  // named slots for #34 (TransitionBar) / #35 (comments+activity) / #36
  // (attachments+tags+related).
  registerTaskDetail();
  // The #34 TransitionBar the TaskDetail spawns into its `transitions` slot:
  // the canonical status changer (bucketed transitions + V13 rejection banner).
  registerTransitionBar();
  // The #35 TaskComments the TaskDetail spawns into its `comments` slot (and
  // which paints the activity feed into the `activity` slot): the comment
  // composer + per-comment author-gated edit + the per-kind activity stream.
  registerTaskComments();
  // The #36 trio the TaskDetail spawns into its right-rail slots:
  //   - AttachmentsSection (`attachments`): drag-drop upload (SHA-256 chunk →
  //     cas.missing_chunks → raw POST /cas/chunk → file.create + attachment.create)
  //     + list / download / soft-delete / thumbnails + an inline image/pdf gallery.
  //   - TagsEditor (`tags`): applied-tag chips (tag.remove) + an add-combobox
  //     over the project's tag cards (tag.apply), optimistic.
  //   - RelatedTasksPanel (`related`): parent chip + relationship dropdown +
  //     set/clear parent (RefPicker over tasks) + the children list, all via
  //     attribute.update(parent_task, parent_relationship), optimistic.
  registerAttachmentsSection();
  registerTagsEditor();
  registerRelatedTasksPanel();
  // The global quick-entry overlay (the `n` fast-task-create flow). The AppShell
  // mounts ONE instance and wires the `quickCreateOpen` intent to it; the `n`
  // hotkey (global + per task screen) + the kanban column `+` / project "+ New
  // task" affordances raise that intent. Reuses card.insert / tag.apply /
  // attachment.create / card.delete (all registered above) — no new specs.
  registerQuickEntry();
  // The #41 CSV import wizard. The AppShell mounts ONE instance and wires the
  // `projectImport` intent to open() (raised by the Project detail's Import hook
  // with `{ projectId }`); on a successful commit it raises `projectImportDone`,
  // which the shell turns into a bump of the shared `import.refreshNonce` leaf so
  // the focal project body reloads its tasks. Reuses the CAS file pipeline +
  // project.import.* specs (registered above) — no new controls beyond the wizard.
  registerImportWizard();

  // The project-export menu (#42): a Popover-anchored dropdown the AppShell
  // mounts once + wires to the `projectExport` intent (raised by the Project
  // detail's Export hook). Format (CSV / xlsx / ZIP) + toggles build a
  // same-origin projectexport GET URL; the menu triggers the browser download.
  registerExportMenu();

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
  // Forward-declared so the appConfig's `helpSnapshot` closure can read the
  // controller that is constructed (below) only after the shell mounts.
  let hotkeys: HotkeyController | null = null;
  const bus = {
    emit(type: string, detail?: unknown): void {
      shell?.intent(type, detail);
    },
  };

  const ctx: ControlContext = { api, tree, bus, scope };

  // ---- The whole UI as ONE declarative config tree ----
  // AppShell (root scope, global hotkeys). The outlet derives from the
  // History-API ROUTER's route leaf (installed below): `/projects` lands the
  // all-projects ProjectList; `/project/:id[/screen/:slug]` lands the
  // ScreenHost → Kanban/Grid/… below; `/admin/:key` lands a MasterDetail.
  // Selecting a project (or a `g k`/`g i`/`g g` chord, or back/forward)
  // navigate()s and the outlet effect re-derives. The board config also
  // declares an UNKNOWN child type to prove NotFound graceful degradation.
  const appConfig = {
    type: 'AppShell' as const,
    brand: 'kitp',
    crumb: 'Kanban',
    // The Picker options load live from the backend (AppShell `projects` query);
    // this static seed is just the placeholder shown for the instant before the
    // query lands. `defaultProjectLabel` picks which loaded project becomes the
    // initial scope (the demo project that has tasks + milestones).
    projects: [{ id: '', label: 'Loading projects…' }],
    defaultProjectLabel: 'Default Project',
    user: 'System',
    // ADMIN rail links → `/admin/:key` routes. The resolver below maps a key to
    // the MasterDetail config; the shell mounts it from the route. Adding an
    // admin screen = a link + a config entry + an `adminScreenConfig` case (the
    // case lives in admin/screens.ts). Every link is derived from the canonical
    // `ADMIN_VIEWS` list so the rail + the resolver can never drift.
    adminLinks: ADMIN_VIEWS.map((v) => ({ label: ADMIN_LINK_LABELS[v], key: v })),
    // The resolver guards on the known view set so an unknown `/admin/:key`
    // returns null → the AppShell renders its NotFound placeholder (preserved).
    adminConfigFor: (key: string): MasterDetailConfig | null =>
      (ADMIN_VIEWS as string[]).includes(key) ? adminScreenConfig(key as AdminView) : null,
    // Global-tier hotkeys raised as intents (derived, hierarchical).
    hotkeys: shellHotkeys((intent) => bus.emit(intent)),
    // The HelpOverlay (`?`) renders the LIVE binding set. The HotkeyController
    // is created after the shell mounts, so thread a closure over it; it reads
    // the controller lazily at open() time (always reflects the active scope).
    helpSnapshot: (): HotkeySnapshot => hotkeys?.snapshot() ?? new Map(),
    // The global quick-entry overlay. The AppShell mounts it once + wires the
    // `quickCreateOpen` intent; its static query loads the in-scope project's
    // status cards (with phase) so the default-create-status chain resolves a
    // triage/active fallback. Scoped to the current project (scope.projectId).
    quickEntryConfig: {
      type: 'QuickEntry',
      defaultCardType: 'task',
      projectScopePath: 'scope.projectId',
      assigneeCardType: 'user',
      tagCardType: 'tag',
    },
    // The CSV import wizard. The AppShell mounts it once + wires the
    // `projectImport` intent (raised by the Project detail's Import hook with
    // `{ projectId }`) to open it scoped to that project. On commit it raises
    // `projectImportDone` → the shell bumps `import.refreshNonce` so the project
    // body reloads its tasks.
    importWizardConfig: {
      type: 'ImportWizard',
    },
    // The project-export menu. The AppShell mounts it once + wires the
    // `projectExport` intent (raised by the Project detail's Export hook with
    // `{ projectId, anchor, predicate? }`) to open it anchored to the Export
    // button. Choosing a format + toggles triggers a same-origin download.
    exportMenuConfig: {
      type: 'ExportMenu',
    },
    // The board / per-project screen body. The shell injects the route-derived
    // `screen.{slug,layout}` so the SAME ScreenHost descriptor serves every
    // screen slug; only the NON-screen fields (the UNKNOWN child type proving
    // NotFound degradation) carry over.
    boardConfig: {
      type: 'ScreenHost',
      screen: { slug: 'kanban', layout: 'kanban', title: 'Kanban' },
      // The kanban screen also declares an UNKNOWN child type so the
      // NotFound placeholder renders (graceful degradation, never throws).
      children: [
        { type: 'SparkleChart', seriesPath: 'analytics.sparkline', smoothing: 0.4 },
      ],
    },
  };

  // ---- Install the History-API router: lands the deep-link route from the
  // live URL + wires popstate (back/forward). Must run BEFORE the shell mounts
  // so the outlet effect's first read sees the right route. ----
  installRouter(tree);

  // ---- Current-user identity: probe /api/v1/auth/me and land `auth.user` ----
  // A boot service fetch (callback form, like the transport) — no promise in the
  // control surface. The role-aware UI (router requireAdmin, the ADMIN rail,
  // Inbox mine_only/routed/delegate, comment author-gating) reads `auth.user`
  // reactively; this writes it ONCE. A 401/403 at /auth/me (or authenticated:
  // false) routes to the SAME `bounceToSso` redirect the batch funnel uses, so
  // the two 401 paths coincide. Kicked off before the shell mounts so the
  // identity is usually present on the first render; the reactive reads handle
  // the (brief) interval before it lands.
  loadAuthUser(tree, { onUnauthorized: () => bounceToSso() });

  const root = Control.New('AppShell', appConfig, ctx);
  const mountEl = document.getElementById('root');
  if (!mountEl) throw new Error('#root missing');
  root.mount(mountEl);
  shell = root as AppShell;

  // ---- Hierarchical hotkeys: derive from the live control tree ----
  const rootSig = signal<Control | null>(root, 'root-control');
  const activeSig = activeControlSignal(root);
  hotkeys = new HotkeyController({ root: rootSig, active: activeSig });
  hotkeys.start();

  function bounceToSso(): void {
    const redirect = encodeURIComponent(location.pathname + location.search);
    location.assign(`${SSO_START_PATH}?redirect=${redirect}`);
  }

  // eslint-disable-next-line no-console
  console.info(
    'kitp web booted: History-API router → AppShell outlet. The route is the ' +
      'source of truth (deep-links, back/forward); `/project/:id/screen/:slug` ' +
      'drives the ScreenHost layout. Drag a card between columns for an ' +
      "optimistic move; the kanban screen's unknown 'SparkleChart' child renders " +
      'a NotFound placeholder.',
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
