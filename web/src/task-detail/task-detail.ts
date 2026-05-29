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
import { setMarkdown } from '../util/markdown-control.js';
import { fitTextarea } from '../util/autosize.js';
import { navigate, taskUrl, projectUrl } from '../shell/router.js';
import { taskNavNeighbor, taskNavListUrl } from '../shell/task-nav.js';
import { SPEC, type SelectWithAttributesOutput, type AttributeUpdateOutput } from '../kanban/specs.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import { CARD_SEARCH_SPEC } from '../ui/specs.js';
import { ADMIN_SPEC, type AttributeDefListOutput } from '../admin/specs.js';
import {
  schemaForCardType,
  type AttrSchema,
} from '../filter/attribute-schema.js';
import type { RefPicker, RefPinnedOption } from '../ui/ref-picker.js';
import { peekCurrentPersonId } from '../auth/auth-state.js';
import type { DatePicker } from '../ui/datepicker.js';
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

  /** The loaded focal task, or null (loading / not found). */
  private task: CardWithAttrs | null = null;
  /** The task card_type's editable attribute schema. */
  private schema: AttrSchema[] = [];
  /** card_ref label cache: stringified id → display label (seeds RefPicker triggers). */
  private readonly refLabels = new Map<string, string>();

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

    // Visible "Back to list" affordance — mirrors the q/Esc chord: returns to
    // the saved source list (inbox/grid/kanban), not a browser-history step.
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'task-detail__back';
    back.dataset.taskBack = '';
    back.title = 'Back to list (q or Esc)';
    back.setAttribute('aria-label', 'Back to list');
    back.textContent = '‹ Back to list';
    this.listen(back, 'click', () => this.goBack());
    header.append(back);

    // "Refresh" — re-fetch the comm threads + comments/activity feed to pick up
    // messages that arrived since load (no polling/long-poll; user-initiated).
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'task-detail__refresh task-detail__refresh--synced';
    refresh.dataset.taskRefresh = '';
    refresh.title = 'Check for new comms & comments';
    refresh.setAttribute('aria-label', 'Refresh comms and comments');
    refresh.textContent = '↻ Refresh';
    this.listen(refresh, 'click', () => this.refreshFeeds());
    header.append(refresh);
    this.refreshBtn = refresh;

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

    const idLine = document.createElement('p');
    idLine.className = 'task-detail__id muted';
    idLine.dataset.taskDetailId = '';
    idLine.textContent = this.taskId === null ? '#—' : `#${this.taskId.toString()}`;

    header.append(headerTop, idLine);
    main.append(header);

    // Description block.
    const descSection = document.createElement('section');
    descSection.className = 'task-detail__desc';
    descSection.dataset.region = 'detail.description';
    // Label row: "DESCRIPTION" + the ✎ edit button sitting right next to the
    // label (not floating in the body). Hidden while editing.
    const descLabel = document.createElement('div');
    descLabel.className = 'task-detail__section-label task-detail__desc-label muted';
    const descLabelText = document.createElement('span');
    descLabelText.textContent = 'DESCRIPTION';
    const descEdit = document.createElement('button');
    descEdit.type = 'button';
    descEdit.className = 'task-detail__edit-btn';
    descEdit.dataset.taskDescEdit = '';
    descEdit.title = 'Edit description';
    descEdit.setAttribute('aria-label', 'Edit description');
    descEdit.textContent = '✎';
    this.listen(descEdit, 'click', () => this.startDescriptionEdit());
    this.descEditBtn = descEdit;
    descLabel.append(descLabelText, descEdit);
    const descHost = document.createElement('div');
    descHost.className = 'task-detail__desc-host';
    this.descHost = descHost;
    descSection.append(descLabel, descHost);
    main.append(descSection);

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

    // Kick off the loads. Zero-promise: the onOk callbacks repaint when each
    // response lands, gated by isAlive() so a torn-down screen never delivers.
    this.loadSchema();
    this.loadTask();
  }

  /* ------------------------------- loads -------------------------------- */

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
          const rows = ((out ?? {}) as { rows?: Array<{ id: bigint; title: string }> }).rows ?? [];
          for (const r of rows) this.refLabels.set(String(r.id), r.title);
          // Re-render the panel so the freshly-resolved labels show.
          if (this.isAlive() && this.task !== null) this.renderPanel();
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
    if (this.task === null || this.taskId === null) return;
    if (this.transitionBar !== null) return;
    const bar = this.spawn(
      'TransitionBar',
      {
        type: 'TransitionBar',
        cardId: this.taskId.toString(),
        statusAttr: 'status',
        onChanged: (toCardId: bigint, attributeName: string) => {
          // Mirror the optimistic move into the loaded task + repaint the
          // panel's status summary; the bar reloads its own steps.
          if (this.task !== null) {
            this.task.attributes = {
              ...this.task.attributes,
              [attributeName]: toCardId,
            };
          }
          if (this.isAlive()) {
            this.renderPanel();
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
    btn.textContent = fresh ? `↻ ${this.pollNewCount} new` : '↻ Refresh';
    btn.title = fresh
      ? `${this.pollNewCount} new comm${this.pollNewCount === 1 ? '' : 's'} / comment${this.pollNewCount === 1 ? '' : 's'} — click to load`
      : 'Up to date · click to check for new comms & comments';
  }

  /** Spawn the COMMS (email-thread) control into the `comms` slot. Idempotent. */
  private mountComms(): void {
    if (this.task === null || this.taskId === null) return;
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
    if (this.task === null || this.taskId === null) return;
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
    if (this.task === null || this.taskId === null) return;
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
        if (this.isAlive()) {
          this.renderPanel();
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
      onChanged: (parentTaskId: bigint | null, relationship: string | null) => {
        if (this.task !== null) {
          this.task.attributes = {
            ...this.task.attributes,
            parent_task: parentTaskId ?? null,
            parent_relationship: relationship ?? null,
          };
        }
        if (this.isAlive()) {
          this.renderPanel();
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
    edit.textContent = '✎';
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
    this.commitAttribute('title', next, () => this.renderTitle());
  }

  /* ----------------------------- description ---------------------------- */

  private descriptionText(): string {
    const d = this.task?.attributes['description'];
    return typeof d === 'string' ? d : '';
  }

  private renderDescription(): void {
    this.descHost.replaceChildren();
    // The label-row ✎ is hidden while editing (the textarea is the affordance).
    if (this.descEditBtn) this.descEditBtn.style.display = this.editingDescription ? 'none' : '';
    if (this.editingDescription) {
      const ta = document.createElement('textarea');
      ta.className = 'task-detail__desc-input';
      ta.dataset.taskDescInput = '';
      ta.value = this.descriptionText();
      ta.rows = 3; // a floor; the field auto-grows with content (fitTextarea)
      ta.setAttribute('aria-label', 'Task description');
      ta.placeholder = 'Markdown supported · Mod+Enter to save';
      this.descHost.append(ta);
      this.listen(ta, 'keydown', (e) => this.onDescriptionKeydown(e as KeyboardEvent, ta));
      this.listen(ta, 'blur', () => this.commitDescription(ta.value));
      this.listen(ta, 'input', () => fitTextarea(ta));
      queueMicrotask(() => {
        ta.focus();
        fitTextarea(ta);
      });
      return;
    }

    const body = document.createElement('div');
    body.className = 'task-detail__desc-body';
    body.dataset.taskDescBody = '';
    const text = this.descriptionText();
    if (text.length > 0) {
      // The single sanctioned innerHTML sink (renderMarkdown → DOMPurify).
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
    prev.textContent = '‹';
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
    next.textContent = '›';
    next.title = 'Next task (])';
    next.setAttribute('aria-label', 'Next task');
    next.disabled = idx === list.length - 1;
    this.listen(next, 'click', () => this.jumpTask(1));

    value.append(prev, count, next);
    row.append(label, value);
    host.append(row);
  }

  private onDescriptionKeydown(e: KeyboardEvent, ta: HTMLTextAreaElement): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.cancelDescriptionEdit();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      this.commitDescription(ta.value);
    }
    // Bare Enter inserts a newline (textarea default).
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
    this.commitAttribute('description', next, () => this.renderDescription());
  }

  /* --------------------------- attribute panel -------------------------- */

  /**
   * Render the attribute side panel: one row per editable attribute. Each row
   * is a `<details>` with a read summary; expanding it mounts the inline editor
   * chosen by value_type. Rebuilds wholesale (disposing prior row children) so
   * a re-render after a commit / late label resolution is clean.
   */
  private renderPanel(): void {
    this.disposeRowChildren();
    this.panelBody.replaceChildren();
    if (this.task === null) return;
    if (this.schema.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'task-detail__panel-empty muted';
      empty.textContent = 'No attributes available.';
      this.panelBody.append(empty);
      return;
    }
    for (const attr of this.schema) {
      this.panelBody.append(this.renderRow(attr));
    }
  }

  private renderRow(attr: AttrSchema): HTMLElement {
    const row = document.createElement('details');
    row.className = 'task-detail__row';
    row.dataset.attrRow = attr.name;

    const summary = document.createElement('summary');
    summary.className = 'task-detail__row-summary';

    const label = document.createElement('span');
    label.className = 'task-detail__row-label muted';
    label.textContent = attr.label;

    const value = document.createElement('span');
    value.className = 'task-detail__row-value';
    value.dataset.attrValue = '';
    value.textContent = this.summaryFor(attr);

    summary.append(label, value);
    row.append(summary);

    const editor = document.createElement('div');
    editor.className = 'task-detail__row-editor';
    editor.dataset.attrEditor = '';
    row.append(editor);

    const errEl = document.createElement('p');
    errEl.className = 'task-detail__row-error';
    errEl.dataset.attrError = '';
    errEl.setAttribute('role', 'alert');
    errEl.style.display = 'none';
    editor.append(errEl);

    // "Unassign" — clears this attribute to null on the focal task, mirroring
    // the bulk-bar's Unassign action. Always rendered (so the row consistently
    // exposes the affordance) and disabled when the field already has no value;
    // bool stays read/write via its checkbox and skips this (its semantics
    // distinguish true / false but not "unset"). Sits at the editor's bottom so
    // the value editor mounts above it.
    const unassign = this.buildUnassignButton(attr, value, errEl);
    if (unassign !== null) editor.append(unassign);

    // Mount the inline editor lazily on first expand so a closed panel doesn't
    // spin up N RefPickers / DatePickers (each fires card.search on open).
    let mounted = false;
    this.listen(row, 'toggle', () => {
      if ((row as unknown as { open?: boolean }).open !== true) return;
      if (mounted) return;
      mounted = true;
      this.mountEditor(attr, editor, value, errEl);
      // Keep the Unassign button at the bottom of the editor even after the
      // value editor mounts its own children (mountEditor appends to `editor`).
      if (unassign !== null) editor.append(unassign);
    });

    return row;
  }

  /**
   * Build the per-row "Unassign" button — fires `attribute.update` with
   * value=null on the focal task. Returns null for attribute types where
   * un-assigning is meaningless (bool: the checkbox already toggles between
   * its two well-defined states). Enabled state tracks whether the attribute
   * currently has a meaningful value to clear.
   */
  private buildUnassignButton(
    attr: AttrSchema,
    valueEl: HTMLElement,
    errEl: HTMLElement,
  ): HTMLButtonElement | null {
    if (attr.valueType === 'bool') return null;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'task-detail__row-unassign';
    btn.dataset.attrUnassign = '';
    btn.textContent = 'Unassign';
    btn.title = `Clear ${attr.label.toLowerCase()} on this task`;
    btn.disabled = !this.hasMeaningfulValue(attr);
    this.listen(btn, 'click', (ev) => {
      // The row is a <details>; bare click bubbles to its <summary> and toggles
      // it. Stop here so a click on the button doesn't fold the row closed.
      (ev as Event).stopPropagation();
      this.commitAttribute(attr.name, null, () => {
        valueEl.textContent = this.summaryFor(attr);
        btn.disabled = !this.hasMeaningfulValue(attr);
      }, errEl);
    });
    return btn;
  }

  /** Whether an attribute currently holds a meaningful (non-empty) value — the
   *  "Unassign" button is disabled when there's nothing to clear. */
  private hasMeaningfulValue(attr: AttrSchema): boolean {
    const v = this.task?.attributes[attr.name];
    if (v === null || v === undefined || v === '') return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return true;
  }

  /** Build a printed read-summary for an attribute's current value. The card_ref
   *  cases coerce via {@link asAttrId} so an un-revived wire form (digit-string
   *  / number) renders its resolved label like a bigint would — uniform across
   *  every card_ref attribute (originator, assignee, status, …). */
  private summaryFor(attr: AttrSchema): string {
    const v = this.task?.attributes[attr.name];
    if (v === null || v === undefined || v === '') return '—';
    if (attr.valueType === 'card_ref') {
      const id = asAttrId(v);
      return id !== null ? this.labelFor(id) : '—';
    }
    if (attr.valueType === 'card_ref[]') {
      if (!Array.isArray(v) || v.length === 0) return '—';
      const labels: string[] = [];
      for (const raw of v) {
        const id = asAttrId(raw);
        if (id !== null) labels.push(this.labelFor(id));
      }
      return labels.length > 0 ? labels.join(', ') : '—';
    }
    if (attr.valueType === 'bool') return v === true ? 'Yes' : 'No';
    if (typeof v === 'bigint') return v.toString();
    return String(v);
  }

  private labelFor(id: bigint): string {
    return this.refLabels.get(String(id)) ?? `#${id.toString()}`;
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
   * Mount the inline editor for an attribute by value_type. Eager-commit types
   * (card_ref / card_ref[] / date / bool) fire `attribute.update` straight from
   * their change callback; text / number hold the typed draft and commit on
   * blur or Enter.
   */
  private mountEditor(
    attr: AttrSchema,
    editor: HTMLElement,
    valueEl: HTMLElement,
    errEl: HTMLElement,
  ): void {
    const cur = this.task?.attributes[attr.name];
    const onDone = (): void => {
      valueEl.textContent = this.summaryFor(attr);
    };
    const onCommit = (next: unknown): void => {
      this.commitAttribute(attr.name, next, onDone, errEl);
    };

    switch (attr.valueType) {
      case 'card_ref': {
        const curId = asAttrId(cur);
        const rp = this.spawn(
          'RefPicker',
          {
            type: 'RefPicker',
            cardType: attr.targetCardType ?? 'card',
            value: curId,
            ...(curId !== null ? { currentLabel: this.labelFor(curId) } : {}),
            ...(this.refScopePath(attr) ? { parentScopePath: this.refScopePath(attr) } : {}),
            ...(this.selfPinnedFor(attr).length > 0 ? { pinnedOptions: this.selfPinnedFor(attr) } : {}),
            'aria-label': attr.label,
            placeholder: `Search ${attr.label.toLowerCase()}…`,
            onChange: (value: bigint | null) => onCommit(value),
          },
          editor,
        ) as RefPicker;
        this.rowChildren.push(rp);
        // Open the picker immediately — the row was expanded specifically to
        // edit it, so skip the extra click to drop the dropdown (#8).
        queueMicrotask(() => {
          if (this.isAlive()) rp.open();
        });
        break;
      }
      case 'card_ref[]': {
        const cur2: bigint[] = [];
        if (Array.isArray(cur)) {
          for (const raw of cur) {
            const id = asAttrId(raw);
            if (id !== null) cur2.push(id);
          }
        }
        const labels: Record<string, string> = {};
        for (const id of cur2) labels[String(id)] = this.labelFor(id);
        const rp = this.spawn(
          'RefPicker',
          {
            type: 'RefPicker',
            cardType: attr.targetCardType ?? 'card',
            multi: true,
            values: cur2,
            currentLabels: labels,
            ...(this.refScopePath(attr) ? { parentScopePath: this.refScopePath(attr) } : {}),
            'aria-label': attr.label,
            placeholder: `Search ${attr.label.toLowerCase()}…`,
            onChangeMulti: (values: bigint[]) => onCommit(values),
          },
          editor,
        ) as RefPicker;
        this.rowChildren.push(rp);
        // Open the picker immediately — the row was expanded specifically to
        // edit it, so skip the extra click to drop the dropdown (#8).
        queueMicrotask(() => {
          if (this.isAlive()) rp.open();
        });
        break;
      }
      case 'date': {
        const dp = this.spawn(
          'DatePicker',
          {
            type: 'DatePicker',
            value: typeof cur === 'string' ? cur : null,
            'aria-label': attr.label,
            onChange: (value: string | null) => onCommit(value),
          },
          editor,
        ) as DatePicker;
        this.rowChildren.push(dp);
        // Drop the calendar immediately on expand (#8).
        queueMicrotask(() => {
          if (this.isAlive()) dp.openMenu();
        });
        break;
      }
      case 'bool': {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'task-detail__row-checkbox';
        box.dataset.attrCheckbox = '';
        box.checked = cur === true;
        box.setAttribute('aria-label', attr.label);
        this.listen(box, 'change', () => onCommit(box.checked));
        editor.append(box);
        break;
      }
      case 'number': {
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'task-detail__row-number';
        input.dataset.attrInput = '';
        input.value = typeof cur === 'number' ? String(cur) : '';
        input.setAttribute('aria-label', attr.label);
        const commit = (): void => {
          const raw = input.value.trim();
          const next: unknown = raw === '' ? null : Number(raw);
          if (next !== null && !Number.isFinite(next as number)) return;
          onCommit(next);
        };
        this.listen(input, 'keydown', (e) => {
          if ((e as KeyboardEvent).key === 'Enter') {
            (e as KeyboardEvent).preventDefault();
            commit();
          }
        });
        this.listen(input, 'blur', () => commit());
        editor.append(input);
        queueMicrotask(() => {
          if (this.isAlive()) input.focus();
        });
        break;
      }
      default: {
        // text + any unknown value_type fall through to a text input.
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'task-detail__row-text';
        input.dataset.attrInput = '';
        input.value = typeof cur === 'string' ? cur : cur === null || cur === undefined ? '' : String(cur);
        input.setAttribute('aria-label', attr.label);
        const commit = (): void => onCommit(input.value);
        this.listen(input, 'keydown', (e) => {
          if ((e as KeyboardEvent).key === 'Enter') {
            (e as KeyboardEvent).preventDefault();
            commit();
          }
        });
        this.listen(input, 'blur', () => commit());
        editor.append(input);
        queueMicrotask(() => {
          if (this.isAlive()) input.focus();
        });
        break;
      }
    }
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
   * Fire `attribute.update` for one attribute, OPTIMISTICALLY: patch the loaded
   * task's attribute immediately, call `onDone` (re-paint the read summary /
   * editor), and roll back + surface the error inline (and via the central
   * funnel) on fault. Zero-promise — routes through `api.callByName`.
   */
  private commitAttribute(
    name: string,
    value: unknown,
    onDone: () => void,
    errEl?: HTMLElement,
  ): void {
    const task = this.task;
    if (task === null || this.taskId === null) return;
    const prev = task.attributes[name];
    // Optimistic local patch.
    task.attributes = { ...task.attributes, [name]: value ?? null };
    if (errEl) {
      errEl.style.display = 'none';
      errEl.textContent = '';
    }
    onDone();

    this.ctx.api.callByName(
      SPEC.attributeUpdate,
      { cardId: this.taskId, attributeName: name, value: value ?? null },
      (_out) => {
        void (_out as AttributeUpdateOutput);
        // Server confirmed; the optimistic patch stands. If we just set a
        // card_ref, the freshly-picked label is already cached by the RefPicker
        // search, but resolve again to cover ids whose label wasn't loaded.
        if (!this.isAlive()) return;
        this.resolveRefLabels();
        // A status change from the panel moves the card through its flow — tell
        // the TransitionBar to re-load its available steps so the two stay in
        // sync (the bar owns the canonical status changer).
        if (name === 'status') this.transitionBar?.reload();
        // Every attribute edit appends an attr_update row to the stream —
        // refresh the #35 activity feed so it reflects the change.
        this.taskComments?.reload();
        this.noteOwnActivity();
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          // Roll back the optimistic patch and surface the error inline; the
          // central funnel (onError default) already showed the toast.
          if (!this.isAlive()) return;
          if (this.task !== null) {
            this.task.attributes = { ...this.task.attributes, [name]: prev };
          }
          onDone();
          if (errEl) {
            errEl.style.display = '';
            errEl.textContent = 'Failed to save. Try again.';
          }
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

/**
 * Coerce a wire-side card_ref attribute value to bigint, or null when absent /
 * malformed. The dispatcher's id-revival is hand-keyed by attribute name
 * (see `core/dispatch.ts` CARD_REF_ATTR_KEYS) so an un-primed card_ref attr
 * (e.g. `originator`) arrives as a digit-string. Every TaskDetail consumer that
 * reads a card_ref attribute funnels through this helper so the panel's label
 * resolution, summary rendering, and editor seeding all apply the SAME tolerant
 * rule — fixing originator (and any future card_ref attr) without a one-off
 * registration per name.
 */
function asAttrId(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) {
    try {
      const n = BigInt(v);
      return n > 0n ? n : null;
    } catch {
      return null;
    }
  }
  return null;
}

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
