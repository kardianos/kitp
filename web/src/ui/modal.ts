/**
 * Modal — a centered, backdropped overlay for focused edit forms (e.g. the
 * workflow "Edit transition" editor). A lightweight lifecycle helper (NOT a
 * Control), mirroring Popover's shape: the caller fills `element` with content,
 * then open()/close()/destroy(). Focus is trapped within the panel and restored
 * to the opener on close; body scroll is locked while open.
 *
 * Dismissal follows the shared dismiss-guard policy (ui/dismiss-guard.ts): the
 * × and Esc dismiss (firing `onClose`), but when the form was edited they first
 * ask "Discard your changes?"; a backdrop click never dismisses (it nudges the
 * panel). By default "edited" means any native field in the body changed since
 * open() — pass `isDirty` for content that isn't plain fields.
 *
 * Mounting: prefers `document.body` (so the fixed overlay escapes any ancestor
 * overflow/stacking context), falling back to the `host` element when there's
 * no document body (the light test DOM) — the panel is `position: fixed`, so it
 * still overlays the viewport either way.
 */

import { trapFocus, captureFocus } from '../util/focus-trap.js';
import { createDismissGuard, nudge, snapshotFields, type DismissGuard } from './dismiss-guard.js';

import { icon } from './icons.js';
export interface ModalOptions {
  /** Heading shown in the panel header. */
  title?: string;
  /** Extra class on the panel (for per-use styling). */
  className?: string;
  /** Fired on an Esc / × dismiss (NOT on a programmatic close()). */
  onClose?: () => void;
  /** True when dismissing would lose edits. Default: a native field in the
   *  body changed since open() (see snapshotFields). */
  isDirty?: () => boolean;
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
  private readonly guard: DismissGuard;
  /** Field snapshot taken at open() — the default dirty baseline. */
  private openSnapshot = '';

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
    close.append(icon('x', 14));
    close.addEventListener('click', () => this.guard.request());
    header.append(title, close);

    const body = document.createElement('div');
    body.className = 'modal__body';
    this.body = body;

    // Empty until the discard prompt mounts here.
    const footer = document.createElement('div');
    footer.className = 'modal__footer';

    panel.append(header, body, footer);
    backdrop.append(panel);
    // A backdrop click (outside the panel) never dismisses — it would throw
    // away the form on a stray click. Nudge toward the explicit × instead.
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) nudge(panel);
    });

    this.guard = createDismissGuard({
      host: footer,
      isDirty: opts.isDirty ?? ((): boolean => snapshotFields(body) !== this.openSnapshot),
      onDiscard: () => this.close(true),
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

    this.openSnapshot = snapshotFields(this.body);
    this.releaseTrap = trapFocus(this.panel);
    // Bubble phase, so a control inside the panel (a combobox / popover
    // closing its own menu) handles its Esc first; one it consumed never
    // dismisses the modal too.
    this.onDocKeydown = (e: Event): void => {
      if ((e as KeyboardEvent).key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        this.guard.escape();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', this.onDocKeydown);
    }

    // Focus the first focusable in the panel.
    const first = this.panel.querySelector<HTMLElement>(
      'input, select, textarea, button:not([data-modal-close])',
    );
    first?.focus?.();
  }

  /** Hide + tear down transient state. `fromSelf` (a confirmed Esc/× dismiss)
   *  fires onClose. A programmatic close() skips the dirty check. */
  close(fromSelf = false): void {
    if (!this.opened) return;
    this.opened = false;
    this.guard.cancel();
    this.releaseTrap?.();
    this.releaseTrap = null;
    if (this.onDocKeydown && typeof document !== 'undefined') {
      document.removeEventListener('keydown', this.onDocKeydown);
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
