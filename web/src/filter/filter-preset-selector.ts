/**
 * FilterPresetSelector — the saved-view picker the ScreenFilterBar mounts in
 * its row 1. A {@link Combobox} listing the screen's saved `filter` cards by
 * title; picking one fires {@link FilterPresetSelectorConfig.onPick} with the
 * chosen filter card id (or null for "Default"). Plus a small action strip the
 * bar wires: Save (current predicate as a new filter card), Set default, and —
 * when cheap — Rename / Delete.
 *
 * Port of the Svelte `FilterPresetSelector.svelte` (presentation-only) + the
 * `ScreenFilterBar.svelte` action handlers (saveAsNew / setActiveAsDefault /
 * renameActive / deleteActive). The control is PRESENTATION + INTENT only: it
 * never calls the API itself. The host (ScreenFilterBar) owns the screen-card
 * id + the saved-filter list and performs the writes from the callbacks — the
 * same separation of concerns the Svelte component used (the parent owns the
 * active id and applies the preset).
 *
 * Cascade-safe: the Combobox emits selection via a plain `onChange` callback
 * (no promise); the bar writes the predicate leaf / fires the optimistic write
 * from there, outside any tracked effect. The selector re-reads its option list
 * + active id from the tree reactively so a save (which appends a filter card)
 * or a back-nav (which restores the active id) repaints the trigger.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { Combobox } from '../ui/combobox.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import { readTitle } from './screen-resolve.js';

export interface FilterPresetSelectorConfig extends BaseControlConfig {
  type: 'FilterPresetSelector';
  /** Tree path holding the saved filter cards (CardWithAttrs[]). Read reactively. */
  filtersPath: string;
  /** Tree path holding the active filter id (bigint|null). Read reactively. */
  activeIdPath: string;
  /** Fired when the user picks a preset (null = the "Default" placeholder). */
  onPick?: (id: bigint | null) => void;
  /** Fired when the user clicks "Save current as new view…". */
  onSave?: () => void;
  /** Fired when the user clicks "Set as default" (no active filter → no-op). */
  onSetDefault?: () => void;
  /** Fired on Rename (deferred-but-cheap; bar wires the prompt + write). */
  onRename?: () => void;
  /** Fired on Delete (deferred-but-cheap; bar wires the confirm + write). */
  onDelete?: () => void;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    FilterPresetSelector: FilterPresetSelectorConfig;
  }
}

export class FilterPresetSelector extends Control<FilterPresetSelectorConfig> {
  private combo: Combobox<string> | null = null;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'filter-preset';
    el.dataset.control = 'FilterPresetSelector';
    return el;
  }

  protected render(): void {
    const label = document.createElement('span');
    label.className = 'filter-preset__label muted';
    label.textContent = 'View';
    this.el.append(label);

    // The Combobox of saved presets. Options + value sync reactively from the
    // tree (a save appends a filter; back-nav restores the active id).
    const comboHost = document.createElement('div');
    comboHost.className = 'filter-preset__combo';
    this.el.append(comboHost);
    this.combo = this.spawn(
      'Combobox',
      {
        type: 'Combobox',
        placeholder: 'Default',
        'aria-label': 'Saved filter preset',
        onChange: (v: string | null) => this.onPick(v),
      },
      comboHost,
    ) as Combobox<string>;

    // Reactively re-sync the Combobox options from the filters list AND the
    // active id from the cache leaf, and (re)publish the view-action footer
    // buttons with their current enabled state. One-way derive: reads the two
    // leaves + writes only the combo's imperative state (never a watched dep).
    // The "⋯" overflow menu is gone — Save / Set default / Rename / Delete now
    // live in the footer of the "View" dropdown (#4); the bar still owns the
    // writes via the callbacks, this control stays presentation + intent only.
    const filtersNode = this.ctx.tree.at(this.config.filtersPath.split('.'));
    const activeNode = this.ctx.tree.at(this.config.activeIdPath.split('.'));
    this.effect(() => {
      const filters = (filtersNode.get<CardWithAttrs[]>() ?? []) as CardWithAttrs[];
      const activeId = activeNode.get<bigint | null>() ?? null;
      const options = filters.map((f) => ({ value: f.id.toString(), label: readTitle(f) }));
      // Rebuild the combo's static options + selected value (setOptions does not
      // fire onChange — purely programmatic sync).
      this.combo?.setOptions(options);
      this.combo?.setValue(activeId === null ? null : activeId.toString());
      // The active-only actions disable when nothing is selected.
      const enabled = activeId !== null;
      this.combo?.setFooterActions([
        { label: 'Save current as new view…', onRun: () => this.config.onSave?.() },
        { label: 'Set as default', onRun: () => this.config.onSetDefault?.(), disabled: !enabled },
        { label: 'Rename…', onRun: () => this.config.onRename?.(), disabled: !enabled },
        { label: 'Delete…', onRun: () => this.config.onDelete?.(), disabled: !enabled, variant: 'danger' },
      ]);
    }, 'filterPreset.sync');
  }

  private onPick(v: string | null): void {
    if (v === null || v === '') {
      this.config.onPick?.(null);
      return;
    }
    try {
      this.config.onPick?.(BigInt(v));
    } catch {
      /* unparseable id — ignore (matches the Svelte selector's guard) */
    }
  }

}

export function registerFilterPresetSelector(): void {
  Control.register('FilterPresetSelector', FilterPresetSelector);
}
