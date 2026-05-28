/**
 * NewTaskButton — a visible primary "New" button for creating a task, mounted on
 * the filter bar's view-actions row (the ScreenFilterBar `viewActions` seam) for
 * the Grid + List screens. It raises the shared `quickCreateOpen` bus intent the
 * AppShell wires to the single QuickEntry overlay — the SAME action as the `n`
 * hotkey, just made discoverable. The new task is scoped to the active project
 * (QuickEntry reads `scope.projectId` itself; no parent is passed here).
 *
 * Which layouts surface the button is data-driven in `viewActionsForLayout`
 * (screen-resolve.ts), not branched here — this control is layout-agnostic.
 */

import { Control, type BaseControlConfig } from '../core/control.js';

export interface NewTaskButtonConfig extends BaseControlConfig {
  type: 'NewTaskButton';
  /** Button label. Default '+ New'. */
  label?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    NewTaskButton: NewTaskButtonConfig;
  }
}

export class NewTaskButton extends Control<NewTaskButtonConfig> {
  protected override createRoot(): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary filterbar__new';
    btn.dataset.control = 'NewTaskButton';
    btn.dataset.newTask = '';
    btn.textContent = this.config.label ?? '+ New';
    return btn;
  }

  protected render(): void {
    this.listen(this.el, 'click', () => this.ctx.bus?.emit('quickCreateOpen'));
  }
}

export function registerNewTaskButton(): void {
  Control.register('NewTaskButton', NewTaskButton);
}
