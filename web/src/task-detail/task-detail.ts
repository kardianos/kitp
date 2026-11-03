/**
 * TaskDetail — the `/task/:id` screen shell (part 1 of 4).
 *
 * Registered for the `task` route (the AppShell spawns `{ type: 'TaskDetail',
 * taskId }` for `/task/:id`). Ports the SHELL of the Svelte client's
 * `TaskDetailScreen.svelte` + its `AttributeSidePanel.svelte`:
 *
 *   - two-column layout (main + ~320px right rail), collapsing to one column
 *     under 700px (CSS media query);
 *   - title inline edit → `attribute.update` (title), Enter/blur commit, Esc
 *     cancel, optimistic;
 *   - description rendered via `renderMarkdown` (the single sanitized sink),
 *     edit mode = textarea → `attribute.update` (description), Mod+Enter commit;
 *   - the ATTRIBUTE SIDE PANEL: one row per editable attribute (from the task
 *     card_type's `attribute_def.select` schema), showing a read summary and a
 *     click-to-edit inline editor chosen BY value_type:
 *       text / number → <input>          (draft → commit on blur/Enter)
 *       date           → DatePicker        (eager commit on change)
 *       bool           → checkbox          (eager)
 *       card_ref        → RefPicker single  (eager; assignee/status/milestone/…)
 *       card_ref[]      → RefPicker multi   (eager; generic multi for non-tag refs)
 *     Each commit fires `attribute.update` optimistically (the loaded task's
 *     attribute is patched immediately; a fault rolls it back AND surfaces the
 *     error inline on the row, with the central funnel showing the toast too).
 *
 * The remaining three task-detail features ship in later tasks; this control
 * leaves OBVIOUS, EMPTY, named slots for them so they drop in mechanically:
 *   - #34 TransitionBar      → `[data-slot="transitions"]` (main, under title)
 *   - #35 comments+activity  → `[data-slot="comments"]` + `[data-slot="activity"]`
 *   - #36 attachments+tags+related → `[data-slot="attachments"]` / `"tags"` /
 *                                    `"related"` (right rail, under attributes)
 *
 * Status is shown in the panel as a plain card_ref editor with a note that the
 * editable TransitionBar (#34) replaces it.
 *
 * Data flow (ZERO-PROMISE, like the RefPicker): the by-id task load and the
 * `attribute_def.select` schema load go through `api.callByName(spec, input,
 * onOk, { alive })`; lookup loads (status/assignee/milestone/component person
 * labels) likewise. NO promise crosses the control boundary; every onOk is
 * gated by `isAlive()` so a destroyed screen never delivers. A missing task
 * resolves to the inline NotFound-style "Task not found" state (the route's
 * NotFound fallback is preserved at the router level for an unmatched path).
 *
 * Reference (NOT imported): `client/src/screens/TaskDetailScreen.svelte` +
 * `client/src/ui/widgets/AttributeSidePanel.svelte`.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { PanelModel } from './panel-model.js';
import { setMarkdown } from '../util/markdown-control.js';
import { RichEditor } from '../editor/rich-editor.js';
import { navigate, taskUrl, projectUrl, cardUrl, type CardRoute } from '../shell/router.js';
import { taskNavNeighbor, taskNavListUrl } from '../shell/task-nav.js';
import { SPEC, type SelectWithAttributesOutput, type AttributeUpdateOutput } from '../kanban/specs.js';
import { asAttrId, type CardWithAttrs } from '../kanban/kanban-helpers.js';
import { CARD_SEARCH_SPEC } from '../ui/specs.js';
import { ADMIN_SPEC, type AttributeDefListOutput } from '../admin/specs.js';
import {
  schemaForCardType,
  type AttrSchema,
} from '../filter/attribute-schema.js';
import type { RefPinnedOption } from '../ui/ref-picker.js';
import { peekCurrentPersonId, isAdmin, hasRole } from '../auth/auth-state.js';
import { Popover } from '../ui/popover.js';
import { GRID_SPEC } from '../grid/specs.js';
import type { TransitionBar } from './transition-bar.js';
import type { TaskComments } from './task-comments.js';
import type { CommThreads } from './task-comm-threads.js';
import type { TaskLinks } from './task-links.js';
import type { TaskApprovals } from './task-approvals.js';
import {
  ACTIVITY_POLL_SPEC,
  type ActivityPollInput,
  type ActivityPollOutput,
} from './comment-specs.js';
import type { AttachmentsSection } from './attachments-section.js';
import type { WatchBar } from '../watch/watch-bar.js';
import type { TagsEditor } from './tags-editor.js';
import type { RelatedTasksPanel } from './related-tasks-panel.js';
import type { PostChunk } from './upload.js';
import {
  detailProfile,
  enclosingProjectId,
  siblingLinkTargets,
  pictureSnippets,
  SECTION_AREA,
  SECTION_NEEDS_AREA_ON,
  type DetailMenuAction,
  type DetailProfile,
  type DetailSection,
} from './detail-profiles.js';
import type { PagePublications } from '../pages/page-publications.js';
import type { PageStructure } from '../pages/page-structure.js';
import { icon } from '../ui/icons.js';
import { placeholderIssues, placeholderSnippets } from '../bundles/placeholders.js';
import { AREA_SPEC, type AreaListOutput } from '../bundles/specs.js';

import { applyStatusGlyphs, type StatusInfo } from '../ui/status-icon.js';
import { peekWorkflowStatusIds } from '../ui/workflow-statuses.js';
/* -------------------------------------------------------------------------- */
/* Config + declaration-merged registry type.                                 */
/* -------------------------------------------------------------------------- */

export interface TaskDetailConfig extends BaseControlConfig {
  type: 'TaskDetail';
  /** The route's `:id` param (string). Parsed to a bigint task id. */
  taskId?: string;
  /** The card's card_type name (drives the attribute schema and, through
   *  DETAIL_PROFILES, the noun / status attr / sections). Default 'task'. */
  cardTypeName?: string;
  /**
   * OPTIONAL override for the signed-in user's id (string), threaded down to the
   * #35 comments control to gate the per-comment edit affordance to the author.
   * When absent, TaskComments reads the identity from `auth.user` (the boot
   * /api/v1/auth/me probe) directly — so the AppShell need not thread it. Tests
   * / a host that wants to pin an identity can still pass it.
   */
  currentUserId?: string;
  /**
   * OPTIONAL override for the signed-in user's PERSON card id, used to offer a
   * "Self" quick-pick when editing a person-typed card_ref (assignee /
   * originator). When absent, read from `auth.user` (the boot /auth/me probe).
   * Tests pin it here to avoid standing up the auth tree.
   */
  currentPersonId?: bigint;
  /**
   * Inject the raw chunk-POST sink for the #36 AttachmentsSection upload service
   * (tests pass a mock). Production leaves it unset → the service uses a
   * same-origin fetch to `/api/v1/cas/chunk`.
   */
  postChunk?: PostChunk;
  /**
   * Inject the blob fetcher the #36 AttachmentsSection uses for thumbnails /
   * inline views / downloads (tests pass a mock so jsdom issues no real GETs).
   * Defaults to a same-origin fetch.
   */
  fetchBlob?: (url: string, onDone: (b: Blob) => void, onError: (e: Error) => void) => void;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    TaskDetail: TaskDetailConfig;
  }
}

/**
 * Built-in attributes the panel does NOT render as generic rows:
 *   - title / description have dedicated editors in the main column;
 *   - tags is owned by the #36 tags editor (the panel shows a generic multi for
 *     OTHER card_ref[] attrs, but defers the dedicated tags UI);
 *   - sort_order is reorder-only UI (kanban/inbox), never edited here;
 *   - parent_task / parent_relationship are owned by #36's related-tasks panel.
 * Mirrors the Svelte screen's `schema` derivation skip-list.
 */
const PANEL_SKIP_ATTRS = new Set([
  'title',
  'description',
  'tags',
  'sort_order',
  'parent_task',
  'parent_relationship',
  // System-managed + shown in the dedicated Comms section below — not a
  // user-pickable ref, so it shouldn't render as a (raw-id) RefPicker row.
  'comms',
  // Status changes flow through the TransitionBar (#34), which restricts the
  // picker to the card's CURRENTLY-AVAILABLE transitions. A free RefPicker row
  // in the panel let you assign any status (including ones the flow forbids)
  // — bypassing the workflow gate. Skip the row entirely; the header's
  // TransitionBar is the canonical assigner.
  'status',
]);

/** A card_ref attribute whose target card_type is NOT project-scoped. */
const GLOBAL_REF_CARD_TYPES = new Set(['person']);

/* -------------------------------------------------------------------------- */
/* Control.                                                                   */
/* -------------------------------------------------------------------------- */

export class TaskDetail extends Control<TaskDetailConfig> {
  private readonly taskId: bigint | null;
  private readonly cardTypeName: string;
  /** Per-card-type configuration (detail-profiles.ts): noun, status attr,
   *  which sections mount, panel skip/show tweaks. */
  private readonly profile: DetailProfile;
  /** The card's project (its parent, or — for a nested page — the first
   *  ancestor that isn't a card of its own type). Set when the card loads. */
  private projectId: bigint | undefined;
  /** Every loaded card of this type (the detail load reads them all): the
   *  description's Link bar picks siblings from them (profile.linkSiblings). */
  private sameTypeRows: SelectWithAttributesOutput['rows'] = [];

  /** The loaded focal task, or null (loading / not found).  Kept for the
   *  callsites that still need the raw card (parent_card_id, redirect-on-
   *  comm logic, etc.); the attribute-level state lives in {@link panel}. */
  private task: CardWithAttrs | null = null;
  /** The task card_type's editable attribute schema. */
  private schema: AttrSchema[] = [];
  /** card_ref label cache held for callers (RefPicker seed labels, etc.) —
   *  the lookup signals live on {@link panel.refLabel} but a few read sites
   *  still want a synchronous lookup, so we mirror landed labels here. */
  private readonly refLabels = new Map<string, string>();
  /**
   * The typed signal store backing the attribute panel.  Replaces the prior
   * ad-hoc trio (`panelVersion` + `attrErrors` + `refLabels`-as-the-truth):
   *
   *   - `panel.attr(name)` is a `Signal<LoadState<unknown>>` per attribute,
   *     read by AttributeRow's `state` thunk.
   *   - `panel.refLabel(target, id)` is a `Signal<LoadState<string>>` per
   *     ref id, read by CardRefValue (when rows wire it in) or accessed
   *     synchronously by the RefPicker seed path through `refLabels`.
   *   - Lifecycle mutations (`seedAttr`, `beginCommit`, `confirmCommit`,
   *     `rejectCommit`, `setRefLabel`) are the ONLY way the panel's
   *     declared state changes.  No more `bumpPanel()`.
   */
  private readonly panel = new PanelModel();

  /* DOM regions, held so the load onOk can repaint without a full re-render. */
  private loadingEl!: HTMLElement;
  private notFoundEl!: HTMLElement;
  private mainCol!: HTMLElement;
  private rightRail!: HTMLElement;
  private titleHost!: HTMLElement;
  private taskNavHost!: HTMLElement;
  private descHost!: HTMLElement;
  private panelBody!: HTMLElement;
  /** Host the #34 TransitionBar mounts into (in the transitions slot). */
  private transitionsHost!: HTMLElement;
  /** The mounted TransitionBar, so a status commit can reload it. */
  private transitionBar: TransitionBar | null = null;
  /** Hosts the #35 comments + activity controls mount into (their two slots). */
  private commentsHost!: HTMLElement;
  private activityHost!: HTMLElement;
  /** The mounted #35 comments+activity control, so an edit can reload its feed. */
  private taskComments: TaskComments | null = null;
  /** Host + control for the COMMS (email-thread) section. */
  private commsHost!: HTMLElement;
  private commThreads: CommThreads | null = null;
  /** Host + control for the LINKS section (code changes / issues / URLs). */
  private linksHost!: HTMLElement;
  private approvalsHost!: HTMLElement;
  private taskLinks: TaskLinks | null = null;
  private taskApprovals: TaskApprovals | null = null;
  /** Host + control for a page's PUBLISHED ON section. */
  private publicationsHost!: HTMLElement;
  private pagePublications: PagePublications | null = null;
  private structureHost!: HTMLElement;
  private pageStructure: PageStructure | null = null;
  /** A thread's TASK section (Attach to task… / Make a task). */
  private placementHost!: HTMLElement;
  private placementMounted = false;

  /** Read-only status badge in the nav row (next to #id). Phase-toned. */
  private statusBadgeEl!: HTMLElement;
  /** status card id → {label, phase} for the header status badge. */
  private readonly statusInfo = new Map<string, StatusInfo>();

  /** The open overflow-menu popover, disposed on close / destroy. */
  private actionsMenu: Popover | null = null;
  /** The type-DELETE-to-confirm purge dialog node (built lazily). */
  private purgeConfirmEl: HTMLElement | null = null;
  /** The "Move to project" dialog node (built lazily), its destination picker
   *  child (disposed on close), and the picked destination project id. */
  private moveConfirmEl: HTMLElement | null = null;
  private movePicker: Control | null = null;
  private moveTargetProject: bigint | null = null;

  /** The header "Refresh" button, held so the background poll can repaint its
   *  synced (green) ↔ new-content (orange-blinking) state. */
  private refreshBtn: HTMLButtonElement | null = null;
  /** Background-poll baseline: activity ids ≤ this are considered "seen" (the
   *  newest id present when the screen opened / was last refreshed). */
  private pollSinceId: bigint = 0n;
  /** The ticking poll handle, cleared on destroy. */
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** Newer-activity count from the last poll (drives the indicator). */
  private pollNewCount = 0;
  /** Hosts the #36 attachments / tags / related controls mount into (their slots). */
  private attachmentsHost!: HTMLElement;
  /** Main-column host the AttachmentsSection paints its preview strip into. */
  private attachmentsPreviewHost!: HTMLElement;
  private tagsHost!: HTMLElement;
  private relatedHost!: HTMLElement;
  /** Main-column host the RelatedTasksPanel paints its read-only navigable
   *  parent/child summary into (clickable links + phase icon + status). The
   *  rail's `relatedHost` keeps the editing controls. */
  private relatedSummaryHost!: HTMLElement;
  /** The mounted #36 controls (idempotent mount; refresh hooks). */
  private attachmentsSection: AttachmentsSection | null = null;
  /** The corner's watch-list bookmarks (tasks and threads). */
  private watchBar: WatchBar | null = null;
  private tagsEditor: TagsEditor | null = null;
  private relatedPanel: RelatedTasksPanel | null = null;

  /** Title inline-edit state. */
  private editingTitle = false;
  /** Description inline-edit state. */
  private editingDescription = false;
  /** The ✎ button on the DESCRIPTION label row (hidden while editing). */
  private descEditBtn: HTMLButtonElement | null = null;
  /** Save / Cancel buttons in the DESCRIPTION label row (visible while editing).
   *  Lets the user paste back and forth between the source and the editor
   *  without a stray blur committing a half-finished draft. */
  private descSaveBtn: HTMLButtonElement | null = null;
  private descCancelBtn: HTMLButtonElement | null = null;
  /** The live editor while editing — held so the Save button can read its
   *  value (getValue) without a DOM query, and so it can be torn down. */
  private descEditor: RichEditor | null = null;
  /** Under the description: what's wrong with its placeholders (pages). */
  private descWarn!: HTMLElement;
  /** Pending re-check of the placeholders while editing (debounced). */
  private descWarnTimer: ReturnType<typeof setTimeout> | null = null;

  /** Per-row child editors (RefPicker / DatePicker) so we can dispose on rebuild. */
  private rowChildren: Control[] = [];

  constructor(...args: ConstructorParameters<typeof Control<TaskDetailConfig>>) {
    super(...args);
    this.taskId = parseId(this.config.taskId);
    this.cardTypeName = this.config.cardTypeName ?? 'task';
    this.profile = detailProfile(this.cardTypeName);
  }

  /** Whether this card shows a section: its profile has it, and the
   *  section's area (SECTION_AREA) isn't off. */
  private shows(section: DetailSection): boolean {
    if (!this.profile.sections.includes(section)) return false;
    const area = SECTION_AREA[section];
    if (area === undefined) return true;
    if (this.offAreas.has(area)) return false;
    return !(SECTION_NEEDS_AREA_ON.has(section) && this.unusedAreas.has(area));
  }

  /** Every section slot, for hiding the ones of an area that is off. */
  private sectionSlots: Array<[DetailSection, HTMLElement]> = [];

  /** The areas that are off for the card's project, and the workspace's.
   *  Known before the first paint, so their sections never show or mount. */
  private offAreas = new Set<string>();
  /** The project's areas that were never set up ('unused'): sections in
   *  SECTION_NEEDS_AREA_ON hide for them too. */
  private unusedAreas = new Set<string>();

  /**
   * Read which areas are off (docs/AREAS.md): the project's from area.list,
   * Sites from the shell's workspace areas. Their sections are hidden and
   * not mounted. Calls `done` when answered, or when the read fails (then
   * every section shows; the server still hides what an off area holds).
   */
  private loadSectionAreas(done: () => void): void {
    const projectId = this.projectId;
    if (projectId === undefined) {
      done();
      return;
    }
    this.ctx.api.callByName(
      AREA_SPEC.list,
      { projectId },
      (out) => {
        if (!this.isAlive()) return;
        const off = new Set(
          ((out as AreaListOutput).areas ?? []).filter((a) => a.state === 'off').map((a) => a.key),
        );
        for (const k of this.ctx.tree.at(['shell', 'workspaceAreasOff']).peek<string[]>() ?? []) off.add(k);
        this.offAreas = off;
        this.unusedAreas = new Set(
          ((out as AreaListOutput).areas ?? []).filter((a) => a.state === 'unused').map((a) => a.key),
        );
        for (const [section, el] of this.sectionSlots) if (!this.shows(section)) el.style.display = 'none';
        done();
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          if (this.isAlive()) done();
        },
      },
    );
  }

  /** The panel's attribute skip-list for this card type. */
  private skipsAttr(name: string): boolean {
    if (this.profile.showAttrs.includes(name)) return false;
    return PANEL_SKIP_ATTRS.has(name) || this.profile.skipAttrs.includes(name);
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'task-detail';
    el.dataset.control = 'TaskDetail';
    el.tabIndex = -1;
    return el;
  }

  protected render(): void {
    /* The two-column grid: main + right rail. CSS collapses to one column at
     * narrow widths. The loading / not-found states span both columns. */
    const grid = document.createElement('div');
    grid.className = 'task-detail__grid';
    grid.dataset.taskDetailGrid = '';

    const loading = document.createElement('div');
    loading.className = 'task-detail__loading muted';
    loading.dataset.taskDetailLoading = '';
    loading.textContent = `Loading ${this.profile.noun.toLowerCase()}…`;
    loading.setAttribute('aria-live', 'polite');
    this.loadingEl = loading;

    const notFound = document.createElement('div');
    notFound.className = 'task-detail__not-found';
    notFound.dataset.taskDetailNotFound = '';
    notFound.style.display = 'none';
    {
      const title = document.createElement('div');
      title.className = 'task-detail__not-found-title';
      const noun = this.profile.noun;
      title.textContent = `${noun} not found`;
      const hint = document.createElement('div');
      hint.className = 'task-detail__not-found-hint muted';
      hint.textContent =
        this.taskId === null
          ? `No ${noun.toLowerCase()} id in the URL.`
          : `No ${noun.toLowerCase()} with id #${this.taskId.toString()} exists or it was deleted.`;
      notFound.append(title, hint);
    }
    this.notFoundEl = notFound;

    /* ------------------------------ main column ------------------------------ */
    const main = document.createElement('main');
    main.className = 'task-detail__main';
    main.dataset.region = 'detail.main';
    main.style.display = 'none';
    this.mainCol = main;

    // Title block (header). Top row puts the title (left, grows) BESIDE the flow
    // / transition controls (right), so the status changer sits next to the
    // title instead of in a separate block below it — reclaiming the wasted
    // vertical whitespace (#10). The `#id` line sits under the title.
    const header = document.createElement('header');
    header.className = 'task-detail__header';
    header.dataset.region = 'detail.header';

    // Top nav row: "Back to list" (left) sharing one line with the task #id and
    // the Refresh affordance (right) — keeps the header compact instead of
    // stacking back / refresh / id on separate lines.
    const navRow = document.createElement('div');
    navRow.className = 'task-detail__nav-bar';

    // Visible "Back to list" affordance — mirrors the q/Esc chord: returns to
    // the saved source list (inbox/grid/kanban), not a browser-history step.
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'task-detail__back';
    back.dataset.taskBack = '';
    back.title = 'Back to list (q or Esc)';
    back.setAttribute('aria-label', 'Back to list');
    back.append(icon('chevron-left', 14), document.createTextNode(' Back to list'));
    this.listen(back, 'click', () => this.goBack());

    const navRight = document.createElement('div');
    navRight.className = 'task-detail__nav-bar-right';

    const idLine = document.createElement('span');
    idLine.className = 'task-detail__id muted';
    idLine.dataset.taskDetailId = '';
    idLine.textContent = this.taskId === null ? '#—' : `#${this.taskId.toString()}`;

    // Read-only status badge — phase-toned, sits next to the #id. The
    // editable changer is the TransitionBar (header-top); this is the at-a-
    // glance current state. Hidden until the status pool + task resolve.
    const statusBadge = document.createElement('span');
    statusBadge.className = 'task-detail__status';
    statusBadge.dataset.taskStatusBadge = '';
    statusBadge.style.display = 'none';
    this.statusBadgeEl = statusBadge;

    // "Refresh" — re-fetch the links, comm threads + comments/activity feed to
    // pick up what arrived since load (a forge moving a CL, a reply, …).
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'task-detail__refresh task-detail__refresh--synced';
    refresh.dataset.taskRefresh = '';
    refresh.title = 'Check for new links, comms, attachments & comments';
    refresh.setAttribute('aria-label', 'Refresh links, comms, attachments and comments');
    refresh.append(icon('refresh-cw', 14), document.createTextNode(' Refresh'));
    this.listen(refresh, 'click', () => this.refreshFeeds());
    this.refreshBtn = refresh;

    // "…" overflow menu — hosts the role-gated "Delete forever" action. Hidden
    // until the auth identity resolves to a manager/admin (effect below); the
    // server enforces the same gate on task.purge.
    const actions = document.createElement('button');
    actions.type = 'button';
    actions.className = 'task-detail__actions';
    actions.dataset.taskActions = '';
    actions.title = 'More actions';
    actions.setAttribute('aria-label', 'More actions');
    actions.setAttribute('aria-haspopup', 'menu');
    actions.append(icon('ellipsis'));
    actions.style.display = 'none';
    this.listen(actions, 'click', () => this.toggleActionsMenu(actions));

    // The viewer's watch lists, to bookmark this card (docs/WATCH_LISTS.md):
    // tasks and threads, by the detail profile.
    const watchHost = document.createElement('div');
    watchHost.className = 'task-detail__watch';
    if (this.profile.watch === true && this.taskId !== null) {
      this.watchBar = this.spawn('WatchBar', { type: 'WatchBar', cardId: this.taskId.toString() }, watchHost) as WatchBar;
    }
    navRight.append(watchHost, idLine, statusBadge, refresh, actions);
    navRow.append(back, navRight);
    header.append(navRow);

    // Reveal the "…" menu only for manager/admin (reactive — auth lands after
    // the boot /auth/me probe, possibly after this render), and only when this
    // card type has menu actions (its detail profile).
    this.effect(() => {
      const allowed = isAdmin(this.ctx.tree) || hasRole(this.ctx.tree, 'manager');
      actions.style.display = allowed && this.profile.menuActions.length > 0 ? '' : 'none';
    }, 'taskDetail.actionsRole');
    // Re-scope the status badge glyph to the task flow once it lands.
    this.effect(() => {
      this.ctx.tree.at(['scope', 'workflowStatusIds']).get();
      this.rescopeStatusBadge();
    }, 'taskDetail.statusFlowScope');
    this.onDestroy(() => {
      this.actionsMenu?.destroy();
      this.actionsMenu = null;
      this.closePurgeConfirm();
    });

    const headerTop = document.createElement('div');
    headerTop.className = 'task-detail__header-top';

    const titleHost = document.createElement('div');
    titleHost.className = 'task-detail__title-host';
    this.titleHost = titleHost;

    // #34 TransitionBar — the status changer. We keep the named `transitions`
    // slot element as the MOUNT HOST (so the slot contract is preserved) and
    // spawn the TransitionBar into it once the task loads (showLoaded). It now
    // lives in the header's top row (right of the title).
    const transitions = document.createElement('div');
    transitions.className = 'task-detail__transitions';
    transitions.dataset.slot = 'transitions';
    transitions.dataset.region = 'detail.transitions';
    this.transitionsHost = transitions;

    headerTop.append(titleHost, transitions);

    header.append(headerTop);
    main.append(header);

    // Description block.
    const descSection = document.createElement('section');
    descSection.className = 'task-detail__desc';
    descSection.dataset.region = 'detail.description';
    // Label row: "DESCRIPTION" on the left, action buttons on the right (✎ when
    // not editing; Save + Cancel when editing).  Save lives at the TOP of the
    // textbox so the user can commit without scrolling down — needed because
    // the description editor stays open across blur (Save / Mod+Enter / Esc
    // only), letting the user paste back and forth from another window.
    const descLabel = document.createElement('div');
    descLabel.className = 'task-detail__section-label task-detail__desc-label muted';
    const descLabelText = document.createElement('span');
    descLabelText.textContent = 'DESCRIPTION';

    const descActions = document.createElement('span');
    descActions.className = 'task-detail__desc-actions';

    const descEdit = document.createElement('button');
    descEdit.type = 'button';
    descEdit.className = 'task-detail__edit-btn';
    descEdit.dataset.taskDescEdit = '';
    descEdit.title = 'Edit description';
    descEdit.setAttribute('aria-label', 'Edit description');
    descEdit.append(icon('pencil', 14));
    this.listen(descEdit, 'click', () => this.startDescriptionEdit());
    this.descEditBtn = descEdit;

    const descSave = document.createElement('button');
    descSave.type = 'button';
    descSave.className = 'btn btn-primary task-detail__desc-save';
    descSave.dataset.taskDescSave = '';
    descSave.title = 'Save description (Mod+Enter)';
    descSave.setAttribute('aria-label', 'Save description');
    descSave.textContent = 'Save';
    descSave.style.display = 'none';
    this.listen(descSave, 'click', () => {
      if (this.descEditor !== null) this.commitDescription(this.descEditor.getValue());
    });
    this.descSaveBtn = descSave;

    const descCancel = document.createElement('button');
    descCancel.type = 'button';
    descCancel.className = 'btn task-detail__desc-cancel';
    descCancel.dataset.taskDescCancel = '';
    descCancel.title = 'Cancel (Esc)';
    descCancel.setAttribute('aria-label', 'Cancel description edit');
    descCancel.textContent = 'Cancel';
    descCancel.style.display = 'none';
    this.listen(descCancel, 'click', () => this.cancelDescriptionEdit());
    this.descCancelBtn = descCancel;

    descActions.append(descEdit, descCancel, descSave);
    descLabel.append(descLabelText, descActions);
    const descHost = document.createElement('div');
    descHost.className = 'task-detail__desc-host';
    this.descHost = descHost;
    // The description editor holds engine state (a ProseMirror view, later) that
    // needs explicit teardown on control destroy.
    this.onDestroy(() => this.descEditor?.destroy());
    const descWarn = document.createElement('div');
    descWarn.className = 'task-detail__desc-warnings';
    descWarn.dataset.descWarnings = '';
    descWarn.setAttribute('role', 'status');
    descWarn.style.display = 'none';
    this.descWarn = descWarn;
    this.onDestroy(() => this.clearDescWarnTimer());
    descSection.append(descLabel, descHost, descWarn);
    main.append(descSection);

    // Read-only RELATED TASKS summary — the navigable parent link + child list
    // (clickable, phase icon, status). The RelatedTasksPanel paints into this
    // main-column host while its editing controls stay in the right rail
    // (#36). Hidden until there's a parent or at least one child.
    const relatedSummary = document.createElement('section');
    relatedSummary.className = 'task-detail__related-summary';
    relatedSummary.dataset.region = 'detail.related';
    relatedSummary.style.display = 'none';
    this.relatedSummaryHost = relatedSummary;
    main.append(relatedSummary);

    // Attachment preview strip (image + PDF tiles) — the AttachmentsSection
    // (right rail) paints into this main-column host so the previews sit in the
    // content flow like the Svelte version. Hidden until/unless there's
    // something previewable. Held so showLoaded() can hand it to the section.
    const previewHost = document.createElement('section');
    previewHost.className = 'task-detail__attachments-preview';
    previewHost.dataset.region = 'detail.attachmentsPreview';
    previewHost.style.display = 'none';
    this.attachmentsPreviewHost = previewHost;
    main.append(previewHost);

    // APPROVALS — who is asked to approve which status change, and the votes:
    // a record of sign-off, kept on the task in its own section.
    const approvalsSlot = this.makeSlot('approvals', 'Approvals');
    this.approvalsHost = approvalsSlot;
    main.append(approvalsSlot);

    // LINKS — code changes / issues / URLs tied to the task, between the
    // attachment previews and COMMS. A code forge (integrations/gerrit) keeps
    // its own links current through the same link.set.
    const linksSlot = this.makeSlot('links', 'Links');
    this.linksHost = linksSlot;
    main.append(linksSlot);

    // #35 comments + activity slots. We hold the two host elements so the
    // showLoaded() path can spawn the TaskComments control into the comments
    // slot and hand it the activity slot to paint into.
    // COMMS (email threads) — its own main-column section above Comments.
    const commsSlot = this.makeSlot('comms', 'Comms');
    this.commsHost = commsSlot;
    const commentsSlot = this.makeSlot('comments', 'Comments (#35)');
    const activitySlot = this.makeSlot('activity', 'Activity (#35)');
    this.commentsHost = commentsSlot;
    this.activityHost = activitySlot;
    main.append(commsSlot, commentsSlot, activitySlot);

    /* ------------------------------- right rail ------------------------------ */
    const rail = document.createElement('aside');
    rail.className = 'task-detail__rail';
    rail.dataset.region = 'detail.rail';
    rail.style.display = 'none';
    rail.setAttribute('aria-label', 'Attributes');
    this.rightRail = rail;

    // Prev/next task nav as a bubble ABOVE the attributes — same rail-bar style,
    // no head: a single row with label "Task" and value `‹ N of M ›`. Walks the
    // same list the user came from (`nav.taskList`, published by grid/inbox/
    // kanban on open); mirrors the `[`/`]` + `j`/`k` jump chords. Hidden on a
    // cold deep-link (no published list) or a single-item list.
    const navPanel = document.createElement('div');
    navPanel.className = 'task-detail__panel task-detail__nav-panel';
    navPanel.dataset.taskNav = '';
    this.taskNavHost = navPanel;
    rail.append(navPanel);
    this.paintTaskNav();

    // A thread's TASK section (thread-placement.ts): above the attributes,
    // since attaching is what a thread on its own is waiting for.
    const placementSlot = this.makeSlot('placement', 'Task');
    this.placementHost = placementSlot;
    rail.append(placementSlot);

    const panel = document.createElement('div');
    panel.className = 'task-detail__panel';
    panel.dataset.region = 'detail.rail.attributes';
    const panelHead = document.createElement('h2');
    panelHead.className = 'task-detail__panel-head';
    panelHead.textContent = 'Attributes';
    const panelBody = document.createElement('div');
    panelBody.className = 'task-detail__panel-body';
    panelBody.dataset.taskDetailPanel = '';
    this.panelBody = panelBody;
    panel.append(panelHead, panelBody);
    rail.append(panel);

    // #36 attachments + tags + related slots. Hold the host elements so
    // showLoaded() can spawn each control into its slot once the task is known.
    const attachmentsSlot = this.makeSlot('attachments', 'Attachments (#36)');
    const tagsSlot = this.makeSlot('tags', 'Tags (#36)');
    const relatedSlot = this.makeSlot('related', 'Related (#36)');
    this.attachmentsHost = attachmentsSlot;
    this.tagsHost = tagsSlot;
    this.relatedHost = relatedSlot;
    // A page's PLACE IN SITE (parent, child pages, navigation) and PUBLISHED
    // ON (where it's live) sections.
    const structureSlot = this.makeSlot('structure', 'Place in site');
    this.structureHost = structureSlot;
    const publicationsSlot = this.makeSlot('publications', 'Published on');
    this.publicationsHost = publicationsSlot;
    rail.append(structureSlot, publicationsSlot, attachmentsSlot, tagsSlot, relatedSlot);

    // Sections this card type doesn't have (its detail profile) never show.
    const slots: Array<[DetailSection, HTMLElement]> = [
      ['description', descSection],
      ['placement', placementSlot],
      ['approvals', approvalsSlot],
      ['links', linksSlot],
      ['comms', commsSlot],
      ['comments', commentsSlot],
      ['comments', activitySlot],
      ['attachments', attachmentsSlot],
      ['tags', tagsSlot],
      ['related', relatedSlot],
      ['structure', structureSlot],
      ['publications', publicationsSlot],
    ];
    for (const [section, el] of slots) if (!this.shows(section)) el.style.display = 'none';
    this.sectionSlots = slots;

    grid.append(loading, notFound, main, rail);
    this.el.append(grid);

    // Pre-mount the route-id-only sections (transitions, comments + activity,
    // comms, attachments) NOW, in the same tick as the task/schema reads, so
    // their queries COALESCE into one POST instead of firing a second round-trip
    // after the task lands. They mount into the still-hidden main/rail slots;
    // showLoaded() just reveals them (the mounts are idempotent there). Tags /
    // related / the attribute panel need the task card itself, so they stay in
    // showLoaded. On a not-found / comm-card redirect these reads are harmless
    // (empty results, discarded when the detail tears down).
    this.mountTransitionBar();
    this.mountComments();
    this.mountComms();
    this.mountLinks();
    this.mountApprovals();
    this.mountAttachments();
    this.mountStructure();
    this.mountPublications();

    // Kick off the loads. Zero-promise: the onOk callbacks repaint when each
    // response lands, gated by isAlive() so a torn-down screen never delivers.
    this.loadSchema();
    this.loadTask();
    this.loadStatusPool();
  }

  /* ------------------------------- loads -------------------------------- */

  /** Load the shared `status` value-cards so the header badge can resolve the
   *  task's current status to a label + phase (mirrors comms-list / CommThreads).
   *  Repaints the badge on arrival in case the task already landed. */
  private loadStatusPool(): void {
    this.ctx.api.callByName(
      SPEC.selectWithAttributes,
      { cardTypeName: 'status' },
      (out) => {
        if (!this.isAlive()) return;
        const rows = (out as SelectWithAttributesOutput).rows ?? [];
        for (const r of rows) {
          const a = r.attributes;
          const label = typeof a['title'] === 'string' && a['title'].length > 0 ? a['title'] : `#${r.id.toString()}`;
          this.statusInfo.set(r.id.toString(), {
            label,
            phase: r.phase ?? '',
            sortOrder: Number(a['sort_order'] ?? 0),
            groupKey: r.parent_card_id?.toString() ?? '',
          });
        }
        this.rescopeStatusBadge();
      },
      { alive: () => this.isAlive() },
    );
  }

  /** Paint the read-only header status badge from the task's `status` ref and
   *  the loaded status pool. Hidden until both resolve. */
  /** Recompute the status badge glyph against the current task-flow scope. */
  private rescopeStatusBadge(): void {
    applyStatusGlyphs(this.statusInfo, peekWorkflowStatusIds(this.ctx));
    this.paintStatusBadge();
  }

  private paintStatusBadge(): void {
    const el = this.statusBadgeEl;
    if (el === undefined) return;
    const sid = this.task === null ? null : asAttrId(this.task.attributes[this.profile.statusAttr]);
    const info = sid === null ? undefined : this.statusInfo.get(sid.toString());
    if (info === undefined) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    el.dataset.phase = info.phase;
    el.textContent = info.label;
  }

  /** Load the task card_type's editable attribute schema (attribute_def.select). */
  private loadSchema(): void {
    this.ctx.api.callByName(
      ADMIN_SPEC.attributeDefSelect,
      {},
      (out) => {
        const defs = (out as AttributeDefListOutput).rows ?? [];
        const full = schemaForCardType(defs, this.cardTypeName);
        this.schema = full.filter((a) => !this.skipsAttr(a.name));
        if (this.task !== null) this.renderPanel();
      },
      { alive: () => this.isAlive() },
    );
  }

  /**
   * Load the focal card by id (`card.select_with_attributes` with `ids`).
   * A profile that links to its siblings (pages: the link picker, and the
   * walk up through parent pages to the project) loads every card of its
   * type instead. Resolves label lookups for the panel's card_ref
   * summaries once the card is known.
   */
  private loadTask(): void {
    if (this.taskId === null) {
      this.task = null;
      this.showNotFound();
      return;
    }
    this.ctx.api.callByName(
      SPEC.selectWithAttributes,
      this.profile.linkSiblings ? { cardTypeName: this.cardTypeName } : { cardTypeName: this.cardTypeName, ids: [this.taskId] },
      (out) => {
        const rows = (out as SelectWithAttributesOutput).rows ?? [];
        const found = rows.find((r) => r.id === this.taskId) ?? null;
        this.task = found;
        if (found === null) {
          // The id may be a comm card (e.g. a stale link) — comm cards have no
          // task route, so resolve to the owning task and redirect there.
          if (this.profile.commRedirect) this.redirectIfCommCard();
          else this.showNotFound();
          return;
        }
        this.landTask(found, rows);
      },
      { alive: () => this.isAlive() },
    );
  }

  /**
   * The card is loaded: show it once everything that would change its first
   * paint is in, so it paints once, complete: which sections show (the
   * project's areas), the labels of its card_ref values ("Help Desk", not
   * "#160") and, for a profile with a parentRoute, whether it opens on its
   * parent's page instead. The reads go out together, in one batch.
   */
  private landTask(found: CardWithAttrs, rows: CardWithAttrs[]): void {
    this.projectId = enclosingProjectId(found, new Map(rows.map((r) => [r.id, r])));
    this.sameTypeRows = rows;
    // Seed the panel store with every attribute's initial Value/Unset.
    // Every subsequent commit drives a Pending → Value/Error transition
    // through `panel.beginCommit / confirmCommit / rejectCommit`.
    this.panel.seedFromAttributes(found.attributes);
    const via = this.profile.parentRoute;
    const parentId = found.parent_card_id;
    const checkParent = via !== undefined && parentId !== undefined;
    const paint = afterAll(checkParent ? 3 : 2, () => {
      if (!this.isAlive() || this.leaving) return;
      this.publishProjectScope();
      this.showLoaded();
    });
    if (checkParent) this.openOnParentIfItIs(parentId, via.cardType, via.route, paint);
    this.loadSectionAreas(paint);
    this.resolveRefLabels(paint);
  }

  /** Set when the card opens on its parent's page instead. */
  private leaving = false;

  /**
   * The profile's parentRoute: a card whose parent is a `cardType` card opens
   * on the parent's page (a thread on a task opens on its task — only a
   * thread on its own has a page). Otherwise `stay`. One read.
   */
  private openOnParentIfItIs(parentId: bigint, cardType: string, route: CardRoute, stay: () => void): void {
    this.ctx.api.callByName(
      CARD_SEARCH_SPEC,
      { cardTypeName: cardType, ids: [parentId] },
      (out) => {
        if (!this.isAlive()) return;
        const rows = ((out ?? {}) as { rows?: Array<{ id: bigint }> }).rows ?? [];
        if (rows.some((r) => r.id === parentId)) {
          this.leaving = true;
          navigate(cardUrl(parentId, route));
          return;
        }
        stay();
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          if (this.isAlive()) stay();
        },
      },
    );
  }

  /**
   * Fallback when /task/:id isn't a task: if the id is a COMM card, redirect to
   * its parent task (comm cards parent under their task); otherwise show the
   * not-found state. One extra read, only on the (rare) miss path.
   */
  private redirectIfCommCard(): void {
    if (this.taskId === null) {
      this.showNotFound();
      return;
    }
    this.ctx.api.callByName(
      SPEC.selectWithAttributes,
      { cardTypeName: 'comm', ids: [this.taskId] },
      (out) => {
        if (!this.isAlive()) return;
        const rows = (out as SelectWithAttributesOutput).rows ?? [];
        const comm = rows.find((r) => r.id === this.taskId) ?? null;
        const parent = comm?.parent_card_id;
        if (typeof parent === 'bigint' && parent > 0n) {
          navigate(taskUrl(parent));
          return;
        }
        this.showNotFound();
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          if (this.isAlive()) this.showNotFound();
        },
      },
    );
  }

  /**
   * Mirror the task's parent (project) id into `scope.projectId` so the rail's
   * DEFAULT PROJECT screen-nav reflects this task's project — keeping the
   * project-specific screens visible on the task-detail screen, even on a cold
   * deep-link to `/task/:id` where no project was previously in scope.
   */
  private publishProjectScope(): void {
    const project = this.projectId;
    if (typeof project === 'bigint' && project > 0n) {
      this.ctx.tree.at(['scope', 'projectId']).set(project);
    }
  }

  /**
   * Resolve display labels for the card_ref attribute values the task currently
   * holds, so the panel's RefPicker triggers show "alice" rather than "#10".
   * One `card.search { ids }` per distinct target card_type that has set refs.
   * Tolerates non-bigint wire forms (digit-string / number): the dispatcher's
   * id-revival is hand-keyed by attribute NAME (`assignee`, `status`, …) so
   * un-primed card_ref attrs (e.g. `originator`) arrive as strings. The schema
   * is the canonical source of card_ref-ness — every consumer reads the value
   * via {@link asAttrId} so the fix applies uniformly to every card_ref attr
   * without per-name registration drift.
   */
  private resolveRefLabels(done?: () => void): void {
    const task = this.task;
    if (task === null) {
      done?.();
      return;
    }
    const byType = new Map<string, Set<bigint>>();
    for (const attr of this.schema) {
      if (attr.valueType !== 'card_ref' && attr.valueType !== 'card_ref[]') continue;
      const target = attr.targetCardType;
      if (target === undefined) continue;
      const v = task.attributes[attr.name];
      const collect = (id: unknown): void => {
        const bid = asAttrId(id);
        if (bid === null) return;
        let set = byType.get(target);
        if (set === undefined) {
          set = new Set();
          byType.set(target, set);
        }
        set.add(bid);
      };
      if (Array.isArray(v)) v.forEach(collect);
      else collect(v);
    }
    // `done` (optional) once every lookup has answered or failed.
    const arrived = afterAll(byType.size, () => done?.());
    for (const [target, ids] of byType) {
      this.ctx.api.callByName(
        CARD_SEARCH_SPEC,
        { cardTypeName: target, ids: [...ids] },
        (out) => {
          if (!this.isAlive()) return;
          const rows = ((out ?? {}) as { rows?: Array<{ id: bigint; title: string }> }).rows ?? [];
          // Land each label on BOTH the per-ref signal (the panel store —
          // AttributeRow / CardRefValue subscribe) and the synchronous Map
          // mirror (still consulted by some seed paths).  Each set() on a
          // signal repaints only the chips that read it.
          for (const r of rows) {
            this.refLabels.set(String(r.id), r.title);
            this.panel.setRefLabel(target, r.id, r.title);
          }
          arrived();
        },
        {
          alive: () => this.isAlive(),
          onErr: () => {
            if (this.isAlive()) arrived();
          },
        },
      );
    }
  }

  /* ----------------------------- state toggles -------------------------- */

  private showNotFound(): void {
    this.loadingEl.style.display = 'none';
    this.mainCol.style.display = 'none';
    this.rightRail.style.display = 'none';
    this.notFoundEl.style.display = '';
  }

  /** Reveal the two columns + paint title / description / panel from the task. */
  private showLoaded(): void {
    this.loadingEl.style.display = 'none';
    this.notFoundEl.style.display = 'none';
    this.mainCol.style.display = '';
    this.rightRail.style.display = '';
    this.renderTitle();
    this.renderDescription();
    this.renderPanel();
    this.paintStatusBadge();
    this.mountTransitionBar();
    this.mountPlacement();
    this.mountComments();
    this.mountComms();
    this.mountLinks();
    this.mountApprovals();
    this.mountAttachments();
    this.mountStructure();
    this.mountPublications();
    this.mountTags();
    this.mountRelated();
    this.startPolling();
  }

  /**
   * Spawn the #34 TransitionBar into the transitions slot once the task is
   * known. Idempotent — a re-show (e.g. late label resolve) reuses the bar. The
   * bar fires its own `attribute.update` for status moves and notifies us via
   * `onChanged` so the panel's status summary tracks the optimistic move.
   */
  private mountTransitionBar(): void {
    if (this.taskId === null) return;
    if (this.transitionBar !== null) return;
    const bar = this.spawn(
      'TransitionBar',
      {
        type: 'TransitionBar',
        cardId: this.taskId.toString(),
        statusAttr: this.profile.statusAttr,
        onChanged: (toCardId: bigint, attributeName: string) => {
          // Mirror the optimistic move into the loaded task AND seed the
          // panel store (Pending → Value on the next confirm, but the bar
          // already drove its own commit so we land directly at Value).
          if (this.task !== null) {
            this.task.attributes = {
              ...this.task.attributes,
              [attributeName]: toCardId,
            };
          }
          this.panel.seedAttr(attributeName, toCardId);
          this.paintStatusBadge();
          if (this.isAlive()) {
            this.resolveRefLabels();
            // The transition wrote an attr_update + status row to the stream —
            // refresh the #35 feed so it reflects the move. A move can also
            // settle an approval request or leave votes stale.
            this.taskComments?.reload();
            this.taskApprovals?.reload();
            // Entering a status can publish the page (or withdraw it).
            this.pagePublications?.reload();
            this.noteOwnActivity();
          }
        },
      },
      this.transitionsHost,
    ) as TransitionBar;
    this.transitionBar = bar;
  }

  /**
   * Spawn the #35 TaskComments control (comments + the activity feed) once the
   * task is known. Idempotent — a re-show reuses the control. It mounts into the
   * `comments` slot and is handed the `activity` slot host to paint the feed
   * into; both share one `activity.select` load. The control author-gates the
   * per-comment edit to `currentUserId` and refreshes its feed after a comment
   * edit; the TaskDetail also tells it to {@link TaskComments.reload} after a
   * status transition / attribute edit so those rows appear.
   */
  /** Re-fetch the links, comm threads, attachments, watch lists + the
   *  comments/activity feed — the header "Refresh" button. Each child control owns its own reload()
   *  (re-query + repaint); null-safe before the task has loaded. Also re-seeds
   *  the poll baseline so the "new content" indicator clears back to synced. */
  private refreshFeeds(): void {
    this.pagePublications?.reload();
    this.attachmentsSection?.reload();
    this.watchBar?.reload();
    this.taskLinks?.reload();
    this.taskApprovals?.reload();
    this.commThreads?.reload();
    this.taskComments?.reload();
    // The user has now pulled the latest — re-seed the baseline to the current
    // head so the indicator drops back to green (the probe lands async).
    this.pollOnce(true);
  }

  /* -------------------------- background poll --------------------------- */

  /** ~15s cadence — cheap enough for a count-only probe, snappy enough that a
   *  reply shows up "soon". Paused while the tab is hidden. */
  private static readonly POLL_INTERVAL_MS = 15_000;

  /**
   * Seed the poll baseline to the task's current latest activity id, then start
   * the ticking background poll. Idempotent (guards on the timer). The initial
   * seed probe means the indicator only lights for activity that arrives AFTER
   * the screen opened. A `visibilitychange` listener re-probes immediately when
   * the tab regains focus (and the interval skips ticks while hidden).
   */
  private startPolling(): void {
    if (this.taskId === null || this.pollTimer !== null) return;
    this.pollOnce(true);
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (this.isAlive()) this.pollOnce(false);
    }, TaskDetail.POLL_INTERVAL_MS);
    // Don't let the poll keep a process alive when nothing else is pending (lets
    // `node --test` exit). No-op in browsers, where setInterval returns a number.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.pollTimer = timer;
    this.onDestroy(() => {
      if (this.pollTimer !== null) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    });
    if (typeof document !== 'undefined') {
      this.listen(document, 'visibilitychange', () => {
        if (!document.hidden && this.isAlive()) this.pollOnce(false);
      });
    }
  }

  /**
   * One poll round-trip. When `seed` is true the response's latest id becomes
   * the baseline (indicator cleared); otherwise `new_count` drives the refresh
   * button's synced ↔ new-content state. Zero-promise; gated by isAlive().
   */
  private pollOnce(seed: boolean): void {
    if (this.taskId === null) return;
    const input: ActivityPollInput = { taskId: this.taskId };
    if (!seed) input.sinceActivityId = this.pollSinceId;
    this.ctx.api.callByName(
      ACTIVITY_POLL_SPEC,
      input,
      (out) => {
        const o = out as ActivityPollOutput;
        if (seed) {
          this.pollSinceId = o.latestActivityId;
          this.pollNewCount = 0;
        } else {
          this.pollNewCount = o.newCount;
        }
        this.paintRefreshState();
      },
      { alive: () => this.isAlive() },
    );
  }

  /** Re-seed the poll baseline after the user's OWN activity (a comment, reply,
   *  attribute edit, transition, …) so it doesn't light the "new content"
   *  indicator. pollOnce(true) adopts the current latest as the baseline. */
  private noteOwnActivity(): void {
    if (this.isAlive()) this.pollOnce(true);
  }

  /** Reflect the poll state on the Refresh button: green/synced when nothing is
   *  new, orange-blinking with a count when newer activity has landed. */
  private paintRefreshState(): void {
    const btn = this.refreshBtn;
    if (btn === null) return;
    const fresh = this.pollNewCount > 0;
    btn.classList.toggle('task-detail__refresh--new', fresh);
    btn.classList.toggle('task-detail__refresh--synced', !fresh);
    btn.replaceChildren(
      icon('refresh-cw', 14),
      document.createTextNode(fresh ? ` ${this.pollNewCount} new` : ' Refresh'),
    );
    btn.title = fresh
      ? `${this.pollNewCount} new update${this.pollNewCount === 1 ? '' : 's'} (comms / comments / links) — click to load`
      : 'Up to date · click to check for new links, comms & comments';
  }

  /** Spawn a page's PLACE IN SITE control into the `structure` slot. Idempotent. */
  private mountStructure(): void {
    if (this.taskId === null || !this.shows('structure')) return;
    if (this.pageStructure !== null) return;
    this.structureHost.replaceChildren();
    this.structureHost.classList.add('task-detail__slot--filled');
    this.pageStructure = this.spawn(
      'PageStructure',
      {
        type: 'PageStructure',
        pageId: this.taskId.toString(),
        // A move, reorder or navigation flag is an edit: a published copy
        // goes stale, and the activity feed gains a row.
        onChanged: () => {
          this.pagePublications?.reload();
          this.taskComments?.reload();
          this.noteOwnActivity();
        },
      },
      this.structureHost,
    ) as PageStructure;
  }

  /** Spawn a page's PUBLISHED ON control into the `publications` slot. Idempotent. */
  private mountPublications(): void {
    if (this.taskId === null || !this.shows('publications')) return;
    if (this.pagePublications !== null) return;
    this.publicationsHost.replaceChildren();
    this.publicationsHost.classList.add('task-detail__slot--filled');
    this.pagePublications = this.spawn(
      'PagePublications',
      { type: 'PagePublications', pageId: this.taskId.toString() },
      this.publicationsHost,
    ) as PagePublications;
  }

  /** Spawn the COMMS (email-thread) control into the `comms` slot. Idempotent. */
  private mountComms(): void {
    if (this.taskId === null || !this.shows('comms')) return;
    if (this.commThreads !== null) return;
    this.commsHost.replaceChildren();
    this.commsHost.classList.add('task-detail__slot--filled');
    this.commThreads = this.spawn(
      'CommThreads',
      {
        type: 'CommThreads',
        // A thread's own page shows the thread; a task lists its threads.
        ...(this.profile.commsSelf === true ? { commId: this.taskId.toString() } : { taskId: this.taskId.toString() }),
        projectScopePath: 'scope.projectId',
        // Our own reply / new thread shouldn't trip the "new content" badge.
        onLocalWrite: () => this.noteOwnActivity(),
        onOpenApproval: (id: bigint) => this.taskApprovals?.reveal(id),
        // Add to task moved a file from a thread into the task's Attachments.
        onFilesChanged: () => {
          this.attachmentsSection?.reload();
          this.taskComments?.reload();
        },
      },
      this.commsHost,
    ) as CommThreads;
  }

  /** Spawn a thread's TASK section into the `placement` slot. Idempotent. */
  private mountPlacement(): void {
    if (this.taskId === null || this.task === null || this.projectId === undefined || !this.shows('placement')) return;
    if (this.placementMounted) return;
    this.placementMounted = true;
    this.placementHost.replaceChildren();
    this.placementHost.classList.add('task-detail__slot--filled');
    const title = this.task.attributes['title'];
    this.spawn(
      'ThreadPlacement',
      {
        type: 'ThreadPlacement',
        commId: this.taskId.toString(),
        title: typeof title === 'string' ? title : '',
      },
      this.placementHost,
    );
  }

  /** Spawn the APPROVALS control into the `approvals` slot. Idempotent. */
  private mountApprovals(): void {
    if (this.taskId === null || !this.shows('approvals')) return;
    if (this.taskApprovals !== null) return;
    this.approvalsHost.replaceChildren();
    this.approvalsHost.classList.add('task-detail__slot--filled');
    this.taskApprovals = this.spawn(
      'TaskApprovals',
      {
        type: 'TaskApprovals',
        taskId: this.taskId.toString(),
        projectScopePath: 'scope.projectId',
        // A vote with a reason also shows in the comments, and an emailed
        // ask starts a comm thread; our own writes shouldn't trip the "new
        // content" badge.
        onLocalWrite: () => {
          this.taskComments?.reload();
          this.commThreads?.reload();
          this.noteOwnActivity();
        },
        onOpenComm: (id: bigint) => this.commThreads?.reveal(id),
      },
      this.approvalsHost,
    ) as TaskApprovals;
  }

  /** Spawn the LINKS control into the `links` slot. Idempotent. */
  private mountLinks(): void {
    if (this.taskId === null || !this.shows('links')) return;
    if (this.taskLinks !== null) return;
    this.linksHost.replaceChildren();
    this.linksHost.classList.add('task-detail__slot--filled');
    this.taskLinks = this.spawn(
      'TaskLinks',
      {
        type: 'TaskLinks',
        taskId: this.taskId.toString(),
        // Our own add / remove shouldn't trip the "new content" badge.
        onLocalWrite: () => this.noteOwnActivity(),
      },
      this.linksHost,
    ) as TaskLinks;
  }

  private mountComments(): void {
    if (this.taskId === null || !this.shows('comments')) return;
    if (this.taskComments !== null) return;
    // Drop the empty-slot placeholder look + label now that both slots are
    // filled (the comments control mounts here; the feed paints the activity
    // slot). The TaskComments control clears the activity host itself.
    this.commentsHost.replaceChildren();
    this.commentsHost.classList.add('task-detail__slot--filled');
    this.activityHost.classList.add('task-detail__slot--filled');
    const cfg: Record<string, unknown> = {
      type: 'TaskComments',
      cardId: this.taskId.toString(),
      cardTypeName: this.cardTypeName,
      activityHost: this.activityHost,
      // A card that lists its email threads (a task) shows their comments
      // too, so a thread's comments stay in view once it's attached.
      withThreadComments: this.profile.sections.includes('comms') && this.profile.commsSelf !== true,
      // Our own comment insert/edit shouldn't trip the "new content" badge.
      onLocalWrite: () => this.noteOwnActivity(),
    };
    if (this.config.currentUserId !== undefined) cfg['currentUserId'] = this.config.currentUserId;
    const tc = this.spawn('TaskComments', cfg, this.commentsHost) as TaskComments;
    this.taskComments = tc;
  }

  /**
   * Spawn the #36 AttachmentsSection into the `attachments` slot once the task
   * is known. Idempotent. The upload service's injectable chunk-POST sink + the
   * blob fetcher (thumbnails / views) are threaded through from config so tests
   * drive them with mocks; production leaves them unset (same-origin fetch).
   */
  private mountAttachments(): void {
    if (this.taskId === null || !this.shows('attachments')) return;
    if (this.attachmentsSection !== null) return;
    this.attachmentsHost.replaceChildren();
    this.attachmentsHost.classList.add('task-detail__slot--filled');
    const cfg: Record<string, unknown> = {
      type: 'AttachmentsSection',
      cardId: this.taskId.toString(),
      // Paint the image/PDF preview strip into the main-column host.
      previewHost: this.attachmentsPreviewHost,
      onChanged: () => {
        if (this.isAlive()) {
          this.taskComments?.reload();
          this.noteOwnActivity();
        }
      },
    };
    if (this.config.postChunk !== undefined) cfg['postChunk'] = this.config.postChunk;
    if (this.config.fetchBlob !== undefined) cfg['fetchBlob'] = this.config.fetchBlob;
    this.attachmentsSection = this.spawn(
      'AttachmentsSection',
      cfg,
      this.attachmentsHost,
    ) as AttachmentsSection;
  }

  /**
   * Spawn the #36 TagsEditor into the `tags` slot once the task is known.
   * Idempotent. Seeded from the task's `tags` card_ref[] attribute (+ any cached
   * ref labels), scoped to the task's parent project for the add-search.
   */
  private mountTags(): void {
    if (this.task === null || this.taskId === null || !this.shows('tags')) return;
    if (this.tagsEditor !== null) return;
    this.tagsHost.replaceChildren();
    this.tagsHost.classList.add('task-detail__slot--filled');

    const raw = this.task.attributes['tags'];
    const ids = Array.isArray(raw)
      ? (raw as unknown[]).filter((x): x is bigint => typeof x === 'bigint')
      : [];
    const initialTagIds = ids.map((id) => id.toString());
    const initialLabels: Record<string, string> = {};
    for (const id of ids) {
      const lbl = this.refLabels.get(String(id));
      if (lbl !== undefined) initialLabels[String(id)] = lbl;
    }

    const cfg: Record<string, unknown> = {
      type: 'TagsEditor',
      cardId: this.taskId.toString(),
      initialTagIds,
      initialLabels,
      onChanged: (tagIds: bigint[]) => {
        if (this.task !== null) {
          this.task.attributes = { ...this.task.attributes, tags: tagIds };
        }
        this.panel.seedAttr('tags', tagIds);
        if (this.isAlive()) {
          this.taskComments?.reload();
          this.noteOwnActivity();
        }
      },
    };
    const scope = this.projectScopePath();
    if (scope !== undefined) cfg['parentScopePath'] = scope;
    this.tagsEditor = this.spawn('TagsEditor', cfg, this.tagsHost) as TagsEditor;
  }

  /**
   * Spawn the #36 RelatedTasksPanel into the `related` slot once the task is
   * known. Idempotent. Seeded from the task's `parent_task` /
   * `parent_relationship` attributes; the children list loads itself.
   */
  private mountRelated(): void {
    if (this.task === null || this.taskId === null || !this.shows('related')) return;
    if (this.relatedPanel !== null) return;
    this.relatedHost.replaceChildren();
    this.relatedHost.classList.add('task-detail__slot--filled');

    const parent = this.task.attributes['parent_task'];
    const rel = this.task.attributes['parent_relationship'];
    const cfg: Record<string, unknown> = {
      type: 'RelatedTasksPanel',
      cardId: this.taskId.toString(),
      summaryHost: this.relatedSummaryHost,
      onChanged: (parentTaskId: bigint | null, relationship: string | null) => {
        if (this.task !== null) {
          this.task.attributes = {
            ...this.task.attributes,
            parent_task: parentTaskId ?? null,
            parent_relationship: relationship ?? null,
          };
        }
        this.panel.seedAttr('parent_task', parentTaskId);
        this.panel.seedAttr('parent_relationship', relationship);
        if (this.isAlive()) {
          this.taskComments?.reload();
          this.noteOwnActivity();
        }
      },
    };
    if (typeof parent === 'bigint') {
      cfg['parentTaskId'] = parent.toString();
      const lbl = this.refLabels.get(String(parent));
      if (lbl !== undefined) cfg['parentLabel'] = lbl;
    }
    if (typeof rel === 'string' && rel !== '') cfg['parentRelationship'] = rel;
    const scope = this.projectScopePath();
    if (scope !== undefined) cfg['parentScopePath'] = scope;
    this.relatedPanel = this.spawn('RelatedTasksPanel', cfg, this.relatedHost) as RelatedTasksPanel;
  }

  /**
   * The dotted tree path holding the focal task's parent (project) card id, for
   * the tags / related child-search scope. Seeds the leaf with the task's parent
   * id and returns the path; undefined when no parent project is known. Mirrors
   * the attribute panel's `refScopePath`.
   */
  private projectScopePath(): string | undefined {
    const parent = this.projectId;
    if (typeof parent !== 'bigint') return undefined;
    const path = ['taskDetail', 'projectScope'];
    this.ctx.tree.at(path).set(parent);
    return path.join('.');
  }

  /* -------------------------------- title ------------------------------- */

  private titleText(): string {
    const t = this.task?.attributes['title'];
    return typeof t === 'string' ? t : '';
  }

  private renderTitle(): void {
    this.titleHost.replaceChildren();
    if (this.editingTitle) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'task-detail__title-input';
      input.dataset.taskTitleInput = '';
      input.value = this.titleText();
      input.setAttribute('aria-label', 'Task title');
      this.titleHost.append(input);
      this.listen(input, 'keydown', (e) => this.onTitleKeydown(e as KeyboardEvent, input));
      this.listen(input, 'blur', () => this.commitTitle(input.value));
      // Focus + select on the next microtask so the freshly-mounted input takes focus.
      queueMicrotask(() => {
        input.focus();
        input.select?.();
      });
      return;
    }

    const h1 = document.createElement('h1');
    h1.className = 'task-detail__title';
    h1.dataset.taskTitle = '';
    const text = this.titleText();
    h1.textContent = text.length > 0 ? text : `Task #${this.taskId?.toString() ?? ''}`;
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'task-detail__edit-btn';
    edit.dataset.taskTitleEdit = '';
    edit.title = 'Edit title';
    edit.setAttribute('aria-label', 'Edit title');
    edit.append(icon('pencil', 14));
    this.listen(edit, 'click', () => this.startTitleEdit());
    this.titleHost.append(h1, edit);
  }

  private startTitleEdit(): void {
    this.editingTitle = true;
    this.renderTitle();
  }

  private cancelTitleEdit(): void {
    this.editingTitle = false;
    this.renderTitle();
  }

  private onTitleKeydown(e: KeyboardEvent, input: HTMLInputElement): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.cancelTitleEdit();
    } else if (e.key === 'Enter') {
      // Single-line title: bare Enter (and Mod+Enter) commit.
      e.preventDefault();
      this.commitTitle(input.value);
    }
  }

  /** Commit the title via attribute.update (optimistic). No-op on unchanged/empty. */
  private commitTitle(raw: string): void {
    if (!this.editingTitle) return; // blur after a commit already closed the editor
    const next = raw.trim();
    const cur = this.titleText();
    this.editingTitle = false;
    if (next === '' || next === cur) {
      this.renderTitle();
      return;
    }
    // commitAttribute mutates this.task.attributes synchronously via
    // beginCommit + the raw mirror, so the renderTitle() that follows reads
    // the optimistic value immediately.  On a server reject we re-render
    // from the rolled-back task in `commitAttribute`'s onErr (todo: subscribe
    // the title input to the panel store directly — same as AttributeRow).
    this.commitAttribute('title', next);
    this.renderTitle();
  }

  /* ----------------------------- description ---------------------------- */

  private descriptionText(): string {
    const d = this.task?.attributes['description'];
    return typeof d === 'string' ? d : '';
  }

  private renderDescription(): void {
    this.clearDescWarnTimer();
    this.descEditor?.destroy();
    this.descEditor = null;
    this.descHost.replaceChildren();
    // Toggle the label-row action buttons: ✎ when reading, Save + Cancel when
    // editing. The editor NEVER commits on blur — the user can paste back and
    // forth from another window without the draft committing.
    if (this.descEditBtn) this.descEditBtn.style.display = this.editingDescription ? 'none' : '';
    if (this.descSaveBtn) this.descSaveBtn.style.display = this.editingDescription ? '' : 'none';
    if (this.descCancelBtn) this.descCancelBtn.style.display = this.editingDescription ? '' : 'none';

    if (this.editingDescription) {
      this.descEditor = new RichEditor({
        value: this.descriptionText(),
        ariaLabel: `${this.profile.noun} description`,
        linkTargets: () =>
          this.profile.linkSiblings && this.taskId !== null && this.projectId !== undefined
            ? siblingLinkTargets(this.taskId, this.projectId, this.sameTypeRows)
            : [],
        // Read when the Insert menu opens: the page's pictures change as
        // files are attached.
        snippets: () => [
          ...placeholderSnippets(this.profile.placeholders),
          ...(this.profile.insertPictures ? pictureSnippets(this.attachmentsSection?.imageRows?.() ?? []) : []),
        ],
        placeholder: 'Markdown supported · Mod+Enter or Save to commit',
        editableClassName: 'task-detail__desc-input',
        editableAttrs: { 'data-task-desc-input': '' },
        onChange: () => this.queueDescWarnings(),
        onCommit: (md) => this.commitDescription(md),
        onCancel: () => this.cancelDescriptionEdit(),
      });
      this.descHost.append(this.descEditor.el);
      this.paintDescWarnings(this.descriptionText());
      queueMicrotask(() => this.descEditor?.focus());
      return;
    }

    const body = document.createElement('div');
    body.className = 'task-detail__desc-body';
    body.dataset.taskDescBody = '';
    const text = this.descriptionText();
    this.paintDescWarnings(text);
    if (text.length > 0) {
      // The single sanctioned Markdown sink (createElement via DOMSerializer).
      setMarkdown(body, text);
    } else {
      body.classList.add('muted');
      body.textContent = 'No description. Click ✎ to add one.';
    }
    this.descHost.append(body);
  }

  /**
   * List the placeholder problems in `markdown` under the description (none,
   * or a type without placeholders: hidden). Shown while reading and while
   * editing, so a typo shows before the next portal build.
   */
  private paintDescWarnings(markdown: string): void {
    const issues = placeholderIssues(markdown, this.profile.placeholders);
    this.descWarn.replaceChildren();
    this.descWarn.style.display = issues.length === 0 ? 'none' : '';
    if (issues.length === 0) return;
    const list = document.createElement('ul');
    for (const msg of issues) {
      const li = document.createElement('li');
      li.textContent = msg;
      list.append(li);
    }
    this.descWarn.append(list);
  }

  /** Re-check the draft's placeholders once typing pauses. */
  private queueDescWarnings(): void {
    if (this.profile.placeholders.length === 0) return;
    this.clearDescWarnTimer();
    this.descWarnTimer = setTimeout(() => {
      this.descWarnTimer = null;
      if (this.descEditor !== null) this.paintDescWarnings(this.descEditor.getValue());
    }, 300);
  }

  private clearDescWarnTimer(): void {
    if (this.descWarnTimer === null) return;
    clearTimeout(this.descWarnTimer);
    this.descWarnTimer = null;
  }

  private startDescriptionEdit(): void {
    this.editingDescription = true;
    this.renderDescription();
  }

  private cancelDescriptionEdit(): void {
    this.editingDescription = false;
    this.renderDescription();
  }

  /* ------------------------------- hotkeys ------------------------------ */

  /**
   * Task-detail scoped hotkeys (design/hotkeys.md TASK DETAIL scope). The `e _`
   * edit chords + `[`/`]` (and `j`/`k`) prev/next jump nav. The HotkeyController
   * collects these while the TaskDetail is in the active path; the engine now
   * suppresses the chord prefix `e` (and bare `j`/`k`) inside editable elements
   * (the #11 fix), so typing in a field stays literal.
   */
  override hotkeys(): readonly import('../core/hotkeys.js').HotkeyBinding[] {
    const noun = this.profile.noun.toLowerCase();
    return [
      { binding: 'e t', label: 'Edit title', run: () => this.startTitleEdit() },
      { binding: 'e d', label: 'Edit description', run: () => this.startDescriptionEdit() },
      { binding: 'e c', label: 'Add comment', run: () => this.focusComposer() },
      { binding: 'e p', label: 'Set parent', run: () => this.focusSetParent() },
      { binding: '[', label: `Previous ${noun}`, run: () => this.jumpTask(-1) },
      { binding: ']', label: `Next ${noun}`, run: () => this.jumpTask(1) },
      { binding: 'k', label: `Previous ${noun}`, run: () => this.jumpTask(-1) },
      { binding: 'j', label: `Next ${noun}`, run: () => this.jumpTask(1) },
      // Back to the issue list the user came from. The engine suppresses bare
      // `q`/`Escape` while focus is in an input/textarea (so they cancel inline
      // edits / close pickers instead) — this only fires from the screen chrome.
      { binding: ['q', 'Escape'], label: 'Back to list', run: () => this.goBack() },
    ];
  }

  /**
   * `q` / `Esc` / the Back button — return to the SAVED LIST SCREEN the user
   * came from (the inbox / grid / kanban that published `nav.listUrl`), NOT a
   * history step. Walking task→task preserves that URL, so this lands on the
   * original list even after a chain of next/prev jumps. With no saved list (a
   * cold deep-link to `/task/:id`) it falls back to the card's project board
   * (a page's parent may be another page, so this is its enclosing project),
   * or the all-projects list when the project isn't known.
   */
  private goBack(): void {
    const listUrl = taskNavListUrl(this.ctx.tree);
    if (listUrl !== null) {
      navigate(listUrl);
      return;
    }
    const project = this.projectId;
    navigate(typeof project === 'bigint' && project > 0n ? projectUrl(project) : '/projects');
  }

  /* --------------------------- actions menu (…) -------------------------- */

  /** Toggle the "…" overflow menu. Built lazily as a Popover anchored to the
   *  trigger; currently holds the manager/admin-only "Delete forever" item. */
  private toggleActionsMenu(anchor: HTMLElement): void {
    if (this.actionsMenu !== null) {
      this.actionsMenu.destroy();
      this.actionsMenu = null;
      return;
    }
    const menu = new Popover(anchor, { placement: 'bottom-end', width: '12rem', onClose: () => { this.actionsMenu = null; } });
    const panel = menu.element;
    panel.classList.add('task-detail__menu');
    panel.dataset.taskActionsMenu = '';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', `${this.profile.noun} actions`);
    const has = (a: DetailMenuAction): boolean => this.profile.menuActions.includes(a);

    // "Move to project…" — re-parent this task (and its sub-tree) under a
    // different project, clearing per-project classification so it's re-triaged
    // in the destination (server `task.move`). Same manager/admin gate as the
    // menu itself; the bulk-grid surface offers the multi-select equivalent.
    const move = document.createElement('button');
    move.type = 'button';
    move.className = 'task-detail__menu-item';
    move.dataset.taskMove = '';
    move.setAttribute('role', 'menuitem');
    move.textContent = 'Move to project…';
    this.listen(move, 'click', () => {
      menu.destroy();
      this.actionsMenu = null;
      this.openMoveDialog();
    });
    if (has('move')) panel.append(move);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'task-detail__menu-item task-detail__menu-item--danger';
    del.dataset.taskPurge = '';
    del.setAttribute('role', 'menuitem');
    del.textContent = 'Delete forever';
    this.listen(del, 'click', () => {
      menu.destroy();
      this.actionsMenu = null;
      this.openPurgeConfirm();
    });
    if (has('purge')) panel.append(del);

    this.actionsMenu = menu;
    menu.open();
  }

  /**
   * Open the "Move to project" dialog: a project RefPicker + Cancel/Move. On
   * Move it fires `task.move` for the focal task (destination intake status
   * resolved server-side; the user re-classifies in the destination), then
   * navigates to the task in its new project. Mirrors {@link openPurgeConfirm}'s
   * structure and reuses the shared `.bulk-confirm*` dialog styling.
   */
  private openMoveDialog(): void {
    if (this.taskId === null) return;
    this.closeMoveDialog();
    this.moveTargetProject = null;

    const dialog = document.createElement('div');
    dialog.className = 'bulk-confirm';
    dialog.dataset.taskMoveDialog = '';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Move task to project');

    const msg = document.createElement('p');
    msg.className = 'bulk-confirm__msg';
    msg.textContent =
      'Move this task (and any sub-tasks) to another project. ' +
      'Status, milestone, component and tags are cleared so you can re-classify in the destination.';

    const pickerHost = document.createElement('div');
    pickerHost.className = 'bulk-confirm__picker';

    const row = document.createElement('div');
    row.className = 'bulk-confirm__actions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'bulk-confirm__cancel';
    cancel.textContent = 'Cancel';
    this.listen(cancel, 'click', () => this.closeMoveDialog());

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'bulk-confirm__confirm';
    confirm.dataset.taskMoveAccept = '';
    confirm.textContent = 'Move';
    confirm.disabled = true;
    this.listen(confirm, 'click', () => this.doMove());

    // Destination picker — a project RefPicker (global, like the bulk bar's).
    this.movePicker = this.spawn(
      'RefPicker',
      {
        type: 'RefPicker',
        cardType: 'project',
        value: null,
        placeholder: 'Destination project…',
        'aria-label': 'Destination project',
        onChange: (v: bigint | null) => {
          this.moveTargetProject = v;
          confirm.disabled = v === null;
        },
      },
      pickerHost,
    );

    row.append(cancel, confirm);
    dialog.append(msg, pickerHost, row);
    this.el.append(dialog);
    this.moveConfirmEl = dialog;
  }

  private closeMoveDialog(): void {
    if (this.movePicker !== null) {
      this.destroyChild(this.movePicker);
      this.movePicker = null;
    }
    if (this.moveConfirmEl !== null) {
      this.moveConfirmEl.remove();
      this.moveConfirmEl = null;
    }
    this.moveTargetProject = null;
  }

  /** Fire `task.move` for the focal task; navigate to the destination project's
   *  board on success. Server re-checks the manager/admin gate + validates the
   *  move. We leave the detail rather than re-loading it in place: the task's
   *  classification was cleared and its project context changed, and navigating
   *  to the SAME `/task/:id` URL is a no-op (no reload). Landing on the
   *  destination board both guarantees a fresh load and shows where it went. */
  private doMove(): void {
    const taskId = this.taskId;
    const dest = this.moveTargetProject;
    if (taskId === null || dest === null) return;
    this.closeMoveDialog();
    this.ctx.api.callByName(
      GRID_SPEC.taskMove,
      { cardId: taskId, newProjectId: dest },
      () => {
        if (!this.isAlive()) return;
        navigate(projectUrl(dest));
      },
      { alive: () => this.isAlive() },
    );
  }

  /** Open the type-DELETE-to-confirm dialog, then hard-delete via task.purge.
   *  Mirrors the bulk grid's confirm (shares the `.bulk-confirm*` styling). */
  private openPurgeConfirm(): void {
    if (this.taskId === null) return;
    this.closePurgeConfirm();

    const dialog = document.createElement('div');
    dialog.className = 'bulk-confirm';
    dialog.dataset.taskPurgeConfirm = '';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Confirm delete forever');

    const msg = document.createElement('p');
    msg.className = 'bulk-confirm__msg';
    msg.textContent =
      'Permanently delete this task and its comms / messages / attachments? ' +
      'This cannot be undone. Type DELETE to confirm.';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'bulk-confirm__input';
    input.setAttribute('aria-label', 'Type DELETE to confirm');
    input.placeholder = 'DELETE';

    const row = document.createElement('div');
    row.className = 'bulk-confirm__actions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'bulk-confirm__cancel';
    cancel.textContent = 'Cancel';
    this.listen(cancel, 'click', () => this.closePurgeConfirm());

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'bulk-confirm__confirm';
    confirm.dataset.taskPurgeAccept = '';
    confirm.textContent = 'Delete forever';
    confirm.disabled = true;
    this.listen(confirm, 'click', () => this.doPurge());

    this.listen(input, 'input', () => {
      confirm.disabled = input.value.trim() !== 'DELETE';
    });

    row.append(cancel, confirm);
    dialog.append(msg, input, row);
    this.el.append(dialog);
    this.purgeConfirmEl = dialog;
    input.focus();
  }

  private closePurgeConfirm(): void {
    if (this.purgeConfirmEl !== null) {
      this.purgeConfirmEl.remove();
      this.purgeConfirmEl = null;
    }
  }

  /** Fire task.purge for the focal task; navigate back to the source list on
   *  success. Server re-checks the manager/admin gate. */
  private doPurge(): void {
    if (this.taskId === null) return;
    this.closePurgeConfirm();
    this.ctx.api.callByName(
      GRID_SPEC.taskPurge,
      { cardId: this.taskId },
      () => {
        if (!this.isAlive()) return;
        this.goBack();
      },
      { alive: () => this.isAlive() },
    );
  }

  /** `e c` — focus the comment composer (in the #35 comments slot). */
  private focusComposer(): void {
    const ta = this.el.querySelector<HTMLTextAreaElement>('[data-comment-input]');
    ta?.focus();
  }

  /** `e p` — trigger the related panel's Set-parent affordance, if present. */
  private focusSetParent(): void {
    // The related-tasks panel's "+ Set parent" button (correct attr is
    // `data-related-set-parent`; the old `[data-rel-set-parent]` matched nothing,
    // so `e p` was a no-op). Only present when no parent is set yet; clicking it
    // reveals the parent picker.
    const btn = this.el.querySelector<HTMLButtonElement>('[data-related-set-parent]');
    btn?.click();
  }

  /** `[`/`]` (and `j`/`k`) — jump to the prev/next card in the source list the
   *  user came from, on this card type's route (a page stays a page). No-op
   *  when there's no published list / no neighbor (#18). */
  private jumpTask(dir: -1 | 1): void {
    if (this.taskId === null) return;
    const next = taskNavNeighbor(this.ctx.tree, this.taskId, dir);
    if (next !== null) navigate(cardUrl(next, this.profile.route));
  }

  /**
   * Paint the prev/next task nav bubble (right rail, above attributes): a single
   * row — label "Task", value `‹ N of M ›` — from the published `nav.taskList`.
   * The whole bubble hides when there's no list / a single item / the task isn't
   * in it. The arrows reuse jumpTask (same as the `[`/`]` chords) and disable at
   * the ends.
   */
  private paintTaskNav(): void {
    const host = this.taskNavHost;
    host.replaceChildren();
    const list = (this.ctx.tree.at(['nav', 'taskList']).peek<string[]>() ?? []) as string[];
    const idx = this.taskId === null ? -1 : list.indexOf(this.taskId.toString());
    if (idx < 0 || list.length <= 1) {
      host.style.display = 'none';
      return;
    }
    host.style.display = '';

    const row = document.createElement('div');
    row.className = 'task-detail__row task-detail__nav-row';

    const noun = this.profile.noun;
    const label = document.createElement('span');
    label.className = 'task-detail__row-label muted';
    label.textContent = noun;

    const value = document.createElement('span');
    value.className = 'task-detail__row-value task-detail__nav';

    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'task-detail__nav-btn';
    prev.dataset.taskNavPrev = '';
    prev.append(icon('chevron-left', 14));
    prev.title = `Previous ${noun.toLowerCase()} ([)`;
    prev.setAttribute('aria-label', `Previous ${noun.toLowerCase()}`);
    prev.disabled = idx === 0;
    this.listen(prev, 'click', () => this.jumpTask(-1));

    const count = document.createElement('span');
    count.className = 'task-detail__nav-count muted';
    count.dataset.taskNavCount = '';
    count.textContent = `${idx + 1} of ${list.length}`;

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'task-detail__nav-btn';
    next.dataset.taskNavNext = '';
    next.append(icon('chevron-right', 14));
    next.title = `Next ${noun.toLowerCase()} (])`;
    next.setAttribute('aria-label', `Next ${noun.toLowerCase()}`);
    next.disabled = idx === list.length - 1;
    this.listen(next, 'click', () => this.jumpTask(1));

    value.append(prev, count, next);
    row.append(label, value);
    host.append(row);
  }

  private commitDescription(raw: string): void {
    if (!this.editingDescription) return;
    const next = raw;
    const cur = this.descriptionText();
    this.editingDescription = false;
    if (next === cur) {
      this.renderDescription();
      return;
    }
    this.commitAttribute('description', next);
    this.renderDescription();
  }

  /* --------------------------- attribute panel -------------------------- */

  /**
   * Render the attribute side panel by spawning a {@link TaskAttributePanel}
   * — the high-level intent control that owns "render the schema's rows
   * against a single-task PanelModel + live-commit each change."
   *
   * This used to be an inline loop here.  Lifted into its own control per
   * the composition principle (ARCHITECTURE.md §13): a NEW high-level control for
   * each intent ('live' here; deferred / batch live in NewTaskForm /
   * BatchTaskEditor) rather than a `policy` knob on a shared primitive.
   */
  private renderPanel(): void {
    this.disposeRowChildren();
    this.panelBody.replaceChildren();
    if (this.task === null) return;
    const tap = this.spawn(
      'TaskAttributePanel',
      {
        type: 'TaskAttributePanel',
        schema: this.schema,
        panel: this.panel,
        onCommit: (name: string, value: unknown) => this.commitAttribute(name, value),
        forAttr: (attr: AttrSchema) => {
          const out: Record<string, unknown> = {};
          const scope = this.refScopePath(attr);
          if (scope !== undefined) out['parentScopePath'] = scope;
          const pinned = this.selfPinnedFor(attr);
          if (pinned.length > 0) out['pinnedOptions'] = pinned;
          return out;
        },
      },
      this.panelBody,
    );
    this.rowChildren.push(tap);
  }

  /**
   * The "Self" quick-pick for a person-typed card_ref (assignee / originator):
   * the caller's PERSON card id (config override, else `auth.user`). Null when
   * the field isn't a person ref or the account has no linked person — in which
   * case no pinned option is offered. Keyed off `targetCardType`, not a magic
   * attribute name, so any person ref (assignee, originator, …) gets it.
   */
  private selfPinnedFor(attr: AttrSchema): RefPinnedOption[] {
    if (attr.targetCardType !== 'person') return [];
    const personId = this.config.currentPersonId ?? peekCurrentPersonId(this.ctx.tree);
    if (personId === null) return [];
    return [{ value: personId, label: 'Self' }];
  }

  /**
   * The parent-scope tree path for a project-scoped ref editor: the focal
   * task's parent (project) card id, so `card.search` only returns in-project
   * value-cards (mirrors the Svelte screen's per-project ref scope). Person
   * refs (assignee/originator) stay global. We seed the leaf with the task's
   * parent id and return its dotted path; null when no scope applies.
   */
  private refScopePath(attr: AttrSchema): string | undefined {
    const target = attr.targetCardType;
    if (target === undefined || GLOBAL_REF_CARD_TYPES.has(target)) return undefined;
    const parent = this.projectId;
    if (typeof parent !== 'bigint') return undefined;
    const path = ['taskDetail', 'refScope'];
    this.ctx.tree.at(path).set(parent);
    return path.join('.');
  }

  /* ---------------------------- commit + state -------------------------- */

  /**
   * Fire `attribute.update` for one attribute through the {@link PanelModel}
   * lifecycle:
   *
   *   1. `beginCommit(name, value)` — state goes Pending(value). The
   *      AttributeRow's reactive bindings see a STABLE pending state for
   *      the whole round trip (no flicker).
   *   2. server OK → `confirmCommit(name)` (Pending → Value).
   *   3. server NACK → `rejectCommit(name, prev, message)` (Pending →
   *      Error). The row's inline error surfaces; the controls revert.
   *
   * The raw `this.task.attributes` is ALSO mirrored so downstream sections
   * (the TagsEditor seed, the related-tasks-panel seed) reading
   * `this.task.attributes['x']` keep working until they migrate to the
   * panel store too. ARCHITECTURE.md §14 follow-up: drop those mirrors.
   */
  private commitAttribute(name: string, value: unknown): void {
    const task = this.task;
    if (task === null || this.taskId === null) return;
    const prev = task.attributes[name];

    this.panel.beginCommit(name, value);
    task.attributes = { ...task.attributes, [name]: value ?? null };

    // Imperative editors (title / description) re-render off `this.task`, so
    // they need an extra paint on the server-reject path to reflect the
    // rolled-back value.  AttributeRow / FieldEditor read the panel store
    // and re-paint automatically.
    const postRender = (): void => {
      if (name === 'title') this.renderTitle();
      else if (name === 'description') this.renderDescription();
    };

    this.ctx.api.callByName(
      SPEC.attributeUpdate,
      { cardId: this.taskId, attributeName: name, value: value ?? null },
      (_out) => {
        void (_out as AttributeUpdateOutput);
        if (!this.isAlive()) return;
        this.panel.confirmCommit(name);
        // If we just set a card_ref, resolve again to cover ids whose
        // label wasn't loaded yet.
        this.resolveRefLabels();
        // A status change moves the card through its flow — refresh the
        // TransitionBar so the two stay in sync.
        if (name === this.profile.statusAttr) {
          this.transitionBar?.reload();
          this.taskApprovals?.reload();
        }
        // An edit can leave a published copy stale ("Unpublished edits").
        this.pagePublications?.reload();
        // Every attribute edit appends an attr_update row to the stream —
        // refresh the #35 activity feed.
        this.taskComments?.reload();
        this.noteOwnActivity();
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          if (!this.isAlive()) return;
          if (this.task !== null) {
            this.task.attributes = { ...this.task.attributes, [name]: prev };
          }
          this.panel.rejectCommit(name, prev, 'Failed to save. Try again.');
          postRender();
        },
      },
    );
  }

  /* -------------------------------- helpers ----------------------------- */

  /** Build a labelled, empty slot for a later task to drop its control into. */
  private makeSlot(slot: string, label: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'task-detail__slot';
    el.dataset.slot = slot;
    const tag = document.createElement('span');
    tag.className = 'task-detail__slot-label muted';
    tag.textContent = label;
    el.append(tag);
    return el;
  }

  private disposeRowChildren(): void {
    for (const c of this.rowChildren) this.destroyChild(c);
    this.rowChildren = [];
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                    */
/* -------------------------------------------------------------------------- */

/** Parse a route `:id` string to a positive bigint, or null when malformed. */
function parseId(raw: string | undefined): bigint | null {
  if (raw === undefined || raw === '') return null;
  if (!/^\d+$/.test(raw)) return null;
  try {
    const n = BigInt(raw);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

export function registerTaskDetail(): void {
  Control.register('TaskDetail', TaskDetail);
}

/** A callback that runs `then` once it has been called `n` times; with
 *  n = 0, `then` runs at once. Joins reads that go out together. */
function afterAll(n: number, then: () => void): () => void {
  let left = n;
  if (left <= 0) then();
  return () => {
    left--;
    if (left === 0) then();
  };
}
