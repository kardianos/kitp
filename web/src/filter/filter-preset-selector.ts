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
import { Popover } from '../ui/popover.js';
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
  private setDefaultBtn: HTMLButtonElement | null = null;
  private renameBtn: HTMLButtonElement | null = null;
  private deleteBtn: HTMLButtonElement | null = null;

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

    // Actions collapsed behind a "⋯" overflow menu (#4): Save (always) + the
    // active-only Set default / Rename / Delete. The bar owns the writes via the
    // callbacks; this control is presentation + intent only.
    const kebab = document.createElement('button');
    kebab.type = 'button';
    kebab.className = 'btn btn--icon filter-preset__menu-trigger';
    kebab.dataset.filterPresetMenu = '';
    kebab.setAttribute('aria-haspopup', 'menu');
    kebab.setAttribute('aria-expanded', 'false');
    kebab.setAttribute('aria-label', 'View actions');
    kebab.title = 'View actions';
    kebab.textContent = '⋯';
    this.el.append(kebab);

    const menu = new Popover(kebab, {
      placement: 'bottom-end',
      onClose: () => kebab.setAttribute('aria-expanded', 'false'),
    });
    const panel = menu.element;
    panel.classList.add('filter-preset__menu');
    panel.setAttribute('role', 'menu');

    const saveBtn = menuItem('Save current as new view…', 'filter-preset__save');
    const setDefaultBtn = menuItem('Set as default', 'filter-preset__set-default');
    const renameBtn = menuItem('Rename…', 'filter-preset__rename');
    const deleteBtn = menuItem('Delete…', 'filter-preset__delete');
    this.setDefaultBtn = setDefaultBtn;
    this.renameBtn = renameBtn;
    this.deleteBtn = deleteBtn;
    panel.append(saveBtn, setDefaultBtn, renameBtn, deleteBtn);

    const run = (fn?: () => void): void => {
      menu.close();
      fn?.();
    };
    this.listen(saveBtn, 'click', () => run(this.config.onSave));
    this.listen(setDefaultBtn, 'click', () => run(this.config.onSetDefault));
    this.listen(renameBtn, 'click', () => run(this.config.onRename));
    this.listen(deleteBtn, 'click', () => run(this.config.onDelete));
    this.listen(kebab, 'click', () => {
      if (menu.isOpen) {
        menu.close();
      } else {
        kebab.setAttribute('aria-expanded', 'true');
        menu.open();
      }
    });
    this.onDestroy(() => menu.destroy());

    // Reactively re-sync the Combobox options from the filters list AND the
    // active id from the cache leaf. One-way derive: reads the two leaves +
    // writes only DOM / the combo's imperative state (never a watched dep).
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
      // Disable the active-only actions when nothing is selected.
      const enabled = activeId !== null;
      this.setActionEnabled(this.setDefaultBtn, enabled);
      this.setActionEnabled(this.renameBtn, enabled);
      this.setActionEnabled(this.deleteBtn, enabled);
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

  private setActionEnabled(btn: HTMLButtonElement | null, enabled: boolean): void {
    if (btn === null) return;
    btn.disabled = !enabled;
    btn.classList.toggle('is-disabled', !enabled);
  }
}

function menuItem(text: string, cls: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `filter-preset__menu-item ${cls}`;
  b.setAttribute('role', 'menuitem');
  b.textContent = text;
  return b;
}

export function registerFilterPresetSelector(): void {
  Control.register('FilterPresetSelector', FilterPresetSelector);
}
