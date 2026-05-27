/**
 * EditableField — an inline "read text + pencil → edit-in-place" control. The
 * shared pencil-edit affordance (e.g. the workflow flow name) so admin screens
 * stop using bespoke editors or window.prompt. A lightweight helper (NOT a
 * Control): mount `el`, and it fires `onCommit(next)` when the value changes.
 *
 * Display mode: the value (or `emptyText`) + a ✎ button. Edit mode: an input
 * (or textarea when `multiline`), committing on Enter (Mod+Enter for multiline)
 * or blur, cancelling on Escape. `setValue` updates the display from outside
 * (e.g. after a reload) when not mid-edit.
 */

export interface EditableFieldOptions {
  value: string;
  /** Fired with the trimmed-or-raw new value when it differs from the current. */
  onCommit: (next: string) => void;
  multiline?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  /** Shown (muted) when the value is empty. Default '—'. */
  emptyText?: string;
  className?: string;
}

export class EditableField {
  readonly el: HTMLElement;
  private value: string;
  private editing = false;
  private readonly opts: EditableFieldOptions;

  constructor(opts: EditableFieldOptions) {
    this.opts = opts;
    this.value = opts.value;
    const el = document.createElement('span');
    el.className = `editable-field${opts.className ? ` ${opts.className}` : ''}`;
    el.dataset.editableField = '';
    this.el = el;
    this.renderDisplay();
  }

  /** Update the displayed value from outside (no-op while the user is editing). */
  setValue(v: string): void {
    this.value = v;
    if (!this.editing) this.renderDisplay();
  }

  private renderDisplay(): void {
    this.editing = false;
    const text = document.createElement('span');
    text.className = 'editable-field__text';
    text.dataset.editableText = '';
    const empty = this.value.trim() === '';
    text.textContent = empty ? this.opts.emptyText ?? '—' : this.value;
    if (empty) text.classList.add('muted');

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'editable-field__edit';
    edit.dataset.editableEdit = '';
    edit.setAttribute('aria-label', this.opts.ariaLabel ?? 'Edit');
    edit.title = this.opts.ariaLabel ?? 'Edit';
    edit.textContent = '✎';
    edit.addEventListener('click', () => this.enterEdit());

    this.el.replaceChildren(text, edit);
  }

  private enterEdit(): void {
    this.editing = true;
    const input = this.opts.multiline
      ? document.createElement('textarea')
      : document.createElement('input');
    input.className = 'editable-field__input';
    input.dataset.editableInput = '';
    if (!this.opts.multiline) (input as HTMLInputElement).type = 'text';
    input.value = this.value;
    if (this.opts.placeholder) input.placeholder = this.opts.placeholder;
    if (this.opts.ariaLabel) input.setAttribute('aria-label', this.opts.ariaLabel);

    let done = false;
    const commit = (): void => {
      if (done) return;
      done = true;
      const next = input.value;
      if (next !== this.value) {
        this.value = next;
        this.opts.onCommit(next);
      }
      this.renderDisplay();
    };
    const cancel = (): void => {
      if (done) return;
      done = true;
      this.renderDisplay();
    };

    input.addEventListener('keydown', (e) => {
      const ev = e as KeyboardEvent;
      if (ev.key === 'Escape') {
        ev.preventDefault();
        cancel();
      } else if (ev.key === 'Enter' && (!this.opts.multiline || ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        commit();
      }
    });
    input.addEventListener('blur', () => commit());

    this.el.replaceChildren(input);
    input.focus?.();
    (input as { select?: () => void }).select?.();
  }
}
