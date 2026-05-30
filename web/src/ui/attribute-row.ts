/**
 * AttributeRow — one `<details>` row for an editable attribute, driven by a
 * single `LoadState<unknown>` thunk.
 *
 * Why one thunk: the prior contract took `value` + `errorText` as separate
 * thunks, which meant the summary, the Unassign-disabled state, the "busy"
 * styling, and the inline error could each be in a different sub-state of
 * the row's actual lifecycle.  That's where the flicker came from — the
 * Unassign button's `disabled` flipped from "value-driven" while the
 * commit was in flight, even though the row was ACTUALLY in a pending
 * lifecycle the renderer wasn't reading.
 *
 * The new contract: ONE `state: () => LoadState<unknown>` thunk owned by
 * the parent (commonly `() => panelModel.attr(name).get()`).  Every
 * rendered surface — summary text, busy class, Unassign disabled, error
 * message — is derived from THAT one state.  No divergence between
 * sub-states means no flicker.
 *
 * Lifecycle the row consumes:
 *
 *   Unset                — show '—', Unassign disabled.
 *   Pending(v)           — show summary(v), Unassign disabled, mark busy.
 *   Value(v)             — show summary(v), Unassign enabled when meaningful.
 *   Error(prev, message) — show summary(prev), Unassign reflects prev,
 *                          inline error visible.
 *
 * Reference: `/home/d/code/kitp/STRUCTURAL_PLAN.md` items (2) + (3) + the
 * (2)/(3) retrospective's "what didn't" follow-up.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { asAttrId } from '../kanban/kanban-helpers.js';
import {
  Unset,
  errorOf,
  isPending,
  isResolved,
  valueOf,
  type LoadState,
} from '../core/load-state.js';
import type { AttrSchema } from '../filter/attribute-schema.js';
import type { RefPinnedOption } from './ref-picker.js';

/* -------------------------------------------------------------------------- */
/* Config + declaration-merged registry type.                                  */
/* -------------------------------------------------------------------------- */

export interface AttributeRowConfig extends BaseControlConfig {
  type: 'AttributeRow';
  /** Schema entry — drives the editor's valueType + the label text. */
  attr: AttrSchema;
  /**
   * Reactive thunk yielding the row's full LoadState.  Commonly
   * `() => panelModel.attr(name).get()`.  Every visible surface is
   * derived from this one read: summary text, busy class, Unassign
   * disabled, error message.
   */
  state: () => LoadState<unknown>;
  /** Resolve a card_ref id to its label (for the summary).  Returning
   *  `undefined` falls back to `#id`. */
  labelFor?: (id: bigint) => string | undefined;
  /** Project-scope tree path threaded to the inner FieldEditor. */
  parentScopePath?: string;
  /** Pinned options forwarded to the inner FieldEditor (e.g. "Self"). */
  pinnedOptions?: RefPinnedOption[];
  /** Commit a new value.  Receives `null` for Unassign. */
  onCommit: (next: unknown) => void;
  /** Initial expanded state. */
  initiallyOpen?: boolean;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    AttributeRow: AttributeRowConfig;
  }
}

/* -------------------------------------------------------------------------- */
/* Control.                                                                   */
/* -------------------------------------------------------------------------- */

export class AttributeRow extends Control<AttributeRowConfig> {
  private fieldEditor: Control | null = null;
  private editorHost!: HTMLElement;
  private unassignBtn: HTMLButtonElement | null = null;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('details');
    el.className = 'task-detail__row';
    el.dataset.control = 'AttributeRow';
    el.dataset.attrRow = this.config.attr.name;
    if (this.config.initiallyOpen === true) el.setAttribute('open', '');
    return el;
  }

  protected render(): void {
    const { attr, state, labelFor } = this.config;

    // One curried reader per row — every binding reads through this so a
    // typo / drift between bindings is impossible at this layer.
    const readState = (): LoadState<unknown> => state() ?? Unset;

    /* ---------------------------- summary --------------------------------- */
    const summary = document.createElement('summary');
    summary.className = 'task-detail__row-summary';

    const labelEl = document.createElement('span');
    labelEl.className = 'task-detail__row-label muted';
    labelEl.textContent = attr.label;

    const valueEl = document.createElement('span');
    valueEl.className = 'task-detail__row-value';
    valueEl.dataset.attrValue = '';
    // Summary text routing:
    //   Mixed   → '[mixed]' placeholder (the selection disagrees on this attr)
    //   else    → computeSummary(value, labelFor) — Unset folds to '—' inside.
    this.bindText(valueEl, () => {
      const s = readState();
      if (s.kind === 'mixed') return '[mixed]';
      return computeSummary(attr, valueOf(s), labelFor);
    });
    // Lifecycle hooks for styling — the host can fade-in the resolved tone,
    // soft-mute the pending tone, etc.
    this.bindAttr(this.el, 'data-attr-state', () => readState().kind);
    this.bindClass(this.el, 'task-detail__row--pending', () => isPending(readState()));
    this.bindClass(this.el, 'task-detail__row--mixed', () => readState().kind === 'mixed');
    this.bindClass(this.el, 'task-detail__row--error', () => readState().kind === 'error');

    summary.append(labelEl, valueEl);
    this.el.append(summary);

    /* ---------------------------- editor body ----------------------------- */
    const body = document.createElement('div');
    body.className = 'task-detail__row-editor';
    body.dataset.attrEditor = '';
    this.editorHost = body;

    // Inline error: visible only when the state is Error.
    const errEl = document.createElement('p');
    errEl.className = 'task-detail__row-error';
    errEl.dataset.attrError = '';
    errEl.setAttribute('role', 'alert');
    body.append(errEl);
    this.bindText(errEl, () => errorOf(readState()) ?? '');
    this.bindShow(errEl, () => {
      const msg = errorOf(readState());
      return typeof msg === 'string' && msg.length > 0;
    });

    // Unassign — only for non-bool types.
    if (attr.valueType !== 'bool') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'task-detail__row-unassign';
      btn.dataset.attrUnassign = '';
      btn.textContent = 'Unassign';
      btn.title = `Clear ${attr.label.toLowerCase()} on this task`;
      // Disabled when there is nothing to clear OR a commit is in flight:
      //   Unset / Pending / Error               → disabled (nothing to clear
      //                                            or in flight)
      //   Value(empty)                          → disabled (already empty)
      //   Value(meaningful)                     → enabled
      //   Mixed                                 → ENABLED (the user is
      //                                            explicitly choosing to
      //                                            flatten the heterogeneous
      //                                            selection to "empty")
      this.bindProp(btn, 'disabled', () => {
        const s = readState();
        if (s.kind === 'mixed') return false;
        if (!isResolved(s)) return true;
        return !hasMeaningfulValue(valueOf(s));
      });
      this.listen(btn, 'click', (ev) => {
        (ev as Event).stopPropagation();
        this.config.onCommit(null);
      });
      body.append(btn);
      this.unassignBtn = btn;
    }

    this.el.append(body);

    /* ----------------------- lazy editor mount ---------------------------- */
    let mounted = false;
    this.listen(this.el, 'toggle', () => {
      const open = (this.el as unknown as { open?: boolean }).open === true;
      if (!open || mounted) return;
      mounted = true;
      this.mountFieldEditor();
    });

    if (this.config.initiallyOpen === true) {
      mounted = true;
      this.mountFieldEditor();
    }
  }

  /** Spawn the FieldEditor with a SNAPSHOT value at mount time; the editor's
   *  internal draft takes over from there.  After onCommit the parent
   *  updates the panel model, which repaints the summary reactively. */
  private mountFieldEditor(): void {
    if (this.fieldEditor !== null) return;
    const snapshot = valueOf(this.config.state());
    const cfg: Record<string, unknown> = {
      type: 'FieldEditor',
      attr: this.config.attr,
      value: snapshot,
      onCommit: (next: unknown) => this.config.onCommit(next),
    };
    if (this.config.labelFor !== undefined) cfg['labelFor'] = this.config.labelFor;
    if (this.config.parentScopePath !== undefined) {
      cfg['parentScopePath'] = this.config.parentScopePath;
    }
    if (this.config.pinnedOptions !== undefined && this.config.pinnedOptions.length > 0) {
      cfg['pinnedOptions'] = this.config.pinnedOptions;
    }
    // The editor renders ABOVE the inline error + Unassign, so insert as
    // the first child of the row's body and re-append Unassign at the end.
    const editorHost = document.createElement('div');
    editorHost.className = 'task-detail__row-editor-host';
    this.editorHost.insertBefore(editorHost, this.editorHost.firstChild);
    this.fieldEditor = this.spawn('FieldEditor', cfg, editorHost);
    if (this.unassignBtn !== null) this.editorHost.append(this.unassignBtn);
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers.                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Compute the read-summary string for an attribute's current value.  Pure
 * + exported so the same rule lives in ONE place — exercised directly by
 * tests, by the bindText thunk inside AttributeRow, and by any other
 * consumer that wants the same `attr → display string` rule.
 */
export function computeSummary(
  attr: AttrSchema,
  value: unknown,
  labelFor?: (id: bigint) => string | undefined,
): string {
  if (value === null || value === undefined || value === '') return '—';
  if (attr.valueType === 'card_ref') {
    const id = asAttrId(value);
    if (id === null) return '—';
    return labelFor?.(id) ?? `#${id.toString()}`;
  }
  if (attr.valueType === 'card_ref[]') {
    if (!Array.isArray(value) || value.length === 0) return '—';
    const labels: string[] = [];
    for (const raw of value) {
      const id = asAttrId(raw);
      if (id !== null) labels.push(labelFor?.(id) ?? `#${id.toString()}`);
    }
    return labels.length > 0 ? labels.join(', ') : '—';
  }
  if (attr.valueType === 'bool') return value === true ? 'Yes' : 'No';
  if (typeof value === 'bigint') return value.toString();
  return String(value);
}

/** Whether `value` can be meaningfully Unassigned (i.e. is not already
 *  empty).  Mirrors `task-detail/panel-model.ts:isMeaningful` deliberately
 *  — kept here so this control has no upward dependency on the panel
 *  store.  Both should answer the same way for any input. */
export function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

export function registerAttributeRow(): void {
  Control.register('AttributeRow', AttributeRow);
}
