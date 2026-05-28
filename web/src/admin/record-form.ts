/**
 * RecordForm — a generic, config-driven editable form for ONE record, mounted
 * in a MasterDetail detail pane. It replaces per-screen bespoke editors: the
 * screen supplies a `fields` table + two data-mapping functions (row→draft,
 * draft→saveInput) and RecordForm owns the rendering, draft state, dependent
 * option loading, save, and list refresh.
 *
 * It reads the master's `${parentScope}.selectedId` + `.items` to know which
 * record to edit, hydrates a draft via `rowToDraft`, renders one input per
 * field, and on Save maps the draft through `draftToInput` → the `saveSpec`,
 * then re-issues `listSpec` so the master list reflects server truth (a new
 * record appears; an edit updates in place) — no navigation needed.
 *
 * The draft lives in an instance field (NOT the tree) so a keystroke doesn't
 * fire the selection effect and replace the focused <input> mid-word; the
 * structural transitions (selection change, + New, save reset) call render
 * explicitly. Zero promises — every call is api.callByName(..., { alive }).
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { MasterDetailItem } from './master-detail.js';

export type RecordFormFieldKind = 'text' | 'secret' | 'select' | 'selectFromQuery' | 'readonly';

/** One input source value for a dependent (selectFromQuery) option load. */
export type OptionInputValue = { lit: unknown } | { fromProject: true };

export interface RecordFormField {
  /** Draft key (camelCase). */
  name: string;
  label: string;
  kind: RecordFormFieldKind;
  placeholder?: string;
  /** Static options (kind 'select'). */
  options?: ReadonlyArray<{ value: string; label: string }>;
  /** Dependent options loaded from a spec (kind 'selectFromQuery'). */
  optionsFrom?: {
    spec: string;
    /** Input template; `{fromProject:true}` injects the active project id. */
    input: Record<string, OptionInputValue>;
    /** Dotted path into each result row for the option value (e.g. 'id'). */
    valueField: string;
    /** Dotted path into each result row for the option label (e.g. 'attributes.title'). */
    labelField: string;
    /** Label for the leading '' option (e.g. 'Use project flow default'). */
    placeholderLabel?: string;
  };
  /** For 'secret': the row field that reports the secret is already stored. */
  configuredFlag?: string;
}

/** The screen-facing config (parentScope + scopeKey are injected by MasterDetail). */
export interface RecordFormScreenConfig {
  title?: string;
  /** Dotted tree path to the active project id. Default 'scope.projectId'. */
  projectScopePath?: string;
  saveSpec: string;
  listSpec: string;
  /** Input field the listSpec scopes on, set to the active project id when the
   *  list is refired after a save. Default 'projectId' (comm_channel.list);
   *  flow.list uses 'scopeCardId'. */
  listProjectKey?: string;
  rowToDraft: (row: Record<string, unknown>) => Record<string, unknown>;
  draftToInput: (draft: Record<string, unknown>, projectId: string) => Record<string, unknown>;
  emptyDraft: () => Record<string, unknown>;
  validate?: (draft: Record<string, unknown>) => Record<string, string>;
  fields: RecordFormField[];
  /** Show the "+ New" button (default true). Set false when creation is owned
   *  elsewhere (e.g. a MasterDetail create dialog that collects structural
   *  fields the edit form doesn't expose, like a flow's governed attribute). */
  allowCreate?: boolean;
  newButtonLabel?: string;
  saveButtonLabel?: string;
}

export interface RecordFormConfig extends BaseControlConfig, RecordFormScreenConfig {
  type: 'RecordForm';
  /** Master scopeKey: reads `${parentScope}.selectedId` + `.items`. */
  parentScope: string;
  /** This form's own tree namespace (currently only for debugging hooks). */
  scopeKey: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    RecordForm: RecordFormConfig;
  }
}

/** Read a dotted path out of a plain row object. */
function readPath(row: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = row;
  for (const seg of dotted.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export class RecordForm extends Control<RecordFormConfig> {
  /** The live draft, or null when nothing is selected and not creating. */
  private draft: Record<string, unknown> | null = null;
  /** True while editing an unsaved new record (vs a selected existing one). */
  private creatingNew = false;
  /** The selectedId the current draft was hydrated from. `undefined` is the
   *  "force re-hydrate on next effect run" sentinel (initial + after save). */
  private lastSel: string | null | undefined = undefined;
  /** The selected master row's raw (for secret 'configured' flags). */
  private row: Record<string, unknown> = {};
  /** Loaded selectFromQuery options, keyed by field name. */
  private options: Record<string, Array<{ value: string; label: string }>> = {};
  /** Project id each field's options were loaded for (dedupe). */
  private optionsLoadedFor: Record<string, string> = {};

  private formHost!: HTMLElement;

  private get selectedPath(): string[] {
    return `${this.config.parentScope}.selectedId`.split('.');
  }
  private get itemsPath(): string[] {
    return `${this.config.parentScope}.items`.split('.');
  }
  private get projectPath(): string[] {
    return (this.config.projectScopePath ?? 'scope.projectId').split('.');
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'record-form';
    el.dataset.control = 'RecordForm';
    return el;
  }

  protected render(): void {
    this.formHost = this.el;
    // Hydrate + render on selection / items change. Does NOT subscribe to the
    // draft (instance field), so typing never re-fires this effect.
    this.effect(() => {
      const sel = this.ctx.tree.at(this.selectedPath).get<string | null>() ?? null;
      const items = (this.ctx.tree.at(this.itemsPath).get<MasterDetailItem[]>() ?? []) as MasterDetailItem[];
      // Re-hydrate only when the selection CHANGED (or a save forced it). An
      // items-only change (e.g. an unrelated edit) keeps the live draft so the
      // user's in-progress edit / + New isn't wiped.
      if (sel !== this.lastSel) {
        this.lastSel = sel;
        this.creatingNew = false;
        const item = sel === null ? null : items.find((it) => it.id === sel) ?? null;
        if (item === null) {
          this.draft = null;
          this.row = {};
        } else {
          this.row = item.raw as Record<string, unknown>;
          this.draft = this.config.rowToDraft(this.row);
        }
      }
      this.renderForm();
    }, 'recordForm.render');
  }

  private projectId(): string {
    const v = this.ctx.tree.at(this.projectPath).peek<unknown>();
    if (v === null || v === undefined) return '';
    return typeof v === 'bigint' ? v.toString() : String(v);
  }

  private renderForm(): void {
    const frag = document.createDocumentFragment();

    const head = document.createElement('div');
    head.className = 'record-form__head';
    const title = document.createElement('h3');
    title.className = 'record-form__title';
    title.textContent = this.config.title ?? (this.creatingNew ? 'New record' : 'Edit record');
    head.append(title);
    if (this.config.allowCreate !== false) {
      const newBtn = document.createElement('button');
      newBtn.type = 'button';
      newBtn.className = 'btn record-form__new';
      newBtn.dataset.recordFormNew = '';
      newBtn.textContent = this.config.newButtonLabel ?? '+ New';
      this.listen(newBtn, 'click', () => {
        this.draft = this.config.emptyDraft();
        this.creatingNew = true;
        this.row = {};
        this.renderForm();
      });
      head.append(newBtn);
    }
    frag.append(head);

    if (this.draft === null) {
      const hint = document.createElement('p');
      hint.className = 'record-form__empty muted';
      hint.dataset.recordFormEmpty = '';
      hint.textContent =
        this.config.allowCreate === false
          ? 'Select a record to edit it.'
          : 'Select a record to edit it, or add a new one.';
      frag.append(hint);
      this.formHost.replaceChildren(frag);
      return;
    }

    const draft = this.draft;
    const form = document.createElement('div');
    form.className = 'record-form__form';
    form.dataset.recordForm = '';
    for (const f of this.config.fields) form.append(this.renderField(f, draft));

    const err = document.createElement('div');
    err.className = 'record-form__error';
    err.dataset.recordFormError = '';
    err.style.display = 'none';
    form.append(err);

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary record-form__save';
    save.dataset.recordFormSave = '';
    save.textContent = this.config.saveButtonLabel ?? 'Save';
    this.listen(save, 'click', () => this.save(err));
    form.append(save);

    frag.append(form);
    this.formHost.replaceChildren(frag);
  }

  private renderField(f: RecordFormField, draft: Record<string, unknown>): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'record-form__field';
    const span = document.createElement('span');
    span.className = 'record-form__label muted';
    span.textContent = f.label;
    wrap.append(span);

    const value = draft[f.name];
    const strValue = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);

    if (f.kind === 'readonly') {
      // Display-only context (e.g. a flow's governed attribute). Reads the draft
      // first, then the raw row (for fields the draft doesn't carry).
      const ro = document.createElement('span');
      ro.className = 'record-form__readonly';
      ro.dataset.recordFormField = f.name;
      const rowVal = this.row[f.name];
      const display = strValue !== '' ? strValue : rowVal === undefined || rowVal === null ? '' : String(rowVal);
      ro.textContent = display || '—';
      wrap.append(ro);
      return wrap;
    }

    if (f.kind === 'select' || f.kind === 'selectFromQuery') {
      const sel = document.createElement('select');
      sel.className = 'record-form__select';
      sel.dataset.recordFormField = f.name;
      const opts =
        f.kind === 'select'
          ? [...(f.options ?? [])]
          : [
              { value: '', label: f.optionsFrom?.placeholderLabel ?? '—' },
              ...(this.options[f.name] ?? []),
            ];
      // Keep the current value visible even if its option hasn't loaded yet.
      if (strValue !== '' && !opts.some((o) => o.value === strValue)) {
        opts.push({ value: strValue, label: `#${strValue}` });
      }
      for (const o of opts) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        if (o.value === strValue) opt.selected = true;
        sel.append(opt);
      }
      sel.value = strValue;
      this.listen(sel, 'change', () => {
        draft[f.name] = sel.value;
      });
      wrap.append(sel);
      if (f.kind === 'selectFromQuery') this.ensureOptions(f);
      return wrap;
    }

    const input = document.createElement('input');
    input.type = f.kind === 'secret' ? 'password' : 'text';
    input.className = 'record-form__input';
    input.dataset.recordFormField = f.name;
    input.value = strValue;
    if (f.placeholder) input.placeholder = f.placeholder;
    this.listen(input, 'input', () => {
      draft[f.name] = input.value;
    });
    wrap.append(input);

    if (f.kind === 'secret' && f.configuredFlag) {
      const hint = document.createElement('span');
      hint.className = 'record-form__hint muted';
      hint.dataset.recordFormSecretState = f.name;
      hint.textContent = this.row[f.configuredFlag] === true ? 'configured — leave blank to keep' : 'not set';
      wrap.append(hint);
    }
    return wrap;
  }

  /** Load a selectFromQuery field's options once per project, then re-render. */
  private ensureOptions(f: RecordFormField): void {
    if (!f.optionsFrom) return;
    const pid = this.projectId();
    if (pid === '' || pid === '0') return;
    if (this.optionsLoadedFor[f.name] === pid) return;
    this.optionsLoadedFor[f.name] = pid;

    const input: Record<string, unknown> = {};
    for (const [k, src] of Object.entries(f.optionsFrom.input)) {
      input[k] = 'fromProject' in src ? pid : src.lit;
    }
    const { valueField, labelField } = f.optionsFrom;
    this.ctx.api.callByName(
      f.optionsFrom.spec,
      input,
      (out) => {
        if (!this.isAlive()) return;
        const rows = ((out ?? {}) as { rows?: Array<Record<string, unknown>> }).rows ?? [];
        this.options[f.name] = rows.map((r) => {
          const v = readPath(r, valueField);
          const id = typeof v === 'bigint' ? v.toString() : String(v);
          const lbl = readPath(r, labelField);
          return { value: id, label: typeof lbl === 'string' && lbl !== '' ? lbl : `#${id}` };
        });
        this.renderForm();
      },
      { alive: () => this.isAlive() },
    );
  }

  private save(err: HTMLElement): void {
    const draft = this.draft;
    if (draft === null) return;
    if (this.config.validate) {
      const errors = this.config.validate(draft);
      const first = Object.values(errors)[0];
      if (first !== undefined) {
        err.style.display = '';
        err.textContent = first;
        return;
      }
    }
    err.style.display = 'none';
    const input = this.config.draftToInput(draft, this.projectId());
    this.ctx.api.callByName(
      this.config.saveSpec,
      input,
      () => {
        if (!this.isAlive()) return;
        this.draft = null;
        this.creatingNew = false;
        this.row = {};
        // Force the next effect run (triggered by reloadList's items write) to
        // re-hydrate from the saved row / clear for a create.
        this.lastSel = undefined;
        this.renderForm();
        this.reloadList();
      },
      { alive: () => this.isAlive(), onErr: (f) => this.setFault(f) },
    );
  }

  /** Re-issue the master list spec and rewrite `${parentScope}.items` so a new
   *  record surfaces / an edit reflects server truth without navigation. */
  private reloadList(): void {
    const pid = this.projectId();
    if (pid === '' || pid === '0') return;
    const projectKey = this.config.listProjectKey ?? 'projectId';
    this.ctx.api.callByName(
      this.config.listSpec,
      { [projectKey]: pid },
      (out) => {
        if (!this.isAlive()) return;
        const rows = ((out ?? {}) as { rows?: Array<Record<string, unknown>> }).rows ?? [];
        const items = rows
          .map((r) => (r['id'] === null || r['id'] === undefined ? null : { id: String(r['id']), raw: r }))
          .filter((it): it is MasterDetailItem => it !== null);
        this.ctx.tree.at(this.itemsPath).set(items);
      },
      { alive: () => this.isAlive() },
    );
  }
}

export function registerRecordForm(): void {
  Control.register('RecordForm', RecordForm);
}
