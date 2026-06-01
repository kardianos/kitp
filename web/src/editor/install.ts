/**
 * Boot side effect: upgrade RichEditor's backend from the textarea fallback to
 * the ProseMirror WYSIWYG engine, app-wide, behind the unchanged public API.
 *
 * Imported once from main.ts (next to the other side-effect registrations). The
 * automated control tests don't import this, so they keep running on the light
 * textarea engine under jsdom; only the real app loads ProseMirror.
 */

import { setRichEditorEngine } from './rich-editor.js';
import { createProseMirrorEngine } from './pm-engine.js';

setRichEditorEngine(createProseMirrorEngine);
