/**
 * TagsEditor (#36) — the applied-tags editor for the Task detail, laid out as
 * a COMPACT MINI-GRID: one row per tag prefix, prefix label on the left and
 * the slot's chips + add-control on the right (single CSS grid, no nested
 * card stacks). Sibling chrome (the attribute panel + Related panel) reads
 * the same flat layout, so the whole right rail stays in one register.
 *
 * Mounts into the TaskDetail's `[data-slot="tags"]` region. Tags are a
 * `card_ref[]` attribute (`tags`) whose values are `tag` cards with a `path`
 * like `priority/high` and an optional `color` (named palette tone) the
 * admin Values screen sets. The editor:
 *
 *   - loads the project's full tag catalogue once at mount via
 *     `card.select_with_attributes { cardTypeName: 'tag', parentCardId: <scope> }`
 *     — `card.search` only returns `{id, title}` and we need `color` too, so the
 *     attribute-aware select is the right call;
 *   - groups the union of catalogue + applied tags by prefix; each prefix
 *     becomes a SLOT row in the mini-grid;
 *   - renders one row per slot — prefix on the left, applied chips (suffix
 *     labels via the SHARED `.tag-chip` styling, coloured by the tag's `color`
 *     attribute) + a small add-Combobox restricted to that slot's unapplied
 *     tags on the right;
 *   - tags whose path has no `/` collect into a trailing "other" slot;
 *   - removes a chip via `tag.remove { targetCardId, tagCardId }` (OPTIMISTIC);
 *   - adds a tag via the slot's Combobox, firing `tag.apply` (OPTIMISTIC).
 *     The server's mutual-exclusion rule may drop sibling tags; the returned
 *     `removed_tag_ids` are reconciled into the chip set on success.
 *
 * The dedicated `tag.apply` / `tag.remove` specs run the server's edge /
 * project-scope / mutual-exclusion checks. After a mutation the parent's
 * `onChanged` lets the TaskDetail refresh siblings (the activity feed) and
 * patch its own copy of the attribute.
 *
 * Cascade-safe + declarative + ZERO-PROMISE: every load / mutation routes
 * through `api.callByName(..., onOk, { alive, onErr })`; no `.then` / `await`.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { Combobox, type ComboboxOption } from '../ui/combobox.js';
import { splitPath } from '../core/data.js';
import { SPEC, type SelectWithAttributesOutput } from '../kanban/specs.js';
import {
  TAG_APPLY_SPEC,
  TAG_REMOVE_SPEC,
  type TagApplyOutput,
  type TagRemoveOutput,
} from './attachment-specs.js';

/* -------------------------------------------------------------------------- */
/* Config + declaration-merged registry type.                                  */
/* -------------------------------------------------------------------------- */

export interface TagsEditorConfig extends BaseControlConfig {
  type: 'TagsEditor';
  /** The focal card the tags hang off (string → bigint). */
  cardId: string;
  /** Initial applied tag ids (the task's `tags` attribute), as strings. */
  initialTagIds?: string[];
  /** Known paths for the initial tags, keyed by stringified id. */
  initialLabels?: Record<string, string>;
  /**
   * Dotted tree path holding the `bigint | null` parent (project) card id; when
   * set + non-null, scopes the catalogue load to the project's tag cards.
   * Peeked at fire time (mirrors the RefPicker's `parentScopePath`).
   */
  parentScopePath?: string;
  /** Called after a successful apply / remove with the new applied-id list. */
  onChanged?: (tagIds: bigint[]) => void;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    TagsEditor: TagsEditorConfig;
  }
}

/** Sentinel slot key for tag paths that have no `/` prefix. */
const UNGROUPED_KEY = '__ungrouped__';

/* -------------------------------------------------------------------------- */
/* Control.                                                                     */
/* -------------------------------------------------------------------------- */

export class TagsEditor extends Control<TagsEditorConfig> {
  private readonly cardId: bigint | null;
  private readonly onChanged?: (tagIds: bigint[]) => void;

  /** Currently-applied tag ids (insertion order). */
  private applied: bigint[] = [];
  /** Catalogue + label cache: stringified tag id → full path. */
  private readonly paths = new Map<string, string>();
  /** Color cache: stringified tag id → palette tone (`red` / `amber` / …). */
  private readonly colors = new Map<string, string>();
  /** True while any apply / remove is in flight (disables every add control). */
  private busy = false;

  /* DOM regions held so a re-render rebuilds the slot list in place. */
  private bodyEl!: HTMLElement;
  /** The Combobox children indexed by slot key, so a re-paint disposes them. */
  private slotCombos = new Map<string, Combobox<bigint>>();

  constructor(...args: ConstructorParameters<typeof Control<TagsEditorConfig>>) {
    super(...args);
    this.cardId = parseId(this.config.cardId);
    this.onChanged = this.config.onChanged;
    for (const raw of this.config.initialTagIds ?? []) {
      const id = parseId(raw);
      if (id !== null) this.applied.push(id);
    }
    const labels = this.config.initialLabels;
    if (labels) {
      for (const k of Object.keys(labels)) {
        const v = labels[k];
        if (typeof v === 'string') this.paths.set(k, v);
      }
    }
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'tags-editor';
    el.dataset.control = 'TagsEditor';
    el.setAttribute('aria-labelledby', 'tags-heading');
    return el;
  }

  protected render(): void {
    const head = document.createElement('h2');
    head.id = 'tags-heading';
    head.className = 'task-detail__panel-head';
    head.dataset.tagsHeading = '';
    head.textContent = 'TAGS';
    this.el.append(head);

    const body = document.createElement('div');
    body.className = 'tags-editor__body';
    body.dataset.tagsBody = '';
    this.bodyEl = body;
    this.el.append(body);

    this.paintSlots();
    // One-shot project-scoped catalogue load — once it lands, paintSlots
    // re-renders with the full prefix set + per-tag colors + populates the
    // add menus.
    this.loadCatalogue();
  }

  /* ----------------------------- catalogue load ------------------------- */

  /**
   * Load every `tag` card available to the caller (one shot), project-scoped
   * when `parentScopePath` resolves to a value. We use `card.select_with_-`
   * `attributes` rather than `card.search` because we need the tag's `color`
   * attribute — search only returns `{id, title}`. The result defines which
   * prefix slots exist, populates the chip colors, and seeds each slot's
   * add-Combobox options.
   */
  private loadCatalogue(): void {
    const input: Record<string, unknown> = { cardTypeName: 'tag', limit: 500 };
    const parent = this.peekParentScope();
    if (parent !== null) input['parentCardId'] = parent;
    this.ctx.api.callByName(
      SPEC.selectWithAttributes,
      input,
      (out) => {
        if (!this.isAlive()) return;
        const rows = (out as SelectWithAttributesOutput).rows ?? [];
        for (const r of rows) {
          const path = r.attributes['path'];
          if (typeof path === 'string' && path.length > 0) {
            this.paths.set(r.id.toString(), path);
          }
          const color = r.attributes['color'];
          if (typeof color === 'string' && color.length > 0) {
            this.colors.set(r.id.toString(), color);
          }
        }
        this.paintSlots();
      },
      { alive: () => this.isAlive() },
    );
  }

  private peekParentScope(): bigint | null {
    if (this.config.parentScopePath === undefined) return null;
    const v = this.ctx.tree.at(splitPath(this.config.parentScopePath)).peek<bigint | null>();
    return v ?? null;
  }

  /* ------------------------------- slots -------------------------------- */

  /**
   * The set of slot keys (prefixes + the trailing ungrouped sentinel) the
   * editor should render, derived from the union of the catalogue + the
   * applied tags. Catalogue prefixes appear even when nothing is applied so
   * the user sees every available slot. Order: alphabetical, untagged last.
   */
  private slotKeys(): string[] {
    const set = new Set<string>();
    let hasUngrouped = false;
    const addFromPath = (path: string): void => {
      if (path === '') return;
      const i = path.indexOf('/');
      if (i > 0) set.add(path.slice(0, i));
      else hasUngrouped = true;
    };
    for (const p of this.paths.values()) addFromPath(p);
    for (const id of this.applied) {
      const p = this.paths.get(String(id));
      if (p !== undefined) addFromPath(p);
      // Applied id with no path yet — folds into "other" until the load lands.
      else hasUngrouped = true;
    }
    const sorted = [...set].sort();
    if (hasUngrouped) sorted.push(UNGROUPED_KEY);
    return sorted;
  }

  /** Applied tag ids that live in [slotKey] (in the user's insertion order). */
  private appliedInSlot(slotKey: string): bigint[] {
    const out: bigint[] = [];
    for (const id of this.applied) {
      const path = this.paths.get(String(id));
      const k = path === undefined ? UNGROUPED_KEY : prefixOf(path);
      if (k === slotKey) out.push(id);
    }
    return out;
  }

  /** Combobox options for a slot's add menu: catalogue entries with [slotKey]
   *  as prefix, minus already-applied ids, labelled by their suffix. */
  private addOptionsForSlot(slotKey: string): ComboboxOption<bigint>[] {
    const appliedSet = new Set(this.applied.map((id) => id.toString()));
    const opts: ComboboxOption<bigint>[] = [];
    for (const [idStr, path] of this.paths) {
      if (appliedSet.has(idStr)) continue;
      const k = prefixOf(path);
      if (k !== slotKey) continue;
      const id = parseId(idStr);
      if (id === null) continue;
      opts.push({ value: id, label: suffixOf(path, slotKey) });
    }
    opts.sort((a, b) => a.label.localeCompare(b.label));
    return opts;
  }

  /** Chip label for an applied tag in a slot: the suffix after `<prefix>/`,
   *  or the whole path when in the ungrouped slot / before the path is known. */
  private chipLabelFor(id: bigint, slotKey: string): string {
    const path = this.paths.get(String(id));
    if (path === undefined) return `#${id.toString()}`;
    return suffixOf(path, slotKey);
  }

  /* -------------------------------- paint ------------------------------- */

  private paintSlots(): void {
    // Dispose any Combobox children from the prior paint so they don't leak.
    for (const cb of this.slotCombos.values()) this.destroyChild(cb);
    this.slotCombos.clear();
    this.bodyEl.replaceChildren();

    const keys = this.slotKeys();
    if (keys.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'tags-editor__empty muted';
      empty.dataset.tagsEmpty = '';
      empty.textContent = 'No tags available in this project.';
      this.bodyEl.append(empty);
      return;
    }
    for (const key of keys) this.bodyEl.append(this.buildSlotRow(key));
  }

  /**
   * One row in the mini-grid: a flat `<div data-tag-slot="<prefix>">` carrying
   * the label cell + the value cell. Styling lays the body out as a CSS grid
   * with two tracks so the labels align across rows like an attribute panel.
   */
  private buildSlotRow(slotKey: string): HTMLElement {
    const slot = document.createElement('div');
    slot.className = 'tags-editor__slot';
    slot.dataset.tagSlot = slotKey;

    const label = document.createElement('span');
    label.className = 'tags-editor__slot-label muted';
    label.textContent = slotKey === UNGROUPED_KEY ? 'other' : slotKey;
    slot.append(label);

    const value = document.createElement('div');
    value.className = 'tags-editor__slot-value';
    const applied = this.appliedInSlot(slotKey);
    for (const id of applied) value.append(this.buildChip(id, slotKey));
    if (applied.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'tags-editor__slot-empty muted';
      empty.dataset.tagsSlotEmpty = '';
      empty.textContent = '—';
      value.append(empty);
    }
    const addHost = document.createElement('span');
    addHost.className = 'tags-editor__slot-add';
    value.append(addHost);
    this.mountSlotAdd(slotKey, addHost);

    slot.append(value);
    return slot;
  }

  private buildChip(id: bigint, slotKey: string): HTMLElement {
    const chip = document.createElement('span');
    // Use the shared .tag-chip styling so the chip looks identical in the
    // editor, the grid, and the kanban card — coloured by data-tag-color.
    chip.className = 'tag-chip tags-editor__chip';
    chip.dataset.tagChip = id.toString();
    const color = this.colors.get(String(id));
    if (color !== undefined && color !== '') chip.dataset.tagColor = color;
    const path = this.paths.get(String(id));
    if (path !== undefined && path.length > 0) chip.title = path;

    const label = document.createElement('span');
    // Two classes so existing tests that probe `.tags-editor__chip-label`
    // still find it, while the shared `.tag-chip__label` styling applies.
    label.className = 'tag-chip__label tags-editor__chip-label';
    label.textContent = this.chipLabelFor(id, slotKey);
    chip.append(label);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'tag-chip__remove';
    remove.dataset.tagRemove = id.toString();
    remove.setAttribute('aria-label', `Remove ${this.chipLabelFor(id, slotKey)}`);
    remove.textContent = '×';
    remove.disabled = this.busy;
    this.listen(remove, 'click', () => this.removeTag(id));
    chip.append(remove);
    return chip;
  }

  /** Spawn the per-slot add Combobox; options are this slot's unapplied
   *  catalogue entries (static — the catalogue is fully loaded). */
  private mountSlotAdd(slotKey: string, host: HTMLElement): void {
    const options = this.addOptionsForSlot(slotKey);
    const cb = new Combobox<bigint>(
      'Combobox',
      {
        type: 'Combobox',
        value: null,
        options,
        placeholder: options.length === 0 ? '—' : '+',
        'aria-label': `Add ${slotKey === UNGROUPED_KEY ? 'tag' : `${slotKey} tag`}`,
        ...(this.busy || options.length === 0 ? { disabled: true } : {}),
        onChange: (v: bigint | null): void => {
          if (v === null) return;
          this.applyTag(v);
          cb.setValue(null);
        },
      },
      this.ctx,
    );
    cb.parent = this;
    this.children.add(cb);
    cb.mount(host);
    this.slotCombos.set(slotKey, cb);
  }

  /* ------------------------------ mutations ----------------------------- */

  /**
   * Apply a tag via `tag.apply`, OPTIMISTICALLY: append the chip immediately;
   * on success reconcile the server's `removed_tag_ids` (mutual-exclusion) into
   * the chip set; on fault drop the optimistic chip.
   */
  applyTag(tagId: bigint): void {
    if (this.cardId === null) return;
    if (this.applied.some((id) => id === tagId)) return; // dedupe
    const prev = this.applied.slice();
    this.applied = [...this.applied, tagId];
    this.busy = true;
    this.paintSlots();

    this.ctx.api.callByName(
      TAG_APPLY_SPEC,
      { targetCardId: this.cardId, tagCardId: tagId },
      (out) => {
        if (!this.isAlive()) return;
        const removed = (out as TagApplyOutput).removedTagIds ?? [];
        if (removed.length > 0) {
          const drop = new Set(removed.map((r) => r.toString()));
          // Keep the just-applied tag even if it happens to collide.
          this.applied = this.applied.filter(
            (id) => id === tagId || !drop.has(id.toString()),
          );
        }
        this.busy = false;
        this.paintSlots();
        this.onChanged?.(this.applied.slice());
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          if (!this.isAlive()) return;
          this.applied = prev;
          this.busy = false;
          this.paintSlots();
        },
      },
    );
  }

  /**
   * Remove a tag via `tag.remove`, OPTIMISTICALLY: the chip vanishes
   * immediately; a fault restores the prior chip set.
   */
  private removeTag(tagId: bigint): void {
    if (this.cardId === null) return;
    const prev = this.applied.slice();
    this.applied = this.applied.filter((id) => id !== tagId);
    this.busy = true;
    this.paintSlots();

    this.ctx.api.callByName(
      TAG_REMOVE_SPEC,
      { targetCardId: this.cardId, tagCardId: tagId },
      (out) => {
        void (out as TagRemoveOutput);
        if (!this.isAlive()) return;
        this.busy = false;
        this.paintSlots();
        this.onChanged?.(this.applied.slice());
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          if (!this.isAlive()) return;
          this.applied = prev;
          this.busy = false;
          this.paintSlots();
        },
      },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                     */
/* -------------------------------------------------------------------------- */

/** Parse an id string to a positive bigint, or null when malformed. */
function parseId(raw: string | undefined): bigint | null {
  if (raw === undefined || raw === '') return null;
  if (!/^\d+$/.test(raw)) return null;
  try {
    const n = BigInt(raw);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

/** The segment before the first `/`, or the sentinel when there is none. */
function prefixOf(path: string): string {
  const i = path.indexOf('/');
  return i > 0 ? path.slice(0, i) : UNGROUPED_KEY;
}

/** Everything after the first `<slotKey>/`, or the full path for the
 *  ungrouped slot / a mismatch. */
function suffixOf(path: string, slotKey: string): string {
  if (slotKey === UNGROUPED_KEY) return path;
  const pre = `${slotKey}/`;
  return path.startsWith(pre) ? path.slice(pre.length) : path;
}

export function registerTagsEditor(): void {
  Control.register('TagsEditor', TagsEditor);
}
