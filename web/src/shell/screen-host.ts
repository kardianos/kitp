/**
 * ScreenHost — resolves the active screen and dispatches on its `layout` to a
 * body control via `Control.New`, mirroring `client/src/screens/ScreenHost.svelte`'s
 * switch-on-layout. The indirection is what makes screens data-driven: a screen
 * card's `layout` chooses the body, and an UNKNOWN layout falls through to the
 * NotFound placeholder (never throws) — exactly the graceful-degradation
 * guarantee the framework is built around.
 *
 * For this slice the screen is configured directly on the ScreenHost config
 * (`screen: { slug, layout }`), but the structure is the same a screen-card
 * lookup will drive later: resolve → read layout → map to a body control type →
 * Control.New(bodyType, bodyConfig). The layout→control map is the single point
 * a new layout registers.
 *
 * Layout → control type:
 *   kanban  → Kanban
 *   list    → Inbox     (not built yet → NotFound placeholder, proving the path)
 *   grid    → Grid      (the dense sortable table — registered)
 *   project → Project   (not built yet → NotFound)
 *   <other> → NotFound  (unknown layout, e.g. a typo'd screen card)
 *
 * The ScreenFilterBar mounts above the body (shared across task-list layouts).
 * No promises, no API calls in this control — it is pure composition.
 */

import { Control, type BaseControlConfig, type ChildConfig } from '../core/control.js';

/** The screen descriptor (today inline; later resolved from a screen card). */
export interface ScreenDescriptor {
  slug: string;
  layout: string;
  /** Title shown in the body header / breadcrumb. */
  title?: string;
  /** Config passed to the resolved body control (axis paths, etc.). */
  bodyConfig?: Record<string, unknown>;
}

export interface ScreenHostConfig extends BaseControlConfig {
  type: 'ScreenHost';
  screen: ScreenDescriptor;
  /** Render the shared ScreenFilterBar above the body. Default true. */
  filterBar?: boolean;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    ScreenHost: ScreenHostConfig;
  }
}

/**
 * The layout→control map. The Svelte ScreenHost hard-codes four cases; here the
 * same four map to control TYPE strings, and `Control.New` resolves them
 * (registered → real control; unregistered → NotFound). `kanban` and `grid`
 * are built; `list` / `project` deliberately resolve to NotFound to prove the
 * data-driven dispatch + graceful degradation.
 */
const LAYOUT_TO_CONTROL: Record<string, string> = {
  kanban: 'Kanban',
  list: 'Inbox',
  grid: 'Grid',
  project: 'Project',
};

/** Resolve a layout string to the body control type. Unknown → '' (→ NotFound). */
export function layoutToControlType(layout: string): string {
  return LAYOUT_TO_CONTROL[layout] ?? `UnknownLayout:${layout}`;
}

export class ScreenHost extends Control<ScreenHostConfig> {
  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'screen-host';
    el.dataset.control = 'ScreenHost';
    return el;
  }

  protected render(): void {
    const screen = this.config.screen;

    // Optional shared filter bar (task-list screens share it).
    if (this.config.filterBar !== false) {
      const barHost = document.createElement('div');
      barHost.className = 'screen-host__filterbar';
      this.el.append(barHost);
      this.spawn('ScreenFilterBar', { type: 'ScreenFilterBar' }, barHost);
    }

    // Body region; dispatch on the screen's layout.
    const bodyHost = document.createElement('div');
    bodyHost.className = 'screen-host__body';
    bodyHost.dataset.layout = screen.layout;
    this.el.append(bodyHost);

    const bodyType = layoutToControlType(screen.layout);
    // The body config carries the screen's title + any layout-specific config.
    // An unregistered bodyType resolves to a visible NotFound placeholder (the
    // load-bearing graceful-degradation path) — never throws.
    const bodyConfig: ChildConfig = {
      type: bodyType,
      ...(screen.bodyConfig ?? {}),
    };
    this.spawn(bodyType, bodyConfig, bodyHost);

    // Mount any declarative children (e.g. an analytics widget) alongside the
    // body. An UNREGISTERED child type renders the visible NotFound placeholder
    // (graceful degradation) — the kanban screen carries one such child.
    for (const child of this.config.children ?? []) {
      this.spawn(child.type, child, bodyHost);
    }
  }
}

export function registerScreenHost(): void {
  Control.register('ScreenHost', ScreenHost);
}
