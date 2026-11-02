/**
 * PageStructure — the PLACE IN SITE section of a page's detail view: where
 * the page sits in its project's page tree, and how it shows in a site's
 * navigation.
 *
 *   - The trail above the page (Home › Guide › this page), each a link.
 *   - "Under": the page's parent. Picking another page (or the top of the
 *     project) moves it there with card.move; the server refuses a move
 *     under the page's own child pages, and the picker doesn't offer them.
 *   - Its child pages in site order, each with ↑ / ↓ to reorder (the
 *     siblings' sort_order is renumbered 10, 20, 30 …), and "+ Child page".
 *   - "Hide from navigation" / "Hide child pages from navigation" (the
 *     page's nav_hidden / nav_hide_children).
 *
 * Every one of these is part of what a portal shows, so like any edit it
 * reaches a site when the page is published again. The detail passes
 * `onChanged` so it can refresh PUBLISHED ON ("Unpublished edits") and the
 * activity feed after a write.
 *
 * It loads the project's pages itself (card.select_with_attributes for
 * card_type page) and re-loads after each write. Zero promises.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { navigate, pageUrl } from '../shell/router.js';
import { SPEC, type SelectWithAttributesOutput } from '../kanban/specs.js';
import { PROJECT_SPEC, type CardInsertOutput } from '../projects/specs.js';
import { CARD_MOVE_SPEC } from '../bundles/specs.js';
import { enclosingProjectId, titlePath } from '../task-detail/detail-profiles.js';
import { newPageInput } from './new-page-button.js';

export interface PageStructureConfig extends BaseControlConfig {
  type: 'PageStructure';
  /** The focal page id (string from the route). */
  pageId?: string;
  /** Called after a write (move, reorder, a navigation flag, a new child). */
  onChanged?: () => void;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    PageStructure: PageStructureConfig;
  }
}

type PageRow = SelectWithAttributesOutput['rows'][number];

/** The parts of one page the section reads. */
export interface PageNode {
  id: bigint;
  parentId: bigint;
  title: string;
  sort: number;
  navHidden: boolean;
  navHideChildren: boolean;
}

export function pageNode(r: PageRow): PageNode {
  const a = r.attributes;
  const sort = Number(a['sort_order'] ?? 0);
  return {
    id: r.id,
    parentId: r.parent_card_id ?? 0n,
    title: typeof a['title'] === 'string' && a['title'] !== '' ? a['title'] : `Page #${r.id.toString()}`,
    sort: Number.isFinite(sort) ? sort : 0,
    navHidden: a['nav_hidden'] === true,
    navHideChildren: a['nav_hide_children'] === true,
  };
}

/** Pages in site order: sort order, then title, then id (as the portal
 *  build orders them). */
export function siteOrder(a: PageNode, b: PageNode): number {
  if (a.sort !== b.sort) return a.sort - b.sort;
  const t = a.title.toLowerCase().localeCompare(b.title.toLowerCase());
  return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The sort_order writes that move `id` one place up (-1) or down (+1)
 * among `siblings` (already in site order): every sibling is renumbered
 * 10, 20, 30 … in the new order, and only the ones whose value changes are
 * returned. Empty at either end.
 */
export function reorderWrites(siblings: readonly PageNode[], id: bigint, dir: -1 | 1): Array<{ id: bigint; sort: number }> {
  const i = siblings.findIndex((s) => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= siblings.length) return [];
  const order = [...siblings];
  [order[i], order[j]] = [order[j]!, order[i]!];
  const out: Array<{ id: bigint; sort: number }> = [];
  order.forEach((s, k) => {
    const sort = (k + 1) * 10;
    if (s.sort !== sort) out.push({ id: s.id, sort });
  });
  return out;
}

/** `id` and every page below it (they can't become its parent). */
export function subtreeIds(id: bigint, nodes: readonly PageNode[]): Set<bigint> {
  const out = new Set<bigint>([id]);
  for (let grew = true, guard = 0; grew && guard < 16; guard++) {
    grew = false;
    for (const n of nodes) {
      if (!out.has(n.id) && out.has(n.parentId)) {
        out.add(n.id);
        grew = true;
      }
    }
  }
  return out;
}

export class PageStructure extends Control<PageStructureConfig> {
  private pageId: bigint | null = null;
  private projectId: bigint | undefined;
  private rows: PageRow[] = [];
  private nodes: PageNode[] = [];
  private loaded = false;
  private busy = false;
  private error = '';

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'page-structure';
    el.dataset.control = 'PageStructure';
    el.dataset.region = 'detail.structure';
    return el;
  }

  protected render(): void {
    this.pageId = parseId(this.config.pageId);
    this.paint();
    this.load();
  }

  /** Public refresh hook. */
  reload(): void {
    this.load();
  }

  private load(): void {
    if (this.pageId === null) return;
    this.ctx.api.callByName(
      SPEC.selectWithAttributes,
      { cardTypeName: 'page' },
      (out) => {
        if (!this.isAlive()) return;
        this.rows = (out as SelectWithAttributesOutput).rows ?? [];
        const byId = new Map(this.rows.map((r) => [r.id, r]));
        const self = this.pageId === null ? undefined : byId.get(this.pageId);
        this.projectId = self === undefined ? undefined : enclosingProjectId(self, byId);
        // This project's pages only.
        this.nodes = this.rows
          .filter((r) => this.projectId !== undefined && enclosingProjectId(r, byId) === this.projectId)
          .map(pageNode);
        this.loaded = true;
        this.busy = false;
        this.paint();
      },
      { alive: () => this.isAlive() },
    );
  }

  private self(): PageNode | undefined {
    return this.nodes.find((n) => n.id === this.pageId);
  }

  private paint(): void {
    const heading = document.createElement('h2');
    heading.className = 'task-detail__section-label muted';
    heading.textContent = 'PLACE IN SITE';
    const self = this.self();
    if (!this.loaded || self === undefined) {
      const msg = document.createElement('p');
      msg.className = 'muted page-structure__empty';
      msg.textContent = this.loaded ? 'This page isn’t in a project.' : 'Loading…';
      this.el.replaceChildren(heading, msg);
      return;
    }
    const parts: HTMLElement[] = [heading, this.renderTrail(self), this.renderParent(self), this.renderChildren(self), this.renderFlags(self)];
    if (this.error !== '') {
      const err = document.createElement('p');
      err.className = 'page-structure__error';
      err.dataset.pageStructureError = '';
      err.textContent = this.error;
      parts.push(err);
    }
    const note = document.createElement('p');
    note.className = 'page-structure__note muted';
    note.textContent = 'These reach a site when the page is published again.';
    parts.push(note);
    this.el.replaceChildren(...parts);
  }

  private renderTrail(self: PageNode): HTMLElement {
    const trail = document.createElement('ol');
    trail.className = 'page-structure__trail';
    trail.dataset.pageTrail = '';
    const chain: PageNode[] = [];
    const byId = new Map(this.nodes.map((n) => [n.id, n]));
    for (let p = byId.get(self.parentId), hops = 0; p !== undefined && hops < 16; p = byId.get(p.parentId), hops++) {
      chain.unshift(p);
    }
    if (chain.length === 0) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'Top level of the project';
      trail.append(li);
    }
    for (const p of chain) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = pageUrl(p.id);
      a.textContent = p.title;
      this.listen(a, 'click', (ev) => {
        const e = ev as MouseEvent;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(pageUrl(p.id));
      });
      li.append(a);
      trail.append(li);
    }
    const me = document.createElement('li');
    me.className = 'page-structure__self';
    me.textContent = self.title;
    trail.append(me);
    return trail;
  }

  /** "Under: [select]" — move the page under another page or the project. */
  private renderParent(self: PageNode): HTMLElement {
    const row = document.createElement('label');
    row.className = 'page-structure__parent';
    const span = document.createElement('span');
    span.className = 'page-structure__label muted';
    span.textContent = 'Under';
    const select = document.createElement('select');
    select.className = 'page-structure__select';
    select.dataset.pageParent = '';
    select.disabled = this.busy;
    const top = document.createElement('option');
    top.value = this.projectId?.toString() ?? '';
    top.textContent = 'Top of the project';
    select.append(top);
    const blocked = subtreeIds(self.id, this.nodes);
    const byId = new Map(this.rows.map((r) => [r.id, r]));
    const options = this.nodes
      .filter((n) => !blocked.has(n.id))
      .map((n) => {
        const row = byId.get(n.id);
        return { id: n.id, label: row === undefined ? n.title : titlePath(row, byId) };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.id.toString();
      opt.textContent = o.label;
      select.append(opt);
    }
    select.value = self.parentId.toString();
    this.listen(select, 'change', () => {
      if (!/^\d+$/.test(select.value)) return;
      const to = BigInt(select.value);
      if (to === self.parentId) return;
      this.write(CARD_MOVE_SPEC, { cardId: self.id, newParentCardId: to }, {
        cycle: 'A page can’t go under one of its own child pages.',
      });
    });
    row.append(span, select);
    return row;
  }

  private renderChildren(self: PageNode): HTMLElement {
    const box = document.createElement('div');
    box.className = 'page-structure__children';
    const head = document.createElement('div');
    head.className = 'page-structure__children-head';
    const label = document.createElement('span');
    label.className = 'page-structure__label muted';
    label.textContent = 'Child pages';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn btn--xs page-structure__add';
    add.dataset.pageChild = '';
    add.textContent = '+ Child page';
    add.title = 'Add a page under this one';
    add.disabled = this.busy;
    this.listen(add, 'click', () => this.addChild(add));
    head.append(label, add);
    box.append(head);

    const kids = this.nodes.filter((n) => n.parentId === self.id).sort(siteOrder);
    if (kids.length === 0) {
      const none = document.createElement('p');
      none.className = 'muted page-structure__none';
      none.textContent = 'None yet.';
      box.append(none);
      return box;
    }
    const list = document.createElement('ol');
    list.className = 'page-structure__list';
    list.dataset.pageChildren = '';
    kids.forEach((k, i) => {
      const li = document.createElement('li');
      li.dataset.pageChildRow = k.id.toString();
      const a = document.createElement('a');
      a.href = pageUrl(k.id);
      a.textContent = k.title;
      this.listen(a, 'click', (ev) => {
        const e = ev as MouseEvent;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(pageUrl(k.id));
      });
      li.append(a);
      if (k.navHidden) {
        const tag = document.createElement('span');
        tag.className = 'page-structure__tag muted';
        tag.textContent = 'hidden from navigation';
        li.append(tag);
      }
      const moves = document.createElement('span');
      moves.className = 'page-structure__moves';
      for (const [dir, glyph, name] of [[-1, '↑', 'up'], [1, '↓', 'down']] as const) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn--xs btn-icon';
        b.textContent = glyph;
        b.dataset.pageMove = name;
        b.title = dir < 0 ? 'Move up' : 'Move down';
        b.setAttribute('aria-label', `Move ${k.title} ${name}`);
        b.disabled = this.busy || (dir < 0 ? i === 0 : i === kids.length - 1);
        this.listen(b, 'click', () => this.reorder(kids, k.id, dir));
        moves.append(b);
      }
      li.append(moves);
      list.append(li);
    });
    box.append(list);
    return box;
  }

  private renderFlags(self: PageNode): HTMLElement {
    const box = document.createElement('div');
    box.className = 'page-structure__flags';
    const flags: Array<[string, string, boolean]> = [
      ['nav_hidden', 'Hide from navigation', self.navHidden],
      ['nav_hide_children', 'Hide child pages from navigation', self.navHideChildren],
    ];
    for (const [attr, text, on] of flags) {
      const label = document.createElement('label');
      label.className = 'page-structure__flag';
      const box2 = document.createElement('input');
      box2.type = 'checkbox';
      box2.checked = on;
      box2.disabled = this.busy;
      box2.dataset.pageFlag = attr;
      this.listen(box2, 'change', () => {
        this.write(SPEC.attributeUpdate, { cardId: self.id, attributeName: attr, value: box2.checked }, {});
      });
      label.append(box2, document.createTextNode(` ${text}`));
      box.append(label);
    }
    const hint = document.createElement('p');
    hint.className = 'muted page-structure__hint';
    hint.textContent = 'A hidden page is still published and reachable by its address and by links.';
    box.append(hint);
    return box;
  }

  private reorder(siblings: readonly PageNode[], id: bigint, dir: -1 | 1): void {
    const writes = reorderWrites(siblings, id, dir);
    if (writes.length === 0) return;
    this.busy = true;
    this.error = '';
    this.paint();
    let left = writes.length;
    let failed = false;
    for (const w of writes) {
      this.ctx.api.callByName(
        SPEC.attributeUpdate,
        { cardId: w.id, attributeName: 'sort_order', value: w.sort },
        () => {
          if (--left === 0) this.afterWrite(failed);
        },
        {
          alive: () => this.isAlive(),
          onErr: () => {
            failed = true;
            if (--left === 0) this.afterWrite(true);
          },
        },
      );
    }
  }

  private write(spec: string, input: Record<string, unknown>, messages: Record<string, string>): void {
    this.busy = true;
    this.error = '';
    this.paint();
    this.ctx.api.callByName(spec, input, () => this.afterWrite(false), {
      alive: () => this.isAlive(),
      onErr: (f) => {
        this.error = f.kind === 'sub_error' ? (messages[f.code] ?? f.message) : 'That didn’t save. Try again.';
        this.afterWrite(true);
      },
    });
  }

  private afterWrite(failed: boolean): void {
    if (!this.isAlive()) return;
    if (failed && this.error === '') this.error = 'Some changes didn’t save. Try again.';
    this.config.onChanged?.();
    this.load();
  }

  /** Create an "Untitled page" under this page and open it. */
  private addChild(btn: HTMLButtonElement): void {
    if (this.pageId === null) return;
    btn.disabled = true;
    this.ctx.api.callByName(
      PROJECT_SPEC.cardInsert,
      newPageInput(this.pageId, 'Untitled page'),
      (out) => {
        btn.disabled = false;
        navigate(pageUrl((out as CardInsertOutput).id));
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          btn.disabled = false;
        },
      },
    );
  }
}

function parseId(raw: string | undefined): bigint | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = BigInt(raw);
  return n > 0n ? n : null;
}

export function registerPageStructure(): void {
  Control.register('PageStructure', PageStructure);
}
