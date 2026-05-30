/**
 * BatchTaskEditor — the high-level intent control for "render the attribute
 * schema as rows against a SELECTION of tasks and fan out each commit
 * across the selection."
 *
 * Sibling to {@link TaskAttributePanel} (live, single-task) and
 * {@link NewTaskForm} (deferred draft + Save).  Per the composition
 * principle, batch edit is its own named control rather than a `policy:
 * 'batch'` knob on a shared `AttributePanel`.
 *
 * Reuse vs. difference:
 *
 *   - SAME lower-level primitives: `AttributeRow` + `FieldEditor` +
 *     `CardRefValue` + LoadState.  Rows render summary / pending / error
 *     identically; the only branch they take for batch is the new
 *     `Mixed` kind (the row already shows `[mixed]` for it).
 *   - DIFFERENT data store: {@link BatchPanelModel} instead of
 *     {@link PanelModel}.  The fold over the selection lives in the model,
 *     not in the row.
 *   - DIFFERENT commit dispatch: each row's `onCommit` runs a FAN-OUT
 *     callback (`onApply(name, value, selection)`) the parent fires N
 *     times then reports back via `settleCommit`.
 *
 * Owned responsibilities:
 *
 *   - Iterating the schema → spawning one AttributeRow per editable attr.
 *   - Wiring each row's `state` thunk to the BatchPanelModel's per-attr
 *     signal (the row reads Unset / Value / Mixed / Pending / Error
 *     transparently).
 *   - Forwarding each row's `onCommit` to the parent's fan-out dispatcher.
 *   - A header line announcing the selection size (`N tasks selected`).
 *   - An empty-state when the selection drops to zero (rendered by the
 *     parent — this control just shows nothing).
 *
 * Deliberately NOT owned:
 *
 *   - The grid's selection set (lives in `grid.selection`).  The parent
 *     hands the size in via `selectionSize` and drives `onApply` against
 *     the live selection.
 *   - The docked-bar chrome (BulkActionBar is the chrome; this is the body).
 *   - The actual fan-out call.  The parent fires the per-row
 *     `attribute.update` writes; on settle it calls `model.settleCommit`
 *     with the {ok, failed} count.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { AttrSchema } from '../filter/attribute-schema.js';
import type { RefPinnedOption } from '../ui/ref-picker.js';
import type { BatchPanelModel } from './batch-panel-model.js';
import type { LoadState } from '../core/load-state.js';

/* -------------------------------------------------------------------------- */
/* Config + declaration-merged registry type.                                  */
/* -------------------------------------------------------------------------- */

export interface BatchTaskEditorConfig extends BaseControlConfig {
  type: 'BatchTaskEditor';

  /** Schema entries to render, in order. */
  schema: AttrSchema[];

  /** The batch store. */
  model: BatchPanelModel;

  /** Reactive thunk yielding the current selection size — drives the header
   *  text + lets the parent re-render this control without re-spawning when
   *  the selection set changes count (the model is mutated in place). */
  selectionSize: () => number;

  /** Per-attr config hook (project scope path, pinned options). */
  forAttr?: (attr: AttrSchema) => {
    parentScopePath?: string;
    pinnedOptions?: RefPinnedOption[];
  };

  /** Fan-out dispatcher.  Receives the committed (name, value) — the parent
   *  fires N `attribute.update` writes across the selection AND calls
   *  `model.settleCommit(name, value, prevSharedValue, {ok, failed})` on
   *  settle.  `value` is `null` for Unassign. */
  onApply: (attributeName: string, value: unknown) => void;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    BatchTaskEditor: BatchTaskEditorConfig;
  }
}

/* -------------------------------------------------------------------------- */
/* Control.                                                                   */
/* -------------------------------------------------------------------------- */

export class BatchTaskEditor extends Control<BatchTaskEditorConfig> {
  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'batch-task-editor';
    el.dataset.control = 'BatchTaskEditor';
    return el;
  }

  protected render(): void {
    const { schema, model, forAttr } = this.config;

    /* ----------------------------- header line ---------------------------- */
    const head = document.createElement('div');
    head.className = 'batch-task-editor__head muted';
    head.dataset.batchHead = '';
    this.bindText(head, () => {
      const n = this.config.selectionSize();
      if (n === 0) return 'No tasks selected.';
      if (n === 1) return '1 task selected — changes apply to it.';
      return `${n} tasks selected — changes apply to all of them.`;
    });
    this.el.append(head);

    /* -------------------------------- rows -------------------------------- */
    const rowsHost = document.createElement('div');
    rowsHost.className = 'batch-task-editor__rows';
    rowsHost.dataset.batchRows = '';
    this.el.append(rowsHost);

    for (const attr of schema) {
      const extra = forAttr?.(attr) ?? {};
      const cfg: Record<string, unknown> = {
        type: 'AttributeRow',
        attr,
        // Reads the SAME Signal<LoadState> contract single-task panels do
        // — the BatchPanelModel just produces Mixed in addition to the
        // other kinds.  AttributeRow already renders that.
        state: (): LoadState<unknown> => model.attr(attr.name).get(),
        // No labelFor: the BatchPanelModel doesn't track ref labels by id;
        // the row falls back to `#id` until the parent feeds the shared
        // PanelModel a label too.  Wire when the consumer needs it.
        onCommit: (next: unknown) => this.config.onApply(attr.name, next),
      };
      if (extra.parentScopePath !== undefined) cfg['parentScopePath'] = extra.parentScopePath;
      if (extra.pinnedOptions !== undefined && extra.pinnedOptions.length > 0) {
        cfg['pinnedOptions'] = extra.pinnedOptions;
      }
      this.spawn('AttributeRow', cfg, rowsHost);
    }
  }
}

export function registerBatchTaskEditor(): void {
  Control.register('BatchTaskEditor', BatchTaskEditor);
}
