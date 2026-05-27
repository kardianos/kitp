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
  /** Loaded value-cards per card_type. */
  private cards: Record<string, CardWithAttrs[]> = {};
  /** Draft text for each card_type's add-input (preserved across repaints). */
  private addDrafts: Record<string, string> = {};

  private listHost!: HTMLElement;

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

    this.loadSchema();
    // Reload value-cards when the active project resolves / changes. One-way:
    // reads scope, writes only this control's DOM + its own load state.
    this.effect(() => {
      this.ctx.tree.at([...this.scopePath]).get();
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
    for (const e of this.enums) {
      this.ctx.api.callByName(
        SPEC.selectWithAttributes,
        // Order by the sort_order ATTRIBUTE so the list reflects the user-chosen
        // order (the reorder controls rewrite sort_order; see moveValue). The
        // select's order field must be the `attributes.<name>` form — a bare
        // 'sort_order' is rejected ("unsupported order field").
        { cardTypeName: e.cardType, parentCardId: pid, order: [{ field: 'attributes.sort_order', direction: 'ASC' }] },
        (out) => {
          if (!this.isAlive()) return;
          this.cards[e.cardType] = (out as SelectWithAttributesOutput).rows ?? [];
          this.paint();
        },
        { alive: () => this.isAlive() },
      );
    }
  }

  private titleOf(card: CardWithAttrs): string {
    const t = card.attributes['title'];
    return typeof t === 'string' ? t : '';
  }

  private paint(): void {
    const host = this.listHost;
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
  }

  private note(text: string): HTMLElement {
    const p = document.createElement('p');
    p.className = 'enum-manager__empty muted';
    p.textContent = text;
    return p;
  }

  private renderEnum(e: ManagedEnum): HTMLElement {
    const section = document.createElement('section');
    section.className = 'enum-manager__group';
    section.dataset.enumGroup = e.cardType;

    const heading = document.createElement('h2');
    heading.className = 'enum-manager__group-title';
    heading.textContent = e.label;
    section.append(heading);

    const rows = document.createElement('div');
    rows.className = 'enum-manager__values';
    const cards = this.cards[e.cardType] ?? [];
    if (cards.length === 0) {
      rows.append(this.note('No values yet.'));
    } else {
      cards.forEach((card, i) => rows.append(this.renderValueRow(e, card, i, cards.length)));
    }
    section.append(rows);

    // Add row: an input + button → card.insert under the active project.
    const addRow = document.createElement('div');
    addRow.className = 'enum-manager__add';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'enum-manager__add-input';
    input.dataset.enumAddInput = e.cardType;
    input.placeholder = `Add ${e.label.toLowerCase()}…`;
    input.value = this.addDrafts[e.cardType] ?? '';
    this.listen(input, 'input', () => {
      this.addDrafts[e.cardType] = input.value;
    });
    this.listen(input, 'keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') {
        (ev as KeyboardEvent).preventDefault();
        this.addValue(e, input.value);
      }
    });
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn';
    addBtn.dataset.enumAdd = e.cardType;
    addBtn.textContent = '+ Add';
    this.listen(addBtn, 'click', () => this.addValue(e, input.value));
    addRow.append(input, addBtn);
    section.append(addRow);

    return section;
  }

  private renderValueRow(e: ManagedEnum, card: CardWithAttrs, index: number, total: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'enum-manager__value';
    row.dataset.enumValue = card.id.toString();

    // Reorder handles: ▲/▼ rewrite sort_order across the list (see moveValue).
    const reorder = document.createElement('div');
    reorder.className = 'enum-manager__reorder';
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'enum-manager__move';
    up.dataset.enumMoveUp = card.id.toString();
    up.setAttribute('aria-label', 'Move up');
    up.textContent = '▲';
    up.disabled = index === 0;
    this.listen(up, 'click', () => this.moveValue(e, card, -1));
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'enum-manager__move';
    down.dataset.enumMoveDown = card.id.toString();
    down.setAttribute('aria-label', 'Move down');
    down.textContent = '▼';
    down.disabled = index === total - 1;
    this.listen(down, 'click', () => this.moveValue(e, card, 1));
    reorder.append(up, down);

    // Inline-rename input: commit on blur / Enter via attribute.update.
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'enum-manager__value-input';
    input.dataset.enumValueInput = '';
    input.value = this.titleOf(card);
    input.setAttribute('aria-label', `${e.label} name`);
    const commit = (): void => {
      const next = input.value.trim();
      if (next === '' || next === this.titleOf(card)) {
        input.value = this.titleOf(card);
        return;
      }
      this.renameValue(card, next);
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

  /**
   * Reorder a value within its enum by `dir` (-1 up / +1 down). Reindexes the
   * group's sort_order to a 10,20,30,… ladder and persists every card whose
   * value changed via `attribute.update` (one coalesced batch). Optimistic: the
   * local order repaints immediately; the next load reconciles from the server
   * (the select is ordered by sort_order).
   */
  private moveValue(e: ManagedEnum, card: CardWithAttrs, dir: -1 | 1): void {
    const list = this.cards[e.cardType] ?? [];
    const idx = list.findIndex((c) => c.id === card.id);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= list.length) return;

    const next = list.slice();
    const [moved] = next.splice(idx, 1);
    next.splice(target, 0, moved!);
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

  private addValue(e: ManagedEnum, raw: string): void {
    const title = raw.trim();
    const pid = this.projectId();
    if (title === '' || pid === null) return;
    this.addDrafts[e.cardType] = '';
    this.ctx.api.callByName(
      'card.insert',
      { cardTypeName: e.cardType, parentCardId: pid, title },
      () => {
        if (this.isAlive()) this.reloadAll();
      },
      { alive: () => this.isAlive() },
    );
  }

  private renameValue(card: CardWithAttrs, title: string): void {
    this.ctx.api.callByName(
      SPEC.attributeUpdate,
      { cardId: card.id, attributeName: 'title', value: title },
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

/** A card's numeric attribute value, or null when absent / non-numeric. */
function numAttr(card: CardWithAttrs, name: string): number | null {
  const v = card.attributes[name];
  return typeof v === 'number' ? v : null;
}

export function registerEnumManager(): void {
  Control.register('EnumManager', EnumManager);
}
