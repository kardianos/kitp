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

    // ONE reactive effect: reads the shared predicate + the options map and
    // repaints every chip's active state (trigger label/count + the open menu's
    // checkboxes). One-way — reads the two leaves, writes only DOM. A predicate
    // change from ANY surface lands here, so the chips always reflect the tree.
    this.effect(() => {
      const predicate = this.readPredicate();
      const options = this.readOptions();
      for (const chip of this.chips) this.paintChip(chip, predicate, options);
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
    caret.textContent = '▾';
    trigger.append(caret);

    // The clear-X — hidden until the chip has an active leaf. Its own button so
    // a click clears WITHOUT opening the menu.
    const clearEl = document.createElement('button');
    clearEl.type = 'button';
    clearEl.className = 'filterbar__chip-clear';
    clearEl.dataset.quickChipClear = def.attr;
    clearEl.setAttribute('aria-label', `Clear ${def.label} filter`);
    clearEl.textContent = '×';
    clearEl.style.display = 'none';
    trigger.append(clearEl);

    wrap.append(trigger);
    this.el.append(wrap);

    const popover = new Popover(trigger, {
      placement: 'bottom-start',
      width: 'anchor',
      clampHeight: true,
      onClose: () => trigger.setAttribute('aria-expanded', 'false'),
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
      trigger,
      labelEl,
      clearEl,
      popover,
      listEl: list,
      selected: [],
    };

    this.listen(trigger, 'click', (e) => {
      // A click on the clear-X clears the leaf; anywhere else toggles the menu.
      if (e.target === clearEl) {
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
    this.commit(chip.def.attr, []);
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
