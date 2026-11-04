/**
 * MyScreens — the account's "My screens" page (/my-screens; user menu →
 * My screens; docs/PERSONAL_SCREENS.md, help topic `my_screens`):
 *
 *   - Your screens: each personal screen with what it lists and which
 *     projects; open it, edit its settings (inline), move it up / down in
 *     the left navigation's Mine, or delete it; **+ New screen**.
 *   - Your views on shared screens: every view you saved with "Save as my
 *     view" on a project's screen — open the screen, rename, delete.
 *
 * Only you see any of it.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { navigate, plainClick, screenUrl } from '../shell/router.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import {
  MY_SCREEN_SPEC,
  myScreenUrl,
  scopeFromPredicate,
  scopeSummary,
  type MyScreen,
} from './specs.js';
import { bumpMyScreens } from './my-screen-settings.js';

export interface MyScreensConfig extends BaseControlConfig {
  type: 'MyScreens';
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    MyScreens: MyScreensConfig;
  }
}

/** One of your views on a shared screen, with where it lives. */
export interface MyView {
  id: string;
  title: string;
  screenId: string;
  screenTitle: string;
  screenSlug: string;
  projectId: string;
  projectTitle: string;
}

/** Your views on shared screens: the private filters whose screen is a
 *  project's (not one of your own screens), named with their screen and
 *  project. */
export function myViewsOnShared(
  filters: readonly CardWithAttrs[],
  screens: readonly CardWithAttrs[],
  projects: ReadonlyMap<string, string>,
): MyView[] {
  const byId = new Map(screens.map((s) => [s.id.toString(), s] as const));
  const out: MyView[] = [];
  for (const f of filters) {
    if (f.private !== true || f.parent_card_id === undefined) continue;
    const s = byId.get(f.parent_card_id.toString());
    if (s === undefined || s.private === true || s.parent_card_id === undefined) continue;
    const projectId = s.parent_card_id.toString();
    out.push({
      id: f.id.toString(),
      title: str(f.attributes['title']),
      screenId: s.id.toString(),
      screenTitle: str(s.attributes['title']),
      screenSlug: str(s.attributes['slug']),
      projectId,
      projectTitle: projects.get(projectId) ?? `#${projectId}`,
    });
  }
  return out.sort((a, b) => a.projectTitle.localeCompare(b.projectTitle) || a.screenTitle.localeCompare(b.screenTitle) || a.title.localeCompare(b.title));
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export class MyScreens extends Control<MyScreensConfig> {
  private screens: MyScreen[] = [];
  private views: MyView[] = [];
  private projectNames = new Map<string, string>();
  private loaded = false;
  private editing: string | null = null;
  private creating = false;
  private screensHost!: HTMLElement;
  private viewsHost!: HTMLElement;
  private forms: Control[] = [];

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'my-screens';
    el.dataset.control = 'MyScreens';
    return el;
  }

  protected render(): void {
    const head = document.createElement('header');
    const h1 = document.createElement('h1');
    h1.className = 'my-screens__title';
    h1.textContent = 'My screens';
    const hint = document.createElement('p');
    hint.className = 'my-screens__hint muted';
    hint.textContent =
      'Screens and views only you see. A personal screen lists tasks or threads across every project you can see — or the ones you pick — and shows in the left navigation under Mine. Narrow it with the filter bar and save that as a view; on any project screen, “Save as my view” keeps a view just for you.';
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'my-screens__link';
    more.textContent = 'Detailed steps';
    this.listen(more, 'click', () => this.ctx.bus?.emit('toggleInstructions', undefined));
    hint.append(document.createTextNode(' '), more);
    head.append(h1, hint);
    this.screensHost = document.createElement('div');
    this.screensHost.className = 'my-screens__section';
    this.screensHost.dataset.myScreensList = '';
    this.viewsHost = document.createElement('div');
    this.viewsHost.className = 'my-screens__section';
    this.viewsHost.dataset.myViewsList = '';
    this.el.replaceChildren(head, this.screensHost, this.viewsHost);
    this.load();
  }

  private load(): void {
    let screens: MyScreen[] | undefined;
    let filters: CardWithAttrs[] | undefined;
    let shared: CardWithAttrs[] | undefined;
    let projects: CardWithAttrs[] | undefined;
    const done = (): void => {
      if (screens === undefined || filters === undefined || shared === undefined || projects === undefined) return;
      this.projectNames = new Map(projects.map((p) => [p.id.toString(), str(p.attributes['title'])] as const));
      this.screens = screens;
      this.views = myViewsOnShared(filters, shared, this.projectNames);
      this.loaded = true;
      this.paint();
    };
    const alive = { alive: () => this.isAlive() };
    this.ctx.api.callByName(MY_SCREEN_SPEC.list, {}, (out) => {
      screens = (out as { screens: MyScreen[] }).screens ?? [];
      done();
    }, alive);
    const rows = (k: (r: CardWithAttrs[]) => void) => (out: unknown) => {
      k(((out as { rows?: CardWithAttrs[] }).rows ?? []) as CardWithAttrs[]);
      done();
    };
    this.ctx.api.callByName('card.select_with_attributes', { cardTypeName: 'filter' }, rows((r) => (filters = r)), alive);
    this.ctx.api.callByName('card.select_with_attributes', { cardTypeName: 'screen' }, rows((r) => (shared = r)), alive);
    this.ctx.api.callByName('card.select_with_attributes', { cardTypeName: 'project' }, rows((r) => (projects = r)), alive);
  }

  private paint(): void {
    for (const f of this.forms) this.destroyChild(f);
    this.forms = [];
    this.paintScreens();
    this.paintViews();
  }

  private paintScreens(): void {
    const host = this.screensHost;
    host.replaceChildren(textEl('h2', 'my-screens__subtitle', 'Your screens'));
    if (!this.loaded) {
      host.append(textEl('p', 'muted', 'Loading…'));
      return;
    }
    if (this.screens.length === 0 && !this.creating) host.append(textEl('p', 'muted', 'None yet.'));
    const ul = document.createElement('ul');
    ul.className = 'my-screens__items';
    this.screens.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = 'my-screens__item';
      li.dataset.myScreen = s.id;
      const link = document.createElement('a');
      link.className = 'my-screens__name';
      link.href = myScreenUrl(s.id);
      link.textContent = s.title;
      this.listen(link, 'click', plainClick(() => navigate(myScreenUrl(s.id))));
      const what = textEl(
        'span',
        'muted',
        `${s.layout === 'grid' ? 'Grid' : 'List'} of ${s.listCardType === 'comm' ? 'threads' : 'tasks'} · ${scopeSummary(scopeFromPredicate(s.predicate), this.projectNames)}${s.viewCount > 0 ? ` · ${s.viewCount} view${s.viewCount === 1 ? '' : 's'}` : ''}`,
      );
      const up = this.iconButton('↑', 'Move up in Mine', i === 0, () => this.move(i, -1));
      up.dataset.myScreenUp = s.id;
      const down = this.iconButton('↓', 'Move down in Mine', i === this.screens.length - 1, () => this.move(i, 1));
      down.dataset.myScreenDown = s.id;
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn';
      edit.dataset.myScreenEdit = s.id;
      edit.textContent = this.editing === s.id ? 'Close' : 'Settings';
      this.listen(edit, 'click', () => {
        this.editing = this.editing === s.id ? null : s.id;
        this.paint();
      });
      li.append(link, what, up, down, edit);
      ul.append(li);
      if (this.editing === s.id) {
        const formHost = document.createElement('li');
        formHost.className = 'my-screens__form';
        ul.append(formHost);
        this.forms.push(
          this.spawn(
            'MyScreenSettings',
            {
              type: 'MyScreenSettings',
              screen: s,
              onSaved: () => {
                this.editing = null;
                this.load();
              },
              onDeleted: () => {
                this.editing = null;
                this.load();
              },
              onCancel: () => {
                this.editing = null;
                this.paint();
              },
            },
            formHost,
          ),
        );
      }
    });
    host.append(ul);
    if (this.creating) {
      const formHost = document.createElement('div');
      formHost.className = 'my-screens__form';
      host.append(formHost);
      this.forms.push(
        this.spawn(
          'MyScreenSettings',
          {
            type: 'MyScreenSettings',
            onSaved: (id: string) => {
              this.creating = false;
              navigate(myScreenUrl(id));
            },
            onCancel: () => {
              this.creating = false;
              this.paint();
            },
          },
          formHost,
        ),
      );
    } else {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'btn';
      add.dataset.myScreenAdd = '';
      add.textContent = '+ New screen';
      this.listen(add, 'click', () => {
        this.creating = true;
        this.paint();
      });
      host.append(add);
    }
  }

  /** Swap a screen with its neighbour in Mine (sort_order). */
  private move(i: number, delta: number): void {
    const j = i + delta;
    const a = this.screens[i];
    const b = this.screens[j];
    if (a === undefined || b === undefined) return;
    // Distinct orders even when two screens share one.
    const ao = a.sortOrder === b.sortOrder ? a.sortOrder + delta : b.sortOrder;
    const bo = a.sortOrder;
    this.screens[i] = { ...b, sortOrder: bo };
    this.screens[j] = { ...a, sortOrder: ao };
    this.paint();
    let pending = 2;
    const after = (): void => {
      pending -= 1;
      if (pending === 0) bumpMyScreens(this.ctx.tree);
    };
    this.ctx.api.callByName(MY_SCREEN_SPEC.set, { id: a.id, sortOrder: ao }, after, { alive: () => this.isAlive(), onErr: () => this.load() });
    this.ctx.api.callByName(MY_SCREEN_SPEC.set, { id: b.id, sortOrder: bo }, after, { alive: () => this.isAlive(), onErr: () => this.load() });
  }

  private paintViews(): void {
    const host = this.viewsHost;
    host.replaceChildren(textEl('h2', 'my-screens__subtitle', 'Your views on project screens'));
    if (!this.loaded) return;
    if (this.views.length === 0) {
      host.append(textEl('p', 'muted', 'None. On any project screen, open View and choose “Save as my view…”.'));
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'my-screens__items';
    for (const v of this.views) {
      const li = document.createElement('li');
      li.className = 'my-screens__item';
      li.dataset.myView = v.id;
      const href = screenUrl(BigInt(v.projectId), v.screenSlug);
      const link = document.createElement('a');
      link.className = 'my-screens__name';
      link.href = href;
      link.textContent = `🔒 ${v.title}`;
      this.listen(link, 'click', plainClick(() => navigate(href)));
      const where = textEl('span', 'muted', `${v.projectTitle} › ${v.screenTitle}`);
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'btn';
      rename.dataset.myViewRename = v.id;
      rename.textContent = 'Rename';
      this.listen(rename, 'click', () => this.renameView(v, li));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn';
      del.dataset.myViewDelete = v.id;
      del.textContent = 'Delete';
      this.listen(del, 'click', () => this.deleteView(v));
      li.append(link, where, rename, del);
      ul.append(li);
    }
    host.append(ul);
  }

  /** Inline rename: the row turns into an input + Save. */
  private renameView(v: MyView, li: HTMLElement): void {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = v.title;
    input.dataset.myViewTitle = v.id;
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary';
    save.textContent = 'Save';
    save.dataset.myViewSave = v.id;
    this.listen(save, 'click', () => {
      const title = input.value.trim();
      if (title === '' || title === v.title) {
        this.paint();
        return;
      }
      this.ctx.api.callByName(
        'attribute.update',
        { cardId: BigInt(v.id), attributeName: 'title', value: title },
        () => {
          if (this.isAlive()) this.load();
        },
        { alive: () => this.isAlive() },
      );
    });
    li.replaceChildren(input, save);
    queueMicrotask(() => input.focus());
  }

  private deleteView(v: MyView): void {
    this.views = this.views.filter((x) => x.id !== v.id);
    this.paintViews();
    this.ctx.api.callByName('card.delete', { cardId: BigInt(v.id) }, () => undefined, {
      alive: () => this.isAlive(),
      onErr: () => this.load(),
    });
  }

  private iconButton(glyph: string, label: string, disabled: boolean, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'my-screens__step';
    b.textContent = glyph;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.disabled = disabled;
    this.listen(b, 'click', fn);
    return b;
  }
}

function textEl(tag: string, cls: string, text: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  e.append(document.createTextNode(text));
  return e;
}

export function registerMyScreens(): void {
  Control.register('MyScreens', MyScreens);
}
