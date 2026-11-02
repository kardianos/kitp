/**
 * Portal placeholders — the `{{< name >}}` markers a page body can hold,
 * expanded when a portal is built. The page detail offers them in its
 * editor's Insert menu and lists what's wrong with the ones a body uses
 * (a misspelt name, misspelt syntax, the retired `{{< ref >}}`), so a typo
 * shows while editing instead of on the next build.
 *
 * The list mirrors `expandPlaceholders` in
 * server/internal/dom/portal/render.go: a placeholder added there is added
 * here too.
 */

import type { EditorSnippet } from '../editor/engine.js';
import { parseMarkdown } from '../editor/markdown.js';
import { marks, nodes } from '../editor/schema.js';
import type { ProseNode } from '../../vendor/prosemirror.js';

export interface PlaceholderDef {
  /** The name inside the braces: `children` for `{{< children >}}`. */
  name: string;
  /** The Insert menu item. */
  label: string;
  /** What it becomes on the published site. */
  description: string;
}

/** The placeholders a portal build expands, in menu order. */
export const PAGE_PLACEHOLDERS: readonly PlaceholderDef[] = [
  { name: 'children', label: 'Child pages', description: "A list of this page's child pages" },
  { name: 'nav', label: 'Site map', description: 'The whole site tree' },
  { name: 'toc', label: 'Table of contents', description: "This page's headings" },
];

/** A placeholder as written in a page body. */
export const placeholderText = (name: string): string => `{{< ${name} >}}`;

/** The Insert-menu entries for `defs`. */
export function placeholderSnippets(defs: readonly PlaceholderDef[]): EditorSnippet[] {
  return defs.map((d) => ({ group: 'Placeholders', label: d.label, text: placeholderText(d.name), description: d.description }));
}

/** A well-formed placeholder: the server's pattern. */
const PLACEHOLDER = /\{\{<\s*([a-z]+)\s*([^>]*?)\s*>\}\}/g;
/** The name at the start of something that opens like a placeholder. */
const OPENER_NAME = /^\{\{\s*[<%]?\s*([A-Za-z]+)/;

/**
 * Problems with the placeholders in page body `markdown`, as sentences for
 * the page detail, in body order without repeats. Placeholders in code (a
 * code span or block) are text, as on the site, so they're skipped. With no
 * `defs` there's nothing to check.
 */
export function placeholderIssues(markdown: string, defs: readonly PlaceholderDef[]): string[] {
  if (defs.length === 0 || !markdown.includes('{{')) return [];
  const names = defs.map((d) => d.name);
  const known = new Set(names);
  const out: string[] = [];
  for (const text of proseTexts(parseMarkdown(markdown))) {
    const covered: Array<[number, number]> = [];
    for (const m of text.matchAll(PLACEHOLDER)) {
      const at = m.index ?? 0;
      covered.push([at, at + m[0].length]);
      const name = m[1];
      if (known.has(name)) continue;
      if (name === 'ref') {
        out.push(`${m[0]} no longer works. Select the link text, choose Link and pick the page.`);
        continue;
      }
      const near = nearest(name, names, 0);
      out.push(
        near !== null
          ? `${m[0]} isn't a placeholder. Did you mean ${placeholderText(near)}?`
          : `${m[0]} isn't a placeholder. Use ${listOf(names.map(placeholderText))}.`,
      );
    }
    // Something that opens like a placeholder around a known name, but isn't
    // one: {{ children }}, {{<children}}, {{< Children >}}.
    for (let at = text.indexOf('{{'); at !== -1; at = text.indexOf('{{', at + 2)) {
      if (covered.some(([s, e]) => at >= s && at < e)) continue;
      const rest = text.slice(at);
      const name = OPENER_NAME.exec(rest)?.[1];
      const near = name === undefined ? null : nearest(name.toLowerCase(), names, 1);
      if (near === null) continue;
      out.push(`${excerpt(rest)} isn't written like a placeholder. Write ${placeholderText(near)}.`);
    }
  }
  return [...new Set(out)];
}

/**
 * The body's prose, one string per text block, skipping code blocks; a code
 * span becomes a NUL so nothing matches across or inside it, and an inline
 * node (a line break, an image) a newline.
 */
function proseTexts(doc: ProseNode): string[] {
  const out: string[] = [];
  doc.descendants((node: ProseNode) => {
    if (node.type === nodes.code_block) return false;
    if (!node.isTextblock) return true;
    let text = '';
    node.forEach((child: ProseNode) => {
      if (!child.isText) text += '\n';
      else if (child.marks.some((m: { type: unknown }) => m.type === marks.code)) text += '\u0000';
      else text += child.text ?? '';
    });
    if (text.includes('{{')) out.push(text);
    return false;
  });
  return out;
}

/** `rest` up to its first `}}` on the line (40 characters at most). */
function excerpt(rest: string): string {
  const line = rest.split('\n', 1)[0];
  const close = line.indexOf('}}');
  if (close !== -1 && close < 40) return line.slice(0, close + 2);
  return line.length > 20 ? `${line.slice(0, 20)}…` : line;
}

/**
 * The name in `names` closest to `name`, if it's near enough: one edit away
 * for a short name (nav, toc), two for a longer one, less `strict` edits
 * (1 for text that isn't even written like a placeholder, so `{{ now }}`
 * doesn't read as nav). Null when none is.
 */
function nearest(name: string, names: readonly string[], strict: number): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const n of names) {
    const d = editDistance(name, n);
    if (d <= (n.length <= 4 ? 1 : 2) - strict && d < bestD) {
      best = n;
      bestD = d;
    }
  }
  return best;
}

/** Levenshtein distance. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** "a", "a or b", "a, b or c". */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}
