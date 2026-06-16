/**
 * ImportWizard — the CSV-import flow (#41), a centered modal sheet over a scrim
 * (same overlay tier + idiom as the QuickEntry / Help overlays). Launched from
 * the Project detail's Import hook (the `projectImport` bus intent), scoped to
 * the project being imported into.
 *
 * A FOUR-STEP machine, gated by the durable `import_job.status` flow
 * (pending → uploaded → mapped → previewed → running → completed/failed):
 *
 *   1. UPLOAD  — pick a `.csv`; get it to the server. The CSV reaches the
 *      backend BY FILE ID: {@link uploadCsv} runs the shared CAS pipeline
 *      (chunk → cas.missing_chunks → POST /cas/chunk → file.create) to
 *      materialise a `file` row, then we fire `project.import.upload` with
 *      { projectId, fileId } — which creates the import_job (status='uploaded')
 *      and returns the parsed header + first 20 preview rows + total row count.
 *   2. MAP     — map each CSV column → a task field (title/assignee_email/…) via
 *      Combobox selects, plus the resolution config (match/auto-create/skip/
 *      leave-blank for unknown persons/milestones/components/tags). "Next" fires
 *      `project.import.set_mapping` (status → 'mapped').
 *   3. PREVIEW — `project.import.preview` (dry-run): shows would-create counts +
 *      a per-row error log; persists resolution + summary (status → 'previewed').
 *   4. COMMIT  — `project.import.commit` (apply; auto-creates refs + inserts the
 *      tasks; status → 'completed'); shows the success/failure summary and (on
 *      completion) fires the `projectImportDone` bus intent so the host refreshes
 *      its tasks.
 *
 * Resumable per the job status: each successful step advances the durable row,
 * and Back/Next move between the in-memory steps without re-uploading (the
 * job_id + parsed preview are kept). Cancel/close resets the form.
 *
 * ZERO-PROMISE control surface: every server call goes through
 * `api.callByName(spec, input, onOk, { alive, onErr })`; the upload goes through
 * {@link uploadCsv}'s callback API. No `.then`/`await` crosses the control
 * boundary. Open/close is a pure DOM display toggle (like QuickEntry), so it
 * never feeds a reactive cascade.
 *
 * Reference (NOT imported): client/src/screens/admin/ImportWizard.svelte +
 * import_wizard.ts — the step machine, column-mapping UI, resolution config,
 * preview counts/errors, and commit.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { trapFocus } from '../util/focus-trap.js';
import type { ApiFault } from '../core/dispatch.js';
import type { Combobox, ComboboxOption } from '../ui/combobox.js';
import { uploadCsv, autoMapping } from './import-helpers.js';
import {
  IMPORT_SPEC,
  IGNORE_COLUMN,
  TARGET_ATTRS,
  RESOLUTION_CATEGORIES,
  type ResolutionCategory,
  type ResolutionMode,
  type ImportResolution,
  type ImportCounts,
  type ImportError,
  type UploadOutput,
  type SetMappingOutput,
  type PreviewOutput,
  type CommitOutput,
} from './specs.js';
import type { PostChunk } from '../task-detail/upload.js';

import { icon } from '../ui/icons.js';
/* -------------------------------------------------------------------------- */
/* Config + declaration-merged registry type.                                 */
/* -------------------------------------------------------------------------- */

export interface ImportWizardConfig extends BaseControlConfig {
  type: 'ImportWizard';
  /**
   * Fired with `{ projectId }` after a successful commit so the host can refresh
   * its tasks. Defaults to emitting the `projectImportDone` bus intent.
   */
  onCommitted?: (detail: { projectId: bigint; created: ImportCounts }) => void;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    ImportWizard: ImportWizardConfig;
  }
}

/** The four wizard steps, in order. */
export type WizardStep = 'upload' | 'map' | 'preview' | 'commit';
const STEP_ORDER: readonly WizardStep[] = ['upload', 'map', 'preview', 'commit'];
const STEP_LABELS: Record<WizardStep, string> = {
  upload: 'Upload',
  map: 'Map',
  preview: 'Preview',
  commit: 'Commit',
};

/** Resolution mode options for the per-category selects. */
const RESOLUTION_MODE_OPTIONS: ReadonlyArray<{ value: ResolutionMode; label: string }> = [
  { value: 'match_existing', label: 'Match existing only' },
  { value: 'auto_create', label: 'Auto-create new' },
  { value: 'skip', label: 'Skip row' },
  { value: 'leave_blank', label: 'Leave blank' },
];

/** How many preview errors to render before collapsing into "… N more". */
const MAX_ERRORS_SHOWN = 50;

/* -------------------------------------------------------------------------- */
/* Control.                                                                    */
/* -------------------------------------------------------------------------- */

export class ImportWizard extends Control<ImportWizardConfig> {
  private opened = false;
  private step: WizardStep = 'upload';

  /** The project being imported into (set on open). */
  private projectId: bigint | null = null;

  /* ---- upload step state ---- */
  private file: File | null = null;
  private uploading = false;

  /* ---- job state (durable record lives on the server) ---- */
  private jobId: bigint | null = null;
  private headers: string[] = [];
  private previewRows: string[][] = [];
  private rowCount = 0;

  /* ---- map step state ---- */
  private mapping: Record<string, string> = {};
  private resolution: ImportResolution = {
    persons: 'match_existing',
    milestones: 'match_existing',
    components: 'match_existing',
    tags: 'match_existing',
  };
  private mapBusy = false;

  /* ---- preview / commit state ---- */
  private previewOut: PreviewOutput | null = null;
  private commitOut: CommitOutput | null = null;
  private previewBusy = false;
  private committing = false;

  /** Injected chunk-POST sink for tests (the default fetch sink otherwise). */
  private postChunkOverride: PostChunk | null = null;

  /* ---- DOM handles built once in render() ---- */
  private stepsEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private backBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;
  private nextLabelEl!: HTMLSpanElement;
  private lastFocused: Element | null = null;
  /** Focus-trap disposer while the wizard is open (#29). */
  private untrap: (() => void) | null = null;

  /** Spawned mapping comboboxes, keyed by CSV header, torn down on reset. */
  private mapPickers = new Map<string, Combobox<string>>();
  private resPickers = new Map<ResolutionCategory, Combobox<ResolutionMode>>();

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'import-wizard';
    el.dataset.control = 'ImportWizard';
    el.style.display = 'none';
    return el;
  }

  protected render(): void {
    const root = this.el;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Import CSV');

    const backdrop = document.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'import-wizard__backdrop';
    backdrop.dataset.iwBackdrop = '';
    backdrop.setAttribute('aria-label', 'Close import');
    backdrop.tabIndex = -1;
    this.listen(backdrop, 'click', () => this.requestClose());

    const panel = document.createElement('div');
    panel.className = 'import-wizard__panel';
    panel.dataset.iwPanel = '';
    this.listen(panel, 'keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        this.requestClose();
      }
    });

    /* ------------------------------- header ------------------------------ */
    const header = document.createElement('div');
    header.className = 'import-wizard__header';
    const heading = document.createElement('h2');
    heading.className = 'import-wizard__title';
    heading.textContent = 'Import CSV';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'import-wizard__close';
    closeBtn.dataset.iwClose = '';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.append(icon('x', 14));
    this.listen(closeBtn, 'click', () => this.requestClose());
    header.append(heading, closeBtn);

    // Step indicator.
    const steps = document.createElement('ol');
    steps.className = 'import-wizard__steps';
    steps.dataset.iwSteps = '';
    this.stepsEl = steps;

    /* -------------------------------- body ------------------------------- */
    const error = document.createElement('div');
    error.className = 'import-wizard__error';
    error.dataset.iwError = '';
    error.setAttribute('role', 'alert');
    error.style.display = 'none';
    this.errorEl = error;

    const body = document.createElement('div');
    body.className = 'import-wizard__body scroll-y';
    body.dataset.iwBody = '';
    this.bodyEl = body;

    /* ------------------------------- footer ------------------------------ */
    const footer = document.createElement('div');
    footer.className = 'import-wizard__footer';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn import-wizard__back';
    back.dataset.iwBack = '';
    back.textContent = 'Back';
    this.listen(back, 'click', () => this.onBack());
    this.backBtn = back;

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'btn btn-primary import-wizard__next';
    next.dataset.iwNext = '';
    const nextLabel = document.createElement('span');
    nextLabel.textContent = 'Next';
    next.append(nextLabel);
    this.nextLabelEl = nextLabel;
    this.listen(next, 'click', () => this.onNext());
    this.nextBtn = next;

    footer.append(back, next);

    panel.append(header, steps, error, body, footer);
    root.append(backdrop, panel);

    this.renderSteps();
    this.renderBody();
    this.renderFooter();
  }

  /* ------------------------------ open/close ----------------------------- */

  isOpen(): boolean {
    return this.opened;
  }

  /** Open the wizard scoped to a project. `detail.projectId` is the import target. */
  open(detail?: unknown): void {
    const d = (detail ?? {}) as { projectId?: bigint | null };
    this.projectId = d.projectId ?? null;
    this.resetState();
    this.opened = true;
    this.lastFocused = activeElement();
    this.el.style.display = '';
    this.untrap?.();
    this.untrap = trapFocus(this.el); // keep Tab inside the modal (#29)
    // Repaint everything for the fresh state.
    this.renderSteps();
    this.renderBody();
    this.renderFooter();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.untrap?.();
    this.untrap = null;
    this.el.style.display = 'none';
    this.resetState();
    focusEl(this.lastFocused);
    this.lastFocused = null;
  }

  private requestClose(): void {
    if (this.uploading || this.committing) return;
    this.close();
  }

  private resetState(): void {
    this.step = 'upload';
    this.file = null;
    this.uploading = false;
    this.jobId = null;
    this.headers = [];
    this.previewRows = [];
    this.rowCount = 0;
    this.mapping = {};
    this.resolution = {
      persons: 'match_existing',
      milestones: 'match_existing',
      components: 'match_existing',
      tags: 'match_existing',
    };
    this.mapBusy = false;
    this.previewOut = null;
    this.commitOut = null;
    this.previewBusy = false;
    this.committing = false;
    this.tearDownPickers();
    this.clearError();
  }

  private tearDownPickers(): void {
    for (const p of this.mapPickers.values()) this.destroyChild(p);
    this.mapPickers.clear();
    for (const p of this.resPickers.values()) this.destroyChild(p);
    this.resPickers.clear();
  }

  /* ------------------------------ step nav ------------------------------- */

  private setStep(step: WizardStep): void {
    this.step = step;
    this.clearError();
    this.renderSteps();
    this.renderBody();
    this.renderFooter();
  }

  /** Back: move to the previous in-memory step (the durable job is unchanged). */
  private onBack(): void {
    const idx = STEP_ORDER.indexOf(this.step);
    if (idx <= 0) {
      this.requestClose();
      return;
    }
    this.setStep(STEP_ORDER[idx - 1]!);
  }

  /** Next: advance — runs the step's server call when one is required. */
  private onNext(): void {
    switch (this.step) {
      case 'upload':
        this.runUpload();
        break;
      case 'map':
        this.runSetMapping();
        break;
      case 'preview':
        this.runCommit();
        break;
      case 'commit':
        // The commit step's primary button is "Done" → close.
        this.close();
        break;
    }
  }

  /* ------------------------------ step: upload --------------------------- */

  /**
   * Upload the CSV: first to CAS (→ file id) via {@link uploadCsv}, then
   * `project.import.upload` (creates the job, returns parsed header + preview).
   * On success → MAP step with an auto-built mapping.
   */
  private runUpload(): void {
    if (this.uploading) return;
    if (this.file === null) {
      this.showError('Choose a CSV file to import.');
      return;
    }
    if (this.projectId === null) {
      this.showError('No project in scope to import into.');
      return;
    }
    this.clearError();
    this.uploading = true;
    this.renderFooter();

    const projectId = this.projectId;
    uploadCsv(this.ctx.api, this.file, {
      alive: () => this.isAlive() && this.opened,
      ...(this.postChunkOverride ? { postChunk: this.postChunkOverride } : {}),
      onDone: (fileId) => {
        this.ctx.api.callByName(
          IMPORT_SPEC.upload,
          { projectId, fileId },
          (out) => {
            const o = out as UploadOutput;
            this.uploading = false;
            this.jobId = o.jobId;
            this.headers = o.headers;
            this.previewRows = o.previewRows;
            this.rowCount = o.rowCount;
            this.mapping = autoMapping(o.headers);
            this.setStep('map');
          },
          {
            alive: () => this.isAlive() && this.opened,
            onErr: (f) => {
              this.uploading = false;
              this.showError(describeFault(f));
              this.renderFooter();
            },
          },
        );
      },
      onError: (e) => {
        this.uploading = false;
        this.showError(`Upload failed: ${e.message}`);
        this.renderFooter();
      },
    });
  }

  /* ------------------------------ step: map ------------------------------ */

  /** Persist the mapping (`set_mapping`, status → 'mapped'), then → PREVIEW. */
  private runSetMapping(): void {
    if (this.mapBusy || this.jobId === null) return;
    this.clearError();
    this.mapBusy = true;
    this.renderFooter();
    const jobId = this.jobId;
    this.ctx.api.callByName(
      IMPORT_SPEC.setMapping,
      { jobId, mapping: this.mapping },
      (out) => {
        void (out as SetMappingOutput);
        this.mapBusy = false;
        // Mapping changed → invalidate any earlier preview/commit summary.
        this.previewOut = null;
        this.commitOut = null;
        this.setStep('preview');
        // Auto-run the dry-run so the preview step lands with counts.
        this.runPreview();
      },
      {
        alive: () => this.isAlive() && this.opened,
        onErr: (f) => {
          this.mapBusy = false;
          this.showError(describeFault(f));
          this.renderFooter();
        },
      },
    );
  }

  /* ----------------------------- step: preview --------------------------- */

  /** Dry-run (`preview`, status → 'previewed'): would-create counts + errors. */
  private runPreview(): void {
    if (this.previewBusy || this.jobId === null) return;
    this.clearError();
    this.previewBusy = true;
    this.renderBody();
    this.renderFooter();
    const jobId = this.jobId;
    this.ctx.api.callByName(
      IMPORT_SPEC.preview,
      { jobId, resolution: this.resolution },
      (out) => {
        this.previewBusy = false;
        this.previewOut = out as PreviewOutput;
        if (this.step !== 'preview') this.step = 'preview';
        this.renderBody();
        this.renderFooter();
      },
      {
        alive: () => this.isAlive() && this.opened,
        onErr: (f) => {
          this.previewBusy = false;
          this.showError(describeFault(f));
          this.renderBody();
          this.renderFooter();
        },
      },
    );
  }

  /* ------------------------------ step: commit --------------------------- */

  /** Apply (`commit`, status → 'completed'): real counts + host refresh. */
  private runCommit(): void {
    if (this.committing || this.jobId === null) return;
    this.clearError();
    this.committing = true;
    this.setStep('commit');
    this.renderFooter();
    const jobId = this.jobId;
    this.ctx.api.callByName(
      IMPORT_SPEC.commit,
      { jobId },
      (out) => {
        this.committing = false;
        this.commitOut = out as CommitOutput;
        this.renderBody();
        this.renderFooter();
        // Tell the host to refresh its tasks.
        if (this.projectId !== null) {
          const detail = { projectId: this.projectId, created: this.commitOut.created };
          if (this.config.onCommitted) this.config.onCommitted(detail);
          else this.ctx.bus?.emit('projectImportDone', detail);
        }
      },
      {
        alive: () => this.isAlive() && this.opened,
        onErr: (f) => {
          this.committing = false;
          this.showError(describeFault(f));
          this.renderBody();
          this.renderFooter();
        },
      },
    );
  }

  /* ------------------------------- rendering ----------------------------- */

  private renderSteps(): void {
    this.stepsEl.replaceChildren();
    const activeIdx = STEP_ORDER.indexOf(this.step);
    STEP_ORDER.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = 'import-wizard__step';
      li.dataset.iwStep = s;
      if (i === activeIdx) li.classList.add('import-wizard__step--active');
      if (i < activeIdx) li.classList.add('import-wizard__step--done');
      const num = document.createElement('span');
      num.className = 'import-wizard__step-num';
      num.textContent = String(i + 1);
      const label = document.createElement('span');
      label.className = 'import-wizard__step-label';
      label.textContent = STEP_LABELS[s];
      li.append(num, label);
      this.stepsEl.append(li);
    });
  }

  private renderBody(): void {
    this.tearDownPickers();
    this.bodyEl.replaceChildren();
    switch (this.step) {
      case 'upload':
        this.renderUploadStep();
        break;
      case 'map':
        this.renderMapStep();
        break;
      case 'preview':
        this.renderPreviewStep();
        break;
      case 'commit':
        this.renderCommitStep();
        break;
    }
  }

  private renderUploadStep(): void {
    const p = document.createElement('p');
    p.className = 'import-wizard__hint muted';
    p.textContent =
      'Choose a CSV exported from a kitp project (or one you prepared yourself). ' +
      'The first row is treated as the column header.';

    const field = labeledField('CSV file');
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,text/csv';
    input.className = 'import-wizard__file-input';
    input.dataset.iwFileInput = '';
    this.listen(input, 'change', () => {
      const picked = input.files && input.files.length > 0 ? input.files.item(0) : null;
      this.file = picked;
      this.renderFooter();
    });
    field.append(input);

    const chosen = document.createElement('div');
    chosen.className = 'import-wizard__chosen muted';
    chosen.dataset.iwChosen = '';
    chosen.textContent = this.file ? `${this.file.name} (${fmtSize(this.file.size)})` : '';

    this.bodyEl.append(p, field, chosen);
  }

  private renderMapStep(): void {
    const p = document.createElement('p');
    p.className = 'import-wizard__hint muted';
    p.dataset.iwRowCount = '';
    const strong = document.createElement('strong');
    strong.textContent = String(this.rowCount);
    p.append('Map each CSV column to a task field. ', strong, ' rows detected.');
    this.bodyEl.append(p);

    /* ----------------------------- column map --------------------------- */
    const mapWrap = document.createElement('div');
    mapWrap.className = 'import-wizard__map';
    mapWrap.dataset.iwMap = '';
    const mapLabel = sectionLabel('Columns');
    mapWrap.append(mapLabel);

    const targetOptions: ComboboxOption<string>[] = [
      { value: IGNORE_COLUMN, label: '(ignore)' },
      ...TARGET_ATTRS.map((t) => ({ value: t, label: t })),
    ];

    for (const h of this.headers) {
      const row = document.createElement('div');
      row.className = 'import-wizard__map-row';
      row.dataset.iwMapRow = h;

      const name = document.createElement('span');
      name.className = 'import-wizard__map-col';
      name.textContent = h;

      const pickerHost = document.createElement('div');
      pickerHost.className = 'import-wizard__map-target';

      row.append(name, pickerHost);
      mapWrap.append(row);

      const current = this.mapping[h] ?? IGNORE_COLUMN;
      const picker = this.spawn(
        'Combobox',
        {
          type: 'Combobox',
          value: current,
          options: targetOptions,
          placeholder: '(ignore)',
          'aria-label': `Target for column ${h}`,
          onChange: (v: string | null) => {
            this.mapping[h] = v ?? IGNORE_COLUMN;
          },
        },
        pickerHost,
      ) as Combobox<string>;
      this.mapPickers.set(h, picker);
    }
    this.bodyEl.append(mapWrap);

    /* --------------------------- resolution config ---------------------- */
    const resWrap = document.createElement('div');
    resWrap.className = 'import-wizard__resolution';
    resWrap.dataset.iwResolution = '';
    resWrap.append(sectionLabel('When a referenced value is unknown'));

    const grid = document.createElement('div');
    grid.className = 'import-wizard__res-grid';
    const modeOptions: ComboboxOption<ResolutionMode>[] = RESOLUTION_MODE_OPTIONS.map((o) => ({
      value: o.value,
      label: o.label,
    }));
    for (const cat of RESOLUTION_CATEGORIES) {
      const field = labeledField(capitalise(cat));
      field.classList.add('import-wizard__res-field');
      field.dataset.iwResField = cat;
      const host = document.createElement('div');
      const picker = this.spawn(
        'Combobox',
        {
          type: 'Combobox',
          value: this.resolution[cat] ?? 'match_existing',
          options: modeOptions,
          'aria-label': `${capitalise(cat)} resolution`,
          onChange: (v: ResolutionMode | null) => {
            this.resolution[cat] = v ?? 'match_existing';
          },
        },
        host,
      ) as Combobox<ResolutionMode>;
      this.resPickers.set(cat, picker);
      field.append(host);
      grid.append(field);
    }
    resWrap.append(grid);
    this.bodyEl.append(resWrap);

    /* ----------------------------- sample rows -------------------------- */
    // A small preview of the parsed data (first few rows) so the user can see
    // what each column holds while mapping. Uses the preview_rows the upload
    // step returned (already capped server-side at 20).
    if (this.previewRows.length > 0 && this.headers.length > 0) {
      const sampleWrap = document.createElement('div');
      sampleWrap.className = 'import-wizard__sample';
      sampleWrap.dataset.iwSample = '';
      sampleWrap.append(sectionLabel('Sample rows'));
      const scroll = document.createElement('div');
      scroll.className = 'import-wizard__sample-scroll scroll-x';
      const table = document.createElement('table');
      table.className = 'import-wizard__sample-table';
      const thead = document.createElement('thead');
      const htr = document.createElement('tr');
      for (const h of this.headers) {
        const th = document.createElement('th');
        th.textContent = h;
        htr.append(th);
      }
      thead.append(htr);
      const tbody = document.createElement('tbody');
      for (const row of this.previewRows.slice(0, 5)) {
        const tr = document.createElement('tr');
        for (let i = 0; i < this.headers.length; i++) {
          const td = document.createElement('td');
          td.textContent = row[i] ?? '';
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(thead, tbody);
      scroll.append(table);
      sampleWrap.append(scroll);
      this.bodyEl.append(sampleWrap);
    }
  }

  private renderPreviewStep(): void {
    if (this.previewBusy) {
      const loading = document.createElement('div');
      loading.className = 'import-wizard__loading muted';
      loading.dataset.iwLoading = '';
      loading.textContent = 'Running preview…';
      this.bodyEl.append(loading);
      return;
    }
    if (this.previewOut === null) {
      const empty = document.createElement('div');
      empty.className = 'import-wizard__loading muted';
      empty.textContent = 'No preview yet.';
      this.bodyEl.append(empty);
      return;
    }
    const out = this.previewOut;
    const p = document.createElement('p');
    p.className = 'import-wizard__hint muted';
    p.textContent = 'Dry run — nothing has been written yet. Review the counts and any errors below.';
    this.bodyEl.append(p);

    this.bodyEl.append(this.renderSummary('Would create', out.wouldCreate, out.skippedRows));
    this.bodyEl.append(this.renderErrors(out.errors));
  }

  private renderCommitStep(): void {
    if (this.committing) {
      const loading = document.createElement('div');
      loading.className = 'import-wizard__loading muted';
      loading.dataset.iwLoading = '';
      loading.textContent = 'Committing import…';
      this.bodyEl.append(loading);
      return;
    }
    if (this.commitOut === null) {
      const empty = document.createElement('div');
      empty.className = 'import-wizard__loading muted';
      empty.textContent = 'Ready to commit.';
      this.bodyEl.append(empty);
      return;
    }
    const out = this.commitOut;
    const banner = document.createElement('div');
    banner.className = 'import-wizard__success';
    banner.dataset.iwSuccess = '';
    banner.textContent = `Import complete — created ${out.created.tasks} task${
      out.created.tasks === 1 ? '' : 's'
    }.`;
    this.bodyEl.append(banner);
    this.bodyEl.append(this.renderSummary('Created', out.created, out.skippedRows));
    if (out.errors.length > 0) this.bodyEl.append(this.renderErrors(out.errors));
  }

  private renderSummary(label: string, counts: ImportCounts, skipped: number): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'import-wizard__summary';
    wrap.dataset.iwSummary = '';
    const rows: Array<[string, number]> = [
      [`${label} tasks`, counts.tasks],
      [`${label} persons`, counts.persons],
      [`${label} milestones`, counts.milestones],
      [`${label} components`, counts.components],
      [`${label} tags`, counts.tags],
      ['Skipped rows', skipped],
    ];
    for (const [text, n] of rows) {
      const k = document.createElement('div');
      k.className = 'import-wizard__summary-k';
      k.textContent = text;
      const v = document.createElement('div');
      v.className = 'import-wizard__summary-v';
      v.textContent = String(n);
      wrap.append(k, v);
    }
    return wrap;
  }

  private renderErrors(errors: ImportError[]): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'import-wizard__errors';
    wrap.dataset.iwErrors = '';
    if (errors.length === 0) {
      wrap.classList.add('import-wizard__errors--clean');
      wrap.textContent = 'No row errors.';
      return wrap;
    }
    const head = document.createElement('p');
    head.className = 'import-wizard__errors-head';
    head.textContent = `${errors.length} error${errors.length === 1 ? '' : 's'}`;
    const list = document.createElement('ul');
    list.className = 'import-wizard__errors-list';
    for (const e of errors.slice(0, MAX_ERRORS_SHOWN)) {
      const li = document.createElement('li');
      li.className = 'import-wizard__errors-item';
      const where = e.column ? `row ${e.row} · ${e.column}` : `row ${e.row}`;
      li.textContent = `${where}: ${e.message}`;
      list.append(li);
    }
    if (errors.length > MAX_ERRORS_SHOWN) {
      const more = document.createElement('li');
      more.className = 'import-wizard__errors-item muted';
      more.textContent = `… ${errors.length - MAX_ERRORS_SHOWN} more`;
      list.append(more);
    }
    wrap.append(head, list);
    return wrap;
  }

  /** Footer button state: labels + enabled/disabled per step + busy flags. */
  private renderFooter(): void {
    // Back is always present; on the first step it doubles as Cancel.
    const idx = STEP_ORDER.indexOf(this.step);
    this.backBtn.textContent = idx === 0 ? 'Cancel' : 'Back';
    this.backBtn.disabled = this.uploading || this.committing;

    let label = 'Next';
    let disabled = false;
    switch (this.step) {
      case 'upload':
        label = this.uploading ? 'Uploading…' : 'Upload & continue';
        disabled = this.uploading || this.file === null || this.projectId === null;
        break;
      case 'map':
        label = this.mapBusy ? 'Saving…' : 'Run preview';
        disabled = this.mapBusy;
        break;
      case 'preview': {
        const hasErrors = (this.previewOut?.errors.length ?? 0) > 0;
        label = 'Commit import';
        // Block commit while the dry-run is loading or has unresolved errors.
        disabled = this.previewBusy || this.previewOut === null || hasErrors;
        break;
      }
      case 'commit':
        label = this.committing ? 'Committing…' : 'Done';
        disabled = this.committing;
        break;
    }
    this.nextLabelEl.textContent = label;
    this.nextBtn.disabled = disabled;
  }

  private showError(msg: string): void {
    this.errorEl.textContent = msg;
    this.errorEl.style.display = '';
  }
  private clearError(): void {
    this.errorEl.textContent = '';
    this.errorEl.style.display = 'none';
  }

  /* ------------------------------ test seams ----------------------------- */

  /** TEST: inject the raw chunk-POST sink (an in-memory CAS store). */
  _setPostChunkForTest(postChunk: PostChunk): void {
    this.postChunkOverride = postChunk;
  }
  /** TEST: queue a file as if picked in the upload step. */
  _setFileForTest(file: File): void {
    this.file = file;
    this.renderFooter();
  }
  /** TEST: read the current in-memory mapping object. */
  _mappingForTest(): Record<string, string> {
    return { ...this.mapping };
  }
  /** TEST: read the current step. */
  _stepForTest(): WizardStep {
    return this.step;
  }
  /** TEST: set a column's target as the mapping combobox would. */
  _setMappingTargetForTest(header: string, target: string): void {
    this.mapping[header] = target;
  }
  /** TEST: set a resolution category mode as its combobox would. */
  _setResolutionForTest(cat: ResolutionCategory, mode: ResolutionMode): void {
    this.resolution[cat] = mode;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                    */
/* -------------------------------------------------------------------------- */

function labeledField(label: string): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'import-wizard__field';
  const span = document.createElement('span');
  span.className = 'import-wizard__label';
  span.textContent = label;
  wrap.append(span);
  return wrap;
}

function sectionLabel(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'import-wizard__section-label muted';
  el.textContent = text;
  return el;
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
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

export function registerImportWizard(): void {
  Control.register('ImportWizard', ImportWizard);
}
