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
 * Layout → control type (all four registered as of the migration; an unknown
 * layout is the only path that still falls through to NotFound):
 *   kanban  → Kanban
 *   list    → Inbox
 *   grid    → Grid      (the dense sortable table)
 *   project → Project   (the project detail / overview)
 *   <other> → NotFound  (unknown layout, e.g. a typo'd screen card)
 *
 * The ScreenFilterBar mounts above the body (shared across task-list layouts).
 * Cascade-safe: the resolution load is a ZERO-PROMISE `api.call` whose onOk
 * lands tree leaves + (only if the layout changed) re-spawns the body — a
 * one-way write outside any tracked effect.
 */

import { Control, type BaseControlConfig, type ChildConfig } from '../core/control.js';
import type { HotkeyBinding } from '../core/hotkeys.js';
import { focusScreenSearch } from './screen-filter-bar.js';
import { navigate, screenUrl } from './router.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import {
  loadScreenAndFilters,
  layoutRequiresGroup,
  defaultGroupForLayout,
  viewActionsForLayout,
  readLayout,
  readSlug,
  readGroupByAttr,
  readExtraColumns,
  readTagPrefixColumns,
  readPhaseToggles,
  bodyConfigForLayout,
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
  /**
   * The default-board mode for the bare `/project/:id` route (no slug). Instead
   * of resolving a fixed slug, the host loads the project's `screen` cards,
   * picks the FIRST by `sort_order`, and replace-navigates to it — so the
   * project's default screen is its first screen, not a hard-coded board. Shows
   * a neutral loading body until the redirect (NotFound iff the project has no
   * screens). When set, `screen.slug` is ignored.
   */
  defaultScreen?: boolean;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    ScreenHost: ScreenHostConfig;
  }
}

/**
 * The layout→control map. The Svelte ScreenHost hard-codes four cases; here the
 * same four map to control TYPE strings, and `Control.New` resolves them
 * (registered → real control; unregistered → NotFound). All four bodies are
 * registered; only a layout string with no entry here (a typo'd screen card)
 * resolves to the NotFound placeholder — the graceful-degradation path.
 */
const LAYOUT_TO_CONTROL: Record<string, string> = {
  kanban: 'Kanban',
  list: 'CardListBody',
  grid: 'Grid',
  project: 'Project',
  comms: 'CardListBody',
};

/** Layouts that support the swim-lane (2nd) axis. Only the Kanban splits its
 *  board into lanes, so only it shows the filter bar's LANES picker; the
 *  Grid / Inbox hide it (lanes are meaningless there). */
export function layoutSupportsLanes(layout: string): boolean {
  return layout === 'kanban';
}

/** Resolve a layout string to the body control type. Unknown → '' (→ NotFound). */
export function layoutToControlType(layout: string): string {
  return LAYOUT_TO_CONTROL[layout] ?? `UnknownLayout:${layout}`;
}

export class ScreenHost extends Control<ScreenHostConfig> {
  private bodyHost: HTMLElement | null = null;
  private bodyControl: Control | null = null;
  private currentLayout = '';
  /** The transient "resolving…" placeholder shown instead of flashing NotFound
   *  while a custom slug's screen card loads. Removed once a body dispatches. */
  private loadingEl: HTMLElement | null = null;
  /** The shared filter bar host + control + the layout it was configured for.
   *  The bar's layout-specific config (lanes / required-group / view actions)
   *  is derived from the RESOLVED layout — no slug is privileged — so the bar is
   *  (re)spawned by dispatchBody when the layout it should reflect changes. */
  private barHost: HTMLElement | null = null;
  private barControl: Control | null = null;
  private barLayout: string | null = null;
  /** The card_type the resolved screen's body lists, derived from its flow
   *  (see ScreenPresetSet.cardType). The filter bar scopes its editor / chips /
   *  axes to this so non-applicable attributes are hidden. Undefined until the
   *  screen resolves (and for flow-less screens) → the bar keeps its `task`
   *  default. Set in onScreenResolved BEFORE dispatchBody so spawnFilterBar
   *  reads the resolved value. */
  private bodyCardType: string | undefined;
  /** The (project, slug) preset key, computed in render() and reused by the
   *  filter bar whenever it's (re)spawned. */
  private statePath: string[] = [];

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'screen-host';
    el.dataset.control = 'ScreenHost';
    return el;
  }

  /**
   * "/" focuses the shared filter bar's search input. Declared HERE (the common
   * ancestor of the bar + every body) rather than per-body, so grid / list /
   * kanban / project all get it from one place; a body can still shadow it.
   */
  override hotkeys(): readonly HotkeyBinding[] {
    return [
      { binding: '/', label: 'Focus search', run: () => focusScreenSearch(this.el) },
      ...(this.config.hotkeys ?? []),
    ];
  }

  protected render(): void {
    const screen = this.config.screen;
    const slug = screen.slug;
    const projectId = this.ctx.tree.at(['scope', 'projectId']).peek<bigint | null>() ?? null;

    // Default-board mode (`/project/:id`, no slug): resolve the project's first
    // screen by sort_order and redirect to it — the default screen is the first
    // screen, not a hard-coded board. A neutral loading body shows until then.
    if (this.config.defaultScreen === true) {
      const bodyHost = document.createElement('div');
      bodyHost.className = 'screen-host__body';
      this.el.append(bodyHost);
      this.bodyHost = bodyHost;
      this.renderLoadingBody();
      if (projectId !== null) this.resolveDefaultScreen(projectId);
      return;
    }

    // The (project, slug) key everything lands under. The ScreenFilterBar reads
    // the SAME key for the preset selector + the default-on-first-visit cache.
    const statePath = screenStatePath(projectId, slug);
    this.statePath = statePath;

    // The seed layout is ONLY the descriptor's own layout — NO slug is special.
    // Every screen (inbox / grid / kanban included) is just a screen card, so a
    // descriptor that doesn't already carry a layout seeds 'unknown' and defers
    // to the card's resolved `layout`. The body AND the filter bar's config are
    // both driven off the resolved layout (see dispatchBody) so there's nothing
    // to privilege per slug.
    const seedLayout = screen.layout && screen.layout !== 'unknown' ? screen.layout : 'unknown';

    // The shared filter bar's HOST is created here; the bar itself is spawned by
    // dispatchBody once the layout is known (its lanes / group / view-action
    // config is layout-specific), so it always matches the dispatched body.
    if (this.config.filterBar !== false) {
      const barHost = document.createElement('div');
      barHost.className = 'screen-host__filterbar';
      this.el.append(barHost);
      this.barHost = barHost;
    }

    // Body region.
    const bodyHost = document.createElement('div');
    bodyHost.className = 'screen-host__body';
    this.el.append(bodyHost);
    this.bodyHost = bodyHost;

    // A screen's layout is known only to its card. Rather than flash the red
    // NotFound placeholder for the 'unknown' seed while that card loads, defer to
    // a neutral "resolving…" body; onScreenResolved dispatches the real layout
    // (or redirects to the project's default screen iff this slug has no card).
    const willResolve = this.config.resolveScreen !== false && projectId !== null;
    if (seedLayout === 'unknown' && willResolve) {
      this.renderLoadingBody();
    } else {
      this.dispatchBody(seedLayout);
    }

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
   * Default-board resolution: load the project's `screen` cards, pick the FIRST
   * by `sort_order`, and replace-navigate to its `/screen/<slug>` URL so the
   * default screen is the project's first screen (URL + presets + nav all key
   * off the real slug). No screens → NotFound (the project genuinely has none).
   */
  private resolveDefaultScreen(projectId: bigint): void {
    this.ctx.api.callByName(
      'card.select_with_attributes',
      { cardTypeName: 'screen', parentCardId: projectId, order: [{ field: 'attributes.sort_order', direction: 'ASC' }] },
      (out) => {
        if (!this.isAlive()) return;
        const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
        const ord = (r: CardWithAttrs): number => {
          const v = r.attributes['sort_order'];
          return typeof v === 'number' && Number.isFinite(v) ? v : Number.POSITIVE_INFINITY;
        };
        const first = rows
          .slice()
          .sort((a, b) => ord(a) - ord(b))
          .map((r) => readSlug(r))
          .find((s): s is string => s !== null && s !== '');
        if (first === undefined) {
          // No screens in this project → genuine NotFound (no slug to land on).
          this.dispatchBody('unknown');
          return;
        }
        navigate(screenUrl(projectId, first), { replace: true });
      },
      { alive: () => this.isAlive() },
    );
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

    // Land the active screen's Grid COLUMN config (extra_columns / tag_prefix_
    // columns) at the global `screen.*` leaves the Grid reads (like screen.group).
    // Reset to [] when there's no screen card so a config-less screen clears them.
    this.ctx.tree
      .at(['screen', 'extraColumns'])
      .set(set.screen !== null ? readExtraColumns(set.screen) : []);
    this.ctx.tree
      .at(['screen', 'tagPrefixColumns'])
      .set(set.screen !== null ? readTagPrefixColumns(set.screen) : []);
    // Phase-scope toggles (Active / Closed / …) from the screen's toggle_groups;
    // the ScreenFilterBar renders them + seeds the default-on phases.
    this.ctx.tree
      .at(['screen', 'phaseToggles'])
      .set(set.screen !== null ? readPhaseToggles(set.screen, set.phaseAttr) : []);

    // The card_type the body lists (flow-derived; status→task, comm_status→comm).
    // ONE source of truth landed in the tree: the CardListBody reads it to scope
    // its query AND the ScreenFilterBar reads it to scope its editor/chips/axes,
    // so the body's card_type and the filter's card_type can never disagree (the
    // bug class where the body listed `task` while the bar filtered `comm`).
    // Defaults to 'task' for a flow-less / missing screen.
    this.ctx.tree.at(['screen', 'cardType']).set(set.cardType ?? 'task');
    // The flow's governed attribute (status / comm_status) — the CardListBody
    // shows it as a phase-toned lead badge. Empty when the screen has no flow.
    this.ctx.tree.at(['screen', 'phaseAttr']).set(set.phaseAttr ?? '');

    if (set.screen === null) {
      // No screen card for this slug in the scoped project. Two sub-cases:
      //
      //  (a) A concrete seed layout already painted a body (a caller that
      //      passed its own `screen.layout`) → keep it + announce "no screen"
      //      so the bar still renders its default-filter fallback.
      //
      //  (b) We were DEFERRING on an 'unknown' seed (the common case: a slug
      //      carried across a project switch, or a stale deep-link, that THIS
      //      project doesn't have). Don't flash the red NotFound — redirect to
      //      the project's DEFAULT (first) screen, so switching projects lands
      //      on the same-named screen when it exists and the default when it
      //      doesn't. A genuinely screenless project falls through
      //      resolveDefaultScreen to NotFound there (no slug to land on). The
      //      first screen's slug always has a card, so this can't loop.
      if (this.bodyControl !== null) {
        node.child('screenId').set(null);
        node.child('resolved').set(true);
        return;
      }
      const projectId = this.ctx.tree.at(['scope', 'projectId']).peek<bigint | null>() ?? null;
      if (projectId !== null) this.resolveDefaultScreen(projectId);
      else this.dispatchBody('unknown');
      return;
    }

    node.child('screenId').set(set.screen.id);
    node.child('resolved').set(true);

    // The card_type the body lists (flow-derived) — recorded BEFORE dispatchBody
    // so the (re)spawned filter bar scopes its editor / chips / axes to it.
    this.bodyCardType = set.cardType;

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

  /** A neutral "resolving…" placeholder shown while a custom slug's screen card
   *  loads — avoids flashing the red NotFound for the 'unknown' seed layout. */
  private renderLoadingBody(): void {
    if (this.bodyHost === null) return;
    const el = document.createElement('div');
    el.className = 'screen-host__loading muted';
    el.dataset.screenLoading = '';
    el.textContent = 'Loading…';
    this.bodyHost.append(el);
    this.loadingEl = el;
  }

  /** (Re)spawn the shared filter bar configured for `layout` — its lanes /
   *  required-group / view-action config is layout-specific, so the bar follows
   *  the resolved layout (no slug privileging). No-op when the bar is disabled
   *  or already configured for this layout. */
  private spawnFilterBar(layout: string): void {
    if (this.barHost === null || this.barLayout === layout) return;
    if (this.barControl !== null) {
      this.destroyChild(this.barControl);
      this.barControl = null;
    }
    this.barLayout = layout;
    this.barControl = this.spawn(
      'ScreenFilterBar',
      {
        type: 'ScreenFilterBar',
        screenStatePath: this.statePath,
        // Layout-derived (the layouts themselves are the only built-ins): the
        // Kanban shows the LANES picker + requires a grouping axis; flat layouts
        // hide lanes + default to "No group". view actions (Inbox's Mine-only /
        // Routed-to-me) likewise come from the layout, not the slug.
        enableLanes: layoutSupportsLanes(layout),
        requireGroup: layoutRequiresGroup(layout),
        defaultGroup: defaultGroupForLayout(layout),
        viewActions: viewActionsForLayout(layout),
        // Scope the filter editor / quick-chips / group axes to the card_type
        // the resolved screen's body lists (flow-derived; see bodyCardType), so
        // non-applicable attributes are hidden — the Comms screen lists `comm`,
        // every task layout lists `task`. Undefined (no flow) → the bar's `task`
        // default. No hardcoded card_type per layout.
        ...(this.bodyCardType !== undefined ? { predicateCardType: this.bodyCardType } : {}),
      } as ChildConfig,
      this.barHost,
    );
  }

  /** (Re)build the body control for `layout`, tearing down any previous body.
   *  Also (re)spawns the filter bar + publishes `screen.layout` (the resolved
   *  layout the help overlay keys its `layout.<layout>` topic off). */
  private dispatchBody(layout: string): void {
    if (this.bodyHost === null) return;
    if (this.loadingEl !== null) {
      this.loadingEl.remove?.();
      this.loadingEl = null;
    }
    if (this.bodyControl !== null) {
      this.destroyChild(this.bodyControl);
      this.bodyControl = null;
    }
    this.currentLayout = layout;
    this.bodyHost.dataset.layout = layout;
    // Publish the resolved layout so the help overlay can resolve its topic from
    // the SCREEN'S layout (works for custom screens too — no slug map needed).
    this.ctx.tree.at(['screen', 'layout']).set(layout);
    this.spawnFilterBar(layout);

    const bodyType = layoutToControlType(layout);
    // The body config carries the screen's title + any layout-specific config.
    // An unregistered bodyType resolves to a visible NotFound placeholder (the
    // load-bearing graceful-degradation path) — never throws.
    const bodyConfig: ChildConfig = {
      type: bodyType,
      // Layout-derived presentation preset (compact comm list, etc.), then any
      // explicit per-descriptor bodyConfig overrides on top.
      ...bodyConfigForLayout(layout),
      ...(this.config.screen.bodyConfig ?? {}),
    };
    this.bodyControl = this.spawn(bodyType, bodyConfig, this.bodyHost);
  }
}

export function registerScreenHost(): void {
  Control.register('ScreenHost', ScreenHost);
}
