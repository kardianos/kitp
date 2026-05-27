/**
 * InboxViewToggles — the "Mine only" / "Routed to me" view toggles, mounted on
 * the filter bar's "View" row via the ScreenFilterBar `viewActions` seam (#8/#13)
 * rather than inside the Inbox body. They are pure leaf flippers: each toggles a
 * boolean tree leaf (`inbox.mineOnly` / `inbox.routedToMe`) that the Inbox watches
 * to re-project its filter / refire its query. Reactive on the leaf, so the
 * Inbox (or anything else) writing the leaf keeps the button's pressed state in
 * sync.
 */

import { Control, type BaseControlConfig } from '../core/control.js';

export interface InboxViewTogglesConfig extends BaseControlConfig {
  type: 'InboxViewToggles';
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    InboxViewToggles: InboxViewTogglesConfig;
  }
}

export class InboxViewToggles extends Control<InboxViewTogglesConfig> {
  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'inbox__toggles';
    el.dataset.control = 'InboxViewToggles';
    return el;
  }

  protected render(): void {
    this.el.append(
      this.toggle('inbox-mine-toggle', 'Mine only', 'Narrow to tasks assigned to me', ['inbox', 'mineOnly']),
      this.toggle('inbox-routed-toggle', 'Routed to me', 'Show tasks routed to me as an agent', ['inbox', 'routedToMe']),
    );
  }

  private toggle(testId: string, label: string, title: string, path: string[]): HTMLElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'inbox__toggle';
    btn.dataset.inboxToggle = testId;
    btn.title = title;
    btn.textContent = label;
    const node = this.ctx.tree.at([...path]);
    this.effect(() => {
      const on = node.get<boolean>() ?? false;
      btn.classList.toggle('inbox__toggle--active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }, `inboxToggle.${testId}`);
    this.listen(btn, 'click', () => node.set(!(node.peek<boolean>() ?? false)));
    return btn;
  }
}

export function registerInboxViewToggles(): void {
  Control.register('InboxViewToggles', InboxViewToggles);
}
