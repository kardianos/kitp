/**
 * WatchBar — the bookmarks in a task's or thread's corner
 * (docs/WATCH_LISTS.md): one small button per watch list of yours, showing
 * the list's symbol; hovering (or focusing) one slides its name out
 * ("★ Stars"). A click puts the card on that list or takes it off — lit
 * when it is on. The last button opens Watch lists, where lists are made,
 * renamed and ordered.
 *
 * Reads watch_list.list {cardId} (which also makes an account's Stars the
 * first time); writes watch.set, optimistically, putting the button back if
 * the write fails. An account with no person has no lists: the bar stays
 * empty.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { navigate, plainClick } from '../shell/router.js';
import { WATCH_SPEC, type WatchList } from './specs.js';

export interface WatchBarConfig extends BaseControlConfig {
  type: 'WatchBar';
  /** The task or thread (comm) card id. */
  cardId: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    WatchBar: WatchBarConfig;
  }
}

/** The Watch lists screen. */
export const WATCH_LISTS_PATH = '/watch-lists';

export class WatchBar extends Control<WatchBarConfig> {
  private lists: WatchList[] = [];
  private seq = 0;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'watch-bar';
    el.dataset.control = 'WatchBar';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Watch lists');
    return el;
  }

  protected render(): void {
    this.load();
  }

  /** Re-read the lists (the page's Refresh). */
  reload(): void {
    this.load();
  }

  private load(): void {
    const seq = ++this.seq;
    this.ctx.api.callByName(
      WATCH_SPEC.lists,
      { cardId: this.config.cardId },
      (out) => {
        if (!this.isAlive() || seq !== this.seq) return;
        this.lists = (out as { lists: WatchList[] }).lists ?? [];
        this.paint();
      },
      { alive: () => this.isAlive() },
    );
  }

  private paint(): void {
    this.el.replaceChildren();
    if (this.lists.length === 0) return;
    for (const list of this.lists) this.el.append(this.button(list));
    const manage = document.createElement('a');
    manage.className = 'watch-bar__manage';
    manage.dataset.watchManage = '';
    manage.href = WATCH_LISTS_PATH;
    manage.title = 'Watch lists: make, rename and order them';
    manage.setAttribute('aria-label', 'Manage watch lists');
    manage.textContent = '⋯';
    this.listen(manage, 'click', plainClick(() => navigate(WATCH_LISTS_PATH)));
    this.el.append(manage);
  }

  private button(list: WatchList): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'watch-bar__item';
    b.dataset.watchList = list.id;
    const paint = (): void => {
      b.setAttribute('aria-pressed', list.hasCard ? 'true' : 'false');
      b.classList.toggle('watch-bar__item--on', list.hasCard);
      b.title = list.hasCard ? `On ${list.title} — click to take it off` : `Put it on ${list.title}`;
    };
    const symbol = document.createElement('span');
    symbol.className = 'watch-bar__symbol';
    symbol.setAttribute('aria-hidden', 'true');
    symbol.textContent = list.symbol;
    const name = document.createElement('span');
    name.className = 'watch-bar__name';
    name.textContent = list.title;
    b.append(symbol, name);
    paint();
    this.listen(b, 'click', () => {
      const on = !list.hasCard;
      list.hasCard = on;
      paint();
      this.ctx.api.callByName(
        WATCH_SPEC.set,
        { watchListId: list.id, cardId: this.config.cardId, on },
        () => {
          if (this.isAlive()) list.count += on ? 1 : -1;
        },
        {
          alive: () => this.isAlive(),
          onErr: () => {
            list.hasCard = !on;
            paint();
          },
        },
      );
    });
    return b;
  }
}

export function registerWatchBar(): void {
  Control.register('WatchBar', WatchBar);
}
