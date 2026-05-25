/**
 * BulkActionBar — the bulk-action surface the Grid mounts below its table.
 *
 * Shown only when the selection set holds ≥1 card id; reads the SAME tree leaf
 * the Grid's row checkboxes write (`grid.selection`, a `Set<string>` of
 * stringified card ids) so it stays in lock-step with the row checks without a
 * second source of truth. The selection lives in the TREE (recycling-safe — the
 * virtualList's row `update` reads it to render each row's checked state); this
 * bar both READS it (count + show/hide) and CLEARS it (the Clear / cancel
 * gesture writes the empty set + bumps the selection version).
 *
 * Three bulk operations, all DECLARATIVE actions (no promises in the surface):
 *
 *   - Assign attribute → `attribute.update`, ONE per selected card, fired in a
 *     single synchronous burst so the dispatcher's microtask flush coalesces
 *     them into ONE /api/v1/batch POST. Optimistic per row (the action's tree
 *     patch rewrites that card's attribute in `grid.tasks` immediately;
 *     auto-rollback on fault). Per-row faults funnel to the central handler
 *     (`onError: 'top'`).
 *   - Move to project → `task.move`, one per selected card, same coalesced burst.
 *   - Purge (hard delete) → `task.purge`, one per selected card, gated behind a
 *     type-to-confirm dialog.
 *
 * After any bulk op fires the bar bumps `grid.queryVersion` (re-issue the tasks
 * query so the server-of-record reconciles the optimistic view) and clears the
 * selection.
 *
 * Cascade-safety: every effect reads ONE leaf and writes only DOM (the
 * count/visibility effects) — selection writes + the query-version bump are
 * one-way writes outside any tracked effect, exactly like the Grid's own
 * query-version drivers. No promise, no `await`, no `call(...)` in the body.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { ActionBinding } from '../core/data.js';
import { SPEC } from '../kanban/specs.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import { GRID_SPEC } from './specs.js';
import type { RefPicker } from '../ui/ref-picker.js';
import type { Combobox } from '../ui/combobox.js';

/* -------------------------------------------------------------------------- */
/* Config + declaration-merged registry type.                                 */
/* -------------------------------------------------------------------------- */

export interface BulkActionBarConfig extends BaseControlConfig {
  type: 'BulkActionBar';
  /** Tree path of the selection set (Set<string> of stringified ids). */
  selectionPath?: string;
  /** Tree path of the selection version leaf the Grid + bar bump together. */
  selectionVersionPath?: string;
  /** Tree path of the tasks query-version leaf the bar bumps after a write. */
  queryVersionPath?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    BulkActionBar: BulkActionBarConfig;
  }
}

/* -------------------------------------------------------------------------- */
/* The assignable-attribute palette.                                          */
/* -------------------------------------------------------------------------- */

/**
 * One assignable attribute. `kind` selects the value editor; `cardType` is the
 * RefPicker target for the ref kinds. Free-text scalars (title / description)
 * are deliberately ABSENT — mass-overwriting free text is a footgun (mirrors
 * the Svelte BulkActionBar's SCALAR_TEXT_BLOCKLIST).
 */
interface AssignAttr {
  name: string;
  label: string;
  kind: 'ref' | 'ref_multi' | 'scalar';
  cardType?: string;
  /** Fixed scalar choices (priority); when set, the value editor is a Combobox. */
  choices?: { value: string; label: string }[];
}

const ASSIGN_ATTRS: readonly AssignAttr[] = [
  { name: 'status', label: 'Status', kind: 'ref', cardType: 'status' },
  { name: 'assignee', label: 'Assignee', kind: 'ref', cardType: 'person' },
  { name: 'milestone_ref', label: 'Milestone', kind: 'ref', cardType: 'milestone' },
  { name: 'component_ref', label: 'Component', kind: 'ref', cardType: 'component' },
  {
    name: 'priority',
    label: 'Priority',
    kind: 'scalar',
    choices: [
      { value: 'high', label: 'High' },
      { value: 'medium', label: 'Medium' },
      { value: 'low', label: 'Low' },
    ],
  },
  { name: 'tags', label: 'Tags', kind: 'ref_multi', cardType: 'tag' },
];

/* -------------------------------------------------------------------------- */
/* Control.                                                                   */
/* -------------------------------------------------------------------------- */

export class BulkActionBar extends Control<BulkActionBarConfig> {
  private get selectionPath(): string[] {
    return (this.config.selectionPath ?? 'grid.selection').split('.');
  }
  private get selectionVersionPath(): string[] {
    return (this.config.selectionVersionPath ?? 'grid.selectionVersion').split('.');
  }
  private get queryVersionPath(): string[] {
    return (this.config.queryVersionPath ?? 'grid.queryVersion').split('.');
  }

  /**
   * Declarative writes. Each fires ONE wire call per `intent(...)`; the bar
   * fans a selection out by calling intent once per card in a synchronous loop,
   * so the dispatcher coalesces the burst into one batch. Inputs read the
   * intent payload; `attribute.update` carries an optimistic patch over the
   * tasks leaf so the visible row updates immediately (rollback on fault).
   */
  static override actions: readonly ActionBinding[] = [
    {
      intent: 'bulkAssign',
      spec: SPEC.attributeUpdate,
      input: {
        cardId: { payload: 'cardId' },
        attributeName: { payload: 'attributeName' },
        value: { payload: 'value' },
      },
      optimistic: {
        path: 'grid.tasks',
        patch: (current, payload): CardWithAttrs[] => {
          const rows = Array.isArray(current) ? (current as CardWithAttrs[]) : [];
          const p = (payload ?? {}) as {
            cardId?: bigint;
            attributeName?: string;
            value?: unknown;
          };
          if (p.cardId === undefined || p.attributeName === undefined) return rows;
          return rows.map((row) =>
            row.id === p.cardId
              ? {
                  ...row,
                  attributes: { ...row.attributes, [p.attributeName as string]: p.value ?? null },
                }
              : row,
          );
        },
      },
      onError: 'top',
    },
    {
      intent: 'bulkMove',
      spec: GRID_SPEC.taskMove,
      input: {
        cardId: { payload: 'cardId' },
        newProjectId: { payload: 'newProjectId' },
      },
      onError: 'top',
    },
    {
      intent: 'bulkPurge',
      spec: GRID_SPEC.taskPurge,
      input: {
        cardId: { payload: 'cardId' },
      },
      onError: 'top',
    },
  ];

  /* ------------------------------ DOM handles ----------------------------- */

  /** The mounted assign-value editor child (RefPicker / Combobox), if any. */
  private valueChild: Control | null = null;
  private valueHost!: HTMLElement;
  /** Currently-picked assign attribute + value. */
  private assignAttr: AssignAttr | null = null;
  private assignValue: unknown = undefined;
  private assignBtn!: HTMLButtonElement;
  /** The purge confirm dialog node (built lazily). */
  private confirmEl: HTMLElement | null = null;

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'bulk-bar-host';
    el.dataset.control = 'BulkActionBar';
    return el;
  }

  protected render(): void {
    const bar = document.createElement('div');
    bar.className = 'bulk-bar';
    bar.dataset.bulkBar = '';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Bulk actions');
    bar.style.display = 'none';

    /* ---- count + clear ---- */
    const head = document.createElement('div');
    head.className = 'bulk-bar__head';

    const count = document.createElement('span');
    count.className = 'bulk-bar__count';
    count.dataset.bulkCount = '';

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'bulk-bar__clear';
    clear.dataset.bulkClear = '';
    clear.textContent = 'Clear';
    this.listen(clear, 'click', () => this.clearSelection());

    head.append(count, clear);

    /* ---- assign attribute ---- */
    const assign = document.createElement('div');
    assign.className = 'bulk-bar__group';
    assign.dataset.bulkAssignGroup = '';

    const assignLabel = document.createElement('span');
    assignLabel.className = 'bulk-bar__group-label';
    assignLabel.textContent = 'Assign';
    assign.append(assignLabel);

    // Attribute picker (which field to assign).
    const attrHost = document.createElement('div');
    attrHost.className = 'bulk-bar__attr';
    this.spawn(
      'Combobox',
      {
        type: 'Combobox',
        placeholder: 'Field…',
        'aria-label': 'Attribute to assign',
        options: ASSIGN_ATTRS.map((a) => ({ value: a.name, label: a.label })),
        onChange: (v: string | null) => this.onAttrPicked(v),
      },
      attrHost,
    );
    assign.append(attrHost);

    // Value editor host (filled when an attribute is picked).
    const valueHost = document.createElement('div');
    valueHost.className = 'bulk-bar__value';
    valueHost.dataset.bulkValue = '';
    this.valueHost = valueHost;
    assign.append(valueHost);

    const assignBtn = document.createElement('button');
    assignBtn.type = 'button';
    assignBtn.className = 'bulk-bar__apply';
    assignBtn.dataset.bulkAssign = '';
    assignBtn.textContent = 'Apply';
    assignBtn.disabled = true;
    this.listen(assignBtn, 'click', () => this.applyAssign());
    this.assignBtn = assignBtn;
    assign.append(assignBtn);

    /* ---- move to project ---- */
    const move = document.createElement('div');
    move.className = 'bulk-bar__group';
    move.dataset.bulkMoveGroup = '';

    const moveLabel = document.createElement('span');
    moveLabel.className = 'bulk-bar__group-label';
    moveLabel.textContent = 'Move to';
    move.append(moveLabel);

    const moveHost = document.createElement('div');
    moveHost.className = 'bulk-bar__move';
    this.spawn(
      'RefPicker',
      {
        type: 'RefPicker',
        cardType: 'project',
        value: null,
        placeholder: 'Project…',
        'aria-label': 'Destination project',
        onChange: (v: bigint | null) => this.onMovePicked(v),
      },
      moveHost,
    );
    move.append(moveHost);

    /* ---- purge ---- */
    const purge = document.createElement('div');
    purge.className = 'bulk-bar__group bulk-bar__group--danger';

    const purgeBtn = document.createElement('button');
    purgeBtn.type = 'button';
    purgeBtn.className = 'bulk-bar__purge';
    purgeBtn.dataset.bulkPurge = '';
    purgeBtn.textContent = 'Delete forever…';
    this.listen(purgeBtn, 'click', () => this.openPurgeConfirm());
    purge.append(purgeBtn);

    bar.append(head, assign, move, purge);
    this.el.append(bar);

    /* ---- reactivity: count + visibility track the selection version ---- */
    // Reads ONLY the version + selection leaves and writes ONLY DOM — the bar
    // never re-triggers itself (cascade-safe). The Grid bumps the version leaf
    // on every toggle / select-all; this bar bumps it on clear.
    this.effect(() => {
      this.ctx.tree.at(this.selectionVersionPath).get(); // subscribe
      const n = this.selectionCount();
      bar.style.display = n === 0 ? 'none' : '';
      count.textContent = `${n} task${n === 1 ? '' : 's'} selected`;
    }, 'bulk.count');
  }

  /* ------------------------------ selection ------------------------------- */

  /** Peek the current selection set (a Set<string>), defaulting to empty. */
  private selection(): Set<string> {
    const s = this.ctx.tree.at(this.selectionPath).peek<Set<string>>();
    return s instanceof Set ? s : new Set<string>();
  }

  private selectionCount(): number {
    return this.selection().size;
  }

  /** The selected ids as bigints, dropping any unparseable entries. */
  private selectedIds(): bigint[] {
    const out: bigint[] = [];
    for (const k of this.selection()) {
      if (/^-?\d+$/.test(k)) out.push(BigInt(k));
    }
    return out;
  }

  /** Clear the selection (write an empty set + bump the version). One-way. */
  private clearSelection(): void {
    this.ctx.tree.at(this.selectionPath).set(new Set<string>());
    this.bumpSelectionVersion();
    this.closePurgeConfirm();
  }

  private bumpSelectionVersion(): void {
    const node = this.ctx.tree.at(this.selectionVersionPath);
    node.set((node.peek<number>() ?? 0) + 1);
  }

  /** Bump the tasks query version so the Grid re-issues the read after a write. */
  private bumpQuery(): void {
    const node = this.ctx.tree.at(this.queryVersionPath);
    node.set((node.peek<number>() ?? 0) + 1);
  }

  /* ------------------------------- assign --------------------------------- */

  /** An attribute was picked: rebuild the value editor for its kind. */
  private onAttrPicked(name: string | null): void {
    this.disposeValueChild();
    this.assignValue = undefined;
    this.assignAttr = name === null ? null : (ASSIGN_ATTRS.find((a) => a.name === name) ?? null);
    this.valueHost.replaceChildren();

    const attr = this.assignAttr;
    if (attr === null) {
      this.refreshAssignEnabled();
      return;
    }

    if (attr.kind === 'scalar' && attr.choices) {
      this.valueChild = this.spawn(
        'Combobox',
        {
          type: 'Combobox',
          placeholder: `${attr.label}…`,
          'aria-label': `${attr.label} value`,
          options: attr.choices,
          onChange: (v: string | null) => {
            this.assignValue = v;
            this.refreshAssignEnabled();
          },
        },
        this.valueHost,
      ) as Combobox<string>;
    } else if (attr.kind === 'ref_multi') {
      this.valueChild = this.spawn(
        'RefPicker',
        {
          type: 'RefPicker',
          cardType: attr.cardType ?? 'card',
          multi: true,
          values: [],
          placeholder: `Search ${attr.label.toLowerCase()}…`,
          'aria-label': `${attr.label} value`,
          onChangeMulti: (values: bigint[]) => {
            this.assignValue = values;
            this.refreshAssignEnabled();
          },
        },
        this.valueHost,
      ) as RefPicker;
    } else {
      this.valueChild = this.spawn(
        'RefPicker',
        {
          type: 'RefPicker',
          cardType: attr.cardType ?? 'card',
          value: null,
          placeholder: `Search ${attr.label.toLowerCase()}…`,
          'aria-label': `${attr.label} value`,
          onChange: (v: bigint | null) => {
            this.assignValue = v;
            this.refreshAssignEnabled();
          },
        },
        this.valueHost,
      ) as RefPicker;
    }
    this.refreshAssignEnabled();
  }

  /** Whether the current assign selection is a non-empty, applicable value. */
  private hasAssignValue(): boolean {
    const v = this.assignValue;
    if (v === undefined || v === null) return false;
    if (typeof v === 'string' && v === '') return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return true;
  }

  private refreshAssignEnabled(): void {
    this.assignBtn.disabled = !(
      this.assignAttr !== null &&
      this.hasAssignValue() &&
      this.selectionCount() > 0
    );
  }

  /**
   * Fire `attribute.update` for every selected card, ONE intent per card in a
   * single synchronous loop. The dispatcher coalesces the same-tick burst into
   * one batch; each carries its own optimistic patch over the tasks leaf.
   */
  private applyAssign(): void {
    const attr = this.assignAttr;
    if (attr === null || !this.hasAssignValue()) return;
    const ids = this.selectedIds();
    if (ids.length === 0) return;
    const value = this.assignValue;
    for (const cardId of ids) {
      this.intent('bulkAssign', { cardId, attributeName: attr.name, value });
    }
    this.afterBulk();
  }

  /* -------------------------------- move ---------------------------------- */

  /** A destination project was picked: fire `task.move` for every selected card. */
  private onMovePicked(projectId: bigint | null): void {
    if (projectId === null) return;
    const ids = this.selectedIds();
    if (ids.length === 0) return;
    for (const cardId of ids) {
      this.intent('bulkMove', { cardId, newProjectId: projectId });
    }
    this.afterBulk();
  }

  /* -------------------------------- purge --------------------------------- */

  /**
   * Open the type-to-confirm purge dialog. The user must type DELETE to enable
   * the destructive button — purge is a hard delete with no undo.
   */
  private openPurgeConfirm(): void {
    if (this.selectionCount() === 0) return;
    this.closePurgeConfirm();

    const dialog = document.createElement('div');
    dialog.className = 'bulk-confirm';
    dialog.dataset.bulkConfirm = '';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Confirm delete forever');

    const n = this.selectionCount();
    const msg = document.createElement('p');
    msg.className = 'bulk-confirm__msg';
    msg.textContent =
      `Permanently delete ${n} task${n === 1 ? '' : 's'}? This cannot be undone. ` +
      'Type DELETE to confirm.';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'bulk-confirm__input';
    input.dataset.bulkConfirmInput = '';
    input.setAttribute('aria-label', 'Type DELETE to confirm');
    input.placeholder = 'DELETE';

    const actions = document.createElement('div');
    actions.className = 'bulk-confirm__actions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'bulk-confirm__cancel';
    cancel.dataset.bulkConfirmCancel = '';
    cancel.textContent = 'Cancel';
    this.listen(cancel, 'click', () => this.closePurgeConfirm());

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'bulk-confirm__confirm';
    confirm.dataset.bulkConfirmAccept = '';
    confirm.textContent = 'Delete forever';
    confirm.disabled = true;
    this.listen(confirm, 'click', () => this.applyPurge());

    this.listen(input, 'input', () => {
      confirm.disabled = input.value.trim() !== 'DELETE';
    });

    actions.append(cancel, confirm);
    dialog.append(msg, input, actions);
    this.el.append(dialog);
    this.confirmEl = dialog;
  }

  private closePurgeConfirm(): void {
    if (this.confirmEl !== null) {
      this.confirmEl.remove();
      this.confirmEl = null;
    }
  }

  /** Fire `task.purge` for every selected card (one coalesced batch). */
  private applyPurge(): void {
    const ids = this.selectedIds();
    if (ids.length === 0) return;
    for (const cardId of ids) {
      this.intent('bulkPurge', { cardId });
    }
    this.closePurgeConfirm();
    this.afterBulk();
  }

  /* ------------------------------- shared --------------------------------- */

  /** Post-write: reconcile the grid (re-issue the read) + clear the selection. */
  private afterBulk(): void {
    this.bumpQuery();
    this.clearSelection();
  }

  /** Dispose the current value-editor child (RefPicker / Combobox), if any. */
  private disposeValueChild(): void {
    if (this.valueChild !== null) {
      this.destroyChild(this.valueChild);
      this.valueChild = null;
    }
  }
}

export function registerBulkActionBar(): void {
  Control.register('BulkActionBar', BulkActionBar);
}
