/**
 * Test-only barrel: RichEditor + the ProseMirror engine bundled together so
 * editor-markdown.test.mjs drives one copy of the editor stack. Not imported
 * by the app — main.ts imports the modules directly.
 */

export { RichEditor, setRichEditorEngine } from './rich-editor.js';
export { createProseMirrorEngine } from './pm-engine.js';
