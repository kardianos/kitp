/**
 * NewTaskForm — the high-level intent control for "render the attribute
 * schema as a DRAFT form, with Save / Save & Another / Save & Open
 * buttons, deferring the commit until the user presses one of them."
 *
 * Sibling to {@link TaskAttributePanel} (live-commit policy) and the
 * forthcoming `BatchTaskEditor` (fan-out across selection).  Per the
 * project's composition principle, each commit semantic is its own
 * named high-level control — there is NO shared `policy` knob.
 *
 * Reuse vs. duplication:
 *
 *   - The SAME `AttributeRow` + `FieldEditor` + `CardRefValue` primitives
 *     render every field.  The `state` thunk reads from a {@link PanelModel}
 *     held as the draft store — identical contract to `TaskAttributePanel`.
 *   - The COMMIT semantic differs: each row's `onCommit` seeds the draft
 *     store (`draft.seedAttr(name, value)`) instead of dispatching to the
 *     server.  When the user presses Save, the form collects the draft as a
 *     plain attributes record and fires `onSubmit(attrs, intent)`.
 *
 * Owned responsibilities:
 *
 *   - Iterating the schema → spawning one AttributeRow per entry.
 *   - The Save / Save & Another / Save & Open button row.
 *   - The minimal validation gate (`required: 'title'` ⇒ button disabled
 *     until the draft has a title) — anything more lives one level up.
 *   - Surfacing `busy` (a parent-driven thunk) on the buttons so an in-flight
 *     `card.insert` disables resubmission.
 *
 * Deliberately NOT owned:
 *
 *   - The modal chrome (backdrop, focus trap, the Esc → close behaviour).
 *   - Tag application / attachment binding / parent-task resolution / route
 *     side-effects.  Those live in the parent control (QuickEntry) which
 *     dispatches based on the `intent` it gets back from `onSubmit`.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { AttrSchema } from '../filter/attribute-schema.js';
import type { RefPinnedOption } from '../ui/ref-picker.js';
import { PanelModel, isMeaningful } from './panel-model.js';
import type { LoadState } from '../core/load-state.js';
import { valueOf } from '../core/load-state.js';

/* -------------------------------------------------------------------------- */
/* Config + declaration-merged registry type.                                  */
/* -------------------------------------------------------------------------- */

/** The intents the form can dispatch. */
export type NewTaskFormIntent = 'save' | 'saveAnother' | 'saveOpen';

export interface NewTaskFormConfig extends BaseControlConfig {
  type: 'NewTaskForm';

  /** Schema entries to render, in order. */
  schema: AttrSchema[];

  /** The DRAFT store.  Every row reads + writes here; the parent reads on
   *  submit.  Typically owned by the parent so a preset can pre-seed it. */
  draft: PanelModel;

  /** Per-attr config hook (project scope path, pinned options).  Same
   *  contract as `TaskAttributePanel.forAttr`. */
  forAttr?: (attr: AttrSchema) => {
    parentScopePath?: string;
    pinnedOptions?: RefPinnedOption[];
  };

  /** Submit handler.  Receives a plain attributes record (Mixed / Error /
   *  Pending kinds in the store are collapsed to `undefined`) + the intent
   *  the user pressed.  The parent fires the API call. */
  onSubmit: (attributes: Record<string, unknown>, intent: NewTaskFormIntent) => void;

  /** Reactive thunk: true while a previous submit is in flight.  Used to
   *  disable the button row.  Defaults to always-false. */
  busy?: () => boolean;

  /** Which submit intents the button row offers, in display order.
   *  Default: `['save']`. */
  intents?: NewTaskFormIntent[];

  /** Attribute name whose presence is required for submission (default:
   *  'title').  Set to `''` to disable the required-gate. */
  required?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    NewTaskForm: NewTaskFormConfig;
  }
}

/* -------------------------------------------------------------------------- */
/* Intent display.                                                            */
/* -------------------------------------------------------------------------- */

const INTENT_LABELS: Record<NewTaskFormIntent, string> = {
  save: 'Save',
  saveAnother: 'Save & Another',
  saveOpen: 'Save & Open',
};

/* -------------------------------------------------------------------------- */
/* Control.                                                                   */
/* -------------------------------------------------------------------------- */

export class NewTaskForm extends Control<NewTaskFormConfig> {
  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'new-task-form';
    el.dataset.control = 'NewTaskForm';
    return el;
  }

  protected render(): void {
    const { schema, draft, forAttr } = this.config;

    /* ------------------------------- rows --------------------------------- */
    const rowsHost = document.createElement('div');
    rowsHost.className = 'new-task-form__rows';
    rowsHost.dataset.newTaskFormRows = '';
    this.el.append(rowsHost);

    for (const attr of schema) {
      const extra = forAttr?.(attr) ?? {};
      const cfg: Record<string, unknown> = {
        type: 'AttributeRow',
        attr,
        state: (): LoadState<unknown> => draft.attr(attr.name).get(),
        labelFor: (id: bigint) => {
          const target = attr.targetCardType;
          if (target === undefined) return undefined;
          const s = draft.refLabel(target, id).get();
          return s.kind === 'value' ? s.value : undefined;
        },
        // Deferred-commit semantic: the row's commit goes into the DRAFT
        // store, not to an API call.  The Save button below dispatches.
        onCommit: (next: unknown) => draft.seedAttr(attr.name, next),
        // Always-open so the user fills the form top-to-bottom.
        initiallyOpen: true,
      };
      if (extra.parentScopePath !== undefined) cfg['parentScopePath'] = extra.parentScopePath;
      if (extra.pinnedOptions !== undefined && extra.pinnedOptions.length > 0) {
        cfg['pinnedOptions'] = extra.pinnedOptions;
      }
      this.spawn('AttributeRow', cfg, rowsHost);
    }

    /* ----------------------------- button row ----------------------------- */
    const intents = this.config.intents ?? ['save'];
    const required = this.config.required ?? 'title';
    const busy = this.config.busy ?? ((): boolean => false);

    const buttonRow = document.createElement('div');
    buttonRow.className = 'new-task-form__buttons';
    buttonRow.dataset.newTaskFormButtons = '';

    for (const intent of intents) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        intent === 'save'
          ? 'btn btn-primary new-task-form__btn'
          : 'btn new-task-form__btn';
      btn.dataset.newTaskFormSubmit = intent;
      btn.textContent = INTENT_LABELS[intent];
      // Disabled while a prior submit is in flight OR while the required
      // attr (default: 'title') is empty in the draft.
      this.bindProp(btn, 'disabled', () => {
        if (busy()) return true;
        if (required === '') return false;
        const s = draft.attr(required).get();
        return !isMeaningful(valueOf(s));
      });
      this.listen(btn, 'click', () => this.submit(intent));
      buttonRow.append(btn);
    }

    this.el.append(buttonRow);
  }

  /** Snapshot the draft store into a plain attributes record and dispatch. */
  private submit(intent: NewTaskFormIntent): void {
    const out: Record<string, unknown> = {};
    for (const attr of this.config.schema) {
      const s = this.config.draft.attr(attr.name).peek();
      const v = valueOf(s);
      if (isMeaningful(v)) out[attr.name] = v;
    }
    this.config.onSubmit(out, intent);
  }
}

export function registerNewTaskForm(): void {
  Control.register('NewTaskForm', NewTaskForm);
}
