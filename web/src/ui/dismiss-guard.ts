/**
 * Dismiss guard — the ONE policy every create/edit dialog follows so typed work
 * is never lost to a stray gesture:
 *
 *   - A backdrop click never dismisses. The dialog calls {@link nudge} instead
 *     (a brief shake) to point the user at its explicit close.
 *   - The explicit closes (×, Cancel) and Esc all route through
 *     {@link DismissGuard.request} / {@link DismissGuard.escape}. A clean
 *     dialog closes straight away; a dirty one first shows an inline
 *     "Discard …? [Keep editing] [Discard]" prompt in its footer.
 *
 * What counts as "dirty" is the dialog's call (`isDirty`), not the guard's.
 * Forms built purely from native fields can use {@link snapshotFields} — take a
 * snapshot at open, compare at dismiss — so they need no per-field bookkeeping.
 *
 * A lifecycle helper (NOT a Control), like Modal / Popover: the dialog owns the
 * host element and calls {@link DismissGuard.cancel} from its own close()/reset
 * so a programmatic close never leaves a stale prompt behind.
 */

export interface DismissGuardOptions {
  /**
   * Where the prompt mounts — typically the dialog's footer / button row.
   * While the prompt shows, the host's other children are hidden (CSS keys off
   * `data-dismiss-prompt`), so the prompt stands in for the normal actions.
   */
  host: HTMLElement;
  /** True when dismissing now would throw away something the user entered. */
  isDirty: () => boolean;
  /** Actually dismiss (the dialog's own close()). */
  onDiscard: () => void;
  /** Prompt copy. Default: "Discard your changes?". */
  message?: string;
  /** Confirm-button label. Default: "Discard". */
  discardLabel?: string;
}

export interface DismissGuard {
  /** An explicit close (× / Cancel): close when clean, else ask first. */
  request(): void;
  /** Esc: backs out of a showing prompt, otherwise acts like {@link request}. */
  escape(): void;
  /** Hide the prompt without dismissing ("Keep editing" / programmatic reset). */
  cancel(): void;
  /** True while the discard prompt is showing. */
  readonly prompting: boolean;
}

export function createDismissGuard(opts: DismissGuardOptions): DismissGuard {
  const { host } = opts;
  host.classList.add('dismiss-guard-host');

  const strip = document.createElement('div');
  strip.className = 'dismiss-guard';
  strip.dataset.dismissGuard = '';
  strip.setAttribute('role', 'alertdialog');
  strip.setAttribute('aria-live', 'assertive');

  const msg = document.createElement('span');
  msg.className = 'dismiss-guard__msg';
  msg.textContent = opts.message ?? 'Discard your changes?';
  strip.setAttribute('aria-label', msg.textContent);

  const actions = document.createElement('div');
  actions.className = 'dismiss-guard__actions';
  const keep = document.createElement('button');
  keep.type = 'button';
  keep.className = 'btn';
  keep.dataset.dismissKeep = '';
  keep.textContent = 'Keep editing';
  const discard = document.createElement('button');
  discard.type = 'button';
  discard.className = 'btn btn-danger';
  discard.dataset.dismissDiscard = '';
  discard.textContent = opts.discardLabel ?? 'Discard';
  actions.append(keep, discard);
  strip.append(msg, actions);

  let prompting = false;
  /** Focus to hand back on "Keep editing" (where the user was typing). */
  let resumeFocus: HTMLElement | null = null;

  const hide = (): void => {
    if (!prompting) return;
    prompting = false;
    delete host.dataset.dismissPrompt;
    strip.remove();
  };

  const show = (): void => {
    prompting = true;
    resumeFocus = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null;
    host.dataset.dismissPrompt = '';
    host.append(strip);
    // Safe default: Enter / Space on the focused button keeps the work.
    keep.focus?.();
  };

  const guard: DismissGuard = {
    request(): void {
      if (prompting) {
        keep.focus?.();
        return;
      }
      if (!opts.isDirty()) {
        opts.onDiscard();
        return;
      }
      show();
    },
    escape(): void {
      if (prompting) guard.cancel();
      else guard.request();
    },
    cancel(): void {
      if (!prompting) return;
      const back = resumeFocus;
      resumeFocus = null;
      hide();
      back?.focus?.();
    },
    get prompting(): boolean {
      return prompting;
    },
  };

  keep.addEventListener('click', () => guard.cancel());
  discard.addEventListener('click', () => {
    resumeFocus = null;
    hide();
    opts.onDiscard();
  });

  return guard;
}

/**
 * Serialise every native field's value under `root` (inputs by value /
 * checked state, selects, textareas) into one comparable string. Take one at
 * open, compare at dismiss: `snapshotFields(el) !== atOpen` ⇒ the user
 * changed something.
 */
export function snapshotFields(root: HTMLElement): string {
  const parts: string[] = [];
  // One query per tag (not a selector list): the order is stable between the
  // open and dismiss snapshots, which is all a comparison needs.
  for (const tag of ['input', 'select', 'textarea']) {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(tag))) {
      const f = el as HTMLInputElement;
      if (f.type === 'checkbox' || f.type === 'radio') parts.push(f.checked ? '1' : '0');
      else if (f.type === 'file') parts.push(String(f.files?.length ?? 0));
      else parts.push(f.value ?? '');
    }
  }
  return JSON.stringify(parts);
}

/**
 * Brief shake on a dialog panel — the feedback for a backdrop click, which no
 * longer dismisses. Restarts cleanly on rapid repeat clicks.
 */
export function nudge(panel: HTMLElement): void {
  panel.classList.remove('dialog-nudge');
  // Force a reflow so re-adding the class restarts the animation.
  void panel.offsetWidth;
  panel.classList.add('dialog-nudge');
  panel.addEventListener('animationend', () => panel.classList.remove('dialog-nudge'), { once: true });
}
