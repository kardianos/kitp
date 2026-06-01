/**
 * Markdown <-> ProseMirror document, bound to the editor schema (schema.ts).
 *
 * Parser: prosemirror-markdown's default CommonMark token map, extended with GFM
 * table tokens and the strikethrough mark, fed by a markdown-it instance with
 * tables + strikethrough enabled and raw HTML OFF (`html: false`) — so embedded
 * HTML is inert text, never markup.
 *
 * Serializer: the default CommonMark node/mark serializers plus a GFM table
 * writer. Table cells are inline-only (enforced by the schema), so the cell
 * writer is a small focused inline-markdown emitter rather than a re-entrant use
 * of the streaming serializer state.
 *
 * This module is DOM-free: it can parse/serialize headlessly (tests, render.ts).
 */

import {
  MarkdownParser,
  MarkdownSerializer,
  MarkdownIt,
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  type MarkdownSerializerState,
  type MarkdownItToken,
  type ProseNode,
} from '../../vendor/prosemirror.js';
import { editorSchema } from './schema.js';

/* ----------------------------- parser ---------------------------- */

// 'default' preset enables GFM tables + strikethrough; html:false makes raw
// HTML inert text (no markup), the same safety posture as the display pipeline.
const md = MarkdownIt('default', { html: false });

const TASK_MARKER = /^\[([ xX])\]\s/;

// GFM task lists. markdown-it has no task-list rule, so this small core rule
// detects a leading `[ ] `/`[x] ` in each list item, records it on the
// list_item_open token (read back by the list_item getAttrs below), and strips
// the marker from the rendered content. Self-contained — no extra vendored dep.
md.core.ruler.after('inline', 'kitp_task_lists', (state: { tokens: any[] }) => {
  const tokens = state.tokens;
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (tokens[i].type !== 'list_item_open') continue;
    const inline = tokens[i + 2];
    if (!inline || inline.type !== 'inline') continue;
    const m = TASK_MARKER.exec(inline.content);
    if (!m) continue;
    tokens[i].attrSet('data-checked', m[1].toLowerCase() === 'x' ? 'true' : 'false');
    inline.content = inline.content.slice(m[0].length);
    const kids = inline.children;
    if (kids && kids.length > 0 && kids[0].type === 'text') {
      kids[0].content = kids[0].content.replace(TASK_MARKER, '');
    }
  }
  return false;
});

/** Read a markdown-it table cell token's column alignment from its style attr. */
function alignOf(tok: MarkdownItToken): string | null {
  const style = typeof tok.attrGet === 'function' ? tok.attrGet('style') : null;
  if (!style) return null;
  const m = /text-align:\s*(left|center|right)/.exec(style);
  return m ? m[1] : null;
}

export const parser = new MarkdownParser(editorSchema, md, {
  ...defaultMarkdownParser.tokens,
  // GFM task list: read the marker the core rule stashed on the token.
  list_item: {
    block: 'list_item',
    getAttrs: (tok: MarkdownItToken) => {
      const c = tok.attrGet('data-checked');
      return { checked: c === null ? null : c === 'true' };
    },
  },
  // GFM tables. markdown-it nests rows under thead/tbody; prosemirror-tables has
  // rows as direct children of `table`, so thead/tbody are ignored (their <tr>
  // children attach straight to the table).
  table: { block: 'table' },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: 'table_row' },
  th: { block: 'table_header', getAttrs: (tok: MarkdownItToken) => ({ align: alignOf(tok) }) },
  td: { block: 'table_cell', getAttrs: (tok: MarkdownItToken) => ({ align: alignOf(tok) }) },
  // GFM strikethrough.
  s: { mark: 'strikethrough' },
});

/* --------------------------- serializer -------------------------- */

/** Escape characters that would break a markdown table cell. */
function escCell(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Serialize one inline node of a table cell to markdown (text + marks, images,
 *  hard breaks). Cells are inline-only, so this covers the whole cell content. */
function inlineNodeMarkdown(node: ProseNode): string {
  const name: string = node.type.name;
  if (name === 'hard_break') return ' ';
  if (name === 'image') {
    const alt = escCell(node.attrs.alt ?? '');
    const title = node.attrs.title ? ` "${node.attrs.title}"` : '';
    return `![${alt}](${node.attrs.src ?? ''}${title})`;
  }
  if (node.isText) {
    const raw: string = node.text ?? '';
    const markNames = new Set<string>(node.marks.map((m: { type: { name: string } }) => m.type.name));
    let link: { href: string; title: string } | null = null;
    for (const m of node.marks) {
      if (m.type.name === 'link') {
        link = { href: m.attrs.href ?? '', title: m.attrs.title ? ` "${m.attrs.title}"` : '' };
      }
    }
    let t: string;
    if (markNames.has('code')) {
      // A code span is literal: only the pipe needs escaping, no nested emphasis.
      t = '`' + raw.replace(/\|/g, '\\|').replace(/\n/g, ' ') + '`';
    } else {
      t = escCell(raw);
      if (markNames.has('strikethrough')) t = `~~${t}~~`;
      if (markNames.has('em')) t = `*${t}*`;
      if (markNames.has('strong')) t = `**${t}**`;
    }
    if (link !== null) t = `[${t}](${link.href}${link.title})`;
    return t;
  }
  return escCell(node.textContent ?? '');
}

function cellMarkdown(cell: ProseNode): string {
  let out = '';
  cell.forEach((child: ProseNode) => {
    out += inlineNodeMarkdown(child);
  });
  return out.trim();
}

/** GFM alignment separator for a column, from the header cell's `align` attr. */
function sep(align: string | null): string {
  switch (align) {
    case 'center':
      return ':---:';
    case 'right':
      return '---:';
    case 'left':
      return ':---';
    default:
      return '---';
  }
}

/** Serialize a `table` node to a GFM pipe table. The first row is the header. */
function writeTable(state: MarkdownSerializerState, node: ProseNode): void {
  const rows: { text: string; align: string | null }[][] = [];
  node.forEach((row: ProseNode) => {
    const cells: { text: string; align: string | null }[] = [];
    row.forEach((cell: ProseNode) => {
      cells.push({ text: cellMarkdown(cell), align: cell.attrs.align ?? null });
    });
    rows.push(cells);
  });
  if (rows.length === 0) return;
  state.ensureNewLine();
  const header = rows[0];
  state.write('| ' + header.map((c) => c.text || ' ').join(' | ') + ' |\n');
  state.write('| ' + header.map((c) => sep(c.align)).join(' | ') + ' |\n');
  for (let i = 1; i < rows.length; i++) {
    state.write('| ' + rows[i].map((c) => c.text || ' ').join(' | ') + ' |\n');
  }
  state.closeBlock(node);
}

export const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    // GFM task list: emit the `[ ]`/`[x]` marker after the list bullet, then the
    // item content. A normal item (checked === null) serializes as before.
    list_item: (state: MarkdownSerializerState, node: ProseNode) => {
      if (node.attrs.checked !== null && node.attrs.checked !== undefined) {
        state.write(node.attrs.checked ? '[x] ' : '[ ] ');
      }
      state.renderContent(node);
    },
    table: writeTable,
    // Consumed by writeTable; never visited directly, but registered so the
    // serializer never throws on an unexpected lookup.
    table_row: () => {},
    table_header: () => {},
    table_cell: () => {},
  },
  {
    ...defaultMarkdownSerializer.marks,
    strikethrough: {
      open: '~~',
      close: '~~',
      mixable: true,
      expelEnclosingWhitespace: true,
    },
  },
);

/* ----------------------------- public ---------------------------- */

/** Markdown source -> ProseMirror document (editor schema). */
export function parseMarkdown(text: string): ProseNode {
  return parser.parse(text);
}

/** ProseMirror document -> markdown source. */
export function serializeMarkdown(doc: ProseNode): string {
  return serializer.serialize(doc);
}
