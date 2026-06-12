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
import { navigate, taskUrl, projectUrl } from '../shell/router.js';
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
import {
  ACTIVITY_POLL_SPEC,
  type ActivityPollInput,
  type ActivityPollOutput,
} from './comment-specs.js';
import type { AttachmentsSection } from './attachments-section.js';
import type { TagsEditor } from './tags-editor.js';
import type { RelatedTasksPanel } from './related-tasks-panel.js';
import type { PostChunk } from './upload.js';
import { icon } from '../ui/icons.js';

/* -------------------------------------------------------------------------- */
/* Config + declaration-merged registry type.                                 */
/* -------------------------------------------------------------------------- */

export interface TaskDetailConfig extends BaseControlConfig {
  type: 'TaskDetail';
  /** The route's `:id` param (string). Parsed to a bigint task id. */
  taskId?: string;
  /** The task's card_type name (drives the attribute schema). Default 'task'. */
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

  /** Read-only status badge in the nav row (next to #id). Phase-toned. */
  private statusBadgeEl!: HTMLElement;
  /** status card id → {label, phase} for the header status badge. */
  private readonly statusInfo = new Map<string, { label: string; phase: string }>();

  /** The open overflow-menu popover, disposed on close / destroy. */
  private actionsMenu: Popover | null = null;
  /** The type-DELETE-to-confirm purge dialog node (built lazily). */
  private purgeConfirmEl: HTMLElement | null = null;

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

  /** Per-row child editors (RefPicker / DatePicker) so we can dispose on rebuild. */
  private rowChildren: Control[] = [];

  constructor(...args: ConstructorParameters<typeof Control<TaskDetailConfig>>) {
    super(...args);
    this.taskId = parseId(this.config.taskId);
    this.cardTypeName = this.config.cardTypeName ?? 'task';
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
    loading.textContent = 'Loading task…';
    loading.setAttribute('aria-live', 'polite');
    this.loadingEl = loading;

    const notFound = document.createElement('div');
    notFound.className = 'task-detail__not-found';
    notFound.dataset.taskDetailNotFound = '';
    notFound.style.display = 'none';
    {
      const title = document.createElement('div');
      title.className = 'task-detail__not-found-title';
      title.textContent = 'Task not found';
      const hint = document.createElement('div');
      hint.className = 'task-detail__not-found-hint muted';
      hint.textContent =
        this.taskId === null
          ? 'No task id in the URL.'
          : `No task with id #${this.taskId.toString()} exists or it was deleted.`;
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

    // "Refresh" — re-fetch the comm threads + comments/activity feed to pick up
    // messages that arrived since load (no polling/long-poll; user-initiated).
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'task-detail__refresh task-detail__refresh--synced';
    refresh.dataset.taskRefresh = '';
    refresh.title = 'Check for new comms & comments';
    refresh.setAttribute('aria-label', 'Refresh comms and comments');
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

    navRight.append(idLine, statusBadge, refresh, actions);
    navRow.append(back, navRight);
    header.append(navRow);

    // Reveal the "…" menu only for manager/admin (reactive — auth lands after
    // the boot /auth/me probe, possibly after this render).
    this.effect(() => {
      const allowed = isAdmin(this.ctx.tree) || hasRole(this.ctx.tree, 'manager');
      actions.style.display = allowed ? '' : 'none';
    }, 'taskDetail.actionsRole');
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
    descSection.append(descLabel, descHost);
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
    rail.append(attachmentsSlot, tagsSlot, relatedSlot);

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
    this.mountAttachments();

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
          this.statusInfo.set(r.id.toString(), { label, phase: r.phase ?? '' });
        }
        this.paintStatusBadge();
      },
      { alive: () => this.isAlive() },
    );
  }

  /** Paint the read-only header status badge from the task's `status` ref and
   *  the loaded status pool. Hidden until both resolve. */
  private paintStatusBadge(): void {
    const el = this.statusBadgeEl;
    if (el === undefined) return;
    const sid = this.task === null ? null : asAttrId(this.task.attributes['status']);
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
        this.schema = full.filter((a) => !PANEL_SKIP_ATTRS.has(a.name));
        if (this.task !== null) this.renderPanel();
      },
      { alive: () => this.isAlive() },
    );
  }

  /**
   * Load the focal task by id. The shared `card.select_with_attributes` spec
   * has no by-id input, so we load the card_type's cards and pick the matching
   * id (parity with the Svelte screen's `pickTaskById`); the row set is small
   * per project and this keeps us on the registered spec. Resolves label
   * lookups for the panel's card_ref summaries once the task is known.
   */
  private loadTask(): void {
    if (this.taskId === null) {
      this.task = null;
      this.showNotFound();
      return;
    }
    this.ctx.api.callByName(
      SPEC.selectWithAttributes,
      { cardTypeName: this.cardTypeName },
      (out) => {
        const rows = (out as SelectWithAttributesOutput).rows ?? [];
        const found = rows.find((r) => r.id === this.taskId) ?? null;
        this.task = found;
        if (found === null) {
          // The id may be a comm card (e.g. a stale link) — comm cards have no
          // task route, so resolve to the owning task and redirect there.
          this.redirectIfCommCard();
          return;
        }
        // Seed the panel store with every attribute's initial Value/Unset.
        // Every subsequent commit drives a Pending → Value/Error transition
        // through `panel.beginCommit / confirmCommit / rejectCommit`.
        this.panel.seedFromAttributes(found.attributes);
        this.showLoaded();
        this.resolveRefLabels();
        this.publishProjectScope();
      },
      { alive: () => this.isAlive() },
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
      { cardTypeName: 'comm' },
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
    const parent = this.task?.parent_card_id;
    if (typeof parent === 'bigint' && parent > 0n) {
      this.ctx.tree.at(['scope', 'projectId']).set(parent);
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
  private resolveRefLabels(): void {
    const task = this.task;
    if (task === null) return;
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
        },
        { alive: () => this.isAlive() },
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
    this.mountComments();
    this.mountComms();
    this.mountAttachments();
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
        statusAttr: 'status',
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
            // refresh the #35 feed so it reflects the move.
            this.taskComments?.reload();
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
  /** Re-fetch the comm threads + the comments/activity feed — the header
   *  "Refresh" button. Both child controls own their own reload() (re-query +
   *  repaint); null-safe before the task has loaded. Also re-seeds the poll
   *  baseline so the "new content" indicator clears back to synced. */
  private refreshFeeds(): void {
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
      ? `${this.pollNewCount} new comm${this.pollNewCount === 1 ? '' : 's'} / comment${this.pollNewCount === 1 ? '' : 's'} — click to load`
      : 'Up to date · click to check for new comms & comments';
  }

  /** Spawn the COMMS (email-thread) control into the `comms` slot. Idempotent. */
  private mountComms(): void {
    if (this.taskId === null) return;
    if (this.commThreads !== null) return;
    this.commsHost.replaceChildren();
    this.commsHost.classList.add('task-detail__slot--filled');
    this.commThreads = this.spawn(
      'CommThreads',
      {
        type: 'CommThreads',
        taskId: this.taskId.toString(),
        projectScopePath: 'scope.projectId',
        // Our own reply / new thread shouldn't trip the "new content" badge.
        onLocalWrite: () => this.noteOwnActivity(),
      },
      this.commsHost,
    ) as CommThreads;
  }

  private mountComments(): void {
    if (this.taskId === null) return;
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
    if (this.taskId === null) return;
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
    if (this.task === null || this.taskId === null) return;
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
    if (this.task === null || this.taskId === null) return;
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
    const parent = this.task?.parent_card_id;
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
        ariaLabel: 'Task description',
        placeholder: 'Markdown supported · Mod+Enter or Save to commit',
        editableClassName: 'task-detail__desc-input',
        editableAttrs: { 'data-task-desc-input': '' },
        onCommit: (md) => this.commitDescription(md),
        onCancel: () => this.cancelDescriptionEdit(),
      });
      this.descHost.append(this.descEditor.el);
      queueMicrotask(() => this.descEditor?.focus());
      return;
    }

    const body = document.createElement('div');
    body.className = 'task-detail__desc-body';
    body.dataset.taskDescBody = '';
    const text = this.descriptionText();
    if (text.length > 0) {
      // The single sanctioned Markdown sink (createElement via DOMSerializer).
      setMarkdown(body, text);
    } else {
      body.classList.add('muted');
      body.textContent = 'No description. Click ✎ to add one.';
    }
    this.descHost.append(body);
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
    return [
      { binding: 'e t', label: 'Edit title', run: () => this.startTitleEdit() },
      { binding: 'e d', label: 'Edit description', run: () => this.startDescriptionEdit() },
      { binding: 'e c', label: 'Add comment', run: () => this.focusComposer() },
      { binding: 'e p', label: 'Set parent', run: () => this.focusSetParent() },
      { binding: '[', label: 'Previous task', run: () => this.jumpTask(-1) },
      { binding: ']', label: 'Next task', run: () => this.jumpTask(1) },
      { binding: 'k', label: 'Previous task', run: () => this.jumpTask(-1) },
      { binding: 'j', label: 'Next task', run: () => this.jumpTask(1) },
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
   * cold deep-link to `/task/:id`) it falls back to the task's project board,
   * or the all-projects list when the parent project isn't known.
   */
  private goBack(): void {
    const listUrl = taskNavListUrl(this.ctx.tree);
    if (listUrl !== null) {
      navigate(listUrl);
      return;
    }
    const parent = this.task?.parent_card_id;
    navigate(typeof parent === 'bigint' && parent > 0n ? projectUrl(parent) : '/projects');
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
    panel.setAttribute('aria-label', 'Task actions');

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
    panel.append(del);

    this.actionsMenu = menu;
    menu.open();
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

  /** `[`/`]` (and `j`/`k`) — jump to the prev/next task in the source list the
   *  user came from. No-op when there's no published list / no neighbor (#18). */
  private jumpTask(dir: -1 | 1): void {
    if (this.taskId === null) return;
    const next = taskNavNeighbor(this.ctx.tree, this.taskId, dir);
    if (next !== null) navigate(taskUrl(next));
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

    const label = document.createElement('span');
    label.className = 'task-detail__row-label muted';
    label.textContent = 'Task';

    const value = document.createElement('span');
    value.className = 'task-detail__row-value task-detail__nav';

    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'task-detail__nav-btn';
    prev.dataset.taskNavPrev = '';
    prev.append(icon('chevron-left', 14));
    prev.title = 'Previous task ([)';
    prev.setAttribute('aria-label', 'Previous task');
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
    next.title = 'Next task (])';
    next.setAttribute('aria-label', 'Next task');
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
    const parent = this.task?.parent_card_id;
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
        if (name === 'status') this.transitionBar?.reload();
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
