/**
 * Modal — a centered, backdropped overlay for focused edit forms (e.g. the
 * workflow "Edit transition" editor). A lightweight lifecycle helper (NOT a
 * Control), mirroring Popover's shape: the caller fills `element` with content,
 * then open()/close()/destroy(). Esc and a backdrop click dismiss (firing
 * `onClose`); focus is trapped within the panel and restored to the opener on
 * close; body scroll is locked while open.
 *
 * Mounting: prefers `document.body` (so the fixed overlay escapes any ancestor
 * overflow/stacking context), falling back to the `host` element when there's
 * no document body (the light test DOM) — the panel is `position: fixed`, so it
 * still overlays the viewport either way.
 */

import { trapFocus, captureFocus } from '../util/focus-trap.js';

export interface ModalOptions {
  /** Heading shown in the panel header. */
  title?: string;
  /** Extra class on the panel (for per-use styling). */
  className?: string;
  /** Fired on Esc / backdrop / × dismiss (NOT on a programmatic close()). */
  onClose?: () => void;
  /** Fallback mount target when there's no `document.body` (tests). */
  host?: HTMLElement;
}

export class Modal {
  private readonly backdrop: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;
  private readonly opts: ModalOptions;
  private opened = false;
  private destroyed = false;
  private releaseTrap: (() => void) | null = null;
  private restoreFocus: (() => void) | null = null;
  private onDocKeydown: ((e: Event) => void) | null = null;

  constructor(opts: ModalOptions = {}) {
    this.opts = opts;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.dataset.modalBackdrop = '';

    const panel = document.createElement('div');
    panel.className = `modal__panel${opts.className ? ` ${opts.className}` : ''}`;
    panel.dataset.modal = '';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');

    const header = document.createElement('div');
    header.className = 'modal__header';
    const title = document.createElement('h2');
    title.className = 'modal__title';
    title.textContent = opts.title ?? '';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'modal__close';
    close.dataset.modalClose = '';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', () => this.close(true));
    header.append(title, close);

    const body = document.createElement('div');
    body.className = 'modal__body';
    this.body = body;

    panel.append(header, body);
    backdrop.append(panel);
    // Backdrop click (outside the panel) dismisses.
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) this.close(true);
    });

    this.backdrop = backdrop;
    this.panel = panel;
  }

  /** The content slot — fill it before open(). */
  get element(): HTMLElement {
    return this.body;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  open(): void {
    if (this.destroyed || this.opened) return;
    this.opened = true;
    this.restoreFocus = captureFocus();

    const target =
      typeof document !== 'undefined' && document.body ? document.body : this.opts.host ?? null;
    target?.appendChild?.(this.backdrop);
    if (typeof document !== 'undefined' && document.body?.style) {
      document.body.style.overflow = 'hidden';
    }

    this.releaseTrap = trapFocus(this.panel);
    this.onDocKeydown = (e: Event): void => {
      if ((e as KeyboardEvent).key === 'Escape') {
        e.preventDefault();
        this.close(true);
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', this.onDocKeydown, true);
    }

    // Focus the first focusable in the panel.
    const first = this.panel.querySelector<HTMLElement>(
      'input, select, textarea, button:not([data-modal-close])',
    );
    first?.focus?.();
  }

  /** Hide + tear down transient state. `fromSelf` (Esc/backdrop/×) fires onClose. */
  close(fromSelf = false): void {
    if (!this.opened) return;
    this.opened = false;
    this.releaseTrap?.();
    this.releaseTrap = null;
    if (this.onDocKeydown && typeof document !== 'undefined') {
      document.removeEventListener('keydown', this.onDocKeydown, true);
    }
    this.onDocKeydown = null;
    if (this.backdrop.parentNode) this.backdrop.parentNode.removeChild(this.backdrop);
    if (typeof document !== 'undefined' && document.body?.style) {
      document.body.style.overflow = '';
    }
    this.restoreFocus?.();
    this.restoreFocus = null;
    if (fromSelf) this.opts.onClose?.();
  }

  /** Permanent teardown (no onClose). Idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.close(false);
    this.destroyed = true;
  }
}
