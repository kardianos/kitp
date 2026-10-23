/**
 * ActivityFilterEditor — the reusable editor for the activity-event filter DSL
 * (see ./activity-predicate.ts): which activity rows (event kind / changed
 * attribute / actor) an activity sink or a personal notification subscription
 * passes on. Mounted by the RecordForm `activityFilter` field kind, so the admin
 * Activity Sinks form and the account page's notification subscriptions share
 * ONE editor.
 *
 * State: the filter is the JSON STRING stored at `config.valuePath` ('' = every
 * event) — the exact `activity_filter` attribute value, so the host just reads
 * the leaf back on save. The single render effect reads that leaf and rebuilds
 * the list; every edit (add / remove leaf, connective) writes the leaf from a
 * click handler, outside the effect (cascade-safe). The add row's op choice +
 * typed values are local DOM state until "+ Add" commits them.
 *
 * Values per op are data-driven: kind ops pick from ACTIVITY_KIND_OPTIONS
 * (checkboxes) and the attribute ops take a comma-separated list. The actor
 * ops ("Done by" / "Not done by") list the host's `actorChoices` (a personal
 * subscription's "Me" / "My agents") and, given a `projectId`, the project's
 * accounts by name (activity.actors), with a search once the list is long;
 * without a project they fall back to typed user ids. Saved conditions show
 * those names too. `shortcuts` are one-click checkboxes for whole conditions
 * (a subscription's "Skip changes I or my agents make").
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { MenuFilter } from '../ui/menu-filter.js';
import { ACTIVITY_ACTORS_SPEC, type ActivityActorsOutput } from '../task-detail/comment-specs.js';
import {
  type ActivityLeafOp,
  type ActivityPredicateLeaf,
  actorIdsIn,
  hasTopLevelLeaf,
  withoutTopLevelLeaf,
  ACTIVITY_LEAF_OPS,
  ACTIVITY_KIND_OPTIONS,
  ACTIVITY_OP_FRIENDLY,
  activityPredicateFromString,
  activityPredicateToString,
  activityOpLabel,
  appendLeaf,
  removeLeafAt,
  setConnective,
  topLevelLeaves,
  describeActivityLeaf,
  isKindOp,
  isActorOp,
  isPersonOp,
  ACTIVITY_ME_TOKEN,
} from './activity-predicate.js';

export interface ActivityFilterEditorConfig extends BaseControlConfig {
  type: 'ActivityFilterEditor';
  /** Dotted tree path of the filter JSON string ('' = match every event). */
  valuePath: string;
  /** Text shown when there is no filter. */
  emptyLabel?: string;
  /** Extra values the actor ops offer ahead of the project's accounts (a
   *  personal subscription's `@me` / `@my_agents`). */
  actorChoices?: ReadonlyArray<{ value: string; label: string }>;
  /** Decimal id of the project whose accounts the actor ops offer by name.
   *  Absent → user ids are typed. */
  projectId?: string;
  /** One-click conditions shown as checkboxes above the list, ticked while the
   *  filter holds that exact top-level condition. */
  shortcuts?: ReadonlyArray<{ label: string; leaf: ActivityPredicateLeaf }>;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    ActivityFilterEditor: ActivityFilterEditorConfig;
  }
}

/** Typed-value placeholder per non-kind op. */
const VALUE_PLACEHOLDER: Readonly<Record<ActivityLeafOp, string>> = {
  kind_in: '',
  kind_not_in: '',
  attr_in: 'attribute names, comma-separated (e.g. status, assignee)',
  attr_not_in: 'attribute names, comma-separated (e.g. sort_order)',
  actor_in: 'user ids, comma-separated',
  actor_not_in: 'user ids, comma-separated',
  approval_asks_in: 'person ids, comma-separated',
};

export class ActivityFilterEditor extends Control<ActivityFilterEditorConfig> {
  /** The project's accounts once activity.actors lands (null before, or with
   *  no project): the actor ops' options and the names saved ids show as. */
  private accounts: Array<{ value: string; label: string }> | null = null;
  /** The same accounts' people (by person card id) — what "approval asked
   *  of" names; agents have none. Null until the load lands. */
  private people: Array<{ value: string; label: string }> | null = null;
  /** The search over the add row's account list (rebuilt with the row). */
  private actorFilter: MenuFilter | null = null;

  private get valueSegs(): string[] {
    return this.config.valuePath.split('.');
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'activity-filter';
    el.dataset.control = 'ActivityFilterEditor';
    return el;
  }

  protected render(): void {
    this.effect(() => {
      const raw = this.ctx.tree.at(this.valueSegs).get<string>() ?? '';
      this.renderFrom(typeof raw === 'string' ? raw : '');
    }, 'activityFilter.render');
    this.onDestroy(() => this.actorFilter?.destroy());
    this.loadAccounts();
  }

  /** Load the project's accounts (plus any ids the filter already names, so
   *  they show by name too), then repaint with them. */
  private loadAccounts(): void {
    const pid = this.config.projectId ?? '';
    if (!/^\d+$/.test(pid)) return;
    this.ctx.api.callByName(
      ACTIVITY_ACTORS_SPEC,
      { projectId: BigInt(pid), ids: actorIdsIn(activityPredicateFromString(this.current())) },
      (out) => {
        const rows = ((out ?? {}) as ActivityActorsOutput).rows ?? [];
        this.accounts = rows.map((r) => ({ value: r.id.toString(), label: r.name }));
        this.people = rows
          .filter((r) => !r.isAgent && r.personId !== null)
          .map((r) => ({ value: (r.personId as bigint).toString(), label: r.name }));
        this.renderFrom(this.current());
      },
      { alive: () => this.isAlive() },
    );
  }

  private accountName(id: string): string | undefined {
    return this.accounts?.find((a) => a.value === id)?.label;
  }

  private personName(id: string): string | undefined {
    return this.people?.find((p) => p.value === id)?.label;
  }

  private current(): string {
    const raw = this.ctx.tree.at(this.valueSegs).peek<string>() ?? '';
    return typeof raw === 'string' ? raw : '';
  }

  private write(next: string): void {
    this.ctx.tree.at(this.valueSegs).set(next);
  }

  private renderFrom(raw: string): void {
    const predicate = activityPredicateFromString(raw);
    const leaves = topLevelLeaves(predicate);
    const frag = document.createDocumentFragment();

    for (const sc of this.config.shortcuts ?? []) {
      const label = document.createElement('label');
      label.className = 'activity-filter__shortcut';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.afShortcut = '';
      box.checked = hasTopLevelLeaf(predicate, sc.leaf);
      this.listen(box, 'change', () => {
        const cur = activityPredicateFromString(this.current());
        const next = box.checked
          ? hasTopLevelLeaf(cur, sc.leaf)
            ? cur
            : appendLeaf(cur, { ...sc.leaf, values: [...sc.leaf.values] })
          : withoutTopLevelLeaf(cur, sc.leaf);
        this.write(activityPredicateToString(next));
      });
      const text = document.createElement('span');
      text.textContent = sc.label;
      label.append(box, text);
      frag.append(label);
    }

    if (predicate !== null && predicate.kind === 'composite' && predicate.items.length > 1) {
      const conn = document.createElement('select');
      conn.className = 'activity-filter__conn';
      conn.dataset.afConn = '';
      for (const op of ['and', 'or'] as const) {
        const opt = document.createElement('option');
        opt.value = op;
        opt.textContent = op === 'and' ? 'Match ALL of' : 'Match ANY of';
        if (predicate.op === op) opt.selected = true;
        conn.append(opt);
      }
      conn.value = predicate.op;
      this.listen(conn, 'change', () => {
        const next = setConnective(activityPredicateFromString(this.current()), conn.value as 'and' | 'or');
        this.write(activityPredicateToString(next));
      });
      frag.append(conn);
    }

    const list = document.createElement('div');
    list.className = 'activity-filter__leaves';
    list.dataset.afLeaves = '';
    if (leaves.length === 0) {
      const none = document.createElement('div');
      none.className = 'muted';
      none.dataset.afEmpty = '';
      none.textContent = this.config.emptyLabel ?? 'No filter — every event.';
      list.append(none);
    }
    leaves.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = 'activity-filter__leaf';
      row.dataset.afLeaf = String(i);
      const txt = document.createElement('span');
      txt.className = 'activity-filter__leaf-text';
      txt.textContent =
        entry.leaf !== null
          ? describeActivityLeaf(entry.leaf, (id) => this.accountName(id), (id) => this.personName(id))
          : entry.summary;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'btn btn-danger activity-filter__remove';
      rm.dataset.afRemove = String(i);
      rm.textContent = 'Remove';
      this.listen(rm, 'click', () => {
        this.write(activityPredicateToString(removeLeafAt(activityPredicateFromString(this.current()), i)));
      });
      row.append(txt, rm);
      list.append(row);
    });
    frag.append(list);
    frag.append(this.buildAddRow());
    this.el.replaceChildren(frag);
  }

  /** The "+ Add" row: op select + an op-appropriate values editor. */
  private buildAddRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'activity-filter__add';
    row.dataset.afAdd = '';

    const opSel = document.createElement('select');
    opSel.className = 'activity-filter__op';
    opSel.dataset.afOp = '';
    for (const op of ACTIVITY_LEAF_OPS) {
      const opt = document.createElement('option');
      opt.value = op;
      opt.textContent = ACTIVITY_OP_FRIENDLY[op];
      opt.title = activityOpLabel(op);
      opSel.append(opt);
    }
    opSel.value = ACTIVITY_LEAF_OPS[0];

    const valuesHost = document.createElement('div');
    valuesHost.className = 'activity-filter__values';
    // Read back by the add button; rebuilt when the op changes.
    let readValues: () => string[] = () => [];
    const renderValues = (op: ActivityLeafOp): void => {
      this.actorFilter?.destroy();
      this.actorFilter = null;
      // Checkbox choices: the kind list for kind ops; for actor ops the host's
      // actorChoices then the project's accounts, and for "approval asked
      // of" its "Me" then the project's people (both a scrolling, searchable
      // list). A typed comma list for the attribute ops, and for actor /
      // people ops when no accounts are known.
      const people = isPersonOp(op);
      const actors = isActorOp(op) || people;
      const choices = isKindOp(op)
        ? ACTIVITY_KIND_OPTIONS
        : people
          ? [...(this.config.actorChoices ?? []).filter((c) => c.value === ACTIVITY_ME_TOKEN), ...(this.people ?? [])]
          : actors
            ? [...(this.config.actorChoices ?? []), ...(this.accounts ?? [])]
            : [];
      const boxes: Array<{ value: string; box: HTMLInputElement }> = [];
      const parts: HTMLElement[] = [];
      if (choices.length > 0) {
        const wrap = document.createElement('div');
        wrap.className = actors ? 'activity-filter__actors' : 'activity-filter__kinds';
        if (actors) {
          this.actorFilter = new MenuFilter(wrap, { placeholder: 'Filter people…' });
          wrap.append(this.actorFilter.el);
        }
        for (const k of choices) {
          const label = document.createElement('label');
          label.className = 'activity-filter__kind';
          if (actors) label.dataset.menuItem = k.label;
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.dataset.afChoice = k.value;
          const span = document.createElement('span');
          span.textContent = k.label;
          label.append(box, span);
          wrap.append(label);
          boxes.push({ value: k.value, box });
        }
        this.actorFilter?.apply();
        parts.push(wrap);
      }
      let input: HTMLInputElement | null = null;
      if (!isKindOp(op) && !(actors && this.accounts !== null)) {
        input = document.createElement('input');
        input.type = 'text';
        input.className = 'activity-filter__text';
        input.dataset.afValues = '';
        input.placeholder = VALUE_PLACEHOLDER[op];
        parts.push(input);
      }
      readValues = () => [
        ...boxes.filter((b) => b.box.checked).map((b) => b.value),
        ...(input?.value ?? '').split(',').map((s) => s.trim()).filter((s) => s !== ''),
      ];
      valuesHost.replaceChildren(...parts);
    };
    renderValues(opSel.value as ActivityLeafOp);
    this.listen(opSel, 'change', () => renderValues(opSel.value as ActivityLeafOp));

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn activity-filter__add-btn';
    addBtn.dataset.afAddBtn = '';
    addBtn.textContent = '+ Add condition';
    this.listen(addBtn, 'click', () => {
      const values = readValues();
      if (values.length === 0) return;
      const op = opSel.value as ActivityLeafOp;
      const next = appendLeaf(activityPredicateFromString(this.current()), { kind: 'leaf', op, values });
      this.write(activityPredicateToString(next));
    });

    row.append(opSel, valuesHost, addBtn);
    return row;
  }
}

export function registerActivityFilterEditor(): void {
  Control.register('ActivityFilterEditor', ActivityFilterEditor);
}
