/**
 * NamedFilters — the "Named" multi-select the ScreenFilterBar pins alongside the
 * quick chips. It toggles reusable predicate-fragment leaves (`snippet` op →
 * `predicate_snippet` cards) on the SAME `screen.predicate` tree the quick
 * chips, the Advanced editor, and the saved-view presets all edit.
 *
 * A snippet is a `predicate_snippet` card parented to the project; its `title`
 * is the human label shown in the dropdown and its `predicate` attribute holds
 * the JSON predicate fragment the snippet stands for. The CLIENT NEVER expands a
 * snippet: picking one emits a single top-level LEAF carrying the snippet's card
 * id (`{ op:'snippet', values:[id] }` on the wire) — the server's
 * `card_compile_predicate.sql` dispatches on `op='snippet'`, fetches the
 * referenced card's `predicate`, recurses, and cycle-guards. So one snippet id
 * round-trips as one leaf; the expansion + cycle detection live server-side.
 *
 * ONE TREE, MANY SURFACES. Like the quick chips, the multi-select owns no state
 * of its own: it READS the current set of top-level snippet leaves out of
 * `screen.predicate` (reactively) so a change from ANY surface — another
 * surface's edit, applying a named view, Clear — repaints the trigger label +
 * the checkbox list. On a pick it computes the NEXT predicate (one leaf per
 * picked snippet id, AND-ed alongside the rest of the tree) and hands it back
 * through {@link NamedFiltersConfig.onCommit}; the host (ScreenFilterBar) writes
 * it to `screen.predicate` and re-seeds the Advanced editor. Snippet leaves are
 * keyed by snippet id (one leaf per snippet) so multiple snippets AND together
 * and toggling the same snippet twice is idempotent.
 *
 * The snippet card list loads from `card.select_with_attributes
 * { cardTypeName:'predicate_snippet', parentCardId:project }` keyed to the
 * project in `scope.projectId` (reactive: a project flip refetches). The list
 * lands at a tree path so it can be read reactively and shared. NOTHING here
 * touches the network on the hot path beyond the one scoped load; the Popover
 * owns its float lifecycle.
 *
 * Cascade-safe: the only writes are the scoped load's onOk (one-way tree land),
 * the active-state effect (DOM patches), and the `onCommit` callback fired from
 * a click handler (outside any tracked effect). No promise crosses the surface.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { splitPath } from '../core/data.js';
import type { Path } from '../core/tree.js';
import { Popover } from '../ui/popover.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import {
  type Predicate,
  type PredicateLeaf,
} from './predicate.js';

/* -------------------------------------------------------------------------- */
/* Snippet leaf shape + snippet-id-keyed top-level helpers.                    */
/* -------------------------------------------------------------------------- */

/**
 * Sentinel `attr` carried by a snippet leaf. The SQL compiler's snippet branch
 * reads only `op` + `values[0]`, never `attr`, but `toWire` always emits an
 * `attr` for a leaf — so we carry this stable sentinel (matching the Svelte
 * client's `SNIPPET_ATTR`). It lets the editor's attribute combobox tell a
 * snippet leaf apart, and it never collides with a real task attribute name.
 */
export const SNIPPET_ATTR = '_snippet';

/**
 * Build a top-level snippet leaf for [snippetId]. The wire shape (via
 * {@link toWire}) is `{ attr:'_snippet', op:'snippet', values:[<id-as-string>] }`
 * — exactly what `card_compile_predicate.sql` dispatches on (it reads `op` +
 * `values[0]`). The id is stringified so it round-trips through JSON / the
 * card_ref-string wire convention the rest of the predicate layer uses (the SQL
 * compiler accepts a numeric string id).
 */
export function snippetLeaf(snippetId: bigint): PredicateLeaf {
  return { kind: 'leaf', attr: SNIPPET_ATTR, op: 'snippet', values: [snippetId.toString()] };
}

/** True when [p] is a leaf carrying a snippet reference. */
function isSnippetLeaf(p: Predicate): p is PredicateLeaf {
  return p.kind === 'leaf' && p.op === 'snippet';
}

/** The snippet id a snippet leaf references (string form, for set membership). */
function snippetIdOf(leaf: PredicateLeaf): string | null {
  const v = leaf.values?.[0];
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * The stringified snippet ids referenced by TOP-LEVEL snippet leaves in [p] (a
 * bare snippet leaf, or direct snippet-leaf children of a root AND). Snippet
 * leaves buried inside an OR / NOT subtree are NOT reflected — those are the
 * Advanced editor's domain, not the top-bar multi-select's. The same projection
 * the trigger label + the checkbox list use.
 */
export function selectedSnippetIds(p: Predicate | null): string[] {
  if (p === null) return [];
  if (p.kind === 'leaf') {
    if (!isSnippetLeaf(p)) return [];
    const id = snippetIdOf(p);
    return id === null ? [] : [id];
  }
  if (p.connective !== 'and') return [];
  const out: string[] = [];
  for (const c of p.children) {
    if (c.kind === 'leaf' && isSnippetLeaf(c)) {
      const id = snippetIdOf(c);
      if (id !== null) out.push(id);
    }
  }
  return out;
}

/** A normalised view of the root: its direct children as a flat AND. */
function rootChildren(p: Predicate | null): Predicate[] {
  if (p === null) return [];
  if (p.kind === 'leaf') return [p];
  if (p.connective === 'and') return p.children.slice();
  // A top-level OR / NOT — keep it as a single child so snippet leaves AND
  // alongside the whole tree (mirrors the quick-chips rootView posture).
  return [p];
}

/** Re-assemble flat-AND children into a {@link Predicate} (or null when empty). */
function fromRootChildren(children: Predicate[]): Predicate | null {
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { kind: 'group', connective: 'and', children };
}

/**
 * Replace the TOP-LEVEL snippet leaves of [p] with exactly one leaf per id in
 * [ids]. Non-snippet top-level leaves, the search leaf, and any nested groups
 * the Advanced editor built are preserved verbatim; a non-AND root (OR / NOT)
 * is kept as a single child so the new snippet leaves AND alongside it.
 *
 *   - no leaves left → null
 *   - exactly one    → that bare leaf (no needless AND wrapper)
 *   - two or more    → a flat AND group
 *
 * Toggling the same id twice is idempotent (the old leaf is dropped first, then
 * re-added only if still in [ids]). This is the snippet-id analogue of
 * {@link upsertTopLevelLeaf} / {@link removeTopLevelLeaf}, keyed by snippet id
 * rather than attr (every snippet leaf shares the `_snippet` attr).
 */
export function setSelectedSnippets(p: Predicate | null, ids: bigint[]): Predicate | null {
  // Drop every existing top-level snippet leaf; keep the rest of the tree.
  const kept: Predicate[] = rootChildren(p).filter(
    (c) => !(c.kind === 'leaf' && c.op === 'snippet'),
  );
  for (const id of ids) kept.push(snippetLeaf(id));
  return fromRootChildren(kept);
}

/* -------------------------------------------------------------------------- */
/* Config.                                                                     */
/* -------------------------------------------------------------------------- */

export interface NamedFiltersConfig extends BaseControlConfig {
  type: 'NamedFilters';
  /** Dotted tree path holding the shared {@link Predicate} (e.g. 'screen.predicate'). */
  predicatePath: string;
  /**
   * Dotted tree path the loaded `predicate_snippet` cards land under (read
   * reactively by the active-state effect). Default 'screen.snippets'.
   */
  snippetsPath?: string;
  /**
   * Dotted tree path of the project id to scope the snippet load to. Default
   * 'scope.projectId'. A null id loads no snippets (the menu shows the empty
   * state); a project flip refetches.
   */
  projectIdPath?: string;
  /** The trigger label. Default 'Named'. */
  label?: string;
  /**
   * Fired with the NEXT predicate whenever a snippet toggles. The host writes it
   * to the shared predicate + re-seeds the Advanced editor. (Intent only — the
   * control never writes the tree.)
   */
  onCommit?: (next: Predicate | null) => void;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    NamedFilters: NamedFiltersConfig;
  }
}

const SELECT_WITH_ATTRS = 'card.select_with_attributes';

/** One snippet option in the multi-select. */
interface SnippetOption {
  id: bigint;
  /** Stringified id — the set-membership key (matches the leaf's stored value). */
  key: string;
  title: string;
}

/* -------------------------------------------------------------------------- */
/* Control.                                                                    */
/* -------------------------------------------------------------------------- */

export class NamedFilters extends Control<NamedFiltersConfig> {
  private trigger!: HTMLButtonElement;
  private labelEl!: HTMLSpanElement;
  private clearEl!: HTMLButtonElement;
  private popover: Popover | null = null;
  private listEl!: HTMLUListElement;

  /** The last project id a load was issued for — guards a duplicate refetch. */
  private loadedProjectKey: string | null = null;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'filterbar__chip-wrap filterbar__named';
    el.dataset.control = 'NamedFilters';
    return el;
  }

  protected render(): void {
    const label = this.config.label ?? 'Named';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'filterbar__chip filterbar__named-trigger';
    trigger.dataset.namedFilters = '';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', 'Named filters');

    const labelEl = document.createElement('span');
    labelEl.className = 'filterbar__chip-label';
    labelEl.textContent = label;
    trigger.append(labelEl);

    const caret = document.createElement('span');
    caret.className = 'filterbar__chip-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = '▾';
    trigger.append(caret);

    // The clear-X — hidden until at least one snippet is active. Its own button
    // so a click clears WITHOUT opening the menu.
    const clearEl = document.createElement('button');
    clearEl.type = 'button';
    clearEl.className = 'filterbar__chip-clear';
    clearEl.dataset.namedFiltersClear = '';
    clearEl.setAttribute('aria-label', 'Clear named filters');
    clearEl.textContent = '×';
    clearEl.style.display = 'none';
    trigger.append(clearEl);

    this.el.append(trigger);
    this.trigger = trigger;
    this.labelEl = labelEl;
    this.clearEl = clearEl;

    const popover = new Popover(trigger, {
      placement: 'bottom-start',
      width: 'anchor',
      clampHeight: true,
      onClose: () => trigger.setAttribute('aria-expanded', 'false'),
    });
    const panel = popover.element;
    panel.classList.add('filterbar__chip-panel', 'filterbar__named-panel');
    const list = document.createElement('ul');
    list.className = 'filterbar__chip-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-multiselectable', 'true');
    panel.append(list);
    this.popover = popover;
    this.listEl = list;

    this.listen(trigger, 'click', (e) => {
      if (e.target === clearEl) {
        e.preventDefault();
        this.clearAll();
        return;
      }
      if (popover.isOpen) {
        popover.close();
        trigger.setAttribute('aria-expanded', 'false');
      } else {
        this.openMenu();
      }
    });
    this.onDestroy(() => popover.destroy());

    // SCOPED LOAD: (re)load the project's snippet cards whenever the project
    // flips. Reads only the primitive project-id leaf; the onOk lands the rows
    // one-way (never a dep this effect reads), so no cascade. Deduped on the
    // project key so a re-run for the same project doesn't refetch.
    this.effect(() => {
      const projectId = this.readProjectId();
      this.loadSnippets(projectId);
    }, 'namedFilters.load');

    // ACTIVE-STATE: read the shared predicate + the loaded snippet list and
    // repaint the trigger label/count + clear-X + (if open) the checkbox list.
    // One-way — reads the two leaves, writes only DOM. A predicate change from
    // ANY surface lands here, so the multi-select always reflects the tree.
    this.effect(() => {
      const ids = selectedSnippetIds(this.readPredicate());
      const options = this.readSnippets();
      this.paint(ids, options, label);
    }, 'namedFilters.sync');
  }

  /* ------------------------------- tree reads ---------------------------- */

  private readProjectId(): bigint | null {
    return this.ctx.tree.at(this.projectIdPath()).get<bigint | null>() ?? null;
  }

  private readPredicate(): Predicate | null {
    return this.ctx.tree.at(splitPath(this.config.predicatePath)).get<Predicate | null>() ?? null;
  }

  private peekPredicate(): Predicate | null {
    return this.ctx.tree.at(splitPath(this.config.predicatePath)).peek<Predicate | null>() ?? null;
  }

  private readSnippets(): SnippetOption[] {
    const rows = this.ctx.tree.at(this.snippetsPath()).get<CardWithAttrs[]>() ?? [];
    return toOptions(rows);
  }

  private peekSnippets(): SnippetOption[] {
    const rows = this.ctx.tree.at(this.snippetsPath()).peek<CardWithAttrs[]>() ?? [];
    return toOptions(rows);
  }

  private snippetsPath(): Path {
    return splitPath(this.config.snippetsPath ?? 'screen.snippets');
  }

  private projectIdPath(): Path {
    return splitPath(this.config.projectIdPath ?? 'scope.projectId');
  }

  /* ------------------------------- loading ------------------------------- */

  /**
   * Load `predicate_snippet` cards for [projectId] and land them at
   * `snippetsPath`. A null project loads nothing (lands an empty list). Deduped
   * on the project key so the reactive effect re-running for the same project
   * doesn't issue a duplicate read. ZERO-PROMISE: routes through `api.callByName`
   * and lands the rows from onOk (one-way), guarded by the alive check.
   */
  private loadSnippets(projectId: bigint | null): void {
    const key = projectId === null ? 'none' : projectId.toString();
    if (key === this.loadedProjectKey) return;
    this.loadedProjectKey = key;

    const node = this.ctx.tree.at(this.snippetsPath());
    if (projectId === null) {
      node.set([]);
      return;
    }
    this.ctx.api.callByName(
      SELECT_WITH_ATTRS,
      { cardTypeName: 'predicate_snippet', parentCardId: projectId },
      (out) => {
        const rows = ((out ?? {}) as { rows?: CardWithAttrs[] }).rows ?? [];
        node.set(rows);
      },
      { alive: () => this.isAlive() },
    );
  }

  /* ------------------------------ open/paint ----------------------------- */

  private openMenu(): void {
    this.renderMenu(selectedSnippetIds(this.peekPredicate()), this.peekSnippets());
    this.trigger.setAttribute('aria-expanded', 'true');
    this.popover?.open();
  }

  /** Repaint the trigger label/count + clear-X + (if open) the checkbox list. */
  private paint(selectedIds: string[], options: SnippetOption[], label: string): void {
    const count = selectedIds.length;
    if (count === 0) {
      this.labelEl.textContent = label;
      this.trigger.classList.remove('filterbar__chip--active');
      this.clearEl.style.display = 'none';
    } else {
      this.labelEl.textContent = `${label}: ${count}`;
      this.trigger.classList.add('filterbar__chip--active');
      this.clearEl.style.display = '';
    }
    if (this.popover?.isOpen === true) this.renderMenu(selectedIds, options);
  }

  /** Render the multi-select checkbox list. */
  private renderMenu(selectedIds: string[], options: SnippetOption[]): void {
    const selected = new Set(selectedIds);
    this.listEl.replaceChildren();

    if (options.length === 0) {
      const li = document.createElement('li');
      li.className = 'filterbar__chip-empty muted';
      li.textContent = 'No named filters';
      this.listEl.append(li);
      this.popover?.reposition();
      return;
    }

    for (const opt of options) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'filterbar__chip-option';
      btn.setAttribute('role', 'option');
      btn.dataset.namedFiltersOption = opt.key;
      const checked = selected.has(opt.key);
      btn.setAttribute('aria-selected', checked ? 'true' : 'false');
      if (checked) btn.classList.add('filterbar__chip-option--checked');

      const box = document.createElement('span');
      box.className = 'filterbar__chip-check';
      box.setAttribute('aria-hidden', 'true');
      box.textContent = checked ? '✓' : '';

      const text = document.createElement('span');
      text.className = 'filterbar__chip-option-label';
      text.textContent = opt.title;

      btn.append(box, text);
      this.listen(btn, 'click', () => this.toggleSnippet(opt.id));
      li.append(btn);
      this.listEl.append(li);
    }
    this.popover?.reposition();
  }

  /* ------------------------------ mutations ------------------------------ */

  /**
   * Toggle [snippetId] against the LIVE shared predicate (peeked, not
   * subscribed) and hand the next predicate to the host's onCommit. Other
   * snippets + the rest of the tree are preserved.
   */
  private toggleSnippet(snippetId: bigint): void {
    const cur = this.peekPredicate();
    const key = snippetId.toString();
    const curIds = selectedSnippetIds(cur);
    const nextKeys = curIds.includes(key) ? curIds.filter((k) => k !== key) : [...curIds, key];
    this.commit(nextKeys.map((k) => BigInt(k)));
  }

  /** The clear-X / "remove all named filters". */
  private clearAll(): void {
    if (this.popover?.isOpen === true) {
      this.popover.close();
      this.trigger.setAttribute('aria-expanded', 'false');
    }
    this.commit([]);
  }

  /** Compute + emit the next predicate for the snippet-id set [ids]. */
  private commit(ids: bigint[]): void {
    const next = setSelectedSnippets(this.peekPredicate(), ids);
    this.config.onCommit?.(next);
  }

  /* ---------------------------- test/host hooks -------------------------- */

  /** The stringified snippet ids the control currently reflects. Test hook. */
  activeSnippetIds(): string[] {
    return selectedSnippetIds(this.peekPredicate());
  }

  /** Toggle [snippetId] + fire onCommit — the exact path a checkbox takes,
   *  without opening the popover. Test/host hook. */
  toggleSnippetId(snippetId: bigint): void {
    this.toggleSnippet(snippetId);
  }

  /** Drop all snippet leaves (the clear-X path). Test/host hook. */
  clearSnippets(): void {
    this.commit([]);
  }

  /** The loaded snippet options, in list order. Test/host hook. */
  snippetOptions(): SnippetOption[] {
    return this.peekSnippets();
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                    */
/* -------------------------------------------------------------------------- */

/** Read a snippet card's `title` attribute (or `#<id>` when absent). */
function snippetTitle(card: CardWithAttrs): string {
  const t = card.attributes['title'];
  return typeof t === 'string' && t !== '' ? t : `#${card.id.toString()}`;
}

/** Project snippet cards into the multi-select option shape, in list order. */
function toOptions(rows: CardWithAttrs[]): SnippetOption[] {
  return rows.map((r) => ({ id: r.id, key: r.id.toString(), title: snippetTitle(r) }));
}

export function registerNamedFilters(): void {
  Control.register('NamedFilters', NamedFilters);
}
