/**
 * MenuFilter — the inline "contains" search for a dropdown's option list.
 *
 * Every filter dropdown (the quick-filter chips, "+ Filter", Display's Group
 * by / Lanes, the grid column filters, the Activity page menus) is a list of
 * rows that can outgrow the screen — a project with a hundred tags. The menus
 * scroll (Popover clamps to the viewport; inline menus use
 * {@link fitBelowAnchor}), and this helper adds a search field above the rows
 * once the list is long enough to need one.
 *
 * It filters the DOM the owner already rendered, so it composes with any
 * menu without changing how the menu builds its rows. The owner marks:
 *
 *   - each option row with `data-menu-item="<label>"` — the label is what the
 *     query matches (so a trailing count or a check glyph never matches);
 *   - each section heading with `data-menu-section` — hidden while none of
 *     its rows match.
 *
 * and calls {@link apply} after every (re)render, {@link reset} when the menu
 * opens, and {@link focus} once it is shown. Keys: ↓ from the field moves into
 * the rows, ↑/↓ walk the visible rows, ↑ off the first row returns to the
 * field, Enter in the field picks the first match, and typing on a row jumps
 * back to the field.
 *
 * A plain lifecycle helper (not a Control), like Popover: the owner calls
 * {@link destroy} from its onDestroy.
 */

/** A list this long (or longer) gets the search field. */
export const MENU_FILTER_MIN_ITEMS = 8;

/**
 * The one matching rule every dropdown search shares (Combobox included):
 * case-insensitive, and every whitespace-separated term must appear somewhere
 * in the label — "area ui" matches "area/billing/ui". An empty query matches
 * everything.
 */
export function labelMatches(label: string, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter((t) => t !== '');
  if (terms.length === 0) return true;
  const hay = label.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export interface MenuFilterOptions {
  /** Field placeholder; default "Filter…". */
  placeholder?: string;
  /** Show the field once the scope holds this many rows; default {@link MENU_FILTER_MIN_ITEMS}. */
  minItems?: number;
}

export class MenuFilter {
  /** The field wrapper — mount it directly above the rows, inside the menu's
   *  scroll container (it sticks to the top while the rows scroll). */
  readonly el: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly note: HTMLElement;
  private readonly minItems: number;

  private readonly onInput: () => void;
  private readonly onFieldKeydown: (e: Event) => void;
  private readonly onRowKeydown: (e: Event) => void;

  /** @param scope  the element holding the rows (searched in document order) */
  constructor(
    private readonly scope: HTMLElement,
    opts: MenuFilterOptions = {},
  ) {
    this.minItems = opts.minItems ?? MENU_FILTER_MIN_ITEMS;

    const el = document.createElement('div');
    el.className = 'kf-menu-filter';
    el.dataset.menuFilter = '';
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'kf-menu-filter__input';
    input.placeholder = opts.placeholder ?? 'Filter…';
    input.setAttribute('aria-label', 'Filter options');
    input.autocomplete = 'off';
    const note = document.createElement('div');
    note.className = 'kf-menu-filter__empty muted';
    note.textContent = 'No matches';
    note.style.display = 'none';
    el.append(input, note);
    el.style.display = 'none';
    this.el = el;
    this.input = input;
    this.note = note;

    this.onInput = () => this.apply();
    this.onFieldKeydown = (e) => this.handleFieldKeydown(e as KeyboardEvent);
    this.onRowKeydown = (e) => this.handleRowKeydown(e as KeyboardEvent);
    input.addEventListener('input', this.onInput);
    input.addEventListener('keydown', this.onFieldKeydown);
    scope.addEventListener('keydown', this.onRowKeydown);
  }

  /** The current query. */
  get query(): string {
    return this.input.value;
  }

  /** Set the query and re-filter (also the test hook for typing). */
  setQuery(q: string): void {
    this.input.value = q;
    this.apply();
  }

  /**
   * Re-filter after the owner (re)rendered its rows: show the field when the
   * list is long (or a query is active), hide the rows that don't match and
   * the sections left empty, and say "No matches" when nothing does.
   */
  apply(): void {
    const q = this.input.value;
    const entries = this.entries();
    const items = entries.filter((e) => e.kind === 'item');
    this.el.style.display = items.length >= this.minItems || q.trim() !== '' ? '' : 'none';

    let visible = 0;
    for (const e of entries) {
      if (e.kind !== 'item') continue;
      const show = labelMatches(e.el.dataset.menuItem ?? '', q);
      e.el.style.display = show ? '' : 'none';
      if (show) visible++;
    }
    // A section heading shows while any row between it and the next heading does.
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e === undefined || e.kind !== 'section') continue;
      let any = false;
      for (let j = i + 1; j < entries.length; j++) {
        const r = entries[j];
        if (r === undefined || r.kind === 'section') break;
        if (r.el.style.display !== 'none') {
          any = true;
          break;
        }
      }
      e.el.style.display = any ? '' : 'none';
    }
    this.note.style.display = items.length > 0 && visible === 0 ? '' : 'none';
  }

  /** Clear the query (call when the menu opens, before rendering). */
  reset(): void {
    this.input.value = '';
  }

  /** Focus the field when it's showing; returns whether it took focus. */
  focus(): boolean {
    if (this.el.style.display === 'none') return false;
    this.input.focus();
    return true;
  }

  destroy(): void {
    this.input.removeEventListener('input', this.onInput);
    this.input.removeEventListener('keydown', this.onFieldKeydown);
    this.scope.removeEventListener('keydown', this.onRowKeydown);
  }

  /* ---------------------------------------------------------------- internal */

  /** Rows + section headings under the scope, in document order. */
  private entries(): Array<{ kind: 'item' | 'section'; el: HTMLElement }> {
    const out: Array<{ kind: 'item' | 'section'; el: HTMLElement }> = [];
    const walk = (node: HTMLElement): void => {
      for (const child of Array.from(node.children) as HTMLElement[]) {
        if (child.dataset?.menuItem !== undefined) out.push({ kind: 'item', el: child });
        else if (child.dataset?.menuSection !== undefined) out.push({ kind: 'section', el: child });
        else walk(child);
      }
    };
    walk(this.scope);
    return out;
  }

  /** The focusable control of each visible row (its button / checkbox). */
  private visibleTargets(): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const e of this.entries()) {
      if (e.kind !== 'item' || e.el.style.display === 'none') continue;
      const t = focusTarget(e.el);
      if (t !== null) out.push(t);
    }
    return out;
  }

  private handleFieldKeydown(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      const first = this.visibleTargets()[0];
      if (first !== undefined) {
        e.preventDefault();
        first.focus();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.input.value.trim() === '') return;
      this.visibleTargets()[0]?.click();
    }
  }

  private handleRowKeydown(e: KeyboardEvent): void {
    if (e.target === this.input) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const targets = this.visibleTargets();
      const i = targets.findIndex((t) => t === e.target || t.contains(e.target as Node));
      if (i < 0) return;
      e.preventDefault();
      const next = targets[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next !== undefined) next.focus();
      else if (e.key === 'ArrowUp' && this.el.style.display !== 'none') this.input.focus();
      return;
    }
    // Type-to-filter: a printable key on a row moves to the field, which then
    // receives the character.
    if (
      e.key.length === 1 &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      e.key !== ' ' &&
      this.el.style.display !== 'none'
    ) {
      this.input.focus();
    }
  }
}

/** A row's focusable control: the row itself when it is one, else the first
 *  checkbox / button inside it. */
function focusTarget(row: HTMLElement): HTMLElement | null {
  if (row.tagName === 'BUTTON' || row.tagName === 'INPUT') return row;
  return row.querySelector('input') ?? row.querySelector('button');
}
