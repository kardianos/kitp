/**
 * QuickChips — the one-tap per-attribute quick-filter row the ScreenFilterBar
 * pins above the Advanced editor.
 *
 * Each chip is a pinned dropdown (a {@link Popover} of a multi-select checkbox
 * list) for ONE task attribute — Status / Assignee / Milestone / Component /
 * Tags by default. Selecting values toggles a single TOP-LEVEL `attr in [...]`
 * leaf in the SAME `screen.predicate` tree the Advanced PredicateFilter + the
 * named-filter presets edit (see {@link upsertTopLevelLeaf} /
 * {@link removeTopLevelLeaf} in predicate.ts). Empty selection removes the leaf.
 *
 * ONE TREE, MANY SURFACES. The chips never own their own state: they READ the
 * current per-attr leaf out of `screen.predicate` (reactively) so a change from
 * ANY source — another chip, the Advanced editor, applying a named filter,
 * Clear — repaints the chip's active label + count. On a pick they compute the
 * NEXT predicate (replace/append/remove the top-level leaf) and hand it back
 * through {@link QuickChipsConfig.onCommit}; the host (ScreenFilterBar) writes
 * it to `screen.predicate` and re-seeds the Advanced editor. The chips compose
 * with the Advanced tree: a chip leaf is a direct child of the root AND, so it
 * ANDs alongside whatever nested groups the Advanced editor built.
 *
 * Option lists come from `optionsPath` — the same `Record<targetCardType,
 * Array<{value,label}>>` map the bar already projects out of `grid.lookups.*`
 * for the Advanced ref pickers — so the chip values match the editor's
 * everywhere. Read reactively: a late-landing lookup repaints the open menu.
 *
 * Cascade-safe: the only writes are DOM patches (the active-state effect) and
 * the `onCommit` callback fired from a click handler (outside any tracked
 * effect). No promise crosses the surface; the Popover owns its float lifecycle.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { splitPath } from '../core/data.js';
import { Popover } from '../ui/popover.js';
import {
  type Predicate,
  type PredicateLeaf,
  leaf as makeLeaf,
  topLevelLeafForAttr,
  upsertTopLevelLeaf,
  removeTopLevelLeaf,
} from './predicate.js';
import { selectedSnippetIds, setSelectedSnippets } from './snippet-predicate.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';

import { icon } from '../ui/icons.js';
/* -------------------------------------------------------------------------- */
/* Config + the pinned chip set.                                              */
/* -------------------------------------------------------------------------- */

/** One pinned chip: a task attribute + the card_type its option list lives under. */
export interface QuickChipDef {
  /** The predicate attribute name written into the leaf (e.g. 'status'). */
  attr: string;
  /** Chip + trigger label (e.g. 'Status'). */
  label: string;
  /**
   * The key into the options map for this chip's value list — the target
   * card_type name (e.g. 'status', 'person', 'milestone'). The bar projects
   * `grid.lookups.*` under these keys (see LOOKUP_TO_CARD_TYPE in the bar).
   */
  optionKey: string;
}

/**
 * The DEFAULT pinned set for task screens. Structured as data so the set could
 * later be sourced from the screen's `toggle_groups` / config (the host passes
 * `chips` to override). Order = left-to-right in the row.
 */
export const DEFAULT_TASK_CHIPS: readonly QuickChipDef[] = [
  { attr: 'status', label: 'Status', optionKey: 'status' },
  { attr: 'assignee', label: 'Assignee', optionKey: 'person' },
  { attr: 'milestone_ref', label: 'Milestone', optionKey: 'milestone' },
  { attr: 'component_ref', label: 'Component', optionKey: 'component' },
  { attr: 'tags', label: 'Tags', optionKey: 'tag' },
];

export interface QuickChipsConfig extends BaseControlConfig {
  type: 'QuickChips';
  /** The pinned chip set. Defaults to {@link DEFAULT_TASK_CHIPS}. */
  chips?: readonly QuickChipDef[];
  /** Dotted tree path holding the shared {@link Predicate} (e.g. 'screen.predicate'). */
  predicatePath: string;
  /**
   * Dotted tree path holding `Record<targetCardType, Array<{value,label}>>` —
   * the chip value lists (same map the Advanced ref pickers read).
   */
  optionsPath: string;
  /**
   * Fired with the NEXT predicate whenever a chip toggles / clears its leaf.
   * The host writes it to the shared predicate leaf + re-seeds the Advanced
   * editor. (Presentation + intent only — the chips never write the tree.)
   */
  onCommit?: (next: Predicate | null) => void;
  /**
   * Dotted tree path the loaded `predicate_snippet` cards land under (the saved
   * "Named" filters, now folded into the "+ Filter" menu). Default
   * 'screen.snippets'. Omit/empty to disable saved filters entirely.
   */
  snippetsPath?: string;
  /** Dotted tree path of the project id scoping the snippet load. Default
   *  'scope.projectId'. */
  projectIdPath?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    QuickChips: QuickChipsConfig;
  }
}

/** One option in a chip's value list. */
interface ChipOption {
  value: string;
  label: string;
}
type OptionsMap = Record<string, ChipOption[]>;

/* -------------------------------------------------------------------------- */
/* Per-chip view object (one trigger + its popover menu).                     */
/* -------------------------------------------------------------------------- */

interface ChipView {
  def: QuickChipDef;
  /** The chip's outer wrapper — hidden until the chip has a value or is
   *  revealed via the "+ Filter" menu (Linear-style on-demand filters). */
  wrap: HTMLElement;
  trigger: HTMLButtonElement;
  labelEl: HTMLSpanElement;
  clearEl: HTMLButtonElement;
  popover: Popover;
  listEl: HTMLUListElement;
  /** Reflects the current selection (stringified values) for this chip's attr. */
  selected: string[];
}

/* -------------------------------------------------------------------------- */
/* Control.                                                                   */
/* -------------------------------------------------------------------------- */

export class QuickChips extends Control<QuickChipsConfig> {
  private chips: ChipView[] = [];
  /** The "+ Filter" add-menu (reveals hidden chips + saved filters on demand). */
  private addPopover: Popover | null = null;
  private addListEl: HTMLUListElement | null = null;
  private addWrap: HTMLElement | null = null;
  /** Active saved-filter (snippet) chips, keyed by snippet id-string. */
  private snippetChips = new Map<string, HTMLElement>();
  private loadedSnippetKey: string | null = null;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'filterbar__chips';
    el.dataset.control = 'QuickChips';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Quick filters');
    return el;
  }

  protected render(): void {
    const defs = this.config.chips ?? DEFAULT_TASK_CHIPS;
    for (const def of defs) this.chips.push(this.buildChip(def));
    this.buildAddFilter();

    // Load the project's saved filters (predicate snippets) into the snippets
    // leaf so "+ Filter" can offer them — reactive on the project id.
    this.effect(() => {
      this.loadSnippets();
    }, 'quickChips.snippetLoad');

    // ONE reactive effect: reads the shared predicate + the options map and
    // repaints every chip's active state (trigger label/count + the open menu's
    // checkboxes). One-way — reads the two leaves, writes only DOM. A predicate
    // change from ANY surface lands here, so the chips always reflect the tree.
    this.effect(() => {
      const predicate = this.readPredicate();
      const options = this.readOptions();
      for (const chip of this.chips) this.paintChip(chip, predicate, options);
      // Active saved filters render as chips alongside the attribute chips.
      this.reconcileSnippetChips(predicate);
      // Keep the open "+ Filter" menu in sync if a chip cleared elsewhere.
      if (this.addPopover?.isOpen) this.renderAddMenu();
    }, 'quickChips.sync');
  }

  /* ----------------------------- tree reads ------------------------------ */

  private readPredicate(): Predicate | null {
    return (
      this.ctx.tree.at(splitPath(this.config.predicatePath)).get<Predicate | null>() ?? null
    );
  }

  /** Peek the predicate WITHOUT subscribing (used inside a click handler). */
  private peekPredicate(): Predicate | null {
    return (
      this.ctx.tree.at(splitPath(this.config.predicatePath)).peek<Predicate | null>() ?? null
    );
  }

  private readOptions(): OptionsMap {
    const v = this.ctx.tree.at(splitPath(this.config.optionsPath)).get<OptionsMap>();
    return (v ?? {}) as OptionsMap;
  }

  /* ----------------------------- chip build ------------------------------ */

  private buildChip(def: QuickChipDef): ChipView {
    const wrap = document.createElement('div');
    wrap.className = 'filterbar__chip-wrap';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'filterbar__chip';
    trigger.dataset.quickChip = def.attr;
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', `Filter by ${def.label}`);

    const labelEl = document.createElement('span');
    labelEl.className = 'filterbar__chip-label';
    labelEl.textContent = def.label;
    trigger.append(labelEl);

    const caret = document.createElement('span');
    caret.className = 'filterbar__chip-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.append(icon('chevron-down', 14));
    trigger.append(caret);

    // The clear-X — hidden until the chip has an active leaf. Its own button so
    // a click clears WITHOUT opening the menu.
    const clearEl = document.createElement('button');
    clearEl.type = 'button';
    clearEl.className = 'filterbar__chip-clear';
    clearEl.dataset.quickChipClear = def.attr;
    clearEl.setAttribute('aria-label', `Clear ${def.label} filter`);
    clearEl.append(icon('x', 12));
    clearEl.style.display = 'none';
    trigger.append(clearEl);

    wrap.append(trigger);
    this.el.append(wrap);

    const popover = new Popover(trigger, {
      placement: 'bottom-start',
      width: 'anchor',
      clampHeight: true,
      onClose: () => {
        trigger.setAttribute('aria-expanded', 'false');
        // Fold the chip back off the bar if it closed with no value (added via
        // "+ Filter" but nothing picked, or its last value just unchecked).
        if (selectedValues(this.peekPredicate(), def.attr).length === 0) {
          wrap.style.display = 'none';
        }
      },
    });
    const panel = popover.element;
    panel.classList.add('filterbar__chip-panel');
    const list = document.createElement('ul');
    list.className = 'filterbar__chip-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-multiselectable', 'true');
    panel.append(list);

    const chip: ChipView = {
      def,
      wrap,
      trigger,
      labelEl,
      clearEl,
      popover,
      listEl: list,
      selected: [],
    };

    this.listen(trigger, 'click', (e) => {
      // A click on the clear-X (or the icon inside it) clears the leaf; anywhere
      // else toggles the menu.
      if (clearEl.contains(e.target as Node)) {
        e.preventDefault();
        this.clearChip(chip);
        return;
      }
      if (popover.isOpen) {
        popover.close();
        trigger.setAttribute('aria-expanded', 'false');
      } else {
        this.openChip(chip);
      }
    });

    this.onDestroy(() => popover.destroy());
    return chip;
  }

  /* ------------------------------- open/paint ---------------------------- */

  private openChip(chip: ChipView): void {
    chip.wrap.style.display = ''; // ensure visible (e.g. just added via "+ Filter")
    // Rebuild the menu from the LIVE selection + options on every open.
    this.renderMenu(chip, this.peekPredicate(), this.readOptionsPeek());
    chip.trigger.setAttribute('aria-expanded', 'true');
    chip.popover.open();
  }

  private readOptionsPeek(): OptionsMap {
    const v = this.ctx.tree.at(splitPath(this.config.optionsPath)).peek<OptionsMap>();
    return (v ?? {}) as OptionsMap;
  }

  /** Update a chip's trigger label/count + clear-X + (if open) its menu rows. */
  private paintChip(chip: ChipView, predicate: Predicate | null, options: OptionsMap): void {
    chip.selected = selectedValues(predicate, chip.def.attr);
    const count = chip.selected.length;

    // On-demand visibility: a chip shows only while it carries a value or its
    // picker is open (just added via "+ Filter"). Empty + closed → folded away.
    chip.wrap.style.display = count > 0 || chip.popover.isOpen ? '' : 'none';

    if (count === 0) {
      chip.labelEl.textContent = chip.def.label;
      chip.trigger.classList.remove('filterbar__chip--active');
      chip.clearEl.style.display = 'none';
    } else {
      chip.labelEl.textContent = `${chip.def.label}: ${count}`;
      chip.trigger.classList.add('filterbar__chip--active');
      chip.clearEl.style.display = '';
    }

    // Keep an open menu's checkboxes in sync if the predicate changed underneath.
    if (chip.popover.isOpen) this.renderMenu(chip, predicate, options);
  }

  /** Render the multi-select checkbox list for a chip. */
  private renderMenu(chip: ChipView, predicate: Predicate | null, options: OptionsMap): void {
    const selected = new Set(selectedValues(predicate, chip.def.attr));
    const opts = options[chip.def.optionKey] ?? [];
    chip.listEl.replaceChildren();

    if (opts.length === 0) {
      const li = document.createElement('li');
      li.className = 'filterbar__chip-empty muted';
      li.textContent = 'No options';
      chip.listEl.append(li);
      return;
    }

    for (const opt of opts) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'filterbar__chip-option';
      btn.setAttribute('role', 'option');
      btn.dataset.quickChipOption = opt.value;
      const checked = selected.has(opt.value);
      btn.setAttribute('aria-selected', checked ? 'true' : 'false');
      if (checked) btn.classList.add('filterbar__chip-option--checked');

      const box = document.createElement('span');
      box.className = 'filterbar__chip-check';
      box.setAttribute('aria-hidden', 'true');
      box.textContent = checked ? '✓' : '';

      const text = document.createElement('span');
      text.className = 'filterbar__chip-option-label';
      text.textContent = opt.label;

      btn.append(box, text);
      this.listen(btn, 'click', () => this.toggleValue(chip, opt.value));
      li.append(btn);
      chip.listEl.append(li);
    }

    chip.popover.reposition();
  }

  /* ------------------------------ mutations ------------------------------ */

  /** Toggle one value in a chip's selection and commit the next predicate. */
  private toggleValue(chip: ChipView, value: string): void {
    const cur = selectedValues(this.peekPredicate(), chip.def.attr);
    const idx = cur.indexOf(value);
    const next = idx >= 0 ? cur.filter((v) => v !== value) : [...cur, value];
    this.commit(chip.def.attr, next);
  }

  /** The clear-X: drop this chip's leaf entirely. */
  private clearChip(chip: ChipView): void {
    if (chip.popover.isOpen) {
      chip.popover.close();
      chip.trigger.setAttribute('aria-expanded', 'false');
    }
    this.commit(chip.def.attr, []); // count→0 + closed popover → repaint folds it away
  }

  /* ------------------------------ + Filter ------------------------------- */

  /** The "+ Filter" trigger + its menu of not-yet-shown chips. Appended after
   *  the chips so it trails the active ones (which collapse when hidden). */
  private buildAddFilter(): void {
    const wrap = document.createElement('div');
    wrap.className = 'filterbar__chip-wrap';
    this.addWrap = wrap;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'filterbar__chip filterbar__add-filter';
    trigger.dataset.addFilter = '';
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', 'Add a filter');
    const plus = document.createElement('span');
    plus.className = 'filterbar__chip-caret';
    plus.setAttribute('aria-hidden', 'true');
    plus.append(icon('plus', 14));
    const label = document.createElement('span');
    label.className = 'filterbar__chip-label';
    label.textContent = 'Filter';
    trigger.append(plus, label);
    wrap.append(trigger);
    this.el.append(wrap);

    const popover = new Popover(trigger, {
      placement: 'bottom-start',
      clampHeight: true,
      onClose: () => trigger.setAttribute('aria-expanded', 'false'),
    });
    this.addPopover = popover;
    const panel = popover.element;
    panel.classList.add('filterbar__chip-panel');
    const list = document.createElement('ul');
    list.className = 'filterbar__chip-list';
    list.setAttribute('role', 'menu');
    panel.append(list);
    this.addListEl = list;

    this.listen(trigger, 'click', () => {
      if (popover.isOpen) {
        popover.close();
        trigger.setAttribute('aria-expanded', 'false');
      } else {
        this.renderAddMenu();
        trigger.setAttribute('aria-expanded', 'true');
        popover.open();
      }
    });
    this.onDestroy(() => popover.destroy());
  }

  /** Populate the "+ Filter" menu: the attribute chips not on the bar, then a
   *  "Saved" section of the project's not-yet-applied saved filters. */
  private renderAddMenu(): void {
    const list = this.addListEl;
    if (list === null) return;
    list.replaceChildren();
    const hidden = this.chips.filter((c) => c.wrap.style.display === 'none');
    const activeSnips = new Set(selectedSnippetIds(this.peekPredicate()));
    const savedAvail = this.snippetOptions(false).filter((s) => !activeSnips.has(s.key));

    for (const chip of hidden) {
      list.append(this.addMenuItem(chip.def.label, () => this.openChip(chip)));
    }
    if (savedAvail.length > 0) {
      const header = document.createElement('li');
      header.className = 'filterbar__chip-menu-header muted';
      header.textContent = 'Saved';
      list.append(header);
      for (const s of savedAvail) {
        list.append(this.addMenuItem(s.title, () => this.toggleSnippet(s.id, true)));
      }
    }
    if (hidden.length === 0 && savedAvail.length === 0) {
      const li = document.createElement('li');
      li.className = 'filterbar__chip-empty muted';
      li.textContent = 'All filters added';
      list.append(li);
    }
    this.addPopover?.reposition();
  }

  /** A "+ Filter" menu row that closes the menu and runs [onPick]. */
  private addMenuItem(label: string, onPick: () => void): HTMLLIElement {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filterbar__chip-option';
    btn.setAttribute('role', 'menuitem');
    const text = document.createElement('span');
    text.className = 'filterbar__chip-option-label';
    text.textContent = label;
    btn.append(text);
    this.listen(btn, 'click', () => {
      this.addPopover?.close();
      onPick();
    });
    li.append(btn);
    return li;
  }

  /* ---------------------------- saved filters ---------------------------- */

  private snippetsSegs(): string[] {
    return splitPath(this.config.snippetsPath ?? 'screen.snippets');
  }

  /** (Re)load the project's predicate_snippet cards into the snippets leaf,
   *  deduped on the project key. No-op when no snippetsPath is configured. */
  private loadSnippets(): void {
    if (this.config.snippetsPath === '') return;
    const pid =
      this.ctx.tree
        .at(splitPath(this.config.projectIdPath ?? 'scope.projectId'))
        .get<bigint | null>() ?? null;
    const key = pid === null ? 'none' : pid.toString();
    if (key === this.loadedSnippetKey) return;
    this.loadedSnippetKey = key;
    const node = this.ctx.tree.at(this.snippetsSegs());
    if (pid === null) {
      node.set([]);
      return;
    }
    this.ctx.api.callByName(
      'card.select_with_attributes',
      { cardTypeName: 'predicate_snippet', parentCardId: pid },
      (out) => node.set(((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? []),
      { alive: () => this.isAlive() },
    );
  }

  /** The loaded saved filters as {id, key, title}. `reactive` subscribes (use in
   *  the sync effect); the no-arg/peek form is also the test/host hook. */
  snippetOptions(reactive = false): { id: bigint; key: string; title: string }[] {
    const leaf = this.ctx.tree.at(this.snippetsSegs());
    const rows = (reactive ? leaf.get<CardWithAttrs[]>() : leaf.peek<CardWithAttrs[]>()) ?? [];
    return rows.map((r) => {
      const t = r.attributes?.['title'];
      return {
        id: r.id,
        key: r.id.toString(),
        title: typeof t === 'string' && t.length > 0 ? t : `#${r.id.toString()}`,
      };
    });
  }

  /** Add/remove snippet chips so the bar reflects the active snippet leaves. */
  private reconcileSnippetChips(predicate: Predicate | null): void {
    const active = new Set(selectedSnippetIds(predicate));
    const byKey = new Map(this.snippetOptions(true).map((s) => [s.key, s]));
    for (const [key, wrap] of this.snippetChips) {
      if (!active.has(key)) {
        wrap.remove();
        this.snippetChips.delete(key);
      }
    }
    for (const key of active) {
      if (this.snippetChips.has(key)) continue;
      const opt = byKey.get(key) ?? { id: BigInt(key), key, title: `#${key}` };
      this.snippetChips.set(key, this.buildSnippetChip(opt));
    }
  }

  /** A chip for an active saved filter — label + clear (no value picker). */
  private buildSnippetChip(opt: { id: bigint; key: string; title: string }): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'filterbar__chip-wrap';
    const chip = document.createElement('span');
    chip.className = 'filterbar__chip filterbar__chip--active filterbar__chip--snippet';
    chip.dataset.snippetChip = opt.key;
    const label = document.createElement('span');
    label.className = 'filterbar__chip-label';
    label.textContent = opt.title;
    const clearEl = document.createElement('button');
    clearEl.type = 'button';
    clearEl.className = 'filterbar__chip-clear';
    clearEl.setAttribute('aria-label', `Remove ${opt.title} filter`);
    clearEl.append(icon('x', 12));
    chip.append(label, clearEl);
    wrap.append(chip);
    if (this.addWrap !== null) this.el.insertBefore(wrap, this.addWrap);
    else this.el.append(wrap);
    this.listen(clearEl, 'click', (e) => {
      e.preventDefault();
      this.toggleSnippet(opt.id, false);
    });
    return wrap;
  }

  /** Apply (on) or remove a saved filter, committing the next predicate. */
  private toggleSnippet(id: bigint, on: boolean): void {
    const cur = this.peekPredicate();
    const ids = selectedSnippetIds(cur)
      .map((s) => BigInt(s))
      .filter((x) => x !== id);
    if (on) ids.push(id);
    this.config.onCommit?.(setSelectedSnippets(cur, ids));
  }

  /**
   * Compute the next predicate for [attr] = [values] against the LIVE shared
   * predicate (peeked, not subscribed) and hand it to the host's onCommit.
   * Empty values remove the leaf; otherwise an `in` leaf (multi) / `eq` leaf
   * (single) replaces the top-level slot — composing with the rest of the tree.
   */
  private commit(attr: string, values: string[]): void {
    const cur = this.peekPredicate();
    let next: Predicate | null;
    if (values.length === 0) {
      next = removeTopLevelLeaf(cur, attr);
    } else {
      const newLeaf: PredicateLeaf =
        values.length === 1 ? makeLeaf(attr, 'eq', [values[0]]) : makeLeaf(attr, 'in', values);
      next = upsertTopLevelLeaf(cur, newLeaf);
    }
    this.config.onCommit?.(next);
  }

  /* ----------------------------- test/host hooks ------------------------- */

  /**
   * The stringified values a chip currently reflects for [attr], read from the
   * shared predicate's top-level leaf. The same projection the trigger label +
   * the menu checkboxes use. Test/host hook (mirrors PredicateFilter's
   * currentPredicate()).
   */
  chipValues(attr: string): string[] {
    return selectedValues(this.peekPredicate(), attr);
  }

  /**
   * Toggle [value] in the chip for [attr] and fire onCommit with the next
   * predicate — the exact path a checkbox click takes, without opening the
   * popover (the float lifecycle is exercised by the Popover/Combobox suites).
   * Test/host hook.
   */
  toggleChipValue(attr: string, value: string): void {
    const cur = selectedValues(this.peekPredicate(), attr);
    const idx = cur.indexOf(value);
    const next = idx >= 0 ? cur.filter((v) => v !== value) : [...cur, value];
    this.commit(attr, next);
  }

  /** Clear the chip for [attr] (drop its top-level leaf). Test/host hook. */
  clearChipLeaf(attr: string): void {
    this.commit(attr, []);
  }

  /** The ids of the saved filters (snippets) currently AND-ed into the shared
   *  predicate, as decimal strings. Test/host hook (mirrors the old
   *  NamedFilters.activeSnippetIds()). */
  activeSnippetIds(): string[] {
    return selectedSnippetIds(this.peekPredicate());
  }

  /** Toggle saved filter [id] in/out of the shared predicate and fire onCommit —
   *  the exact path a "Saved" menu item / snippet-chip X takes, without opening
   *  the menu. Test/host hook. */
  toggleSnippetId(id: bigint): void {
    const active = new Set(this.activeSnippetIds());
    this.toggleSnippet(id, !active.has(id.toString()));
  }

  /** Drop every active saved filter at once. Test/host hook. */
  clearSnippets(): void {
    this.config.onCommit?.(setSelectedSnippets(this.peekPredicate(), []));
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The stringified value list a chip should reflect for [attr], read from the
 * top-level leaf. Only `eq` / `in` leaves carry chip values; any other op
 * (the Advanced editor put a `contains` / `exists` / phase leaf there) reflects
 * as an empty selection — the chip won't clobber it, and the Advanced editor
 * still owns it.
 */
function selectedValues(predicate: Predicate | null, attr: string): string[] {
  const leaf = topLevelLeafForAttr(predicate, attr);
  if (leaf === null) return [];
  if (leaf.op !== 'eq' && leaf.op !== 'in') return [];
  return (leaf.values ?? []).map((v) => String(v));
}

export function registerQuickChips(): void {
  Control.register('QuickChips', QuickChips);
}
