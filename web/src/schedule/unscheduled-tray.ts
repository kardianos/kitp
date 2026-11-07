/**
 * The Unscheduled tray of the Calendar and Timeline
 * (docs/TIMELINE_AND_CALENDAR.md T2, T3): the filtered tasks with neither a
 * start nor a due date. Collapsed by default behind a header toggle that
 * shows the count; open, it lists each task by title and #id. Dragging a row
 * onto a day gives the task that due date (the view plans and fires the
 * write); clicking a row opens the task.
 *
 * A plain helper the view owns — not a registered control: it has no data of
 * its own, only the rows the view hands it.
 */

import { rowLink, setRowLinkHref } from '../shell/popout.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import { taskTitle } from './schedule-data.js';
import { icon } from '../ui/icons.js';

export interface UnscheduledTrayOptions {
  /** A press on a row (the view starts a drag from it). */
  onPress: (ev: PointerEvent, row: CardWithAttrs, el: HTMLElement) => void;
  /** A plain click on a row (open the task). */
  onOpen: (row: CardWithAttrs) => void;
}

export class UnscheduledTray {
  /** The toggle button, for the view's header. */
  readonly toggle: HTMLButtonElement;
  /** The panel, for the view's body. */
  readonly panel: HTMLElement;
  private readonly list: HTMLElement;
  private readonly note: HTMLElement;
  private readonly countEl: HTMLElement;
  private open = false;
  private rows: CardWithAttrs[] = [];
  private readonly disposers: Array<() => void> = [];

  constructor(private readonly opts: UnscheduledTrayOptions) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn schedule-tray__toggle';
    toggle.dataset.trayToggle = '';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.title = 'Tasks with no start or due date';
    const label = document.createElement('span');
    label.textContent = 'Unscheduled';
    const count = document.createElement('span');
    count.className = 'schedule-tray__count';
    count.dataset.trayCount = '';
    count.textContent = '0';
    toggle.append(icon('calendar', 14), label, count);
    this.toggle = toggle;
    this.countEl = count;

    const panel = document.createElement('aside');
    panel.className = 'schedule-tray';
    panel.dataset.tray = '';
    panel.setAttribute('aria-label', 'Unscheduled tasks');
    panel.style.display = 'none';
    const hint = document.createElement('div');
    hint.className = 'schedule-tray__hint muted';
    hint.textContent = 'Drag a task onto a day to give it that due date.';
    const list = document.createElement('div');
    list.className = 'schedule-tray__list';
    list.setAttribute('role', 'list');
    const note = document.createElement('div');
    note.className = 'schedule-tray__note muted';
    note.dataset.trayNote = '';
    panel.append(hint, list, note);
    this.panel = panel;
    this.list = list;
    this.note = note;

    const onToggle = (): void => this.setOpen(!this.open);
    toggle.addEventListener('click', onToggle);
    this.disposers.push(() => toggle.removeEventListener('click', onToggle));
  }

  isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.panel.style.display = open ? '' : 'none';
    this.toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    this.toggle.classList.toggle('is-active', open);
  }

  /**
   * Show these rows (the view already left out any it has just scheduled).
   * `more` = the read hit its limit, so there are more than shown.
   */
  update(rows: readonly CardWithAttrs[], more: boolean): void {
    this.rows = [...rows];
    this.countEl.textContent = more ? `${rows.length}+` : String(rows.length);
    this.list.replaceChildren(...this.rows.map((r) => this.rowEl(r)));
    if (rows.length === 0) {
      this.note.textContent = 'Every task here has a date.';
    } else if (more) {
      this.note.textContent = `Showing the ${rows.length} most recently active. Narrow the filter to see the rest.`;
    } else {
      this.note.textContent = '';
    }
  }

  private rowEl(row: CardWithAttrs): HTMLElement {
    const el = document.createElement('div');
    el.className = 'schedule-tray__row';
    el.dataset.trayRow = row.id.toString();
    el.dataset.cardId = row.id.toString();
    el.setAttribute('role', 'listitem');
    el.tabIndex = 0;
    const title = document.createElement('span');
    title.className = 'schedule-tray__title';
    title.textContent = taskTitle(row);
    const id = document.createElement('span');
    id.className = 'schedule-tray__id muted';
    id.textContent = `#${row.id.toString()}`;
    const link = rowLink();
    setRowLinkHref(link, row.id);
    el.append(title, id, link);
    el.addEventListener('pointerdown', (ev) => this.opts.onPress(ev as PointerEvent, row, el));
    el.addEventListener('click', () => this.opts.onOpen(row));
    el.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') {
        ev.preventDefault();
        this.opts.onOpen(row);
      }
    });
    return el;
  }

  /** The rows shown now. */
  shown(): readonly CardWithAttrs[] {
    return this.rows;
  }

  dispose(): void {
    for (const d of this.disposers.splice(0)) d();
    this.list.replaceChildren();
  }
}
