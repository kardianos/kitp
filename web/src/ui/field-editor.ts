/**
 * FieldEditor — ONE inline editor that routes to the right inner control by
 * `attr.valueType`. The screen-side analog: every place that used to host a
 * per-type switch — `task-detail`'s attribute panel `mountEditor()`, the
 * `BulkActionBar`'s value editor, the `grid`'s inline-edit cell — now spawns
 * a single FieldEditor and listens for `onCommit`.
 *
 * The editor is PURE (no API calls): config in, `onCommit(value)` out. The
 * parent owns the persistence (the optimistic patch + rollback + inline
 * error). This is what lets the same control drive a TaskDetail row AND the
 * bulk bar AND a grid cell without each surface owning its own write logic.
 *
 * Routing by `attr.valueType`:
 *
 *   - `card_ref`     → RefPicker single (auto-opens), `onChange` → onCommit.
 *   - `card_ref[]`   → RefPicker multi (auto-opens), `onChangeMulti` → onCommit.
 *   - `date`         → DatePicker (auto-opens), `onChange` → onCommit.
 *   - `bool`         → <input type=checkbox>, eager `change` → onCommit.
 *   - `number`       → <input type=number>, Enter/blur commit (parsed float).
 *   - `text` / other → <input type=text>, Enter/blur commit (string).
 *
 * The bool / number / text arms hold their draft in a local `signal()` so
 * the new `bindProp(el, 'checked' | 'value', signal)` and `bindClass()`
 * helpers on the Control base actually get exercised. The bigger win is
 * STRUCTURAL though: the 6-arm switch that used to live in 3 different
 * screens (with subtle drift between them) is now ONE control.
 *
 * Reference: ARCHITECTURE.md §13 (composition principle + L0 primitives).
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { signal } from '../core/signal.js';
import { asAttrId } from '../kanban/kanban-helpers.js';
import type { AttrSchema } from '../filter/attribute-schema.js';
import type { RefPicker, RefPinnedOption } from './ref-picker.js';
import type { DatePicker } from './datepicker.js';

/* -------------------------------------------------------------------------- */
/* Config + declaration-merged registry type.                                  */
/* -------------------------------------------------------------------------- */

export interface FieldEditorConfig extends BaseControlConfig {
  type: 'FieldEditor';
  /** The schema entry for the attribute being edited (drives valueType routing). */
  attr: AttrSchema;
  /** The attribute's current value, in any wire-revived form. The editor
   *  coerces card_ref values via `asAttrId` so a digit-string or number seeds
   *  the same as a real bigint. */
  value: unknown;
  /** Resolve a card_ref id to a display label (single + multi). Without a
   *  resolver the picker shows '#id' until the user types. */
  labelFor?: (id: bigint) => string;
  /** Dotted tree path holding the project scope (`bigint | null`) for
   *  project-scoped card_ref targets; omitted means a global lookup. */
  parentScopePath?: string;
  /** Optional pinned options for card_ref (e.g. a "Self" quick-pick for
   *  person-typed refs). */
  pinnedOptions?: RefPinnedOption[];
  /** Fired once the user commits a value (already coerced to the right type:
   *  bigint | bigint[] | string | number | boolean | null). */
  onCommit: (value: unknown) => void;
  /** Suppress the auto-open / auto-focus behaviour. Default false (auto-open
   *  on mount so an expanded TaskDetail row drops straight into edit mode). */
  noAutoOpen?: boolean;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    FieldEditor: FieldEditorConfig;
  }
}

/* -------------------------------------------------------------------------- */
/* Control.                                                                   */
/* -------------------------------------------------------------------------- */

export class FieldEditor extends Control<FieldEditorConfig> {
  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'field-editor';
    el.dataset.control = 'FieldEditor';
    el.dataset.fieldType = this.config.attr.valueType;
    return el;
  }

  protected render(): void {
    const { attr } = this.config;
    switch (attr.valueType) {
      case 'card_ref':
        this.renderRefSingle();
        break;
      case 'card_ref[]':
        this.renderRefMulti();
        break;
      case 'date':
        this.renderDate();
        break;
      case 'bool':
        this.renderBool();
        break;
      case 'number':
        this.renderNumber();
        break;
      default:
        this.renderText();
        break;
    }
  }

  /* --------------------------- card_ref (single) ------------------------ */

  private renderRefSingle(): void {
    const { attr, value, labelFor, parentScopePath, pinnedOptions } = this.config;
    const curId = asAttrId(value);
    const refCfg: Record<string, unknown> = {
      type: 'RefPicker',
      cardType: attr.targetCardType ?? 'card',
      value: curId,
      'aria-label': attr.label,
      placeholder: `Search ${attr.label.toLowerCase()}…`,
      onChange: (next: bigint | null) => this.config.onCommit(next),
    };
    if (curId !== null && labelFor !== undefined) refCfg['currentLabel'] = labelFor(curId);
    if (parentScopePath !== undefined) refCfg['parentScopePath'] = parentScopePath;
    if (pinnedOptions !== undefined && pinnedOptions.length > 0) {
      refCfg['pinnedOptions'] = pinnedOptions;
    }
    const picker = this.spawn('RefPicker', refCfg, this.el) as RefPicker;
    this.autoOpenPicker(() => picker.open());
  }

  /* --------------------------- card_ref[] (multi) ----------------------- */

  private renderRefMulti(): void {
    const { attr, value, labelFor, parentScopePath } = this.config;
    const ids: bigint[] = [];
    if (Array.isArray(value)) {
      for (const raw of value) {
        const id = asAttrId(raw);
        if (id !== null) ids.push(id);
      }
    }
    const labels: Record<string, string> = {};
    if (labelFor !== undefined) {
      for (const id of ids) labels[String(id)] = labelFor(id);
    }
    const refCfg: Record<string, unknown> = {
      type: 'RefPicker',
      cardType: attr.targetCardType ?? 'card',
      multi: true,
      values: ids,
      currentLabels: labels,
      'aria-label': attr.label,
      placeholder: `Search ${attr.label.toLowerCase()}…`,
      onChangeMulti: (next: bigint[]) => this.config.onCommit(next),
    };
    if (parentScopePath !== undefined) refCfg['parentScopePath'] = parentScopePath;
    const picker = this.spawn('RefPicker', refCfg, this.el) as RefPicker;
    this.autoOpenPicker(() => picker.open());
  }

  /* -------------------------------- date -------------------------------- */

  private renderDate(): void {
    const { attr, value } = this.config;
    const dp = this.spawn(
      'DatePicker',
      {
        type: 'DatePicker',
        value: typeof value === 'string' ? value : null,
        'aria-label': attr.label,
        onChange: (next: string | null) => this.config.onCommit(next),
      },
      this.el,
    ) as DatePicker;
    this.autoOpenPicker(() => dp.openMenu());
  }

  /* -------------------------------- bool -------------------------------- */

  private renderBool(): void {
    const { attr, value } = this.config;
    // The checkbox's checked state mirrors a signal — bindProp pushes the
    // signal value onto `box.checked` reactively. The change listener pushes
    // the other way (and commits eagerly).
    const checked = signal<boolean>(value === true, `${attr.name}.checked`);
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'field-editor__checkbox';
    box.dataset.attrCheckbox = '';
    box.setAttribute('aria-label', attr.label);
    this.bindProp(box, 'checked', checked);
    this.listen(box, 'change', () => {
      checked.set(box.checked);
      this.config.onCommit(box.checked);
    });
    this.el.append(box);
  }

  /* ------------------------------- number ------------------------------- */

  private renderNumber(): void {
    const { attr, value } = this.config;
    const draft = signal<string>(typeof value === 'number' ? String(value) : '', `${attr.name}.draft`);
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'field-editor__number';
    input.dataset.attrInput = '';
    input.setAttribute('aria-label', attr.label);
    this.bindProp(input, 'value', draft);
    const commit = (): void => {
      const raw = input.value.trim();
      const next: unknown = raw === '' ? null : Number(raw);
      // Reject NaN / Infinity — leave the input visible so the user can correct.
      if (next !== null && !Number.isFinite(next as number)) return;
      draft.set(raw);
      this.config.onCommit(next);
    };
    this.listen(input, 'keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        (e as KeyboardEvent).preventDefault();
        commit();
      }
    });
    this.listen(input, 'blur', () => commit());
    this.el.append(input);
    this.autoFocus(input);
  }

  /* -------------------------- text + fallback --------------------------- */

  private renderText(): void {
    const { attr, value } = this.config;
    const initial = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
    const draft = signal<string>(initial, `${attr.name}.draft`);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'field-editor__text';
    input.dataset.attrInput = '';
    input.setAttribute('aria-label', attr.label);
    this.bindProp(input, 'value', draft);
    const commit = (): void => {
      draft.set(input.value);
      this.config.onCommit(input.value);
    };
    this.listen(input, 'keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        (e as KeyboardEvent).preventDefault();
        commit();
      }
    });
    this.listen(input, 'blur', () => commit());
    this.el.append(input);
    this.autoFocus(input);
  }

  /* ------------------------------- helpers ------------------------------ */

  /** Auto-open the picker on the next microtask (the row was expanded
   *  specifically to edit — saves a redundant click).  Honoured for RefPicker
   *  and DatePicker; `noAutoOpen: true` suppresses it. */
  private autoOpenPicker(open: () => void): void {
    if (this.config.noAutoOpen === true) return;
    queueMicrotask(() => {
      if (this.isAlive()) open();
    });
  }

  /** Focus a freshly-mounted input on the next microtask (number / text). */
  private autoFocus(input: HTMLElement): void {
    if (this.config.noAutoOpen === true) return;
    queueMicrotask(() => {
      if (this.isAlive()) input.focus?.();
    });
  }
}

export function registerFieldEditor(): void {
  Control.register('FieldEditor', FieldEditor);
}
