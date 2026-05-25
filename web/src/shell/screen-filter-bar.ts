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
 * cached). With no default it falls back to `status notTerminal` (a single
 * not-terminal leaf). The active filter is CACHED at `<statePath>.activeFilterId`
 * so back-nav restores the exact preset without re-applying the default.
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
  toWire,
  leaf,
} from '../filter/predicate.js';
import {
  readPredicate,
  readGroupByAttr,
  readTitle,
} from '../filter/screen-resolve.js';

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
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    ScreenFilterBar: ScreenFilterBarConfig;
  }
}

const DEFAULT_GROUP_OPTIONS = [
  { value: 'milestone', label: 'Milestone' },
  { value: 'status', label: 'Status' },
  { value: 'component', label: 'Component' },
  { value: 'assignee', label: 'Assignee' },
];

/**
 * Map the Grid's lookup leaf NAME → the card_type NAME the schema's card_ref
 * attrs target. The PredicateFilter keys its options on the target card_type, so
 * we re-key the `{id:label}` lookup maps under these names. A lookup with no
 * mapping here is simply not exposed to the ref pickers.
 */
const LOOKUP_TO_CARD_TYPE: Readonly<Record<string, string>> = {
  persons: 'person',
  statuses: 'status',
  milestones: 'milestone',
  components: 'component',
  tags: 'tag',
};

/** One ref-picker option. */
interface RefOption {
  value: string;
  label: string;
}

/** The GROUP-by value name → the human label used when re-keying a preset's
 *  stored `group_by_attr` (an attribute name) back to the picker vocabulary. */
const ATTR_TO_GROUP_VALUE: Readonly<Record<string, string>> = {
  milestone_ref: 'milestone',
  component_ref: 'component',
  status: 'status',
  assignee: 'assignee',
};

export class ScreenFilterBar extends Control<ScreenFilterBarConfig> {
  /** The live Advanced PredicateFilter child + its mount host, so Clear /
   *  preset-apply can re-seed the editor by re-spawning it against the
   *  (updated) predicate leaf — the editor peeks the leaf once at mount. */
  private predicateChild: Control | null = null;
  private predicateHost: HTMLElement | null = null;
  private predicateConfig: PredicateFilterConfig | null = null;

  private groupEl: HTMLSelectElement | null = null;
  private searchEl: HTMLInputElement | null = null;
  private defaultGroup = 'milestone';

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'filterbar';
    el.dataset.control = 'ScreenFilterBar';
    return el;
  }

  protected render(): void {
    this.defaultGroup = this.config.defaultGroup ?? 'milestone';
    const groupOptions = this.config.groupOptions ?? DEFAULT_GROUP_OPTIONS;
    const predicateCardType = this.config.predicateCardType ?? 'task';

    // Seed tree defaults (one-way; the Object.is gate makes re-seeding a no-op).
    this.ctx.tree.at(['screen', 'group']).set(this.defaultGroup);
    this.ctx.tree.at(['screen', 'search']).set('');

    /* ---- row 1: the NAMED/SAVED filter picker (when wired to a screen) ---- */
    if (this.config.screenStatePath !== undefined) {
      const row1 = document.createElement('div');
      row1.className = 'filterbar__row filterbar__row--presets';
      this.el.append(row1);
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
    for (const o of groupOptions) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === this.defaultGroup) opt.selected = true;
      group.append(opt);
    }
    groupWrap.append(groupLabel, group);
    this.groupEl = group;

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

    row2.append(groupWrap, search, advanced, clear);
    this.el.append(row2);

    /* ---- row 3: the QUICK-CHIPS row (pinned per-attribute one-tap filters) ---- */
    // Each chip toggles a top-level `attr in [...]` leaf in 'screen.predicate'
    // via applyPredicate — the SAME write the preset/Advanced surfaces use, so
    // the Advanced editor re-seeds on a chip pick and the chips re-read the
    // shared predicate reactively on any other surface's edit.
    const chipsHost = document.createElement('div');
    chipsHost.className = 'filterbar__row filterbar__row--chips';
    this.el.append(chipsHost);

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

    this.spawn(
      'QuickChips',
      {
        type: 'QuickChips',
        predicatePath: 'screen.predicate',
        optionsPath: 'screen.predicateOptions',
        onCommit: (next: Predicate | null) => this.applyPredicate(next),
      } as QuickChipsConfig,
      chipsHost,
    );

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
      schema: { cardType: predicateCardType },
      optionsPath: 'screen.predicateOptions',
    };
    this.predicateChild = this.spawn('PredicateFilter', this.predicateConfig, panel);

    // Project the Grid's `{id:label}` lookup maps into the PredicateFilter's
    // option shape (re-keyed by card_type). One-way derive, cascade-safe.
    this.effect(() => {
      this.ctx.tree.at(['grid', 'lookups', 'tick']).get(); // re-derive on a late land
      const options: Record<string, RefOption[]> = {};
      for (const [lookup, cardType] of Object.entries(LOOKUP_TO_CARD_TYPE)) {
        const map =
          (this.ctx.tree.at(['grid', 'lookups', lookup]).get<Record<string, string>>() ??
            {}) as Record<string, string>;
        const opts: RefOption[] = Object.entries(map).map(([value, label]) => ({ value, label }));
        if (opts.length > 0) options[cardType] = opts;
      }
      this.ctx.tree.at(['screen', 'predicateOptions']).set(options);
    }, 'filterbar.predicateOptions');

    // DEFAULT-FILTER-ON-FIRST-VISIT. When the screen resolves, apply the
    // default's predicate the first time this (project, slug) is visited; with
    // no default fall back to `status notTerminal`. Reads only the `resolved`
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
      return;
    }
    const filters = this.ctx.tree.at([...statePath, 'filters']).peek<CardWithAttrs[]>() ?? [];
    const card = filters.find((f) => f.id === id) ?? null;
    if (card === null) {
      this.applyPredicate(null);
      return;
    }
    this.applyPredicate(readPredicate(card));
    const groupBy = readGroupByAttr(card);
    const groupValue = groupBy === null ? this.defaultGroup : (ATTR_TO_GROUP_VALUE[groupBy] ?? this.defaultGroup);
    this.setGroup(groupValue);
  }

  /**
   * First-visit default application. No-op once the (project, slug) cache has an
   * `activeFilterId` (back-nav restored a prior selection). Applies the screen's
   * `default_filter` preset when present; otherwise the `status notTerminal`
   * fallback. Marks the cache visited so it runs exactly once per first visit.
   */
  private applyDefaultOnFirstVisit(statePath: string[]): void {
    const activeNode = this.ctx.tree.at([...statePath, 'activeFilterId']);
    // `undefined` = never visited; `null` = visited with "Default" (no preset).
    if (activeNode.peek<bigint | null>() !== undefined) return;

    const defaultId = this.ctx.tree.at([...statePath, 'defaultFilterId']).peek<bigint | null>() ?? null;
    if (defaultId !== null) {
      // Mark visited + apply the default preset's predicate/group.
      this.applyPreset(defaultId);
      return;
    }
    // No default → the `status notTerminal` fallback (a single not-terminal
    // leaf). Mark visited (null) so re-resolution doesn't re-apply it over a
    // later user edit.
    activeNode.set(null);
    this.applyPredicate(leaf('status', 'notTerminal'));
  }

  /** Write a predicate to `screen.predicate` + re-seed the Advanced editor. */
  private applyPredicate(predicate: Predicate | null): void {
    this.ctx.tree.at(['screen', 'predicate']).set(predicate);
    this.respawnPredicate();
  }

  /** Set the GROUP picker value + leaf (keeps the <select> in sync on apply). */
  private setGroup(value: string): void {
    if (this.groupEl) this.groupEl.value = value;
    this.ctx.tree.at(['screen', 'group']).set(value);
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
    const groupValue = this.ctx.tree.at(['screen', 'group']).peek<string>() ?? this.defaultGroup;
    const groupAttr = invertGroupValue(groupValue);
    if (groupAttr !== null) attributes['group_by_attr'] = groupAttr;

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

/** Invert a GROUP picker value to the stored attribute name (null = no group). */
function invertGroupValue(value: string): string | null {
  switch (value) {
    case 'milestone':
      return 'milestone_ref';
    case 'component':
      return 'component_ref';
    case 'status':
      return 'status';
    case 'assignee':
      return 'assignee';
    default:
      return null;
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
