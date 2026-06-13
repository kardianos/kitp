/**
 * CardListBody — the COMPACT / LIST presentation on top of {@link CardListCore}.
 *
 * It renders the `comms` screen (one-line: phase-toned badge · subject · parent
 * chip · Needs-ACK flag) and the `list`/Inbox screen (two-line: #id + title /
 * status pill + assignee + priority columns, with personal-sort reorder + a
 * delegate picker). Everything below the rendering — the query, lookups, cursor,
 * group, filter, reorder, delegate — lives in CardListCore, which the Grid
 * extends too, so the two bodies share one interface. CSS keys off
 * `data-presentation` for the one-line vs two-line arrangement.
 */

import { Control } from '../core/control.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import { asAttrId } from '../kanban/kanban-helpers.js';
import { CardListCore, type CardListCoreConfig, titleOf, idKey } from './core.js';
import { rowLink, setRowLinkHref } from '../shell/popout.js';

import { statusIcon } from '../ui/status-icon.js';
const ROW_HEIGHT = 56;

/** A secondary column shown as a chip on the row (assignee, priority, …). */
export interface CardListColumn {
  attr: string;
  kind: 'ref' | 'text';
  lookup?: string;
  label?: string;
}

export interface CardListBodyConfig extends CardListCoreConfig {
  type: 'CardListBody';
  /** 'compact' (one line — comms) or 'list' (two lines — inbox). Default 'compact'. */
  presentation?: 'compact' | 'list';
  /** Show the `#id` lead element (the inbox list does; comms doesn't). */
  showId?: boolean;
  /** Secondary columns (assignee, priority) rendered as chips. */
  columns?: CardListColumn[];
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    CardListBody: CardListBodyConfig;
  }
}

export class CardListBody extends CardListCore<CardListBodyConfig> {
  private headEl!: HTMLElement;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'card-list';
    el.dataset.control = 'CardListBody';
    el.dataset.presentation = this.config.presentation ?? 'compact';
    el.tabIndex = -1;
    return el;
  }

  protected render(): void {
    this.registerCoreHandlers();

    const head = document.createElement('header');
    head.className = 'card-list__head';
    const h = document.createElement('h2');
    h.className = 'card-list__heading muted';
    h.dataset.cardListHeading = '';
    h.textContent = this.headingLabel();
    head.append(h);
    this.headEl = h;

    if (this.config.flagAttr !== undefined) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'card-list__flag-filter';
      toggle.dataset.cardListFlagFilter = '';
      toggle.textContent = this.config.flagLabel ?? 'Flagged';
      toggle.setAttribute('aria-pressed', 'false');
      this.listen(toggle, 'click', () => {
        this.flaggedOnly = !this.flaggedOnly;
        toggle.setAttribute('aria-pressed', this.flaggedOnly ? 'true' : 'false');
        this.applyFilterAndOrder();
        this.bumpQuery();
      });
      head.append(toggle);
    }
    this.el.append(head);

    const list = document.createElement('div');
    list.className = 'card-list__rows';
    list.dataset.cardListRows = '';
    list.setAttribute('role', 'list');
    this.listEl = list;
    this.el.append(list);

    const empty = document.createElement('p');
    empty.className = 'card-list__empty muted';
    empty.dataset.cardListEmpty = '';
    empty.style.display = 'none';
    empty.textContent = 'Loading…';
    this.emptyEl = empty;
    this.el.append(empty);

    this.rowHeight = ROW_HEIGHT;
    this.wireList();
    this.wireCoreEffects();
    this.wireListInteractions();

    // Heading count, repainted on every rows change.
    this.effect(() => {
      const rows = (this.ctx.tree.at(this.rowsPath).get<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
      this.headEl.textContent = this.headingLabel(rows.length);
    }, 'cardList.heading');
  }

  override hotkeys(): readonly import('../core/hotkeys.js').HotkeyBinding[] {
    return this.coreHotkeys();
  }

  /* ---- presentation: the compact / list row -------------------------------- */

  protected ensureRowMode(el: HTMLElement): void {
    if (el.dataset.cardRow !== undefined) return;
    delete el.dataset.cardGroup;
    el.className = 'card-list__row';
    el.dataset.cardRow = '';
    el.setAttribute('role', 'listitem');
    el.tabIndex = 0;
    el.replaceChildren();

    // Leftmost drag grip for personal-sort reorder (inbox). Native-DnD source;
    // the container drag wiring + commit live in CardListCore.
    if (this.config.personalSort === true) el.append(this.makeRowGrip(el));

    const badge = document.createElement('span');
    badge.className = 'card-list__status';
    badge.dataset.role = 'badge';

    const main = document.createElement('div');
    main.className = 'card-list__main';
    const line1 = document.createElement('div');
    line1.className = 'card-list__line1';
    const idEl = document.createElement('span');
    idEl.className = 'card-list__id muted';
    idEl.dataset.role = 'id';
    const subject = document.createElement('span');
    subject.className = 'card-list__subject';
    subject.dataset.role = 'subject';
    const flag = document.createElement('span');
    flag.className = 'card-list__flag';
    flag.dataset.role = 'flag';
    flag.style.display = 'none';
    subject.append(flag);
    line1.append(idEl, subject);
    const line2 = document.createElement('div');
    line2.className = 'card-list__line2';
    line2.dataset.role = 'cols';
    const parent = document.createElement('span');
    parent.className = 'card-list__parent muted';
    parent.dataset.role = 'parent';
    line2.append(parent);
    main.append(line1, line2);
    el.append(badge, main);

    if (this.config.delegate === true) {
      const delegate = document.createElement('select');
      delegate.className = 'card-list__delegate';
      delegate.dataset.role = 'delegate';
      delegate.setAttribute('aria-label', 'Delegate to one of your agents');
      this.listen(delegate, 'change', (ev) => {
        const sel = ev.target as HTMLSelectElement;
        const idStr = el.dataset.cardId;
        if (idStr === undefined) return;
        const cardId = BigInt(idStr);
        if (sel.value === '') this.intent('clearDelegateRow', { cardId });
        else this.intent('delegateRow', { cardId, agentUserId: BigInt(sel.value) });
      });
      el.append(delegate);
    }

    // Stretched full-row link — covers the row for ⌘/middle/right-click → new
    // tab. The delegate select lifts above it via z-index (styles.css). href set
    // per fill. A plain click bubbles to the row open handler below.
    const link = rowLink();
    link.dataset.role = 'rowlink';
    el.append(link);

    const open = (): void => this.openRowIndex(Number(el.dataset.index ?? '-1'));
    this.listen(el, 'click', open);
    this.listen(el, 'keydown', (ev) => {
      const k = (ev as KeyboardEvent).key;
      if (k === 'Enter' || k === 'o') {
        ev.preventDefault();
        open();
      }
    });
  }

  protected fillRowCard(el: HTMLElement, card: CardWithAttrs, index: number): void {
    el.dataset.index = String(index);
    el.dataset.cardId = card.id.toString();
    const on = index === this.selectedIndex;
    el.classList.toggle('card-list__row--selected', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
    el.classList.toggle('card-list__row--ordered', typeof card.personal_sort_order === 'number');

    const badge = el.querySelector('[data-role="badge"]') as HTMLElement;
    const badgeAttr = this.ctx.tree.at(['screen', 'phaseAttr']).peek<string>() ?? '';
    const sid = badgeAttr === '' ? null : idKey(card.attributes[badgeAttr]);
    const info = sid !== null ? this.statusInfo.get(sid) : undefined;
    badge.dataset.phase = info?.phase ?? '';
    badge.replaceChildren(
      statusIcon(info ?? ''),
      document.createTextNode(info !== undefined ? info.label : '—'),
    );
    badge.style.display = badgeAttr === '' ? 'none' : '';

    // The row link opens the SAME card the row opens — its parent on the comms
    // screen (openTarget). No target (a parentless comm) → drop the href.
    const target = this.openTargetId(card);
    const link = el.querySelector('[data-role="rowlink"]') as HTMLAnchorElement | null;
    if (link) {
      if (target !== undefined) setRowLinkHref(link, target);
      else link.removeAttribute('href');
    }

    const idEl = el.querySelector('[data-role="id"]') as HTMLElement;
    if (this.config.showId === true) {
      idEl.textContent = `#${card.id.toString()}`;
      idEl.style.display = '';
    } else idEl.style.display = 'none';

    const subject = el.querySelector('[data-role="subject"]') as HTMLElement;
    const flag = el.querySelector('[data-role="flag"]') as HTMLElement;
    setSubjectText(subject, flag, titleOf(card));
    const flagged = this.config.flagAttr !== undefined && card.attributes[this.config.flagAttr] === false;
    if (flagged) {
      flag.textContent = this.config.flagLabel ?? 'Flag';
      flag.style.display = '';
    } else flag.style.display = 'none';

    const cols = el.querySelector('[data-role="cols"]') as HTMLElement;
    const parent = cols.querySelector('[data-role="parent"]') as HTMLElement;
    for (const c of Array.from(cols.querySelectorAll('[data-col]'))) c.remove();
    for (const col of this.config.columns ?? []) {
      const text = this.columnText(card, col);
      if (text === '') continue;
      const chip = document.createElement('span');
      chip.className = 'card-list__col';
      chip.dataset.col = col.attr;
      chip.textContent = text;
      cols.insertBefore(chip, parent);
    }
    if (this.config.parentChipCardType !== undefined && card.parent_card_id !== undefined) {
      const pid = card.parent_card_id.toString();
      const t = this.parentTitles.get(pid);
      parent.textContent = t !== undefined ? `#${pid} · ${t}` : `#${pid}`;
      parent.style.display = '';
    } else parent.style.display = 'none';

    const delegate = el.querySelector('[data-role="delegate"]') as HTMLSelectElement | null;
    if (delegate) this.fillDelegate(delegate, card);
  }

  private columnText(card: CardWithAttrs, col: CardListColumn): string {
    const v = card.attributes[col.attr];
    if (col.kind === 'ref') {
      const id = asAttrId(v);
      if (id === null) return '';
      const map = this.getLookup(col.lookup ?? '');
      return map[id.toString()] ?? `#${id.toString()}`;
    }
    if (v === null || v === undefined || v === '') return '';
    return typeof v === 'bigint' ? v.toString() : String(v);
  }
}

/** Set the subject's text node without clobbering the flag child. */
function setSubjectText(subject: HTMLElement, flag: HTMLElement, text: string): void {
  for (const n of Array.from(subject.childNodes)) if (n.nodeType === Node.TEXT_NODE) n.remove();
  subject.insertBefore(document.createTextNode(text), flag);
}

export function registerCardListBody(): void {
  Control.register('CardListBody', CardListBody);
}
