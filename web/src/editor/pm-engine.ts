/**
 * ProseMirror engine — the WYSIWYG backend behind the {@link EditorEngine} seam.
 *
 * Built against the shared editor schema (schema.ts) and markdown round-trip
 * (markdown.ts). It mounts an EditorView into the host wrapper and surfaces the
 * three engine hooks; the public RichEditor contract (markdown string in/out +
 * lifecycle) is unchanged from the textarea engine, so swapping to this touches
 * no call site. Boot wires it via `setRichEditorEngine(createProseMirrorEngine)`.
 *
 * Commit semantics match the rest of the app: Mod/Ctrl+Enter commits, Escape
 * cancels, NEVER commits on blur. Lists and tables get the standard editing
 * keymaps (Enter splits a list item; Tab moves between table cells or indents a
 * list item); markdown shortcuts (`# `, `> `, `- `, `1. `, ```` ``` ````) come
 * from input rules.
 */

import {
  EditorState,
  EditorView,
  Plugin,
  Decoration,
  DecorationSet,
  keymap,
  baseKeymap,
  toggleMark,
  setBlockType,
  wrapIn,
  wrapInList,
  chainCommands,
  history,
  undo,
  redo,
  inputRules,
  wrappingInputRule,
  textblockTypeInputRule,
  splitListItem,
  liftListItem,
  sinkListItem,
  tableEditing,
  columnResizing,
  goToNextCell,
  type Command,
  type ProseNode,
} from '../../vendor/prosemirror.js';
import type { EditorAction, EngineFactory, EngineHooks, EngineInit } from './engine.js';
import { editorSchema, nodes, marks } from './schema.js';
import { parseMarkdown, serializeMarkdown } from './markdown.js';

/* ----------------------------- plugins --------------------------- */

function markdownInputRules(): Plugin {
  return inputRules({
    rules: [
      // `> ` -> blockquote
      wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
      // `- ` / `* ` / `+ ` -> bullet list
      wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list),
      // `1. ` -> ordered list (continuing the surrounding numbering)
      wrappingInputRule(
        /^(\d+)\.\s$/,
        nodes.ordered_list,
        (match: RegExpMatchArray) => ({ order: Number(match[1]) }),
        (match: RegExpMatchArray, node: { childCount: number; attrs: { order: number } }) =>
          node.childCount + node.attrs.order === Number(match[1]),
      ),
      // `# ` .. `###### ` -> heading
      textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading, (match: RegExpMatchArray) => ({
        level: match[1].length,
      })),
      // ``` -> code block
      textblockTypeInputRule(/^```$/, nodes.code_block),
    ],
  });
}

function editorKeymap(hooks: EngineHooks): Plugin {
  const li = nodes.list_item;
  const keys: Record<string, Command> = {
    'Mod-Enter': (state) => {
      hooks.onCommit(serializeMarkdown(state.doc));
      return true;
    },
    Escape: () => {
      hooks.onCancel();
      return true;
    },
    'Mod-b': toggleMark(marks.strong),
    'Mod-i': toggleMark(marks.em),
    'Mod-`': toggleMark(marks.code),
    'Mod-z': undo,
    'Mod-y': redo,
    'Shift-Mod-z': redo,
    // Enter splits the current list item (no-op -> falls through to baseKeymap).
    Enter: splitListItem(li),
    // Tab: next table cell, else indent a list item.
    Tab: chainCommands(goToNextCell(1), sinkListItem(li)),
    'Shift-Tab': chainCommands(goToNextCell(-1), liftListItem(li)),
    'Mod-[': liftListItem(li),
    'Mod-]': sinkListItem(li),
  };
  return keymap(keys);
}

/**
 * NodeView for `list_item` giving GFM task items (checked !== null) an
 * interactive checkbox that toggles the node's `checked` attribute. Normal list
 * items render as a plain <li> (the <li> is its own contentDOM). Editor-only;
 * the display path renders task checkboxes from the schema's toDOM (disabled).
 */
function taskItemNodeView(
  node: ProseNode,
  view: EditorView,
  getPos: () => number | undefined,
): { dom: HTMLElement; contentDOM: HTMLElement; update(updated: ProseNode): boolean } {
  let current = node;
  const li = document.createElement('li');
  let checkbox: HTMLInputElement | null = null;
  let contentDOM: HTMLElement;

  if (current.attrs.checked === null) {
    contentDOM = li;
  } else {
    li.className = 'task-item';
    checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = current.attrs.checked === true;
    checkbox.contentEditable = 'false';
    // Keep the cursor/selection where it is; just toggle the attribute.
    checkbox.addEventListener('mousedown', (e) => e.preventDefault());
    checkbox.addEventListener('change', () => {
      const pos = getPos();
      if (typeof pos !== 'number') return;
      view.dispatch(
        view.state.tr.setNodeMarkup(pos, undefined, {
          ...current.attrs,
          checked: checkbox?.checked === true,
        }),
      );
    });
    const content = document.createElement('div');
    content.className = 'task-item__content';
    li.appendChild(checkbox);
    li.appendChild(content);
    contentDOM = content;
  }

  return {
    dom: li,
    contentDOM,
    update(updated: ProseNode): boolean {
      if (updated.type !== current.type) return false;
      // A toggle between task <-> normal changes the DOM structure: rebuild.
      if ((updated.attrs.checked === null) !== (current.attrs.checked === null)) return false;
      current = updated;
      if (checkbox) checkbox.checked = updated.attrs.checked === true;
      return true;
    },
  };
}

function placeholderPlugin(text: string): Plugin {
  return new Plugin({
    props: {
      decorations(state: EditorState) {
        const doc = state.doc;
        const empty =
          doc.childCount === 1 &&
          doc.firstChild.isTextblock &&
          doc.firstChild.content.size === 0;
        if (!empty) return null;
        // NODE decoration (class + data-placeholder on the empty block, shown via
        // CSS ::before) — NOT a widget. A widget DOM node sitting at the caret
        // position is destroyed+recreated on every transaction (incl. the
        // selection change a click makes), which drops the browser selection and
        // makes the caret refuse to stay. A node decoration only toggles attrs on
        // the existing <p>, so nothing near the caret churns.
        return DecorationSet.create(doc, [
          Decoration.node(0, doc.firstChild.nodeSize, {
            class: 'rich-editor__placeholder',
            'data-placeholder': text,
          }),
        ]);
      },
    },
  });
}

/* --------------------------- commands ---------------------------- */
/* The formatting-toolbar surface. The UI addresses these by EditorAction name
 * only (engine.ts); ProseMirror never leaks past this file. */

const HEADING_LEVEL: Record<'h1' | 'h2' | 'h3', number> = { h1: 1, h2: 2, h3: 3 };

/* The vendored ProseMirror .d.ts types state / nodes / marks loosely (`any`),
 * matching `Command`'s `state: any`; these helpers follow that convention. */

/** True when `type` is set anywhere in the current selection (or stored). */
function markActive(state: any, type: unknown): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) {
    const active = state.storedMarks ?? $from.marks();
    return active.some((m: { type: unknown }) => m.type === type);
  }
  return state.doc.rangeHasMark(from, to, type);
}

/** True when the selection's textblock is `type` (optionally a given level). */
function blockTypeActive(state: any, type: unknown, attrs?: { level?: number }): boolean {
  const node = state.selection.$from.parent;
  if (node.type !== type) return false;
  return attrs?.level === undefined || node.attrs.level === attrs.level;
}

/** True when any ancestor of the selection is `type` (lists / blockquote). */
function ancestorActive(state: any, type: unknown): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === type) return true;
  return false;
}

/** The ProseMirror command for an action given the live state, or null when the
 *  action has no plain command (link → URL prompt in exec; quote-when-quoted →
 *  no-op since the vendored bundle ships no `lift`). */
function commandFor(action: EditorAction, state: any): Command | null {
  switch (action) {
    case 'bold': return toggleMark(marks.strong);
    case 'italic': return toggleMark(marks.em);
    case 'strike': return toggleMark(marks.strikethrough);
    case 'code': return toggleMark(marks.code);
    case 'h1':
    case 'h2':
    case 'h3': {
      const level = HEADING_LEVEL[action];
      return blockTypeActive(state, nodes.heading, { level })
        ? setBlockType(nodes.paragraph)
        : setBlockType(nodes.heading, { level });
    }
    case 'codeblock':
      return blockTypeActive(state, nodes.code_block)
        ? setBlockType(nodes.paragraph)
        : setBlockType(nodes.code_block);
    case 'bullet':
      return ancestorActive(state, nodes.bullet_list)
        ? liftListItem(nodes.list_item)
        : wrapInList(nodes.bullet_list);
    case 'ordered':
      return ancestorActive(state, nodes.ordered_list)
        ? liftListItem(nodes.list_item)
        : wrapInList(nodes.ordered_list);
    case 'quote':
      return ancestorActive(state, nodes.blockquote) ? null : wrapIn(nodes.blockquote);
    case 'undo': return undo;
    case 'redo': return redo;
    case 'link': return null;
  }
}

function actionActive(action: EditorAction, state: any): boolean {
  switch (action) {
    case 'bold': return markActive(state, marks.strong);
    case 'italic': return markActive(state, marks.em);
    case 'strike': return markActive(state, marks.strikethrough);
    case 'code': return markActive(state, marks.code);
    case 'link': return markActive(state, marks.link);
    case 'h1':
    case 'h2':
    case 'h3': return blockTypeActive(state, nodes.heading, { level: HEADING_LEVEL[action] });
    case 'codeblock': return blockTypeActive(state, nodes.code_block);
    case 'bullet': return ancestorActive(state, nodes.bullet_list);
    case 'ordered': return ancestorActive(state, nodes.ordered_list);
    case 'quote': return ancestorActive(state, nodes.blockquote);
    case 'undo':
    case 'redo': return false;
  }
}

/** Link: remove when one is active, else prompt for a URL over the selection. */
function execLink(view: EditorView): void {
  const state: any = view.state;
  if (markActive(state, marks.link)) {
    toggleMark(marks.link)(state, view.dispatch);
    view.focus();
    return;
  }
  if (state.selection.empty) return; // nothing to wrap → no-op
  const url = typeof prompt === 'function' ? prompt('Link URL') : null;
  if (url !== null && url.trim() !== '') {
    toggleMark(marks.link, { href: url.trim() })(view.state, view.dispatch);
  }
  view.focus();
}

/* ----------------------------- engine ---------------------------- */

function buildState(value: string, hooks: EngineHooks, init: EngineInit) {
  const plugins: Plugin[] = [
    editorKeymap(hooks),
    keymap(baseKeymap),
    markdownInputRules(),
    history(),
    columnResizing(),
    tableEditing(),
  ];
  if (init.placeholder !== undefined && init.placeholder !== '') {
    plugins.push(placeholderPlugin(init.placeholder));
  }
  return EditorState.create({ doc: parseMarkdown(value), schema: editorSchema, plugins });
}

export const createProseMirrorEngine: EngineFactory = (host, init, hooks) => {
  let disabled = init.disabled === true;

  const attributes: Record<string, string> = {};
  if (init.editableClassName !== undefined) attributes.class = init.editableClassName;
  if (init.ariaLabel !== undefined) attributes['aria-label'] = init.ariaLabel;
  for (const [k, v] of Object.entries(init.editableAttrs ?? {})) attributes[k] = v;

  const view = new EditorView(host, {
    state: buildState(init.value, hooks, init),
    editable: () => !disabled,
    attributes,
    nodeViews: { list_item: taskItemNodeView },
    dispatchTransaction(tr) {
      const next = view.state.apply(tr);
      view.updateState(next);
      if (tr.docChanged) hooks.onInput(serializeMarkdown(next.doc));
      // A selection move (no doc change) still needs to refresh the toolbar's
      // active/enabled state, so notify on every transaction.
      hooks.onSelectionChange?.();
    },
  });

  // Live-commit hosts (e.g. the project properties panel) commit on blur. Fires
  // when focus leaves the contenteditable entirely; the task checkbox's
  // mousedown-preventDefault keeps a toggle from stealing focus and tripping it.
  const onBlur = (): void => hooks.onBlur?.();
  view.dom.addEventListener('blur', onBlur);

  return {
    getMarkdown: () => serializeMarkdown(view.state.doc),
    setMarkdown: (md) => view.updateState(buildState(md, hooks, init)),
    setDisabled: (d) => {
      disabled = d;
      view.setProps({ editable: () => !disabled });
    },
    focus: () => view.focus(),
    isFocused: () => view.hasFocus(),
    destroy: () => {
      view.dom.removeEventListener('blur', onBlur);
      view.destroy();
    },
    supportsCommands: () => true,
    exec: (action) => {
      if (action === 'link') {
        execLink(view);
        return;
      }
      const cmd = commandFor(action, view.state);
      if (cmd) cmd(view.state, view.dispatch);
      view.focus();
    },
    isActive: (action) => actionActive(action, view.state),
    can: (action) => {
      const state: any = view.state;
      if (action === 'link') {
        return !state.selection.empty || markActive(state, marks.link);
      }
      const cmd = commandFor(action, state);
      return cmd !== null && cmd(state);
    },
  };
};
