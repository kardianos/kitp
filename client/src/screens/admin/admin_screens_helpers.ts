/**
 * Pure helpers for `AdminScreensScreen`. Extracted as a TypeScript module
 * so they can be unit-tested without a Svelte component-mount runtime
 * (vitest is node-only here).
 *
 *   - `missingLayouts`        order-preserving set difference for the
 *                             "+ Add screen" combobox.
 *   - `sortBySortOrder`    sort_order ASC, NULLS LAST, ties by id ASC.
 *   - `validatePredicateJson` decode JSON typed into "Edit predicate";
 *                             empty/whitespace means "no predicate".
 *   - `friendlyScreenLabel`   `multi_word_thing` → `Multi word thing`.
 */

import { predicateFromJson, type Predicate } from '../../filter/predicate.js';
import { readLayout, type Layout } from '../../filter/screen_preset.svelte.js';
import type { CardWithAttrs } from '../../reg/types.js';

/** Subset of `all` not present in `screens`, in `all`-order. */
export function missingLayouts(
  screens: readonly CardWithAttrs[],
  all: readonly Layout[],
): Layout[] {
  const present = new Set<string>();
  for (const s of screens) {
    const t = readLayout(s);
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

/**
 * Pick a slug that doesn't collide with any in `taken`. If `base` is
 * free, returns it; otherwise appends `-2`, `-3`, … until a free slot
 * is found. Two `grid` screens get `grid` + `grid-2`; a third becomes
 * `grid-3`. ScreenHost resolves by slug via `find(r => readSlug(r) ===
 * wanted)`, so unique slugs are the prerequisite for >1 screen per
 * layout to be addressable.
 */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Extremely unlikely fallback; keeps the function total.
  return `${base}-${Date.now()}`;
}

/** Capitalise + underscore-to-space (`pair` → `Pair`, `multi_word` → `Multi word`). */
export function friendlyScreenLabel(screenType: string): string {
  if (screenType === '') return '';
  const spaced = screenType.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The slug becomes a URL path segment (`/project/:id/screen/<slug>`), so
 * restrict to characters that don't need percent-encoding: lowercase
 * a-z, digits, `-`, `_`. Empty is rejected. Must not start with a digit
 * to avoid colliding with future numeric route segments.
 *
 * Returns `{ ok: true }` on success, `{ ok: false, error }` otherwise.
 */
export function validateScreenSlug(
  raw: string,
): { ok: true } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, error: 'Slug is required.' };
  if (!/^[a-z][a-z0-9_-]*$/.test(trimmed)) {
    return {
      ok: false,
      error: 'Slug: lowercase letters, digits, "-", "_"; must start with a letter.',
    };
  }
  return { ok: true };
}

/**
 * The hotkey is the tail of a `g <key>` chord registered in AppShell.
 * Accept a single printable ASCII key — that's what the chord parser
 * recognises today. Empty is allowed and means "no chord"; the
 * registration loop in AppShell skips screens whose hotkey is null.
 */
export function validateScreenHotkey(
  raw: string,
): { ok: true } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true };
  if (!/^[A-Za-z0-9]$/.test(trimmed)) {
    return {
      ok: false,
      error: 'Hotkey: one letter or digit (or blank to disable).',
    };
  }
  return { ok: true };
}
