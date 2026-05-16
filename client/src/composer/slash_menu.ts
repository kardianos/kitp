/**
 * Slash-menu item registry for the Milkdown composer.
 *
 * Each item declares a `match` substring used for filtering after the
 * "/" trigger, a `label` shown in the menu, and an `apply` function
 * that runs once selected. The apply function uses Milkdown's
 * `callCommand` macro for built-in commands and `insert` for arbitrary
 * markdown snippets. All commands come from the commonmark and gfm
 * presets, which the composer already loads.
 */

import type { Ctx } from '@milkdown/ctx';
import { callCommand, insert } from '@milkdown/utils';
import {
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
  createCodeBlockCommand,
} from '@milkdown/preset-commonmark';
import { insertTableCommand } from '@milkdown/preset-gfm';

/** One row in the slash menu. */
export interface SlashItem {
  /** Stable id (used for keys + tests). */
  id: string;
  /** Display label. */
  label: string;
  /** Secondary text shown next to the label (the markdown shape). */
  hint: string;
  /** Substring matchers — typing any of these after "/" surfaces the item. */
  match: readonly string[];
  /** Action to run on selection. */
  apply: (ctx: Ctx) => void;
}

export const SLASH_ITEMS: readonly SlashItem[] = [
  {
    id: 'h1',
    label: 'Heading 1',
    hint: '#',
    match: ['h1', 'heading', 'title'],
    apply: (ctx) => callCommand(wrapInHeadingCommand.key, 1)(ctx),
  },
  {
    id: 'h2',
    label: 'Heading 2',
    hint: '##',
    match: ['h2', 'heading', 'subtitle'],
    apply: (ctx) => callCommand(wrapInHeadingCommand.key, 2)(ctx),
  },
  {
    id: 'h3',
    label: 'Heading 3',
    hint: '###',
    match: ['h3', 'heading'],
    apply: (ctx) => callCommand(wrapInHeadingCommand.key, 3)(ctx),
  },
  {
    id: 'bullets',
    label: 'Bulleted list',
    hint: '- item',
    match: ['list', 'bullet', 'ul'],
    apply: (ctx) => callCommand(wrapInBulletListCommand.key)(ctx),
  },
  {
    id: 'numbered',
    label: 'Numbered list',
    hint: '1. item',
    match: ['ordered', 'numbered', 'ol'],
    apply: (ctx) => callCommand(wrapInOrderedListCommand.key)(ctx),
  },
  {
    id: 'quote',
    label: 'Quote',
    hint: '> …',
    match: ['quote', 'blockquote'],
    apply: (ctx) => callCommand(wrapInBlockquoteCommand.key)(ctx),
  },
  {
    id: 'code',
    label: 'Code block',
    hint: '```',
    match: ['code', 'pre'],
    apply: (ctx) => callCommand(createCodeBlockCommand.key)(ctx),
  },
  {
    id: 'table',
    label: 'Table',
    hint: '3×3',
    match: ['table', 'grid'],
    apply: (ctx) =>
      callCommand(insertTableCommand.key, { row: 3, col: 3 })(ctx),
  },
  {
    id: 'hr',
    label: 'Divider',
    hint: '---',
    match: ['hr', 'divider', 'rule'],
    apply: (ctx) => insert('\n---\n')(ctx),
  },
];

/**
 * Return items whose label/match list contains every word of [query]
 * (case-insensitive). Empty query returns the full list. Used by the
 * slash menu to filter as the user types after "/".
 */
export function filterSlashItems(query: string): readonly SlashItem[] {
  const q = query.trim().toLowerCase();
  if (q === '') return SLASH_ITEMS;
  const words = q.split(/\s+/);
  return SLASH_ITEMS.filter((it) => {
    const hay = (it.label + ' ' + it.match.join(' ')).toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
