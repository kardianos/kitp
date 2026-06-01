// Hand-authored type surface for the vendored ProseMirror bundle
// (vendor/prosemirror.js — see its banner for the bundled package list).
//
// Like vendor/floating-ui-dom.d.ts, this declares ONLY the surface the single
// consumer (web/src/editor/) uses, rather than vendoring + rewriting the whole
// upstream type graph across a dozen @prosemirror packages. ProseMirror's
// internal object graph (documents, transactions, resolved positions) is opaque
// to the editor code, which lives BEHIND the RichEditor boundary and only deals
// in markdown strings outwardly — so those internals are intentionally typed as
// `any`. Widen here if the editor grows to need more of the API.
//
// Resolved as the sibling .d.ts to the `./prosemirror.js` import under
// tsconfig's Bundler resolution, mirroring vendor/marked.d.ts etc.

/* ----------------------------- model ----------------------------- */

/** Opaque ProseMirror document node / fragment / mark — the editor treats
 *  these as handles and never reaches into their structure outside markdown.ts. */
export type ProseNode = any;
export type ProseMark = any;

export interface NodeType {
  name: string;
  create(attrs?: any, content?: any, marks?: any): ProseNode;
}
export interface MarkType {
  name: string;
  create(attrs?: any): ProseMark;
}

/** orderedmap — the schema spec's node/mark tables. */
export interface OrderedMap<T = any> {
  append(map: OrderedMap<T> | Record<string, T>): OrderedMap<T>;
  addToEnd(key: string, value: T): OrderedMap<T>;
  update(key: string, value: T, newKey?: string): OrderedMap<T>;
  get(key: string): T | undefined;
}

export interface SchemaSpec {
  nodes: OrderedMap;
  marks: OrderedMap;
}

export class Schema {
  constructor(spec: {
    nodes: OrderedMap | Record<string, any>;
    marks?: OrderedMap | Record<string, any>;
  });
  spec: SchemaSpec;
  nodes: Record<string, NodeType>;
  marks: Record<string, MarkType>;
}

export class DOMSerializer {
  static fromSchema(schema: Schema): DOMSerializer;
  serializeFragment(fragment: any, options?: any): DocumentFragment;
  serializeNode(node: ProseNode): Node;
}

/* --------------------------- markdown ---------------------------- */

/** The base CommonMark schema from prosemirror-markdown. */
export const schema: Schema;

/** A markdown-it token-name -> ParseSpec map (see prosemirror-markdown docs). */
export type MarkdownTokenSpec = Record<string, any>;

export class MarkdownParser {
  constructor(schema: Schema, tokenizer: any, tokens: MarkdownTokenSpec);
  tokens: MarkdownTokenSpec;
  parse(text: string): ProseNode;
}

/** The streaming serializer state handed to each node/mark serializer fn. */
export interface MarkdownSerializerState {
  write(content: string): void;
  ensureNewLine(): void;
  closeBlock(node: ProseNode): void;
  renderInline(parent: ProseNode): void;
  renderContent(parent: ProseNode): void;
  esc(str: string): string;
  text(text: string, escape?: boolean): void;
}

export type MarkdownNodeSerializer = (
  state: MarkdownSerializerState,
  node: ProseNode,
  parent: ProseNode,
  index: number,
) => void;

export class MarkdownSerializer {
  constructor(
    nodes: Record<string, MarkdownNodeSerializer>,
    marks: Record<string, any>,
  );
  nodes: Record<string, MarkdownNodeSerializer>;
  marks: Record<string, any>;
  serialize(content: ProseNode, options?: any): string;
}

export const defaultMarkdownParser: MarkdownParser;
export const defaultMarkdownSerializer: MarkdownSerializer;

/* --------------------------- markdown-it ------------------------- */

export interface MarkdownItToken {
  type: string;
  info: string;
  content: string;
  attrGet(name: string): string | null;
}
export interface MarkdownItConstructor {
  new (preset?: string, options?: any): any;
  (preset?: string, options?: any): any;
}
export const MarkdownIt: MarkdownItConstructor;

/* ----------------------------- state ----------------------------- */

export type Command = (
  state: any,
  dispatch?: (tr: any) => void,
  view?: any,
) => boolean;

export class EditorState {
  static create(config: {
    doc?: ProseNode;
    schema?: Schema;
    plugins?: Plugin[];
  }): EditorState;
  doc: ProseNode;
  readonly schema: Schema;
  readonly tr: any;
  apply(tr: any): EditorState;
}

export class Plugin {
  constructor(spec: any);
}
export class PluginKey {
  constructor(name?: string);
}
export class TextSelection {
  static create(doc: ProseNode, anchor: number, head?: number): any;
}

/* ----------------------------- view ------------------------------ */

export interface NodeViewResult {
  dom: HTMLElement;
  contentDOM?: HTMLElement | null;
  update?(node: ProseNode): boolean;
  destroy?(): void;
}
export type NodeViewConstructor = (
  node: ProseNode,
  view: EditorView,
  getPos: () => number | undefined,
) => NodeViewResult;

export interface EditorProps {
  state: EditorState;
  dispatchTransaction?(tr: any): void;
  editable?(state: EditorState): boolean;
  attributes?: Record<string, string> | ((state: EditorState) => Record<string, string>);
  nodeViews?: Record<string, NodeViewConstructor>;
}

export class EditorView {
  constructor(place: HTMLElement | { mount: HTMLElement }, props: EditorProps);
  state: EditorState;
  dom: HTMLElement;
  updateState(state: EditorState): void;
  setProps(props: Partial<EditorProps>): void;
  dispatch(tr: any): void;
  focus(): void;
  hasFocus(): boolean;
  destroy(): void;
}

export class Decoration {
  static widget(pos: number, toDOM: Node | ((view: any) => Node), spec?: any): Decoration;
  static node(from: number, to: number, attrs: Record<string, string>, spec?: any): Decoration;
}
export class DecorationSet {
  static create(doc: ProseNode, decorations: Decoration[]): DecorationSet;
  static empty: DecorationSet;
}

/* --------------------------- commands ---------------------------- */

export const baseKeymap: Record<string, Command>;
export function toggleMark(mark: MarkType, attrs?: any): Command;
export function setBlockType(type: NodeType, attrs?: any): Command;
export function wrapIn(type: NodeType, attrs?: any): Command;
export function chainCommands(...commands: Command[]): Command;
export const exitCode: Command;

/* ---------------------------- keymap ----------------------------- */

export function keymap(bindings: Record<string, Command>): Plugin;

/* ---------------------------- history ---------------------------- */

export function history(config?: any): Plugin;
export const undo: Command;
export const redo: Command;

/* -------------------------- inputrules --------------------------- */

export class InputRule {
  constructor(match: RegExp, handler: any);
}
export function inputRules(config: { rules: InputRule[] }): Plugin;
export function wrappingInputRule(
  regexp: RegExp,
  nodeType: NodeType,
  getAttrs?: any,
  joinPredicate?: any,
): InputRule;
export function textblockTypeInputRule(
  regexp: RegExp,
  nodeType: NodeType,
  getAttrs?: any,
): InputRule;

/* -------------------------- schema-list -------------------------- */

export function splitListItem(itemType: NodeType, attrs?: any): Command;
export function liftListItem(itemType: NodeType): Command;
export function sinkListItem(itemType: NodeType): Command;
export function wrapInList(nodeType: NodeType, attrs?: any): Command;
export function addListNodes(
  nodes: OrderedMap,
  itemContent: string,
  listGroup?: string,
): OrderedMap;

/* ---------------------------- tables ----------------------------- */

export interface CellAttribute {
  default: any;
  getFromDOM?(dom: HTMLElement): any;
  setDOMAttr?(value: any, attrs: Record<string, string>): void;
}
export function tableNodes(options: {
  tableGroup?: string;
  cellContent: string;
  cellAttributes: Record<string, CellAttribute>;
}): Record<string, any>;
export function tableEditing(options?: any): Plugin;
export function columnResizing(options?: any): Plugin;
export function goToNextCell(direction: number): Command;
export function fixTables(state: any): any;
export const addRowAfter: Command;
export const addRowBefore: Command;
export const deleteRow: Command;
export const addColumnAfter: Command;
export const addColumnBefore: Command;
export const deleteColumn: Command;
export const deleteTable: Command;
export const mergeCells: Command;
export const splitCell: Command;
