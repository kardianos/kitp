/**
 * Editor engine seam — the swappable backend behind {@link RichEditor}.
 *
 * RichEditor's PUBLIC surface is markdown-string-in / markdown-string-out plus
 * lifecycle (focus / destroy). Everything engine-specific (a <textarea> today, a
 * ProseMirror view tomorrow) lives behind this `EditorEngine` interface so the
 * engine can be replaced with ZERO change at any call site. The interface is the
 * encapsulation boundary: no engine type (no ProseMirror import) ever leaks past
 * it.
 *
 * An engine is created by an {@link EngineFactory}: it builds its editable DOM
 * inside the host element handed to it, wires the three hooks (input / commit /
 * cancel), and returns the imperative handle RichEditor drives.
 *
 * Stage 1 ships only the textarea engine (graceful fallback + a baseline that
 * proves the boundary). Stage 3 adds a ProseMirror engine and flips the default
 * via `setRichEditorEngine` — no call site changes.
 */

import { fitTextarea } from '../util/autosize.js';

/** Construction inputs for an engine. Mirrors the RichEditor option subset that
 *  describes the editable element itself (not the wrapper or the callbacks). */
export interface EngineInit {
  /** Initial markdown source. */
  value: string;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** Minimum visible rows / height floor. */
  minRows?: number;
  /** Class(es) applied to the EDITABLE element so existing per-site CSS hooks
   *  (e.g. `task-comments__composer-input`) keep applying across the swap. */
  editableClassName?: string;
  /** data-* (or any) attributes stamped on the EDITABLE element so existing
   *  selectors (`[data-comment-input]`, focus targets, tests) keep resolving. */
  editableAttrs?: Record<string, string>;
}

/**
 * A formatting command the toolbar can run. The toolbar addresses the engine
 * ONLY through these names — no engine type (no ProseMirror) leaks to the UI.
 */
export type EditorAction =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bullet'
  | 'ordered'
  | 'quote'
  | 'codeblock'
  | 'hr'
  | 'link'
  | 'undo'
  | 'redo'
  // Toggles the editor between WYSIWYG and a raw-Markdown <textarea>. Unlike the
  // others this isn't a document edit — the engine swaps its own editing surface
  // (see pm-engine.ts). `isActive('raw')` reports the current mode; `can(...)` of
  // every formatting action is false while raw is on (only undo/redo/raw stay
  // live). The textarea fallback engine has no rich mode, so it's inert there.
  | 'raw';

/** The things an engine reports outward. The owning RichEditor forwards these
 *  to its caller's optional callbacks. */
export interface EngineHooks {
  /** Content changed; carries the current markdown. */
  onInput: (markdown: string) => void;
  /** Commit gesture (Mod/Ctrl+Enter); carries the current markdown. */
  onCommit: (markdown: string) => void;
  /** Cancel gesture (Escape). */
  onCancel: () => void;
  /** Focus left the editable element. Optional — only live-commit hosts use it. */
  onBlur?: () => void;
  /** Selection moved or content changed — the host refreshes toolbar state.
   *  Optional; only command-capable engines fire it. */
  onSelectionChange?: () => void;
}

/** Imperative handle over a live engine instance. */
export interface EditorEngine {
  getMarkdown(): string;
  setMarkdown(markdown: string): void;
  setDisabled(disabled: boolean): void;
  focus(): void;
  /** True when the editable element currently holds focus (guards setMarkdown). */
  isFocused(): boolean;
  /** Tear down listeners / view and remove the editable DOM. */
  destroy(): void;
  /** True when this engine implements the {@link EditorAction} command surface
   *  (the formatting toolbar only renders when true). */
  supportsCommands(): boolean;
  /** Run a formatting command at the current selection. */
  exec(action: EditorAction): void;
  /** Whether the command is active at the current selection (button pressed). */
  isActive(action: EditorAction): boolean;
  /** Whether the command can apply right now (button enabled). */
  can(action: EditorAction): boolean;
}

export type EngineFactory = (
  host: HTMLElement,
  init: EngineInit,
  hooks: EngineHooks,
) => EditorEngine;

/* -------------------------------------------------------------------------- */
/* Textarea engine — the Stage-1 backend.                                      */
/* -------------------------------------------------------------------------- */

/**
 * A plain auto-growing <textarea>. This is the current editing experience,
 * relocated behind the engine seam unchanged: markdown is the literal textarea
 * value, Escape cancels, Mod/Ctrl+Enter commits, bare Enter inserts a newline.
 */
export const createTextareaEngine: EngineFactory = (host, init, hooks) => {
  const ta = document.createElement('textarea');
  ta.className = init.editableClassName ?? 'rich-editor__textarea';
  ta.value = init.value;
  ta.rows = init.minRows ?? 3;
  if (init.placeholder !== undefined) ta.placeholder = init.placeholder;
  if (init.ariaLabel !== undefined) ta.setAttribute('aria-label', init.ariaLabel);
  if (init.disabled === true) ta.disabled = true;
  for (const [k, v] of Object.entries(init.editableAttrs ?? {})) ta.setAttribute(k, v);

  const onInput = (): void => {
    fitTextarea(ta);
    hooks.onInput(ta.value);
  };
  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      hooks.onCancel();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      hooks.onCommit(ta.value);
    }
  };
  const onBlur = (): void => hooks.onBlur?.();
  ta.addEventListener('input', onInput);
  ta.addEventListener('keydown', onKeydown as EventListener);
  ta.addEventListener('blur', onBlur);
  host.append(ta);
  // Fit once layout is available (preserved drafts, reopened editors).
  queueMicrotask(() => fitTextarea(ta));

  return {
    getMarkdown: () => ta.value,
    setMarkdown: (md) => {
      ta.value = md;
      fitTextarea(ta);
    },
    setDisabled: (d) => {
      ta.disabled = d;
    },
    focus: () => ta.focus(),
    isFocused: () => document.activeElement === ta,
    destroy: () => {
      ta.removeEventListener('input', onInput);
      ta.removeEventListener('keydown', onKeydown as EventListener);
      ta.removeEventListener('blur', onBlur);
      ta.remove();
    },
    // The textarea baseline has no rich command surface — the toolbar stays
    // hidden over it (supportsCommands === false), so these are inert.
    supportsCommands: () => false,
    exec: () => {},
    isActive: () => false,
    can: () => false,
  };
};
