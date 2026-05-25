/**
 * RelatedTasksPanel (#36) — task ↔ task relations for the Task detail.
 *
 * Mounts into the TaskDetail's `[data-slot="related"]` region (the right rail).
 * Ports `client/src/ui/widgets/RelatedTasksPanel.svelte` onto the web
 * framework's direct-DOM, callback, zero-promise posture.
 *
 * Data model (two attributes on the CHILD side of a link):
 *   - `parent_task`         : card_ref → another task (nullable).
 *   - `parent_relationship` : text annotation (subtask / blocker / related).
 * The inverse (children) is computed by querying for tasks whose `parent_task`
 * points back at this card.
 *
 * Editing surfaces:
 *   - PARENT: the parent chip + a relationship dropdown (subtask / blocker /
 *     related) + a Remove (×) that clears both attrs. "Set parent" opens a
 *     RefPicker over the project's tasks; picking + saving writes `parent_task`
 *     and `parent_relationship` in one batch (OPTIMISTIC).
 *   - CHILDREN: every task whose `parent_task = me`, each with its own
 *     relationship pill + dropdown + Unlink (clears the child's parent_task).
 *
 * All writes go via `attribute.update` (no new endpoint). The relationship
 * dropdown commits eagerly; set/clear parent commits both attrs. After a write
 * the parent's `onChanged` lets the TaskDetail refresh siblings (the feed).
 *
 * Cascade-safe + declarative + ZERO-PROMISE: every load / write routes through
 * `api.callByName(..., onOk, { alive, onErr })`; no `.then` / `await`.
 *
 * Reference (NOT imported): client/src/ui/widgets/RelatedTasksPanel.svelte.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { SPEC, type SelectWithAttributesOutput, type AttributeUpdateOutput } from '../kanban/specs.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import { CARD_SEARCH_SPEC, type CardSearchOutput } from '../ui/specs.js';
import type { RefPicker } from '../ui/ref-picker.js';

/* -------------------------------------------------------------------------- */
/* Config + declaration-merged registry type.                                  */
/* -------------------------------------------------------------------------- */

export interface RelatedTasksPanelConfig extends BaseControlConfig {
  type: 'RelatedTasksPanel';
  /** The focal task (string → bigint). */
  cardId: string;
  /** The focal task's current `parent_task` id (string), if set. */
  parentTaskId?: string;
  /** The focal task's current `parent_relationship` text. */
  parentRelationship?: string;
  /** Known label for the current parent, shown before any lookup resolves. */
  parentLabel?: string;
  /**
   * Dotted tree path holding the `bigint | null` project card id; when set +
   * non-null, scopes the parent RefPicker's `card.search` to the project's
   * tasks. Peeked at fire time (mirrors the RefPicker's `parentScopePath`).
   */
  parentScopePath?: string;
  /**
   * Called after a successful parent set/clear so the TaskDetail can patch its
   * own copy of `parent_task` / `parent_relationship` + refresh the feed.
   */
  onChanged?: (parentTaskId: bigint | null, relationship: string | null) => void;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    RelatedTasksPanel: RelatedTasksPanelConfig;
  }
}

const RELATIONSHIP_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'subtask', label: 'Sub-task' },
  { value: 'blocker', label: 'Blocker' },
  { value: 'related', label: 'Related' },
];

const DEFAULT_RELATIONSHIP = 'subtask';

/* -------------------------------------------------------------------------- */
/* Control.                                                                     */
/* -------------------------------------------------------------------------- */

export class RelatedTasksPanel extends Control<RelatedTasksPanelConfig> {
  private readonly cardId: bigint | null;
  private readonly onChanged?: (parentTaskId: bigint | null, relationship: string | null) => void;

  /** Current parent task id (null when standalone). */
  private parentId: bigint | null;
  /** Current relationship label on this card's parent link. */
  private relationship: string;
  /** Children — tasks whose `parent_task` is this card. */
  private children_: CardWithAttrs[] = [];
  /** True between the children load fire and its response. */
  private loadingChildren = false;
  /** True while the parent picker is shown (vs. the chip / "Set parent"). */
  private parentPickerOpen = false;
  /** Pending relationship while picking a parent (seeded from current). */
  private pendingRelationship = DEFAULT_RELATIONSHIP;
  /** The pending picked parent id (from the RefPicker). */
  private pendingParentId: bigint | null = null;

  /** Label cache: stringified task id → display title. */
  private readonly labels = new Map<string, string>();
  /** True while a parent set/clear write is in flight. */
  private busy = false;

  /* DOM regions held so writes / loads repaint without a full re-render. */
  private parentHost!: HTMLElement;
  private childrenHost!: HTMLElement;
  /** Active RefPicker for the parent picker, disposed on close. */
  private parentPicker: RefPicker | null = null;

  constructor(...args: ConstructorParameters<typeof Control<RelatedTasksPanelConfig>>) {
    super(...args);
    this.cardId = parseId(this.config.cardId);
    this.onChanged = this.config.onChanged;
    this.parentId = parseId(this.config.parentTaskId);
    this.relationship =
      typeof this.config.parentRelationship === 'string' && this.config.parentRelationship !== ''
        ? this.config.parentRelationship
        : DEFAULT_RELATIONSHIP;
    if (this.parentId !== null && typeof this.config.parentLabel === 'string') {
      this.labels.set(String(this.parentId), this.config.parentLabel);
    }
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'related-tasks';
    el.dataset.control = 'RelatedTasksPanel';
    el.setAttribute('aria-labelledby', 'related-heading');
    return el;
  }

  protected render(): void {
    const head = document.createElement('h2');
    head.id = 'related-heading';
    head.className = 'task-detail__panel-head';
    head.dataset.relatedHeading = '';
    head.textContent = 'RELATED TASKS';
    this.el.append(head);

    const parentBlock = document.createElement('div');
    parentBlock.className = 'related-tasks__block';
    const parentLabel = document.createElement('div');
    parentLabel.className = 'related-tasks__block-label muted';
    parentLabel.textContent = 'Parent';
    const parentHost = document.createElement('div');
    parentHost.className = 'related-tasks__parent';
    parentHost.dataset.relatedParent = '';
    this.parentHost = parentHost;
    parentBlock.append(parentLabel, parentHost);
    this.el.append(parentBlock);

    const childrenBlock = document.createElement('div');
    childrenBlock.className = 'related-tasks__block';
    const childrenLabel = document.createElement('div');
    childrenLabel.className = 'related-tasks__block-label muted';
    childrenLabel.dataset.relatedChildrenLabel = '';
    childrenLabel.textContent = 'Children';
    const childrenHost = document.createElement('div');
    childrenHost.className = 'related-tasks__children';
    childrenHost.dataset.relatedChildren = '';
    this.childrenHost = childrenHost;
    childrenBlock.append(childrenLabel, childrenHost);
    this.el.append(childrenBlock);

    this.paintParent();
    this.paintChildren();
    this.resolveParentLabel();
    this.loadChildren();
  }

  /* -------------------------------- loads ------------------------------- */

  /** Public refresh hook: reload children (parent state lives in config/local). */
  reload(): void {
    this.loadChildren();
  }

  /** Tasks whose `parent_task` = this card. */
  private loadChildren(): void {
    if (this.cardId === null) {
      this.loadingChildren = false;
      this.paintChildren();
      return;
    }
    this.loadingChildren = true;
    this.paintChildren();
    this.ctx.api.callByName(
      SPEC.selectWithAttributes,
      {
        cardTypeName: 'task',
        where: [{ attr: 'parent_task', op: '=', value: this.cardId }],
      },
      (out) => {
        if (!this.isAlive()) return;
        const rows = (out as SelectWithAttributesOutput).rows ?? [];
        this.children_ = rows.filter((r) => r.id !== this.cardId);
        for (const c of this.children_) {
          const t = c.attributes['title'];
          if (typeof t === 'string') this.labels.set(String(c.id), t);
        }
        this.loadingChildren = false;
        this.paintChildren();
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          if (!this.isAlive()) return;
          this.loadingChildren = false;
          this.paintChildren();
        },
      },
    );
  }

  /** Resolve the parent task's title for the chip when only an id is known. */
  private resolveParentLabel(): void {
    if (this.parentId === null) return;
    if (this.labels.has(String(this.parentId))) return;
    this.ctx.api.callByName(
      CARD_SEARCH_SPEC,
      { cardTypeName: 'task', ids: [this.parentId] },
      (out) => {
        if (!this.isAlive()) return;
        const rows = (out as CardSearchOutput).rows ?? [];
        for (const r of rows) this.labels.set(String(r.id), r.title);
        this.paintParent();
      },
      { alive: () => this.isAlive() },
    );
  }

  private labelFor(id: bigint): string {
    return this.labels.get(String(id)) ?? `#${id.toString()}`;
  }

  /* -------------------------------- parent ------------------------------ */

  private paintParent(): void {
    this.disposeParentPicker();
    this.parentHost.replaceChildren();

    if (this.parentPickerOpen) {
      this.parentHost.append(this.renderParentPicker());
      return;
    }

    if (this.parentId === null) {
      const setBtn = document.createElement('button');
      setBtn.type = 'button';
      setBtn.className = 'related-tasks__link-btn';
      setBtn.dataset.relatedSetParent = '';
      setBtn.textContent = '+ Set parent';
      setBtn.disabled = this.busy;
      this.listen(setBtn, 'click', () => this.openParentPicker());
      this.parentHost.append(setBtn);
      return;
    }

    const row = document.createElement('div');
    row.className = 'related-tasks__chip-row';
    row.dataset.relatedParentRow = '';
    row.dataset.parentId = this.parentId.toString();

    const chip = document.createElement('span');
    chip.className = 'related-tasks__chip';
    chip.dataset.relatedParentChip = '';
    chip.textContent = `#${this.parentId.toString()} ${this.labelFor(this.parentId)}`;
    row.append(chip);

    const pill = this.relationshipDropdown(this.relationship, (next) =>
      this.commitRelationship(next),
    );
    pill.dataset.relatedParentRel = '';
    row.append(pill);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'related-tasks__chip-remove';
    remove.dataset.relatedRemoveParent = '';
    remove.title = 'Remove parent (make standalone)';
    remove.setAttribute('aria-label', 'Remove parent');
    remove.textContent = '×';
    remove.disabled = this.busy;
    this.listen(remove, 'click', () => this.removeParent());
    row.append(remove);

    this.parentHost.append(row);
  }

  private renderParentPicker(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'related-tasks__picker';
    wrap.dataset.relatedParentPicker = '';

    const pickerHost = document.createElement('div');
    pickerHost.className = 'related-tasks__picker-ref';
    wrap.append(pickerHost);

    const rp = this.spawn(
      'RefPicker',
      {
        type: 'RefPicker',
        cardType: 'task',
        value: this.pendingParentId,
        ...(this.parentScopePath() ? { parentScopePath: this.parentScopePath() } : {}),
        'aria-label': 'Parent task',
        placeholder: 'Search tasks…',
        onChange: (value: bigint | null) => {
          this.pendingParentId = value;
          // Toggle Save enablement without a full repaint.
          const save = wrap.querySelector<HTMLButtonElement>('[data-related-save-parent]');
          if (save !== null) save.disabled = this.pendingParentId === null || this.busy;
        },
      },
      pickerHost,
    ) as RefPicker;
    this.parentPicker = rp;

    const controls = document.createElement('div');
    controls.className = 'related-tasks__picker-controls';

    const rel = this.relationshipDropdown(this.pendingRelationship, (next) => {
      this.pendingRelationship = next;
    });
    controls.append(rel);

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary related-tasks__btn';
    save.dataset.relatedSaveParent = '';
    save.textContent = 'Save';
    save.disabled = this.pendingParentId === null || this.busy;
    this.listen(save, 'click', () => {
      if (this.pendingParentId !== null) this.setParent(this.pendingParentId, this.pendingRelationship);
    });
    controls.append(save);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn related-tasks__btn';
    cancel.dataset.relatedCancelParent = '';
    cancel.textContent = 'Cancel';
    this.listen(cancel, 'click', () => {
      this.parentPickerOpen = false;
      this.pendingParentId = null;
      this.paintParent();
    });
    controls.append(cancel);

    wrap.append(controls);
    return wrap;
  }

  private openParentPicker(): void {
    this.parentPickerOpen = true;
    // Snap the pending relationship to the current one so "change parent" keeps
    // the existing classification by default.
    this.pendingRelationship = this.relationship;
    this.pendingParentId = this.parentId;
    this.paintParent();
  }

  private parentScopePath(): string | undefined {
    return this.config.parentScopePath;
  }

  /* ------------------------------- children ----------------------------- */

  private paintChildren(): void {
    this.childrenHost.replaceChildren();
    const label = this.el.querySelector<HTMLElement>('[data-related-children-label]');
    if (label !== null) label.textContent = `Children (${this.children_.length})`;

    if (this.loadingChildren && this.children_.length === 0) {
      const wait = document.createElement('p');
      wait.className = 'related-tasks__loading muted';
      wait.dataset.relatedChildrenLoading = '';
      wait.textContent = 'Loading…';
      this.childrenHost.append(wait);
      return;
    }

    if (this.children_.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'related-tasks__empty muted';
      empty.dataset.relatedChildrenEmpty = '';
      empty.textContent = 'No related tasks yet.';
      this.childrenHost.append(empty);
      return;
    }

    const ul = document.createElement('ul');
    ul.className = 'related-tasks__list';
    ul.dataset.relatedChildrenList = '';
    for (const child of this.children_) ul.append(this.renderChild(child));
    this.childrenHost.append(ul);
  }

  private renderChild(child: CardWithAttrs): HTMLElement {
    const li = document.createElement('li');
    li.className = 'related-tasks__chip-row';
    li.dataset.relatedChildRow = '';
    li.dataset.childId = child.id.toString();

    const rel = relationshipOf(child);

    const chip = document.createElement('span');
    chip.className = 'related-tasks__chip';
    chip.dataset.relatedChildChip = '';
    chip.textContent = `#${child.id.toString()} ${this.labelFor(child.id)}`;
    li.append(chip);

    const pill = document.createElement('span');
    pill.className = `related-tasks__pill related-tasks__pill--${pillTone(rel)}`;
    pill.dataset.relatedChildPill = '';
    pill.textContent = relationshipLabel(rel);
    li.append(pill);

    const dropdown = this.relationshipDropdown(rel, (next) =>
      this.commitChildRelationship(child.id, next),
    );
    li.append(dropdown);

    const unlink = document.createElement('button');
    unlink.type = 'button';
    unlink.className = 'related-tasks__chip-remove';
    unlink.dataset.relatedUnlinkChild = child.id.toString();
    unlink.title = "Unlink (clears child's parent)";
    unlink.setAttribute('aria-label', 'Unlink child');
    unlink.textContent = '×';
    this.listen(unlink, 'click', () => this.unlinkChild(child.id));
    li.append(unlink);

    return li;
  }

  /* ------------------------------- writes ------------------------------- */

  /** Set this task's parent + relationship in one batch (OPTIMISTIC). */
  private setParent(parentId: bigint, relationship: string): void {
    if (this.cardId === null) return;
    const prevId = this.parentId;
    const prevRel = this.relationship;
    this.parentId = parentId;
    this.relationship = relationship;
    this.parentPickerOpen = false;
    this.pendingParentId = null;
    this.busy = true;
    this.paintParent();

    let remaining = 2;
    let failed = false;
    const settle = (ok: boolean): void => {
      if (!ok) failed = true;
      if (--remaining > 0) return;
      if (!this.isAlive()) return;
      this.busy = false;
      if (failed) {
        this.parentId = prevId;
        this.relationship = prevRel;
        this.paintParent();
        return;
      }
      this.paintParent();
      this.resolveParentLabel();
      this.onChanged?.(parentId, relationship);
    };
    this.writeAttr(this.cardId, 'parent_task', parentId, settle);
    this.writeAttr(this.cardId, 'parent_relationship', relationship, settle);
  }

  /** Clear parent_task + parent_relationship — "make standalone" (OPTIMISTIC). */
  private removeParent(): void {
    if (this.cardId === null) return;
    const prevId = this.parentId;
    const prevRel = this.relationship;
    this.parentId = null;
    this.busy = true;
    this.paintParent();

    let remaining = 2;
    let failed = false;
    const settle = (ok: boolean): void => {
      if (!ok) failed = true;
      if (--remaining > 0) return;
      if (!this.isAlive()) return;
      this.busy = false;
      if (failed) {
        this.parentId = prevId;
        this.relationship = prevRel;
        this.paintParent();
        return;
      }
      this.relationship = DEFAULT_RELATIONSHIP;
      this.paintParent();
      this.onChanged?.(null, null);
    };
    this.writeAttr(this.cardId, 'parent_task', null, settle);
    this.writeAttr(this.cardId, 'parent_relationship', null, settle);
  }

  /** Eagerly commit only the parent-link relationship label (OPTIMISTIC). */
  private commitRelationship(next: string): void {
    if (this.cardId === null) return;
    const prev = this.relationship;
    this.relationship = next;
    this.paintParent();
    this.writeAttr(this.cardId, 'parent_relationship', next, (ok) => {
      if (!this.isAlive()) return;
      if (!ok) {
        this.relationship = prev;
        this.paintParent();
        return;
      }
      this.onChanged?.(this.parentId, next);
    });
  }

  /** Change a single child's relationship label (OPTIMISTIC). */
  private commitChildRelationship(childId: bigint, next: string): void {
    const child = this.children_.find((c) => c.id === childId);
    const prev = child ? relationshipOf(child) : DEFAULT_RELATIONSHIP;
    if (child) child.attributes = { ...child.attributes, parent_relationship: next };
    this.paintChildren();
    this.writeAttr(childId, 'parent_relationship', next, (ok) => {
      if (!this.isAlive()) return;
      if (!ok && child) {
        child.attributes = { ...child.attributes, parent_relationship: prev };
        this.paintChildren();
      }
    });
  }

  /** Unlink one child: clear ITS parent_task + parent_relationship (OPTIMISTIC). */
  private unlinkChild(childId: bigint): void {
    const prev = this.children_;
    this.children_ = this.children_.filter((c) => c.id !== childId);
    this.paintChildren();

    let remaining = 2;
    let failed = false;
    const settle = (ok: boolean): void => {
      if (!ok) failed = true;
      if (--remaining > 0) return;
      if (!this.isAlive()) return;
      if (failed) {
        this.children_ = prev;
        this.paintChildren();
        return;
      }
      this.onChanged?.(this.parentId, this.relationship);
    };
    this.writeAttr(childId, 'parent_task', null, settle);
    this.writeAttr(childId, 'parent_relationship', null, settle);
  }

  /** One `attribute.update`; `done(ok)` fires on settle (success or fault). */
  private writeAttr(target: bigint, name: string, value: unknown, done: (ok: boolean) => void): void {
    this.ctx.api.callByName(
      SPEC.attributeUpdate,
      { cardId: target, attributeName: name, value: value ?? null },
      (out) => {
        void (out as AttributeUpdateOutput);
        done(true);
      },
      {
        alive: () => this.isAlive(),
        onErr: () => done(false),
      },
    );
  }

  /* -------------------------------- helpers ----------------------------- */

  /** Build a small relationship `<select>` that calls `onPick` on change. */
  private relationshipDropdown(current: string, onPick: (next: string) => void): HTMLElement {
    const select = document.createElement('select');
    select.className = 'related-tasks__rel-select';
    select.dataset.relatedRelSelect = '';
    select.setAttribute('aria-label', 'Relationship');
    let matched = false;
    for (const opt of RELATIONSHIP_OPTIONS) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === current) {
        o.selected = true;
        matched = true;
      }
      select.append(o);
    }
    if (!matched) {
      // Preserve an arbitrary stored relationship as a leading option.
      const o = document.createElement('option');
      o.value = current;
      o.textContent = current;
      o.selected = true;
      select.prepend(o);
    }
    select.disabled = this.busy;
    this.listen(select, 'change', () => onPick(select.value));
    return select;
  }

  private disposeParentPicker(): void {
    if (this.parentPicker !== null) {
      this.destroyChild(this.parentPicker);
      this.parentPicker = null;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers.                                                                */
/* -------------------------------------------------------------------------- */

/** Parse a config id string to a positive bigint, or null when malformed. */
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

/** Read a child card's relationship label, defaulting to 'subtask'. */
function relationshipOf(c: CardWithAttrs): string {
  const v = c.attributes['parent_relationship'];
  return typeof v === 'string' && v !== '' ? v : DEFAULT_RELATIONSHIP;
}

function relationshipLabel(r: string): string {
  return RELATIONSHIP_OPTIONS.find((x) => x.value === r)?.label ?? r;
}

/** A coarse pill tone for the relationship (matches the Svelte color buckets). */
function pillTone(r: string): 'blocker' | 'related' | 'subtask' {
  if (r === 'blocker') return 'blocker';
  if (r === 'related') return 'related';
  return 'subtask';
}

export function registerRelatedTasksPanel(): void {
  Control.register('RelatedTasksPanel', RelatedTasksPanel);
}
