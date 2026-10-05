/**
 * RecordForm — a generic, config-driven editable form for ONE record, mounted
 * in a MasterDetail detail pane. It replaces per-screen bespoke editors: the
 * screen supplies a `fields` table + two data-mapping functions (row→draft,
 * draft→saveInput) and RecordForm owns the rendering, draft state, dependent
 * option loading, save, delete, and list refresh.
 *
 * It reads the master's `${parentScope}.selectedId` + `.items` to know which
 * record to edit, hydrates a draft via `rowToDraft`, renders one input per
 * field, and on Save maps the draft through `draftToInput` → the `saveSpec`,
 * then re-issues `listSpec` so the master list reflects server truth (a new
 * record appears; an edit updates in place) — no navigation needed.
 *
 * The draft lives in an instance field (NOT the tree) so a keystroke doesn't
 * fire the selection effect and replace the focused <input> mid-word; the
 * structural transitions (selection change, + New, save reset, a `showWhen`
 * driver changing) call render explicitly. Zero promises — every call is
 * api.callByName(..., { alive }).
 *
 * Field kinds beyond plain inputs are still DATA, not per-screen code:
 *   - `showWhen` hides a field unless another draft field has one of a set of
 *     values (e.g. Teams-only fields on an activity sink);
 *   - `optionsFrom.alsoSet` copies fields of the picked option's row into the
 *     draft (e.g. picking a sink also sets the record's project);
 *   - `activityFilter` / `cardFilter` mount the shared ActivityFilterEditor /
 *     PredicateFilter controls; their state lives in tree leaves under
 *     `${scopeKey}.fields.<name>` (the child controls read/write the tree) and is
 *     folded back into the draft as the stored JSON string on save.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { ApiFault } from '../core/dispatch.js';
import type { MasterDetailItem } from './master-detail.js';
import {
  type Predicate,
  predicateFromJsonString,
  predicateToJsonString,
} from '../filter/predicate.js';
import { loadRefOptions } from '../filter/ref-options.js';

export type RecordFormFieldKind =
  | 'text'
  | 'secret'
  | 'number'
  | 'checkbox'
  | 'select'
  | 'selectFromQuery'
  | 'readonly'
  | 'activityFilter'
  | 'cardFilter';

/** One input source value for a dependent (selectFromQuery) option load. */
export type OptionInputValue = { lit: unknown } | { fromProject: true };

export interface RecordFormField {
  /** Draft key (camelCase). */
  name: string;
  label: string;
  kind: RecordFormFieldKind;
  placeholder?: string;
  /** Muted caption rendered under the input. */
  hint?: string;
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
    /** On pick, copy these fields of the chosen option's row into the draft:
     *  `{ draftKey: 'dotted.row.path' }` (e.g. the picked sink's project id). */
    alsoSet?: Record<string, string>;
  };
  /** For 'secret': the row field that reports the secret is already stored. */
  configuredFlag?: string;
  /** Render the field only when the draft's `field` (stringified) is one of
   *  `in` (and none of `notIn`). A select that drives a showWhen re-renders
   *  the form on change. */
  showWhen?: { field: string; in?: readonly string[]; notIn?: readonly string[] };
  /** 'number': input bounds. */
  min?: number;
  max?: number;
  /** 'cardFilter': the card_type the predicate filters. Default 'task'. */
  cardType?: string;
  /** 'cardFilter': draft key holding the project id the ref-picker options
   *  (statuses, tags, …) load for. Default: the form's project scope. */
  projectField?: string;
  /** 'activityFilter' / 'cardFilter': extra config merged into the spawned
   *  editor control's config (e.g. `{ actorChoices }` for the event filter). */
  editor?: Record<string, unknown>;
}

/** Inline-confirmed delete of the selected record. */
export interface RecordFormDelete {
  spec: string;
  /** Map the draft to the delete input (e.g. `{ id }`). */
  toInput: (draft: Record<string, unknown>) => Record<string, unknown>;
  buttonLabel?: string;
  /** The inline confirm question (no browser dialog). */
  confirmText?: string;
}

/** The screen-facing config (parentScope + scopeKey are injected by MasterDetail). */
export interface RecordFormScreenConfig {
  title?: string;
  /** Dotted tree path to the active project id. Default 'scope.projectId'. */
  projectScopePath?: string;
  /** False for a form that isn't bound to the active project (e.g. the
   *  account page's own notification subscriptions): the list refetches with
   *  `listInput` and option loads don't wait for a project. Default true. */
  projectScoped?: boolean;
  /** The list refetch input when `projectScoped` is false. Default `{}`. */
  listInput?: Record<string, unknown>;
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
  /** Optional inline-confirmed delete for an existing record. */
  delete?: RecordFormDelete;
  /** Friendly inline text per server fault code (save / delete). */
  faultMessages?: Record<string, string>;
}

export interface RecordFormConfig extends BaseControlConfig, RecordFormScreenConfig {
  type: 'RecordForm';
  /** Master scopeKey: reads `${parentScope}.selectedId` + `.items`. */
  parentScope: string;
  /** This form's own tree namespace (filter-field leaves live under it). */
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

function asText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'bigint') return v.toString();
  return String(v);
}

/** Whether [f] renders for [draft] (its `showWhen` gate). Exported for tests. */
export function fieldVisible(f: RecordFormField, draft: Record<string, unknown>): boolean {
  const w = f.showWhen;
  if (w === undefined) return true;
  const v = asText(draft[w.field]);
  if (w.in !== undefined && !w.in.includes(v)) return false;
  if (w.notIn !== undefined && w.notIn.includes(v)) return false;
  return true;
}

/** A fault as one line of inline text, preferring the screen's friendly map. */
export function faultText(f: ApiFault, messages?: Record<string, string>): string {
  switch (f.kind) {
    case 'sub_error':
      return messages?.[f.code] ?? (f.message !== '' ? f.message : f.code);
    case 'http':
      return `Request failed (http ${f.status}).`;
    case 'network':
    case 'decode':
      return f.message;
    default:
      return `Request aborted: ${f.reason}`;
  }
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
  /** Loaded selectFromQuery options (+ their source rows), keyed by field name. */
  private options: Record<string, Array<{ value: string; label: string }>> = {};
  private optionRows: Record<string, Array<Record<string, unknown>>> = {};
  /** Option-load dedupe key (project id, or '*' for an unscoped load) per field. */
  private optionsLoadedFor: Record<string, string> = {};
  /** Ref-option load dedupe (project id) per cardFilter field. */
  private refOptionsLoadedFor: Record<string, string> = {};
  /** The draft was just (re)hydrated: seed the filter-field tree leaves. */
  private needsSeed = false;
  /** Child editors (filter fields) owned by the current render. */
  private fieldChildren: Control[] = [];
  /** The inline delete-confirm is showing. */
  private confirmingDelete = false;

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
  private fieldPath(name: string, ...rest: string[]): string[] {
    return [...this.config.scopeKey.split('.'), 'fields', name, ...rest];
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
        this.confirmingDelete = false;
        const item = sel === null ? null : items.find((it) => it.id === sel) ?? null;
        if (item === null) {
          this.draft = null;
          this.row = {};
        } else {
          this.row = item.raw as Record<string, unknown>;
          this.draft = this.config.rowToDraft(this.row);
          this.needsSeed = true;
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

  /** Fields whose change can alter which fields render (showWhen drivers) or
   *  what they load (alsoSet), so a change re-renders the form. */
  private isStructural(name: string): boolean {
    return this.config.fields.some(
      (f) => f.showWhen?.field === name || (f.name === name && f.optionsFrom?.alsoSet !== undefined),
    );
  }

  /** Seed every filter-field leaf from the freshly hydrated draft. */
  private seedFilterLeaves(draft: Record<string, unknown>): void {
    for (const f of this.config.fields) {
      const raw = asText(draft[f.name]);
      if (f.kind === 'activityFilter') this.ctx.tree.at(this.fieldPath(f.name)).set(raw);
      else if (f.kind === 'cardFilter') this.ctx.tree.at(this.fieldPath(f.name, 'value')).set(predicateFromJsonString(raw));
    }
  }

  /** Fold the filter-field leaves back into the draft as stored JSON strings. */
  private collectFilterLeaves(draft: Record<string, unknown>): void {
    for (const f of this.config.fields) {
      if (f.kind === 'activityFilter') {
        draft[f.name] = asText(this.ctx.tree.at(this.fieldPath(f.name)).peek<string>());
      } else if (f.kind === 'cardFilter') {
        draft[f.name] = predicateToJsonString(this.ctx.tree.at(this.fieldPath(f.name, 'value')).peek<Predicate | null>() ?? null);
      }
    }
  }

  private renderForm(): void {
    for (const c of this.fieldChildren) this.destroyChild(c);
    this.fieldChildren = [];
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
        this.confirmingDelete = false;
        this.needsSeed = true;
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
    if (this.needsSeed) {
      this.needsSeed = false;
      this.seedFilterLeaves(draft);
    }
    const form = document.createElement('div');
    form.className = 'record-form__form';
    form.dataset.recordForm = '';
    // Filter editors mount after the fields are in the fragment (spawn needs
    // the host element; the host is appended to the form below).
    const pendingSpawns: Array<() => void> = [];
    for (const f of this.config.fields) {
      if (!fieldVisible(f, draft)) continue;
      form.append(this.renderField(f, draft, pendingSpawns));
    }

    const err = document.createElement('div');
    err.className = 'record-form__error';
    err.dataset.recordFormError = '';
    err.style.display = 'none';
    form.append(err);

    const actions = document.createElement('div');
    actions.className = 'record-form__actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary record-form__save';
    save.dataset.recordFormSave = '';
    save.textContent = this.config.saveButtonLabel ?? 'Save';
    this.listen(save, 'click', () => this.save(err));
    actions.append(save);
    if (this.config.delete && !this.creatingNew) actions.append(this.buildDelete(this.config.delete, err));
    form.append(actions);

    frag.append(form);
    this.formHost.replaceChildren(frag);
    for (const spawn of pendingSpawns) spawn();
  }

  private renderField(f: RecordFormField, draft: Record<string, unknown>, pendingSpawns: Array<() => void>): HTMLElement {
    const isEditor = f.kind === 'activityFilter' || f.kind === 'cardFilter';
    // Editors hold their own controls (buttons, selects) — a <label> wrapper
    // would forward clicks into them, so they get a plain container.
    const wrap = document.createElement(isEditor || f.kind === 'checkbox' ? 'div' : 'label');
    wrap.className = `record-form__field record-form__field--${f.kind}`;
    wrap.dataset.recordFormFieldWrap = f.name;
    const span = document.createElement('span');
    span.className = 'record-form__label muted';
    span.textContent = f.label;
    if (f.kind !== 'checkbox') wrap.append(span);

    const value = draft[f.name];
    const strValue = asText(value);

    if (f.kind === 'readonly') {
      // Display-only context (e.g. a flow's governed attribute). Reads the draft
      // first, then the raw row (for fields the draft doesn't carry).
      const ro = document.createElement('span');
      ro.className = 'record-form__readonly';
      ro.dataset.recordFormField = f.name;
      const display = strValue !== '' ? strValue : asText(this.row[f.name]);
      ro.textContent = display || '—';
      wrap.append(ro);
      this.appendHint(wrap, f);
      return wrap;
    }

    if (f.kind === 'checkbox') {
      const label = document.createElement('label');
      label.className = 'record-form__check';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'record-form__checkbox';
      box.dataset.recordFormField = f.name;
      box.checked = value === true;
      this.listen(box, 'change', () => {
        draft[f.name] = box.checked;
        if (this.isStructural(f.name)) this.renderForm();
      });
      label.append(box, span);
      wrap.append(label);
      this.appendHint(wrap, f);
      return wrap;
    }

    if (f.kind === 'activityFilter') {
      const host = document.createElement('div');
      host.className = 'record-form__editor';
      host.dataset.recordFormField = f.name;
      wrap.append(host);
      pendingSpawns.push(() => {
        this.fieldChildren.push(
          this.spawn('ActivityFilterEditor', {
            type: 'ActivityFilterEditor',
            valuePath: this.fieldPath(f.name).join('.'),
            ...(f.placeholder !== undefined ? { emptyLabel: f.placeholder } : {}),
            ...(f.editor ?? {}),
          }, host),
        );
      });
      this.appendHint(wrap, f);
      return wrap;
    }

    if (f.kind === 'cardFilter') {
      const host = document.createElement('div');
      host.className = 'record-form__editor';
      host.dataset.recordFormField = f.name;
      wrap.append(host);
      const cardType = f.cardType ?? 'task';
      const projectId = f.projectField !== undefined ? asText(draft[f.projectField]) : this.projectId();
      this.ensureRefOptions(f, cardType, projectId);
      pendingSpawns.push(() => {
        this.fieldChildren.push(
          this.spawn('PredicateFilter', {
            type: 'PredicateFilter',
            valuePath: this.fieldPath(f.name, 'value').join('.'),
            schema: { cardType },
            optionsPath: this.fieldPath(f.name, 'options').join('.'),
            ...(f.editor ?? {}),
          }, host),
        );
      });
      this.appendHint(wrap, f);
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
        this.applyAlsoSet(f, sel.value, draft);
        if (this.isStructural(f.name)) this.renderForm();
      });
      wrap.append(sel);
      this.appendHint(wrap, f);
      if (f.kind === 'selectFromQuery') this.ensureOptions(f);
      return wrap;
    }

    const input = document.createElement('input');
    input.type = f.kind === 'secret' ? 'password' : f.kind === 'number' ? 'number' : 'text';
    input.className = 'record-form__input';
    input.dataset.recordFormField = f.name;
    input.value = strValue;
    if (f.placeholder) input.placeholder = f.placeholder;
    if (f.kind === 'number') {
      if (f.min !== undefined) input.setAttribute('min', String(f.min));
      if (f.max !== undefined) input.setAttribute('max', String(f.max));
    }
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
    this.appendHint(wrap, f);
    return wrap;
  }

  private appendHint(wrap: HTMLElement, f: RecordFormField): void {
    if (f.hint === undefined) return;
    const hint = document.createElement('span');
    hint.className = 'record-form__caption muted';
    hint.dataset.recordFormHint = f.name;
    hint.textContent = f.hint;
    wrap.append(hint);
  }

  /** Copy the picked option row's `alsoSet` fields into the draft. */
  private applyAlsoSet(f: RecordFormField, value: string, draft: Record<string, unknown>): void {
    const alsoSet = f.optionsFrom?.alsoSet;
    if (alsoSet === undefined) return;
    const valueField = f.optionsFrom?.valueField ?? 'id';
    const row = (this.optionRows[f.name] ?? []).find((r) => asText(readPath(r, valueField)) === value);
    for (const [key, path] of Object.entries(alsoSet)) {
      draft[key] = row === undefined ? '' : asText(readPath(row, path));
    }
  }

  /** Load a selectFromQuery field's options once per project (or once, for an
   *  input that doesn't depend on the project), then re-render. */
  private ensureOptions(f: RecordFormField): void {
    if (!f.optionsFrom) return;
    const needsProject = Object.values(f.optionsFrom.input).some((src) => 'fromProject' in src);
    const pid = this.projectId();
    if (needsProject && (pid === '' || pid === '0')) return;
    const key = needsProject ? pid : '*';
    if (this.optionsLoadedFor[f.name] === key) return;
    this.optionsLoadedFor[f.name] = key;

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
        this.optionRows[f.name] = rows;
        this.options[f.name] = rows.map((r) => {
          const id = asText(readPath(r, valueField));
          const lbl = readPath(r, labelField);
          return { value: id, label: typeof lbl === 'string' && lbl !== '' ? lbl : `#${id}` };
        });
        this.renderForm();
      },
      { alive: () => this.isAlive() },
    );
  }

  /** Load a cardFilter field's ref-picker options for [projectId] (once per
   *  project; the PredicateFilter repaints as each option list lands). */
  private ensureRefOptions(f: RecordFormField, cardType: string, projectId: string): void {
    if (this.refOptionsLoadedFor[f.name] === projectId) return;
    this.refOptionsLoadedFor[f.name] = projectId;
    loadRefOptions(this.ctx, {
      cardType,
      projectId,
      optionsPath: this.fieldPath(f.name, 'options'),
      alive: () => this.isAlive(),
    });
  }

  private showError(err: HTMLElement, text: string): void {
    err.style.display = '';
    err.textContent = text;
  }

  private save(err: HTMLElement): void {
    const draft = this.draft;
    if (draft === null) return;
    this.collectFilterLeaves(draft);
    if (this.config.validate) {
      const errors = this.config.validate(draft);
      const first = Object.values(errors)[0];
      if (first !== undefined) {
        this.showError(err, first);
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
        this.resetAfterWrite();
        this.reloadList();
      },
      {
        alive: () => this.isAlive(),
        onErr: (f) => {
          this.showError(err, faultText(f, this.config.faultMessages));
          this.setFault(f);
        },
      },
    );
  }

  /** The Delete button + its inline (non-browser-dialog) confirm. */
  private buildDelete(del: RecordFormDelete, err: HTMLElement): HTMLElement {
    const box = document.createElement('div');
    box.className = 'record-form__delete';
    if (!this.confirmingDelete) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-danger record-form__delete-btn';
      btn.dataset.recordFormDelete = '';
      btn.textContent = del.buttonLabel ?? 'Delete';
      this.listen(btn, 'click', () => {
        this.confirmingDelete = true;
        this.renderForm();
      });
      box.append(btn);
      return box;
    }
    const q = document.createElement('span');
    q.className = 'record-form__delete-question';
    q.textContent = del.confirmText ?? 'Delete this record?';
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'btn btn-danger';
    yes.dataset.recordFormDeleteConfirm = '';
    yes.textContent = del.buttonLabel ?? 'Delete';
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'btn';
    no.dataset.recordFormDeleteCancel = '';
    no.textContent = 'Cancel';
    this.listen(no, 'click', () => {
      this.confirmingDelete = false;
      this.renderForm();
    });
    this.listen(yes, 'click', () => {
      const draft = this.draft;
      if (draft === null) return;
      this.ctx.api.callByName(
        del.spec,
        del.toInput(draft),
        () => {
          if (!this.isAlive()) return;
          this.ctx.tree.at(this.selectedPath).set(null);
          this.resetAfterWrite();
          this.reloadList();
        },
        {
          alive: () => this.isAlive(),
          onErr: (f) => {
            this.confirmingDelete = false;
            this.showError(err, faultText(f, this.config.faultMessages));
            this.setFault(f);
          },
        },
      );
    });
    box.append(q, yes, no);
    return box;
  }

  /** Clear the draft after a save / delete; the next effect run (triggered by
   *  reloadList's items write) re-hydrates from the saved row or clears. */
  private resetAfterWrite(): void {
    this.draft = null;
    this.creatingNew = false;
    this.confirmingDelete = false;
    this.row = {};
    this.lastSel = undefined;
    this.renderForm();
  }

  /** Re-issue the master list spec and rewrite `${parentScope}.items` so a new
   *  record surfaces / an edit reflects server truth without navigation. */
  private reloadList(): void {
    let input: Record<string, unknown>;
    if (this.config.projectScoped === false) {
      input = { ...(this.config.listInput ?? {}) };
    } else {
      const pid = this.projectId();
      if (pid === '' || pid === '0') return;
      input = { [this.config.listProjectKey ?? 'projectId']: pid };
    }
    this.ctx.api.callByName(
      this.config.listSpec,
      input,
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
