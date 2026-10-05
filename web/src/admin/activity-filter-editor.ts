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
 * (checkboxes), the attribute / actor ops take a comma-separated list, and the
 * actor ops also offer the host's `actorChoices` (e.g. a personal
 * subscription's "Me" → `@me`) as checkboxes beside the typed ids.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import {
  type ActivityLeafOp,
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
} from './activity-predicate.js';

export interface ActivityFilterEditorConfig extends BaseControlConfig {
  type: 'ActivityFilterEditor';
  /** Dotted tree path of the filter JSON string ('' = match every event). */
  valuePath: string;
  /** Text shown when there is no filter. */
  emptyLabel?: string;
  /** Extra values the actor ops offer as checkboxes beside the typed user ids
   *  (e.g. `[{ value: '@me', label: 'Me' }]` on a personal subscription).
   *  Absent → typed ids only. */
  actorChoices?: ReadonlyArray<{ value: string; label: string }>;
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
};

export class ActivityFilterEditor extends Control<ActivityFilterEditorConfig> {
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
      txt.textContent = entry.leaf !== null ? describeActivityLeaf(entry.leaf) : entry.summary;
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
      // Checkbox choices: the kind list for kind ops, the host's actorChoices
      // for actor ops; a typed comma list for everything but the kind ops.
      const choices = isKindOp(op) ? ACTIVITY_KIND_OPTIONS : isActorOp(op) ? this.config.actorChoices ?? [] : [];
      const boxes: Array<{ value: string; box: HTMLInputElement }> = [];
      const parts: HTMLElement[] = [];
      if (choices.length > 0) {
        const wrap = document.createElement('div');
        wrap.className = 'activity-filter__kinds';
        for (const k of choices) {
          const label = document.createElement('label');
          label.className = 'activity-filter__kind';
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.dataset.afChoice = k.value;
          const span = document.createElement('span');
          span.textContent = k.label;
          label.append(box, span);
          wrap.append(label);
          boxes.push({ value: k.value, box });
        }
        parts.push(wrap);
      }
      let input: HTMLInputElement | null = null;
      if (!isKindOp(op)) {
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
