/**
 * TaskAttributePanel — the high-level intent control for "render a panel of
 * attribute rows against a SINGLE task's PanelModel and commit each change
 * to the server immediately."
 *
 * Per the project's composition principle (STRUCTURAL_PLAN): this control is
 * the named intent.  We do NOT have a generic `AttributePanel { policy:
 * 'live' | 'deferred' | 'batch' }`.  Instead each commit semantic gets its
 * own high-level control — `TaskAttributePanel` (live), `NewTaskForm`
 * (deferred + Save), `BatchTaskEditor` (fan-out across selection).  Each
 * declares its intent in its name and composes the SAME lower-level
 * primitives: `AttributeRow` + `FieldEditor` + `CardRefValue` + LoadState.
 *
 * Owned responsibilities (the focused duty):
 *
 *   - Iterating the schema → spawning one `AttributeRow` per editable attr.
 *   - Wiring each row's `state` thunk to the PanelModel's per-attr signal.
 *   - Wiring each row's `labelFor` to the PanelModel's per-ref signal.
 *   - Forwarding each row's `onCommit` to the parent's commit dispatcher
 *     (`config.onCommit(name, value)`) — the parent fires the actual API
 *     call + drives `panel.beginCommit / confirmCommit / rejectCommit`.
 *   - The empty-state placeholder when the schema is empty.
 *
 * Deliberately NOT owned (kept at the screen level):
 *
 *   - The API call.  This control fires `onCommit(name, value)`; the parent
 *     dispatches.  Keeps the control test-friendly + screen-policy free.
 *   - The per-ref label loading.  PanelModel is handed in; the screen seeds
 *     it via `setRefLabel` from its own `card.search` calls.
 *   - Surrounding chrome (panel head, "Attributes" title, etc.) — the
 *     screen wraps this control in its own section.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { AttrSchema } from '../filter/attribute-schema.js';
import type { RefPinnedOption } from '../ui/ref-picker.js';
import { PanelModel } from './panel-model.js';
import type { LoadState } from '../core/load-state.js';

/* -------------------------------------------------------------------------- */
/* Config + declaration-merged registry type.                                  */
/* -------------------------------------------------------------------------- */

export interface TaskAttributePanelConfig extends BaseControlConfig {
  type: 'TaskAttributePanel';

  /** Schema entries to render, in display order.  The control DOES NOT
   *  filter; the caller hands in the visible list. */
  schema: AttrSchema[];

  /** The signal store backing each row's state.  The control reads
   *  `panel.attr(name)` for state and `panel.refLabel(...)` for refs. */
  panel: PanelModel;

  /** Commit dispatch.  Fired by an AttributeRow when the user finishes an
   *  edit (including null for Unassign).  The screen runs the actual
   *  `attribute.update` and drives the panel store's lifecycle. */
  onCommit: (attributeName: string, value: unknown) => void;

  /** Per-attr config hook — the screen returns the project scope path for
   *  refs + any pinned options (e.g. "Self" for person refs). */
  forAttr?: (attr: AttrSchema) => {
    parentScopePath?: string;
    pinnedOptions?: RefPinnedOption[];
  };
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    TaskAttributePanel: TaskAttributePanelConfig;
  }
}

/* -------------------------------------------------------------------------- */
/* Control.                                                                   */
/* -------------------------------------------------------------------------- */

export class TaskAttributePanel extends Control<TaskAttributePanelConfig> {
  /** Spawned AttributeRow children, so a re-render disposes the prior set. */
  private rowChildren: Control[] = [];

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'task-attribute-panel';
    el.dataset.control = 'TaskAttributePanel';
    return el;
  }

  protected render(): void {
    if (this.config.schema.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'task-detail__panel-empty muted';
      empty.dataset.attributePanelEmpty = '';
      empty.textContent = 'No attributes available.';
      this.el.append(empty);
      return;
    }

    for (const attr of this.config.schema) {
      const extra = this.config.forAttr?.(attr) ?? {};
      const cfg: Record<string, unknown> = {
        type: 'AttributeRow',
        attr,
        state: (): LoadState<unknown> => this.config.panel.attr(attr.name).get(),
        labelFor: (id: bigint) => {
          const target = attr.targetCardType;
          if (target === undefined) return undefined;
          const s = this.config.panel.refLabel(target, id).get();
          return s.kind === 'value' ? s.value : undefined;
        },
        onCommit: (next: unknown) => this.config.onCommit(attr.name, next),
      };
      if (extra.parentScopePath !== undefined) cfg['parentScopePath'] = extra.parentScopePath;
      if (extra.pinnedOptions !== undefined && extra.pinnedOptions.length > 0) {
        cfg['pinnedOptions'] = extra.pinnedOptions;
      }
      this.rowChildren.push(this.spawn('AttributeRow', cfg, this.el));
    }
  }
}

export function registerTaskAttributePanel(): void {
  Control.register('TaskAttributePanel', TaskAttributePanel);
}
