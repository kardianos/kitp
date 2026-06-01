/**
 * RichEditor — the encapsulated, drop-in WYSIWYG/markdown editor.
 *
 * A lightweight HELPER (not a Control), in the mould of `ui/editable-field.ts`:
 * construct it, mount its `.el`, and it fires `onInput` / `onCommit` / `onCancel`.
 * The host owns persistence (PURE: markdown in, markdown out — the same contract
 * as `FieldEditor`). The host MUST call `destroy()` when it tears the editor down
 * (engines such as ProseMirror hold a view that needs explicit teardown); the
 * call-site Controls register that in their own `onDestroy`.
 *
 * The PUBLIC surface is markdown `string` + lifecycle only — no engine type
 * leaks. The actual editor is provided by an {@link EngineFactory} (see
 * engine.ts), so the backend swaps (textarea -> ProseMirror) with no change here
 * or at any call site.
 *
 * Commit semantics match the existing description/comment editors exactly:
 * Mod/Ctrl+Enter commits, Escape cancels, and it NEVER commits on blur (the
 * description field deliberately lets the user paste back and forth without
 * committing — see task-detail.ts).
 */

import { createTextareaEngine, type EditorEngine, type EngineFactory } from './engine.js';
import { createToolbar, type EditorToolbar } from './toolbar.js';

export interface RichEditorOptions {
  /** Initial markdown source. */
  value: string;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** Minimum visible rows / height floor. */
  minRows?: number;
  /** Extra class(es) on the wrapper `el`. */
  className?: string;
  /** Class(es) on the editable element (preserves per-site CSS across the swap). */
  editableClassName?: string;
  /** Attributes stamped on the editable element (preserves selectors / focus). */
  editableAttrs?: Record<string, string>;
  /** Fired on every change with the current markdown (host tracks draft / toggles buttons). */
  onInput?: (markdown: string) => void;
  /** Mod/Ctrl+Enter. Host persists. */
  onCommit?: (markdown: string) => void;
  /** Escape. */
  onCancel?: () => void;
  /** Focus left the editor — for live-commit hosts that save on blur. */
  onBlur?: () => void;
  /**
   * Show the formatting toolbar at the top of the edit area. Default true. Only
   * renders when the active engine actually supports commands (the ProseMirror
   * engine does; the textarea fallback doesn't), so it's a no-op over textarea.
   */
  toolbar?: boolean;
}

/**
 * The active engine factory. Defaults to the textarea engine; Stage 3 calls
 * `setRichEditorEngine(createProseMirrorEngine)` once at boot to upgrade every
 * RichEditor in the app behind the unchanged public API.
 */
let engineFactory: EngineFactory = createTextareaEngine;

/** Swap the backend for all future RichEditor instances. */
export function setRichEditorEngine(factory: EngineFactory): void {
  engineFactory = factory;
}

export class RichEditor {
  /** Mount this; it wraps the active engine's editable element. */
  readonly el: HTMLElement;
  private readonly opts: RichEditorOptions;
  private readonly engine: EditorEngine;
  private toolbar: EditorToolbar | null = null;

  constructor(opts: RichEditorOptions) {
    this.opts = opts;
    const el = document.createElement('div');
    el.className = `rich-editor${opts.className ? ` ${opts.className}` : ''}`;
    el.dataset.richEditor = '';
    this.el = el;
    this.engine = engineFactory(
      el,
      {
        value: opts.value,
        placeholder: opts.placeholder,
        ariaLabel: opts.ariaLabel,
        disabled: opts.disabled,
        minRows: opts.minRows,
        editableClassName: opts.editableClassName,
        editableAttrs: opts.editableAttrs,
      },
      {
        onInput: (md) => {
          this.opts.onInput?.(md);
          this.toolbar?.refresh();
        },
        onCommit: (md) => this.opts.onCommit?.(md),
        onCancel: () => this.opts.onCancel?.(),
        onBlur: () => this.opts.onBlur?.(),
        onSelectionChange: () => this.toolbar?.refresh(),
      },
    );
    // The formatting toolbar mounts at the TOP of the edit area (prepended
    // before the engine's editable). It only renders over a command-capable
    // engine, so the textarea fallback (and jsdom tests) stay toolbar-free.
    if (opts.toolbar !== false && this.engine.supportsCommands()) {
      this.toolbar = createToolbar(this.engine);
      el.prepend(this.toolbar.el);
      el.classList.add('rich-editor--with-toolbar');
    }
  }

  /** Current content as markdown. */
  getValue(): string {
    return this.engine.getMarkdown();
  }

  /**
   * Reseed the content from outside (e.g. after a server reload, or populating a
   * reused dialog). No-op while the editor is focused, so an in-progress edit is
   * never clobbered — mirrors `EditableField.setValue`. Pass `force` for
   * programmatic resets (dialog open/clear) that must override regardless.
   */
  setValue(markdown: string, force = false): void {
    if (!force && this.engine.isFocused()) return;
    if (markdown !== this.engine.getMarkdown()) this.engine.setMarkdown(markdown);
  }

  setDisabled(disabled: boolean): void {
    this.engine.setDisabled(disabled);
  }

  focus(): void {
    this.engine.focus();
  }

  /** Tear down the engine (its view/listeners) and remove the wrapper DOM. */
  destroy(): void {
    this.toolbar?.destroy();
    this.engine.destroy();
    this.el.remove();
  }
}
