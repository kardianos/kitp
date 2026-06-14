/**
 * DatePicker — a trigger button + a Popover month-grid calendar. Emits an ISO
 * `YYYY-MM-DD` (or null on clear) via the `onChange` callback.
 *
 * Ported from the Svelte client's DatePicker.svelte: 6×7 month grid (weeks
 * start Sunday), prev/next month, optional min/max range clamp, Today + Clear
 * shortcuts, full keyboard nav (arrows move a day, PageUp/Down move a month,
 * Home/End jump to week edges, Enter/Space pick, Esc closes). The floating
 * panel routes through the shared `Popover` helper — no direct floating-ui use.
 *
 * ZERO-PROMISE SURFACE: open/close/pick are synchronous; selection leaves via
 * the plain `onChange(iso)` callback (the caller writes a tree signal / fires
 * an intent). All date arithmetic is local-midnight Date math, so an ISO round
 * trip is stable regardless of timezone.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { Popover } from './popover.js';

import { icon as svgIcon } from './icons.js';
export interface DatePickerConfig extends BaseControlConfig {
  type: 'DatePicker';
  /** Initial value as ISO `YYYY-MM-DD`, or null. */
  value?: string | null;
  /** Inclusive lower bound (ISO). Days before it are disabled. */
  min?: string;
  /** Inclusive upper bound (ISO). Days after it are disabled. */
  max?: string;
  /** Trigger placeholder when unset. */
  placeholder?: string;
  disabled?: boolean;
  /** Fired with the new ISO date (or null on clear). */
  onChange?: (value: string | null) => void;
  'aria-label'?: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    DatePicker: DatePickerConfig;
  }
}

/** ISO `YYYY-MM-DD` → local-midnight Date, or null if malformed. */
function parseIso(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function toIso(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export class DatePicker extends Control<DatePickerConfig> {
  private value: string | null = null;
  /** The month being displayed + the highlighted (keyboard-focusable) day. */
  private cursor = new Date();

  private popover: Popover | null = null;
  private triggerEl!: HTMLButtonElement;
  private labelEl!: HTMLSpanElement;
  private gridBody!: HTMLDivElement;
  private monthLabelEl!: HTMLSpanElement;

  constructor(...args: ConstructorParameters<typeof Control<DatePickerConfig>>) {
    super(...args);
    this.value = this.config.value ?? null;
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'kf-datepicker';
    el.dataset.control = 'DatePicker';
    return el;
  }

  protected render(): void {
    const disabled = this.config.disabled === true;

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'kf-datepicker__trigger';
    trigger.dataset.dpTrigger = '';
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    if (this.config['aria-label']) trigger.setAttribute('aria-label', this.config['aria-label']);
    if (disabled) trigger.disabled = true;

    const label = document.createElement('span');
    label.className = 'kf-datepicker__label';
    trigger.appendChild(label);

    const icon = document.createElement('span');
    icon.className = 'kf-datepicker__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.append(svgIcon('calendar', 14));
    trigger.appendChild(icon);

    this.el.appendChild(trigger);
    this.triggerEl = trigger;
    this.labelEl = label;
    this.renderTriggerLabel();

    this.listen(trigger, 'click', () => {
      if (this.config.disabled === true) return;
      this.isMenuOpen() ? this.closeMenu() : this.openMenu();
    });
    this.listen(trigger, 'keydown', (e) => this.onTriggerKeydown(e as KeyboardEvent));

    this.popover = new Popover(trigger, {
      placement: 'bottom-start',
      onClose: () => this.triggerEl.setAttribute('aria-expanded', 'false'),
    });
    this.buildPanel(this.popover.element);
    this.onDestroy(() => {
      this.popover?.destroy();
      this.popover = null;
    });
  }

  /* --------------------------------------------------------------- public API */

  getValue(): string | null {
    return this.value;
  }

  /** Set the value WITHOUT firing onChange. */
  setValue(iso: string | null): void {
    this.value = iso;
    this.renderTriggerLabel();
  }

  openMenu(): void {
    if (this.config.disabled === true || this.isMenuOpen()) return;
    const init = (this.value && parseIso(this.value)) || new Date();
    this.cursor = new Date(init.getFullYear(), init.getMonth(), init.getDate());
    this.renderGrid();
    this.triggerEl.setAttribute('aria-expanded', 'true');
    this.popover?.open();
    this.focusCursor();
  }

  closeMenu(): void {
    if (!this.isMenuOpen()) return;
    this.triggerEl.setAttribute('aria-expanded', 'false');
    this.popover?.close();
  }

  /* ---------------------------------------------------------------- internals */

  private isMenuOpen(): boolean {
    return this.popover?.isOpen === true;
  }

  private inRange(d: Date): boolean {
    if (this.config.min) {
      const lo = parseIso(this.config.min);
      if (lo && d < lo) return false;
    }
    if (this.config.max) {
      const hi = parseIso(this.config.max);
      if (hi && d > hi) return false;
    }
    return true;
  }

  private renderTriggerLabel(): void {
    const placeholder = this.config.placeholder ?? 'Pick a date';
    const d = this.value ? parseIso(this.value) : null;
    if (d === null) {
      this.labelEl.textContent = placeholder;
      this.labelEl.classList.add('kf-datepicker__label--placeholder');
      return;
    }
    this.labelEl.classList.remove('kf-datepicker__label--placeholder');
    this.labelEl.textContent = d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  private buildPanel(panel: HTMLElement): void {
    panel.classList.add('kf-datepicker__panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Choose date');

    // Header: prev | month label | next.
    const header = document.createElement('div');
    header.className = 'kf-datepicker__header';
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'kf-datepicker__nav';
    prev.dataset.dpPrev = '';
    prev.setAttribute('aria-label', 'Previous month');
    prev.append(svgIcon('chevron-left', 14));
    const monthLabel = document.createElement('span');
    monthLabel.className = 'kf-datepicker__month';
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'kf-datepicker__nav';
    next.dataset.dpNext = '';
    next.setAttribute('aria-label', 'Next month');
    next.append(svgIcon('chevron-right', 14));
    header.append(prev, monthLabel, next);
    panel.appendChild(header);
    this.monthLabelEl = monthLabel;

    this.listen(prev, 'click', () => {
      this.moveMonth(-1);
      this.renderGrid();
    });
    this.listen(next, 'click', () => {
      this.moveMonth(1);
      this.renderGrid();
    });

    // Weekday header row.
    const dow = document.createElement('div');
    dow.className = 'kf-datepicker__weekdays';
    WEEKDAYS.forEach((w) => {
      const c = document.createElement('div');
      c.textContent = w;
      dow.appendChild(c);
    });
    panel.appendChild(dow);

    // The 6×7 day grid body (rebuilt on month/cursor change).
    const grid = document.createElement('div');
    grid.className = 'kf-datepicker__grid';
    grid.setAttribute('role', 'grid');
    grid.tabIndex = -1;
    panel.appendChild(grid);
    this.gridBody = grid;
    this.listen(grid, 'keydown', (e) => this.onGridKeydown(e as KeyboardEvent));

    // Footer: Clear + Today.
    const footer = document.createElement('div');
    footer.className = 'kf-datepicker__footer';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'kf-datepicker__action';
    clear.dataset.dpClear = '';
    clear.textContent = 'Clear';
    const today = document.createElement('button');
    today.type = 'button';
    today.className = 'kf-datepicker__action kf-datepicker__action--accent';
    today.dataset.dpToday = '';
    today.textContent = 'Today';
    footer.append(clear, today);
    panel.appendChild(footer);

    this.listen(clear, 'click', () => {
      this.value = null;
      this.renderTriggerLabel();
      this.closeMenu();
      this.triggerEl.focus();
      this.config.onChange?.(null);
    });
    this.listen(today, 'click', () => {
      const t = new Date();
      this.cursor = new Date(t.getFullYear(), t.getMonth(), t.getDate());
      this.pick(this.cursor);
    });
  }

  private monthGrid(): Date[] {
    const first = new Date(this.cursor.getFullYear(), this.cursor.getMonth(), 1);
    const start = new Date(first);
    start.setDate(start.getDate() - first.getDay());
    const days: Date[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      days.push(d);
    }
    return days;
  }

  private renderGrid(): void {
    this.monthLabelEl.textContent = this.cursor.toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
    });
    this.gridBody.replaceChildren();
    const selected = this.value ? parseIso(this.value) : null;
    for (const d of this.monthGrid()) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'kf-datepicker__day';
      cell.setAttribute('role', 'gridcell');
      cell.textContent = String(d.getDate());
      const inMonth = d.getMonth() === this.cursor.getMonth();
      const isCursor = sameDay(d, this.cursor);
      const isSelected = selected !== null && sameDay(d, selected);
      const allowed = this.inRange(d);
      if (!inMonth) cell.classList.add('kf-datepicker__day--outside');
      if (isSelected) cell.classList.add('kf-datepicker__day--selected');
      if (!allowed) {
        cell.classList.add('kf-datepicker__day--disabled');
        cell.disabled = true;
      }
      cell.tabIndex = isCursor ? 0 : -1;
      if (isCursor) cell.dataset.cursor = 'true';
      if (isSelected) cell.setAttribute('aria-selected', 'true');
      const captured = new Date(d);
      this.listen(cell, 'click', () => this.pick(captured));
      this.gridBody.appendChild(cell);
    }
  }

  private focusCursor(): void {
    const el = this.gridBody.querySelector<HTMLElement>('[data-cursor="true"]');
    el?.focus();
  }

  private pick(d: Date): void {
    if (!this.inRange(d)) return;
    // Close before emitting (parent may rearrange on change).
    this.closeMenu();
    this.value = toIso(d);
    this.renderTriggerLabel();
    this.triggerEl.focus();
    this.config.onChange?.(this.value);
  }

  private moveCursor(deltaDays: number): void {
    const next = new Date(this.cursor);
    next.setDate(next.getDate() + deltaDays);
    this.cursor = next;
    this.renderGrid();
    this.focusCursor();
  }

  private moveMonth(delta: number): void {
    const next = new Date(this.cursor);
    next.setMonth(next.getMonth() + delta);
    this.cursor = next;
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

  private onGridKeydown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        this.moveCursor(-1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.moveCursor(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.moveCursor(-7);
        break;
      case 'ArrowDown':
        e.preventDefault();
        this.moveCursor(7);
        break;
      case 'PageUp':
        e.preventDefault();
        this.moveMonth(-1);
        this.renderGrid();
        this.focusCursor();
        break;
      case 'PageDown':
        e.preventDefault();
        this.moveMonth(1);
        this.renderGrid();
        this.focusCursor();
        break;
      case 'Home':
        e.preventDefault();
        this.moveCursor(-this.cursor.getDay());
        break;
      case 'End':
        e.preventDefault();
        this.moveCursor(6 - this.cursor.getDay());
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        this.pick(this.cursor);
        break;
      case 'Escape':
        e.preventDefault();
        this.closeMenu();
        this.triggerEl.focus();
        break;
      default:
        break;
    }
  }
}

export function registerDatePicker(): void {
  Control.register('DatePicker', DatePicker);
}
