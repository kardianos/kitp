/**
 * ProjectPropertiesPanel — the slide-over editor for a PROJECT card's own
 * properties (title + markdown-source description + its project-bound
 * attributes), plus the Export (#42) / Import (#41) HOOK buttons.
 *
 * Ports the SHELL of the Svelte `client/src/ui/widgets/ProjectPropertiesPanel.svelte`
 * (a SlideOver), re-expressed against the `web/` framework and REUSING the
 * task-detail attribute-panel pattern: one `<details>` row per editable
 * attribute, the inline editor chosen by value_type
 * (RefPicker / DatePicker / checkbox / number / text), each commit firing
 * `attribute.update` OPTIMISTICALLY on the project card.
 *
 *   - Title  → an <input>; commit on blur / Enter (no-op on empty / unchanged).
 *   - Description → a <textarea> (markdown SOURCE); commit on blur / Mod+Enter.
 *   - Attributes → the per-value_type inline editors, sourced from
 *     `attribute_def.select` filtered to defs BOUND to the `project` card_type,
 *     minus the built-ins rendered above (title/description) + the ones never
 *     edited here (tags/sort_order).
 *   - Export / Import → buttons that fire the `projectExport` / `projectImport`
 *     bus intents the AppShell handles (#42 ExportMenu / #41 ImportWizard own the
 *     real flows; this panel only raises the intent).
 *
 * Data flow ZERO-PROMISE (the TaskDetail posture): the project + the schema
 * load through `api.callByName(..., { alive })`; card_ref summaries resolve via
 * `card.search`. Every commit patches the loaded project's attribute
 * immediately, fires `attribute.update`, and rolls back + surfaces inline on
 * fault. On success the panel hands the updated card back to its host
 * (`config.onSaved`) so the project HEADER repaints.
 *
 * Reference (NOT imported): `client/src/ui/widgets/ProjectPropertiesPanel.svelte`
 * + `client/src/ui/widgets/AttributeSidePanel.svelte`.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { RichEditor } from '../editor/rich-editor.js';
import {
  SPEC,
  type SelectWithAttributesOutput,
  type AttributeUpdateOutput,
} from '../kanban/specs.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import { CARD_SEARCH_SPEC } from '../ui/specs.js';
import { ADMIN_SPEC, type AttributeDefListOutput } from '../admin/specs.js';
import { schemaForCardType, type AttrSchema } from '../filter/attribute-schema.js';
import type { RefPicker } from '../ui/ref-picker.js';
import type { DatePicker } from '../ui/datepicker.js';

import { icon } from '../ui/icons.js';
import { captionedField } from '../ui/captioned-field.js';
import { BUNDLE_SPEC, type BundleFeature, type BundleListOutput } from '../bundles/specs.js';
import { faultText } from '../admin/record-form.js';
/* -------------------------------------------------------------------------- */
/* Config.                                                                    */
/* -------------------------------------------------------------------------- */

export interface ProjectPropertiesPanelConfig extends BaseControlConfig {
  type: 'ProjectPropertiesPanel';
  /** The project card_type name (drives the bound-attribute schema). Default 'project'. */
  cardTypeName?: string;
  /** Notified with the (optimistically) updated project card after each commit. */
  onSaved?: (project: CardWithAttrs) => void;
  /** Tree path bumped after a feature is added, so data-driven navigation
   *  (the project's screen tabs / sidebar) reloads. Default 'shell.navRefresh'. */
  navRefreshPath?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    ProjectPropertiesPanel: ProjectPropertiesPanelConfig;
  }
}

/**
 * Built-ins the panel does NOT render as generic attribute rows: title /
 * description have dedicated fields above; tags / sort_order are never edited
 * here. Mirrors the Svelte panel's schema skip-list.
 */
// bundle_key marks a feature bundle's hidden source project — server-owned,
// never something a person edits on a project.
const PANEL_SKIP_ATTRS = new Set(['title', 'description', 'tags', 'sort_order', 'bundle_key']);

/** A card_ref attribute whose target card_type is NOT project-scoped. */
const GLOBAL_REF_CARD_TYPES = new Set(['person']);

/* -------------------------------------------------------------------------- */
/* Control.                                                                   */
/* -------------------------------------------------------------------------- */

export class ProjectPropertiesPanel extends Control<ProjectPropertiesPanelConfig> {
  private readonly cardTypeName: string;

  /** The project being edited. */
  private projectId: bigint | null = null;
  private project: CardWithAttrs | null = null;
  /** project-bound editable attribute schema. */
  private schema: AttrSchema[] = [];
  /** card_ref label cache (stringified id → label). */
  private readonly refLabels = new Map<string, string>();

  /* DOM regions. */
  private loadingEl!: HTMLElement;
  private titleHost!: HTMLElement;
  private descHost!: HTMLElement;
  private panelBody!: HTMLElement;
  private featuresBody!: HTMLElement;

  private titleInput: HTMLInputElement | null = null;
  private descEditor: RichEditor | null = null;

  /** Per-row child editors (RefPicker / DatePicker) to dispose on rebuild. */
  private rowChildren: Control[] = [];
  private isOpen = false;

  constructor(...args: ConstructorParameters<typeof Control<ProjectPropertiesPanelConfig>>) {
    super(...args);
    this.cardTypeName = this.config.cardTypeName ?? 'project';
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'project-props';
    el.dataset.control = 'ProjectPropertiesPanel';
    el.style.display = 'none';
    return el;
  }

  protected render(): void {
    const backdrop = document.createElement('div');
    backdrop.className = 'project-props__backdrop';
    backdrop.dataset.projectPropsBackdrop = '';
    this.listen(backdrop, 'click', () => this.close());

    const sheet = document.createElement('aside');
    sheet.className = 'project-props__sheet';
    sheet.dataset.projectPropsSheet = '';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Project properties');

    const head = document.createElement('header');
    head.className = 'project-props__head';
    const headTitle = document.createElement('h2');
    headTitle.className = 'project-props__head-title';
    headTitle.textContent = 'Project properties';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'iconbtn project-props__close';
    closeBtn.dataset.projectPropsClose = '';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.append(icon('x', 14));
    this.listen(closeBtn, 'click', () => this.close());
    head.append(headTitle, closeBtn);

    const body = document.createElement('div');
    body.className = 'project-props__body scroll-y';

    const loading = document.createElement('div');
    loading.className = 'project-props__loading muted';
    loading.dataset.projectPropsLoading = '';
    loading.textContent = 'Loading…';
    loading.setAttribute('aria-live', 'polite');
    this.loadingEl = loading;

    /* --- Title field --- */
    const titleHost = document.createElement('div');
    this.titleHost = titleHost;
    const titleField = this.field('Title', titleHost);

    /* --- Description field (markdown source) --- */
    const descHost = document.createElement('div');
    this.descHost = descHost;
    const descField = this.field('Description', descHost);
    // The description editor holds engine state (a ProseMirror view) to tear down.
    this.onDestroy(() => this.descEditor?.destroy());

    /* --- Attributes section --- */
    const attrsSection = document.createElement('section');
    attrsSection.className = 'project-props__section';
    const attrsLabel = document.createElement('div');
    attrsLabel.className = 'project-props__section-label muted';
    attrsLabel.textContent = 'ATTRIBUTES';
    const panelBody = document.createElement('div');
    panelBody.className = 'project-props__panel';
    panelBody.dataset.projectPropsAttrs = '';
    this.panelBody = panelBody;
    attrsSection.append(attrsLabel, panelBody);

    /* --- Export / Import HOOK buttons (#42 / #41) --- */
    const ioSection = document.createElement('section');
    ioSection.className = 'project-props__section';
    const ioLabel = document.createElement('div');
    ioLabel.className = 'project-props__section-label muted';
    ioLabel.textContent = 'EXPORT · IMPORT';
    const ioRow = document.createElement('div');
    ioRow.className = 'project-props__io';
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'btn project-props__export';
    exportBtn.dataset.projectPropsExport = '';
    exportBtn.textContent = 'Export…';
    this.listen(exportBtn, 'click', () => this.onExport());
    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'btn project-props__import';
    importBtn.dataset.projectPropsImport = '';
    importBtn.textContent = 'Import…';
    this.listen(importBtn, 'click', () => this.onImport());
    ioRow.append(exportBtn, importBtn);
    ioSection.append(ioLabel, ioRow);

    /* --- Features (feature bundles: add what the project doesn't have) --- */
    const featuresSection = document.createElement('section');
    featuresSection.className = 'project-props__section';
    const featuresLabel = document.createElement('div');
    featuresLabel.className = 'project-props__section-label muted';
    featuresLabel.textContent = 'FEATURES';
    const featuresBody = document.createElement('div');
    featuresBody.className = 'project-props__features';
    featuresBody.dataset.projectPropsFeatures = '';
    this.featuresBody = featuresBody;
    featuresSection.append(featuresLabel, featuresBody);

    body.append(loading, titleField, descField, attrsSection, featuresSection, ioSection);
    sheet.append(head, body);
    this.el.append(backdrop, sheet);

    // Esc closes the sheet when it has focus within.
    this.listen(this.el, 'keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Escape') {
        ev.preventDefault();
        this.close();
      }
    });
  }

  /* -------------------------------- open/close --------------------------- */

  /** Open the panel for a project id; (re)loads the project + schema. */
  open(projectId: bigint): void {
    this.projectId = projectId;
    this.isOpen = true;
    this.el.style.display = '';
    this.el.classList.add('project-props--open');
    // Reset the visible state to "loading" until the project lands.
    this.project = null;
    this.loadingEl.style.display = '';
    this.titleHost.replaceChildren();
    this.descHost.replaceChildren();
    this.disposeRowChildren();
    this.panelBody.replaceChildren();
    this.featuresBody.replaceChildren();
    this.loadProject();
    this.loadFeatures();
    if (this.schema.length === 0) this.loadSchema();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.classList.remove('project-props--open');
    this.el.style.display = 'none';
  }

  /* --------------------------------- loads ------------------------------- */

  private loadProject(): void {
    const id = this.projectId;
    if (id === null) return;
    this.ctx.api.callByName(
      SPEC.selectWithAttributes,
      { cardTypeName: this.cardTypeName },
      (out) => {
        const rows = (out as SelectWithAttributesOutput).rows ?? [];
        this.project = rows.find((r) => r.id === id) ?? null;
        this.loadingEl.style.display = 'none';
        this.renderTitle();
        this.renderDescription();
        this.renderPanel();
        this.resolveRefLabels();
      },
      { alive: () => this.isAlive() },
    );
  }

  private loadSchema(): void {
    this.ctx.api.callByName(
      ADMIN_SPEC.attributeDefSelect,
      {},
      (out) => {
        const defs = (out as AttributeDefListOutput).rows ?? [];
        const full = schemaForCardType(defs, this.cardTypeName);
        this.schema = full.filter((a) => !PANEL_SKIP_ATTRS.has(a.name));
        if (this.project !== null) this.renderPanel();
      },
      { alive: () => this.isAlive() },
    );
  }

  /** Resolve display labels for the project's set card_ref values. */
  private resolveRefLabels(): void {
    const project = this.project;
    if (project === null) return;
    const byType = new Map<string, Set<bigint>>();
    for (const attr of this.schema) {
      if (attr.valueType !== 'card_ref' && attr.valueType !== 'card_ref[]') continue;
      const target = attr.targetCardType;
      if (target === undefined) continue;
      const v = project.attributes[attr.name];
      const collect = (id: unknown): void => {
        if (typeof id === 'bigint') {
          let set = byType.get(target);
          if (set === undefined) {
            set = new Set();
            byType.set(target, set);
          }
          set.add(id);
        }
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
          if (this.isAlive() && this.project !== null) this.renderPanel();
        },
        { alive: () => this.isAlive() },
      );
    }
  }

  /* -------------------------------- title -------------------------------- */

  private titleText(): string {
    const t = this.project?.attributes['title'];
    return typeof t === 'string' ? t : '';
  }

  private renderTitle(): void {
    this.titleHost.replaceChildren();
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'project-props__input';
    input.dataset.projectPropsTitle = '';
    input.value = this.titleText();
    input.setAttribute('aria-label', 'Project title');
    input.placeholder = 'Project title';
    this.titleInput = input;
    this.listen(input, 'keydown', (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commitTitle(input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        input.value = this.titleText();
      }
    });
    this.listen(input, 'blur', () => this.commitTitle(input.value));
    this.titleHost.append(input);
  }

  private commitTitle(raw: string): void {
    const next = raw.trim();
    const cur = this.titleText();
    if (next === '' || next === cur) {
      if (this.titleInput) this.titleInput.value = cur;
      return;
    }
    this.commitAttribute('title', next);
  }

  /* ----------------------------- description ----------------------------- */

  private descriptionText(): string {
    const d = this.project?.attributes['description'];
    return typeof d === 'string' ? d : '';
  }

  private renderDescription(): void {
    this.descEditor?.destroy();
    this.descEditor = null;
    this.descHost.replaceChildren();
    // Live-commit inline editor (no Save button): Mod+Enter and blur both
    // commit; Escape reverts to the stored value.
    this.descEditor = new RichEditor({
      value: this.descriptionText(),
      ariaLabel: 'Project description',
      placeholder: 'Markdown supported · Mod+Enter to save',
      minRows: 5,
      editableClassName: 'project-props__input project-props__textarea',
      editableAttrs: { 'data-project-props-desc': '' },
      onCommit: (md) => this.commitDescription(md),
      onBlur: () => this.commitDescription(this.descEditor?.getValue() ?? ''),
      onCancel: () => this.descEditor?.setValue(this.descriptionText(), true),
    });
    this.descHost.append(this.descEditor.el);
  }

  private commitDescription(raw: string): void {
    const next = raw;
    const cur = this.descriptionText();
    if (next === cur) return;
    this.commitAttribute('description', next);
  }

  /* --------------------------- attribute panel --------------------------- */

  private renderPanel(): void {
    this.disposeRowChildren();
    this.panelBody.replaceChildren();
    if (this.project === null) return;
    if (this.schema.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'project-props__panel-empty muted';
      empty.textContent = 'No project attributes.';
      this.panelBody.append(empty);
      return;
    }
    for (const attr of this.schema) this.panelBody.append(this.renderRow(attr));
  }

  private renderRow(attr: AttrSchema): HTMLElement {
    const row = document.createElement('details');
    row.className = 'project-props__row';
    row.dataset.attrRow = attr.name;

    const summary = document.createElement('summary');
    summary.className = 'project-props__row-summary';
    const label = document.createElement('span');
    label.className = 'project-props__row-label muted';
    label.textContent = attr.label;
    const value = document.createElement('span');
    value.className = 'project-props__row-value';
    value.dataset.attrValue = '';
    value.textContent = this.summaryFor(attr);
    summary.append(label, value);
    row.append(summary);

    const editor = document.createElement('div');
    editor.className = 'project-props__row-editor';
    editor.dataset.attrEditor = '';
    row.append(editor);

    const errEl = document.createElement('p');
    errEl.className = 'project-props__row-error';
    errEl.dataset.attrError = '';
    errEl.setAttribute('role', 'alert');
    errEl.style.display = 'none';
    editor.append(errEl);

    let mounted = false;
    this.listen(row, 'toggle', () => {
      if ((row as unknown as { open?: boolean }).open !== true) return;
      if (mounted) return;
      mounted = true;
      this.mountEditor(attr, editor, value, errEl);
    });
    return row;
  }

  private summaryFor(attr: AttrSchema): string {
    const v = this.project?.attributes[attr.name];
    if (v === null || v === undefined || v === '') return '—';
    if (attr.valueType === 'card_ref') {
      return typeof v === 'bigint' ? this.labelFor(v) : String(v);
    }
    if (attr.valueType === 'card_ref[]') {
      if (!Array.isArray(v) || v.length === 0) return '—';
      return v.map((id) => (typeof id === 'bigint' ? this.labelFor(id) : String(id))).join(', ');
    }
    if (attr.valueType === 'bool') return v === true ? 'Yes' : 'No';
    if (typeof v === 'bigint') return v.toString();
    return String(v);
  }

  private labelFor(id: bigint): string {
    return this.refLabels.get(String(id)) ?? `#${id.toString()}`;
  }

  private mountEditor(
    attr: AttrSchema,
    editor: HTMLElement,
    valueEl: HTMLElement,
    errEl: HTMLElement,
  ): void {
    const cur = this.project?.attributes[attr.name];
    const onDone = (): void => {
      valueEl.textContent = this.summaryFor(attr);
    };
    const onCommit = (next: unknown): void => {
      this.commitAttribute(attr.name, next, onDone, errEl);
    };

    switch (attr.valueType) {
      case 'card_ref': {
        const rp = this.spawn(
          'RefPicker',
          {
            type: 'RefPicker',
            cardType: attr.targetCardType ?? 'card',
            attributeName: attr.name,
            value: typeof cur === 'bigint' ? cur : null,
            ...(typeof cur === 'bigint' ? { currentLabel: this.labelFor(cur) } : {}),
            ...(this.refScopePath(attr) ? { parentScopePath: this.refScopePath(attr) } : {}),
            'aria-label': attr.label,
            placeholder: `Search ${attr.label.toLowerCase()}…`,
            onChange: (value: bigint | null) => onCommit(value),
          },
          editor,
        ) as RefPicker;
        this.rowChildren.push(rp);
        break;
      }
      case 'card_ref[]': {
        const cur2 = Array.isArray(cur)
          ? (cur as unknown[]).filter((x): x is bigint => typeof x === 'bigint')
          : [];
        const labels: Record<string, string> = {};
        for (const id of cur2) labels[String(id)] = this.labelFor(id);
        const rp = this.spawn(
          'RefPicker',
          {
            type: 'RefPicker',
            cardType: attr.targetCardType ?? 'card',
            attributeName: attr.name,
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
        break;
      }
      case 'bool': {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'project-props__row-checkbox';
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
        input.className = 'project-props__row-number';
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
        break;
      }
      default: {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'project-props__row-text';
        input.dataset.attrInput = '';
        input.value =
          typeof cur === 'string' ? cur : cur === null || cur === undefined ? '' : String(cur);
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
        break;
      }
    }
  }

  /**
   * The parent-scope path for a project-scoped ref editor: the project being
   * edited IS the enclosing project, so its milestones/components/tags sit under
   * it (parent_card_id == projectId). Person refs stay global. Seeds the leaf +
   * returns its dotted path; undefined when no scope applies.
   */
  private refScopePath(attr: AttrSchema): string | undefined {
    const target = attr.targetCardType;
    if (target === undefined || GLOBAL_REF_CARD_TYPES.has(target)) return undefined;
    if (this.projectId === null) return undefined;
    const path = ['projectProps', 'refScope'];
    this.ctx.tree.at(path).set(this.projectId);
    return path.join('.');
  }

  /* ---------------------------- commit + state --------------------------- */

  /**
   * Fire `attribute.update` for one attribute, OPTIMISTICALLY: patch the loaded
   * project immediately, repaint, notify the host (header repaint), and roll
   * back + surface inline on fault. Zero-promise.
   */
  private commitAttribute(
    name: string,
    value: unknown,
    onDone?: () => void,
    errEl?: HTMLElement,
  ): void {
    const project = this.project;
    if (project === null || this.projectId === null) return;
    const prev = project.attributes[name];
    project.attributes = { ...project.attributes, [name]: value ?? null };
    if (errEl) {
      errEl.style.display = 'none';
      errEl.textContent = '';
    }
    onDone?.();
    // Title / description have no row valueEl; repaint their fields + tell the
    // host so the header tracks the optimistic change.
    if (name === 'title' && this.titleInput) this.titleInput.value = this.titleText();
    if (name === 'description') this.descEditor?.setValue(this.descriptionText());
    this.config.onSaved?.(project);

    this.ctx.api.callByName(
      SPEC.attributeUpdate,
      { cardId: this.projectId, attributeName: name, value: value ?? null },
      (_out) => {
        void (_out as AttributeUpdateOutput);
        if (!this.isAlive()) return;
        this.resolveRefLabels();
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          if (!this.isAlive()) return;
          if (this.project !== null) {
            this.project.attributes = { ...this.project.attributes, [name]: prev };
          }
          onDone?.();
          if (name === 'title' && this.titleInput) this.titleInput.value = this.titleText();
          if (name === 'description') this.descEditor?.setValue(this.descriptionText(), true);
          if (this.project !== null) this.config.onSaved?.(this.project);
          if (errEl) {
            errEl.style.display = '';
            errEl.textContent = 'Failed to save. Try again.';
          }
        },
      },
    );
  }

  /* ------------------------------- features ------------------------------ */

  /** Load the feature catalog with this project's enabled / conflict state. */
  private loadFeatures(): void {
    const id = this.projectId;
    if (id === null) return;
    this.ctx.api.callByName(
      BUNDLE_SPEC.list,
      { projectId: id },
      (out) => {
        if (this.projectId !== id) return;
        this.renderFeatures((out as BundleListOutput).features ?? []);
      },
      {
        alive: () => this.isAlive(),
        // An older server has no bundles: say so instead of an empty section.
        onErr: () => {
          if (this.projectId !== id) return;
          this.renderFeatures([]);
        },
      },
    );
  }

  /**
   * One row per feature bundle: enabled ones are marked; the rest offer Add,
   * unless the project can't take them (it already drives one of the
   * feature's flow attributes itself) — then the reason shows instead.
   */
  private renderFeatures(features: BundleFeature[]): void {
    const host = this.featuresBody;
    if (features.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'project-props__features-empty muted';
      empty.textContent = 'No feature bundles are available.';
      host.replaceChildren(empty);
      return;
    }
    const rows = features.map((f) => {
      const row = document.createElement('div');
      row.className = 'project-props__feature';
      row.dataset.feature = f.key;
      const text = document.createElement('div');
      text.className = 'project-props__feature-text';
      const name = document.createElement('div');
      name.className = 'project-props__feature-title';
      name.textContent = f.title;
      const doc = document.createElement('div');
      doc.className = 'project-props__feature-doc muted';
      doc.textContent = f.conflict !== '' && !f.enabled ? f.conflict : f.doc;
      text.append(name, doc);
      const err = document.createElement('div');
      err.className = 'project-props__row-error';
      err.dataset.featureError = '';
      err.style.display = 'none';
      text.append(err);
      row.append(text);
      if (f.enabled) {
        const on = document.createElement('span');
        on.className = 'badge badge--success project-props__feature-on';
        on.dataset.featureEnabled = '';
        on.textContent = 'On';
        row.append(on);
        return row;
      }
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'btn project-props__feature-add';
      add.dataset.featureAdd = f.key;
      add.textContent = 'Add';
      if (f.conflict !== '') {
        add.disabled = true;
        add.title = f.conflict;
        row.classList.add('project-props__feature--conflict');
      } else {
        this.listen(add, 'click', () => this.addFeature(f.key, add, err));
      }
      row.append(add);
      return row;
    });
    host.replaceChildren(...rows);
  }

  /** bundle.apply one feature, then reload the catalog and let the host (and
   *  the data-driven nav) pick up the new screens. */
  private addFeature(key: string, btn: HTMLButtonElement, errEl: HTMLElement): void {
    const id = this.projectId;
    if (id === null) return;
    btn.disabled = true;
    btn.textContent = 'Adding…';
    errEl.style.display = 'none';
    this.ctx.api.callByName(
      BUNDLE_SPEC.apply,
      { projectId: id, keys: [key] },
      () => {
        if (!this.isAlive()) return;
        const nav = this.ctx.tree.at((this.config.navRefreshPath ?? 'shell.navRefresh').split('.'));
        nav.set((nav.peek<number>() ?? 0) + 1);
        if (this.project !== null) this.config.onSaved?.(this.project);
        this.loadFeatures();
      },
      {
        alive: () => this.isAlive(),
        onErr: (fault) => {
          if (!this.isAlive()) return;
          btn.disabled = false;
          btn.textContent = 'Add';
          errEl.textContent = faultText(fault);
          errEl.style.display = '';
        },
      },
    );
  }

  /* ---------------------------- export / import -------------------------- */

  private onExport(): void {
    // The AppShell owns the single ExportMenu instance and opens it on this
    // intent (#42 — CSV / xlsx / ZIP same-origin download).
    this.ctx.bus?.emit('projectExport', { projectId: this.projectId });
  }

  private onImport(): void {
    // The AppShell owns the single ImportWizard instance and opens it on this
    // intent (#41 — upload→map→preview→commit over the CAS pipeline).
    this.ctx.bus?.emit('projectImport', { projectId: this.projectId });
  }

  /* -------------------------------- helpers ------------------------------ */

  /** Caption + host in the panel's field shell. The hosts hold composite
   *  editors (the description RichEditor's toolbar is a row of buttons), so
   *  this is a div group, never a <label> — see ui/captioned-field.ts. */
  private field(label: string, control: HTMLElement): HTMLElement {
    return captionedField(label, control, { field: 'project-props__field', caption: 'project-props__field-label muted' });
  }

  private disposeRowChildren(): void {
    for (const c of this.rowChildren) this.destroyChild(c);
    this.rowChildren = [];
  }
}

export function registerProjectPropertiesPanel(): void {
  Control.register('ProjectPropertiesPanel', ProjectPropertiesPanel);
}
