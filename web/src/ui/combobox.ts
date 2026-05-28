/**
 * Combobox — typeahead single-select. A text-input trigger + a Popover listbox
 * of options, with substring filtering, keyboard nav (↑/↓/Enter/Esc), and an
 * optional async option loader.
 *
 * Ported from the Svelte client's Combobox.svelte (single-select slice). The
 * floating panel goes through the shared `Popover` helper — the one floating
 * implementation in the client. The Svelte version inlined computePosition;
 * here Popover owns it.
 *
 * ZERO-PROMISE SURFACE. The async loader is the framework's callback-dispatcher
 * shape, NOT a Promise:
 *
 *     loadOptions: (query, deliver) => void
 *
 * The control calls `loadOptions(query, deliver)`; the caller fires `deliver`
 * with the option list when its request settles (e.g. from an Api query's
 * `onOk`). The control guards staleness with a monotonic sequence so a slow
 * earlier request can't clobber a fresher one, and ignores deliveries after
 * close/destroy. This mirrors `dispatch.ts`'s `onOk`/`onFault` convention —
 * no `.then`/`await` ever crosses the control boundary, so it cannot feed a
 * Svelte-style effect cascade.
 *
 * Selection is emitted via the `onChange(value)` callback (cascade-safe — the
 * caller writes a tree signal / fires an intent from there). Keystroke-driven
 * loads debounce (180ms); the empty-query load on open fires immediately.
 */

import { Control, type BaseControlConfig, type ControlContext } from '../core/control.js';
import { Popover } from './popover.js';

export interface ComboboxOption<V = unknown> {
  value: V;
  label: string;
  disabled?: boolean;
}

/**
 * Async loader, callback-dispatcher form. Invoked with the current query and a
 * `deliver` sink; call `deliver(options)` when the underlying request settles.
 * Late/stale deliveries are dropped by the control. Errors are the caller's to
 * surface (deliver an empty list, or nothing, on failure).
 */
export type ComboboxLoad<V = unknown> = (
  query: string,
  deliver: (options: ComboboxOption<V>[]) => void,
) => void;

export interface ComboboxConfig<V = unknown> extends BaseControlConfig {
  type: 'Combobox';
  /** Initial selected value, or null for "nothing selected". */
  value?: V | null;
  /** Static option list. Ignored when `loadOptions` is set (async is source of truth). */
  options?: ComboboxOption<V>[];
  /**
   * Always-available options pinned to the TOP of the list, shown in both
   * static and async modes (e.g. a "Self" quick-pick). They are substring-
   * filtered by the query like any option and deduped against the result list
   * by value, so a pinned id that the loader also returns appears once. The
   * control treats these generically — semantics (what "Self" means) live in
   * the host that supplies them.
   */
  pinnedOptions?: ComboboxOption<V>[];
  /** Async option loader (callback-dispatcher form). When set, switches to async mode. */
  loadOptions?: ComboboxLoad<V>;
  /** Trigger placeholder when nothing is selected. */
  placeholder?: string;
  /** Disable the control. */
  disabled?: boolean;
  /** Fired with the newly selected value on each pick. */
  onChange?: (value: V | null) => void;
  /** ARIA label for the trigger. */
  'aria-label'?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Combobox: ComboboxConfig<any>;
  }
}

const DEBOUNCE_MS = 180;

export class Combobox<V = unknown> extends Control<ComboboxConfig<V>> {
  private value: V | null = null;
  private staticOptions: ComboboxOption<V>[] = [];
  private pinnedOptions: ComboboxOption<V>[] = [];
  private asyncOptions: ComboboxOption<V>[] = [];
  private filtered: ComboboxOption<V>[] = [];
  private query = '';
  private highlightIdx = 0;

  private readonly isAsync: boolean = false;

  private popover: Popover | null = null;
  private triggerEl!: HTMLButtonElement;
  private labelEl!: HTMLSpanElement;
  private searchEl!: HTMLInputElement;
  private listEl!: HTMLUListElement;

  /** Monotonic load counter so a stale async delivery resolves into a no-op. */
  private loadSeq = 0;
  private debounceHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(...args: ConstructorParameters<typeof Control<ComboboxConfig<V>>>) {
    super(...args);
    this.value = this.config.value ?? null;
    this.staticOptions = this.config.options ?? [];
    this.pinnedOptions = this.config.pinnedOptions ?? [];
    this.isAsync = typeof this.config.loadOptions === 'function';
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'kf-combobox';
    el.dataset.control = 'Combobox';
    return el;
  }

  protected render(): void {
    const disabled = this.config.disabled === true;

    // Trigger button.
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'kf-combobox__trigger';
    trigger.dataset.cbTrigger = '';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    if (this.config['aria-label']) trigger.setAttribute('aria-label', this.config['aria-label']);
    if (disabled) trigger.disabled = true;

    const label = document.createElement('span');
    label.className = 'kf-combobox__label';
    trigger.appendChild(label);

    const caret = document.createElement('span');
    caret.className = 'kf-combobox__caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = '▾'; // ▾
    trigger.appendChild(caret);

    this.el.appendChild(trigger);
    this.triggerEl = trigger;
    this.labelEl = label;
    this.renderTriggerLabel();

    this.listen(trigger, 'click', () => {
      if (this.config.disabled === true) return;
      this.isMenuOpen() ? this.closeMenu() : this.openMenu();
    });
    this.listen(trigger, 'keydown', (e) => this.onTriggerKeydown(e as KeyboardEvent));

    // Build the panel content once; Popover owns its placement + show/hide.
    this.popover = new Popover(trigger, {
      placement: 'bottom-start',
      width: 'anchor',
      clampHeight: true,
      onClose: () => this.afterSelfClose(),
    });
    this.buildPanel(this.popover.element);
    this.onDestroy(() => {
      this.clearDebounce();
      this.popover?.destroy();
      this.popover = null;
    });
  }

  /* --------------------------------------------------------------- public API */

  /** The current selected value (null when unset). */
  getValue(): V | null {
    return this.value;
  }

  /** Imperatively set the value WITHOUT firing onChange (programmatic sync). */
  setValue(v: V | null): void {
    this.value = v;
    this.renderTriggerLabel();
  }

  /**
   * Imperatively replace the static option list (programmatic sync — no
   * onChange). Used by hosts that drive the options from a reactive tree leaf
   * (e.g. the FilterPresetSelector's saved-filter list). Re-renders the trigger
   * label (the selected value's label may now resolve) and, if the menu is
   * open in static mode, the visible list.
   */
  setOptions(options: ComboboxOption<V>[]): void {
    this.staticOptions = options;
    this.renderTriggerLabel();
    if (!this.isAsync && this.isMenuOpen()) {
      this.recomputeFiltered();
      this.renderList();
    }
  }

  /** Imperatively open the menu (e.g. a keyboard chord on a parent screen). */
  openMenu(): void {
    if (this.config.disabled === true || this.isMenuOpen()) return;
    this.query = '';
    this.searchEl.value = '';
    this.highlightIdx = 0;
    if (this.isAsync) {
      this.asyncOptions = [];
      this.renderList('loading');
      this.scheduleLoad('', true);
    } else {
      this.recomputeFiltered();
      this.renderList();
    }
    this.triggerEl.setAttribute('aria-expanded', 'true');
    this.popover?.open();
    // The panel is focusable immediately (Popover hides via opacity, not
    // visibility), so focusing the search input here works on the first frame.
    this.searchEl.focus();
  }

  closeMenu(): void {
    if (!this.isMenuOpen()) return;
    this.clearDebounce();
    // Bump so any in-flight async delivery is discarded.
    this.loadSeq++;
    this.triggerEl.setAttribute('aria-expanded', 'false');
    this.popover?.close();
  }

  /* ---------------------------------------------------------------- internals */

  private isMenuOpen(): boolean {
    return this.popover?.isOpen === true;
  }

  /** Popover closed itself (Esc / outside-click) — keep our state in sync. */
  private afterSelfClose(): void {
    this.clearDebounce();
    this.loadSeq++;
    this.triggerEl.setAttribute('aria-expanded', 'false');
  }

  private buildPanel(panel: HTMLElement): void {
    panel.classList.add('kf-combobox__panel');

    const searchWrap = document.createElement('div');
    searchWrap.className = 'kf-combobox__search';
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'kf-combobox__search-input';
    search.placeholder = 'Search…';
    search.setAttribute('aria-label', 'Filter options');
    searchWrap.appendChild(search);
    panel.appendChild(searchWrap);
    this.searchEl = search;

    const list = document.createElement('ul');
    list.className = 'kf-combobox__list';
    list.setAttribute('role', 'listbox');
    panel.appendChild(list);
    this.listEl = list;

    this.listen(search, 'input', () => {
      this.query = search.value;
      this.highlightIdx = 0;
      if (this.isAsync) {
        this.renderList('loading');
        this.scheduleLoad(this.query, false);
      } else {
        this.recomputeFiltered();
        this.renderList();
      }
    });
    this.listen(search, 'keydown', (e) => this.onMenuKeydown(e as KeyboardEvent));
    this.listen(list, 'keydown', (e) => this.onMenuKeydown(e as KeyboardEvent));
  }

  private recomputeFiltered(): void {
    const q = this.query.trim().toLowerCase();
    // Async: the loader is the single source of truth for the body — no client
    // narrowing. Static: substring-filter locally.
    const body = this.isAsync
      ? this.asyncOptions
      : q === ''
        ? this.staticOptions
        : this.staticOptions.filter((o) => o.label.toLowerCase().includes(q));
    this.filtered = this.withPinned(body, q);
  }

  /**
   * Prepend the query-matching pinned options to `body`, deduped against it by
   * value (a pinned id the loader also returned shows once, in the body's
   * position is dropped in favour of the pinned slot at top).
   */
  private withPinned(body: ComboboxOption<V>[], q: string): ComboboxOption<V>[] {
    if (this.pinnedOptions.length === 0) return body;
    const pinned = q === ''
      ? this.pinnedOptions
      : this.pinnedOptions.filter((o) => o.label.toLowerCase().includes(q));
    if (pinned.length === 0) return body;
    const pinnedValues = new Set(pinned.map((o) => o.value));
    return [...pinned, ...body.filter((o) => !pinnedValues.has(o.value))];
  }

  /** Resolve a label for `value` from whichever option list knows it. */
  private labelFor(value: V): string | null {
    const all = [...this.pinnedOptions, ...this.staticOptions, ...this.asyncOptions];
    const hit = all.find((o) => o.value === value);
    return hit ? hit.label : null;
  }

  private renderTriggerLabel(): void {
    const placeholder = this.config.placeholder ?? 'Select…';
    if (this.value === null) {
      this.labelEl.textContent = placeholder;
      this.labelEl.classList.add('kf-combobox__label--placeholder');
      return;
    }
    const lbl = this.labelFor(this.value);
    this.labelEl.classList.remove('kf-combobox__label--placeholder');
    this.labelEl.textContent = lbl ?? `#${String(this.value)}`;
  }

  private renderList(state: 'ready' | 'loading' = 'ready'): void {
    this.listEl.replaceChildren();
    // While the async body loads, still surface the pinned quick-picks (e.g.
    // "Self") at the top so they're available immediately, with a Loading row
    // beneath. `filtered` is set to the pinned-only list so keyboard nav +
    // Enter stay consistent with what's painted.
    if (state === 'loading') {
      this.filtered = this.withPinned([], this.query.trim().toLowerCase());
      this.filtered.forEach((opt, i) => this.appendOption(opt, i));
      const li = document.createElement('li');
      li.className = 'kf-combobox__empty';
      li.textContent = 'Loading…';
      this.listEl.appendChild(li);
      return;
    }
    if (this.filtered.length === 0) {
      const li = document.createElement('li');
      li.className = 'kf-combobox__empty';
      li.textContent = 'No matches';
      this.listEl.appendChild(li);
      return;
    }
    this.filtered.forEach((opt, i) => this.appendOption(opt, i));
  }

  /** Render one option <li> at index `i` into the list. */
  private appendOption(opt: ComboboxOption<V>, i: number): void {
    const li = document.createElement('li');
    li.className = 'kf-combobox__option';
    li.setAttribute('role', 'option');
    li.dataset.cbOption = String(i);
    const selected = this.value !== null && opt.value === this.value;
    li.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (selected) li.classList.add('kf-combobox__option--selected');
    if (opt.disabled) {
      li.classList.add('kf-combobox__option--disabled');
      li.setAttribute('aria-disabled', 'true');
    }
    if (i === this.highlightIdx) li.classList.add('kf-combobox__option--active');
    li.textContent = opt.label;
    this.listen(li, 'pointerenter', () => {
      this.highlightIdx = i;
      this.paintActive();
    });
    this.listen(li, 'click', () => this.selectOption(opt));
    this.listEl.appendChild(li);
  }

  /** Cheap highlight-only repaint (no full rebuild) on arrow / hover move. */
  private paintActive(): void {
    const items = this.listEl.querySelectorAll('[data-cb-option]');
    items.forEach((node, i) => {
      (node as HTMLElement).classList.toggle('kf-combobox__option--active', i === this.highlightIdx);
    });
    const active = items[this.highlightIdx] as HTMLElement | undefined;
    active?.scrollIntoView({ block: 'nearest' });
  }

  private moveHighlight(delta: number): void {
    const n = this.filtered.length;
    if (n === 0) return;
    let i = this.highlightIdx;
    for (let attempts = 0; attempts < n; attempts++) {
      i += delta;
      if (i < 0) i = n - 1;
      if (i >= n) i = 0;
      const opt = this.filtered[i];
      if (opt && !opt.disabled) {
        this.highlightIdx = i;
        this.paintActive();
        return;
      }
    }
  }

  private selectOption(opt: ComboboxOption<V>): void {
    if (opt.disabled) return;
    // Close BEFORE emitting: onChange may synchronously rearrange the parent
    // (refetch, rerender); closing first guarantees the listbox is gone
    // regardless of what the callback does.
    this.closeMenu();
    this.value = opt.value;
    this.renderTriggerLabel();
    this.triggerEl.focus();
    this.config.onChange?.(this.value);
  }

  private onTriggerKeydown(e: KeyboardEvent): void {
    if (this.config.disabled === true) return;
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.openMenu();
    } else if (e.key === 'Escape' && this.isMenuOpen()) {
      e.preventDefault();
      this.closeMenu();
    }
  }

  private onMenuKeydown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.moveHighlight(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.moveHighlight(-1);
        break;
      case 'Enter': {
        e.preventDefault();
        const opt = this.filtered[this.highlightIdx];
        if (opt) this.selectOption(opt);
        break;
      }
      case 'Escape':
        e.preventDefault();
        this.closeMenu();
        this.triggerEl.focus();
        break;
      case 'Tab':
        this.closeMenu();
        break;
      case 'Home':
        e.preventDefault();
        this.highlightIdx = 0;
        this.paintActive();
        break;
      case 'End':
        e.preventDefault();
        this.highlightIdx = Math.max(0, this.filtered.length - 1);
        this.paintActive();
        break;
      default:
        break;
    }
  }

  /* --------------------------------------------------------- async load path */

  private clearDebounce(): void {
    if (this.debounceHandle !== null) {
      clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
  }

  /**
   * Queue an async load. Empty-query (just-opened) fires immediately;
   * keystroke-driven loads debounce. Each load carries a sequence number;
   * a delivery whose sequence is stale (a newer load started, or the menu
   * closed) is dropped.
   */
  private scheduleLoad(query: string, immediate: boolean): void {
    const load = this.config.loadOptions;
    if (load === undefined) return;
    this.clearDebounce();
    const fire = (): void => {
      this.debounceHandle = null;
      const seq = ++this.loadSeq;
      load(query, (options) => {
        // Drop stale / post-close deliveries.
        if (seq !== this.loadSeq) return;
        if (!this.isMenuOpen()) return;
        this.asyncOptions = options;
        this.recomputeFiltered();
        this.highlightIdx = 0;
        this.renderList();
        this.popover?.reposition();
      });
    };
    if (immediate) fire();
    else this.debounceHandle = setTimeout(fire, DEBOUNCE_MS);
  }
}

export function registerCombobox(): void {
  // `Combobox` is generic over the option value type, but the registry stores a
  // single type-erased ctor keyed by the string 'Combobox' (the runtime factory
  // path is Map.get). The declaration-merged ControlConfigMap entry is
  // ComboboxConfig<any>; instances narrow V at their call site via the typed
  // config they receive. Register the unknown-V concrete class — the cast is at
  // this single registration boundary, never at a consumer call site.
  Control.register(
    'Combobox',
    Combobox as unknown as new (
      type: string,
      config: ComboboxConfig<unknown>,
      ctx: ControlContext,
    ) => Control,
  );
}
