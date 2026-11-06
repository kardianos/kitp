/**
 * WatchLists — the account's Watch lists screen (/watch-lists;
 * docs/WATCH_LISTS.md, help topic `watch_lists`).
 *
 *   - Left: your lists (symbol, name, how many items), Stars first as the
 *     oldest. Pick one to see it; **+ New list** adds one.
 *   - Right: the picked list — its symbol, name and description, editable
 *     in place (Save), Delete (asks once, inline) — and what is on it, in
 *     its order: drag a row by its handle to move it (watch.move, a
 *     sort_order between its new neighbours), **Remove** takes it off. Each
 *     row opens its task or thread.
 *
 * The page address keeps the picked list (?list=<id>). Lists are each
 * account's own; tasks and threads go on them from the bookmarks in their
 * corner (WatchBar). To see a list as a screen, filter on "On my watch list".
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { navigate, plainClick } from '../shell/router.js';
import { icon } from '../ui/icons.js';
import { DropPlaceholder, computeDropTarget } from '../ui/drag-placeholder.js';
import { WATCH_SPEC, sortOrderForSlot, watchItemHref, type WatchItem, type WatchList } from './specs.js';
import { WATCH_SYMBOLS } from './symbols.js';

export interface WatchListsConfig extends BaseControlConfig {
  type: 'WatchLists';
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    WatchLists: WatchListsConfig;
  }
}

/** The list id in the page address (?list=<id>), or ''. */
export function listFromSearch(search: string): string {
  const v = new URLSearchParams(search).get('list') ?? '';
  return /^\d+$/.test(v) ? v : '';
}

export class WatchLists extends Control<WatchListsConfig> {
  private lists: WatchList[] = [];
  private items: WatchItem[] = [];
  private selected = '';
  private loaded = false;
  private itemsLoaded = false;
  private confirmDelete = false;
  private error = '';
  private dragging: string | null = null;
  private placeholder: DropPlaceholder | null = null;
  private itemSeq = 0;

  private listHost!: HTMLElement;
  private detailHost!: HTMLElement;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'watch-lists';
    el.dataset.control = 'WatchLists';
    return el;
  }

  protected render(): void {
    this.selected = listFromSearch(typeof location !== 'undefined' ? location.search : '');
    const head = document.createElement('header');
    head.className = 'watch-lists__head';
    const h1 = document.createElement('h1');
    h1.className = 'watch-lists__title';
    h1.textContent = 'Watch lists';
    const hint = document.createElement('p');
    hint.className = 'watch-lists__hint muted';
    hint.textContent =
      'Your own bookmark lists of tasks and threads. Put something on a list from the symbols in the top corner of its page; here you name lists, give each a symbol, and drag what is on them into order. To work through a list on a screen, filter on “On my watch list” (with Active, say).';
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'watch-lists__link';
    more.textContent = 'Detailed steps';
    this.listen(more, 'click', () => this.ctx.bus?.emit('toggleInstructions', undefined));
    hint.append(document.createTextNode(' '), more);
    head.append(h1, hint);

    const body = document.createElement('div');
    body.className = 'watch-lists__body';
    this.listHost = document.createElement('div');
    this.listHost.className = 'watch-lists__lists';
    this.listHost.dataset.watchLists = '';
    this.detailHost = document.createElement('div');
    this.detailHost.className = 'watch-lists__detail';
    this.detailHost.dataset.watchDetail = '';
    body.append(this.listHost, this.detailHost);
    this.el.replaceChildren(head, body);
    this.onDestroy(() => this.placeholder?.destroy());
    this.loadLists();
  }

  /* -------------------------------- loads -------------------------------- */

  private loadLists(after?: () => void): void {
    this.ctx.api.callByName(
      WATCH_SPEC.lists,
      {},
      (out) => {
        if (!this.isAlive()) return;
        this.lists = (out as { lists: WatchList[] }).lists ?? [];
        this.loaded = true;
        if (!this.lists.some((l) => l.id === this.selected)) this.selected = this.lists[0]?.id ?? '';
        after?.();
        this.paintLists();
        this.loadItems();
      },
      { alive: () => this.isAlive() },
    );
  }

  private loadItems(): void {
    const seq = ++this.itemSeq;
    this.itemsLoaded = false;
    this.items = [];
    this.paintDetail();
    if (this.selected === '') return;
    this.ctx.api.callByName(
      WATCH_SPEC.items,
      { watchListId: this.selected },
      (out) => {
        if (!this.isAlive() || seq !== this.itemSeq) return;
        this.items = (out as { items: WatchItem[] }).items ?? [];
        this.itemsLoaded = true;
        this.paintDetail();
      },
      { alive: () => this.isAlive() },
    );
  }

  private select(id: string): void {
    if (id === this.selected) return;
    this.selected = id;
    this.confirmDelete = false;
    this.error = '';
    if (typeof history !== 'undefined' && typeof location !== 'undefined') {
      history.replaceState(history.state, '', `${location.pathname}?list=${id}`);
    }
    this.paintLists();
    this.loadItems();
  }

  /* -------------------------------- lists -------------------------------- */

  private paintLists(): void {
    this.listHost.replaceChildren();
    if (!this.loaded) {
      this.listHost.append(textEl('p', 'muted', 'Loading…'));
      return;
    }
    if (this.lists.length === 0) {
      this.listHost.append(textEl('p', 'muted', 'No lists yet.'));
    }
    const ul = document.createElement('ul');
    ul.className = 'watch-lists__list-items';
    for (const l of this.lists) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'watch-lists__list';
      b.dataset.watchListPick = l.id;
      if (l.id === this.selected) b.setAttribute('aria-current', 'true');
      const sym = textEl('span', 'watch-lists__symbol', l.symbol);
      sym.setAttribute('aria-hidden', 'true');
      b.append(sym, textEl('span', 'watch-lists__name', l.title), textEl('span', 'watch-lists__count muted', String(l.count)));
      this.listen(b, 'click', () => this.select(l.id));
      li.append(b);
      ul.append(li);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn watch-lists__add';
    add.dataset.watchListAdd = '';
    add.textContent = '+ New list';
    this.listen(add, 'click', () => this.createList());
    this.listHost.append(ul, add);
  }

  private createList(): void {
    const n = this.lists.length + 1;
    this.ctx.api.callByName(
      WATCH_SPEC.setList,
      { title: `List ${n}`, symbol: '🔖' },
      (out) => {
        if (!this.isAlive()) return;
        const id = (out as { id: string }).id;
        this.selected = id;
        this.loadLists();
      },
      { alive: () => this.isAlive() },
    );
  }

  /* ------------------------------- detail -------------------------------- */

  private paintDetail(): void {
    this.detailHost.replaceChildren();
    const list = this.lists.find((l) => l.id === this.selected);
    if (list === undefined) {
      if (this.loaded) this.detailHost.append(textEl('p', 'muted', 'Make a list to start.'));
      return;
    }
    this.detailHost.append(this.editForm(list), this.itemsView(list));
  }

  private editForm(list: WatchList): HTMLElement {
    const form = document.createElement('div');
    form.className = 'watch-lists__form';
    form.dataset.watchForm = list.id;
    const field = (label: string, input: HTMLElement, hint?: string): HTMLElement => {
      const wrap = document.createElement('label');
      wrap.className = 'watch-lists__field';
      wrap.append(textEl('span', 'watch-lists__label muted', label), input);
      if (hint !== undefined) wrap.append(textEl('span', 'watch-lists__caption muted', hint));
      return wrap;
    };
    const symbol = document.createElement('input');
    symbol.type = 'text';
    symbol.className = 'watch-lists__symbol-input';
    symbol.dataset.watchSymbol = '';
    symbol.value = list.symbol;
    symbol.maxLength = 16;
    symbol.placeholder = 'Any';
    symbol.setAttribute('aria-label', 'Symbol');
    const symbolPick = this.symbolPicker(symbol);
    const title = document.createElement('input');
    title.type = 'text';
    title.dataset.watchTitle = '';
    title.value = list.title;
    title.maxLength = 60;
    const desc = document.createElement('textarea');
    desc.dataset.watchDescription = '';
    desc.rows = 2;
    desc.value = list.description;
    desc.placeholder = 'What this list is for (optional)';
    const error = textEl('p', 'watch-lists__error', this.error);
    error.setAttribute('role', 'alert');
    error.hidden = this.error === '';

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary';
    save.dataset.watchSave = '';
    save.textContent = 'Save';
    this.listen(save, 'click', () => {
      const t = title.value.trim();
      const s = symbol.value.trim();
      if (t === '' || s === '') {
        this.error = 'A list needs a symbol and a name.';
        this.paintDetail();
        return;
      }
      this.error = '';
      this.ctx.api.callByName(
        WATCH_SPEC.setList,
        { id: list.id, title: t, symbol: s, description: desc.value.trim() },
        () => {
          if (this.isAlive()) this.loadLists();
        },
        {
          alive: () => this.isAlive(),
          onErr: () => {
            this.error = 'Couldn’t save the list.';
            this.paintDetail();
          },
        },
      );
    });

    const actions = document.createElement('div');
    actions.className = 'watch-lists__actions';
    if (this.confirmDelete) {
      const ask = textEl('span', 'muted', `Delete ${list.title}? What is on it isn't touched.`);
      const yes = document.createElement('button');
      yes.type = 'button';
      yes.className = 'btn btn-danger';
      yes.dataset.watchDeleteConfirm = '';
      yes.textContent = 'Delete';
      this.listen(yes, 'click', () => this.deleteList(list.id));
      const no = document.createElement('button');
      no.type = 'button';
      no.className = 'btn';
      no.textContent = 'Keep';
      this.listen(no, 'click', () => {
        this.confirmDelete = false;
        this.paintDetail();
      });
      actions.append(ask, yes, no);
    } else {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn';
      del.dataset.watchDelete = '';
      del.textContent = 'Delete list';
      this.listen(del, 'click', () => {
        this.confirmDelete = true;
        this.paintDetail();
      });
      actions.append(save, del);
    }
    form.append(
      field('Symbol', symbolPick, 'Pick one, or type any emoji or character; it is what you click on a task.'),
      field('Name', title),
      field('Description', desc),
      error,
      actions,
    );
    return form;
  }

  /**
   * The Symbol field: its text box (any emoji or character) and, under it,
   * the quick picks (WATCH_SYMBOLS). A pick fills the box; the one matching
   * the box is marked pressed, and typing updates the mark. Save keeps it.
   */
  private symbolPicker(input: HTMLInputElement): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'watch-lists__symbol-pick';
    const grid = document.createElement('div');
    grid.className = 'watch-lists__symbols';
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', 'Pick a symbol');
    grid.dataset.watchSymbols = '';
    const buttons = WATCH_SYMBOLS.map((w) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'watch-lists__symbol-btn';
      b.dataset.watchSymbolPick = w.symbol;
      b.textContent = w.symbol;
      b.title = w.name;
      b.setAttribute('aria-label', w.name);
      this.listen(b, 'click', (e) => {
        // Inside the field's <label>: don't let the click also focus the box.
        e.preventDefault();
        input.value = w.symbol;
        mark();
      });
      return b;
    });
    const mark = (): void => {
      const v = input.value.trim();
      for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.watchSymbolPick === v));
    };
    this.listen(input, 'input', mark);
    mark();
    grid.append(...buttons);
    wrap.append(input, grid);
    return wrap;
  }

  private deleteList(id: string): void {
    this.ctx.api.callByName(
      WATCH_SPEC.deleteList,
      { id },
      () => {
        if (!this.isAlive()) return;
        this.confirmDelete = false;
        this.selected = '';
        this.loadLists();
      },
      { alive: () => this.isAlive() },
    );
  }

  /* -------------------------------- items -------------------------------- */

  private itemsView(list: WatchList): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'watch-lists__items-wrap';
    const h = textEl('h2', 'watch-lists__items-title muted', `On ${list.title}`);
    wrap.append(h);
    if (!this.itemsLoaded) {
      wrap.append(textEl('p', 'muted', 'Loading…'));
      return wrap;
    }
    if (this.items.length === 0) {
      wrap.append(
        textEl('p', 'muted', `Nothing yet. Click ${list.symbol} in the corner of a task or thread to put it here.`),
      );
      return wrap;
    }
    const rows = document.createElement('ol');
    rows.className = 'watch-lists__items';
    rows.dataset.watchItems = '';
    this.placeholder?.destroy();
    this.placeholder = new DropPlaceholder(rows, { className: 'drop-placeholder--watch' });
    const placeholder = this.placeholder;
    this.listen(rows, 'dragover', (ev) => {
      if (this.dragging === null) return;
      ev.preventDefault();
      const t = computeDropTarget(rows, (ev as DragEvent).clientY, this.dragging, '[data-watch-item]');
      placeholder.showAtY(t.y);
    });
    this.listen(rows, 'drop', (ev) => {
      if (this.dragging === null) return;
      ev.preventDefault();
      placeholder.pulse();
      const t = computeDropTarget(rows, (ev as DragEvent).clientY, this.dragging, '[data-watch-item]');
      const moved = this.dragging;
      this.dragging = null;
      this.moveTo(list.id, moved, t.slot);
    });
    for (const item of this.items) rows.append(this.itemRow(list.id, item));
    wrap.append(rows);
    return wrap;
  }

  private itemRow(listId: string, item: WatchItem): HTMLElement {
    const li = document.createElement('li');
    li.className = 'watch-lists__item';
    li.dataset.watchItem = item.cardId;
    // computeDropTarget skips the dragged row by data-card-id.
    li.dataset.cardId = item.cardId;
    const handle = document.createElement('span');
    handle.className = 'watch-lists__drag';
    handle.dataset.watchDrag = item.cardId;
    handle.draggable = true;
    handle.title = 'Drag to move';
    handle.setAttribute('aria-hidden', 'true');
    handle.append(icon('grip-vertical', 14));
    this.listen(handle, 'dragstart', (ev) => {
      this.dragging = item.cardId;
      const dt = (ev as DragEvent).dataTransfer;
      if (dt) {
        dt.effectAllowed = 'move';
        dt.setData('text/plain', item.cardId);
      }
    });
    this.listen(handle, 'dragend', () => {
      this.dragging = null;
      this.placeholder?.hide();
    });

    const href = watchItemHref(item);
    const link = document.createElement('a');
    link.className = 'watch-lists__item-title';
    link.href = href;
    link.textContent = item.title !== '' ? item.title : `#${item.cardId}`;
    this.listen(link, 'click', plainClick(() => navigate(href)));
    const kind = textEl('span', 'watch-lists__kind muted', item.cardType === 'comm' ? 'Thread' : `#${item.cardId}`);
    const project = textEl('span', 'watch-lists__project muted', item.projectTitle);
    const status = textEl('span', 'watch-lists__status', item.status);
    status.dataset.phase = item.phase;
    if (item.status === '') status.hidden = true;

    const up = this.moveButton('Move up', 'arrow-up', () => this.step(listId, item.cardId, -1));
    const down = this.moveButton('Move down', 'arrow-down', () => this.step(listId, item.cardId, 1));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'watch-lists__remove';
    remove.dataset.watchRemove = item.cardId;
    remove.textContent = 'Remove';
    remove.title = 'Take it off this list';
    this.listen(remove, 'click', () => this.removeItem(listId, item.cardId));

    li.append(handle, link, kind, project, status, up, down, remove);
    return li;
  }

  private moveButton(label: string, glyph: 'arrow-up' | 'arrow-down', fn: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'watch-lists__step';
    b.dataset.watchStep = glyph === 'arrow-up' ? 'up' : 'down';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(icon(glyph, 12));
    this.listen(b, 'click', fn);
    return b;
  }

  /** Keyboard / button move: one place up (-1) or down (+1). */
  private step(listId: string, cardId: string, delta: number): void {
    const from = this.items.findIndex((i) => i.cardId === cardId);
    if (from < 0) return;
    const slot = from + delta;
    if (slot < 0 || slot > this.items.length - 1) return;
    this.moveTo(listId, cardId, slot);
  }

  /** Move an item to `slot` among the others: reorder locally, then save
   *  its new sort_order; a failed save reloads the list's real order. */
  private moveTo(listId: string, cardId: string, slot: number): void {
    const from = this.items.findIndex((i) => i.cardId === cardId);
    const item = this.items[from];
    if (item === undefined) return;
    const others = this.items.filter((i) => i.cardId !== cardId);
    const at = Math.max(0, Math.min(slot, others.length));
    // Back where it was: nothing moves.
    if (at === from) return;
    const sortOrder = sortOrderForSlot(
      others.map((i) => i.sortOrder),
      at,
    );
    item.sortOrder = sortOrder;
    others.splice(at, 0, item);
    this.items = others;
    this.paintDetail();
    this.ctx.api.callByName(
      WATCH_SPEC.move,
      { watchListId: listId, cardId, sortOrder },
      () => undefined,
      { alive: () => this.isAlive(), onErr: () => this.loadItems() },
    );
  }

  private removeItem(listId: string, cardId: string): void {
    this.items = this.items.filter((i) => i.cardId !== cardId);
    const list = this.lists.find((l) => l.id === listId);
    if (list !== undefined) list.count = Math.max(0, list.count - 1);
    this.paintLists();
    this.paintDetail();
    this.ctx.api.callByName(
      WATCH_SPEC.set,
      { watchListId: listId, cardId, on: false },
      () => undefined,
      { alive: () => this.isAlive(), onErr: () => this.loadLists() },
    );
  }
}

function textEl(tag: string, cls: string, text: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  e.append(document.createTextNode(text));
  return e;
}

export function registerWatchLists(): void {
  Control.register('WatchLists', WatchLists);
}
