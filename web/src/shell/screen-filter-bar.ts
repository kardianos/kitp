/**
 * ScreenFilterBar — the shared header for task-list screens (Inbox, Grid,
 * Kanban, Project detail). v1 is a documented SUBSET of the full design
 * (web/design/controls-and-rules.md `ScreenFilterBar`):
 *
 *   v1 (built here):
 *     - GROUP-by Picker (default 'milestone' — the current kanban axis). On
 *       change it writes 'kanban.columnAttr' to the tree so a future Kanban
 *       could re-key live; for v1 the Kanban axis is fixed at milestone_ref so
 *       this is a structural placeholder that renders + reads correctly.
 *     - Search Field (writes 'screen.search' to the tree as you type).
 *     - Advanced toggle → an expandable panel hosting a structured
 *       {@link PredicateFilter} over the `task` card_type. The editor writes its
 *       {@link Predicate} tree to 'screen.predicate'; Grid + Kanban read that leaf
 *       and AND it into the task query (flat-AND → the `where[]` field composed
 *       with the title-search leaf; otherwise the v2 `tree` field). Cascade-safe:
 *       the editor's writes are one-way leaf writes; the hosts bump a query
 *       version off them.
 *     - Clear button (resets search + group to defaults AND clears the predicate).
 *
 *   TODO (deferred, render placeholders so they slot in later — see the mock):
 *     - row 1: export ⤓ · View Picker (saved screen view) · NAMED filter Picker
 *       · kebab ⋮ · search-scope `in:[Title ▾]`.
 *     - row 2: per-attribute filter Pickers (Status / Assignee / Originator /
 *       Milestone / Component / Tags) · + Add filter · row count · Show closed
 *       status checkbox.
 *
 * OPTIONS for the PredicateFilter's card_ref pickers: the Grid lands its lookup
 * label-maps at `grid.lookups.<name>` (stringified id → label) keyed by lookup
 * NAME (persons/statuses/milestones/components/tags). The PredicateFilter wants
 * `Record<targetCardType, {value,label}[]>` keyed by the target card_type NAME
 * (person/status/milestone/component/tag). A single reactive effect projects the
 * former into the latter at 'screen.predicateOptions' so a late-landing lookup
 * repaints the open ref pickers. This is a one-way derive (reads lookups, writes
 * the options leaf — never back into a watched dep), cascade-safe.
 *
 * No promises, no API calls here — the bar only mutates tree state (R3/R5
 * one-way writes); the data-bound controls below it react.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { PredicateFilterConfig } from '../filter/predicate-filter.js';

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

export class ScreenFilterBar extends Control<ScreenFilterBarConfig> {
  /** The live Advanced PredicateFilter child + its mount host, so Clear can
   *  re-seed the editor by re-spawning it against the (now-null) predicate leaf
   *  — the editor peeks the leaf once at mount, so a re-spawn is the clean reset. */
  private predicateChild: Control | null = null;
  private predicateHost: HTMLElement | null = null;
  private predicateConfig: PredicateFilterConfig | null = null;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'filterbar';
    el.dataset.control = 'ScreenFilterBar';
    return el;
  }

  protected render(): void {
    const defaultGroup = this.config.defaultGroup ?? 'milestone';
    const groupOptions = this.config.groupOptions ?? DEFAULT_GROUP_OPTIONS;
    const predicateCardType = this.config.predicateCardType ?? 'task';

    // Seed tree defaults (one-way; the Object.is gate makes re-seeding a no-op).
    this.ctx.tree.at(['screen', 'group']).set(defaultGroup);
    this.ctx.tree.at(['screen', 'search']).set('');

    // Row 1 (the saved-view / named-filter / export / kebab strip) is deferred
    // until those Pickers land. Rather than render placeholder "TODO" text in
    // the product UI, we omit row 1 entirely; the working subset below stands
    // on its own. The slot is mechanical to re-introduce when the Pickers ship.

    /* ---- the v1 working subset (GROUP + search + Advanced + Clear) ---- */
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
      if (o.value === defaultGroup) opt.selected = true;
      group.append(opt);
    }
    groupWrap.append(groupLabel, group);

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'filterbar__search';
    search.placeholder = 'Search tasks…';
    search.dataset.filterSearch = '';

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

    /* ---- the Advanced panel: a structured PredicateFilter over the task type ---- */
    // Hidden until toggled. The PredicateFilter writes its predicate to
    // 'screen.predicate'; Grid + Kanban read that leaf one-way and AND it into
    // the task query. Options for ref pickers are projected from the Grid's
    // lookup label-maps (see the effect below) at 'screen.predicateOptions'.
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
    // `Record<targetCardType, {value,label}[]>` shape (re-keyed by card_type).
    // Reads ONLY the lookups tick + leaves; writes ONLY the options leaf — a
    // one-way derive, cascade-safe. Late-landing lookups repaint open pickers.
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

    // Interactions: bar writes tree state one-way; nothing reads back into the
    // same effect that wrote it (cascade-safe).
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
    this.listen(clear, 'click', () => {
      search.value = '';
      group.value = defaultGroup;
      this.ctx.tree.at(['screen', 'search']).set('');
      this.ctx.tree.at(['screen', 'group']).set(defaultGroup);
      // Clear also resets the structured predicate (null = no filter). The host
      // grids read this leaf and re-run their query without the predicate AND.
      this.ctx.tree.at(['screen', 'predicate']).set(null);
      // Re-seed the editor itself: it peeks the predicate leaf once at mount, so
      // a re-spawn against the now-null leaf collapses it back to an empty root.
      this.respawnPredicate();
    });
  }

  /** Tear down + re-spawn the Advanced PredicateFilter so it re-seeds from the
   *  (now reset) `screen.predicate` leaf. The panel's open/closed state is on the
   *  panel element, untouched by the swap. */
  private respawnPredicate(): void {
    if (this.predicateChild === null || this.predicateHost === null || this.predicateConfig === null) {
      return;
    }
    this.destroyChild(this.predicateChild);
    this.predicateChild = this.spawn('PredicateFilter', this.predicateConfig, this.predicateHost);
  }
}

export function registerScreenFilterBar(): void {
  Control.register('ScreenFilterBar', ScreenFilterBar);
}
