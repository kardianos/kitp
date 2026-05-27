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
import { setMarkdown } from '../util/markdown-control.js';
import { trapFocus } from '../util/focus-trap.js';
import { HELP_GET_TOPIC_SPEC, type HelpOutput } from './help-specs.js';

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
  /**
   * Provider for the current help TOPIC key (e.g. `layout.kanban`, `admin.screens`),
   * derived from the live route. Called on every open(); when it returns a key
   * the overlay loads `help.get_topic` and renders the server's markdown above
   * the keybindings. Null / a failed load → keybindings only (graceful).
   */
  topic?: () => string | null;
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
  /** Server help-content region (markdown), loaded on open when a topic resolves. */
  private helpContentEl: HTMLElement | null = null;
  /** Rule between the instructions markdown and the keybinding cheatsheet. Shown
   *  only while instructions content is visible. */
  private sepEl: HTMLElement | null = null;
  /** The panel header title — flips between the two open modes. */
  private titleEl: HTMLElement | null = null;
  /** The scrollable rows region — repopulated on every open(). */
  private listEl: HTMLElement | null = null;
  /** Open mode: shortcuts-only (`?`/`Mod+/`) vs instructions + shortcuts (ⓘ). */
  private showInstructions = false;
  /** The focusable close affordance — focus lands here on open. */
  private closeBtn: HTMLElement | null = null;
  private opened = false;
  /** Element to restore focus to when the overlay closes. */
  private lastFocused: Element | null = null;
  /** Focus-trap disposer while the overlay is open (#29). */
  private untrap: (() => void) | null = null;
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
    title.dataset.helpTitle = '';
    title.textContent = 'Keyboard shortcuts';
    this.titleEl = title;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'help-overlay__close';
    close.textContent = 'Esc';
    close.setAttribute('aria-label', 'Close');
    close.dataset.helpClose = '';
    this.listen(close, 'click', () => this.close());
    this.closeBtn = close;
    header.append(title, close);

    // Server-driven contextual help (markdown), above the keybindings. Hidden
    // until a topic loads (loadHelp on open).
    const content = document.createElement('div');
    content.className = 'help-overlay__content';
    content.dataset.helpContent = '';
    content.style.display = 'none';
    this.helpContentEl = content;

    // Separator between the instructions markdown (above) and the keybinding
    // cheatsheet (below). Hidden until instructions actually render, so the
    // keybindings-only view (no authored topic) has no dangling rule.
    const sep = document.createElement('hr');
    sep.className = 'help-overlay__sep';
    sep.dataset.helpSep = '';
    sep.style.display = 'none';
    this.sepEl = sep;

    const list = document.createElement('div');
    list.className = 'help-overlay__list';
    list.dataset.helpList = '';
    this.listEl = list;

    // One scroll region holds the instructions, the rule, and the shortcuts —
    // the content + shortcuts flow together past a single horizontal rule, not
    // as two independently-scrolling boxes.
    const body = document.createElement('div');
    body.className = 'help-overlay__body';
    body.dataset.helpBody = '';
    body.append(content, sep, list);

    panel.append(header, body);
    root.append(backdrop, panel);
  }

  /** True while the overlay is shown. */
  isOpen(): boolean {
    return this.opened;
  }

  /**
   * Toggle the overlay. Two distinct surfaces share one control:
   *   - `{ instructions: false }` (default; the `?`/`Mod+/` chord + the `?`
   *     button) → KEYBOARD SHORTCUTS only.
   *   - `{ instructions: true }` (the ⓘ "About this screen" button) → the
   *     screen's authored instructions, an <hr>, then the shortcuts.
   * Re-firing the SAME mode closes it; firing the OTHER mode while open just
   * switches the view (keeps focus trapped).
   */
  toggle(opts?: { instructions?: boolean }): void {
    const want = opts?.instructions === true;
    if (this.opened) {
      if (want === this.showInstructions) this.close();
      else this.applyMode(want);
      return;
    }
    this.open(opts);
  }

  /**
   * Show the overlay in the requested mode, reveal the surface, trap focus, and
   * wire the overlay-tier Esc/`?` listener. A DOM toggle only — no signal writes
   * (cascade-safe). Idempotent.
   */
  open(opts?: { instructions?: boolean }): void {
    if (this.opened) return;
    this.opened = true;
    this.lastFocused = activeElement();
    this.applyMode(opts?.instructions === true);
    this.el.style.display = '';
    // Overlay-tier keydown: capture so Esc/`?` win over anything underneath.
    document.addEventListener('keydown', this.onKeydown, true);
    this.untrap?.();
    this.untrap = trapFocus(this.el); // keep Tab inside the overlay (#29)
    focusEl(this.closeBtn);
  }

  /**
   * Paint the overlay for a mode: the header title, the always-present
   * machine-generated shortcut rows, and — only in instructions mode — the
   * authored topic markdown (which the <hr> separates from the shortcuts).
   * Shortcuts mode hides/clears the instructions content.
   */
  private applyMode(instructions: boolean): void {
    this.showInstructions = instructions;
    const label = instructions ? 'About this screen' : 'Keyboard shortcuts';
    if (this.titleEl) this.titleEl.textContent = label;
    this.el.setAttribute('aria-label', label);
    this.renderRows();
    if (instructions) {
      this.loadHelp();
    } else {
      this.helpContentEl?.replaceChildren();
      this.setContentVisible(false);
    }
  }

  /** Hide the overlay, drop the transient listener, restore focus. Idempotent. */
  close(): void {
    if (!this.opened) return;
    this.opened = false;
    document.removeEventListener('keydown', this.onKeydown, true);
    this.untrap?.();
    this.untrap = null;
    this.el.style.display = 'none';
    focusEl(this.lastFocused);
    this.lastFocused = null;
  }

  override destroy(): void {
    if (this.opened) document.removeEventListener('keydown', this.onKeydown, true);
    super.destroy();
  }

  /**
   * Load + render the server's contextual help markdown for the current topic.
   * No topic / empty body / fault → the content area stays hidden, so the
   * overlay degrades to the keybinding cheatsheet only (cascade-safe: one-way
   * DOM write from the callback, no signal).
   */
  private loadHelp(): void {
    const content = this.helpContentEl;
    if (content === null) return;
    const topic = this.config.topic?.() ?? null;
    if (topic === null || topic === '') {
      content.replaceChildren();
      this.setContentVisible(false);
      return;
    }
    this.ctx.api.callByName(
      HELP_GET_TOPIC_SPEC,
      { topic },
      (out) => {
        if (!this.isAlive() || !this.opened) return;
        const o = out as HelpOutput;
        if (o.markdown.trim() === '') {
          this.setContentVisible(false);
          return;
        }
        content.replaceChildren();
        const h = document.createElement('h3');
        h.className = 'help-overlay__content-title';
        h.textContent = o.title !== '' ? o.title : topic;
        const body = document.createElement('div');
        body.className = 'help-overlay__content-body';
        setMarkdown(body, o.markdown); // the single sanitized markdown sink
        content.append(h, body);
        this.setContentVisible(true);
      },
      {
        alive: () => this.isAlive(),
        onErr: () => this.setContentVisible(false),
      },
    );
  }

  /** Show/hide the instructions content + its separator together. */
  private setContentVisible(visible: boolean): void {
    if (this.helpContentEl !== null) this.helpContentEl.style.display = visible ? '' : 'none';
    if (this.sepEl !== null) this.sepEl.style.display = visible ? '' : 'none';
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
