/**
 * Editor formatting toolbar — a static button bar mounted at the top of a
 * {@link RichEditor}'s edit area. It speaks to the editor ONLY through the
 * {@link EditorEngine} command surface ({@link EditorAction}); it imports no
 * ProseMirror type, so it works over any command-capable engine.
 *
 * Each button runs `engine.exec(action)` on click; `refresh()` (driven by the
 * editor's selection-change hook) repaints every button's pressed / disabled
 * state from `engine.isActive` / `engine.can`. `mousedown` is prevented so a
 * click never steals the selection out of the editor.
 */

import type { EditorAction, EditorEngine } from './engine.js';

interface ToolbarButton {
  action: EditorAction;
  label: string;
  title: string;
}

/** Buttons in display order, grouped (a thin separator between groups). */
const GROUPS: ToolbarButton[][] = [
  [
    { action: 'bold', label: 'B', title: 'Bold (Ctrl/Cmd+B)' },
    { action: 'italic', label: 'I', title: 'Italic (Ctrl/Cmd+I)' },
    { action: 'strike', label: 'S', title: 'Strikethrough' },
    { action: 'code', label: '</>', title: 'Inline code (Ctrl/Cmd+`)' },
  ],
  [
    { action: 'h1', label: 'H1', title: 'Heading 1' },
    { action: 'h2', label: 'H2', title: 'Heading 2' },
    { action: 'h3', label: 'H3', title: 'Heading 3' },
  ],
  [
    { action: 'bullet', label: '•', title: 'Bullet list' },
    { action: 'ordered', label: '1.', title: 'Numbered list' },
    { action: 'quote', label: '❝', title: 'Blockquote' },
    { action: 'codeblock', label: '{ }', title: 'Code block' },
    { action: 'hr', label: '―', title: 'Horizontal rule' },
  ],
  [{ action: 'link', label: '🔗', title: 'Link' }],
  [
    { action: 'undo', label: '↶', title: 'Undo (Ctrl/Cmd+Z)' },
    { action: 'redo', label: '↷', title: 'Redo' },
  ],
  // Mode toggle: WYSIWYG <-> raw-Markdown source. Pressed state reflects the
  // current mode; the engine disables the other buttons while raw is on.
  [{ action: 'raw', label: 'M↓', title: 'Edit raw Markdown source' }],
];

export interface EditorToolbar {
  /** The toolbar root — mount it at the top of the edit area. */
  readonly el: HTMLElement;
  /** Repaint every button's active / enabled state from the engine. */
  refresh(): void;
  /** Detach listeners and remove the DOM. */
  destroy(): void;
}

export function createToolbar(engine: EditorEngine): EditorToolbar {
  const el = document.createElement('div');
  el.className = 'rich-editor__toolbar';
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', 'Formatting');

  const buttons: Array<{ btn: HTMLButtonElement; action: EditorAction }> = [];
  const cleanups: Array<() => void> = [];

  GROUPS.forEach((group, gi) => {
    if (gi > 0) {
      const sep = document.createElement('span');
      sep.className = 'rich-editor__toolbar-sep';
      sep.setAttribute('aria-hidden', 'true');
      el.append(sep);
    }
    for (const b of group) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rich-editor__tool';
      btn.dataset.action = b.action;
      btn.title = b.title;
      btn.setAttribute('aria-label', b.title);
      btn.textContent = b.label;
      // Mouse-only tool: stay out of the keyboard tab order so Tab moves
      // straight from title to description body, not through every button.
      btn.tabIndex = -1;
      // Keep the editor's selection/focus — a toolbar click must not blur it.
      const onMouseDown = (e: MouseEvent): void => e.preventDefault();
      const onClick = (): void => {
        engine.exec(b.action);
        refresh();
      };
      btn.addEventListener('mousedown', onMouseDown);
      btn.addEventListener('click', onClick);
      cleanups.push(() => {
        btn.removeEventListener('mousedown', onMouseDown);
        btn.removeEventListener('click', onClick);
      });
      el.append(btn);
      buttons.push({ btn, action: b.action });
    }
  });

  function refresh(): void {
    for (const { btn, action } of buttons) {
      const active = engine.isActive(action);
      btn.classList.toggle('rich-editor__tool--active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.disabled = !engine.can(action);
    }
  }

  refresh();
  return {
    el,
    refresh,
    destroy(): void {
      for (const c of cleanups) c();
      el.remove();
    },
  };
}
