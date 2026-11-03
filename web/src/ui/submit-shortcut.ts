/**
 * The send shortcut every multi-line box shares: Ctrl+Enter (⌘+Enter on a
 * Mac) runs the box's send action — a reply, a comment, a vote, an
 * approval request. Plain Enter keeps making a new line. Use
 * {@link bindSubmitShortcut} on a textarea (through the owning control's
 * `listen`, so the listener goes with the control) and
 * {@link submitShortcutHint} in its placeholder so people can find it.
 */

/** Whether a keydown is the send shortcut (not while an IME is composing). */
export function isSubmitShortcut(ev: KeyboardEvent): boolean {
  return ev.key === 'Enter' && (ev.ctrlKey === true || ev.metaKey === true) && ev.isComposing !== true;
}

/** "⌘+Enter" on a Mac, else "Ctrl+Enter". */
export function submitShortcutLabel(): string {
  const p = typeof navigator !== 'undefined' ? `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}` : '';
  return /Mac|iPhone|iPad/.test(p) ? '⌘+Enter' : 'Ctrl+Enter';
}

/** A placeholder suffix naming the shortcut, e.g. " (Ctrl+Enter to send)". */
export function submitShortcutHint(verb = 'send'): string {
  return ` (${submitShortcutLabel()} to ${verb})`;
}

type Listen = (el: EventTarget, type: string, fn: (e: Event) => void) => void;

/** Run `submit` on the send shortcut in `el`. Pass the control's `listen`
 *  (bound) so the listener is removed with the control. */
export function bindSubmitShortcut(listen: Listen, el: HTMLElement, submit: () => void): void {
  listen(el, 'keydown', (e) => {
    const ev = e as KeyboardEvent;
    if (!isSubmitShortcut(ev)) return;
    ev.preventDefault();
    submit();
  });
}
