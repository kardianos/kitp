/**
 * TagsEditor (#36) — the applied-tags editor for the Task detail.
 *
 * Mounts into the TaskDetail's `[data-slot="tags"]` region (the right rail).
 * Tags are a `card_ref[]` attribute (`tags`) whose values are `tag` cards. The
 * editor:
 *
 *   - renders the currently-applied tags as removable chips (seeded from the
 *     focal task's `tags` attribute, label-resolved via `card.search { ids }`);
 *   - removes a chip via `tag.remove { targetCardId, tagCardId }` (OPTIMISTIC —
 *     the chip vanishes immediately; a fault restores it);
 *   - adds a tag via an async Combobox over the project's `tag` cards (a
 *     typeahead `card.search` scoped to the task's parent project), firing
 *     `tag.apply { targetCardId, tagCardId }` (OPTIMISTIC — the chip appears
 *     immediately). The server's mutual-exclusion rule may drop sibling tags;
 *     the returned `removed_tag_ids` are reconciled into the chip set on success.
 *
 * The dedicated `tag.apply` / `tag.remove` specs are used (NOT a bare
 * `attribute.update`) so the server's edge / project-scope / mutual-exclusion
 * checks run. After a mutation the parent's `onChanged` lets the TaskDetail
 * refresh siblings (the activity feed) and patch its own copy of the attribute.
 *
 * Cascade-safe + declarative + ZERO-PROMISE: every load / mutation routes
 * through `api.callByName(..., onOk, { alive, onErr })`; no `.then` / `await`.
 *
 * Reference (NOT imported): the Svelte client's tag chips + the `tag.apply` /
 * `tag.remove` handlers.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { Combobox, type ComboboxOption } from '../ui/combobox.js';
import { splitPath } from '../core/data.js';
import { CARD_SEARCH_SPEC, type CardSearchOutput } from '../ui/specs.js';
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
  /** Known labels for the initial tags, keyed by stringified id. */
  initialLabels?: Record<string, string>;
  /**
   * Dotted tree path holding the `bigint | null` parent (project) card id; when
   * set + non-null, scopes the add-Combobox `card.search` to the project's tag
   * cards. Peeked at fire time (mirrors the RefPicker's `parentScopePath`).
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

/* -------------------------------------------------------------------------- */
/* Control.                                                                     */
/* -------------------------------------------------------------------------- */

export class TagsEditor extends Control<TagsEditorConfig> {
  private readonly cardId: bigint | null;
  private readonly onChanged?: (tagIds: bigint[]) => void;

  /** Currently-applied tag ids (insertion order). */
  private applied: bigint[] = [];
  /** Label cache: stringified tag id → display label. */
  private readonly labels = new Map<string, string>();
  /** True while any apply / remove is in flight (disables the add control). */
  private busy = false;
  /** Monotonic gate so a stale add-search delivery resolves to a no-op. */
  private searchSeq = 0;

  /* DOM regions held so mutations repaint without a full re-render. */
  private chipsHost!: HTMLElement;
  private addHost!: HTMLElement;
  private combo: Combobox<bigint> | null = null;

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
        if (typeof v === 'string') this.labels.set(k, v);
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

    const chips = document.createElement('div');
    chips.className = 'tags-editor__chips';
    chips.dataset.tagsChips = '';
    this.chipsHost = chips;
    body.append(chips);

    const addHost = document.createElement('div');
    addHost.className = 'tags-editor__add';
    addHost.dataset.tagsAdd = '';
    this.addHost = addHost;
    body.append(addHost);

    this.el.append(body);

    this.paintChips();
    this.mountAdd();
    // Resolve labels for any seeded tag ids we don't have a label for yet.
    this.resolveLabels();
  }

  /* ------------------------------- labels ------------------------------- */

  /** One `card.search { cardTypeName: 'tag', ids }` to resolve missing labels. */
  private resolveLabels(): void {
    const need = this.applied.filter((id) => !this.labels.has(String(id)));
    if (need.length === 0) return;
    this.ctx.api.callByName(
      CARD_SEARCH_SPEC,
      { cardTypeName: 'tag', ids: need },
      (out) => {
        if (!this.isAlive()) return;
        const rows = (out as CardSearchOutput).rows ?? [];
        for (const r of rows) this.labels.set(String(r.id), r.title);
        this.paintChips();
      },
      { alive: () => this.isAlive() },
    );
  }

  private labelFor(id: bigint): string {
    return this.labels.get(String(id)) ?? `#${id.toString()}`;
  }

  /* -------------------------------- chips ------------------------------- */

  private paintChips(): void {
    this.chipsHost.replaceChildren();
    if (this.applied.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'tags-editor__empty muted';
      empty.dataset.tagsEmpty = '';
      empty.textContent = 'No tags';
      this.chipsHost.append(empty);
      return;
    }
    for (const id of this.applied) {
      const chip = document.createElement('span');
      chip.className = 'tags-editor__chip';
      chip.dataset.tagChip = id.toString();

      const label = document.createElement('span');
      label.className = 'tags-editor__chip-label';
      label.textContent = this.labelFor(id);
      chip.append(label);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'tags-editor__chip-remove';
      remove.dataset.tagRemove = id.toString();
      remove.setAttribute('aria-label', `Remove ${this.labelFor(id)}`);
      remove.textContent = '×';
      remove.disabled = this.busy;
      this.listen(remove, 'click', () => this.removeTag(id));
      chip.append(remove);

      this.chipsHost.append(chip);
    }
  }

  /* --------------------------------- add -------------------------------- */

  private mountAdd(): void {
    const cb = new Combobox<bigint>(
      'Combobox',
      {
        type: 'Combobox',
        value: null,
        placeholder: 'Add tag…',
        'aria-label': 'Add tag',
        ...(this.busy ? { disabled: true } : {}),
        loadOptions: (query: string, deliver: (opts: ComboboxOption<bigint>[]) => void): void => {
          this.runSearch(query, deliver);
        },
        onChange: (v: bigint | null): void => {
          if (v === null) return;
          this.applyTag(v);
          this.combo?.setValue(null);
        },
      },
      this.ctx,
    );
    this.combo = cb;
    cb.parent = this;
    this.children.add(cb);
    cb.mount(this.addHost);
  }

  /** Fire `card.search` over `tag` cards (project-scoped) for the add menu. */
  private runSearch(query: string, deliver: (opts: ComboboxOption<bigint>[]) => void): void {
    const seq = ++this.searchSeq;
    const input: Record<string, unknown> = { cardTypeName: 'tag' };
    if (query !== '') input['query'] = query;
    const parent = this.peekParentScope();
    if (parent !== null) input['parentCardId'] = parent;

    this.ctx.api.callByName(
      CARD_SEARCH_SPEC,
      input,
      (out) => {
        if (seq !== this.searchSeq) return; // superseded
        const rows = (out as CardSearchOutput).rows ?? [];
        const opts = rows
          // Hide already-applied tags from the add menu.
          .filter((r) => !this.applied.some((id) => id === r.id))
          .map((r) => {
            this.labels.set(String(r.id), r.title);
            return { value: r.id, label: r.title };
          });
        deliver(opts);
      },
      { alive: () => this.isAlive() },
    );
  }

  private peekParentScope(): bigint | null {
    if (this.config.parentScopePath === undefined) return null;
    const v = this.ctx.tree.at(splitPath(this.config.parentScopePath)).peek<bigint | null>();
    return v ?? null;
  }

  /* ------------------------------ mutations ----------------------------- */

  /**
   * Apply a tag via `tag.apply`, OPTIMISTICALLY: append the chip immediately;
   * on success reconcile the server's `removed_tag_ids` (mutual-exclusion) into
   * the chip set; on fault drop the optimistic chip.
   */
  private applyTag(tagId: bigint): void {
    if (this.cardId === null) return;
    if (this.applied.some((id) => id === tagId)) return; // dedupe
    const prev = this.applied.slice();
    this.applied = [...this.applied, tagId];
    this.busy = true;
    this.paintChips();

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
        this.paintChips();
        this.resolveLabels();
        this.onChanged?.(this.applied.slice());
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          if (!this.isAlive()) return;
          this.applied = prev;
          this.busy = false;
          this.paintChips();
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
    this.paintChips();

    this.ctx.api.callByName(
      TAG_REMOVE_SPEC,
      { targetCardId: this.cardId, tagCardId: tagId },
      (out) => {
        void (out as TagRemoveOutput);
        if (!this.isAlive()) return;
        this.busy = false;
        this.paintChips();
        this.onChanged?.(this.applied.slice());
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          if (!this.isAlive()) return;
          this.applied = prev;
          this.busy = false;
          this.paintChips();
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

export function registerTagsEditor(): void {
  Control.register('TagsEditor', TagsEditor);
}
