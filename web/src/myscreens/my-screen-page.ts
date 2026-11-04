/**
 * MyScreenPage — a personal screen at /my/:id (docs/PERSONAL_SCREENS.md):
 * its name, ⚙ Screen settings (MyScreenSettings, inline), and the screen
 * itself — the shared ScreenHost in personal mode, so the filter bar, saved
 * views and the list / grid work as on any screen, over every project you
 * can see (or the ones it names). There's no "+ New": a personal screen
 * has no project to put a card in.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { navigate, plainClick } from '../shell/router.js';
import { MY_SCREEN_SPEC, MY_SCREENS_PATH, type MyScreen } from './specs.js';

export interface MyScreenPageConfig extends BaseControlConfig {
  type: 'MyScreenPage';
  /** The personal screen's card id (the route's :id). */
  screenId: string;
  /** Open with the settings showing (a just-made screen). */
  openSettings?: boolean;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    MyScreenPage: MyScreenPageConfig;
  }
}

export class MyScreenPage extends Control<MyScreenPageConfig> {
  private screen: MyScreen | null = null;
  private loaded = false;
  private settingsOpen = false;
  private headEl!: HTMLElement;
  private settingsHost!: HTMLElement;
  private screenHost!: HTMLElement;
  private settings: Control | null = null;
  private host: Control | null = null;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'my-screen-page';
    el.dataset.control = 'MyScreenPage';
    return el;
  }

  protected render(): void {
    this.settingsOpen = this.config.openSettings === true;
    this.headEl = document.createElement('header');
    this.headEl.className = 'my-screen-page__head';
    this.settingsHost = document.createElement('div');
    this.settingsHost.className = 'my-screen-page__settings';
    this.screenHost = document.createElement('div');
    this.screenHost.className = 'my-screen-page__screen';
    this.el.replaceChildren(this.headEl, this.settingsHost, this.screenHost);
    this.load(true);
  }

  private load(mountScreen: boolean): void {
    this.ctx.api.callByName(
      MY_SCREEN_SPEC.list,
      {},
      (out) => {
        if (!this.isAlive()) return;
        const screens = (out as { screens: MyScreen[] }).screens ?? [];
        const prev = this.screen;
        this.screen = screens.find((s) => s.id === this.config.screenId) ?? null;
        this.loaded = true;
        this.paintHead();
        this.paintSettings();
        // A layout or list change re-mounts the screen; the rest doesn't.
        const changed =
          prev !== null &&
          this.screen !== null &&
          (prev.layout !== this.screen.layout ||
            prev.listCardType !== this.screen.listCardType ||
            prev.predicate !== this.screen.predicate);
        if (mountScreen || changed) this.mountScreen();
      },
      { alive: () => this.isAlive() },
    );
  }

  private paintHead(): void {
    this.headEl.replaceChildren();
    const h1 = document.createElement('h1');
    h1.className = 'my-screen-page__title';
    if (!this.loaded) {
      h1.textContent = 'Loading…';
      this.headEl.append(h1);
      return;
    }
    if (this.screen === null) {
      h1.textContent = 'Screen not found';
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'This personal screen isn’t yours, or it was deleted.';
      this.headEl.append(h1, p);
      return;
    }
    h1.textContent = this.screen.title;
    const mine = document.createElement('span');
    mine.className = 'my-screen-page__badge muted';
    mine.textContent = 'Only you see this screen';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn';
    toggle.dataset.myScreenSettingsToggle = '';
    toggle.setAttribute('aria-expanded', this.settingsOpen ? 'true' : 'false');
    toggle.textContent = '⚙ Screen settings';
    this.listen(toggle, 'click', () => {
      this.settingsOpen = !this.settingsOpen;
      this.paintHead();
      this.paintSettings();
    });
    const all = document.createElement('a');
    all.className = 'my-screen-page__link';
    all.href = MY_SCREENS_PATH;
    all.textContent = 'All my screens';
    this.listen(all, 'click', plainClick(() => navigate(MY_SCREENS_PATH)));
    this.headEl.append(h1, mine, toggle, all);
  }

  private paintSettings(): void {
    if (this.settings !== null) {
      this.destroyChild(this.settings);
      this.settings = null;
    }
    this.settingsHost.replaceChildren();
    if (!this.settingsOpen || this.screen === null) return;
    this.settings = this.spawn(
      'MyScreenSettings',
      {
        type: 'MyScreenSettings',
        screen: this.screen,
        onSaved: () => {
          this.settingsOpen = false;
          this.load(false);
        },
        onDeleted: () => navigate(MY_SCREENS_PATH),
        onCancel: () => {
          this.settingsOpen = false;
          this.paintHead();
          this.paintSettings();
        },
      },
      this.settingsHost,
    );
  }

  private mountScreen(): void {
    if (this.host !== null) {
      this.destroyChild(this.host);
      this.host = null;
    }
    this.screenHost.replaceChildren();
    if (this.screen === null) return;
    this.host = this.spawn(
      'ScreenHost',
      {
        type: 'ScreenHost',
        screen: { slug: `my-${this.screen.id}`, layout: this.screen.layout, title: this.screen.title },
        personalScreenId: this.screen.id,
      },
      this.screenHost,
    );
  }
}

export function registerMyScreenPage(): void {
  Control.register('MyScreenPage', MyScreenPage);
}
