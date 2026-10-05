/**
 * Guard: no "empty <label> shell" field helpers.
 *
 * A `<label>` with no `for` forwards every click inside it to its FIRST
 * labelable descendant. Wrapping a composite (a RichEditor whose toolbar
 * starts with the Bold button, a RefPicker / Combobox trigger, a composer)
 * therefore re-dispatches clicks on the caption, the text area or the padding
 * as clicks on that first button — the "Bold toggles itself / looks stuck on"
 * bug in the new-issue dialog.
 *
 * The bug was copied three times through the same shape: a helper that takes
 * only a caption string, builds a bare `<label>` and returns it for the CALLER
 * to fill with whatever control it likes (`labeledField(label)` /
 * `field(label)`). Captioned fields must go through
 * `captionedField(caption, control, classes)` (src/ui/captioned-field.ts),
 * which sees the control and only uses a `<label>` around a native
 * input / select / textarea.
 *
 * A plain inline `<label>` around one native control (a checkbox row, a
 * native date input) is fine and isn't flagged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function tsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

// A function / method / arrow whose ONLY parameter is a string, returning an
// HTMLElement, that creates a <label> before its body closes at depth 0.
const SHELL = /\(\s*\w+\s*:\s*string\s*\)\s*:\s*HTMLElement\s*(?:=>\s*)?\{(?:[^{}]|\{[^{}]*\})*?document\.createElement\(\s*['"]label['"]\s*\)/g;

/** The detector itself, as a table — so a regex tweak can't silently stop
 *  matching the shapes that actually shipped. */
for (const [name, src, want] of [
  ['old quick-entry helper', "function labeledField(label: string): HTMLElement {\n  const wrap = document.createElement('label');\n  return wrap;\n}", true],
  ['old comm-thread method', "  private field(label: string): HTMLElement {\n    const row = document.createElement('label');\n    return row;\n  }", true],
  ['arrow form', "const f = (text: string): HTMLElement => {\n  const l = document.createElement('label');\n  return l;\n};", true],
  ['helper that receives the control', "function field(label: string, control: HTMLElement): HTMLElement {\n  const l = document.createElement('label');\n  l.append(control);\n  return l;\n}", false],
  ['inline checkbox row', "const row = document.createElement('label');\nrow.append(box, span);", false],
  ['string-only helper with no label', "function caption(text: string): HTMLElement {\n  const s = document.createElement('span');\n  return s;\n}", false],
]) {
  test(`label-shell detector: ${name}`, () => {
    assert.equal(new RegExp(SHELL.source).test(src), want);
  });
}

test('no source file defines an empty <label> shell helper (use captionedField)', () => {
  const offenders = [];
  for (const file of tsFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(SHELL)) {
      const line = text.slice(0, m.index).split('\n').length;
      offenders.push(`${relative(SRC, file)}:${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'build captioned fields with captionedField(caption, control, classes) from src/ui/captioned-field.ts — ' +
      'a <label> shell filled later can end up wrapping a composite and forward its clicks to the first button',
  );
});
