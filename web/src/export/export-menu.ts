/**
 * ExportMenu — the project-export dropdown (#42), a Popover-anchored menu
 * launched from the Project detail's Export hook.
 *
 * Mounted ONCE into the shell root (the QuickEntry / ImportWizard / HelpOverlay
 * idiom) and opened by the `projectExport` bus intent, which carries
 * `{ projectId, anchor, predicate? }`. The menu anchors to the Export button
 * (the `anchor` element the intent forwards) via the shared {@link Popover}
 * helper — the ONE place floating-ui is used.
 *
 * The panel offers:
 *   - a FORMAT choice (CSV / Excel .xlsx / ZIP) as a radio group, and
 *   - TOGGLES — "Include deleted tasks" (all formats), "Include attachments"
 *     and "Include activity" (ZIP-only; disabled + hidden-by-relevance for
 *     CSV / XLSX since those routes ignore them).
 *
 * Choosing "Export" triggers a SAME-ORIGIN browser download of the
 * projectexport GET route for `(project, format, toggles)`:
 *   - CSV uses a hidden `<a download href=url>` click (a same-origin
 *     navigation the browser saves; the kitp_session cookie rides along).
 *   - XLSX / ZIP fetch the URL → object-URL → `<a download>` so we honour the
 *     server's Content-Disposition filename AND surface a non-2xx as an inline
 *     error rather than navigating to a JSON error page.
 * Both paths live in `export-helpers.ts`; this control owns only the menu DOM,
 * the in-flight state, and the close-on-done.
 *
 * Cascade-safe: open/close is a pure DOM action (Popover.open/destroy — no
 * signal write), and the download is a DOM/navigation side effect, NOT a batch
 * spec. The single private promise (the blob fetch) is consumed inside a
 * try/catch and never crosses the control boundary into a tracked effect.
 *
 * Reference (NOT imported): client/src/filter/ExportMenu.svelte +
 * client/src/screens/admin/project_export.ts.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { Popover } from '../ui/popover.js';
import type { Predicate } from '../filter/predicate.js';
import { toWire } from '../filter/predicate.js';
import {
  type ExportFormat,
  type ExportToggles,
  type BlobDownloadDeps,
  defaultToggles,
  exportNavUrl,
  fallbackFilename,
  downloadViaAnchor,
  downloadViaBlob,
} from './export-helpers.js';

/* -------------------------------------------------------------------------- */
/* Config + declaration-merged registry type.                                 */
/* -------------------------------------------------------------------------- */

export interface ExportMenuConfig extends BaseControlConfig {
  type: 'ExportMenu';
  /**
   * Same-origin base for the export URL. Defaults to '' (the production
   * BFF-cookie path). Tests may set it to assert against an absolute URL.
   */
  apiBase?: string;
  /**
   * Injected download sink for the CSV (anchor) path — tests capture the URL
   * without a real navigation. Defaults to {@link downloadViaAnchor}.
   */
  navDownload?: (url: string) => void;
  /**
   * Injected fetch-blob deps for the xlsx/zip path (tests stub the network).
   * Defaults to the real fetch + object-URL machinery.
   */
  blobDeps?: BlobDownloadDeps;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    ExportMenu: ExportMenuConfig;
  }
}

/** The detail the `projectExport` intent carries. */
interface ExportIntentDetail {
  projectId?: bigint | null;
  /** The Export button to anchor the popover against. */
  anchor?: HTMLElement;
  /** The active screen predicate (sent as the `tree` query param). */
  predicate?: Predicate | null;
}

const FORMAT_LABELS: ReadonlyArray<{ value: ExportFormat; label: string; hint: string }> = [
  { value: 'csv', label: 'CSV', hint: 'One row per task (.csv)' },
  { value: 'xlsx', label: 'Excel', hint: 'Single-sheet workbook (.xlsx)' },
  { value: 'zip', label: 'ZIP', hint: 'Full archive — all CSVs + attachments' },
];

/* -------------------------------------------------------------------------- */
/* Control.                                                                    */
/* -------------------------------------------------------------------------- */

export class ExportMenu extends Control<ExportMenuConfig> {
  /** The open popover, or null when closed. The control owns no resting DOM. */
  private menu: Popover | null = null;

  /** The project being exported (set on open). */
  private projectId: bigint | null = null;
  /** The active screen predicate forwarded by the opener (sent as `tree`). */
  private predicate: Predicate | null = null;

  /** Current selection. */
  private format: ExportFormat = 'csv';
  private toggles: ExportToggles = defaultToggles();

  /** One-shot in-flight guard so a slow download click doesn't queue dupes. */
  private running = false;

  /* Panel regions held so a format switch / in-flight repaints without a full
   * rebuild. Re-created each open() since the popover panel is fresh. */
  private togglesEl: HTMLElement | null = null;
  private exportBtn: HTMLButtonElement | null = null;
  private errorEl: HTMLElement | null = null;

  protected override createRoot(): HTMLElement {
    // No resting DOM — the menu is a Popover appended to <body> on open. We
    // still own a (display:none) anchor element so the control has a node in
    // the tree (mount() requires one) and the registry/hotkey walk is happy.
    const el = document.createElement('div');
    el.className = 'export-menu-host';
    el.dataset.control = 'ExportMenu';
    el.style.display = 'none';
    return el;
  }

  protected render(): void {
    // Nothing painted at rest — open() builds the popover panel on demand.
  }

  override destroy(): void {
    this.closeMenu();
    super.destroy();
  }

  /* ------------------------------ open / close --------------------------- */

  /** True while the menu popover is open. */
  isOpen(): boolean {
    return this.menu !== null && this.menu.isOpen;
  }

  /**
   * Open the menu anchored to the Export button. `detail.projectId` is the
   * export target; `detail.anchor` is the button to position against;
   * `detail.predicate` (if any) rides the export URL as the `tree` param.
   * A no-op when no project or no anchor is supplied.
   */
  open(detail?: unknown): void {
    const d = (detail ?? {}) as ExportIntentDetail;
    const id = d.projectId ?? null;
    const anchor = d.anchor ?? null;
    if (id === null || anchor === null) return;

    // Re-open: tear down the previous popover first.
    this.closeMenu();

    this.projectId = id;
    this.predicate = d.predicate ?? null;
    this.format = 'csv';
    this.toggles = defaultToggles();
    this.running = false;

    const menu = new Popover(anchor, { placement: 'bottom-end', width: '16rem' });
    const panel = menu.element;
    panel.classList.add('export-menu');
    panel.dataset.exportMenu = '';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', 'Export project');
    this.buildPanel(panel);

    this.menu = menu;
    menu.open();
  }

  /** Close + dispose the popover. Idempotent. */
  closeMenu(): void {
    if (this.menu === null) return;
    this.menu.destroy();
    this.menu = null;
    this.togglesEl = null;
    this.exportBtn = null;
    this.errorEl = null;
  }

  /* -------------------------------- panel -------------------------------- */

  private buildPanel(panel: HTMLElement): void {
    /* ------------------------------- format ------------------------------- */
    const fmtGroup = document.createElement('div');
    fmtGroup.className = 'export-menu__group';
    fmtGroup.setAttribute('role', 'radiogroup');
    fmtGroup.setAttribute('aria-label', 'Format');

    const fmtLabel = document.createElement('div');
    fmtLabel.className = 'export-menu__label';
    fmtLabel.textContent = 'Format';
    fmtGroup.append(fmtLabel);

    for (const f of FORMAT_LABELS) {
      const row = document.createElement('label');
      row.className = 'export-menu__radio';
      row.dataset.exportFormat = f.value;

      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'export-format';
      input.value = f.value;
      input.checked = f.value === this.format;
      this.listen(input, 'change', () => {
        if (input.checked) {
          this.format = f.value;
          this.repaintToggles();
        }
      });

      const text = document.createElement('span');
      text.className = 'export-menu__radio-text';
      const name = document.createElement('span');
      name.className = 'export-menu__radio-name';
      name.textContent = f.label;
      const hint = document.createElement('span');
      hint.className = 'export-menu__radio-hint muted';
      hint.textContent = f.hint;
      text.append(name, hint);

      row.append(input, text);
      fmtGroup.append(row);
    }

    /* ------------------------------- toggles ------------------------------ */
    const togglesEl = document.createElement('div');
    togglesEl.className = 'export-menu__group';
    togglesEl.dataset.exportToggles = '';
    this.togglesEl = togglesEl;

    const togLabel = document.createElement('div');
    togLabel.className = 'export-menu__label';
    togLabel.textContent = 'Include';
    togglesEl.append(togLabel);

    /* ------------------------------- error -------------------------------- */
    const error = document.createElement('div');
    error.className = 'export-menu__error';
    error.dataset.exportError = '';
    error.setAttribute('role', 'alert');
    error.style.display = 'none';
    this.errorEl = error;

    /* ------------------------------ actions ------------------------------- */
    const actions = document.createElement('div');
    actions.className = 'export-menu__actions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn export-menu__cancel';
    cancel.dataset.exportCancel = '';
    cancel.textContent = 'Cancel';
    this.listen(cancel, 'click', () => this.closeMenu());

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'btn btn-primary export-menu__export';
    exportBtn.dataset.exportRun = '';
    exportBtn.textContent = 'Export';
    this.listen(exportBtn, 'click', () => this.runExport());
    this.exportBtn = exportBtn;

    actions.append(cancel, exportBtn);

    panel.append(fmtGroup, togglesEl, error, actions);
    this.repaintToggles();
  }

  /**
   * Repaint the toggle rows for the current format. Include-deleted applies to
   * every format; attachments + activity are ZIP-only, so they only render for
   * the ZIP format (the routes ignore them elsewhere).
   */
  private repaintToggles(): void {
    const host = this.togglesEl;
    if (host === null) return;
    // Keep the section label (first child); replace the toggle rows after it.
    const label = host.firstElementChild;
    host.replaceChildren();
    if (label !== null) host.append(label);

    host.append(
      this.toggleRow('Deleted tasks', 'includeDeleted', this.toggles.includeDeleted),
    );
    if (this.format === 'zip') {
      host.append(
        this.toggleRow('Attachments', 'includeAttachments', this.toggles.includeAttachments),
        this.toggleRow('Activity', 'includeActivity', this.toggles.includeActivity),
      );
    }
  }

  private toggleRow(label: string, key: keyof ExportToggles, checked: boolean): HTMLElement {
    const row = document.createElement('label');
    row.className = 'export-menu__check';
    row.dataset.exportToggle = key;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    this.listen(input, 'change', () => {
      this.toggles[key] = input.checked;
    });

    const text = document.createElement('span');
    text.textContent = label;

    row.append(input, text);
    return row;
  }

  /* -------------------------------- export ------------------------------- */

  /** Build the route URL for the current selection. */
  private url(): string | null {
    if (this.projectId === null) return null;
    const base = exportNavUrl(this.projectId, this.format, this.toggles, this.apiBase());
    // Append the predicate tree (the active screen filter) so the export
    // matches what the user is looking at. Bigint card-ref values survive the
    // JSON round-trip via a replacer; the server accepts string + number ids.
    if (this.predicate === null) return base;
    const tree = JSON.stringify(toWire(this.predicate), bigintReplacer);
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}tree=${encodeURIComponent(tree)}`;
  }

  private apiBase(): string {
    return this.config.apiBase ?? '';
  }

  /**
   * Trigger the download for the current selection. CSV navigates via a hidden
   * anchor; xlsx / zip fetch a blob so we can name the file + report errors
   * inline. One-shot-guarded; closes the menu once the download is kicked off.
   */
  private runExport(): void {
    if (this.running || this.projectId === null) return;
    const url = this.url();
    if (url === null) return;
    this.setError(null);

    if (this.format === 'csv') {
      // Same-origin navigation download — synchronous, no promise. Close the
      // menu immediately (the browser owns the save from here).
      const nav = this.config.navDownload ?? downloadViaAnchor;
      nav(url);
      this.closeMenu();
      return;
    }

    // Binary formats: blob fetch so we honour Content-Disposition + can show a
    // non-2xx inline. The promise is consumed HERE inside the control and never
    // escapes into a tracked effect.
    this.running = true;
    this.setBusy(true);
    const fallback = fallbackFilename(this.projectId, this.format);
    void downloadViaBlob(url, fallback, this.config.blobDeps ?? {})
      .then(() => {
        if (!this.isAlive()) return;
        this.running = false;
        this.closeMenu();
      })
      .catch((e: unknown) => {
        if (!this.isAlive()) return;
        this.running = false;
        this.setBusy(false);
        this.setError(e instanceof Error ? e.message : String(e));
      });
  }

  private setBusy(busy: boolean): void {
    this.running = busy;
    const btn = this.exportBtn;
    if (btn === null) return;
    btn.disabled = busy;
    btn.textContent = busy ? 'Exporting…' : 'Export';
  }

  private setError(msg: string | null): void {
    const el = this.errorEl;
    if (el === null) return;
    if (msg === null) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.style.display = '';
    el.textContent = msg;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers + registration.                                                     */
/* -------------------------------------------------------------------------- */

/** JSON.stringify replacer: bigint → decimal string (the server accepts both). */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function registerExportMenu(): void {
  Control.register('ExportMenu', ExportMenu);
}
