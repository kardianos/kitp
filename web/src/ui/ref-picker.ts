/**
 * RefPicker — the card_ref attribute editor (control type `'RefPicker'`).
 *
 * Every card_ref attribute edits through this: assignee / status / milestone /
 * component / parent_task (single), tags / comm_recipients (multi). It is a thin
 * shell over the shared {@link Combobox}: the Combobox owns the typeahead UI +
 * keyboard nav + the async-load lifecycle; RefPicker supplies the `loadOptions`
 * sink that fires `card.search` and maps rows → options.
 *
 * ZERO-PROMISE SURFACE. The `card.search` lookup goes through the declarative
 * `api.callByName('card.search', …)` callback path; the result lands in the
 * Combobox's `deliver` sink from the query's `onOk` — NO promise crosses the
 * control boundary (the same contract as Combobox's `loadOptions`). Stale /
 * post-close deliveries are dropped by the Combobox's sequence guard AND by an
 * `alive`/sequence gate here so a destroyed picker never delivers.
 *
 * Selection is emitted via `onChange`:
 *   - single: `onChange(value: bigint | null)` — emitted AFTER the menu closes
 *     (Combobox closes before firing its own onChange), so a cascade-driven
 *     parent rerender can't tear the open listbox out from under us.
 *   - multi:  `onChange(values: bigint[])` — emitted on each chip add/remove.
 *
 * The trigger shows the current value's label before any menu opens: pass
 * `currentLabel` (single) / `currentLabels` (multi map) for the known label,
 * falling back to `#<id>` when unknown. Once the menu has loaded options the
 * Combobox resolves freshly-picked labels itself.
 *
 * `parentScopePath` (optional) is a dotted tree path holding a `bigint | null`
 * parent-card id; when set + non-null it scopes `card.search` to that parent's
 * direct children. Peeked at fire time (not subscribed) so it reflects the
 * latest scope without re-rendering the control.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { splitPath } from '../core/data.js';
import { Combobox, type ComboboxOption } from './combobox.js';
import { CARD_SEARCH_SPEC, type CardSearchOutput } from './specs.js';

/** A pinned quick-pick (e.g. "Self") always shown atop the single-mode list. */
export type RefPinnedOption = ComboboxOption<bigint>;

/* -------------------------------------------------------------------------- */
/* Config + declaration-merged registry type.                                 */
/* -------------------------------------------------------------------------- */

export interface RefPickerConfig extends BaseControlConfig {
  type: 'RefPicker';
  /** The card_type the ref targets (e.g. 'milestone', 'contact'). Required. */
  cardType: string;
  /**
   * Single mode: the current value (bigint id) or null.
   * Multi mode: ignored — use `values`.
   */
  value?: bigint | null;
  /** Multi mode: the current selected id list. Ignored in single mode. */
  values?: bigint[];
  /** When true, render the chips + add-combobox multi editor (card_ref[]). */
  multi?: boolean;
  /**
   * Multi mode only: keep the add-combobox hidden behind a "+ <addLabel>"
   * button, so the picker shows just its chips at rest and only reveals the
   * search field once the operator opts in. Reverts to collapsed on the next
   * repaint. Ignored in single mode.
   */
  collapsedAdd?: boolean;
  /** Label for the collapsed-add affordance (e.g. 'recipient' → "+ recipient"). */
  addLabel?: string;
  /**
   * Dotted tree path holding a `bigint | null` parent-card id; when set +
   * non-null, scopes `card.search` to that parent's direct children. Peeked at
   * fire time.
   */
  parentScopePath?: string;
  /** Known label for the current single value, shown before the menu opens. */
  currentLabel?: string;
  /** Known labels for current multi values, keyed by stringified id. */
  currentLabels?: Record<string, string>;
  /**
   * Single-mode only: options pinned to the top of the dropdown regardless of
   * the search query (e.g. a "Self" person quick-pick resolving to the caller's
   * person card). Their labels seed the trigger label cache so a pinned pick
   * shows its label immediately. Ignored in multi mode.
   */
  pinnedOptions?: RefPinnedOption[];
  /** Trigger placeholder when nothing is selected. */
  placeholder?: string;
  /** Disable the control. */
  disabled?: boolean;
  /** ARIA label for the trigger / add-combobox. */
  'aria-label'?: string;
  /** Single: fired with the new bigint id (or null on clear). */
  onChange?: (value: bigint | null) => void;
  /** Multi: fired with the full new id list on each add/remove. */
  onChangeMulti?: (values: bigint[]) => void;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    RefPicker: RefPickerConfig;
  }
}

/* -------------------------------------------------------------------------- */
/* Control.                                                                   */
/* -------------------------------------------------------------------------- */

export class RefPicker extends Control<RefPickerConfig> {
  /** Single-mode current value. */
  private value: bigint | null = null;
  /** Multi-mode current values (insertion order preserved). */
  private values: bigint[] = [];
  /**
   * Label cache: stringified id → label. Seeded from currentLabel(s), grown as
   * `card.search` rows arrive so removed-then-readded chips keep a real label.
   */
  private readonly labels = new Map<string, string>();

  private readonly isMulti: boolean = false;
  /** Multi-mode: keep the add-combobox behind a "+ <addLabel>" reveal button. */
  private readonly collapsedAdd: boolean = false;

  /** The single-mode Combobox, or the multi-mode add-combobox. */
  private combo: Combobox<bigint> | null = null;
  /** Multi-mode chips container. */
  private chipsEl: HTMLElement | null = null;

  /** Monotonic gate so a delivery from a superseded search resolves to a no-op. */
  private searchSeq = 0;

  constructor(...args: ConstructorParameters<typeof Control<RefPickerConfig>>) {
    super(...args);
    this.isMulti = this.config.multi === true;
    this.collapsedAdd = this.isMulti && this.config.collapsedAdd === true;
    this.value = this.config.value ?? null;
    this.values = (this.config.values ?? []).slice();
    // Seed the label cache from the host-provided known labels.
    if (this.config.currentLabel !== undefined && this.value !== null) {
      this.labels.set(String(this.value), this.config.currentLabel);
    }
    const cl = this.config.currentLabels;
    if (cl) {
      for (const k of Object.keys(cl)) {
        const v = cl[k];
        if (typeof v === 'string') this.labels.set(k, v);
      }
    }
    // Seed labels for pinned quick-picks so the trigger resolves after a pick.
    for (const opt of this.config.pinnedOptions ?? []) {
      this.labels.set(String(opt.value), opt.label);
    }
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    // Read this.config (set before super() calls createRoot), NOT this.isMulti /
    // this.collapsedAdd — those field initializers run AFTER super() under
    // ES2022 define-class-fields, so they're still undefined here.
    const multi = this.config.multi === true;
    let cls = multi ? 'kf-refpicker kf-refpicker--multi' : 'kf-refpicker';
    // Collapsed-add lays chips + reveal/search inline on one row and starts
    // collapsed (combobox hidden, "+ <label>" button showing).
    if (multi && this.config.collapsedAdd === true) {
      cls += ' kf-refpicker--inline-add kf-refpicker--collapsed';
    }
    el.className = cls;
    el.dataset.control = 'RefPicker';
    return el;
  }

  protected render(): void {
    if (this.isMulti) this.renderMulti();
    else this.renderSingle();
  }

  /* ------------------------------ public API ----------------------------- */

  /** Current single value (null when unset). */
  getValue(): bigint | null {
    return this.value;
  }

  /** Current multi values. */
  getValues(): bigint[] {
    return this.values.slice();
  }

  /** Open the dropdown immediately (lets a host skip the extra click when the
   *  picker is mounted specifically to be edited — e.g. task-detail row expand). */
  open(): void {
    this.combo?.openMenu();
  }

  /* ------------------------------- single -------------------------------- */

  private renderSingle(): void {
    const cb = this.makeCombobox(this.value, (v) => {
      // Combobox already closed its menu before this fires.
      this.value = v;
      if (v !== null) this.cacheLabelFromCombo(v);
      this.config.onChange?.(v);
    });
    this.combo = cb;
    cb.parent = this;
    this.children.add(cb);
    cb.mount(this.el);
    // Seed the trigger label from the known label (before any menu opens).
    this.applyTriggerLabel();
  }

  /* -------------------------------- multi -------------------------------- */

  private renderMulti(): void {
    // Collapsed-add: a "+ <label>" button leads the row (reveals the search
    // combobox on demand), so the row reads "[+ recipient] [chip] [chip]" and
    // the revealed search box also sits on the left. Omitted when disabled.
    if (this.collapsedAdd && this.config.disabled !== true) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'kf-refpicker__add-btn';
      add.dataset.rpAdd = '';
      add.textContent = `+ ${this.config.addLabel ?? 'Add'}`;
      this.listen(add, 'click', () => this.revealAdd());
      this.el.appendChild(add);
    }

    const chips = document.createElement('div');
    chips.className = 'kf-refpicker__chips';
    chips.dataset.rpChips = '';
    this.chipsEl = chips;

    // The add-combobox: each pick appends to `values` (no single "current"
    // value — selecting adds a chip and clears the combobox selection so the
    // next search starts fresh).
    const cb = this.makeCombobox(null, (v) => {
      if (v === null) return;
      this.addValue(v);
      // Reset the combobox's own value so it doesn't show the just-added pick
      // as its "selected" label (chips are the source of truth).
      this.combo?.setValue(null);
    });
    this.combo = cb;
    cb.parent = this;
    this.children.add(cb);

    // Collapsed-add: combobox before chips (so it reveals on the left, after
    // the "+" button). Normal multi: chips first, then the add-combobox.
    if (this.collapsedAdd) {
      cb.mount(this.el);
      this.el.appendChild(chips);
    } else {
      this.el.appendChild(chips);
      cb.mount(this.el);
    }
    this.renderChips();
  }

  private renderChips(): void {
    if (this.chipsEl === null) return;
    this.chipsEl.replaceChildren();
    if (this.values.length === 0) {
      // Collapsed-add shows the "+ <label>" button as the empty affordance, so
      // skip the redundant placeholder text.
      if (this.collapsedAdd) return;
      const empty = document.createElement('span');
      empty.className = 'kf-refpicker__empty muted';
      empty.textContent = this.config.placeholder ?? 'No selections';
      this.chipsEl.appendChild(empty);
      return;
    }
    for (const id of this.values) {
      const chip = document.createElement('span');
      chip.className = 'kf-refpicker__chip';
      chip.dataset.rpChip = String(id);

      const label = document.createElement('span');
      label.className = 'kf-refpicker__chip-label';
      label.textContent = this.labelFor(id);
      chip.appendChild(label);

      if (this.config.disabled !== true) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'kf-refpicker__chip-remove';
        remove.dataset.rpRemove = String(id);
        remove.setAttribute('aria-label', `Remove ${this.labelFor(id)}`);
        remove.textContent = '×';
        this.listen(remove, 'click', () => this.removeValue(id));
        chip.appendChild(remove);
      }

      this.chipsEl.appendChild(chip);
    }
  }

  /** Reveal the collapsed add-combobox and open it (one extra click buys the
   *  search field; it stays revealed until the next repaint re-collapses it). */
  private revealAdd(): void {
    this.el.classList.remove('kf-refpicker--collapsed');
    this.combo?.openMenu();
  }

  /** Re-hide the add-combobox behind the "+ <label>" button (collapsed-add). */
  private recollapse(): void {
    if (this.collapsedAdd) this.el.classList.add('kf-refpicker--collapsed');
  }

  private addValue(id: bigint): void {
    if (this.values.some((v) => v === id)) return; // dedupe
    this.cacheLabelFromCombo(id);
    this.values = [...this.values, id];
    this.renderChips();
    this.config.onChangeMulti?.(this.values.slice());
  }

  private removeValue(id: bigint): void {
    this.values = this.values.filter((v) => v !== id);
    this.renderChips();
    this.config.onChangeMulti?.(this.values.slice());
  }

  /* ----------------------------- shared bits ----------------------------- */

  /**
   * Build a Combobox wired to fire `card.search` from its `loadOptions` sink.
   * `onPick` receives the chosen bigint (or null on clear) AFTER the Combobox
   * has closed its menu.
   */
  private makeCombobox(
    initial: bigint | null,
    onPick: (value: bigint | null) => void,
  ): Combobox<bigint> {
    const cfg = {
      type: 'Combobox' as const,
      value: initial,
      placeholder: this.config.placeholder ?? 'Search…',
      // Pinned quick-picks are a single-mode affordance (assignee/originator);
      // the multi add-combobox doesn't surface them.
      ...(!this.isMulti && this.config.pinnedOptions?.length
        ? { pinnedOptions: this.config.pinnedOptions }
        : {}),
      ...(this.config.disabled === true ? { disabled: true } : {}),
      ...(this.config['aria-label'] ? { 'aria-label': this.config['aria-label'] } : {}),
      // Collapsed-add: re-hide the search field once the menu closes (by a pick,
      // Esc, Tab, or outside-click) so it doesn't linger after use.
      ...(this.collapsedAdd ? { onClose: (): void => this.recollapse() } : {}),
      loadOptions: (query: string, deliver: (opts: ComboboxOption<bigint>[]) => void): void => {
        this.runSearch(query, deliver);
      },
      onChange: (v: bigint | null): void => onPick(v),
    };
    return new Combobox<bigint>('Combobox', cfg, this.ctx);
  }

  /**
   * Fire `card.search` for the current query + scope and feed mapped rows into
   * the Combobox's `deliver` sink. The query rides the framework's callback
   * dispatcher (`api.callByName(..., onOk)`) — no promise crosses the surface.
   * A monotonic seq + the control's `isAlive` gate drop stale / post-destroy
   * deliveries (the Combobox guards staleness too, belt-and-braces).
   */
  private runSearch(query: string, deliver: (opts: ComboboxOption<bigint>[]) => void): void {
    const seq = ++this.searchSeq;
    const input: Record<string, unknown> = { cardTypeName: this.config.cardType };
    if (query !== '') input['query'] = query;
    const parent = this.peekParentScope();
    if (parent !== null) input['parentCardId'] = parent;

    this.ctx.api.callByName(
      CARD_SEARCH_SPEC,
      input,
      (out) => {
        if (seq !== this.searchSeq) return; // a newer search superseded this one
        const rows = (out as CardSearchOutput).rows ?? [];
        const opts = rows.map((r) => {
          // Grow the label cache so chips / trigger labels resolve later.
          this.labels.set(String(r.id), r.title);
          return { value: r.id, label: r.title };
        });
        deliver(opts);
      },
      { alive: () => this.isAlive() },
    );
  }

  /** Peek the parent-scope tree leaf (bigint | null). Not subscribed. */
  private peekParentScope(): bigint | null {
    if (this.config.parentScopePath === undefined) return null;
    const v = this.ctx.tree.at(splitPath(this.config.parentScopePath)).peek<bigint | null>();
    return v ?? null;
  }

  /** Resolve a display label for an id: cached title, else `#<id>`. */
  private labelFor(id: bigint): string {
    return this.labels.get(String(id)) ?? `#${String(id)}`;
  }

  /**
   * Pull the just-picked value's label out of the Combobox option list (it
   * resolved a label when it rendered the option), falling back to the cache.
   */
  private cacheLabelFromCombo(id: bigint): void {
    if (this.labels.has(String(id))) return;
    // No label known yet — leave it to resolve to `#<id>` until a search row
    // for this id lands (the next open re-runs card.search and caches it).
  }

  /**
   * Push the single-mode trigger label so the known label shows before the
   * menu first opens. The Combobox resolves its own label from loaded options
   * once open; this seeds the initial paint via setValue (which relabels) and
   * patches the label text directly when only a host-provided label is known.
   */
  private applyTriggerLabel(): void {
    if (this.combo === null || this.value === null) return;
    const labelEl = this.combo.el.querySelector<HTMLElement>('.kf-combobox__label');
    if (labelEl) {
      labelEl.textContent = this.labelFor(this.value);
      labelEl.classList.remove('kf-combobox__label--placeholder');
    }
  }
}

export function registerRefPicker(): void {
  Control.register('RefPicker', RefPicker);
}
