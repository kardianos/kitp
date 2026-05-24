/**
 * PredicateFilter — reusable structured filter editor (control type
 * `'PredicateFilter'`).
 *
 * Renders a recursive tree of connective groups + comparison leaves and writes
 * the edited {@link Predicate} to a tree path the host designates
 * (`config.valuePath`). This is the `web/` port of the Svelte
 * `FilterTreeEditor.svelte` + `ValueInput.svelte`, re-expressed against the
 * control/signal/tree framework: NO promises, declarative data layer for the
 * `attribute_def.select` source, plain-DOM render patched by signal effects,
 * cascade-safe (effects READ the schema/options leaves + write DOM; tree edits
 * write the predicate leaf — never back into a watched dep).
 *
 * Per node:
 *   - Group: a connective <select> (AND / OR / NOT), "+ leaf", "+ group", and a
 *            remove button (non-root only); a recursive list of children.
 *   - Leaf:  attribute <select> -> operator <select> (ops for that attr's
 *            value_type) -> value editor(s) by op + type:
 *              text/number/date  -> <input>
 *              bool               -> checkbox
 *              card_ref single    -> single-select <select> (options from the
 *                                    lookup path)
 *              card_ref / [] multi -> multi-select <select>
 *              has_phase          -> triage/active/terminal checkboxes
 *              exists/notExists/notTerminal/beforeToday -> NO value editor
 *
 * SCHEMA sources (config.schema): a literal `AttrSchema[]`, or `{ cardType }`.
 * For the `{ cardType }` form the control declares a `defs` query against
 * `attribute_def.select` that lands the rows at `<valuePath>.__defs`; an effect
 * resolves the schema from them. A literal schema needs no query.
 *
 * OPTIONS for card_ref pickers come from `config.optionsPath` — a tree path
 * holding `Record<targetCardTypeName, Array<{ value, label }>>`. The host
 * pre-loads option cards there (e.g. via its own `card.select_with_attributes`
 * lookups); the editor reads them reactively so a late-landing option list
 * repaints the open pickers.
 *
 * The edit tree carries internal `id` markers so a structural mutation
 * (add/remove/reorder) re-renders deterministically; the whole editor
 * re-renders from the model on each structural change (the model is small —
 * a handful of leaves — so a full subtree rebuild is cheap and avoids
 * fine-grained DOM reconciliation for a config surface).
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { QueryBinding } from '../core/data.js';
import { signal } from '../core/signal.js';
import { splitPath } from '../core/data.js';
import type { AttributeDefRow } from '../admin/specs.js';
import {
  type AttrSchema,
  type SchemaSource,
  resolveSchema,
  findAttr,
} from './attribute-schema.js';
import {
  type Op,
  type Phase,
  type Predicate,
  type PredicateGroup,
  type PredicateLeaf,
  PHASES,
  isPhase,
  opArity,
  opLabel,
  opsForValueType,
  fromWire,
  toWire,
} from './predicate.js';

/* -------------------------------------------------------------------------- */
/* Config + declaration-merged registry type.                                 */
/* -------------------------------------------------------------------------- */

export interface PredicateFilterConfig extends BaseControlConfig {
  type: 'PredicateFilter';
  /** Dotted tree path the edited {@link Predicate} is read from + written to. */
  valuePath: string;
  /** The attribute schema: a literal list, or `{ cardType }` (sourced from defs). */
  schema: SchemaSource;
  /**
   * Optional tree path holding `Record<targetCardTypeName, Array<{ value, label }>>`
   * — the option lists for card_ref pickers. Read reactively. Absent -> ref
   * pickers render an empty option list (still selectable once options land).
   */
  optionsPath?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    PredicateFilter: PredicateFilterConfig;
  }
}

/** One ref-picker option (stringified id value + label). */
interface RefOption {
  value: string;
  label: string;
}
type OptionsMap = Record<string, RefOption[]>;

/* -------------------------------------------------------------------------- */
/* Internal edit tree (carries stable ids for deterministic re-render).       */
/* -------------------------------------------------------------------------- */

interface EditLeaf {
  id: string;
  kind: 'leaf';
  attr: string;
  op: Op;
  values: unknown[];
}
interface EditGroup {
  id: string;
  kind: 'group';
  connective: 'and' | 'or' | 'not';
  children: EditNode[];
}
type EditNode = EditLeaf | EditGroup;

const CONNECTIVES: ReadonlyArray<{ value: 'and' | 'or' | 'not'; label: string }> = [
  { value: 'and', label: 'AND' },
  { value: 'or', label: 'OR' },
  { value: 'not', label: 'NOT' },
];

/* -------------------------------------------------------------------------- */
/* Control.                                                                   */
/* -------------------------------------------------------------------------- */

export class PredicateFilter extends Control<PredicateFilterConfig> {
  /** Monotonic id source for edit-node keys. */
  private nextId = 1;
  private newId(): string {
    return `n${this.nextId++}`;
  }

  /** The root edit group (always a group so the UI has a top-level connective). */
  private root: EditGroup = { id: 'n0', kind: 'group', connective: 'and', children: [] };

  /** Resolved schema, recomputed when the defs source lands. Read in render. */
  private readonly schemaSignal = signal<AttrSchema[]>([], 'predicateFilter.schema');

  /** Re-render trigger: bumped on every structural / value mutation. */
  private readonly version = signal(0, 'predicateFilter.version');

  /** Container the recursive tree renders into (rebuilt on each version bump). */
  private treeHost!: HTMLElement;

  private get valuePathSegs(): string[] {
    return this.config.valuePath.split('.');
  }
  private get defsPath(): string[] {
    return [...this.valuePathSegs, '__defs'];
  }

  /**
   * CLASS-STATIC query table is empty; the defs query is per-instance and only
   * needed for a `{ cardType }` schema. We build it in render() and merge via
   * config.queries-style wiring is not available post-mount, so instead we
   * declare it here through an instance override of mergedQueries.
   */
  private defsQuery(): QueryBinding | null {
    if (Array.isArray(this.config.schema)) return null;
    return {
      name: 'predicateFilterDefs',
      spec: 'attribute_def.select',
      when: 'mount',
      result: { method: 'landDefs' },
      onError: 'self',
    };
  }

  protected override mergedQueries(): readonly QueryBinding[] {
    const base = super.mergedQueries();
    const dq = this.defsQuery();
    return dq ? [...base, dq] : base;
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'predfilter';
    el.dataset.control = 'PredicateFilter';
    return el;
  }

  protected render(): void {
    // Result sink for the (optional) attribute_def.select query.
    this.handler('landDefs', (out) => {
      const rows = ((out ?? {}) as { rows?: AttributeDefRow[] }).rows ?? [];
      this.ctx.tree.at(this.defsPath).set(rows);
    });

    // Seed the edit tree from any predicate already at valuePath (peek — a
    // one-time read, not a subscription, so external writes don't stomp an
    // in-progress edit).
    this.seedFromValue();

    // Self-represented fault (defs load failure).
    const fault = document.createElement('div');
    fault.className = 'predfilter__fault';
    fault.style.display = 'none';
    this.el.append(fault);
    this.effect(() => {
      const f = this.fault.get();
      if (!f) {
        fault.style.display = 'none';
        fault.textContent = '';
        return;
      }
      fault.style.display = '';
      fault.textContent = 'Failed to load filter attributes.';
    }, 'predfilter.fault');

    // The tree host — rebuilt on each version bump (structural edits) AND when
    // the schema or options change (so selectors / pickers repaint). Reading
    // those signals here subscribes the single render effect; the body only
    // writes DOM, so it never re-triggers itself (cascade-safe).
    this.treeHost = document.createElement('div');
    this.treeHost.className = 'predfilter__tree';
    this.el.append(this.treeHost);

    // Resolve the schema from the defs leaf (literal schemas resolve once with
    // an empty defs list; `{ cardType }` re-resolves when defs land).
    this.effect(() => {
      const defs =
        (this.ctx.tree.at(this.defsPath).get<AttributeDefRow[]>() ?? []) as AttributeDefRow[];
      this.schemaSignal.set(resolveSchema(this.config.schema, defs));
    }, 'predfilter.schemaResolve');

    // The single render effect.
    this.effect(() => {
      this.version.get(); // structural edits
      const schema = this.schemaSignal.get(); // attribute selector + op lists
      const options = this.readOptions(); // ref-picker option lists
      this.treeHost.replaceChildren(this.renderGroup(this.root, schema, options, true));
    }, 'predfilter.render');
  }

  /* ---------------------------- value <-> model -------------------------- */

  /** Read the current options map from the configured path (reactive). */
  private readOptions(): OptionsMap {
    if (this.config.optionsPath === undefined) return {};
    const v = this.ctx.tree.at(splitPath(this.config.optionsPath)).get<OptionsMap>();
    return (v ?? {}) as OptionsMap;
  }

  /** Seed the edit tree from a {@link Predicate} (or wire node) at valuePath. */
  private seedFromValue(): void {
    const raw = this.ctx.tree.at(this.valuePathSegs).peek<unknown>();
    let seed: EditNode | null = null;
    if (raw !== undefined && raw !== null) {
      try {
        // Accept either the AST shape (kind: ...) or the wire shape.
        const pred = isAst(raw) ? (raw as Predicate) : fromWire(raw);
        seed = this.fromPredicate(pred);
      } catch {
        // Unparseable seed -> start empty rather than throw in render.
        seed = null;
      }
    }
    if (seed === null) {
      this.root = { id: this.newId(), kind: 'group', connective: 'and', children: [] };
    } else if (seed.kind === 'leaf') {
      // Normalise a bare leaf into a root AND group so the UI has a connective.
      this.root = {
        id: this.newId(),
        kind: 'group',
        connective: 'and',
        children: [seed],
      };
    } else {
      this.root = seed;
    }
  }

  private fromPredicate(p: Predicate): EditNode {
    if (p.kind === 'leaf') {
      return {
        id: this.newId(),
        kind: 'leaf',
        attr: p.attr,
        op: p.op,
        values: p.values ? p.values.slice() : [],
      };
    }
    return {
      id: this.newId(),
      kind: 'group',
      connective: p.connective,
      children: p.children.map((c) => this.fromPredicate(c)),
    };
  }

  /** Convert an edit node back to a {@link Predicate}. */
  private toPredicate(n: EditNode): Predicate {
    if (n.kind === 'leaf') {
      const out: PredicateLeaf = { kind: 'leaf', attr: n.attr, op: n.op };
      if (opArity(n.op) !== 'none' && n.values.length > 0) {
        out.values = n.values.slice();
      }
      return out;
    }
    const out: PredicateGroup = {
      kind: 'group',
      connective: n.connective,
      children: n.children.map((c) => this.toPredicate(c)),
    };
    return out;
  }

  /**
   * Project the current edit tree to the valuePath leaf. An empty top-level
   * AND group writes `null` ("no filter") so a host can drop the wire field.
   * One-way write outside any tracked effect — cascade-safe.
   */
  private writeValue(): void {
    const pred = this.toPredicate(this.root);
    let out: Predicate | null = pred;
    if (pred.kind === 'group' && pred.connective === 'and' && pred.children.length === 0) {
      out = null;
    }
    this.ctx.tree.at(this.valuePathSegs).set(out);
  }

  /** Apply a structural mutation then re-render + write the value. */
  private mutate(): void {
    this.version.set(this.version.peek() + 1);
    this.writeValue();
  }

  /* ------------------------------- mutators ------------------------------ */

  private defaultLeaf(schema: readonly AttrSchema[]): EditLeaf {
    const first = schema[0];
    if (first === undefined) {
      return { id: this.newId(), kind: 'leaf', attr: '', op: 'eq', values: [] };
    }
    const op = opsForValueType(first.valueType)[0] ?? 'eq';
    return { id: this.newId(), kind: 'leaf', attr: first.name, op, values: [] };
  }

  private addLeaf(group: EditGroup, schema: readonly AttrSchema[]): void {
    group.children.push(this.defaultLeaf(schema));
    this.mutate();
  }

  private addGroup(group: EditGroup): void {
    group.children.push({ id: this.newId(), kind: 'group', connective: 'and', children: [] });
    this.mutate();
  }

  private removeChild(group: EditGroup, id: string): void {
    group.children = group.children.filter((c) => c.id !== id);
    this.mutate();
  }

  private setConnective(group: EditGroup, c: 'and' | 'or' | 'not'): void {
    group.connective = c;
    this.mutate();
  }

  private setLeafAttr(leaf: EditLeaf, name: string, schema: readonly AttrSchema[]): void {
    leaf.attr = name;
    const attr = findAttr(schema, name);
    // Reset op + values: the new attribute may not support the previous op,
    // and stale values from another attribute are confusing.
    leaf.op = (attr ? opsForValueType(attr.valueType)[0] : 'eq') ?? 'eq';
    leaf.values = [];
    this.mutate();
  }

  private setLeafOp(leaf: EditLeaf, op: Op): void {
    const prevArity = opArity(leaf.op);
    const prevOp = leaf.op;
    leaf.op = op;
    const newArity = opArity(op);
    const isPhaseOp = (o: Op): boolean => o === 'hasPhase' || o === 'parentStatusPhase';
    // Phase ops carry phase strings, not ref values — clear in both directions.
    if (isPhaseOp(op) || isPhaseOp(prevOp)) {
      leaf.values = [];
    } else if (newArity === 'none') {
      leaf.values = [];
    } else if (newArity === 'multi' && prevArity !== 'multi') {
      const v = leaf.values[0];
      leaf.values = v === undefined ? [] : [v];
    } else if (newArity === 'single' && prevArity === 'multi') {
      const v = leaf.values[0];
      leaf.values = v === undefined ? [] : [v];
    }
    this.mutate();
  }

  /** Set a leaf's value WITHOUT a structural re-render (value-only edit). The
   *  DOM input already holds the new text; we just thread it to the model +
   *  the valuePath leaf so the predicate stays in sync. */
  private setLeafValues(leaf: EditLeaf, values: unknown[]): void {
    leaf.values = values;
    this.writeValue();
  }

  private togglePhase(leaf: EditLeaf, phase: Phase): void {
    const cur = leaf.values.filter(isPhase);
    leaf.values = cur.includes(phase) ? cur.filter((p) => p !== phase) : [...cur, phase];
    this.writeValue();
  }

  /* ------------------------------- renderers ----------------------------- */

  private renderGroup(
    group: EditGroup,
    schema: readonly AttrSchema[],
    options: OptionsMap,
    isRoot: boolean,
  ): HTMLElement {
    const box = document.createElement('div');
    box.className = 'predfilter__group';
    box.dataset.predGroup = '';
    box.dataset.connective = group.connective;

    const headerRow = document.createElement('div');
    headerRow.className = 'predfilter__group-head';

    const connSel = document.createElement('select');
    connSel.className = 'predfilter__select predfilter__connective';
    connSel.setAttribute('aria-label', 'Connective');
    connSel.dataset.predConnective = '';
    for (const c of CONNECTIVES) {
      const opt = document.createElement('option');
      opt.value = c.value;
      opt.textContent = c.label;
      if (c.value === group.connective) opt.selected = true;
      connSel.append(opt);
    }
    this.listen(connSel, 'change', () => {
      const v = connSel.value;
      if (v === 'and' || v === 'or' || v === 'not') this.setConnective(group, v);
    });

    const addLeafBtn = document.createElement('button');
    addLeafBtn.type = 'button';
    addLeafBtn.className = 'btn predfilter__add';
    addLeafBtn.dataset.predAddLeaf = '';
    addLeafBtn.textContent = '+ leaf';
    this.listen(addLeafBtn, 'click', () => this.addLeaf(group, schema));

    const addGroupBtn = document.createElement('button');
    addGroupBtn.type = 'button';
    addGroupBtn.className = 'btn predfilter__add';
    addGroupBtn.dataset.predAddGroup = '';
    addGroupBtn.textContent = '+ group';
    this.listen(addGroupBtn, 'click', () => this.addGroup(group));

    headerRow.append(connSel, addLeafBtn, addGroupBtn);

    if (!isRoot) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn predfilter__remove';
      removeBtn.dataset.predRemoveGroup = '';
      removeBtn.setAttribute('aria-label', 'Remove group');
      removeBtn.textContent = '×';
      // Removal is from the parent; we look up the parent via a closure passed
      // down. Simpler: the parent renders this group and owns its children, so
      // the remove handler is installed by the parent (see child loop below).
      headerRow.append(removeBtn);
      box.dataset.removeId = group.id;
    }

    box.append(headerRow);

    const list = document.createElement('div');
    list.className = 'predfilter__children';
    if (group.children.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'predfilter__empty muted';
      empty.textContent = 'Empty group. Add a leaf or nested group.';
      list.append(empty);
    } else {
      for (const child of group.children) {
        const row = document.createElement('div');
        row.className = 'predfilter__child';
        if (child.kind === 'leaf') {
          row.append(this.renderLeaf(child, group, schema, options));
        } else {
          const sub = this.renderGroup(child, schema, options, false);
          // Wire the sub-group's own remove button to remove it from THIS group.
          const rm = sub.querySelector('[data-pred-remove-group]');
          if (rm) this.listen(rm, 'click', () => this.removeChild(group, child.id));
          row.append(sub);
        }
        list.append(row);
      }
    }
    box.append(list);
    return box;
  }

  private renderLeaf(
    leaf: EditLeaf,
    parent: EditGroup,
    schema: readonly AttrSchema[],
    options: OptionsMap,
  ): HTMLElement {
    const attr = findAttr(schema, leaf.attr);

    const row = document.createElement('div');
    row.className = 'predfilter__leaf';
    row.dataset.predLeaf = '';

    /* attribute selector */
    const attrSel = document.createElement('select');
    attrSel.className = 'predfilter__select predfilter__attr';
    attrSel.setAttribute('aria-label', 'Attribute');
    attrSel.dataset.predAttr = '';
    if (schema.length === 0) {
      const opt = document.createElement('option');
      opt.value = leaf.attr;
      opt.textContent = leaf.attr || '(no attributes)';
      opt.selected = true;
      attrSel.append(opt);
    } else {
      for (const a of schema) {
        const opt = document.createElement('option');
        opt.value = a.name;
        opt.textContent = a.label;
        if (a.name === leaf.attr) opt.selected = true;
        attrSel.append(opt);
      }
    }
    this.listen(attrSel, 'change', () => this.setLeafAttr(leaf, attrSel.value, schema));

    /* operator selector */
    const opSel = document.createElement('select');
    opSel.className = 'predfilter__select predfilter__op';
    opSel.setAttribute('aria-label', 'Operator');
    opSel.dataset.predOp = '';
    const ops = attr ? opsForValueType(attr.valueType) : (['eq', 'ne'] as Op[]);
    for (const o of ops) {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = opLabel(o);
      if (o === leaf.op) opt.selected = true;
      opSel.append(opt);
    }
    this.listen(opSel, 'change', () => this.setLeafOp(leaf, opSel.value as Op));

    /* value editor */
    const valueWrap = document.createElement('div');
    valueWrap.className = 'predfilter__value';
    valueWrap.dataset.predValue = '';
    this.fillValueEditor(valueWrap, leaf, attr, options);

    /* remove */
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn predfilter__remove';
    removeBtn.dataset.predRemoveLeaf = '';
    removeBtn.setAttribute('aria-label', 'Remove leaf');
    removeBtn.textContent = '×';
    this.listen(removeBtn, 'click', () => this.removeChild(parent, leaf.id));

    row.append(attrSel, opSel, valueWrap, removeBtn);
    return row;
  }

  /**
   * Populate the value-editor slot for a leaf by op + the attribute's
   * value_type. Mirrors the Svelte ValueInput's by-type branches:
   *   - none-arity ops (exists / notExists / notTerminal / beforeToday): a
   *     "no value" marker, no editor.
   *   - withinDays: numeric day-count input (overrides the date type).
   *   - hasPhase / parentStatusPhase: triage/active/terminal checkboxes.
   *   - card_ref / card_ref[]: single/multi <select> from the options map.
   *   - bool: checkbox. number/date/text: typed <input>.
   */
  private fillValueEditor(
    host: HTMLElement,
    leaf: EditLeaf,
    attr: AttrSchema | undefined,
    options: OptionsMap,
  ): void {
    host.replaceChildren();
    const arity = opArity(leaf.op);

    if (arity === 'none') {
      const span = document.createElement('span');
      span.className = 'predfilter__novalue muted';
      span.dataset.predNovalue = '';
      span.textContent = 'no value';
      host.append(span);
      return;
    }

    if (leaf.op === 'withinDays') {
      host.append(this.numberInput(leaf, attr?.label ?? leaf.attr, true));
      return;
    }

    if (leaf.op === 'hasPhase' || leaf.op === 'parentStatusPhase') {
      host.append(this.phasePicker(leaf));
      return;
    }

    const valueType = attr?.valueType ?? 'text';

    if (valueType === 'card_ref' || valueType === 'card_ref[]') {
      const multi = arity === 'multi';
      host.append(this.refPicker(leaf, attr, options, multi));
      return;
    }
    if (valueType === 'bool') {
      host.append(this.boolInput(leaf, attr?.label ?? leaf.attr));
      return;
    }
    if (valueType === 'number') {
      host.append(this.numberInput(leaf, attr?.label ?? leaf.attr, false));
      return;
    }
    if (valueType === 'date') {
      host.append(this.dateInput(leaf, attr?.label ?? leaf.attr));
      return;
    }
    // text + unknown fallback.
    host.append(this.textInput(leaf, attr?.label ?? leaf.attr));
  }

  private textInput(leaf: EditLeaf, label: string): HTMLElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'predfilter__input';
    input.setAttribute('aria-label', label);
    input.value = asInputString(leaf.values[0]);
    this.listen(input, 'input', () => this.setLeafValues(leaf, [input.value]));
    return input;
  }

  private numberInput(leaf: EditLeaf, label: string, dayCount: boolean): HTMLElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'predfilter__input';
    input.setAttribute('aria-label', label);
    if (dayCount) input.setAttribute('min', '0');
    input.value = asInputString(leaf.values[0]);
    this.listen(input, 'input', () => {
      const raw = input.value;
      if (raw === '') {
        this.setLeafValues(leaf, []);
        return;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || (dayCount && n < 0)) {
        this.setLeafValues(leaf, []);
        return;
      }
      this.setLeafValues(leaf, [dayCount ? Math.floor(n) : n]);
    });
    return input;
  }

  private dateInput(leaf: EditLeaf, label: string): HTMLElement {
    const input = document.createElement('input');
    input.type = 'date';
    input.className = 'predfilter__input';
    input.setAttribute('aria-label', label);
    input.value = asInputString(leaf.values[0]);
    this.listen(input, 'input', () => {
      const v = input.value;
      this.setLeafValues(leaf, v === '' ? [] : [v]);
    });
    return input;
  }

  private boolInput(leaf: EditLeaf, label: string): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'predfilter__bool';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('aria-label', label);
    input.checked = leaf.values[0] === true;
    this.listen(input, 'change', () => this.setLeafValues(leaf, [input.checked]));
    const text = document.createElement('span');
    text.textContent = label;
    wrap.append(input, text);
    return wrap;
  }

  private phasePicker(leaf: EditLeaf): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'predfilter__phases';
    wrap.dataset.predPhases = '';
    const selected = leaf.values.filter(isPhase);
    for (const phase of PHASES) {
      const label = document.createElement('label');
      label.className = 'predfilter__phase';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('aria-label', phaseLabel(phase));
      input.checked = selected.includes(phase);
      this.listen(input, 'change', () => this.togglePhase(leaf, phase));
      const text = document.createElement('span');
      text.textContent = phaseLabel(phase);
      label.append(input, text);
      wrap.append(label);
    }
    return wrap;
  }

  private refPicker(
    leaf: EditLeaf,
    attr: AttrSchema | undefined,
    options: OptionsMap,
    multi: boolean,
  ): HTMLElement {
    const sel = document.createElement('select');
    sel.className = 'predfilter__select predfilter__ref';
    sel.setAttribute('aria-label', attr?.label ?? leaf.attr);
    sel.dataset.predRef = '';
    if (multi) sel.multiple = true;
    const list = attr?.targetCardType ? (options[attr.targetCardType] ?? []) : [];

    // For single-select, a leading blank lets the user clear the value.
    if (!multi) {
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = '—';
      sel.append(blank);
    }
    const selectedStrs = new Set(leaf.values.map((v) => String(v)));
    for (const o of list) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      if (selectedStrs.has(o.value)) opt.selected = true;
      sel.append(opt);
    }
    this.listen(sel, 'change', () => {
      if (multi) {
        const picked = Array.from(sel.children)
          .filter((o) => (o as HTMLOptionElement).selected)
          .map((o) => (o as HTMLOptionElement).value)
          .filter((v) => v !== '');
        this.setLeafValues(leaf, picked);
      } else {
        const v = sel.value;
        this.setLeafValues(leaf, v === '' ? [] : [v]);
      }
    });
    return sel;
  }

  /* ----------------------------- test helpers ---------------------------- */

  /** The current predicate (null when the root is an empty AND). Test/host hook. */
  currentPredicate(): Predicate | null {
    const pred = this.toPredicate(this.root);
    if (pred.kind === 'group' && pred.connective === 'and' && pred.children.length === 0) {
      return null;
    }
    return pred;
  }

  /** The current predicate's wire shape (null when empty). Test/host hook. */
  currentWire(): unknown {
    const p = this.currentPredicate();
    return p === null ? null : toWire(p);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                   */
/* -------------------------------------------------------------------------- */

function isAst(v: unknown): boolean {
  return (
    v !== null &&
    typeof v === 'object' &&
    'kind' in (v as Record<string, unknown>) &&
    ((v as Record<string, unknown>).kind === 'leaf' ||
      (v as Record<string, unknown>).kind === 'group')
  );
}

function asInputString(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

function phaseLabel(p: Phase): string {
  return p.charAt(0).toUpperCase() + p.slice(1);
}

export function registerPredicateFilter(): void {
  Control.register('PredicateFilter', PredicateFilter);
}
