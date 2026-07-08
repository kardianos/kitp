// Parent/child relation indicator — a small leading symbol on list/grid rows
// that marks a task as a CHILD of another task and encodes the relationship
// TYPE by shape (so the relation reads without color):
//
//   subtask → corner-down-right   (nested under a parent)
//   blocker → ban                 (this task blocks its parent)
//   related → link                (loosely linked to its parent)
//
// A "child" is any task carrying the `parent_task` card_ref attribute; the
// `parent_relationship` text annotation (subtask | blocker | related) picks
// the glyph and defaults to 'subtask' — matching `card_insert_batch`'s default
// and the RelatedTasksPanel. Tasks with no `parent_task` (and every non-task
// card) return null, so callers render nothing extra.

import { icon, type IconName } from './icons.js';
import type { CardWithAttrs } from '../kanban/kanban-helpers.js';

/** Glyph + accessible label per recognised relationship. */
const RELATION: Record<string, { icon: IconName; label: string }> = {
  subtask: { icon: 'corner-down-right', label: 'Sub-task' },
  blocker: { icon: 'ban', label: 'Blocker' },
  related: { icon: 'link', label: 'Related' },
};

const DEFAULT_RELATION = 'subtask';

/** True when the card is a child task (carries a `parent_task` ref). */
export function isChildTask(card: CardWithAttrs): boolean {
  const p = card.attributes['parent_task'];
  return p !== undefined && p !== null;
}

/**
 * Build the leading relation indicator for a child task, or null when the card
 * has no `parent_task` (standalone task / non-task). The relationship type is
 * read from `parent_relationship` (default 'subtask'); an unrecognised value
 * falls back to the sub-task glyph but keeps the raw text in the tooltip.
 */
export function relationIcon(card: CardWithAttrs, size = 14): HTMLElement | null {
  if (!isChildTask(card)) return null;

  const raw = card.attributes['parent_relationship'];
  const rel = typeof raw === 'string' && raw !== '' ? raw : DEFAULT_RELATION;
  const spec = RELATION[rel] ?? RELATION[DEFAULT_RELATION];
  const label =
    RELATION[rel] !== undefined ? spec.label : rel.charAt(0).toUpperCase() + rel.slice(1);

  const span = document.createElement('span');
  span.className = 'relation-ind';
  span.dataset.relation = rel;
  span.title = label;
  span.setAttribute('aria-label', label);
  span.append(icon(spec.icon, size));
  return span;
}
