/**
 * Popover — the ONE place @floating-ui is used in the web client.
 *
 * The Svelte client's bug was nine separate components hand-rolling
 * `computePosition` + `autoUpdate` + click-outside + the "hide until the first
 * position resolves" trick, each diverging subtly (cc1cfd1, a347f38). This
 * helper is the single floating implementation: Combobox and DatePicker (and
 * the later ref-pickers / quick filters / attribute editors) compose it rather
 * than touching floating-ui directly. Route EVERYTHING anchored-floating
 * through here.
 *
 * It is a plain lifecycle helper, not a Control — it owns a floating panel
 * element and positions it against an anchor. The caller owns the anchor
 * (usually a trigger button) and the panel's content; the helper owns:
 *
 *   - floating-ui positioning (offset + flip + shift, optional size) and the
 *     autoUpdate subscription while open;
 *   - the reveal-after-first-position trick (the panel starts at opacity 0 /
 *     pointer-events none so the user never sees the (0,0) flash before the
 *     first computePosition resolves);
 *   - pointerdown-outside (skipping the anchor + the panel) and Escape close;
 *   - FULL teardown — the autoUpdate disposer AND every document listener — on
 *     close() and destroy(). destroy() is idempotent and safe to call from a
 *     Control's onDestroy.
 *
 * Cascade-safe: no promises cross the public surface (open/close/destroy are
 * synchronous); the only `.then` is floating-ui's internal computePosition,
 * whose continuation just writes inline styles and never calls back into app
 * reactivity. Callbacks (onOpen/onClose) are plain functions, not awaited.
 */

import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  size,
  type Placement,
  type SizeApplyState,
} from '../../vendor/floating-ui-dom.js';

export type { Placement };

export interface PopoverOptions {
  /** floating-ui placement; default 'bottom-start'. */
  placement?: Placement;
  /** Pixel gap between anchor and panel; default 4. */
  offsetPx?: number;
  /**
   * Panel width sizing:
   *   'auto'    — sized to content (default).
   *   'anchor'  — min-width matches the anchor's width (grows with content).
   *   <string>  — any CSS width value applied verbatim (e.g. '20rem').
   */
  width?: 'auto' | 'anchor' | string;
  /**
   * When true, the panel's max-height is clamped to the available space below
   * (down to a 140px floor) via floating-ui's size middleware — used by the
   * Combobox listbox so a long option list scrolls instead of overflowing the
   * viewport.
   */
  clampHeight?: boolean;
  /** Fired after the panel is shown and first positioned. */
  onOpen?: () => void;
  /**
   * Fired when the popover closes ITSELF (Escape or pointerdown-outside).
   * NOT fired by an explicit close() call from the owner — the owner already
   * knows. Lets a trigger reset its aria-expanded / focus.
   */
  onClose?: () => void;
}

export class Popover {
  private readonly panel: HTMLElement;
  private cleanupFloat: (() => void) | null = null;
  private docListenerBound = false;
  private opened = false;
  private destroyed = false;

  // Bound once so add/removeEventListener pair on the same reference.
  private readonly onDocPointerDown: (e: Event) => void;
  private readonly onDocKeydown: (e: Event) => void;

  /**
   * @param anchor  the element to position against (typically a trigger button)
   * @param opts    positioning + lifecycle callbacks
   */
  constructor(
    private readonly anchor: HTMLElement,
    private readonly opts: PopoverOptions = {},
  ) {
    const panel = document.createElement('div');
    panel.className = 'kf-popover';
    // Start invisible + inert so the brief pre-position frame at (0,0) never
    // flashes. computePosition flips these on once it resolves a real point.
    panel.style.position = 'absolute';
    panel.style.top = '0';
    panel.style.left = '0';
    panel.style.opacity = '0';
    panel.style.pointerEvents = 'none';
    this.panel = panel;

    this.onDocPointerDown = (e: Event) => this.handleDocPointerDown(e);
    this.onDocKeydown = (e: Event) => this.handleDocKeydown(e);
  }

  /** The panel element — append content into this. Stable across open/close. */
  get element(): HTMLElement {
    return this.panel;
  }

  /** True between open() and close()/destroy(). */
  get isOpen(): boolean {
    return this.opened;
  }

  /**
   * Show the panel: append to <body>, start autoUpdate, wire the dismiss
   * listeners. Idempotent — a second open() while open is a no-op. Synchronous;
   * the panel reveals once floating-ui's first computePosition resolves.
   */
  open(): void {
    if (this.destroyed || this.opened) return;
    this.opened = true;

    // Reset to the inert pre-position state in case this is a re-open.
    this.panel.style.opacity = '0';
    this.panel.style.pointerEvents = 'none';
    this.panel.classList.remove('kf-popover--enter');
    document.body.appendChild(this.panel);

    this.applyWidth();
    this.startFloating();

    document.addEventListener('pointerdown', this.onDocPointerDown, true);
    document.addEventListener('keydown', this.onDocKeydown, true);
    this.docListenerBound = true;

    this.opts.onOpen?.();
  }

  /**
   * Hide the panel and tear down EVERYTHING transient: the autoUpdate
   * subscription and both document listeners. The panel element is detached
   * from <body> but kept (and reusable via open()). Idempotent.
   *
   * @param fromSelf  internal — true when the close was triggered by Escape /
   *                  outside-click, so onClose should fire. The owner's own
   *                  close() leaves it false (the owner already knows).
   */
  close(fromSelf = false): void {
    if (!this.opened) return;
    this.opened = false;
    this.teardownTransient();
    if (this.panel.parentNode) this.panel.parentNode.removeChild(this.panel);
    if (fromSelf) this.opts.onClose?.();
  }

  /**
   * Permanent teardown for the owning control's onDestroy. Closes if open and
   * marks the helper dead so a stray open() after destroy is a no-op. Does NOT
   * fire onClose (the owner is going away). Idempotent.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.opened = false;
    this.teardownTransient();
    if (this.panel.parentNode) this.panel.parentNode.removeChild(this.panel);
  }

  /** Re-run positioning now (e.g. after the panel's content size changed). */
  reposition(): void {
    if (!this.opened) return;
    // autoUpdate already watches layout; an explicit nudge just restarts it so
    // the next animation frame recomputes against the new content size.
    this.startFloating();
  }

  /* ---------------------------------------------------------------- internal */

  private applyWidth(): void {
    const w = this.opts.width ?? 'auto';
    if (w === 'auto') {
      this.panel.style.width = '';
      this.panel.style.minWidth = '';
    } else if (w === 'anchor') {
      this.panel.style.width = '';
      this.panel.style.minWidth = `${this.anchor.getBoundingClientRect().width}px`;
    } else {
      this.panel.style.width = w;
    }
  }

  private startFloating(): void {
    this.cleanupFloat?.();
    const anchor = this.anchor;
    const panel = this.panel;
    const placement = this.opts.placement ?? 'bottom-start';
    const offsetPx = this.opts.offsetPx ?? 4;

    const middleware = [offset(offsetPx), flip(), shift({ padding: 8 })];
    if (this.opts.clampHeight) {
      middleware.push(
        size({
          padding: 8,
          apply: (state: SizeApplyState) => {
            const { availableHeight, elements } = state;
            elements.floating.style.maxHeight = `${Math.max(140, availableHeight - 8)}px`;
          },
        }),
      );
    }

    this.cleanupFloat = autoUpdate(anchor, panel, () => {
      void computePosition(anchor, panel, { placement, middleware }).then(({ x, y }) => {
        // Reveal only after the first resolved position — opacity (not
        // visibility:hidden) so a focusable input inside the panel stays
        // focusable while still hidden (the Combobox search field relies on
        // being focusable the moment the panel opens).
        panel.style.left = `${x}px`;
        panel.style.top = `${y}px`;
        panel.style.opacity = '1';
        panel.style.pointerEvents = 'auto';
        // First reveal kicks the enter animation (idempotent on repositions).
        panel.classList.add('kf-popover--enter');
      });
    });
  }

  private teardownTransient(): void {
    this.cleanupFloat?.();
    this.cleanupFloat = null;
    if (this.docListenerBound) {
      document.removeEventListener('pointerdown', this.onDocPointerDown, true);
      document.removeEventListener('keydown', this.onDocKeydown, true);
      this.docListenerBound = false;
    }
  }

  private handleDocPointerDown(e: Event): void {
    if (!this.opened) return;
    const t = e.target as Node | null;
    if (!t) return;
    if (this.panel.contains(t)) return;
    if (this.anchor.contains(t)) return;
    this.close(true);
  }

  private handleDocKeydown(e: Event): void {
    if (!this.opened) return;
    const ke = e as KeyboardEvent;
    if (ke.key === 'Escape') {
      ke.stopPropagation();
      this.close(true);
    }
  }
}
