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
import type { NamedFiltersConfig } from '../filter/named-filters.js';
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

    /* ---- row 1: the NAMED/SAVED filter picker (when wired to a screen) +
           any screen-registered view actions, pulled right. ---- */
    const viewActions = this.config.viewActions ?? [];
    if (this.config.screenStatePath !== undefined || viewActions.length > 0) {
      const row1 = document.createElement('div');
      row1.className = 'filterbar__row filterbar__row--presets';
      this.el.append(row1);
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
          row1,
        );
      }
      // Screen-specific view actions (e.g. Grid → Columns), right-aligned.
      if (viewActions.length > 0) {
        const actions = document.createElement('div');
        actions.className = 'filterbar__view-actions';
        actions.dataset.filterbarViewActions = '';
        row1.append(actions);
        for (const action of viewActions) this.spawn(action.type, action, actions);
      }
    }

    /* ---- row 2: the v1 working subset (GROUP + search + Advanced + Clear) ---- */
    const row2 = document.createElement('div');
    row2.className = 'filterbar__row';

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

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'filterbar__search';
    search.placeholder = 'Search tasks…';
    search.dataset.filterSearch = '';
    this.searchEl = search;

    // Advanced toggle — expands the structured PredicateFilter panel.
    const advanced = document.createElement('button');
    advanced.type = 'button';
    advanced.className = 'btn filterbar__advanced';
    advanced.dataset.filterAdvanced = '';
    advanced.setAttribute('aria-expanded', 'false');
    advanced.textContent = 'Advanced';

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'btn filterbar__clear';
    clear.textContent = 'Clear';

    row2.append(groupWrap);
    if (laneWrap !== null) row2.append(laneWrap);
    row2.append(search, advanced, clear);
    this.el.append(row2);

    /* ---- phase-scope toggles (Active / Closed / …) from the screen's
     *      `toggle_groups`. Each toggles a phase in the SINGLE top-level
     *      `status has_phase [phases]` leaf of `screen.predicate` (OR-semantics).
     *      Default-on phases are seeded on first visit (so e.g. terminal is
     *      hidden); a click reveals/hides a phase. Reads `screen.phaseToggles`
     *      (landed by ScreenHost) + `screen.predicate` reactively, so it repaints
     *      on any surface's edit and composes with the chips (the chip helpers
     *      preserve the `has_phase` leaf). ---- */
    const phaseHost = document.createElement('div');
    phaseHost.className = 'filterbar__row filterbar__row--phases';
    phaseHost.dataset.phaseToggles = '';
    this.el.append(phaseHost);
    this.effect(() => {
      const toggles = (this.ctx.tree.at(['screen', 'phaseToggles']).get<PhaseToggle[]>() ?? []) as PhaseToggle[];
      const scoped = topLevelPhases(this.ctx.tree.at(['screen', 'predicate']).get<Predicate | null>() ?? null);
      this.paintPhaseToggles(phaseHost, toggles, new Set<Phase>(scoped));
    }, 'filterbar.phaseToggles');

    /* ---- row 3: the QUICK-CHIPS row (pinned per-attribute one-tap filters) ---- */
    // Each chip toggles a top-level `attr in [...]` leaf in 'screen.predicate'
    // via applyPredicate — the SAME write the preset/Advanced surfaces use, so
    // the Advanced editor re-seeds on a chip pick and the chips re-read the
    // shared predicate reactively on any other surface's edit.
    const chipsHost = document.createElement('div');
    chipsHost.className = 'filterbar__row filterbar__row--chips';
    this.el.append(chipsHost);
    this.chipsHostEl = chipsHost;

    // The "Named" multi-select — toggles reusable predicate-fragment leaves
    // (`snippet` op → predicate_snippet cards) on the SAME tree. Picking a
    // snippet adds a top-level snippet-id leaf the server expands + cycle-guards;
    // routes through applyPredicate so the Advanced editor + chips reflect it.
    // Reads scope.projectId to scope its snippet load + screen.predicate for its
    // active state (consistent with every other surface).
    this.spawn(
      'NamedFilters',
      {
        type: 'NamedFilters',
        predicatePath: 'screen.predicate',
        snippetsPath: 'screen.snippets',
        projectIdPath: 'scope.projectId',
        onCommit: (next: Predicate | null) => this.applyPredicate(next),
      } as NamedFiltersConfig,
      chipsHost,
    );
    // QuickChips is (re)spawned by applyAxes once the data-driven axes resolve,
    // so its chip set + option values come from the project's attribute schema
    // rather than a hardcoded list.

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
    });
    this.listen(advanced, 'click', () => {
      const open = panel.style.display === 'none';
      panel.style.display = open ? '' : 'none';
      advanced.setAttribute('aria-expanded', open ? 'true' : 'false');
      advanced.classList.toggle('filterbar__advanced--open', open);
    });
    this.listen(clear, 'click', () => this.clearAll());

    // VIEW PERSISTENCE (#27): restore the saved (project, slug) view now — before
    // the async screen-resolve fires the default-on-first-visit effect — then
    // persist on any change to the view leaves. Restore takes precedence: a
    // restored view marks the (project, slug) visited so the default is skipped.
    this.restoreView();
    this.effect(() => {
      const predicate = this.ctx.tree.at(['screen', 'predicate']).get<Predicate | null>() ?? null;
      const group = this.ctx.tree.at(['screen', 'group']).get<string>() ?? '';
      const laneGroup = this.ctx.tree.at(['screen', 'laneGroup']).get<string>() ?? '';
      const columnConfig = this.ctx.tree.at(['screen', 'columnConfig']).get<unknown>();
      if (!this.viewRestored) return; // don't persist the transient pre-restore seed
      const sp = this.config.screenStatePath;
      if (sp !== undefined) saveView(sp, { predicate, group, laneGroup, columnConfig });
    }, 'filterbar.persistView');
  }

  /** Restore the persisted (project, slug) view into the screen.* leaves. */
  private restoreView(): void {
    const sp = this.config.screenStatePath;
    if (sp === undefined) {
      this.viewRestored = true;
      return;
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
        this.ctx.tree.at(['screen', 'predicate']).set(v.predicate as Predicate | null);
        this.respawnPredicate();
      }
      // Mark the (project, slug) visited so default-on-first-visit doesn't
      // override the restored view when the screen resolves.
      this.ctx.tree.at([...sp, 'activeFilterId']).set(null);
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
    const byAttr: Record<string, GroupAttr> = {};
    for (const a of axes) {
      const ga = groupAxisForAttr(a.attr, a.targetCardType);
      if (ga !== null) byAttr[a.attr] = ga;
    }
    this.ctx.tree.at(['screen', 'groupAxesByAttr']).set(byAttr);
    // Publish the full axis list so other surfaces (the Grid's bulk-action bar,
    // synthetic ref columns) data-drive off the SAME schema without re-loading.
    this.ctx.tree.at(['screen', 'refAxes']).set(axes);
    const opts = axes.map((a) => ({ value: a.attr, label: a.label }));
    this.rebuildGroupSelect(opts);
    this.rebuildLaneSelect(opts);
    this.spawnChips(axes);
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

    const defaultId = this.ctx.tree.at([...statePath, 'defaultFilterId']).peek<bigint | null>() ?? null;
    const toggles = (this.ctx.tree.at(['screen', 'phaseToggles']).peek<PhaseToggle[]>() ?? []) as PhaseToggle[];

    // 1. Base predicate: the default_filter preset, else EMPTY (every phase
    //    visible). There is no hardcoded "not terminal" default any more — what
    //    a screen hides by default is OWNED by its phase toggles' `default_on`
    //    flags (seeded per screen, applied in step 2). A screen with no phase
    //    toggles therefore shows ALL phases by default.
    if (defaultId !== null) {
      this.applyPreset(defaultId); // marks visited + sets predicate/group/sort
    } else {
      activeNode.set(null); // mark visited
      this.applyPredicate(null);
    }

    // 2. Seed the phase scope from the default-on toggles, composed on top of
    //    the base predicate. All-on (or none) → no leaf (every phase visible).
    if (toggles.length > 0) {
      const all = toggles.map((t) => t.phase);
      const on = toggles.filter((t) => t.defaultOn).map((t) => t.phase);
      const phases = on.length >= all.length ? [] : on;
      const cur = this.ctx.tree.at(['screen', 'predicate']).peek<Predicate | null>() ?? null;
      this.applyPredicate(withTopLevelPhases(cur, phases));
    }
  }

  /* ----------------------------- phase toggles ----------------------------- */

  /** (Re)render the phase-scope toggle row. `active` is the set of phases the
   *  `status has_phase` leaf currently scopes to; an EMPTY set means no leaf →
   *  every phase is visible, so every toggle reads as ON. */
  private paintPhaseToggles(host: HTMLElement, toggles: readonly PhaseToggle[], active: Set<Phase>): void {
    host.replaceChildren();
    if (toggles.length === 0) {
      host.style.display = 'none';
      return;
    }
    host.style.display = '';
    const label = document.createElement('span');
    label.className = 'filterbar__phase-label muted';
    label.textContent = 'Phase';
    host.append(label);
    for (const t of toggles) {
      const on = active.size === 0 ? true : active.has(t.phase);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'filterbar__phase-toggle';
      btn.dataset.phaseToggle = t.phase;
      btn.textContent = t.label;
      btn.classList.toggle('filterbar__phase-toggle--on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      this.listen(btn, 'click', () => this.togglePhase(t.phase));
      host.append(btn);
    }
  }

  /** Toggle one phase in the `status has_phase` scope. Showing-all (no leaf) +
   *  a click HIDES that phase (restricts to the rest); otherwise the phase is
   *  added/removed. A result covering every phase collapses to no leaf (show
   *  all), which the chips never touch. Routes through applyPredicate so the
   *  Advanced editor + the toggles repaint. */
  private togglePhase(phase: Phase): void {
    const toggles = (this.ctx.tree.at(['screen', 'phaseToggles']).peek<PhaseToggle[]>() ?? []) as PhaseToggle[];
    const all = toggles.map((t) => t.phase);
    const cur = this.ctx.tree.at(['screen', 'predicate']).peek<Predicate | null>() ?? null;
    const curPhases = topLevelPhases(cur);

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
    this.applyPredicate(withTopLevelPhases(cur, phases));
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

  /** Clear search + group + the predicate back to defaults (the Clear button). */
  private clearAll(): void {
    if (this.searchEl) this.searchEl.value = '';
    this.setGroup(this.defaultGroup);
    this.ctx.tree.at(['screen', 'search']).set('');
    this.applyPredicate(null);
    // Clearing detaches from any active preset (a subsequent re-pick reattaches).
    const statePath = this.config.screenStatePath;
    if (statePath !== undefined) {
      this.ctx.tree.at([...statePath, 'activeFilterId']).set(null);
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
