/**
 * Per-project saved view presets.
 *
 * Each project owns N `screen` cards; each screen owns N `filter` card
 * children. The screen's `default_filter` (card_ref → filter) picks
 * which preset applies on first load.
 *
 * Gate 8 renamed the closed-set attribute from `screen_type` to
 * `layout`. The values are the renderer names the application
 * enforces. The wider screen-card schema also carries `slug`,
 * `hotkey`, `flow_ref`, etc; see docs/FLOW_AND_SCREEN_KERNEL.md. Gate
 * 13 dropped the legacy `SCREEN_TYPES` constant in favour of the
 * `LAYOUTS` slot list below — only the admin CRUD combobox needs the
 * closed set; ScreenHost dispatches on `layout` directly.
 *
 * This module owns the shared fetch + accessor helpers; the UI lives in
 * `FilterPresetSelector.svelte` and is wired into each screen.
 */

import type { Dispatcher } from '../dispatch/dispatcher';
import { cardSelectWithAttributes } from '../reg/handlers';
import type {
  CardSelectWithAttributesInput,
  CardSelectWithAttributesOutput,
  CardWithAttrs,
  ID,
} from '../reg/types';
import { predicateFromJson, type Predicate } from './predicate';

/**
 * Closed set of layouts (renderer names) the app knows about. A row in
 * the `screen` card table whose `layout` is outside this set is
 * silently ignored — the kernel stores text without validation, so the
 * application is the source of truth on what counts.
 */
export type Layout =
  | 'list'
  | 'grid'
  | 'kanban'
  | 'pair';

export const LAYOUTS: readonly Layout[] = [
  'list',
  'grid',
  'kanban',
  'pair',
] as const;

/** Result of {@link loadScreenAndFilters}. */
export interface ScreenPresetSet {
  /** The single screen card for (project, layout), or null when missing. */
  screen: CardWithAttrs | null;
  /** Filter cards parented to that screen, in `sort_order` (then id). */
  filters: CardWithAttrs[];
  /** Filter that `screen.default_filter` points at (when set + present). */
  defaultFilter: CardWithAttrs | null;
}

/**
 * Issue the two batched requests a screen needs to materialise its
 * presets:
 *   1. card.select_with_attributes: card_type='screen', parent=projectId
 *      → pick the one whose `layout` attribute matches.
 *   2. card.select_with_attributes: card_type='filter', parent=<that
 *      screen's id>.
 *
 * Step 2 only fires after step 1 returns; if the project has no screen
 * row for this layout we short-circuit with an empty result.
 */
export async function loadScreenAndFilters(
  dispatcher: Pick<Dispatcher, 'request'>,
  projectId: ID,
  layout: Layout,
): Promise<ScreenPresetSet> {
  const screenOut = await dispatcher.request<
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput
  >({
    endpoint: cardSelectWithAttributes.endpoint,
    action: cardSelectWithAttributes.action,
    data: { cardTypeName: 'screen', parentCardId: projectId },
  });

  const screen =
    screenOut.rows.find(
      (r) => readLayout(r) === layout,
    ) ?? null;
  if (screen === null) {
    return { screen: null, filters: [], defaultFilter: null };
  }

  const filterOut = await dispatcher.request<
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput
  >({
    endpoint: cardSelectWithAttributes.endpoint,
    action: cardSelectWithAttributes.action,
    data: {
      cardTypeName: 'filter',
      parentCardId: screen.id,
      order: [{ field: 'attributes.sort_order', direction: 'ASC' }],
    },
  });

  const filters = filterOut.rows;
  const defaultID = readDefaultFilterID(screen);
  const defaultFilter =
    defaultID === null ? null : (filters.find((f) => f.id === defaultID) ?? null);
  return { screen, filters, defaultFilter };
}

/* -------------------------------------------------------------------------- */
/* Attribute accessors                                                        */
/*                                                                            */
/* Filter cards carry typed attributes; these helpers pull each one with the */
/* right narrowing so screen code doesn't sprinkle `typeof === 'string'`     */
/* checks everywhere.                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Read the `layout` attribute as a string (or null when absent / non-
 * string / empty). Gate 8 renamed the underlying attribute from
 * `screen_type` to `layout`; Gate 13 renamed the helper from
 * `readScreenType` to match.
 */
export function readLayout(card: CardWithAttrs): string | null {
  const v = card.attributes['layout'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Read the `slug` attribute as a string (or null when absent). */
export function readSlug(card: CardWithAttrs): string | null {
  const v = card.attributes['slug'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Read the `hotkey` attribute as a string (or null when absent). */
export function readHotkey(card: CardWithAttrs): string | null {
  const v = card.attributes['hotkey'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function readTitle(card: CardWithAttrs): string {
  const v = card.attributes['title'];
  return typeof v === 'string' && v.length > 0 ? v : `#${card.id}`;
}

export function readDefaultFilterID(screen: CardWithAttrs): ID | null {
  const v = screen.attributes['default_filter'];
  return typeof v === 'bigint' ? v : null;
}

export function readColumnAttr(filter: CardWithAttrs): string | null {
  const v = filter.attributes['column_attr'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function readLaneAttr(filter: CardWithAttrs): string | null {
  const v = filter.attributes['lane_attr'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Decode the filter card's `predicate` attribute into a typed
 * `Predicate | null`. Filter cards store the predicate as a
 * JSON-encoded string (the same shape `predicateToJson` produces on the
 * write side); a missing / empty attribute means "no filter".
 *
 * Invalid JSON or AST shape returns `null` so the screen falls through
 * to the no-filter path instead of throwing.
 *
 * Leaf values are revived for the known card_ref attributes
 * (assignee / milestone_ref / component_ref / tags): the wire encoder
 * (`stringifyBigInt`) ships bigint ids as JSON strings, so on the way
 * back in we restore them to bigints so the FilterBar chip matcher and
 * picker options compare cleanly (their option values are bigints too).
 */
export function readPredicate(filter: CardWithAttrs): Predicate | null {
  const raw = filter.attributes['predicate'];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const decoded = predicateFromJson(JSON.parse(raw));
    return reviveCardRefValues(decoded);
  } catch {
    return null;
  }
}

const CARD_REF_LEAF_ATTRS = new Set(['assignee', 'milestone_ref', 'component_ref']);
const CARD_REF_ARRAY_LEAF_ATTRS = new Set(['tags']);

function reviveCardRefValues(p: Predicate): Predicate {
  if (p.kind === 'group') {
    return { ...p, children: p.children.map(reviveCardRefValues) };
  }
  if (
    p.values !== undefined &&
    (CARD_REF_LEAF_ATTRS.has(p.attr) || CARD_REF_ARRAY_LEAF_ATTRS.has(p.attr))
  ) {
    return { ...p, values: p.values.map(toBigIntIfDigits) };
  }
  return p;
}

function toBigIntIfDigits(v: unknown): unknown {
  if (typeof v === 'string' && /^-?\d+$/.test(v)) {
    try {
      return BigInt(v);
    } catch {
      /* fall through */
    }
  }
  return v;
}
