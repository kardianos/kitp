/**
 * The editor's ProseMirror schema — the single source of truth for "what
 * markdown means" inside the WYSIWYG editor AND the headless renderer.
 *
 * It is the CommonMark schema from prosemirror-markdown (which already includes
 * paragraphs, headings, blockquotes, code blocks, horizontal rules, images,
 * hard breaks, and bullet/ordered/list_item) extended with:
 *
 *   - GFM tables (prosemirror-tables), with cells constrained to INLINE content
 *     only. GFM table cells cannot hold block content (paragraphs, nested
 *     lists), so the schema enforces that structurally — every table the editor
 *     can build round-trips losslessly to markdown. A per-cell `align` attribute
 *     carries column alignment so it survives the round-trip.
 *   - a `strikethrough` mark (GFM `~~text~~`), matching the feature set the
 *     display pipeline already renders.
 *
 * markdown.ts builds the parser/serializer against THIS schema; render.ts builds
 * a DOMSerializer from it. Keep the three in lockstep: a node/mark added here
 * needs a parser token, a serializer entry, and (implicitly) a toDOM.
 */

import {
  Schema,
  schema as markdownBaseSchema,
  tableNodes,
} from '../../vendor/prosemirror.js';

const tnodes = tableNodes({
  tableGroup: 'block',
  // Inline-only cells: the structural guarantee that tables stay GFM-serializable.
  cellContent: 'inline+',
  cellAttributes: {
    align: {
      default: null,
      getFromDOM(dom: HTMLElement): string | null {
        return dom.style.textAlign || null;
      },
      setDOMAttr(value: string | null, attrs: Record<string, string>): void {
        if (value) attrs.style = `text-align:${value}`;
      },
    },
  },
});

// Extend the base `list_item` with a GFM task-list `checked` attribute:
//   null  → a normal list item (renders/serializes exactly as before)
//   false → an unchecked task item `[ ]`
//   true  → a checked task item `[x]`
// markdown.ts detects/emits the `[ ]`/`[x]` marker; pm-engine.ts gives task
// items an interactive checkbox nodeView; render.ts renders them disabled.
const baseListItem = markdownBaseSchema.spec.nodes.get('list_item');
const taskListItem = {
  ...baseListItem,
  attrs: { ...(baseListItem.attrs ?? {}), checked: { default: null } },
  parseDOM: [
    {
      tag: 'li[data-checked]',
      getAttrs: (dom: HTMLElement) => ({ checked: dom.getAttribute('data-checked') === 'true' }),
    },
    { tag: 'li', getAttrs: () => ({ checked: null }) },
  ],
  toDOM: (node: { attrs: { checked: boolean | null } }) => {
    if (node.attrs.checked === null) return ['li', 0];
    const box = node.attrs.checked
      ? { type: 'checkbox', checked: 'checked' }
      : { type: 'checkbox' };
    return [
      'li',
      { class: 'task-item', 'data-checked': node.attrs.checked ? 'true' : 'false' },
      ['input', box],
      ['div', { class: 'task-item__content' }, 0],
    ];
  },
};

export const editorSchema = new Schema({
  nodes: markdownBaseSchema.spec.nodes.update('list_item', taskListItem).append(tnodes),
  marks: markdownBaseSchema.spec.marks.addToEnd('strikethrough', {
    parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }],
    toDOM(): [string, number] {
      return ['s', 0];
    },
  }),
});

/** Node types, by name (blockquote, heading, bullet_list, table, …). */
export const nodes = editorSchema.nodes;
/** Mark types, by name (em, strong, link, code, strikethrough). */
export const marks = editorSchema.marks;
