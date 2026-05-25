/**
 * ScreenHost — resolves the active screen and dispatches on its `layout` to a
 * body control via `Control.New`, mirroring `client/src/screens/ScreenHost.svelte`'s
 * switch-on-layout. The indirection is what makes screens data-driven: a screen
 * card's `layout` chooses the body, and an UNKNOWN layout falls through to the
 * NotFound placeholder (never throws) — exactly the graceful-degradation
 * guarantee the framework is built around.
 *
 * SCREEN-CARD RESOLUTION (#29): the host receives a `slug` (and reads the
 * in-scope `projectId` from the tree). It renders the body immediately from the
 * FALLBACK layout (the static slug→layout map — so a cold deep-link / unseeded
 * project paints without a round-trip), then loads the project's `screen` cards
 * and matches by slug. When a real screen card resolves AND carries a different
 * `layout`, the body is re-dispatched to the resolved control. The resolved
 * screen's id + its saved `filter` cards + its `default_filter` all LAND in the
 * tree at a (project, slug) key (`filter/screen-resolve.ts` screenStatePath) so
 * the ScreenFilterBar can drive the preset selector + default-on-first-visit off
 * the same key. An unknown slug with no screen card keeps the fallback body.
 *
 * Layout → control type:
 *   kanban  → Kanban
 *   list    → Inbox     (not built yet → NotFound placeholder, proving the path)
 *   grid    → Grid      (the dense sortable table — registered)
 *   project → Project   (not built yet → NotFound)
 *   <other> → NotFound  (unknown layout, e.g. a typo'd screen card)
 *
 * The ScreenFilterBar mounts above the body (shared across task-list layouts).
 * Cascade-safe: the resolution load is a ZERO-PROMISE `api.call` whose onOk
 * lands tree leaves + (only if the layout changed) re-spawns the body — a
 * one-way write outside any tracked effect.
 */

import { Control, type BaseControlConfig, type ChildConfig } from '../core/control.js';
import {
  loadScreenAndFilters,
  fallbackLayoutForSlug,
  readLayout,
  readGroupByAttr,
  screenStatePath,
  type ScreenPresetSet,
} from '../filter/screen-resolve.js';

/** The screen descriptor (slug-keyed; the layout is the fallback until resolved). */
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
  /**
   * Resolve the real screen card by slug (the #29 backbone). Default true. Set
   * false in unit tests that assert on the static-fallback layout only (they
   * inject no screen-card response). When true the host fires the screen load
   * and re-dispatches the body if the resolved `layout` differs.
   */
  resolveScreen?: boolean;
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
  private bodyHost: HTMLElement | null = null;
  private bodyControl: Control | null = null;
  private currentLayout = '';

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'screen-host';
    el.dataset.control = 'ScreenHost';
    return el;
  }

  protected render(): void {
    const screen = this.config.screen;
    const slug = screen.slug;
    const projectId = this.ctx.tree.at(['scope', 'projectId']).peek<bigint | null>() ?? null;

    // The (project, slug) key everything lands under. The ScreenFilterBar reads
    // the SAME key for the preset selector + the default-on-first-visit cache.
    const statePath = screenStatePath(projectId, slug);

    // Optional shared filter bar (task-list screens share it). Tell it which
    // (project, slug) key its presets live under so it stays in sync with the
    // host's resolution.
    if (this.config.filterBar !== false) {
      const barHost = document.createElement('div');
      barHost.className = 'screen-host__filterbar';
      this.el.append(barHost);
      this.spawn(
        'ScreenFilterBar',
        { type: 'ScreenFilterBar', screenStatePath: statePath } as ChildConfig,
        barHost,
      );
    }

    // Body region; dispatch on the FALLBACK layout first so a cold load paints
    // without waiting on the screen-card round-trip.
    const bodyHost = document.createElement('div');
    bodyHost.className = 'screen-host__body';
    this.el.append(bodyHost);
    this.bodyHost = bodyHost;

    // The fallback layout comes from the descriptor (which the shell seeds from
    // the static slug→layout map). If the descriptor's layout is the generic
    // 'unknown' sentinel, fall back to the slug-derived one so a deep-link to a
    // known slug still renders even before the screen card resolves.
    const seedLayout =
      screen.layout && screen.layout !== 'unknown'
        ? screen.layout
        : fallbackLayoutForSlug(slug);
    this.dispatchBody(seedLayout);

    // Mount any declarative children (e.g. an analytics widget) alongside the
    // body. An UNREGISTERED child type renders the visible NotFound placeholder
    // (graceful degradation) — the kanban screen carries one such child.
    for (const child of this.config.children ?? []) {
      this.spawn(child.type, child, bodyHost);
    }

    // Resolve the REAL screen card (the #29 backbone). Skipped when there is no
    // project in scope (nothing to resolve against) or explicitly disabled.
    if (this.config.resolveScreen !== false && projectId !== null) {
      loadScreenAndFilters(
        this.ctx.api,
        projectId,
        slug,
        (set) => this.onScreenResolved(statePath, set),
        () => this.isAlive(),
      );
    }
  }

  /**
   * Land the resolved screen state + (when the layout changed) re-dispatch the
   * body. One-way: writes tree leaves + DOM, never reads back a watched dep.
   */
  private onScreenResolved(statePath: string[], set: ScreenPresetSet): void {
    if (!this.isAlive()) return;
    const node = this.ctx.tree.at(statePath);

    // Land the saved filters list + the default-filter id keyed by (project,
    // slug). The ScreenFilterBar reads these to populate the preset selector
    // and to apply the default on first visit.
    node.child('filters').set(set.filters);
    node.child('defaultFilterId').set(set.defaultFilter ? set.defaultFilter.id : null);

    if (set.screen === null) {
      // No screen card for this slug → keep the fallback body + announce "no
      // screen" so the bar still renders its default-filter fallback.
      node.child('screenId').set(null);
      node.child('resolved').set(true);
      return;
    }

    node.child('screenId').set(set.screen.id);
    node.child('resolved').set(true);

    // Drive the body off the resolved screen card's `layout`. Re-dispatch only
    // when it actually differs from what we painted (avoids a needless tear-down
    // of a body that already loaded data).
    const layout = readLayout(set.screen);
    if (layout !== null && layout !== this.currentLayout) {
      this.dispatchBody(layout);
    }

    // Carry the screen's group_by_attr default into the GROUP picker leaf when
    // the default filter sets one (the bar's default-on-first-visit reads it).
    if (set.defaultFilter !== null) {
      const groupBy = readGroupByAttr(set.defaultFilter);
      if (groupBy !== null) node.child('defaultGroupBy').set(groupBy);
    }
  }

  /** (Re)build the body control for `layout`, tearing down any previous body. */
  private dispatchBody(layout: string): void {
    if (this.bodyHost === null) return;
    if (this.bodyControl !== null) {
      this.destroyChild(this.bodyControl);
      this.bodyControl = null;
    }
    this.currentLayout = layout;
    this.bodyHost.dataset.layout = layout;

    const bodyType = layoutToControlType(layout);
    // The body config carries the screen's title + any layout-specific config.
    // An unregistered bodyType resolves to a visible NotFound placeholder (the
    // load-bearing graceful-degradation path) — never throws.
    const bodyConfig: ChildConfig = {
      type: bodyType,
      ...(this.config.screen.bodyConfig ?? {}),
    };
    this.bodyControl = this.spawn(bodyType, bodyConfig, this.bodyHost);
  }
}

export function registerScreenHost(): void {
  Control.register('ScreenHost', ScreenHost);
}
