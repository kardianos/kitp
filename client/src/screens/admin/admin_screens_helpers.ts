/**
 * Pure helpers for `AdminScreensScreen`. Extracted as a TypeScript module
 * so they can be unit-tested without a Svelte component-mount runtime
 * (vitest is node-only here).
 *
 *   - `missingScreenTypes`    order-preserving set difference for the
 *                             "+ Add screen" combobox.
 *   - `sortBySortOrder`    sort_order ASC, NULLS LAST, ties by id ASC.
 *   - `validatePredicateJson` decode JSON typed into "Edit predicate";
 *                             empty/whitespace means "no predicate".
 *   - `friendlyScreenLabel`   `multi_word_thing` → `Multi word thing`.
 */

import { predicateFromJson, type Predicate } from '../../filter/predicate.js';
import { readScreenType, type ScreenType } from '../../filter/screen_preset.svelte.js';
import type { CardWithAttrs } from '../../reg/types.js';

/** Subset of `all` not present in `screens`, in `all`-order. */
export function missingScreenTypes(
  screens: readonly CardWithAttrs[],
  all: readonly ScreenType[],
): ScreenType[] {
  const present = new Set<string>();
  for (const s of screens) {
    const t = readScreenType(s);
    if (t !== null) present.add(t);
  }
  return all.filter((t) => !present.has(t));
}

/** Coerce `sort_order` to a finite number, or null (sorts last). */
function readSortOrder(card: CardWithAttrs): number | null {
  const v = card.attributes['sort_order'];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  return null;
}

/** Stable sort by sort_order ASC (NULLS LAST), ties by id ASC. Fresh array. */
export function sortBySortOrder(
  screens: readonly CardWithAttrs[],
): CardWithAttrs[] {
  const out = screens.slice();
  out.sort((a, b) => {
    const sa = readSortOrder(a);
    const sb = readSortOrder(b);
    if (sa !== null && sb !== null) {
      if (sa !== sb) return sa - sb;
    } else if (sa !== null) return -1;
    else if (sb !== null) return 1;
    // bigint can't go through `-`; compare directly.
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  return out;
}

/**
 * Parse a predicate-JSON string. Empty / whitespace-only is valid and
 * means "no predicate" (`{ ok: true, predicate: null }`). Invalid JSON
 * or a bad predicate shape returns `{ ok: false, error }`.
 */
export function validatePredicateJson(
  raw: string,
):
  | { ok: true; predicate: Predicate | null }
  | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, predicate: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${errMsg(e)}` };
  }
  try {
    return { ok: true, predicate: predicateFromJson(parsed) };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/** Coerce a thrown value to a string for toast messages. Shared with
 *  AdminScreensScreen so both surfaces format error toasts the same way. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Capitalise + underscore-to-space (`pair` → `Pair`, `multi_word` → `Multi word`). */
export function friendlyScreenLabel(screenType: string): string {
  if (screenType === '') return '';
  const spaced = screenType.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
