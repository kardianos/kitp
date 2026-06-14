/**
 * ScreenFilterBar — the shared header for task-list screens (Inbox, Grid,
 * Kanban, Project detail). It composes:
 *
 *   - row 1: the NAMED/SAVED filter picker (FilterPresetSelector) + its action
 *     strip (Save / Set default / Rename / Delete). Picking a preset applies its
 *     stored `predicate` (→ the `screen.predicate` leaf the Advanced editor +
 *     the Grid/Kanban task query already consume) + its `group_by_attr` (→
 *     `screen.group`). Save writes a new `filter` card (optimistic). The bar
 *     reads its preset list + active-filter id from the (project, slug) key the
 *     ScreenHost lands them under (`config.screenStatePath`).
 *   - row 2 (the v1 working subset):
 *       - GROUP-by Picker (default 'milestone' — the current kanban axis).
 *       - Search Field (writes 'screen.search' to the tree as you type).
 *       - Advanced toggle → an expandable panel hosting a structured
 *         {@link PredicateFilter} over the `task` card_type. The editor writes its
 *         {@link Predicate} tree to 'screen.predicate'; Grid + Kanban read that
 *         leaf and AND it into the task query.
 *       - Clear button (resets search + group + the predicate to defaults).
 *   - row 3: the QUICK-CHIPS row — a pinned set of per-attribute dropdowns
 *     (Status / Assignee / Milestone / Component / Tags). Each chip toggles a
 *     TOP-LEVEL `attr in [...]` leaf in the SAME 'screen.predicate' tree the
 *     Advanced editor + named filters edit, so the three surfaces stay
 *     consistent (one tree, many surfaces). Picking on a chip routes through the
 *     same {@link ScreenFilterBar.applyPredicate} the presets use — it writes
 *     the predicate AND re-seeds the Advanced editor; the chips themselves read
 *     'screen.predicate' reactively so any other surface's edit repaints them.
 *
 * DEFAULT-FILTER-ON-FIRST-VISIT: when the screen resolves (the ScreenHost lands
 * `<statePath>.resolved`), an effect applies the screen's `default_filter`'s
 * predicate the FIRST time this (project, slug) is visited (no `activeFilterId`
 * cached). With no default the predicate starts EMPTY (all phases visible) — what
 * a screen hides by default is owned by its phase toggles' `default_on` flags,
 * not a hardcoded "not terminal" leaf. The active filter is CACHED at
 * `<statePath>.activeFilterId` so back-nav restores the exact preset.
 *
 * OPTIONS for the PredicateFilter's card_ref pickers project from the Grid's
 * `grid.lookups.<name>` maps into `screen.predicateOptions` (re-keyed by target
 * card_type), same as before.
 *
 * Cascade-safe: every leaf write here is one-way (the bar never reads back into
 * the same effect that wrote it); the API writes (save / set-default / rename /
 * delete) go through the ZERO-PROMISE `api.call` surface from a click handler,
 * outside any tracked effect.
 */

import { Control, type BaseControlConfig, type ChildConfig } from '../core/control.js';
import type { PredicateFilterConfig } from '../filter/predicate-filter.js';
import type { QuickChipsConfig } from '../filter/quick-chips.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import { optimistic } from '../core/tree.js';
import {
  type Predicate,
  type Phase,
  toWire,
  topLevelPhases,
  withTopLevelPhases,
} from '../filter/predicate.js';
import {
  readPredicate,
  readGroupByAttr,
  readSortBy,
  readTitle,
  type PhaseToggle,
} from '../filter/screen-resolve.js';
import { refAxesForCardType, type RefAxis, type CardTypeRow } from '../filter/vocabulary.js';
import { schemaForCardType } from '../filter/attribute-schema.js';
import { loadView, saveView } from '../filter/view-persistence.js';
import { groupAxisForAttr, type GroupAttr } from '../filter/group-axis.js';
import { icon } from '../ui/icons.js';
import { exclusiveRoots, tagPrefixOptionValue, tagRootLabel } from '../filter/tag-prefix.js';
import type { AttributeDefRow } from '../admin/specs.js';

export interface ScreenFilterBarConfig extends BaseControlConfig {
  type: 'ScreenFilterBar';
  /** GROUP-by options shown in the Picker. */
  groupOptions?: Array<{ value: string; label: string }>;
  /** Default GROUP-by value. Default 'milestone'. */
  defaultGroup?: string;
  /**
   * card_type the Advanced PredicateFilter filters. Default 'task'. The editor
   * sources its attribute schema from `attribute_def.select` for this type.
   */
  predicateCardType?: string;
  /**
   * The (project, slug) tree key the ScreenHost lands the resolved screen state
   * under (screenId / filters / defaultFilterId / activeFilterId / resolved).
   * The bar reads the preset list + active id and writes the active id here.
   * Absent → the bar runs in stand-alone mode (no preset selector / default),
   * which is what the existing predicate-only tests exercise.
   */
  screenStatePath?: string[];
  /**
   * Show the LANE (swim-lane 2nd axis) picker. Only the Kanban consumes
   * `screen.laneAxis`, so the host enables this for the kanban layout and leaves
   * it OFF (default) for the Grid / Inbox — where lanes are meaningless and the
   * picker would just be dead UI. When false the picker isn't built at all and
   * `screen.laneGroup`/`laneAxis` stay empty.
   */
  enableLanes?: boolean;
  /**
   * Require a grouping axis (a board layout — the Kanban — has columns, so it
   * can't be "ungrouped"). When true the GROUP picker drops its "No group"
   * option and never resolves to empty: an empty selection is coerced to
   * `defaultGroup`. The host sets this for the kanban layout, paired with a
   * non-empty `defaultGroup`, so the picker shows the board's real grouping (no
   * more "No group" while the board silently groups by milestone).
   */
  requireGroup?: boolean;
  /**
   * Screen-specific view actions mounted pulled-RIGHT on the "View" row (row 1),
   * after the preset selector + its ⋯ menu. The host registers per-screen
   * controls here — e.g. the Grid screen registers its "Columns" chooser, since
   * column selection is a view concern. Data-driven: the bar mounts whatever
   * ChildConfigs the host supplies; it hard-codes nothing.
   */
  viewActions?: ChildConfig[];
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    ScreenFilterBar: ScreenFilterBarConfig;
  }
}

/**
 * The "off" entry pinned first in the GROUP picker. Empty value →
 * `groupAxisForAttr('')` returns null → no grouping (Grid renders a flat list;
 * Kanban falls back to its default milestone axis). Every other option is
 * data-driven from the card_type's card_ref attributes (see {@link loadVocabulary}).
 */
const NO_GROUP_OPTION = { value: '', label: 'No group' } as const;
/** The "off" entry pinned first in the LANE picker (swim lanes 2nd axis). */
const NO_LANE_OPTION = { value: '', label: 'No lanes' } as const;

/** One ref-picker / chip option (stringified card id → display label). */
interface RefOption {
  value: string;
  label: string;
}

/**
 * Display label for a ref-target card: `title` ?? `name` ?? `path` ?? `#id`.
 * Covers status/milestone/component (title), person (title), tag (path), and
 * any future value type, mirroring the Svelte `buildRefOptions` rule.
 */
function refLabel(card: CardWithAttrs): string {
  const a = card.attributes;
  const t = a['title'] ?? a['name'] ?? a['path'];
  return typeof t === 'string' && t.length > 0 ? t : `#${String(card.id)}`;
}

export class ScreenFilterBar extends Control<ScreenFilterBarConfig> {
  /** The live Advanced PredicateFilter child + its mount host, so Clear /
   *  preset-apply can re-seed the editor by re-spawning it against the
   *  (updated) predicate leaf — the editor peeks the leaf once at mount. */
  private predicateChild: Control | null = null;
  private predicateHost: HTMLElement | null = null;
  private predicateConfig: PredicateFilterConfig | null = null;

  private groupEl: HTMLSelectElement | null = null;
  /** The LANE picker (swim lanes — a 2nd group axis); empty = no lanes. */
  private laneEl: HTMLSelectElement | null = null;
  /** Hosts for the custom (menu-styled) GROUP/LANE option lists in the Display
   *  menu. The native selects above stay (hidden) as the value/change source;
   *  these lists mirror them with the same look as the "+ Filter" menu. */
  private groupListHost: HTMLElement | null = null;
  private laneListHost: HTMLElement | null = null;
  /** True once the persisted view has been restored — gates the persist effect
   *  so it never writes the transient pre-restore seed over a saved view. */
  private viewRestored = false;
  private searchEl: HTMLInputElement | null = null;
  // Default group is "No group" unless the screen config / a saved filter's
  // group_by_attr sets one; the group value is now the attribute NAME (e.g.
  // 'milestone_ref'), not a hardcoded friendly token.
  private defaultGroup = '';

  /** Host for the QuickChips control, (re)spawned once the axes resolve. */
  private chipsHostEl: HTMLElement | null = null;
  private chipsControl: Control | null = null;
  private predicateCardType = 'task';

  /** The resolved schema axes (last applied) + the exclusive tag roots derived
   *  once the `tag` option cards land. Held so the group/lane `<select>`s can be
   *  rebuilt when the (async) tag roots arrive after the initial axis derive. */
  private axes: RefAxis[] = [];
  private tagRoots: string[] = [];

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'filterbar';
    el.dataset.control = 'ScreenFilterBar';
    return el;
  }

  protected render(): void {
    this.defaultGroup = this.config.defaultGroup ?? '';
    this.predicateCardType = this.config.predicateCardType ?? 'task';

    // Seed tree defaults (one-way; the Object.is gate makes re-seeding a no-op).
    this.ctx.tree.at(['screen', 'group']).set(this.defaultGroup);
    this.ctx.tree.at(['screen', 'laneGroup']).set('');
    this.ctx.tree.at(['screen', 'search']).set('');

    // The search box now always matches title, description and comments — the
    // per-field "In:" dropdown is gone. Seed the leaf before the data layer wires
    // so the first query (and every consumer) reads the full field set.
    this.ctx.tree.at(['screen', 'searchFields']).set(['title', 'description', 'comments']);

    // Host for the QuickChips control (the "+ Filter" entry + its active chips),
    // (re)spawned by applyAxes once the schema resolves. It rides inline on the
    // bar between Display and the search box.
    const chipsHost = document.createElement('div');
    chipsHost.className = 'filterbar__chips-inline';
    this.chipsHostEl = chipsHost;

    /* ---- the bar is ONE row now: the saved-view picker, Phase, Display, the
           "+ Filter" entry + active chips, the search box (flex-grows), then
           Advanced / Clear and any screen view actions pulled to the right. ---- */
    const bar = document.createElement('div');
    bar.className = 'filterbar__row filterbar__row--presets';
    this.el.append(bar);

    // Saved-view picker (VIEW + "Default …" combo + ⋯ menu), when wired to a screen.
    if (this.config.screenStatePath !== undefined) {
      const dotted = this.config.screenStatePath.join('.');
      this.spawn(
        'FilterPresetSelector',
        {
          type: 'FilterPresetSelector',
          filtersPath: `${dotted}.filters`,
          activeIdPath: `${dotted}.activeFilterId`,
          onPick: (id: bigint | null) => this.applyPreset(id),
          onSave: () => this.saveCurrentAsNew(),
          onSetDefault: () => this.setActiveAsDefault(),
          onRename: () => this.renameActive(),
          onDelete: () => this.deleteActive(),
        } as ChildConfig,
        bar,
      );
    }

    // Phase-scope dropdown (#31): phase checkboxes; self-hides when the screen
    // defines no phase toggles. Edits the `status has_phase` scope.
    this.buildPhaseDropdown(bar);

    /* ---- GROUP + LANE pickers (tucked behind the "Display" menu), the search
           box, and Advanced / Clear — all appended onto the single bar below. ---- */

    // GROUP-by Picker (native <select> — the Picker common control lands later).
    const groupWrap = document.createElement('label');
    groupWrap.className = 'filterbar__group';
    const groupLabel = document.createElement('span');
    groupLabel.className = 'filterbar__label muted';
    groupLabel.textContent = 'GROUP';
    const group = document.createElement('select');
    group.className = 'filterbar__select';
    group.dataset.filterGroup = '';
    this.groupEl = group;
    // Seed the options now (No group + any static config override); the
    // data-driven axes replace these once the schema loads (applyAxes).
    this.rebuildGroupSelect(this.config.groupOptions ?? []);
    groupWrap.append(groupLabel, group);

    // LANE-by Picker (swim lanes — a 2nd axis the Kanban splits rows on). Same
    // data-driven axes as GROUP; empty = no lanes. Only the Kanban consumes it,
    // so it's built ONLY when the host enables it (config.enableLanes) — the
    // Grid / Inbox hide it entirely (laneGroup/laneAxis stay empty).
    let laneWrap: HTMLElement | null = null;
    if (this.config.enableLanes === true) {
      laneWrap = document.createElement('label');
      laneWrap.className = 'filterbar__group filterbar__lane';
      const laneLabel = document.createElement('span');
      laneLabel.className = 'filterbar__label muted';
      laneLabel.textContent = 'LANES';
      const lane = document.createElement('select');
      lane.className = 'filterbar__select';
      lane.dataset.filterLane = '';
      this.laneEl = lane;
      this.rebuildLaneSelect([]);
      laneWrap.append(laneLabel, lane);
    }

    // "Display" menu — tuck the GROUP + LANE pickers behind a compact trigger so
    // they don't clutter the bar (Linear-style). The selects are built above
    // (this.groupEl / this.laneEl) and mounted into this popover's panel.
    const displayWrap = document.createElement('div');
    displayWrap.className = 'filterbar__display-wrap';
    const displayBtn = document.createElement('button');
    displayBtn.type = 'button';
    displayBtn.className = 'btn filterbar__iconbtn filterbar__display';
    displayBtn.dataset.filterDisplay = '';
    displayBtn.setAttribute('aria-haspopup', 'menu');
    displayBtn.setAttribute('aria-expanded', 'false');
    displayBtn.setAttribute('aria-label', 'Display');
    displayBtn.title = 'Display';
    displayBtn.append(icon('sliders-horizontal', 16));
    displayWrap.append(displayBtn);

    // An inline dropdown (not a detached popover) so the GROUP/LANE selects stay
    // in the bar's DOM — restore/persist + tests reach them whether open or not.
    const displayMenu = document.createElement('div');
    displayMenu.className = 'filterbar__display-menu';
    displayMenu.dataset.filterDisplayMenu = '';
    displayMenu.style.display = 'none';
    // Keep the native selects in the DOM (value/change/restore plumbing) but
    // hidden; render visible menu-styled option lists that mirror + drive them
    // so the Display menu matches the "+ Filter" menu's look.
    groupWrap.style.display = 'none';
    const groupListHost = document.createElement('div');
    this.groupListHost = groupListHost;
    displayMenu.append(groupWrap, groupListHost);
    if (laneWrap !== null) {
      laneWrap.style.display = 'none';
      const laneListHost = document.createElement('div');
      this.laneListHost = laneListHost;
      displayMenu.append(laneWrap, laneListHost);
    }
    displayWrap.append(displayMenu);

    const setDisplayOpen = (open: boolean): void => {
      if (open) this.renderDisplayLists(); // fresh from the selects' current state
      displayMenu.style.display = open ? '' : 'none';
      displayBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    this.listen(displayBtn, 'click', (e) => {
      e.stopPropagation();
      setDisplayOpen(displayMenu.style.display === 'none');
    });
    // Dismiss on outside pointer / Escape, like the other menus.
    this.listen(document, 'pointerdown', (e) => {
      if (displayMenu.style.display !== 'none' && !displayWrap.contains(e.target as Node)) {
        setDisplayOpen(false);
      }
    });
    this.listen(document, 'keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape' && displayMenu.style.display !== 'none') {
        setDisplayOpen(false);
      }
    });

    // Display sits left of the "+ Filter" entry + active chips.
    /* ---- the QUICK-CHIPS surface (pinned per-attribute one-tap filters) ----
       Each chip toggles a top-level `attr in [...]` leaf in 'screen.predicate'
       via applyPredicate — the SAME write the preset/Advanced surfaces use, so
       the Advanced editor re-seeds on a chip pick and the chips re-read the
       shared predicate reactively. Saved/"Named" filters (predicate snippets)
       are folded into the "+ Filter" menu; QuickChips itself is (re)spawned by
       applyAxes once the data-driven axes resolve. */
    bar.append(displayWrap, chipsHost);

    // Search — a magnifier icon that expands into the input on click (or "/"),
    // collapsing back when the field is emptied + blurred. The wrap flex-grows
    // so the expanded field fills the middle and Advanced/Clear stay right. The
    // search always matches title/description/comments (see the seed above).
    const searchWrap = document.createElement('div');
    searchWrap.className = 'filterbar__search-wrap';
    searchWrap.dataset.searchWrap = '';
    const searchToggle = document.createElement('button');
    searchToggle.type = 'button';
    searchToggle.className = 'btn filterbar__iconbtn filterbar__search-toggle';
    searchToggle.dataset.searchToggle = '';
    searchToggle.setAttribute('aria-label', 'Search');
    searchToggle.title = 'Search';
    searchToggle.append(icon('search', 16));
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'filterbar__search';
    search.placeholder = 'Search or #ID…';
    search.dataset.filterSearch = '';
    this.searchEl = search;
    searchWrap.append(searchToggle, search);
    bar.append(searchWrap);

    const setSearchExpanded = (open: boolean): void => {
      searchWrap.classList.toggle('filterbar__search-wrap--expanded', open);
      searchToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    this.listen(searchToggle, 'click', () => {
      setSearchExpanded(true);
      search.focus();
    });
    // Focus expands (so "/" → focusScreenSearch reveals the field); blur collapses
    // only when empty, so an active query stays visible.
    this.listen(search, 'focus', () => setSearchExpanded(true));
    this.listen(search, 'blur', () => {
      if ((search.value ?? '') === '') setSearchExpanded(false);
    });
    // Keep expansion in sync with the shared search leaf — a restored / preset /
    // cleared query expands or collapses the field even when focus never moved.
    this.effect(() => {
      const q = this.ctx.tree.at(['screen', 'search']).get<string>() ?? '';
      if (q !== '') setSearchExpanded(true);
      else if (typeof document === 'undefined' || document.activeElement !== search) {
        setSearchExpanded(false);
      }
    }, 'filterbar.searchExpand');

    // Advanced toggle (expands the structured PredicateFilter) + Clear, pushed
    // to the right edge by the flex-grow search.
    const advanced = document.createElement('button');
    advanced.type = 'button';
    advanced.className = 'btn filterbar__iconbtn filterbar__advanced';
    advanced.dataset.filterAdvanced = '';
    advanced.setAttribute('aria-expanded', 'false');
    advanced.setAttribute('aria-label', 'Advanced filters');
    advanced.title = 'Advanced filters';
    advanced.append(icon('list-tree', 16));

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'btn filterbar__iconbtn filterbar__clear';
    clear.setAttribute('aria-label', 'Clear filters');
    clear.title = 'Clear filters';
    clear.append(icon('paintbrush', 16));
    bar.append(advanced, clear);

    // Screen-specific view actions (e.g. Grid → Columns / "+ New"), far right.
    const viewActions = this.config.viewActions ?? [];
    if (viewActions.length > 0) {
      const actions = document.createElement('div');
      actions.className = 'filterbar__view-actions';
      actions.dataset.filterbarViewActions = '';
      bar.append(actions);
      for (const action of viewActions) this.spawn(action.type, action, actions);
    }

    /* ---- the Advanced panel: a structured PredicateFilter over the task type ---- */
    const panel = document.createElement('div');
    panel.className = 'filterbar__panel';
    panel.dataset.filterPanel = '';
    panel.style.display = 'none';
    this.el.append(panel);

    this.predicateHost = panel;
    this.predicateConfig = {
      type: 'PredicateFilter',
      valuePath: 'screen.predicate',
      schema: { cardType: this.predicateCardType },
      optionsPath: 'screen.predicateOptions',
      // The Advanced panel doubles as the view builder: add a "Sort by" editor
      // (the grid consumes `screen.sort` as the default order). GROUP stays the
      // dedicated row-2 picker, so it's not duplicated here.
      sortPath: 'screen.sort',
    };
    this.predicateChild = this.spawn('PredicateFilter', this.predicateConfig, panel);

    // DATA-DRIVEN VOCABULARY. Load the card_type's attribute schema + each
    // ref-target's option cards, then derive the group picker options + quick
    // chips + the predicate ref-picker options — all from the server, on EVERY
    // screen (the old grid.lookups projection only populated on the Grid). Re-
    // runs on a project switch so project-scoped value cards reload. One-way:
    // reads scope.projectId, writes schema/options/axes leaves it never reads back.
    this.effect(() => {
      this.ctx.tree.at(['scope', 'projectId']).get();
      this.loadVocabulary();
    }, 'filterbar.vocab');

    // Derive `screen.groupAxis` ({attr, lookup} | null) from the active group
    // attr name + the resolved axis map. The Grid/Kanban read this resolved
    // value instead of the retired hardcoded switch. One-way derive.
    this.effect(() => {
      const groupAttr = this.ctx.tree.at(['screen', 'group']).get<string>() ?? '';
      const byAttr =
        this.ctx.tree.at(['screen', 'groupAxesByAttr']).get<Record<string, GroupAttr>>() ?? {};
      const axis = groupAttr === '' ? null : (byAttr[groupAttr] ?? null);
      this.ctx.tree.at(['screen', 'groupAxis']).set(axis);
    }, 'filterbar.groupAxis');

    // Same derive for the LANE axis (swim lanes) → `screen.laneAxis`.
    this.effect(() => {
      const laneAttr = this.ctx.tree.at(['screen', 'laneGroup']).get<string>() ?? '';
      const byAttr =
        this.ctx.tree.at(['screen', 'groupAxesByAttr']).get<Record<string, GroupAttr>>() ?? {};
      const axis = laneAttr === '' ? null : (byAttr[laneAttr] ?? null);
      this.ctx.tree.at(['screen', 'laneAxis']).set(axis);
    }, 'filterbar.laneAxis');

    // Restore the saved (project, slug) view BEFORE the default-filter + phase
    // seed effects run. Critical for nav-back: when `resolved` is already true,
    // those effects fire on creation, so the restore must precede them — else it
    // overwrites the seeded phase (and the seed peeks, so it won't re-apply).
    this.restoreView();

    // DEFAULT-FILTER-ON-FIRST-VISIT. When the screen resolves, apply the
    // default's predicate the first time this (project, slug) is visited; with
    // no default start from an EMPTY predicate (phase toggles' default_on own
    // what's hidden). Reads only the `resolved`
    // flag + peeks the (already-landed) state; writes the predicate/group leaves
    // + the active-id cache. One-way (never reads back a dep it writes).
    if (this.config.screenStatePath !== undefined) {
      const statePath = this.config.screenStatePath;
      this.effect(() => {
        const resolved = this.ctx.tree.at([...statePath, 'resolved']).get<boolean>() ?? false;
        if (!resolved) return;
        this.applyDefaultOnFirstVisit(statePath);
      }, 'filterbar.defaultFilter');
      // Phase is SESSION-ONLY. Derive it from the in-session value (the user's
      // choice this session) or the screen's base phase. This SUBSCRIBES to the
      // phase toggles so it re-derives when they land — a deferred / empty first
      // resolution must not lock in "all". The session node is written only by
      // user actions (toggle / Clear), so re-deriving never clobbers a choice.
      this.effect(() => {
        const resolved = this.ctx.tree.at([...statePath, 'resolved']).get<boolean>() ?? false;
        const toggles = (this.ctx.tree.at(['screen', 'phaseToggles']).get<PhaseToggle[]>() ?? []) as PhaseToggle[];
        if (!resolved) return;
        const session = this.phaseSessionNode(statePath).peek<Phase[] | undefined>();
        // No toggles + no in-session choice → the screen has no phase concept.
        if (toggles.length === 0 && session === undefined) return;
        const phases = session ?? this.basePhases();
        const cur = this.ctx.tree.at(['screen', 'predicate']).peek<Predicate | null>() ?? null;
        this.applyPredicate(withTopLevelPhases(cur, phases, phaseAttrOf(toggles)));
      }, 'filterbar.seedPhase');
    }

    /* ---- interactions: bar writes tree state one-way ---- */
    this.listen(group, 'change', () => {
      this.ctx.tree.at(['screen', 'group']).set(group.value);
    });
    if (this.laneEl !== null) {
      const lane = this.laneEl;
      this.listen(lane, 'change', () => {
        this.ctx.tree.at(['screen', 'laneGroup']).set(lane.value);
      });
    }
    this.listen(search, 'input', () => {
      this.ctx.tree.at(['screen', 'search']).set(search.value);
      const sp = this.config.screenStatePath;
      if (sp !== undefined) this.searchSessionNode(sp).set(search.value);
    });
    // ArrowDown from the search box hands keyboard focus to the screen body so
    // the user can keep arrowing / j-k into the rows. Bump a tree nonce the body
    // watches (decoupled — the bar doesn't reach into the body's DOM).
    this.listen(search, 'keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'ArrowDown') return;
      e.preventDefault();
      const node = this.ctx.tree.at(['screen', 'enterBodyNonce']);
      node.set((node.peek<number>() ?? 0) + 1);
    });
    this.listen(advanced, 'click', () => {
      const open = panel.style.display === 'none';
      panel.style.display = open ? '' : 'none';
      advanced.setAttribute('aria-expanded', open ? 'true' : 'false');
      advanced.classList.toggle('filterbar__advanced--open', open);
    });
    this.listen(clear, 'click', () => this.clearAll());

    // VIEW PERSISTENCE (#27): persist on any change to the view leaves. The
    // restore itself happens earlier (before the default-filter + phase-seed
    // effects) — see restoreView() near the top of render.
    this.effect(() => {
      const predicate = this.ctx.tree.at(['screen', 'predicate']).get<Predicate | null>() ?? null;
      const group = this.ctx.tree.at(['screen', 'group']).get<string>() ?? '';
      const laneGroup = this.ctx.tree.at(['screen', 'laneGroup']).get<string>() ?? '';
      const columnConfig = this.ctx.tree.at(['screen', 'columnConfig']).get<unknown>();
      if (!this.viewRestored) return; // don't persist the transient pre-restore seed
      const sp = this.config.screenStatePath;
      if (sp === undefined) return;
      // Persist the SELECTED preset too (peek — selection always rides a
      // predicate change), so a reload re-selects it in the View picker instead
      // of falling back to a blank "Default". null = explicit Default / ad-hoc.
      const activeId = this.ctx.tree.at([...sp, 'activeFilterId']).peek<bigint | null>() ?? null;
      saveView(sp, {
        // Phase scope is SESSION-ONLY — strip it so a reload starts at the
        // screen's base phase rather than restoring a stale phase selection.
        predicate: withTopLevelPhases(predicate, [], this.phaseAttr()),
        group,
        laneGroup,
        columnConfig,
        activeFilterId: activeId === null ? null : activeId.toString(),
      });
    }, 'filterbar.persistView');
  }

  /** Restore the persisted (project, slug) view into the screen.* leaves. */
  private restoreView(): void {
    const sp = this.config.screenStatePath;
    if (sp === undefined) {
      this.viewRestored = true;
      return;
    }
    // Restore the in-session search text (list → detail → back keeps what the
    // user typed). Empty when never set this session; the cold-reload path keeps
    // the existing transient-search posture.
    const sessionSearch = this.searchSessionNode(sp).peek<string>() ?? '';
    if (sessionSearch !== '') {
      this.ctx.tree.at(['screen', 'search']).set(sessionSearch);
      if (this.searchEl !== null) this.searchEl.value = sessionSearch;
    }
    const v = loadView(sp);
    if (v !== null) {
      if (v.group !== undefined) {
        // setGroup coerces an empty restored group to the default under
        // requireGroup (old saved views may carry '' from before the board
        // required a group), keeping the picker + board in sync.
        this.setGroup(v.group);
      }
      if (v.laneGroup !== undefined) {
        this.ctx.tree.at(['screen', 'laneGroup']).set(v.laneGroup);
        if (this.laneEl !== null) this.laneEl.value = v.laneGroup;
      }
      if (v.columnConfig !== undefined) this.ctx.tree.at(['screen', 'columnConfig']).set(v.columnConfig);
      if (v.predicate !== undefined) {
        // Strip any persisted phase leaf (session-only); the per-mount phase
        // seed re-applies the base / in-session phase on top.
        this.ctx.tree.at(['screen', 'predicate']).set(withTopLevelPhases(v.predicate as Predicate | null, [], this.phaseAttr()));
        this.respawnPredicate();
      }
      // Restore the selected preset so the View picker re-selects it (the
      // default view included). Setting it ALSO marks the (project, slug)
      // visited, so default-on-first-visit doesn't re-apply over the restore.
      // A legacy view with no persisted selection leaves activeFilterId UNSET,
      // so the screen's default_filter still applies + selects on resolve.
      if ('activeFilterId' in v) {
        const raw = v.activeFilterId;
        // Regex-guarded, so BigInt() never throws; any other shape → null (Default).
        const id = typeof raw === 'string' && /^\d+$/.test(raw) ? BigInt(raw) : null;
        this.ctx.tree.at([...sp, 'activeFilterId']).set(id);
      }
    }
    this.viewRestored = true;
  }

  /* --------------------------- data-driven vocabulary ----------------------- */

  /**
   * Load the card_type's attribute schema (`attribute_def.select`) + card_type
   * registry (`card_type.select`), derive the group/chip axes (filter/
   * vocabulary.ts), apply them to the UI, and load each axis's option cards.
   * Both lead queries fire the same tick → one batch; the join derives once both
   * land. Re-invoked by the `filterbar.vocab` effect on a project switch.
   */
  private loadVocabulary(): void {
    const cardType = this.predicateCardType;
    let defs: AttributeDefRow[] | null = null;
    let types: CardTypeRow[] | null = null;
    const derive = (): void => {
      if (defs === null || types === null || !this.isAlive()) return;
      // Publish the full attribute schema so the Grid can type its data-driven
      // `extra_columns` (date vs text/number rendering) off the same load.
      this.ctx.tree.at(['screen', 'attrSchema']).set(schemaForCardType(defs, cardType));
      const axes = refAxesForCardType(defs, types, cardType);
      this.applyAxes(axes);
      this.loadAxisOptions(axes, types);
    };
    this.ctx.api.callByName(
      'attribute_def.select',
      {},
      (out) => {
        if (!this.isAlive()) return;
        defs = ((out as { rows?: AttributeDefRow[] }).rows ?? []) as AttributeDefRow[];
        derive();
      },
      { alive: () => this.isAlive() },
    );
    this.ctx.api.callByName(
      'card_type.select',
      {},
      (out) => {
        if (!this.isAlive()) return;
        types = ((out as { rows?: CardTypeRow[] }).rows ?? []) as CardTypeRow[];
        derive();
      },
      { alive: () => this.isAlive() },
    );
  }

  /**
   * Apply the resolved axes: publish the attr→{attr,lookup} map (for the
   * `screen.groupAxis` derive), rebuild the group `<select>` options, and
   * (re)spawn QuickChips with the derived chip set.
   */
  private applyAxes(axes: RefAxis[]): void {
    this.axes = axes;
    // Publish the full axis list so other surfaces (the Grid's bulk-action bar,
    // synthetic ref columns) data-drive off the SAME schema without re-loading.
    // This keeps every axis (incl. multi-ref `tags`) — it's the GROUP/LANE
    // pickers that narrow to single-valued axes + exclusive tag prefixes.
    this.ctx.tree.at(['screen', 'refAxes']).set(axes);
    this.applyGroupOptions();
    this.spawnChips(axes);
  }

  /**
   * (Re)build the GROUP + LANE pickers' options + the `screen.groupAxesByAttr`
   * resolver from the current schema axes ({@link axes}) and the discovered
   * exclusive tag roots ({@link tagRoots}).
   *
   * Two deliberate narrowings vs. the raw axis set:
   *   - MULTI-valued ref axes (card_ref[], e.g. raw `tags`) are NOT groupable —
   *     a card with several tags would scatter across columns. They're dropped.
   *   - Each mutually-exclusive tag ROOT (e.g. 'priority') is offered instead as
   *     a synthetic `tagpfx:<root>` option resolving to a tag-prefix GroupAttr.
   *     Non-exclusive prefixes ('platform' / 'area') are never offered.
   *
   * Re-invoked when the async `tag` option cards land (so the prefix options
   * appear once their roots are known).
   */
  private applyGroupOptions(): void {
    const byAttr: Record<string, GroupAttr> = {};
    const opts: { value: string; label: string }[] = [];
    for (const a of this.axes) {
      if (a.multi) continue; // raw card_ref[] axes aren't groupable
      const ga = groupAxisForAttr(a.attr, a.targetCardType);
      if (ga !== null) {
        byAttr[a.attr] = ga;
        opts.push({ value: a.attr, label: a.label });
      }
    }
    for (const root of this.tagRoots) {
      const value = tagPrefixOptionValue(root);
      byAttr[value] = { attr: 'tags', lookup: 'tags', tagPrefix: root };
      opts.push({ value, label: tagRootLabel(root) });
    }
    this.ctx.tree.at(['screen', 'groupAxesByAttr']).set(byAttr);
    this.rebuildGroupSelect(opts);
    this.rebuildLaneSelect(opts);
  }

  /** Rebuild the group `<select>` as `No group` + the given axis options,
   *  preserving the active selection. A board layout (requireGroup) drops the
   *  "No group" option and falls back to the default axis instead of empty. */
  private rebuildGroupSelect(options: ReadonlyArray<{ value: string; label: string }>): void {
    const requireGroup = this.config.requireGroup === true;
    this.rebuildAxisSelect(
      this.groupEl,
      ['screen', 'group'],
      requireGroup ? null : NO_GROUP_OPTION,
      options,
      requireGroup ? this.defaultGroup : '',
    );
  }

  /** Rebuild the LANE picker (swim lanes — a 2nd axis); empty value = no lanes. */
  private rebuildLaneSelect(options: ReadonlyArray<{ value: string; label: string }>): void {
    this.rebuildAxisSelect(this.laneEl, ['screen', 'laneGroup'], NO_LANE_OPTION, options);
  }

  /** Shared: rebuild an axis `<select>`. With a `noneOption` it's pinned first
   *  (the "none" entry); pass null to omit it (a required axis). Preserves the
   *  active selection, falling back to `fallback` when it isn't among the
   *  options. */
  private rebuildAxisSelect(
    sel: HTMLSelectElement | null,
    leafPath: string[],
    noneOption: { value: string; label: string } | null,
    options: ReadonlyArray<{ value: string; label: string }>,
    fallback = '',
  ): void {
    if (sel === null) return;
    const current = this.ctx.tree.at(leafPath).peek<string>() ?? '';
    sel.replaceChildren();
    const all = noneOption !== null ? [noneOption, ...options] : [...options];
    for (const o of all) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.append(opt);
    }
    sel.value = current;
    if (sel.value !== current) sel.value = fallback;
  }

  /** Rebuild the Display menu's GROUP/LANE option lists from the (hidden) native
   *  selects, styled like the "+ Filter" menu. Called each time the menu opens
   *  so it reflects the selects' current options + value. */
  private renderDisplayLists(): void {
    this.renderAxisList(this.groupListHost, this.groupEl, 'Group by');
    this.renderAxisList(this.laneListHost, this.laneEl, 'Lanes');
  }

  /** One labelled radio list mirroring a native <select>; a pick sets the
   *  select's value + dispatches `change` (so all existing wiring runs). */
  private renderAxisList(
    host: HTMLElement | null,
    sel: HTMLSelectElement | null,
    title: string,
  ): void {
    if (host === null || sel === null) return;
    host.replaceChildren();
    const header = document.createElement('div');
    header.className = 'filterbar__display-section';
    header.textContent = title;
    const list = document.createElement('ul');
    list.className = 'filterbar__chip-list';
    list.setAttribute('role', 'menu');
    for (const opt of Array.from(sel.options)) {
      const checked = opt.value === sel.value;
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'filterbar__chip-option';
      btn.setAttribute('role', 'menuitemradio');
      btn.setAttribute('aria-checked', checked ? 'true' : 'false');
      if (checked) btn.classList.add('filterbar__chip-option--checked');
      const box = document.createElement('span');
      box.className = 'filterbar__chip-check';
      box.setAttribute('aria-hidden', 'true');
      box.textContent = checked ? '✓' : '';
      const text = document.createElement('span');
      text.className = 'filterbar__chip-option-label';
      text.textContent = opt.textContent ?? opt.value;
      btn.append(box, text);
      const value = opt.value;
      this.listen(btn, 'click', () => {
        if (sel.value !== value) {
          sel.value = value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        this.renderDisplayLists(); // refresh the checkmarks
      });
      li.append(btn);
      list.append(li);
    }
    host.append(header, list);
  }

  /** (Re)spawn QuickChips with chip defs derived from the axes (one chip per
   *  card_ref attr; optionKey = its target card_type). */
  private spawnChips(axes: RefAxis[]): void {
    if (this.chipsHostEl === null) return;
    if (this.chipsControl !== null) {
      this.destroyChild(this.chipsControl);
      this.chipsControl = null;
    }
    const chips = axes.map((a) => ({ attr: a.attr, label: a.label, optionKey: a.targetCardType }));
    this.chipsControl = this.spawn(
      'QuickChips',
      {
        type: 'QuickChips',
        chips,
        predicatePath: 'screen.predicate',
        optionsPath: 'screen.predicateOptions',
        snippetsPath: 'screen.snippets',
        projectIdPath: 'scope.projectId',
        onCommit: (next: Predicate | null) => this.applyPredicate(next),
      } as QuickChipsConfig,
      this.chipsHostEl,
    );
  }

  /**
   * Load each axis target's option cards into `screen.predicateOptions[target]`
   * (the map the chips + Advanced ref pickers read). Project-scoped value types
   * (parent_card_type_id === the project type) query under scope.projectId;
   * global types (person) query unscoped. One card.select per distinct target.
   */
  private loadAxisOptions(axes: RefAxis[], types: CardTypeRow[]): void {
    const projectType = types.find((t) => t.name === 'project');
    const projectId = this.ctx.tree.at(['scope', 'projectId']).peek<bigint | null>() ?? null;
    const seen = new Set<string>();
    for (const axis of axes) {
      const target = axis.targetCardType;
      if (seen.has(target)) continue;
      seen.add(target);
      const trow = types.find((t) => t.name === target);
      const projectScoped =
        projectType !== undefined && trow !== undefined && trow.parent_card_type_id === projectType.id;
      const data: Record<string, unknown> = { cardTypeName: target };
      if (projectScoped && projectId !== null) data['parentCardId'] = projectId;
      this.ctx.api.callByName(
        'card.select_with_attributes',
        data,
        (out) => {
          if (!this.isAlive()) return;
          const rows = ((out as { rows?: CardWithAttrs[] }).rows ?? []) as CardWithAttrs[];
          const opts: RefOption[] = rows.map((r) => ({ value: String(r.id), label: refLabel(r) }));
          const node = this.ctx.tree.at(['screen', 'predicateOptions']);
          const cur = (node.peek<Record<string, RefOption[]>>() ?? {}) as Record<string, RefOption[]>;
          node.set({ ...cur, [target]: opts });
          // Tags: derive the mutually-exclusive roots (the `root_exclusive_at`
          // segments) and, if they changed, rebuild the GROUP/LANE pickers so
          // each becomes a "group by <prefix>" option. Publishing the id→root
          // map lets the Grid bucket rows by prefix without re-querying.
          if (target === 'tag') {
            const rootById: Record<string, string> = {};
            for (const r of rows) {
              const re = r.attributes['root_exclusive_at'];
              if (typeof re === 'string' && re.length > 0) rootById[r.id.toString()] = re;
            }
            this.ctx.tree.at(['screen', 'tagRootById']).set(rootById);
            const roots = exclusiveRoots(rows.map((r) => ({ rootExclusiveAt: rootById[r.id.toString()] ?? '' })));
            if (roots.join(' ') !== this.tagRoots.join(' ')) {
              this.tagRoots = roots;
              this.applyGroupOptions();
            }
          }
        },
        { alive: () => this.isAlive() },
      );
    }
  }

  /* --------------------------- preset application --------------------------- */

  /**
   * Apply a saved preset (or clear back to no-filter when id is null). Reads the
   * filter card from the landed list, writes its predicate to `screen.predicate`
   * + its group to `screen.group`, re-seeds the Advanced editor, and caches the
   * active id at `<statePath>.activeFilterId` (so back-nav restores it). A
   * one-way set of leaf writes from a click handler — cascade-safe.
   */
  private applyPreset(id: bigint | null): void {
    const statePath = this.config.screenStatePath;
    if (statePath === undefined) return;
    // Cache the active id first so the default-on-first-visit effect treats this
    // (project, slug) as visited.
    this.ctx.tree.at([...statePath, 'activeFilterId']).set(id);

    if (id === null) {
      this.applyPredicate(null);
      this.setGroup(this.defaultGroup);
      this.ctx.tree.at(['screen', 'sort']).set(null);
      return;
    }
    const filters = this.ctx.tree.at([...statePath, 'filters']).peek<CardWithAttrs[]>() ?? [];
    const card = filters.find((f) => f.id === id) ?? null;
    if (card === null) {
      this.applyPredicate(null);
      return;
    }
    this.applyPredicate(readPredicate(card));
    // `group_by_attr` already IS the attribute name (the group-picker value), so
    // it applies directly — no friendly-token translation.
    this.setGroup(readGroupByAttr(card) ?? this.defaultGroup);
    // Apply the view's persisted sort (the grid consumes `screen.sort`).
    const sort = readSortBy(card);
    this.ctx.tree.at(['screen', 'sort']).set(sort.length > 0 ? sort : null);
  }

  /**
   * First-visit default application. No-op once the (project, slug) cache has an
   * `activeFilterId` (back-nav restored a prior selection). Applies the screen's
   * `default_filter` preset when present; otherwise an EMPTY predicate (the phase
   * toggles' `default_on` flags then seed what's hidden). Marks the cache visited
   * so it runs exactly once per first visit.
   */
  private applyDefaultOnFirstVisit(statePath: string[]): void {
    const activeNode = this.ctx.tree.at([...statePath, 'activeFilterId']);
    // `undefined` = never visited; `null` = visited with "Default" (no preset).
    if (activeNode.peek<bigint | null>() !== undefined) return;
    this.applyScreenDefaults(statePath);
  }

  /**
   * Apply the screen's DEFAULT VIEW: the `default_filter` preset (else an empty
   * predicate). Shared by the first-visit seed and the Clear button. Phase is
   * NOT touched here — it's session-only and owned by the `filterbar.seedPhase`
   * effect and {@link resetPhaseToBase}.
   */
  private applyScreenDefaults(statePath: string[]): void {
    const activeNode = this.ctx.tree.at([...statePath, 'activeFilterId']);
    const defaultId = this.ctx.tree.at([...statePath, 'defaultFilterId']).peek<bigint | null>() ?? null;
    if (defaultId !== null) {
      this.applyPreset(defaultId); // marks visited + sets predicate/group/sort
    } else {
      activeNode.set(null); // mark visited
      this.applyPredicate(null);
    }
  }

  /** The screen's BASE phase set (toggles' `default_on`); [] = all phases (no
   *  scope leaf). A screen with no phase toggles has no base phase. */
  private basePhases(): Phase[] {
    const toggles = (this.ctx.tree.at(['screen', 'phaseToggles']).peek<PhaseToggle[]>() ?? []) as PhaseToggle[];
    if (toggles.length === 0) return [];
    const all = toggles.map((t) => t.phase);
    const on = toggles.filter((t) => t.defaultOn).map((t) => t.phase);
    return on.length >= all.length ? [] : on;
  }

  /** The card_ref attribute the active screen's phase toggles scope (`status`
   *  for task screens, `comm_status` for the Comms screen). Drives which
   *  `has_phase` leaf the seed/restore/reset compose + strip. */
  private phaseAttr(): string {
    return phaseAttrOf(this.ctx.tree.at(['screen', 'phaseToggles']).peek<PhaseToggle[]>() ?? []);
  }

  /** The IN-MEMORY (session-only) phase node for a screen. It survives in-session
   *  navigation (task → back keeps the toggle) but is gone on reload, so phase
   *  resets to base each session. Keyed like the persisted view (project, slug). */
  private phaseSessionNode(statePath: string[]) {
    return this.ctx.tree.at(['session', 'phase', ...statePath.slice(1)]);
  }

  /** The IN-MEMORY (session-only) search text node for a screen. Mirrors the
   *  phase pattern: a list → detail → back round trip restores what the user
   *  typed, but a cold reload starts empty (search is transient across reloads
   *  by design — only retained within a session). Keyed by (project, slug). */
  private searchSessionNode(statePath: string[]) {
    return this.ctx.tree.at(['session', 'search', ...statePath.slice(1)]);
  }

  /** Reset phase to the screen's base (the Clear button) + record it as the
   *  in-session value so it sticks for the rest of the session. */
  private resetPhaseToBase(statePath: string[]): void {
    const phases = this.basePhases();
    const cur = this.ctx.tree.at(['screen', 'predicate']).peek<Predicate | null>() ?? null;
    this.applyPredicate(withTopLevelPhases(cur, phases, this.phaseAttr()));
    this.phaseSessionNode(statePath).set(phases);
  }

  /* ----------------------------- phase dropdown ---------------------------- */

  /**
   * Build the phase-scope DROPDOWN (#31) on the View line: a trigger button +
   * a panel of one checkbox per phase. Shown only when the screen defines phase
   * toggles; the checked set reflects the `status has_phase` scope (defaulting
   * to the base phase the screen seeded). A child-panel dropdown (not a body-
   * mounted popover) so it stays in the bar's DOM + works under the test shim.
   */
  private buildPhaseDropdown(row: HTMLElement): void {
    const wrap = document.createElement('div');
    wrap.className = 'filterbar__phase';
    wrap.dataset.phaseToggles = ''; // the (project, slug) phase-scope control
    wrap.style.display = 'none'; // until toggles land

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'btn filterbar__phase-trigger';
    trigger.dataset.phaseDropdown = '';
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.textContent = 'Phase';

    const panel = document.createElement('div');
    panel.className = 'filterbar__phase-menu';
    panel.dataset.phaseMenu = '';
    panel.style.display = 'none';

    wrap.append(trigger, panel);
    row.append(wrap);

    const setOpen = (open: boolean): void => {
      panel.style.display = open ? '' : 'none';
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    this.listen(trigger, 'click', (ev) => {
      (ev as Event).stopPropagation();
      setOpen(panel.style.display === 'none');
    });
    // Keep the menu open while ticking boxes; close on an outside click (best-
    // effort — the shim may not bubble, which is fine: tests drive directly).
    this.listen(panel, 'click', (ev) => (ev as Event).stopPropagation());
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      this.listen(document, 'click', () => setOpen(false));
    }

    this.effect(() => {
      const toggles = (this.ctx.tree.at(['screen', 'phaseToggles']).get<PhaseToggle[]>() ?? []) as PhaseToggle[];
      const scoped = topLevelPhases(
        this.ctx.tree.at(['screen', 'predicate']).get<Predicate | null>() ?? null,
        phaseAttrOf(toggles),
      );
      this.paintPhaseDropdown(wrap, trigger, panel, toggles, new Set<Phase>(scoped));
    }, 'filterbar.phaseToggles');
  }

  /** (Re)render the phase dropdown's trigger label + checkbox panel. `active` is
   *  the set of phases the `status has_phase` leaf scopes to; EMPTY = no leaf →
   *  every phase visible, so every box reads checked. */
  private paintPhaseDropdown(
    wrap: HTMLElement,
    trigger: HTMLElement,
    panel: HTMLElement,
    toggles: readonly PhaseToggle[],
    active: Set<Phase>,
  ): void {
    if (toggles.length === 0) {
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = '';
    // Trigger summary: the on-phase labels, or "All" when nothing is scoped out.
    const onLabels = toggles.filter((t) => active.size === 0 || active.has(t.phase)).map((t) => t.label);
    const summary = onLabels.length === toggles.length ? 'All' : onLabels.join(', ') || 'None';
    trigger.textContent = `Phase: ${summary}`;

    panel.replaceChildren();
    for (const t of toggles) {
      const on = active.size === 0 ? true : active.has(t.phase);
      const option = document.createElement('label');
      option.className = 'filterbar__phase-option';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'filterbar__phase-check';
      cb.dataset.phaseToggle = t.phase;
      cb.checked = on;
      const text = document.createElement('span');
      text.textContent = t.label;
      option.append(cb, text);
      this.listen(cb, 'change', () => this.togglePhase(t.phase));
      panel.append(option);
    }
  }

  /** Toggle one phase in the `status has_phase` scope. Showing-all (no leaf) +
   *  a click HIDES that phase (restricts to the rest); otherwise the phase is
   *  added/removed. A result covering every phase collapses to no leaf (show
   *  all), which the chips never touch. Routes through applyPredicate so the
   *  Advanced editor + the toggles repaint. */
  private togglePhase(phase: Phase): void {
    const toggles = (this.ctx.tree.at(['screen', 'phaseToggles']).peek<PhaseToggle[]>() ?? []) as PhaseToggle[];
    const attr = phaseAttrOf(toggles);
    const all = toggles.map((t) => t.phase);
    const cur = this.ctx.tree.at(['screen', 'predicate']).peek<Predicate | null>() ?? null;
    const curPhases = topLevelPhases(cur, attr);

    let next: Set<Phase>;
    if (curPhases.length === 0) {
      // Showing every phase → clicking hides the clicked one.
      next = new Set(all.filter((p) => p !== phase));
    } else {
      next = new Set(curPhases);
      if (next.has(phase)) next.delete(phase);
      else next.add(phase);
    }
    // Covering all phases (or none) ⇒ no restriction ⇒ drop the leaf.
    const phases = next.size >= all.length ? [] : all.filter((p) => next.has(p));
    this.applyPredicate(withTopLevelPhases(cur, phases, attr));
    // Remember the user's phase choice for THIS session only (in-memory).
    const sp = this.config.screenStatePath;
    if (sp !== undefined) this.phaseSessionNode(sp).set(phases);
  }

  /** Write a predicate to `screen.predicate` + re-seed the Advanced editor. */
  private applyPredicate(predicate: Predicate | null): void {
    this.ctx.tree.at(['screen', 'predicate']).set(predicate);
    this.respawnPredicate();
  }

  /** Set the GROUP picker value + leaf (keeps the <select> in sync on apply).
   *  A board layout (requireGroup) never goes to "No group": an empty value is
   *  coerced to the configured default so the picker + board stay in sync. */
  private setGroup(value: string): void {
    const v = this.config.requireGroup === true && value === '' ? this.defaultGroup : value;
    if (this.groupEl) this.groupEl.value = v;
    this.ctx.tree.at(['screen', 'group']).set(v);
  }

  /**
   * The Clear button — reset the screen to its DEFAULTS, not to "All". Clears
   * the search, resets the group, then re-applies the screen's default view
   * (`default_filter` preset) + base phase via {@link applyScreenDefaults}. With
   * no persisted screen state (tests / ad-hoc) it falls back to an empty filter.
   */
  private clearAll(): void {
    if (this.searchEl) this.searchEl.value = '';
    this.setGroup(this.defaultGroup);
    this.ctx.tree.at(['screen', 'search']).set('');
    const statePath = this.config.screenStatePath;
    if (statePath !== undefined) {
      this.searchSessionNode(statePath).set(''); // drop the in-session search too
      this.applyScreenDefaults(statePath); // default VIEW
      this.resetPhaseToBase(statePath); // base PHASE (+ session)
    } else {
      this.applyPredicate(null);
    }
  }

  /* --------------------------- saved-filter writes -------------------------- */

  /**
   * Save the current `screen.predicate` as a NEW filter card under the resolved
   * screen. Optimistic: the new card is appended to the landed filters list +
   * selected immediately; on a server id we replace the temp id, on a fault the
   * optimistic append rolls back (the centralized funnel surfaces the error).
   */
  private saveCurrentAsNew(): void {
    const statePath = this.config.screenStatePath;
    if (statePath === undefined) return;
    const screenId = this.ctx.tree.at([...statePath, 'screenId']).peek<bigint | null>() ?? null;
    if (screenId === null) return; // no resolved screen → nothing to parent under
    const title = promptText('Save current filter as:', '');
    if (title === null) return;
    const trimmed = title.trim();
    if (trimmed === '') return;

    const predicate = this.ctx.tree.at(['screen', 'predicate']).peek<Predicate | null>() ?? null;
    const attributes: Record<string, unknown> = { title: trimmed };
    if (predicate !== null) {
      // Stored as a JSON STRING (the shape readPredicate reads back).
      attributes['predicate'] = JSON.stringify(toWire(predicate));
    }
    // The group value IS the attribute name → persist it verbatim as group_by_attr.
    const groupAttr = this.ctx.tree.at(['screen', 'group']).peek<string>() ?? '';
    if (groupAttr !== '') attributes['group_by_attr'] = groupAttr;
    // The view's "Sort by" list (`{ attr, dir }[]`) → persisted as the filter
    // card's `sort` attribute (JSON).
    const sort = this.ctx.tree.at(['screen', 'sort']).peek<unknown>();
    if (Array.isArray(sort) && sort.length > 0) attributes['sort'] = JSON.stringify(sort);

    // Optimistic append with a negative temp id (distinct from any real id).
    const tempIdBig = BigInt(Math.trunc(-Date.now()));
    const filtersNode = this.ctx.tree.at([...statePath, 'filters']);
    const optimisticCard: CardWithAttrs = {
      id: tempIdBig,
      card_type_id: 0n,
      card_type_name: 'filter',
      parent_card_id: screenId,
      attributes,
    };
    const txn = optimistic<CardWithAttrs[]>(filtersNode, (cur) => [...(cur ?? []), optimisticCard]);
    this.ctx.tree.at([...statePath, 'activeFilterId']).set(tempIdBig);

    this.ctx.api.callByName(
      'card.insert',
      { cardTypeName: 'filter', parentCardId: screenId, title: trimmed, attributes },
      (out) => {
        txn.commit();
        const newId = ((out ?? {}) as { id?: bigint }).id ?? null;
        if (newId === null) return;
        // Swap the temp id for the real one (keep the row + re-select it).
        const cur = filtersNode.peek<CardWithAttrs[]>() ?? [];
        const next = cur.map((f) => (f.id === tempIdBig ? { ...f, id: newId } : f));
        filtersNode.set(next);
        this.ctx.tree.at([...statePath, 'activeFilterId']).set(newId);
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          txn.rollback();
          this.ctx.tree.at([...statePath, 'activeFilterId']).set(null);
        },
      },
    );
  }

  /** Set the active preset as the screen's default_filter (attribute.update). */
  private setActiveAsDefault(): void {
    const statePath = this.config.screenStatePath;
    if (statePath === undefined) return;
    const screenId = this.ctx.tree.at([...statePath, 'screenId']).peek<bigint | null>() ?? null;
    const activeId = this.ctx.tree.at([...statePath, 'activeFilterId']).peek<bigint | null>() ?? null;
    if (screenId === null || activeId === null) return;
    // Optimistically reflect the new default id.
    this.ctx.tree.at([...statePath, 'defaultFilterId']).set(activeId);
    this.ctx.api.callByName(
      'attribute.update',
      { cardId: screenId, attributeName: 'default_filter', value: activeId },
      () => {
        /* success — the optimistic default id stands */
      },
      { alive: () => this.isAlive() },
    );
  }

  /** Rename the active preset (attribute.update title). Optimistic list patch. */
  private renameActive(): void {
    const statePath = this.config.screenStatePath;
    if (statePath === undefined) return;
    const activeId = this.ctx.tree.at([...statePath, 'activeFilterId']).peek<bigint | null>() ?? null;
    if (activeId === null) return;
    const filtersNode = this.ctx.tree.at([...statePath, 'filters']);
    const cur = filtersNode.peek<CardWithAttrs[]>() ?? [];
    const card = cur.find((f) => f.id === activeId) ?? null;
    if (card === null) return;
    const next = promptText('Rename filter:', readTitle(card));
    if (next === null) return;
    const trimmed = next.trim();
    if (trimmed === '' || trimmed === readTitle(card)) return;
    const txn = optimistic<CardWithAttrs[]>(filtersNode, (list) =>
      (list ?? []).map((f) =>
        f.id === activeId ? { ...f, attributes: { ...f.attributes, title: trimmed } } : f,
      ),
    );
    this.ctx.api.callByName(
      'attribute.update',
      { cardId: activeId, attributeName: 'title', value: trimmed },
      () => txn.commit(),
      { alive: () => this.isAlive(), onErr: () => txn.rollback() },
    );
  }

  /** Delete the active preset (card.delete). Optimistic list removal. */
  private deleteActive(): void {
    const statePath = this.config.screenStatePath;
    if (statePath === undefined) return;
    const activeId = this.ctx.tree.at([...statePath, 'activeFilterId']).peek<bigint | null>() ?? null;
    if (activeId === null) return;
    const filtersNode = this.ctx.tree.at([...statePath, 'filters']);
    const cur = filtersNode.peek<CardWithAttrs[]>() ?? [];
    const card = cur.find((f) => f.id === activeId) ?? null;
    if (card === null) return;
    if (!confirmText(`Delete filter "${readTitle(card)}"?`)) return;
    const txn = optimistic<CardWithAttrs[]>(filtersNode, (list) =>
      (list ?? []).filter((f) => f.id !== activeId),
    );
    // Drop the active selection + reset the filter (the user removed it).
    this.applyPreset(null);
    this.ctx.api.callByName(
      'card.delete',
      { cardId: activeId },
      (out) => {
        if (((out ?? {}) as { ok?: boolean }).ok === false) {
          txn.rollback();
          return;
        }
        txn.commit();
      },
      { alive: () => this.isAlive(), onErr: () => txn.rollback() },
    );
  }

  /** Tear down + re-spawn the Advanced PredicateFilter so it re-seeds from the
   *  (updated) `screen.predicate` leaf. The panel's open/closed state lives on
   *  the panel element, untouched by the swap. */
  private respawnPredicate(): void {
    if (this.predicateChild === null || this.predicateHost === null || this.predicateConfig === null) {
      return;
    }
    this.destroyChild(this.predicateChild);
    this.predicateChild = this.spawn('PredicateFilter', this.predicateConfig, this.predicateHost);
  }
}

/** The card_ref attribute a screen's phase toggles scope. All toggles in one
 *  group share it (the seed's `attr`); the Comms screen uses `comm_status`, the
 *  rest `status`. Empty toggle set → 'status' (the only place a leaf could be
 *  composed without toggles is a no-op). */
function phaseAttrOf(toggles: readonly PhaseToggle[]): string {
  return toggles[0]?.attr ?? 'status';
}

/** Prompt for text (browser prompt; null when unavailable / cancelled). */
function promptText(message: string, initial: string): string | null {
  if (typeof window === 'undefined' || typeof window.prompt !== 'function') return null;
  return window.prompt(message, initial);
}

/** Confirm dialog (browser confirm; true when unavailable so tests can proceed). */
function confirmText(message: string): boolean {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  return window.confirm(message);
}

export function registerScreenFilterBar(): void {
  Control.register('ScreenFilterBar', ScreenFilterBar);
}

/**
 * Focus (and select) the shared ScreenFilterBar's search input, if one is
 * mounted in the same document tree as `from`. Returns true when an input was
 * found + focused. DOM-only (no signal write) so it's safe to call from a
 * hotkey handler. ScreenHost binds "/" to this so every search screen (grid /
 * list / kanban / project) gets focus-search without each body re-implementing
 * it. The bar's search input is the canonical `[data-filter-search]` element.
 */
export function focusScreenSearch(from: HTMLElement): boolean {
  const sel = '[data-filter-search]';
  const root = (from.getRootNode?.() ?? null) as ParentNode | null;
  // `from` (the ScreenHost root) contains the bar, so try its subtree first;
  // then the document root, then the document — covers both the live shell and
  // a detached test mount.
  const input =
    from.querySelector?.<HTMLInputElement>(sel) ??
    root?.querySelector?.<HTMLInputElement>(sel) ??
    (typeof document !== 'undefined' ? document.querySelector?.<HTMLInputElement>(sel) : null) ??
    null;
  if (input && typeof input.focus === 'function') {
    input.focus();
    input.select?.();
    return true;
  }
  return false;
}
