/**
 * QuickEntry — the global `n` fast-task-create overlay.
 *
 * The `n` shortcut from any task screen (Inbox / Kanban / Grid / Project) lands
 * here. The fast path is "type a title, press Enter"; everything else hides
 * behind "+ More details". Layout:
 *   - ALWAYS visible: Title input (auto-focused) + Description textarea.
 *   - "+ More details" disclosure reveals:
 *       · Assignee (single RefPicker over `user` / the configured card_type),
 *       · Tags (multi RefPicker over the project's `tag` cards),
 *       · an attachment dropzone (uses the shared {@link uploadFile} service),
 *       · "+ Add field" — pick any editable attribute from the palette and edit
 *         its value inline (RefPicker for card_ref(s), DatePicker for dates,
 *         text/number/checkbox otherwise).
 *
 * Submission (web/design parity):
 *   - Plain Enter in the title  → submit + KEEP the overlay open (clear, refocus
 *     title for the next entry).
 *   - Mod+Enter (anywhere)      → submit + CLOSE.
 *   - Esc                       → cancel (close without submitting).
 * Attachments pre-upload to CAS via {@link uploadFile} BEFORE the batch fires;
 * once every file has an id, card.insert + tag.apply + attachment.create are
 * issued in ONE dispatcher tick (one batch, one transaction — see
 * {@link submitQuickEntry}). On success a toast with an Undo button (fires
 * `card.delete` on the new task) shows; the optimistic where-it-makes-sense is
 * the toast appearing instantly + Enter clearing for the next entry.
 *
 * Default-create-status: resolved via {@link resolveDefaultCreateStatus} —
 * screen.default_create_status → flow default → first triage → first active.
 * The candidate statuses + the screen card + the flow row are read from the
 * tree paths the host seeds (see {@link QuickEntryConfig}); the parent is
 * scoped to the current project (`scope.projectId`).
 *
 * ZERO-PROMISE control surface: the submit goes through `api.callByName`; the
 * upload goes through `uploadFile`'s callback API. No `.then` / `await` here.
 *
 * It is DOM-driven (open()/close() toggle display) — like the HelpOverlay — so
 * it never feeds a reactive cascade. The AppShell mounts ONE instance and wires
 * the `quickCreateOpen` intent to open() (the `n` hotkey + the screen `+`
 * affordances raise that intent).
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { splitPath, type QueryBinding } from '../core/data.js';
import type { ApiFault } from '../core/dispatch.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import type { AttrSchema } from '../filter/attribute-schema.js';
import { prepareFile, type PostChunk } from '../task-detail/upload.js';
import { trapFocus } from '../util/focus-trap.js';
import type { RefPicker } from '../ui/ref-picker.js';
import type { DatePicker } from '../ui/datepicker.js';
import {
  resolveDefaultCreateStatus,
  type FlowRow,
} from './default-status.js';
import type { PhaseToggle } from '../filter/screen-resolve.js';
import type { Phase } from '../filter/predicate.js';
import {
  resolveParentForInsert,
  submitQuickEntry,
  undoQuickEntry,
  type NamedAttribute,
  type QuickEntryPrefill,
  type QuickEntrySubmitInput,
} from './submission.js';
import { navigate, taskUrl } from '../shell/router.js';

/* -------------------------------------------------------------------------- */
/* Config + declaration-merged registry type.                                 */
/* -------------------------------------------------------------------------- */

export interface QuickEntryConfig extends BaseControlConfig {
  type: 'QuickEntry';
  /** The card_type the overlay creates. Default 'task'. */
  defaultCardType?: string;
  /**
   * Tree path holding the active project id (bigint | null) — the parent the
   * new task is scoped to. Default 'scope.projectId'.
   */
  projectScopePath?: string;
  /**
   * Tree path the candidate status cards live at (CardWithAttrs[] with `phase`
   * + `sort_order`) for the default-create-status chain's triage/active fallback.
   * Optional — absent skips steps 3-4 of the chain.
   */
  candidateStatusesPath?: string;
  /**
   * Tree path the active screen card lives at (CardWithAttrs) for
   * `screen.default_create_status` (step 1). Optional.
   */
  screenCardPath?: string;
  /**
   * Tree path the active flow row lives at ({@link FlowRow}) for the per-flow
   * default (step 2). Optional.
   */
  flowPath?: string;
  /**
   * Tree path the active screen's phase toggles live at ({@link PhaseToggle}[])
   * for the base-phase default (step 3). Default 'screen.phaseToggles' — the
   * leaf the ScreenHost seeds for the active screen.
   */
  phaseTogglesPath?: string;
  /** The card_type the assignee RefPicker searches. Default 'user'. */
  assigneeCardType?: string;
  /** The card_type the tags RefPicker searches. Default 'tag'. */
  tagCardType?: string;
  /**
   * The "+ Add field" attribute palette ({@link AttrSchema}[]). When empty the
   * palette button is disabled. Title / description / assignee / tags / status
   * are filtered out (the overlay manages them already).
   */
  attributePalette?: AttrSchema[];
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    QuickEntry: QuickEntryConfig;
  }
}

/** A pending attachment the user has queued; uploaded on submit. */
interface PendingAttachment {
  id: number;
  file: File;
  status: 'queued' | 'uploading' | 'ready' | 'error';
  fileId?: bigint;
  error?: string;
}

/** A user-added "+ Add field" row: the attribute + its current value + editor. */
interface AttrRow {
  id: number;
  name: string | null;
  value: unknown;
  /** The spawned inline editor (RefPicker / DatePicker), if any. */
  editor: Control | null;
  /** The row's DOM container so we can re-render its editor in place. */
  el: HTMLElement;
  /** The value host the editor / input mounts into. */
  valueHost: HTMLElement;
}

/** Names the overlay manages itself — hidden from the "+ Add field" palette. */
const WELL_KNOWN_ATTRS = new Set<string>(['title', 'description', 'tags', 'assignee', 'status']);

/* -------------------------------------------------------------------------- */
/* Control.                                                                    */
/* -------------------------------------------------------------------------- */

/** Default tree path the status-candidate cards land at (the chain's fallback). */
const DEFAULT_CANDIDATE_STATUSES_PATH = 'quickEntry.candidateStatuses';
/** Default tree path the active screen's phase toggles land at (base-phase step). */
const DEFAULT_PHASE_TOGGLES_PATH = 'screen.phaseToggles';

export class QuickEntry extends Control<QuickEntryConfig> {
  /**
   * CLASS-STATIC query: load the in-scope project's `status` cards WITH their
   * attributes (so each carries `phase` + `sort_order`) for the default-create-
   * status chain's triage/active fallback (steps 3-4). Lands at
   * `quickEntry.candidateStatuses`; refires on project switch; stays idle until
   * a project resolves. (Steps 1-2 — the screen / flow default — are read from
   * the `screenCardPath` / `flowPath` leaves the host seeds.)
   */
  static override queries: readonly QueryBinding[] = [
    {
      name: 'quickEntryStatuses',
      spec: 'card.select_with_attributes',
      when: { signal: 'scope.projectId' },
      input: {
        cardTypeName: { lit: 'status' },
        parentCardId: { from: 'scope.projectId' },
      },
      skipWhenNull: ['parentCardId'],
      result: { method: 'landStatusCandidates' },
      onError: 'self',
    },
  ];

  private opened = false;
  /** Focus-trap disposer while the overlay is open (#29). */
  private untrap: (() => void) | null = null;
  private submitting = false;
  private detailsOpen = false;

  /** Prefill threaded by the opener (kanban column `+` pins a lane axis). */
  private prefill: QuickEntryPrefill | null = null;
  /** Per-open parent override (the project-layout "+ New task" passes the project). */
  private parentOverride: bigint | null = null;

  private assigneeId: bigint | null = null;
  private tagIds: bigint[] = [];
  private attrRows: AttrRow[] = [];
  private nextRowId = 1;
  private pendingAttachments: PendingAttachment[] = [];
  private nextAttId = 1;

  /** DOM handles built once in render(). */
  private panelEl: HTMLElement | null = null;
  private titleInput: HTMLInputElement | null = null;
  private descInput: HTMLTextAreaElement | null = null;
  private moreBtn: HTMLButtonElement | null = null;
  private moreRegion: HTMLElement | null = null;
  private errorEl: HTMLElement | null = null;
  private assigneeHost: HTMLElement | null = null;
  private tagsHost: HTMLElement | null = null;
  private attachListEl: HTMLElement | null = null;
  private attrRowsEl: HTMLElement | null = null;
  private addFieldBtn: HTMLButtonElement | null = null;
  private submittingEl: HTMLElement | null = null;
  private lastFocused: Element | null = null;

  /** Spawned pickers cleared on close so a re-open starts fresh. */
  private assigneePicker: RefPicker | null = null;
  private tagsPicker: RefPicker | null = null;

  /** The success-toast singleton (built lazily on first success). */
  private toast: SuccessToast | null = null;

  /** Injected chunk-POST sink for tests (the default fetch sink otherwise). */
  private postChunkOverride: PostChunk | null = null;

  private get cardType(): string {
    return this.config.defaultCardType ?? 'task';
  }
  private get assigneeCardType(): string {
    return this.config.assigneeCardType ?? 'user';
  }
  private get tagCardType(): string {
    return this.config.tagCardType ?? 'tag';
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'qe-overlay';
    el.dataset.control = 'QuickEntry';
    el.style.display = 'none';
    return el;
  }

  protected render(): void {
    // Land the project's status cards (full rows, with phase) for the chain's
    // triage/active fallback. A one-way tree write outside any tracked effect.
    this.handler('landStatusCandidates', (out) => {
      const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
      const path = this.config.candidateStatusesPath ?? DEFAULT_CANDIDATE_STATUSES_PATH;
      this.ctx.tree.at(splitPath(path)).set(rows);
    });

    const root = this.el;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Quick entry');

    // Backdrop scrim — a click closes (when not mid-submit).
    const backdrop = document.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'qe-overlay__backdrop';
    backdrop.dataset.qeBackdrop = '';
    backdrop.setAttribute('aria-label', 'Close quick entry');
    backdrop.tabIndex = -1;
    this.listen(backdrop, 'click', () => this.requestClose());

    const panel = document.createElement('div');
    panel.className = 'qe-overlay__panel';
    panel.dataset.qePanel = '';
    this.panelEl = panel;
    // Mod+Enter / Esc anywhere in the panel (assignee combobox, footer, etc.).
    this.listen(panel, 'keydown', (ev) => this.onPanelKeydown(ev as KeyboardEvent));

    /* ------------------------------- header ------------------------------ */
    const header = document.createElement('div');
    header.className = 'qe-overlay__header';
    const heading = document.createElement('h2');
    heading.className = 'qe-overlay__title';
    heading.dataset.qeHeading = '';
    heading.textContent = `New ${this.cardType}`;
    header.append(heading);

    /* -------------------------------- body ------------------------------- */
    const body = document.createElement('div');
    body.className = 'qe-overlay__body scroll-y';

    const error = document.createElement('div');
    error.className = 'qe-overlay__error';
    error.dataset.qeError = '';
    error.setAttribute('role', 'alert');
    error.style.display = 'none';
    this.errorEl = error;

    // Title.
    const titleField = labeledField('Title');
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'qe-overlay__input';
    titleInput.dataset.qeTitle = '';
    titleInput.placeholder = 'Title';
    titleInput.setAttribute('autocomplete', 'off');
    titleField.append(titleInput);
    this.titleInput = titleInput;
    this.listen(titleInput, 'keydown', (ev) => this.onTitleKeydown(ev as KeyboardEvent));

    // Description.
    const descField = labeledField('Description');
    const descInput = document.createElement('textarea');
    descInput.className = 'qe-overlay__input qe-overlay__textarea';
    descInput.dataset.qeDescription = '';
    descInput.rows = 3;
    descInput.placeholder = 'Description (optional)';
    descField.append(descInput);
    this.descInput = descInput;
    this.listen(descInput, 'keydown', (ev) => this.onDescriptionKeydown(ev as KeyboardEvent));

    // "+ More details" disclosure.
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'qe-overlay__more';
    more.dataset.qeMore = '';
    more.textContent = '+ More details';
    this.moreBtn = more;
    this.listen(more, 'click', () => this.toggleDetails());

    const moreRegion = this.buildMoreRegion();
    this.moreRegion = moreRegion;
    moreRegion.style.display = 'none';

    body.append(error, titleField, descField, more, moreRegion);

    /* ------------------------------- footer ------------------------------ */
    const footer = document.createElement('div');
    footer.className = 'qe-overlay__footer';

    const hint = document.createElement('div');
    hint.className = 'qe-overlay__hint muted';
    hint.dataset.qeHint = '';
    hint.textContent = 'Enter to add another · Mod+Enter to add and close · Esc to cancel';

    const submitting = document.createElement('span');
    submitting.className = 'qe-overlay__saving';
    submitting.dataset.qeSaving = '';
    submitting.textContent = 'Saving…';
    submitting.style.display = 'none';
    this.submittingEl = submitting;

    const buttons = document.createElement('div');
    buttons.className = 'qe-overlay__buttons';
    const another = document.createElement('button');
    another.type = 'button';
    another.className = 'btn qe-overlay__another';
    another.dataset.qeAddAnother = '';
    another.textContent = 'Add & Another';
    // "Save & Edit" — creates the task AND navigates to its detail view so the
    // user can fill in the rest. Closes the overlay on the navigate (the detail
    // screen mounts on the new route).
    const addEdit = document.createElement('button');
    addEdit.type = 'button';
    addEdit.className = 'btn qe-overlay__edit';
    addEdit.dataset.qeAddEdit = '';
    addEdit.textContent = 'Save & Edit';
    addEdit.title = 'Save and open this task in the detail view';
    const addClose = document.createElement('button');
    addClose.type = 'button';
    addClose.className = 'btn btn-primary qe-overlay__close';
    addClose.dataset.qeAddClose = '';
    addClose.textContent = 'Add & Close';
    buttons.append(another, addEdit, addClose);
    this.listen(another, 'click', () => this.submit(false));
    this.listen(addEdit, 'click', () => this.submit(true, true));
    this.listen(addClose, 'click', () => this.submit(true));

    const hintRow = document.createElement('div');
    hintRow.className = 'qe-overlay__hint-row';
    hintRow.append(hint, submitting);
    footer.append(hintRow, buttons);

    panel.append(header, body, footer);
    root.append(backdrop, panel);
  }

  /** Build the "+ More details" region (assignee / tags / attachments / add-field). */
  private buildMoreRegion(): HTMLElement {
    const region = document.createElement('div');
    region.className = 'qe-overlay__more-region';
    region.dataset.qeMoreRegion = '';

    // Assignee (single RefPicker, spawned on first expand).
    const assigneeField = labeledField('Assignee');
    assigneeField.dataset.qeAssigneeField = '';
    const assigneeHost = document.createElement('div');
    assigneeHost.className = 'qe-overlay__picker';
    assigneeHost.dataset.qeAssignee = '';
    assigneeField.append(assigneeHost);
    this.assigneeHost = assigneeHost;

    // Tags (multi RefPicker).
    const tagsField = labeledField('Tags');
    tagsField.dataset.qeTagsField = '';
    const tagsHost = document.createElement('div');
    tagsHost.className = 'qe-overlay__picker';
    tagsHost.dataset.qeTags = '';
    tagsField.append(tagsHost);
    this.tagsHost = tagsHost;

    // Attributes ("+ Add field").
    const attrsWrap = document.createElement('div');
    attrsWrap.className = 'qe-overlay__attrs';
    attrsWrap.dataset.qeAttributes = '';
    const attrsHead = document.createElement('div');
    attrsHead.className = 'qe-overlay__attrs-head';
    const attrsLabel = document.createElement('span');
    attrsLabel.className = 'qe-overlay__label';
    attrsLabel.textContent = 'Attributes';
    const addField = document.createElement('button');
    addField.type = 'button';
    addField.className = 'qe-overlay__add-field';
    addField.dataset.qeAddField = '';
    addField.textContent = '+ Add field';
    this.addFieldBtn = addField;
    this.listen(addField, 'click', () => this.addAttrRow());
    attrsHead.append(attrsLabel, addField);
    const attrRowsEl = document.createElement('div');
    attrRowsEl.className = 'qe-overlay__attr-rows';
    attrRowsEl.dataset.qeAttrRows = '';
    this.attrRowsEl = attrRowsEl;
    attrsWrap.append(attrsHead, attrRowsEl);

    // Attachments dropzone + list.
    const attachWrap = document.createElement('div');
    attachWrap.className = 'qe-overlay__attachments';
    attachWrap.dataset.qeAttachments = '';
    const attachLabel = document.createElement('span');
    attachLabel.className = 'qe-overlay__label';
    attachLabel.textContent = 'Attachments';
    const dropzone = document.createElement('div');
    dropzone.className = 'qe-overlay__dropzone';
    dropzone.dataset.qeDropzone = '';
    dropzone.setAttribute('role', 'button');
    dropzone.tabIndex = 0;
    const dropText = document.createElement('span');
    dropText.textContent = 'Drop files or ';
    const browse = document.createElement('label');
    browse.className = 'qe-overlay__browse';
    browse.textContent = 'browse to attach';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.className = 'qe-overlay__file-input';
    fileInput.dataset.qeFileInput = '';
    fileInput.style.display = 'none';
    browse.append(fileInput);
    dropText.append(browse);
    dropzone.append(dropText);
    this.listen(fileInput, 'change', (ev) => {
      const input = ev.target as HTMLInputElement;
      this.queueFiles(input.files);
      input.value = '';
    });
    this.listen(browse, 'click', () => fileInput.click());
    this.listen(dropzone, 'click', () => fileInput.click());
    this.listen(dropzone, 'dragover', (ev) => {
      ev.preventDefault();
      dropzone.classList.add('qe-overlay__dropzone--over');
    });
    this.listen(dropzone, 'dragleave', () => dropzone.classList.remove('qe-overlay__dropzone--over'));
    this.listen(dropzone, 'drop', (ev) => {
      ev.preventDefault();
      dropzone.classList.remove('qe-overlay__dropzone--over');
      this.queueFiles((ev as DragEvent).dataTransfer?.files ?? null);
    });

    const attachList = document.createElement('div');
    attachList.className = 'qe-overlay__attach-list';
    attachList.dataset.qeAttachList = '';
    this.attachListEl = attachList;
    attachWrap.append(attachLabel, dropzone, attachList);

    region.append(assigneeField, tagsField, attrsWrap, attachWrap);
    return region;
  }

  /* ------------------------------- open/close --------------------------- */

  /** True while the overlay is shown — the AppShell sets the overlay-tier signal. */
  isOpen(): boolean {
    return this.opened;
  }

  /**
   * Open the overlay, scoped to the current project. `detail` may carry a
   * `parentCardId` (the project-layout "+ New task") and/or a `prefill`
   * (the kanban column `+` pins its axis value). Clears the form, expands
   * details when a prefill provides extra context, focuses the title.
   */
  open(detail?: unknown): void {
    if (this.opened) {
      // Re-open with fresh context — reset then re-apply.
      this.resetForm();
    }
    const d = (detail ?? {}) as { parentCardId?: bigint; prefill?: QuickEntryPrefill };
    this.parentOverride = d.parentCardId ?? null;
    this.prefill = d.prefill ?? null;

    this.opened = true;
    this.lastFocused = activeElement();
    this.resetForm();

    // A prefill (kanban column `+`) implies the user wants the lane pinned;
    // open details so they can see it (the prefill itself rides on submit).
    if (this.prefill?.laneAttribute !== undefined || (this.prefill?.extraAttributes?.length ?? 0) > 0) {
      this.setDetails(true);
    }
    // Seed assignee from prefill (inbox "me").
    if (this.prefill?.assigneeUserId !== undefined) {
      this.assigneeId = this.prefill.assigneeUserId;
    }

    this.el.style.display = '';
    this.untrap?.();
    this.untrap = trapFocus(this.el); // keep Tab inside the modal (#29)
    focusEl(this.titleInput);
  }

  /** Close without submitting (Esc / backdrop / Add & Close after success). */
  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.untrap?.();
    this.untrap = null;
    this.el.style.display = 'none';
    this.resetForm();
    focusEl(this.lastFocused);
    this.lastFocused = null;
  }

  private requestClose(): void {
    if (this.submitting) return;
    this.close();
  }

  /** Clear the per-submission inputs + tear down spawned pickers/editors. */
  private resetForm(): void {
    if (this.titleInput) this.titleInput.value = '';
    if (this.descInput) this.descInput.value = '';
    this.assigneeId = null;
    this.tagIds = [];
    this.pendingAttachments = [];
    this.clearError();
    this.tearDownPickers();
    this.clearAttrRows();
    this.renderAttachments();
    this.setDetails(false);
  }

  /** Clear the inputs but keep the overlay open + details expanded (Enter path). */
  private clearForNext(): void {
    if (this.titleInput) this.titleInput.value = '';
    if (this.descInput) this.descInput.value = '';
    // Keep the assignee selection (the user chose it / it came from prefill).
    this.tagIds = [];
    this.pendingAttachments = [];
    this.clearAttrRows();
    this.renderAttachments();
    // Re-seed the tags picker so its chips clear.
    if (this.detailsOpen) this.spawnTagsPicker();
    focusEl(this.titleInput);
  }

  private tearDownPickers(): void {
    if (this.assigneePicker) {
      this.destroyChild(this.assigneePicker);
      this.assigneePicker = null;
    }
    if (this.tagsPicker) {
      this.destroyChild(this.tagsPicker);
      this.tagsPicker = null;
    }
  }

  /* ------------------------------- details ------------------------------ */

  private toggleDetails(): void {
    this.setDetails(!this.detailsOpen);
  }

  private setDetails(open: boolean): void {
    this.detailsOpen = open;
    if (this.moreRegion) this.moreRegion.style.display = open ? '' : 'none';
    if (this.moreBtn) this.moreBtn.textContent = open ? '− Hide details' : '+ More details';
    if (this.panelEl) this.panelEl.classList.toggle('qe-overlay__panel--wide', open);
    if (open) {
      this.spawnAssigneePicker();
      this.spawnTagsPicker();
    }
  }

  private spawnAssigneePicker(): void {
    if (this.assigneeHost === null) return;
    if (this.assigneePicker) {
      this.destroyChild(this.assigneePicker);
      this.assigneePicker = null;
    }
    this.assigneeHost.replaceChildren();
    this.assigneePicker = this.spawn(
      'RefPicker',
      {
        type: 'RefPicker',
        cardType: this.assigneeCardType,
        value: this.assigneeId,
        placeholder: 'Select assignee…',
        'aria-label': 'Assignee',
        onChange: (v: bigint | null) => {
          this.assigneeId = v;
        },
      },
      this.assigneeHost,
    ) as RefPicker;
  }

  private spawnTagsPicker(): void {
    if (this.tagsHost === null) return;
    if (this.tagsPicker) {
      this.destroyChild(this.tagsPicker);
      this.tagsPicker = null;
    }
    this.tagsHost.replaceChildren();
    this.tagsPicker = this.spawn(
      'RefPicker',
      {
        type: 'RefPicker',
        cardType: this.tagCardType,
        multi: true,
        values: this.tagIds.slice(),
        parentScopePath: this.config.projectScopePath ?? 'scope.projectId',
        placeholder: 'Pick tags…',
        'aria-label': 'Tags',
        onChangeMulti: (vs: bigint[]) => {
          this.tagIds = vs.slice();
        },
      },
      this.tagsHost,
    ) as RefPicker;
  }

  /* --------------------------- "+ Add field" rows ----------------------- */

  private palette(): AttrSchema[] {
    return this.config.attributePalette ?? [];
  }

  /** Attributes not already covered by a well-known slot or an existing row. */
  private availablePaletteFor(currentName: string | null): AttrSchema[] {
    const taken = new Set<string>(WELL_KNOWN_ATTRS);
    for (const r of this.attrRows) if (r.name !== null && r.name !== currentName) taken.add(r.name);
    return this.palette().filter((a) => a.name === currentName || !taken.has(a.name));
  }

  private addAttrRow(): void {
    if (this.attrRowsEl === null) return;
    if (this.availablePaletteFor(null).length === 0) return;
    const rowEl = document.createElement('div');
    rowEl.className = 'qe-overlay__attr-row';
    rowEl.dataset.qeAttrRow = '';

    const select = document.createElement('select');
    select.className = 'qe-overlay__attr-select';
    select.dataset.qeAttrSelect = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Field…';
    select.append(blank);

    const valueHost = document.createElement('div');
    valueHost.className = 'qe-overlay__attr-value';
    valueHost.dataset.qeAttrValue = '';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'qe-overlay__attr-remove';
    remove.dataset.qeAttrRemove = '';
    remove.setAttribute('aria-label', 'Remove field');
    remove.textContent = '×';

    rowEl.append(select, valueHost, remove);

    const row: AttrRow = {
      id: this.nextRowId++,
      name: null,
      value: undefined,
      editor: null,
      el: rowEl,
      valueHost,
    };
    this.attrRows.push(row);

    this.fillAttrSelect(select, row);
    this.listen(select, 'change', () => {
      row.name = select.value === '' ? null : select.value;
      row.value = undefined;
      this.renderAttrEditor(row);
      // Refresh sibling selects so a picked name drops out of their options.
      this.refreshAttrSelects();
    });
    this.listen(remove, 'click', () => this.removeAttrRow(row));

    this.attrRowsEl.append(rowEl);
    this.refreshAttrSelects();
    this.updateAddFieldEnabled();
  }

  private fillAttrSelect(select: HTMLSelectElement, row: AttrRow): void {
    // Keep the blank option, rebuild the rest from the available palette.
    const opts = this.availablePaletteFor(row.name);
    // Remove all but the first (blank) option.
    while (select.children.length > 1) select.children[select.children.length - 1].remove();
    for (const a of opts) {
      const opt = document.createElement('option');
      opt.value = a.name;
      opt.textContent = a.label;
      if (a.name === row.name) opt.selected = true;
      select.append(opt);
    }
    select.value = row.name ?? '';
  }

  private refreshAttrSelects(): void {
    for (const r of this.attrRows) {
      const select = r.el.querySelector<HTMLSelectElement>('[data-qe-attr-select]');
      if (select) this.fillAttrSelect(select, r);
    }
  }

  private removeAttrRow(row: AttrRow): void {
    if (row.editor) this.destroyChild(row.editor);
    row.el.remove();
    this.attrRows = this.attrRows.filter((r) => r.id !== row.id);
    this.refreshAttrSelects();
    this.updateAddFieldEnabled();
  }

  private clearAttrRows(): void {
    for (const r of this.attrRows) {
      if (r.editor) this.destroyChild(r.editor);
      r.el.remove();
    }
    this.attrRows = [];
    this.updateAddFieldEnabled();
  }

  private updateAddFieldEnabled(): void {
    if (this.addFieldBtn) this.addFieldBtn.disabled = this.availablePaletteFor(null).length === 0;
  }

  /** Render the inline value editor for a row's picked attribute by valueType. */
  private renderAttrEditor(row: AttrRow): void {
    if (row.editor) {
      this.destroyChild(row.editor);
      row.editor = null;
    }
    row.valueHost.replaceChildren();
    const attr = this.palette().find((a) => a.name === row.name);
    if (attr === undefined) return;

    const vt = attr.valueType;
    if (vt === 'card_ref' || vt === 'card_ref[]') {
      const multi = vt === 'card_ref[]';
      row.editor = this.spawn(
        'RefPicker',
        {
          type: 'RefPicker',
          cardType: attr.targetCardType ?? 'card',
          multi,
          parentScopePath: this.config.projectScopePath ?? 'scope.projectId',
          placeholder: `Pick ${attr.label}…`,
          'aria-label': attr.label,
          ...(multi
            ? { onChangeMulti: (vs: bigint[]) => { row.value = vs.slice(); } }
            : { onChange: (v: bigint | null) => { row.value = v; } }),
        },
        row.valueHost,
      );
      return;
    }
    if (vt === 'date') {
      row.editor = this.spawn(
        'DatePicker',
        {
          type: 'DatePicker',
          value: null,
          placeholder: `Pick ${attr.label}…`,
          'aria-label': attr.label,
          onChange: (iso: string | null) => { row.value = iso; },
        },
        row.valueHost,
      ) as DatePicker;
      return;
    }
    if (vt === 'bool') {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'qe-overlay__attr-checkbox';
      cb.dataset.qeAttrInput = '';
      this.listen(cb, 'change', () => { row.value = cb.checked; });
      row.valueHost.append(cb);
      return;
    }
    // text / number / unknown → a plain input.
    const input = document.createElement('input');
    input.type = vt === 'number' ? 'number' : 'text';
    input.className = 'qe-overlay__input qe-overlay__attr-input';
    input.dataset.qeAttrInput = '';
    input.placeholder = attr.label;
    this.listen(input, 'input', () => {
      const raw = input.value;
      if (raw === '') { row.value = undefined; return; }
      row.value = vt === 'number' ? Number(raw) : raw;
    });
    row.valueHost.append(input);
  }

  /** Collect the filled "+ Add field" rows as NamedAttribute[] (drop empties). */
  private collectAdditionalAttributes(): NamedAttribute[] {
    const out: NamedAttribute[] = [];
    for (const r of this.attrRows) {
      if (r.name === null) continue;
      const v = r.value;
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out.push({ name: r.name, value: v });
    }
    return out;
  }

  /* ------------------------------ attachments --------------------------- */

  private queueFiles(files: FileList | File[] | null): void {
    if (!files) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    for (const f of list) {
      this.pendingAttachments.push({ id: this.nextAttId++, file: f, status: 'queued' });
    }
    this.renderAttachments();
  }

  private removeAttachment(id: number): void {
    this.pendingAttachments = this.pendingAttachments.filter((a) => a.id !== id);
    this.renderAttachments();
  }

  private renderAttachments(): void {
    if (this.attachListEl === null) return;
    this.attachListEl.replaceChildren();
    for (const att of this.pendingAttachments) {
      const row = document.createElement('div');
      row.className = 'qe-overlay__attach-row';
      row.dataset.qeAttachRow = '';
      const name = document.createElement('span');
      name.className = 'qe-overlay__attach-name';
      name.textContent = att.file.name;
      const size = document.createElement('span');
      size.className = 'qe-overlay__attach-size muted';
      size.textContent = fmtSize(att.file.size);
      row.append(name, size);
      if (att.status !== 'queued') {
        const status = document.createElement('span');
        status.className = `qe-overlay__attach-status qe-overlay__attach-status--${att.status}`;
        status.textContent =
          att.status === 'uploading' ? 'uploading…' : att.status === 'error' ? 'error' : 'ready';
        if (att.error) status.title = att.error;
        row.append(status);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'qe-overlay__attach-remove';
      remove.dataset.qeAttachRemove = String(att.id);
      remove.setAttribute('aria-label', `Remove ${att.file.name}`);
      remove.textContent = '×';
      this.listen(remove, 'click', () => this.removeAttachment(att.id));
      row.append(remove);
      this.attachListEl.append(row);
    }
  }

  /* ------------------------------ keyboard ------------------------------ */

  private onTitleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.requestClose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      // Mod+Enter → submit + close; plain Enter → submit + keep open.
      this.submit(isMod(e));
    }
  }

  private onDescriptionKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.requestClose();
      return;
    }
    // Mod+Enter commits from the textarea (plain Enter is a newline).
    if (e.key === 'Enter' && isMod(e)) {
      e.preventDefault();
      e.stopPropagation();
      this.submit(true);
    }
  }

  private onPanelKeydown(e: KeyboardEvent): void {
    // Title/description handle their own keys + stopPropagation; this catches
    // focus on the pickers / footer / attachments.
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.requestClose();
      return;
    }
    if (e.key === 'Enter' && isMod(e)) {
      e.preventDefault();
      e.stopPropagation();
      this.submit(true);
    }
  }

  /* ------------------------------- submit ------------------------------- */

  /**
   * Submit: resolve the parent + the default status, pre-upload any queued
   * attachments (CAS), then issue the coalesced card.insert + tag.apply +
   * attachment.create batch. `closeAfter` distinguishes Mod+Enter / Add & Close
   * (close on success) from Enter / Add & Another (clear + keep open).
   * `openDetailAfter` (Save & Edit) navigates to the new task's detail view
   * on success — implies `closeAfter` since the route change tears the overlay
   * down anyway.
   */
  private submit(closeAfter: boolean, openDetailAfter = false): void {
    if (this.submitting) return;
    const title = (this.titleInput?.value ?? '').trim();
    if (title === '') {
      focusEl(this.titleInput);
      return;
    }
    this.clearError();

    // Parent: explicit override (project-layout) → current project scope.
    const scopeId = this.peekProjectScope();
    const resolution = resolveParentForInsert(this.cardType, this.parentOverride ?? undefined, scopeId);
    if (resolution.error !== null) {
      this.showError(resolution.error);
      return;
    }

    // Effective prefill: prefill + any user-chosen assignee.
    const effectivePrefill: QuickEntryPrefill = { ...(this.prefill ?? {}) };
    if (this.assigneeId !== null) effectivePrefill.assigneeUserId = this.assigneeId;

    // Default-create-status chain (tasks only, when status isn't pinned).
    let defaultStatusCardId: bigint | undefined;
    if (this.cardType === 'task') {
      const additional = this.collectAdditionalAttributes();
      const pinsStatus =
        effectivePrefill.laneAttribute?.name === 'status' ||
        (effectivePrefill.extraAttributes ?? []).some((a) => a.name === 'status') ||
        additional.some((a) => a.name === 'status');
      const candidates = this.peekCandidateStatuses();
      const screenCard = this.peekScreenCard();
      const flow = this.peekFlow();
      const basePhase = this.peekBasePhase();
      // A "+ New sub-task" raise carries parent_relationship='subtask'; such a
      // task defaults to the first ACTIVE status (step 0), not the screen base.
      const subtask = (effectivePrefill.extraAttributes ?? []).some(
        (a) => a.name === 'parent_relationship' && a.value === 'subtask',
      );
      // Run the chain when there's something to resolve from: a screen / flow
      // override, or loaded candidate statuses. With none, skip it and let the
      // server's required-edge check surface a missing status (avoids a
      // premature "no valid starting status" error on an unseeded project).
      const hasSource = screenCard !== null || flow !== null || candidates.length > 0;
      if (!pinsStatus && hasSource) {
        const r = resolveDefaultCreateStatus({ screenCard, flow, candidateStatuses: candidates, basePhase, subtask });
        if ('error' in r) {
          this.showError(r.message);
          return;
        }
        defaultStatusCardId = r.statusCardId;
      }
    }

    this.setSubmitting(true);

    // Pre-upload attachments (CAS), then fire the batch.
    this.uploadThenSubmit(
      title,
      resolution.parentCardId,
      effectivePrefill,
      defaultStatusCardId,
      closeAfter,
      openDetailAfter,
    );
  }

  /**
   * Pre-upload every queued attachment to CAS + `file.create` (NOT bound to any
   * card yet — the new task doesn't exist). Once every file has an id, fire the
   * coalesced batch so the bind (`attachment.create`) rides the SAME tick as the
   * `card.insert`. A single failed upload aborts the submit (the form stays so
   * the user can retry).
   */
  private uploadThenSubmit(
    title: string,
    parentCardId: bigint | null,
    prefill: QuickEntryPrefill,
    defaultStatusCardId: bigint | undefined,
    closeAfter: boolean,
    openDetailAfter: boolean,
  ): void {
    const pending = this.pendingAttachments.filter((a) => a.fileId === undefined);
    const ready = (): void => {
      const fileIds = this.pendingAttachments
        .map((a) => a.fileId)
        .filter((id): id is bigint => id !== undefined);
      this.fireSubmit(title, parentCardId, prefill, defaultStatusCardId, fileIds, closeAfter, openDetailAfter);
    };
    if (pending.length === 0) {
      ready();
      return;
    }

    let remaining = pending.length;
    let failed = false;
    for (const att of pending) {
      att.status = 'uploading';
      this.renderAttachments();
      prepareFile(this.ctx.api, att.file, {
        alive: () => this.isAlive() && this.opened,
        ...(this.postChunkOverride ? { postChunk: this.postChunkOverride } : {}),
        onDone: (fileOut) => {
          if (failed) return;
          att.fileId = fileOut.id;
          att.status = 'ready';
          this.renderAttachments();
          remaining -= 1;
          if (remaining === 0) ready();
        },
        onError: (e) => {
          if (failed) return;
          failed = true;
          att.status = 'error';
          att.error = e.message;
          this.renderAttachments();
          this.setSubmitting(false);
          this.showError(`Attachment upload failed: ${e.message}`);
        },
      });
    }
  }

  private fireSubmit(
    title: string,
    parentCardId: bigint | null,
    prefill: QuickEntryPrefill,
    defaultStatusCardId: bigint | undefined,
    attachmentFileIds: bigint[],
    closeAfter: boolean,
    openDetailAfter: boolean,
  ): void {
    const input: QuickEntrySubmitInput = {
      cardTypeName: this.cardType,
      title,
      description: (this.descInput?.value ?? '').trim(),
      prefill,
    };
    if (parentCardId !== null) input.parentCardId = parentCardId;
    if (defaultStatusCardId !== undefined) input.defaultStatusCardId = defaultStatusCardId;
    const additional = this.collectAdditionalAttributes();
    if (additional.length > 0) input.additionalAttributes = additional;
    if (this.tagIds.length > 0) input.tagIds = this.tagIds.slice();
    if (attachmentFileIds.length > 0) input.attachmentFileIds = attachmentFileIds;

    submitQuickEntry(this.ctx.api, input, {
      alive: () => this.isAlive(),
      onCreated: (newCardId) => {
        this.setSubmitting(false);
        this.showSuccessToast(newCardId);
        // Broadcast a "task created" tick so open list/detail surfaces refresh
        // without a manual re-search (Grid refetch #3, related-children reload
        // for + New sub-task #9). One-way write — cascade-safe.
        const nonce = this.ctx.tree.at(['tasks', 'createdNonce']);
        nonce.set((nonce.peek<number>() ?? 0) + 1);
        if (openDetailAfter) {
          // "Save & Edit" — the new card route takes over the page so the
          // overlay tears down with it. Close FIRST so the focus trap releases
          // before navigation moves focus to the detail screen.
          this.close();
          navigate(taskUrl(newCardId));
        } else if (closeAfter) {
          this.close();
        } else {
          this.clearForNext();
        }
      },
      onError: (fault: ApiFault) => {
        this.setSubmitting(false);
        this.showError(describeFault(fault));
      },
    });
  }

  private setSubmitting(on: boolean): void {
    this.submitting = on;
    if (this.submittingEl) this.submittingEl.style.display = on ? '' : 'none';
    if (this.titleInput) this.titleInput.disabled = on;
    if (this.descInput) this.descInput.disabled = on;
  }

  private showSuccessToast(newCardId: bigint): void {
    if (this.toast === null) this.toast = createSuccessToast();
    this.toast.show(`Created ${this.cardType}`, () => {
      undoQuickEntry(this.ctx.api, newCardId, () => this.isAlive());
    });
  }

  private showError(msg: string): void {
    if (this.errorEl === null) return;
    this.errorEl.textContent = msg;
    this.errorEl.style.display = '';
  }

  private clearError(): void {
    if (this.errorEl === null) return;
    this.errorEl.textContent = '';
    this.errorEl.style.display = 'none';
  }

  /* ----------------------------- tree reads ----------------------------- */

  private peekProjectScope(): bigint | null {
    const path = this.config.projectScopePath ?? 'scope.projectId';
    if (path.startsWith('scope.')) {
      const v = (this.ctx.scope ?? {})[path.slice('scope.'.length)];
      return (v as bigint | null) ?? null;
    }
    return this.ctx.tree.at(splitPath(path)).peek<bigint | null>() ?? null;
  }

  private peekCandidateStatuses(): CardWithAttrs[] {
    const path = this.config.candidateStatusesPath ?? DEFAULT_CANDIDATE_STATUSES_PATH;
    const v = this.ctx.tree.at(splitPath(path)).peek<CardWithAttrs[]>();
    return Array.isArray(v) ? v : [];
  }

  private peekScreenCard(): CardWithAttrs | null {
    if (this.config.screenCardPath === undefined) return null;
    return this.ctx.tree.at(splitPath(this.config.screenCardPath)).peek<CardWithAttrs | null>() ?? null;
  }

  private peekFlow(): FlowRow | null {
    if (this.config.flowPath === undefined) return null;
    return this.ctx.tree.at(splitPath(this.config.flowPath)).peek<FlowRow | null>() ?? null;
  }

  /**
   * The active screen's base phase — its first default-on phase toggle (e.g. a
   * Board screen → 'active', an Inbox screen → 'triage'). Null when there are
   * no toggles, so the chain falls through to the triage/active fallbacks.
   */
  private peekBasePhase(): Phase | null {
    const path = this.config.phaseTogglesPath ?? DEFAULT_PHASE_TOGGLES_PATH;
    const toggles = this.ctx.tree.at(splitPath(path)).peek<PhaseToggle[]>();
    if (!Array.isArray(toggles) || toggles.length === 0) return null;
    return (toggles.find((t) => t.defaultOn) ?? toggles[0]).phase;
  }

  /* ------------------------------ test seams ---------------------------- */
  // Tiny hooks so `node --test` can drive the picker-fed selections + the
  // attachment pipeline without standing up a full Combobox interaction /
  // real chunk POST. Mirror the `_resetDragState` pattern used elsewhere.

  /** TEST: set the multi-tag selection the tags RefPicker would report. */
  _setTagsForTest(ids: bigint[]): void {
    this.tagIds = ids.slice();
  }
  /** TEST: queue files as if dropped onto the dropzone. */
  _queueFilesForTest(files: File[]): void {
    this.queueFiles(files);
  }
  /** TEST: inject the raw chunk-POST sink (an in-memory CAS store). */
  _setPostChunkForTest(postChunk: PostChunk): void {
    this.postChunkOverride = postChunk;
  }
}

/* -------------------------------------------------------------------------- */
/* Success toast (with Undo). A single reused fixed-corner element.            */
/* -------------------------------------------------------------------------- */

interface SuccessToast {
  show(message: string, onUndo: () => void): void;
}

function createSuccessToast(): SuccessToast {
  if (typeof document === 'undefined') return { show() {} };
  const el = document.createElement('div');
  el.className = 'qe-toast';
  el.dataset.qeToast = '';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');

  const dot = document.createElement('span');
  dot.className = 'qe-toast__dot';
  dot.setAttribute('aria-hidden', 'true');
  const msg = document.createElement('span');
  msg.className = 'qe-toast__msg';
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.className = 'qe-toast__undo';
  undo.dataset.qeToastUndo = '';
  undo.textContent = 'Undo';
  el.append(dot, msg, undo);
  document.body.append(el);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let undoFn: (() => void) | null = null;
  const hide = (): void => el.classList.remove('qe-toast--show');
  undo.addEventListener('click', () => {
    if (undoFn) undoFn();
    if (timer !== undefined) clearTimeout(timer);
    hide();
  });

  return {
    show(message, onUndo): void {
      msg.textContent = message;
      undoFn = onUndo;
      el.classList.add('qe-toast--show');
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(hide, 6000);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                    */
/* -------------------------------------------------------------------------- */

function labeledField(label: string): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'qe-overlay__field';
  const span = document.createElement('span');
  span.className = 'qe-overlay__label';
  span.textContent = label;
  wrap.append(span);
  return wrap;
}

function isMod(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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

function activeElement(): Element | null {
  const doc = document as unknown as { activeElement?: Element | null };
  return doc.activeElement ?? null;
}

function focusEl(el: unknown): void {
  if (el && typeof (el as { focus?: () => void }).focus === 'function') {
    (el as { focus: () => void }).focus();
  }
}

export function registerQuickEntry(): void {
  Control.register('QuickEntry', QuickEntry);
}
