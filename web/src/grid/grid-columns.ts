/**
 * GridColumns — the Grid's "Columns" chooser (per-screen show/hide + reorder),
 * mounted on the filter bar's "View" row via the ScreenFilterBar `viewActions`
 * seam (the same mechanism Inbox uses for its toggles), NOT inside the Grid
 * body. It is a pure leaf editor: it reads the data-driven column set from
 * `screen.refAxes` / `screen.attrSchema` / `screen.extraColumns` /
 * `screen.tagPrefixColumns` and writes the user's choices to
 * `screen.columnConfig` (`{ hidden, order, widths }`). The Grid's `grid.columns`
 * effect watches that same leaf and rebuilds the table — so this control needs
 * no reference to the Grid instance; the shared tree is the only coupling.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { Popover } from '../ui/popover.js';
import { buildGridColumns, type ColumnDef } from './grid-helpers.js';
import type { RefAxis } from '../filter/vocabulary.js';
import type { AttrSchema } from '../filter/attribute-schema.js';

export interface GridColumnsConfig extends BaseControlConfig {
  type: 'GridColumns';
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    GridColumns: GridColumnsConfig;
  }
}

interface ColumnConfig {
  hidden: string[];
  order: string[];
  widths: Record<string, number>;
}

export class GridColumns extends Control<GridColumnsConfig> {
  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'grid__columns';
    el.dataset.control = 'GridColumns';
    return el;
  }

  protected render(): void {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn grid__columns-btn';
    btn.dataset.gridColumnsBtn = '';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.textContent = 'Columns';
    this.el.append(btn);

    const pop = new Popover(btn, {
      placement: 'bottom-end',
      clampHeight: true,
      onClose: () => btn.setAttribute('aria-expanded', 'false'),
    });
    pop.element.classList.add('grid__columns-panel');
    this.onDestroy(() => pop.destroy());
    this.listen(btn, 'click', () => {
      if (pop.isOpen) {
        pop.close();
        return;
      }
      this.renderMenu(pop.element);
      btn.setAttribute('aria-expanded', 'true');
      pop.open();
    });
  }

  /* ------------------------------ tree reads ----------------------------- */

  /** The full data-driven column set from the schema + screen config, BEFORE
   *  the user's per-screen hide/reorder (mirrors Grid.rawColumns). */
  private rawColumns(): ColumnDef[] {
    const refAxes = (this.ctx.tree.at(['screen', 'refAxes']).peek<RefAxis[]>() ?? []) as RefAxis[];
    const schema = (this.ctx.tree.at(['screen', 'attrSchema']).peek<AttrSchema[]>() ?? []) as AttrSchema[];
    const extra = (this.ctx.tree.at(['screen', 'extraColumns']).peek<string[]>() ?? []) as string[];
    const tagPrefixes = (this.ctx.tree.at(['screen', 'tagPrefixColumns']).peek<string[]>() ?? []) as string[];
    return buildGridColumns(refAxes, schema, extra, tagPrefixes);
  }

  /** The user's per-screen column config (hidden keys + order + widths). */
  private columnConfig(): ColumnConfig {
    const c =
      this.ctx.tree
        .at(['screen', 'columnConfig'])
        .peek<{ hidden?: string[]; order?: string[]; widths?: Record<string, number> }>() ?? {};
    return { hidden: c.hidden ?? [], order: c.order ?? [], widths: c.widths ?? {} };
  }

  /** All raw column keys in the user's current order (configured keys first). */
  private orderedKeys(): string[] {
    const keys = this.rawColumns().map((c) => c.key);
    const { order } = this.columnConfig();
    if (order.length === 0) return keys;
    const rank = (k: string): number => {
      const i = order.indexOf(k);
      return i >= 0 ? i : order.length + keys.indexOf(k);
    };
    return keys.slice().sort((a, b) => rank(a) - rank(b));
  }

  /* ------------------------------ tree writes ---------------------------- */

  private toggleHidden(key: string): void {
    const cfg = this.columnConfig();
    const set = new Set(cfg.hidden);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    this.ctx.tree.at(['screen', 'columnConfig']).set({ ...cfg, hidden: [...set] });
  }

  private moveColumn(key: string, dir: -1 | 1): void {
    const keys = this.orderedKeys();
    const i = keys.indexOf(key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= keys.length) return;
    const a = keys[i];
    const b = keys[j];
    if (a === undefined || b === undefined) return;
    keys[i] = b;
    keys[j] = a;
    this.ctx.tree.at(['screen', 'columnConfig']).set({ ...this.columnConfig(), order: keys });
  }

  /* -------------------------------- menu --------------------------------- */

  /** (Re)render the Columns menu: a visible checkbox + ↑/↓ reorder per column. */
  private renderMenu(panel: HTMLElement): void {
    const byKey = new Map(this.rawColumns().map((c) => [c.key, c]));
    const hide = new Set(this.columnConfig().hidden);
    const ordered = this.orderedKeys();
    const list = document.createElement('div');
    list.className = 'grid__columns-list';
    ordered.forEach((key, i) => {
      const col = byKey.get(key);
      if (col === undefined) return;
      const row = document.createElement('div');
      row.className = 'grid__columns-row';
      row.dataset.gridColumnsRow = key;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'grid__columns-visible';
      cb.dataset.gridColumnVisible = key;
      cb.checked = !hide.has(key);
      this.listen(cb, 'change', () => {
        this.toggleHidden(key);
        this.renderMenu(panel);
      });
      const label = document.createElement('span');
      label.className = 'grid__columns-label';
      label.textContent = col.label;
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'grid__columns-move';
      up.textContent = '↑';
      up.disabled = i === 0;
      up.setAttribute('aria-label', `Move ${col.label} up`);
      this.listen(up, 'click', () => {
        this.moveColumn(key, -1);
        this.renderMenu(panel);
      });
      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'grid__columns-move';
      down.textContent = '↓';
      down.disabled = i === ordered.length - 1;
      down.setAttribute('aria-label', `Move ${col.label} down`);
      this.listen(down, 'click', () => {
        this.moveColumn(key, 1);
        this.renderMenu(panel);
      });
      row.append(cb, label, up, down);
      list.append(row);
    });
    panel.replaceChildren(list);
  }
}

export function registerGridColumns(): void {
  Control.register('GridColumns', GridColumns);
}
