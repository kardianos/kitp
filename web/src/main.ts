/**
 * Boot entry — the first REAL screen vertical slice.
 *
 * Assembles AppShell → ScreenHost(kanban) → Kanban entirely from a declarative
 * config tree via `Control.New`, driven by the declarative ZERO-PROMISE data
 * layer. The load-bearing NotFound graceful-degradation guarantee (an unknown
 * control type renders a visible placeholder rather than crashing) is covered
 * by the control-registry tests + genuine unknown-layout handling in ScreenHost.
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
import { loadAuthUser, peekCurrentUserId } from './auth/auth-state.js';
import { Dispatcher, fetchTransport, type ApiFault, type Transport } from './core/dispatch.js';
import { Api } from './core/api.js';
import { Control, controlForNode, type ControlContext, type ChildConfig } from './core/control.js';
import './core/not-found.js'; // side effect: installs the NotFound factory path
import './util/markdown-control.js'; // side effect: registers the Markdown control + sink
import './editor/install.js'; // side effect: upgrades RichEditor to the ProseMirror engine
import { HotkeyController, activeControlSignal } from './core/hotkeys.js';
import { registerKanbanSpecs } from './kanban/specs.js';
import { registerKanbanControls } from './kanban/kanban.js';
import { registerGridCardRefAttrs, registerGridBulkSpecs } from './grid/specs.js';
import { registerGrid } from './grid/grid.js';
import { registerGridColumns } from './grid/grid-columns.js';
import { registerBulkActionBar } from './grid/bulk-action-bar.js';
import { registerTagChip } from './grid/tag-chip.js';
import { registerInbox } from './inbox/inbox.js';
import { registerCommsList } from './comms/comms-list.js';
import { registerInboxViewToggles } from './inbox/inbox-view-toggles.js';
import { registerInboxSpecs } from './inbox/specs.js';
import { registerScreenFilterBar } from './shell/screen-filter-bar.js';
import { registerScreenHost } from './shell/screen-host.js';
import { registerAppShell, shellHotkeys, applyStoredTheme, type AppShell } from './shell/app-shell.js';
import { installRouter, peekRoute, helpTopicForRoute } from './shell/router.js';
import { registerHelpOverlay, type HotkeySnapshot } from './shell/help-overlay.js';
import { registerHelpSpecs } from './shell/help-specs.js';
import { registerConfigSpecs, loadServerConfig } from './shell/config-specs.js';
import { registerProjectList } from './projects/project-list.js';
import { registerProjectSpecs } from './projects/specs.js';
import { registerProjectLayout } from './project-detail/project-layout.js';
import { registerProjectPropertiesPanel } from './project-detail/project-properties-panel.js';
import { registerMasterDetail } from './admin/master-detail.js';
import { registerNestedEditor } from './admin/nested-editor.js';
import { registerEnumManager } from './admin/enum-manager.js';
import { registerPeopleManager } from './admin/people-manager.js';
import { registerSchedulerJobs } from './admin/scheduler-jobs.js';
import { registerRecordForm } from './admin/record-form.js';
import { registerAdminSpecs } from './admin/specs.js';
import { adminScreenConfig, ownAgentsScreen, ADMIN_VIEWS, MANAGER_ADMIN_VIEWS, ADMIN_SECTION, type AdminView } from './admin/screens.js';
import { registerPredicateFilter } from './filter/predicate-filter.js';
import { registerQuickChips } from './filter/quick-chips.js';
import { registerNamedFilters } from './filter/named-filters.js';
import { registerFilterSpecs } from './filter/specs.js';
import { registerFilterPresetSelector } from './filter/filter-preset-selector.js';
import { registerFilterCardSpecs } from './filter/filter-card-specs.js';
import { registerCombobox } from './ui/combobox.js';
import { registerDatePicker } from './ui/datepicker.js';
import { registerRefPicker } from './ui/ref-picker.js';
import { registerFieldEditor } from './ui/field-editor.js';
import { registerCardRefValue } from './ui/card-ref-value.js';
import { registerAttributeRow } from './ui/attribute-row.js';
import { registerTaskAttributePanel } from './task-detail/task-attribute-panel.js';
import { registerNewTaskForm } from './task-detail/new-task-form.js';
import { registerBatchTaskEditor } from './task-detail/batch-task-editor.js';
import { registerCardSearchSpec } from './ui/specs.js';
import { registerTaskDetail } from './task-detail/task-detail.js';
import { registerTransitionBar } from './task-detail/transition-bar.js';
import { registerTransitionSpecs } from './task-detail/specs.js';
import { registerTaskComments } from './task-detail/task-comments.js';
import { registerCommentSpecs } from './task-detail/comment-specs.js';
import { registerCommThreads } from './task-detail/task-comm-threads.js';
import { registerCommThreadSpecs } from './task-detail/comm-specs.js';
import { registerAttachmentSpecs } from './task-detail/attachment-specs.js';
import { registerAttachmentsSection } from './task-detail/attachments-section.js';
import { registerTagsEditor } from './task-detail/tags-editor.js';
import { registerRelatedTasksPanel } from './task-detail/related-tasks-panel.js';
import { registerQuickEntry } from './quick-entry/quick-entry.js';
import { registerNewTaskButton } from './quick-entry/new-task-button.js';
import { registerImportWizard } from './import/import-wizard.js';
import { registerImportSpecs } from './import/specs.js';
import { registerExportMenu } from './export/export-menu.js';
import { registerActivity } from './activity/activity.js';
import { registerAccountPage } from './shell/account-page.js';

/** Rail-link labels for each admin view key (the rail is derived from these). */
const ADMIN_LINK_LABELS: Record<AdminView, string> = {
  people: 'People',
  agents: 'Agents',
  screens: 'Screens',
  attributes: 'Attributes',
  enums: 'Values',
  workflows: 'Workflows',
  roles: 'Roles',
  oidc_claims: 'OIDC Claims',
  comm_channels: 'Comm Channels',
  activity_sinks: 'Activity Sinks',
  comm_log: 'Comm Log',
  jobs: 'Background Jobs',
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

/**
 * Dev sign-in mint. The server registers this route ONLY when AUTH_MODE=off
 * (`session.HTTPConfig.DevLoginEnabled`); in OIDC mode it 404s. On a 401 the
 * client POSTs here first — a 200 means a System session cookie was set (dev),
 * a 404 means we're in OIDC mode and should bounce to SSO instead. This keeps
 * the recovery self-configuring with no build-time env flag.
 */
const DEV_LOGIN_PATH = '/api/v1/auth/dev-login';
/** sessionStorage guard key: "dev-login was already tried this tab session". */
const AUTH_RECOVERY_KEY = 'kitp.devLoginTried';

function boot(): void {
  // Restore the user's saved theme before anything mounts, so a dark-mode user
  // doesn't load into the light default (CSP forbids a pre-paint inline script).
  applyStoredTheme();

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
  // 'aborted' covers genuine problems (a missing subresponse) AND the noisy
  // "batch aborted by sibling sub-request" — the latter is emitted for every
  // OTHER sub-request when one fails (the offender's real error rides a separate
  // sub_error fault). Because the single reused toast is last-wins, the sibling
  // noise was masking the real cause. Log it, but don't toast it over the offender.
  dispatcher.onFault('aborted', (f) => {
    if (f.reason === 'batch aborted by sibling sub-request') {
      // eslint-disable-next-line no-console
      console.warn('[fault]', describeFault(f));
      return;
    }
    showFault(f);
  });

  // ---- Auth recovery (401) / SSO bounce (403) ----
  // 401 = no/expired session: try to recover (dev-login in AUTH_MODE=off,
  // else bounce). 403 = authenticated but forbidden: re-authing as the same
  // user can't fix it, so bounce straight to SSO (unchanged behaviour).
  dispatcher.onFault('http', (f) => {
    if (f.status === 401) recoverAuthOrBounce();
    else if (f.status === 403) bounceToSso();
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
  // The COMMS (email-thread) surface on task detail: comm.list_for_task /
  // comm.create / comm.set_recipients / reply.post. Idempotent-by-presence;
  // registered before the TaskDetail mounts its CommThreads control.
  registerCommThreadSpecs(api);
  // Server-driven contextual help (help.get_topic / help.get_screen) the `?`
  // overlay renders above the keybinding cheatsheet. Idempotent-by-presence.
  registerHelpSpecs(api);
  // config.get — the operator-set workspace title (header brand + tab title) +
  // attachment caps. loadServerConfig (below, after the router installs) lands
  // the title; idempotent-by-presence.
  registerConfigSpecs(api);
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
  // The Grid's "Columns" chooser — mounted on the filter bar's View row
  // (viewActions seam) rather than an in-body toolbar.
  registerGridColumns();
  // The Grid's selection-driven bulk-action bar (assign / move / purge); the
  // Grid spawns it as a child below the table.
  registerBulkActionBar();
  // The Inbox (list layout body). ScreenHost maps `list` → 'Inbox'; registering
  // it makes a `list` screen resolve here instead of the NotFound placeholder.
  registerInbox();
  // The Inbox's "Mine only" / "Routed to me" view toggles — mounted on the
  // filter bar's View row (viewActions seam) rather than the Inbox body.
  registerInboxViewToggles();
  // The `comms` layout body: lists comm cards filtered by comm_status phase.
  registerCommsList();
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
  // The data-driven "Values" (Enums) admin screen (#3): edits the value-cards
  // for every `enum_managed` attribute (milestone / component / tag) in the
  // active project. Not a MasterDetail — its own control.
  registerEnumManager();
  // The unified "People" admin screen (#11): one list of every person with
  // Users / Assignees / Contacts segment toggles + promote/demote (replaces the
  // separate Contacts + Users screens). Its own control, not a MasterDetail.
  registerPeopleManager();
  // The workspace "Background Jobs" admin screen: lists the server's hard-coded
  // scheduler jobs + a per-job "Run now". Its own control, not a MasterDetail.
  registerSchedulerJobs();
  // The generic config-driven record editor mounted in a MasterDetail detail
  // pane (Comm Channels today). Replaces per-screen bespoke config editors.
  registerRecordForm();
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
  // The unified attribute editor (ARCHITECTURE.md §13 / FieldEditor): one control that
  // routes to RefPicker / DatePicker / native input by attr.valueType.
  // Replaces the per-screen 6-arm switches in TaskDetail / BulkActionBar /
  // grid inline-edit so a new attribute type is one switch arm here, not
  // three drifts across screens.
  registerFieldEditor();
  // The single-id ref-label render (ARCHITECTURE.md §13 / CardRefValue): replaces the
  // per-screen `map[id] ?? '#id'` reimplementations. Consumed by
  // AttributeRow's summary and any other surface rendering a resolved ref.
  registerCardRefValue();
  // The unified attribute row (ARCHITECTURE.md §13 / AttributeRow): label + reactive
  // summary + lazy-mounted FieldEditor + Unassign + inline error.  Replaces
  // TaskDetail's renderRow + buildUnassignButton + the per-row event wiring.
  registerAttributeRow();
  // The single-task panel (live-commit policy).  Owns the schema iteration
  // + per-row wiring.  Composed by TaskDetail.  Sister high-level controls
  // for the deferred-commit (NewTaskForm) and fan-out (BatchTaskEditor)
  // policies live alongside and use the same AttributeRow primitive.
  registerTaskAttributePanel();
  // The deferred-commit form (Save / Save & Another / Save & Open).  Owns
  // the draft store + the submit button row.  Composed by QuickEntry's
  // modal (or any other "create a new task" surface).
  registerNewTaskForm();
  // The fan-out batch editor (Mixed-aware, applies to N selected).  Owns
  // the selection-header line + the row list.  Composed by BulkActionBar.
  registerBatchTaskEditor();
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
  // The COMMS (email-thread) control the TaskDetail spawns into its `comms`
  // slot: list comms, start-comm form (channel + recipients + message), per-comm
  // recipients editor + reply composer. Reuses card.search (RefPicker) + the
  // comm-thread specs registered above.
  registerCommThreads();
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
  // The visible "+ New" button on the Grid + List filter bars (raises the same
  // quickCreateOpen intent as the `n` hotkey, mounted via viewActionsForLayout).
  registerNewTaskButton();
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
  // The standalone `/activity` screen (#1): the active project's reverse-chron
  // activity feed, reusing the task-detail row phrasing + card_ref label
  // resolution. The rail "Activity" link / `g a` chord navigates here.
  registerActivity();
  // The read-only Account profile (rail user-menu → Account, route /account).
  registerAccountPage();

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
  // The current route body (ScreenHost / TaskDetail / …) and the deepest active
  // control WITHIN it. The help overlay snapshots this scope so its shortcut
  // list reflects the screen — not the topbar chrome the user clicked to open
  // it (which would otherwise make the shell the live active control).
  let routeBody: Control | null = null;
  let screenActive: Control | null = null;
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
  // navigate()s and the outlet effect re-derives.
  const appConfig = {
    type: 'AppShell' as const,
    // No static brand: the header shows the operator-set WORKSPACE TITLE that
    // loadServerConfig (config.get) lands at `config.workspaceTitle`, falling
    // back to the neutral 'Workspace' — 'kitp' is never displayed.
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
    adminLinks: ADMIN_VIEWS.map((v) => ({
      label: ADMIN_LINK_LABELS[v],
      key: v,
      // Managers reach the project-scoped manager screens (Manage values); the
      // rest stay admin-only. Same source the router guard consults.
      minRole: MANAGER_ADMIN_VIEWS.has(v) ? ('manager' as const) : ('admin' as const),
      // Rail section: 'workspace' (global) vs 'project' (active-project-scoped).
      section: ADMIN_SECTION[v],
    })),
    // The resolver guards on the known view set so an unknown `/admin/:key`
    // returns null → the AppShell renders its NotFound placeholder (preserved).
    adminConfigFor: (key: string): ChildConfig | null => {
      // The per-user "My Agents" screen (rail user-menu → /agents) resolves
      // through the SAME seam under a fixed personal key, so the shell keeps no
      // screen knowledge. It's owner-scoped to the signed-in user (read here at
      // resolve time); null id (unresolved identity) → NotFound placeholder.
      if (key === 'my_agents') {
        const myId = peekCurrentUserId(tree);
        return myId === null ? null : (ownAgentsScreen(myId) as unknown as ChildConfig);
      }
      return (ADMIN_VIEWS as string[]).includes(key) ? (adminScreenConfig(key as AdminView) as ChildConfig) : null;
    },
    // Global-tier hotkeys raised as intents (derived, hierarchical).
    hotkeys: shellHotkeys((intent) => bus.emit(intent)),
    // The HelpOverlay (`?`) renders the LIVE binding set. The HotkeyController
    // is created after the shell mounts, so thread a closure over it; it reads
    // the controller lazily at open() time (always reflects the active scope).
    helpSnapshot: (): HotkeySnapshot => hotkeys?.snapshotFor(screenActive) ?? new Map(),
    // The contextual help TOPIC for the overlay's prose section, derived from
    // the live route (task_detail / admin.<key> / layout.<layout>). The task +
    // project routes used to fall through to null — so the task detail showed
    // keybindings with NO authored prose even though `task_detail` help exists.
    helpTopic: (): string | null => {
      // screen / project routes: the topic is `layout.<layout>`, where the
      // layout is resolved from the active screen's card (no slug→layout map).
      // The ScreenHost publishes it to `screen.layout`; read it here so a custom
      // screen gets its layout's help too. Other routes use the static mapping.
      const route = peekRoute(tree);
      if (route.name === 'screen' || route.name === 'project') {
        const layout = tree.at(['screen', 'layout']).peek<string>() ?? '';
        return layout !== '' && layout !== 'unknown' ? `layout.${layout}` : null;
      }
      return helpTopicForRoute(route);
    },
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
    // screen slug.
    boardConfig: {
      type: 'ScreenHost',
      screen: { slug: 'kanban', layout: 'kanban', title: 'Kanban' },
    },
  };

  // ---- Install the History-API router: lands the deep-link route from the
  // live URL + wires popstate (back/forward). Must run BEFORE the shell mounts
  // so the outlet effect's first read sees the right route. ----
  installRouter(tree, { managerAdminKeys: MANAGER_ADMIN_VIEWS });

  // ---- Current-user identity: probe /api/v1/auth/me and land `auth.user` ----
  // A boot service fetch (callback form, like the transport) — no promise in the
  // control surface. The role-aware UI (router requireAdmin, the ADMIN rail,
  // Inbox mine_only/routed/delegate, comment author-gating) reads `auth.user`
  // reactively; this writes it ONCE. A 401/403 at /auth/me (or authenticated:
  // false) routes to the SAME `bounceToSso` redirect the batch funnel uses, so
  // the two 401 paths coincide. Kicked off before the shell mounts so the
  // identity is usually present on the first render; the reactive reads handle
  // the (brief) interval before it lands.
  loadAuthUser(tree, {
    onUnauthorized: () => recoverAuthOrBounce(),
    // A successful probe clears the recovery guard so a LATER mid-session
    // expiry can dev-login again (the guard only suppresses a same-session loop).
    onAuthed: () => clearAuthRecoveryGuard(),
  });

  // ---- Workspace title: probe config.get and land `config.workspaceTitle` ----
  // A boot service fetch (callback form, like loadAuthUser). The AppShell brand
  // reads the tree leaf reactively; this also sets the browser tab title. An
  // empty/absent value falls back to the neutral 'Workspace' (never 'kitp').
  loadServerConfig(api, tree);

  const root = Control.New('AppShell', appConfig, ctx);
  const mountEl = document.getElementById('root');
  if (!mountEl) throw new Error('#root missing');
  shell = root as AppShell;

  // ---- Hierarchical hotkeys: derive from the live control tree ----
  // The ACTIVE control is what makes a screen's scoped hotkeys live (the
  // TaskDetail's `e t`/`e d`, the Kanban's `j`/`k`, …). It tracks FOCUS: when
  // focus enters an element, the owning control (deepest registered root at or
  // above it) becomes active, so its + its ancestors' chords are collected.
  // Without this the signal sat on the AppShell forever and only the global
  // `g _`/`n`/`?` chords ever fired.
  //
  // ALL of this is wired BEFORE `root.mount()` so the very first route's body
  // (a deep-link / reload straight to `/task/:id`) becomes the active scope as
  // it mounts — otherwise its chords wouldn't be live until the next click.
  const rootSig = signal<Control | null>(root, 'root-control');
  const activeSig = activeControlSignal(root);
  // The current screen body (route control). Its WHOLE subtree's hotkeys stay
  // in scope regardless of focus, so clicking the sidebar / search box never
  // drops the screen's keys. Set in onBodyMount below.
  const screenSig = signal<Control | null>(null, 'hotkeys.screen');
  hotkeys = new HotkeyController({ root: rootSig, active: activeSig, screen: screenSig });
  const isWithin = (c: Control | null, ancestor: Control | null): boolean => {
    for (let x = c; x; x = x.parent) if (x === ancestor) return true;
    return false;
  };
  const trackActive = (node: EventTarget | null): void => {
    const c = controlForNode(node as Node | null) ?? root;
    activeSig.set(c);
    // Remember the deepest active control INSIDE the current route body so the
    // help overlay's shortcut list reflects the SCREEN even after the user
    // clicks the topbar chrome (which makes the shell the live active control).
    if (routeBody && isWithin(c, routeBody)) screenActive = c;
  };
  document.addEventListener('focusin', (e) => trackActive(e.target));
  // Clicks on non-focusable regions (a card body, the detail title row) don't
  // emit focusin — track pointerdown too so interacting with a screen activates
  // its chords even before anything inside takes focus.
  document.addEventListener('pointerdown', (e) => trackActive(e.target), true);
  // Baseline: when the route body (re)mounts, make it active so its chords work
  // immediately on navigation — before any click. The TaskDetail IS the body, so
  // `e t`/`e d`/`e c`/`e p` are live the moment the task screen opens; the help
  // overlay's snapshot also seeds to this body.
  shell.onBodyMount = (body) => {
    routeBody = body;
    screenActive = body;
    activeSig.set(body);
    screenSig.set(body); // its whole subtree's hotkeys are now in scope page-wide
  };

  // Mount AFTER the hotkey wiring so the initial route body's onBodyMount lands.
  root.mount(mountEl);
  hotkeys.start();

  function bounceToSso(): void {
    const redirect = encodeURIComponent(location.pathname + location.search);
    location.assign(`${SSO_START_PATH}?redirect=${redirect}`);
  }

  // In-memory latch: coordinates the boot probe + the batch funnel when BOTH
  // observe the unauthenticated session in the same load. Only the first caller
  // drives recovery; the rest are no-ops (a reload or bounce is already coming).
  let recoveryInFlight = false;

  /**
   * Recover an unauthenticated (401) session, else bounce to SSO. In dev
   * (AUTH_MODE=off) POST {@link DEV_LOGIN_PATH} mints a System session cookie →
   * reload signed in; in OIDC mode that route 404s → fall through to
   * {@link bounceToSso}. The sessionStorage guard breaks a
   * reload→401→dev-login→reload loop if the minted session still fails; it is
   * cleared by `onAuthed` on the next successful probe.
   */
  function recoverAuthOrBounce(): void {
    if (recoveryInFlight) return;
    recoveryInFlight = true;
    let triedBefore = false;
    try {
      triedBefore = sessionStorage.getItem(AUTH_RECOVERY_KEY) !== null;
    } catch {
      // sessionStorage unavailable (private mode / no DOM) — skip the guard.
    }
    if (triedBefore) {
      bounceToSso();
      return;
    }
    void (async () => {
      try {
        const r = await fetch(DEV_LOGIN_PATH, { method: 'POST', credentials: 'same-origin' });
        if (r.ok) {
          try {
            sessionStorage.setItem(AUTH_RECOVERY_KEY, '1');
          } catch {
            // best-effort guard; a missing store just means no loop protection.
          }
          location.reload();
          return;
        }
      } catch {
        // network error → fall through to the bounce below.
      }
      // 404 (OIDC mode, route not registered) or any failure → SSO bounce.
      bounceToSso();
    })();
  }

  /** Clear the dev-login recovery guard after a successful authenticated probe. */
  function clearAuthRecoveryGuard(): void {
    try {
      sessionStorage.removeItem(AUTH_RECOVERY_KEY);
    } catch {
      // no store → nothing to clear.
    }
  }
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
