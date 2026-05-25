/**
 * HelpOverlay — the keyboard-shortcuts (`?`) overlay.
 *
 * A comfortable-register floating surface (backdrop scrim + soft-shadowed
 * panel) that lists the keyboard bindings that are CURRENTLY active, grouped
 * by scope (global → screen → region → control). The rows are rendered from
 * `HotkeyController.snapshot()` — the same hierarchically-resolved binding map
 * the live keydown listener resolves against — so the overlay always reflects
 * exactly what would fire right now (deepest scope wins, aliases collapse onto
 * one row).
 *
 * It is DOM-driven, not signal-driven: open()/close() show/hide the overlay
 * element and (de)register a transient keydown listener. There is NO signal
 * write on open/close, so it can't feed a reactive cascade — the load-bearing
 * fix the rest of the client is built around. The AppShell wires the dead
 * `toggleHelp` intent to toggle().
 *
 * Esc and `?` close it; clicking the backdrop closes it. While open, focus is
 * moved into the panel and restored to the previously-focused element on
 * close. The keydown listener is captured on the overlay tier so its Esc/`?`
 * win regardless of what's underneath.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { formatBinding, type ResolvedBinding } from '../core/hotkeys.js';

/** The snapshot shape the overlay renders from (HotkeyController.snapshot()). */
export type HotkeySnapshot = Map<string, ResolvedBinding>;

export interface HelpOverlayConfig extends BaseControlConfig {
  /**
   * Provider for the live binding snapshot — wired to
   * `HotkeyController.snapshot()`. Called fresh on every open() so the overlay
   * reflects the active scope chain at the moment it is shown. Optional so the
   * control degrades to an empty list (rather than throwing) if unwired.
   */
  snapshot?: () => HotkeySnapshot;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    HelpOverlay: HelpOverlayConfig;
  }
}

/** One display row: collapsed alias bindings for a single (scope, label). */
interface DisplayRow {
  /** Comma-joined formatted bindings, e.g. "?, Ctrl+/". */
  bindings: string;
  label: string;
}

/** Friendlier headings for the well-known scope tiers. */
const SCOPE_TITLES: Record<string, string> = {
  global: 'Global',
};

export class HelpOverlay extends Control<HelpOverlayConfig> {
  /** The scrollable rows region — repopulated on every open(). */
  private listEl: HTMLElement | null = null;
  /** The focusable close affordance — focus lands here on open. */
  private closeBtn: HTMLElement | null = null;
  private opened = false;
  /** Element to restore focus to when the overlay closes. */
  private lastFocused: Element | null = null;
  /** Transient overlay-tier keydown listener (bound once, added on open). */
  private readonly onKeydown: (e: Event) => void;

  constructor(...args: ConstructorParameters<typeof Control<HelpOverlayConfig>>) {
    super(...args);
    this.onKeydown = (e: Event) => this.handleKeydown(e as KeyboardEvent);
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'help-overlay';
    el.dataset.control = 'HelpOverlay';
    // Start hidden; open() flips display on.
    el.style.display = 'none';
    return el;
  }

  protected render(): void {
    const root = this.el;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Keyboard shortcuts');

    // Backdrop scrim — a click anywhere on it closes the overlay.
    const backdrop = document.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'help-overlay__backdrop';
    backdrop.setAttribute('aria-label', 'Close keyboard shortcuts');
    backdrop.dataset.helpBackdrop = '';
    this.listen(backdrop, 'click', () => this.close());

    // The floating panel.
    const panel = document.createElement('div');
    panel.className = 'help-overlay__panel';
    panel.dataset.helpPanel = '';

    const header = document.createElement('div');
    header.className = 'help-overlay__header';
    const title = document.createElement('h2');
    title.className = 'help-overlay__title';
    title.textContent = 'Keyboard shortcuts';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'help-overlay__close';
    close.textContent = 'Esc';
    close.setAttribute('aria-label', 'Close');
    close.dataset.helpClose = '';
    this.listen(close, 'click', () => this.close());
    this.closeBtn = close;
    header.append(title, close);

    const list = document.createElement('div');
    list.className = 'help-overlay__list';
    list.dataset.helpList = '';
    this.listEl = list;

    panel.append(header, list);
    root.append(backdrop, panel);
  }

  /** True while the overlay is shown. */
  isOpen(): boolean {
    return this.opened;
  }

  /** Toggle open/closed — the surface the `toggleHelp` intent drives. */
  toggle(): void {
    if (this.opened) this.close();
    else this.open();
  }

  /**
   * Show the overlay: snapshot the live bindings, render the grouped rows,
   * reveal the surface, trap focus, and wire the overlay-tier Esc/`?` listener.
   * A DOM toggle only — no signal writes (cascade-safe). Idempotent.
   */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.lastFocused = activeElement();
    this.renderRows();
    this.el.style.display = '';
    // Overlay-tier keydown: capture so Esc/`?` win over anything underneath.
    document.addEventListener('keydown', this.onKeydown, true);
    focusEl(this.closeBtn);
  }

  /** Hide the overlay, drop the transient listener, restore focus. Idempotent. */
  close(): void {
    if (!this.opened) return;
    this.opened = false;
    document.removeEventListener('keydown', this.onKeydown, true);
    this.el.style.display = 'none';
    focusEl(this.lastFocused);
    this.lastFocused = null;
  }

  override destroy(): void {
    if (this.opened) document.removeEventListener('keydown', this.onKeydown, true);
    super.destroy();
  }

  /** Render the snapshot into grouped rows (called fresh on every open). */
  private renderRows(): void {
    const list = this.listEl;
    if (!list) return;
    const snap = this.config.snapshot?.() ?? new Map<string, ResolvedBinding>();
    const groups = groupSnapshot(snap);

    const frag = document.createDocumentFragment();
    if (groups.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'help-overlay__empty muted';
      empty.textContent = 'No keyboard shortcuts are active right now.';
      frag.append(empty);
    }
    for (const [scope, rows] of groups) {
      const section = document.createElement('section');
      section.className = 'help-overlay__group';
      section.dataset.helpScope = scope;

      const heading = document.createElement('h3');
      heading.className = 'help-overlay__group-title';
      heading.textContent = scopeTitle(scope);
      section.append(heading);

      for (const row of rows) {
        const rowEl = document.createElement('div');
        rowEl.className = 'help-overlay__row';
        rowEl.dataset.helpRow = '';
        const keys = document.createElement('kbd');
        keys.className = 'help-overlay__keys';
        keys.textContent = row.bindings;
        const label = document.createElement('span');
        label.className = 'help-overlay__label';
        label.textContent = row.label;
        rowEl.append(keys, label);
        section.append(rowEl);
      }
      frag.append(section);
    }
    list.replaceChildren(frag);
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (!this.opened) return;
    const key = e.key;
    // Esc closes; `?` (Shift+/) toggles closed for symmetry with the open chord.
    if (key === 'Escape' || key === '?') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Snapshot → grouped display rows (pure).                                    */
/* -------------------------------------------------------------------------- */

/**
 * Collapse a resolved-binding snapshot into ordered scope groups of display
 * rows. Aliases that share a scope + label + handler fold onto one row
 * (e.g. "?, Ctrl+/"). Groups are ordered shallowest-first by tier depth so
 * Global leads; ties break alphabetically by scope name.
 */
export function groupSnapshot(snap: HotkeySnapshot): Array<[string, DisplayRow[]]> {
  // Per scope: an ordered list of rows + an index to merge aliases onto an
  // existing row, keyed by (label + handler identity).
  const byScope = new Map<string, DisplayRow[]>();
  const rowIndex = new Map<string, Map<string, DisplayRow>>();
  const minDepth = new Map<string, number>();
  const handlerKeys = new WeakMap<() => void, number>();
  let nextHandlerKey = 1;
  const handlerKey = (fn: () => void): number => {
    const existing = handlerKeys.get(fn);
    if (existing !== undefined) return existing;
    const id = nextHandlerKey++;
    handlerKeys.set(fn, id);
    return id;
  };

  for (const [token, b] of snap) {
    const scope = b.scope;
    const label = b.label ?? token;
    const rows = byScope.get(scope) ?? [];
    const idx = rowIndex.get(scope) ?? new Map<string, DisplayRow>();
    const mergeKey = `${label} ${handlerKey(b.run)}`;
    const formatted = formatBinding(token);
    const existing = idx.get(mergeKey);
    if (existing) {
      existing.bindings = `${existing.bindings}, ${formatted}`;
    } else {
      const row: DisplayRow = { bindings: formatted, label };
      rows.push(row);
      idx.set(mergeKey, row);
    }
    byScope.set(scope, rows);
    rowIndex.set(scope, idx);
    const d = minDepth.get(scope);
    if (d === undefined || b.depth < d) minDepth.set(scope, b.depth);
  }

  return [...byScope.entries()].sort(([a], [b]) => {
    const da = minDepth.get(a) ?? 0;
    const db = minDepth.get(b) ?? 0;
    if (da !== db) return da - db; // shallow (global) first
    return a.localeCompare(b);
  });
}

function scopeTitle(scope: string): string {
  return SCOPE_TITLES[scope] ?? scope;
}

function activeElement(): Element | null {
  const doc = document as unknown as { activeElement?: Element | null };
  return doc.activeElement ?? null;
}

function focusEl(el: unknown): void {
  if (el && typeof (el as { focus?: () => void }).focus === 'function') {
    (el as { focus: () => void }).focus();
  }
}

export function registerHelpOverlay(): void {
  Control.register('HelpOverlay', HelpOverlay);
}
