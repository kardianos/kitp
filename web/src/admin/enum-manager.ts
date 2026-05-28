/**
 * EnumManager — the data-driven "Enums" admin screen (#3). One screen that lets
 * a MANAGER edit the possible values for every card_ref attribute flagged
 * `enum_managed` (milestone / component / tag today; any future flagged
 * attribute appears automatically — nothing hard-coded). For each managed
 * attribute it lists the target card_type's value-cards in the active project,
 * with add / rename / remove.
 *
 * Reuses the existing manager-allowed handlers: `card.select_with_attributes`
 * (list), `card.insert` (add), `attribute.update` (rename `title`), `card.delete`
 * (remove). Scoped to `scope.projectId` (value-cards are project-owned); reloads
 * on a project switch. Zero-promise — every call is `api.callByName(..., onOk,
 * { alive })`.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { ADMIN_SPEC, type AttributeDefListOutput } from './specs.js';
import { SPEC, type SelectWithAttributesOutput } from '../kanban/specs.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import { DropPlaceholder, computeDropTarget } from '../ui/drag-placeholder.js';

export interface EnumManagerConfig extends BaseControlConfig {
  type: 'EnumManager';
  /** Dotted tree path holding the active project id. Default 'scope.projectId'. */
  projectScopePath?: string;
  /** Breadcrumb title (the AppShell reads it for the admin crumb). */
  title?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    EnumManager: EnumManagerConfig;
  }
}

/** One managed enum: a flagged attribute + the card_type whose cards are its values. */
interface ManagedEnum {
  /** Section heading (the target card_type, capitalised). */
  label: string;
  /** The target card_type whose cards are the enum values. */
  cardType: string;
}

export class EnumManager extends Control<EnumManagerConfig> {
  private readonly scopePath: string[];
  /** The flagged attributes' target card_types (deduped). */
  private enums: ManagedEnum[] = [];
  /** Per value-card-type, the names of REQUIRED text attributes (besides title)
   *  that a new value-card must carry — e.g. tag.path. Filled from the schema so
   *  this stays data-driven (no card_type hardcoded); a flat add mirrors the
   *  entered title into each (path = title), which also accepts a slash path. */
  private requiredTextAttrs: Record<string, string[]> = {};
  /** Loaded value-cards per card_type. */
  private cards: Record<string, CardWithAttrs[]> = {};
  /** Draft text for each add-input (keyed by cardType, or `cardType/root` for a
   *  grouped enum's per-group input), preserved across repaints. */
  private addDrafts: Record<string, string> = {};
  /** After an add commits + the list repaints, refocus this add input so the
   *  next value can be typed right away. `group` is the path root for grouped
   *  enums; undefined for a flat enum's single add input. */
  private focusAddFor: { cardType: string; group?: string } | null = null;
  /** Per grouped card_type, text attr names bound to it (detects "grouped" mode:
   *  the type carries both a `path` and a `root_exclusive_at` text edge). */
  private textAttrsByType: Record<string, Set<string>> = {};
  /** Client-side empty groups the user created via "+ New group" but hasn't
   *  added a value to yet (per grouped cardType). They vanish once a value lands
   *  (the group is then real) or on project switch. */
  private pendingGroups: Record<string, string[]> = {};

  private listHost!: HTMLElement;

  /** In-flight value drag (shared DnD kit, same as Inbox/Kanban): the dragged
   *  value-card id + its enum cardType + (grouped) the path-root group it came
   *  from — drag is constrained to one enum, and one group within it. */
  private draggingValueId: bigint | null = null;
  private draggingCardType: string | null = null;
  private draggingGroup: string | null = null;
  /** One gliding placeholder per enum section; recreated each paint. */
  private placeholders: DropPlaceholder[] = [];

  constructor(...args: ConstructorParameters<typeof Control<EnumManagerConfig>>) {
    super(...args);
    this.scopePath = (this.config.projectScopePath ?? 'scope.projectId').split('.');
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'enum-manager';
    el.dataset.control = 'EnumManager';
    return el;
  }

  protected render(): void {
    const head = document.createElement('header');
    head.className = 'enum-manager__head';
    const title = document.createElement('h1');
    title.className = 'enum-manager__title';
    title.textContent = 'Manage values';
    const hint = document.createElement('p');
    hint.className = 'enum-manager__hint muted';
    hint.textContent = 'Add, rename, or remove the allowed values for milestones, components, tags, and any other managed attribute — for the active project.';
    head.append(title, hint);

    const list = document.createElement('div');
    list.className = 'enum-manager__list';
    list.dataset.enumList = '';
    this.listHost = list;

    this.el.append(head, list);
    this.onDestroy(() => {
      for (const p of this.placeholders) p.destroy();
      this.placeholders = [];
    });

    this.loadSchema();
    // Reload value-cards when the active project resolves / changes. One-way:
    // reads scope, writes only this control's DOM + its own load state.
    this.effect(() => {
      this.ctx.tree.at([...this.scopePath]).get();
      this.pendingGroups = {}; // client-side empty groups don't survive a switch
      this.reloadAll();
    }, 'enumManager.scope');
  }

  private projectId(): bigint | null {
    return this.ctx.tree.at([...this.scopePath]).peek<bigint | null>() ?? null;
  }

  /** Load the attribute schema once → the deduped set of managed-enum card_types. */
  private loadSchema(): void {
    this.ctx.api.callByName(
      ADMIN_SPEC.attributeDefSelect,
      {},
      (out) => {
        if (!this.isAlive()) return;
        const rows = (out as AttributeDefListOutput).rows ?? [];
        const seen = new Set<string>();
        const enums: ManagedEnum[] = [];
        for (const r of rows) {
          if (r.enum_managed !== true) continue;
          const ct = r.target_card_type_name;
          if (ct === undefined || ct === '' || seen.has(ct)) continue;
          seen.add(ct);
          enums.push({ cardType: ct, label: capitalise(ct) });
        }
        this.enums = enums;

        // Collect each managed value-card-type's REQUIRED text attributes (other
        // than the dedicated title) so addValue can satisfy them — e.g. a `tag`
        // requires `path`. Schema-driven: any future value-card-type with a
        // required text edge is handled without touching this control.
        const managed = new Set(enums.map((e) => e.cardType));
        const required: Record<string, string[]> = {};
        const textAttrs: Record<string, Set<string>> = {};
        for (const r of rows) {
          if (r.value_type !== 'text') continue;
          for (const b of r.bound_to) {
            if (!managed.has(b.card_type_name)) continue;
            (textAttrs[b.card_type_name] ??= new Set<string>()).add(r.name);
            if (b.is_required === true && r.name !== 'title') {
              (required[b.card_type_name] ??= []).push(r.name);
            }
          }
        }
        this.requiredTextAttrs = required;
        this.textAttrsByType = textAttrs;

        this.reloadAll();
      },
      { alive: () => this.isAlive() },
    );
  }

  /** Load the value-cards for every managed enum, scoped to the active project. */
  private reloadAll(): void {
    const pid = this.projectId();
    if (pid === null || this.enums.length === 0) {
      this.paint();
      return;
    }
    for (const e of this.enums) this.loadEnum(e);
  }

  /** Load ONE enum's value-cards + repaint. Used on its own after an add so the
   *  repaint doesn't race the other enums' loads (which would steal add-focus). */
  private loadEnum(e: ManagedEnum): void {
    const pid = this.projectId();
    if (pid === null) {
      this.paint();
      return;
    }
    this.ctx.api.callByName(
      SPEC.selectWithAttributes,
      // Order by the sort_order ATTRIBUTE so the list reflects the user-chosen
      // order (drag-reorder rewrites sort_order; see moveValueToSlot). `title` is
      // a deterministic secondary key: seed/demo value-cards carry NO sort_order
      // (all null → NULLS LAST), and the select appends no final tiebreaker, so
      // without it equal/unset rows come back in a non-deterministic order. The
      // order fields must be the `attributes.<name>` form — a bare 'sort_order'
      // is rejected ("unsupported order field").
      {
        cardTypeName: e.cardType,
        parentCardId: pid,
        order: [
          { field: 'attributes.sort_order', direction: 'ASC' },
          { field: 'attributes.title', direction: 'ASC' },
        ],
      },
      (out) => {
        if (!this.isAlive()) return;
        this.cards[e.cardType] = (out as SelectWithAttributesOutput).rows ?? [];
        this.paint();
      },
      { alive: () => this.isAlive() },
    );
  }

  private titleOf(card: CardWithAttrs): string {
    const t = card.attributes['title'];
    return typeof t === 'string' ? t : '';
  }

  private paint(): void {
    const host = this.listHost;
    // Discard the previous paint's placeholders (their host rows are about to be
    // replaced); recreated per section below.
    for (const p of this.placeholders) p.destroy();
    this.placeholders = [];
    host.replaceChildren();

    if (this.projectId() === null) {
      host.append(this.note('Select a project to manage its values.'));
      return;
    }
    if (this.enums.length === 0) {
      host.append(this.note('No managed attributes. Flag an attribute as “enum managed” to edit its values here.'));
      return;
    }

    for (const e of this.enums) host.append(this.renderEnum(e));

    // After an add, return focus to that input so the next value can be typed
    // immediately (the add path clears the draft + repaints, dropping focus).
    if (this.focusAddFor !== null) {
      const want = this.focusAddFor;
      this.focusAddFor = null;
      const inputs = (host.querySelectorAll?.('[data-enum-add-input]') ?? []) as unknown as Array<{
        focus?: () => void;
        dataset?: Record<string, string | undefined>;
      }>;
      for (const inp of inputs) {
        if (
          inp.dataset?.enumAddInput === want.cardType &&
          (inp.dataset?.enumAddGroup ?? '') === (want.group ?? '')
        ) {
          if (typeof inp.focus === 'function') inp.focus();
          break;
        }
      }
    }
  }

  private note(text: string): HTMLElement {
    const p = document.createElement('p');
    p.className = 'enum-manager__empty muted';
    p.textContent = text;
    return p;
  }

  /** True when an enum's value-cards are hierarchical + support exclusivity:
   *  the card_type carries BOTH a `path` and a `root_exclusive_at` text edge.
   *  Schema-driven — no card_type name hardcoded (tag qualifies today). */
  private grouped(cardType: string): boolean {
    const s = this.textAttrsByType[cardType];
    return s !== undefined && s.has('path') && s.has('root_exclusive_at');
  }

  /** A card's `path` (falls back to its title when unset). */
  private pathOf(card: CardWithAttrs): string {
    const p = card.attributes['path'];
    return typeof p === 'string' && p !== '' ? p : this.titleOf(card);
  }

  /** A card's `root_exclusive_at` value ('' when unset / non-string). */
  private rootExclusiveOf(card: CardWithAttrs): string {
    const r = card.attributes['root_exclusive_at'];
    return typeof r === 'string' ? r : '';
  }

  private renderEnum(e: ManagedEnum): HTMLElement {
    const section = document.createElement('section');
    section.className = 'enum-manager__group';
    section.dataset.enumGroup = e.cardType;

    const heading = document.createElement('h2');
    heading.className = 'enum-manager__group-title';
    heading.textContent = e.label;
    section.append(heading);

    if (this.grouped(e.cardType)) this.renderGroupedEnum(e, section);
    else this.renderFlatEnum(e, section);
    return section;
  }

  /** Flat enum (milestone / component): one list of value-cards + a single add. */
  private renderFlatEnum(e: ManagedEnum, section: HTMLElement): void {
    const rows = document.createElement('div');
    rows.className = 'enum-manager__values';
    const cards = this.cards[e.cardType] ?? [];
    if (cards.length === 0) {
      rows.append(this.note('No values yet.'));
    } else {
      cards.forEach((card) => rows.append(this.renderValueRow(e, card, null)));
    }
    section.append(rows);
    this.wireReorder(e, null, rows);
    section.append(this.renderAddRow(e, null, `Add ${e.label.toLowerCase()}…`));
  }

  /**
   * Grouped enum (tag): value-cards bucketed by their path root, each bucket a
   * sub-group with a Single-select toggle that drives `root_exclusive_at`. A
   * per-group add prepends the root (path = `root/<typed>`); "+ New group"
   * starts a fresh (client-side) bucket. Reorder is constrained within a group.
   */
  private renderGroupedEnum(e: ManagedEnum, section: HTMLElement): void {
    const groups = this.groupsOf(e);
    const realRoots = new Set(groups.map((g) => g.root));
    for (const root of this.pendingGroups[e.cardType] ?? []) {
      if (!realRoots.has(root)) groups.push({ root, members: [] });
    }
    groups.sort((a, b) => a.root.localeCompare(b.root));

    if (groups.length === 0) {
      section.append(this.note('No values yet. Add a group to get started.'));
    }
    for (const g of groups) section.append(this.renderGroupBlock(e, g.root, g.members));
    section.append(this.renderNewGroup(e));
  }

  /** Bucket an enum's loaded cards by path root, preserving sort_order within. */
  private groupsOf(e: ManagedEnum): Array<{ root: string; members: CardWithAttrs[] }> {
    const order: string[] = [];
    const byRoot: Record<string, CardWithAttrs[]> = {};
    for (const card of this.cards[e.cardType] ?? []) {
      const root = pathRoot(this.pathOf(card));
      if (byRoot[root] === undefined) {
        byRoot[root] = [];
        order.push(root);
      }
      byRoot[root]!.push(card);
    }
    return order.map((root) => ({ root, members: byRoot[root]! }));
  }

  private renderGroupBlock(e: ManagedEnum, root: string, members: CardWithAttrs[]): HTMLElement {
    const block = document.createElement('div');
    block.className = 'enum-manager__subgroup';
    block.dataset.enumSubgroup = root;

    const head = document.createElement('div');
    head.className = 'enum-manager__subgroup-head';
    const name = document.createElement('span');
    name.className = 'enum-manager__subgroup-name';
    name.textContent = root;

    // Single-select toggle: ON when every member is exclusive at this root.
    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'enum-manager__exclusive';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.dataset.enumExclusive = root;
    const exclusive = members.length > 0 && members.every((c) => this.rootExclusiveOf(c) === root);
    toggle.checked = exclusive;
    toggle.disabled = members.length === 0; // nothing to make exclusive yet
    const toggleText = document.createElement('span');
    toggleText.textContent = 'Single-select';
    toggleLabel.append(toggle, toggleText);
    this.listen(toggle, 'change', () => this.setGroupExclusive(root, members, toggle.checked));
    head.append(name, toggleLabel);
    block.append(head);

    const rows = document.createElement('div');
    rows.className = 'enum-manager__values';
    if (members.length === 0) rows.append(this.note('No values yet.'));
    else members.forEach((card) => rows.append(this.renderValueRow(e, card, root)));
    block.append(rows);
    this.wireReorder(e, root, rows);

    block.append(this.renderAddRow(e, root, `Add to ${root}…`));
    return block;
  }

  /** The "+ New group" control: names a fresh (client-side) bucket the user can
   *  then add values to (the bucket persists once its first value lands). */
  private renderNewGroup(e: ManagedEnum): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'enum-manager__new-group';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'enum-manager__add-input';
    input.dataset.enumNewGroup = e.cardType;
    input.placeholder = 'New group name…';
    const commit = (): void => {
      const root = input.value.trim();
      if (root === '' || root.includes('/')) return; // a group root has no slash
      const list = this.pendingGroups[e.cardType] ?? [];
      if (!list.includes(root) && !this.groupsOf(e).some((g) => g.root === root)) {
        this.pendingGroups[e.cardType] = [...list, root];
      }
      input.value = '';
      this.focusAddFor = { cardType: e.cardType, group: root };
      this.paint();
    };
    this.listen(input, 'keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') {
        (ev as KeyboardEvent).preventDefault();
        commit();
      }
    });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.dataset.enumNewGroupAdd = e.cardType;
    btn.textContent = '+ New group';
    this.listen(btn, 'click', () => commit());
    wrap.append(input, btn);
    return wrap;
  }

  /** The add-input row, shared by flat (group=null) and grouped (group=root). */
  private renderAddRow(e: ManagedEnum, group: string | null, placeholder: string): HTMLElement {
    const key = group === null ? e.cardType : `${e.cardType}/${group}`;
    const addRow = document.createElement('div');
    addRow.className = 'enum-manager__add';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'enum-manager__add-input';
    input.dataset.enumAddInput = e.cardType;
    if (group !== null) input.dataset.enumAddGroup = group;
    input.placeholder = placeholder;
    input.value = this.addDrafts[key] ?? '';
    this.listen(input, 'input', () => {
      this.addDrafts[key] = input.value;
    });
    this.listen(input, 'keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') {
        (ev as KeyboardEvent).preventDefault();
        this.addValue(e, group, input.value);
      }
    });
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn';
    addBtn.dataset.enumAdd = e.cardType;
    if (group !== null) addBtn.dataset.enumAddGroupBtn = group;
    addBtn.textContent = '+ Add';
    this.listen(addBtn, 'click', () => this.addValue(e, group, input.value));
    addRow.append(input, addBtn);
    return addRow;
  }

  /** Container-level drag-reorder wiring (shared DnD kit). For a grouped enum
   *  `group` is the path root and the drag is constrained to that group. */
  private wireReorder(e: ManagedEnum, group: string | null, rows: HTMLElement): void {
    const placeholder = new DropPlaceholder(rows, { className: 'drop-placeholder--enum' });
    this.placeholders.push(placeholder);
    const inScope = (): boolean =>
      this.draggingCardType === e.cardType &&
      this.draggingGroup === group &&
      this.draggingValueId !== null;
    this.listen(rows, 'dragover', (ev) => {
      if (!inScope()) return;
      ev.preventDefault();
      const t = computeDropTarget(rows, (ev as DragEvent).clientY, this.draggingValueId!.toString(), '[data-enum-value]');
      placeholder.showAtY(t.y);
    });
    this.listen(rows, 'drop', (ev) => {
      if (!inScope()) return;
      ev.preventDefault();
      placeholder.pulse();
      const t = computeDropTarget(rows, (ev as DragEvent).clientY, this.draggingValueId!.toString(), '[data-enum-value]');
      const movedId = this.draggingValueId!;
      this.resetDrag();
      this.moveValueToSlot(e, group, movedId, t.slot);
    });
  }

  private resetDrag(): void {
    this.draggingValueId = null;
    this.draggingCardType = null;
    this.draggingGroup = null;
  }

  private renderValueRow(e: ManagedEnum, card: CardWithAttrs, group: string | null): HTMLElement {
    const row = document.createElement('div');
    row.className = 'enum-manager__value';
    row.dataset.enumValue = card.id.toString();
    // `data-card-id` lets the shared computeDropTarget skip the dragged row.
    row.dataset.cardId = card.id.toString();

    // Drag handle (shared DnD kit) — reorder rewrites the sort_order ladder.
    const reorder = document.createElement('div');
    reorder.className = 'enum-manager__reorder';
    const handle = document.createElement('span');
    handle.className = 'enum-manager__drag-handle';
    handle.dataset.enumDrag = card.id.toString();
    handle.draggable = true;
    handle.setAttribute('aria-hidden', 'true');
    handle.title = 'Drag to reorder';
    handle.textContent = '⠿';
    this.listen(handle, 'dragstart', (ev) => {
      this.draggingValueId = card.id;
      this.draggingCardType = e.cardType;
      this.draggingGroup = group;
      const dt = (ev as DragEvent).dataTransfer;
      if (dt) {
        dt.effectAllowed = 'move';
        dt.setData('text/plain', card.id.toString());
      }
    });
    this.listen(handle, 'dragend', () => {
      this.resetDrag();
      for (const p of this.placeholders) p.hide();
    });
    reorder.append(handle);

    // Inline-rename input. Grouped enums show + edit the full path (title is
    // kept equal to path); flat enums edit the title. Commit on blur / Enter.
    const isGrouped = group !== null;
    const shown = isGrouped ? this.pathOf(card) : this.titleOf(card);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'enum-manager__value-input';
    input.dataset.enumValueInput = '';
    input.value = shown;
    input.setAttribute('aria-label', `${e.label} name`);
    const commit = (): void => {
      const next = input.value.trim();
      if (next === '' || next === shown) {
        input.value = shown;
        return;
      }
      this.renameValue(e, card, next);
    };
    this.listen(input, 'keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') {
        (ev as KeyboardEvent).preventDefault();
        input.blur();
      }
    });
    this.listen(input, 'blur', () => commit());

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-danger enum-manager__value-remove';
    remove.dataset.enumRemove = card.id.toString();
    remove.setAttribute('aria-label', 'Remove');
    remove.textContent = '×';
    this.listen(remove, 'click', () => this.removeValue(card));

    row.append(reorder, input, remove);
    return row;
  }

  /** Toggle single-select for a group: set (or clear) `root_exclusive_at = root`
   *  on every member. Optimistic local update + one coalesced attribute.update
   *  batch; the next load reconciles. */
  private setGroupExclusive(root: string, members: CardWithAttrs[], on: boolean): void {
    const want = on ? root : '';
    let changed = false;
    for (const c of members) {
      if (this.rootExclusiveOf(c) === want) continue;
      c.attributes['root_exclusive_at'] = want;
      changed = true;
      this.ctx.api.callByName(
        SPEC.attributeUpdate,
        { cardId: c.id, attributeName: 'root_exclusive_at', value: want },
        () => {},
        { alive: () => this.isAlive() },
      );
    }
    if (changed) this.paint();
  }

  /** Drag commit: move `cardId` to `slot` (insertion index among the non-dragged
   *  rows — computeDropTarget already excludes it). For a grouped enum the move
   *  is within `group`; the full sort_order ladder is then rewritten over the
   *  groups in display order (so the moved row stays in its group). */
  private moveValueToSlot(e: ManagedEnum, group: string | null, cardId: bigint, slot: number): void {
    const list = this.cards[e.cardType] ?? [];
    if (group === null) {
      const idx = list.findIndex((c) => c.id === cardId);
      if (idx < 0) return;
      const next = list.slice();
      const [moved] = next.splice(idx, 1);
      next.splice(Math.max(0, Math.min(slot, next.length)), 0, moved!);
      if (next.every((c, i) => c.id === list[i]?.id)) return; // no change
      this.applyOrder(e, next);
      return;
    }
    // Grouped: reorder within the group, then flatten all groups (by display
    // order: roots sorted, members in order) into the new full list.
    const groups = this.groupsOf(e);
    const g = groups.find((gr) => gr.root === group);
    if (g === undefined) return;
    const idx = g.members.findIndex((c) => c.id === cardId);
    if (idx < 0) return;
    const members = g.members.slice();
    const [moved] = members.splice(idx, 1);
    members.splice(Math.max(0, Math.min(slot, members.length)), 0, moved!);
    g.members = members;
    groups.sort((a, b) => a.root.localeCompare(b.root));
    const next = groups.flatMap((gr) => gr.members);
    if (next.every((c, i) => c.id === list[i]?.id)) return; // no change
    this.applyOrder(e, next);
  }

  /** Apply a new value order: repaint optimistically + persist the 10,20,30,…
   *  sort_order ladder for every card whose value changed (one coalesced batch).
   *  The next load reconciles from the server (select is ordered by sort_order). */
  private applyOrder(e: ManagedEnum, next: CardWithAttrs[]): void {
    this.cards[e.cardType] = next;
    this.paint();
    next.forEach((c, i) => {
      const want = (i + 1) * 10;
      if (numAttr(c, 'sort_order') === want) return;
      c.attributes['sort_order'] = want;
      this.ctx.api.callByName(
        SPEC.attributeUpdate,
        { cardId: c.id, attributeName: 'sort_order', value: want },
        () => {},
        { alive: () => this.isAlive() },
      );
    });
  }

  /** Add a value. For a grouped enum, `group` is the path root: the new card's
   *  path = `root/<typed>` and it inherits the group's current exclusivity. For
   *  a flat enum (`group` null) the entered title mirrors into required text
   *  edges (e.g. a flat tag's path = title). */
  private addValue(e: ManagedEnum, group: string | null, raw: string): void {
    const typed = raw.trim();
    const pid = this.projectId();
    if (typed === '' || pid === null) return;
    const draftKey = group === null ? e.cardType : `${e.cardType}/${group}`;
    this.addDrafts[draftKey] = '';

    const attrs: Record<string, unknown> = {};
    let title = typed;
    if (group === null) {
      // Flat: mirror the entered title into any required text edge (e.g. path).
      for (const name of this.requiredTextAttrs[e.cardType] ?? []) attrs[name] = typed;
    } else {
      // Grouped: full path = root/typed; keep title == path; inherit exclusivity
      // from the group so a new value in a single-select group is exclusive too.
      const path = `${group}/${typed}`;
      title = path;
      attrs['path'] = path;
      const members = this.groupsOf(e).find((g) => g.root === group)?.members ?? [];
      const exclusive = members.length > 0 && members.every((c) => this.rootExclusiveOf(c) === group);
      if (exclusive) attrs['root_exclusive_at'] = group;
    }

    const input: { cardTypeName: string; parentCardId: bigint; title: string; attributes?: Record<string, unknown> } = {
      cardTypeName: e.cardType,
      parentCardId: pid,
      title,
    };
    if (Object.keys(attrs).length > 0) input.attributes = attrs;
    this.ctx.api.callByName(
      'card.insert',
      input,
      () => {
        if (!this.isAlive()) return;
        // The pending (empty) group is now real; drop the client-side marker.
        if (group !== null) {
          this.pendingGroups[e.cardType] = (this.pendingGroups[e.cardType] ?? []).filter((r) => r !== group);
        }
        this.focusAddFor = { cardType: e.cardType, group: group ?? undefined };
        this.loadEnum(e); // reload ONLY this enum so the focus isn't raced away
      },
      { alive: () => this.isAlive() },
    );
  }

  /** Rename a value. For a grouped enum the row shows + edits the full path, so
   *  rename rewrites BOTH `path` and `title` (kept equal) — the new root re-buckets
   *  the row and the chip leaf tracks it. Flat enums rename `title` only. */
  private renameValue(e: ManagedEnum, card: CardWithAttrs, next: string): void {
    if (this.grouped(e.cardType)) {
      this.ctx.api.callByName(
        SPEC.attributeUpdate,
        { cardId: card.id, attributeName: 'path', value: next },
        () => {},
        { alive: () => this.isAlive() },
      );
    }
    this.ctx.api.callByName(
      SPEC.attributeUpdate,
      { cardId: card.id, attributeName: 'title', value: next },
      () => {
        if (this.isAlive()) this.reloadAll();
      },
      { alive: () => this.isAlive() },
    );
  }

  private removeValue(card: CardWithAttrs): void {
    const ok = typeof confirm === 'function' ? confirm(`Remove “${this.titleOf(card)}”?`) : true;
    if (!ok) return;
    this.ctx.api.callByName(
      'card.delete',
      { cardId: card.id },
      () => {
        if (this.isAlive()) this.reloadAll();
      },
      { alive: () => this.isAlive() },
    );
  }
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/** The group root of a tag path: everything before the first '/', or the whole
 *  path when it has none. Matches tag_apply_batch's pathRoot semantics. */
function pathRoot(path: string): string {
  const i = path.indexOf('/');
  return i >= 0 ? path.slice(0, i) : path;
}

/** A card's numeric attribute value, or null when absent / non-numeric. */
function numAttr(card: CardWithAttrs, name: string): number | null {
  const v = card.attributes[name];
  return typeof v === 'number' ? v : null;
}

export function registerEnumManager(): void {
  Control.register('EnumManager', EnumManager);
}
