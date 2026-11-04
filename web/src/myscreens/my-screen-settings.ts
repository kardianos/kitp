/**
 * MyScreenSettings — the form for one personal screen
 * (docs/PERSONAL_SCREENS.md), on its own page (⚙ Screen settings) and on My
 * screens: its name, layout (list / grid), what it lists (tasks / threads)
 * and which projects it covers — every project you can see (the default),
 * only some, or all but some. Save writes my_screen.set; Delete (asks once)
 * my_screen.delete. Either bumps `shell.myScreensVersion`, which the left
 * navigation's Mine section watches.
 *
 * Narrow it further with the filter bar and save that as a view (only you
 * see views on your own screen); set one as the screen's default.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import {
  MY_SCREEN_SPEC,
  predicateFromScope,
  scopeFromPredicate,
  type MyScreen,
  type ProjectScope,
} from './specs.js';

export interface MyScreenSettingsConfig extends BaseControlConfig {
  type: 'MyScreenSettings';
  /** The screen to edit; absent = a new one. */
  screen?: MyScreen;
  onSaved?: (id: string) => void;
  onDeleted?: () => void;
  onCancel?: () => void;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    MyScreenSettings: MyScreenSettingsConfig;
  }
}

/** Bump the counter the Mine section reloads on. */
export function bumpMyScreens(tree: { at(path: string[]): { peek<T>(): T | undefined; set(v: unknown): void } }): void {
  const node = tree.at(['shell', 'myScreensVersion']);
  node.set((node.peek<number>() ?? 0) + 1);
}

interface ProjectOption {
  id: string;
  title: string;
}

export class MyScreenSettings extends Control<MyScreenSettingsConfig> {
  private projects: ProjectOption[] | null = null;
  private scope: ProjectScope = { mode: 'all', projects: [] };
  private confirmDelete = false;
  private error = '';
  private title = '';
  private layout = 'list';
  private listCardType = 'task';

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'my-screen-settings';
    el.dataset.control = 'MyScreenSettings';
    return el;
  }

  protected render(): void {
    const s = this.config.screen;
    this.title = s?.title ?? '';
    this.layout = s?.layout ?? 'list';
    this.listCardType = s?.listCardType ?? 'task';
    this.scope = scopeFromPredicate(s?.predicate ?? '');
    this.paint();
    this.ctx.api.callByName(
      'card.select_with_attributes',
      { cardTypeName: 'project', order: [{ field: 'attributes.title', direction: 'ASC' }] },
      (out) => {
        if (!this.isAlive()) return;
        const rows = ((out as { rows?: Array<{ id: unknown; attributes?: Record<string, unknown> }> }).rows ?? []);
        this.projects = rows
          .filter((r) => r.attributes?.['is_template'] !== true)
          .map((r) => ({ id: String(r.id), title: typeof r.attributes?.['title'] === 'string' ? (r.attributes['title'] as string) : `#${String(r.id)}` }));
        this.paint();
      },
      { alive: () => this.isAlive() },
    );
  }

  private paint(): void {
    const form = document.createElement('div');
    form.className = 'my-screen-settings__form';
    const field = (label: string, input: HTMLElement, hint?: string): HTMLElement => {
      const wrap = document.createElement('label');
      wrap.className = 'my-screen-settings__field';
      wrap.append(text('span', 'my-screen-settings__label muted', label), input);
      if (hint !== undefined) wrap.append(text('span', 'my-screen-settings__caption muted', hint));
      return wrap;
    };

    const name = document.createElement('input');
    name.type = 'text';
    name.maxLength = 60;
    name.value = this.title;
    name.dataset.myScreenTitle = '';
    name.placeholder = 'e.g. Stars, still open';
    this.listen(name, 'input', () => (this.title = name.value));

    const layout = select(
      [
        ['list', 'List'],
        ['grid', 'Grid (a table)'],
      ],
      this.layout,
    );
    layout.dataset.myScreenLayout = '';
    this.listen(layout, 'change', () => (this.layout = layout.value));

    const lists = select(
      [
        ['task', 'Tasks'],
        ['comm', 'Threads (conversations)'],
      ],
      this.listCardType,
    );
    lists.dataset.myScreenLists = '';
    this.listen(lists, 'change', () => (this.listCardType = lists.value));

    form.append(
      field('Name', name),
      field('Layout', layout),
      field('Lists', lists),
      this.projectsField(),
    );

    const error = text('p', 'my-screen-settings__error', this.error);
    error.setAttribute('role', 'alert');
    error.hidden = this.error === '';

    const actions = document.createElement('div');
    actions.className = 'my-screen-settings__actions';
    const save = button('Save', 'btn btn-primary', () => this.save());
    save.dataset.myScreenSave = '';
    actions.append(save);
    if (this.config.onCancel !== undefined) actions.append(button('Cancel', 'btn', () => this.config.onCancel?.()));
    if (this.config.screen !== undefined) {
      if (this.confirmDelete) {
        const yes = button('Delete', 'btn btn-danger', () => this.remove());
        yes.dataset.myScreenDeleteConfirm = '';
        actions.append(
          text('span', 'muted', 'Delete this screen and its views? The tasks it lists are untouched.'),
          yes,
          button('Keep', 'btn', () => {
            this.confirmDelete = false;
            this.paint();
          }),
        );
      } else {
        const del = button('Delete screen', 'btn', () => {
          this.confirmDelete = true;
          this.paint();
        });
        del.dataset.myScreenDelete = '';
        actions.append(del);
      }
    }
    this.el.replaceChildren(form, error, actions);
  }

  /** All projects / only these / all but these, and the project list. */
  private projectsField(): HTMLElement {
    const wrap = document.createElement('fieldset');
    wrap.className = 'my-screen-settings__projects';
    wrap.dataset.myScreenProjects = '';
    const legend = text('legend', 'my-screen-settings__label muted', 'Projects');
    wrap.append(legend);
    const modes: Array<[ProjectScope['mode'], string]> = [
      ['all', 'Every project I can see'],
      ['only', 'Only these'],
      ['except', 'All but these'],
    ];
    const radios = document.createElement('div');
    radios.className = 'my-screen-settings__modes';
    for (const [mode, label] of modes) {
      const l = document.createElement('label');
      const r = document.createElement('input');
      r.type = 'radio';
      r.name = `my-screen-scope-${this.config.screen?.id ?? 'new'}`;
      r.value = mode;
      r.checked = this.scope.mode === mode;
      r.dataset.myScreenScope = mode;
      this.listen(r, 'change', () => {
        if (!r.checked) return;
        this.scope = { ...this.scope, mode };
        this.paint();
      });
      l.append(r, document.createTextNode(` ${label}`));
      radios.append(l);
    }
    wrap.append(radios);
    if (this.scope.mode !== 'all') {
      const list = document.createElement('div');
      list.className = 'my-screen-settings__project-list';
      if (this.projects === null) list.append(text('span', 'muted', 'Loading projects…'));
      for (const p of this.projects ?? []) {
        const l = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.myScreenProject = p.id;
        cb.checked = this.scope.projects.includes(p.id);
        this.listen(cb, 'change', () => {
          const set = new Set(this.scope.projects);
          if (cb.checked) set.add(p.id);
          else set.delete(p.id);
          this.scope = { ...this.scope, projects: [...set] };
        });
        l.append(cb, document.createTextNode(` ${p.title}`));
        list.append(l);
      }
      wrap.append(list);
    }
    wrap.append(
      text(
        'span',
        'my-screen-settings__caption muted',
        'New projects are included automatically under “Every project” and “All but these”.',
      ),
    );
    return wrap;
  }

  private save(): void {
    const title = this.title.trim();
    if (title === '') {
      this.error = 'A screen needs a name.';
      this.paint();
      return;
    }
    if (this.scope.mode !== 'all' && this.scope.projects.length === 0) {
      this.error = 'Pick at least one project, or choose “Every project I can see”.';
      this.paint();
      return;
    }
    this.error = '';
    const id = this.config.screen?.id;
    this.ctx.api.callByName(
      MY_SCREEN_SPEC.set,
      {
        ...(id !== undefined ? { id } : {}),
        title,
        layout: this.layout,
        listCardType: this.listCardType,
        predicate: predicateFromScope(this.scope),
      },
      (out) => {
        if (!this.isAlive()) return;
        bumpMyScreens(this.ctx.tree);
        this.config.onSaved?.((out as { id: string }).id);
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          this.error = 'Couldn’t save the screen.';
          this.paint();
        },
      },
    );
  }

  private remove(): void {
    const id = this.config.screen?.id;
    if (id === undefined) return;
    this.ctx.api.callByName(
      MY_SCREEN_SPEC.delete,
      { id },
      () => {
        if (!this.isAlive()) return;
        bumpMyScreens(this.ctx.tree);
        this.config.onDeleted?.();
      },
      { alive: () => this.isAlive() },
    );
  }

}

function text(tag: string, cls: string, t: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  e.append(document.createTextNode(t));
  return e;
}

function select(options: Array<[string, string]>, value: string): HTMLSelectElement {
  const s = document.createElement('select');
  for (const [v, label] of options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    if (v === value) o.selected = true;
    s.append(o);
  }
  s.value = value;
  return s;
}

function button(label: string, cls: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}

export function registerMyScreenSettings(): void {
  Control.register('MyScreenSettings', MyScreenSettings);
}
