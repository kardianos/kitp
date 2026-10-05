/**
 * captionedField — the shared "caption above a control" form-field shell.
 *
 * It renders a native `<label>` ONLY around a single native labelable control
 * (input / select / textarea), where clicking the caption usefully focuses the
 * control. Any other content — a RichEditor (whose formatting toolbar is a row
 * of `<button>`s), a RefPicker, a composer — gets a `<div role="group">` named
 * by the caption via `aria-labelledby`.
 *
 * Why: wrapping a composite widget in a `<label>` is a trap. The label's
 * labeled control is its FIRST labelable descendant — for a RichEditor that's
 * the toolbar's Bold button — so the browser re-dispatches every click that
 * lands anywhere else in the field (the caption, the editable text, padding)
 * as a click on that button, toggling bold, and paints the label's
 * :hover / :active state onto it so Bold looks stuck "on".
 */

export interface CaptionedFieldClasses {
  /** Class on the field wrapper. */
  field: string;
  /** Class on the caption span. */
  caption: string;
}

let captionSeq = 0;

export function captionedField(caption: string, control: HTMLElement, cls: CaptionedFieldClasses): HTMLElement {
  const native = isNativeLabelable(control);
  const wrap = document.createElement(native ? 'label' : 'div');
  wrap.className = cls.field;
  const span = document.createElement('span');
  span.className = cls.caption;
  span.textContent = caption;
  if (!native) {
    span.id = `captioned-field-${++captionSeq}`;
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-labelledby', span.id);
  }
  wrap.append(span, control);
  return wrap;
}

const NATIVE_LABELABLE = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

function isNativeLabelable(el: HTMLElement): boolean {
  return NATIVE_LABELABLE.has(String(el.tagName).toUpperCase());
}
