/**
 * In-memory cache of FilterBar predicates keyed by (screen scope,
 * project id). Lets a list screen (Inbox / Grid / Kanban / Project
 * detail) restore the user's last predicate after they walk into a
 * task detail and back out.
 *
 * Lifetime is the SPA session — values vanish on hard reload. That
 * matches the "outlive the unmount" semantics of the sibling stores
 * `taskNavList` and `projectScope`. When shareable / deep-linkable
 * filters become a feature ask, layer URL serialisation on top: this
 * cache then becomes the fallback for screens loaded without a
 * `?filter=` query parameter.
 *
 * Why it isn't localStorage: a stale-tab problem (user edits the
 * filter on tab A, switches to tab B, sees a divergent state) for
 * limited gain. Reload is rare enough that "filter survives reload"
 * is not a big enough win to justify the complexity.
 */

import type { Predicate } from '../filter/predicate';
import type { ID } from '../reg/types';

/**
 * One cache key. We embed projectId because the same screen scope
 * (e.g. 'kanban') can be visited in different project contexts and we
 * don't want a Project A filter to bleed into Project B.
 *
 * `projectId === null` means "no project scope" — Inbox in 'all'
 * view, or Grid loaded without `:id`. Keep it as a distinct key from
 * any numeric id.
 */
function makeKey(scope: string, projectId: ID | null | undefined): string {
  return `${scope}:${projectId ?? '_none_'}`;
}

class FilterCache {
  /**
   * Plain Record so reads via property access participate in Svelte's
   * fine-grained reactivity. Writes go through `set` / `clear` to
   * keep the API consistent.
   */
  byKey = $state<Record<string, Predicate | null>>({});
  /**
   * Active filter-preset id per (scope, project). `0n` is the sentinel
   * for "user picked No preset" (custom predicate); a missing entry
   * means "untouched — apply the screen's default_filter on next
   * mount". Tracking this separately from `byKey` lets the preset
   * combobox highlight the right row even after the user edits its
   * predicate inline.
   */
  presetByKey = $state<Record<string, ID>>({});
}

const cache = new FilterCache();

/**
 * Look up the cached predicate for `(scope, projectId)`. Returns
 * `null` when no predicate has ever been written for that key (or
 * when the user explicitly cleared it). Callers should use this
 * value verbatim — `null` is a meaningful "no filter" state, not a
 * cache miss.
 */
export function getFilter(
  scope: string,
  projectId: ID | null | undefined,
): Predicate | null {
  return cache.byKey[makeKey(scope, projectId)] ?? null;
}

/**
 * Persist `predicate` for `(scope, projectId)`. Always records an
 * entry (even when null) so callers can tell "user explicitly cleared"
 * apart from "never touched" via {@link hasFilter}.
 */
export function setFilter(
  scope: string,
  projectId: ID | null | undefined,
  predicate: Predicate | null,
): void {
  // Fine-grained per-key write into the `$state` proxy (FE-H2). Mutating
  // one property invalidates only the readers of that key, not every
  // reader of `byKey` — the whole-object reassign this replaced fired
  // every `getFilter`/`hasFilter` subscriber on each write (the same
  // fan-out the registry fixed in cc1cfd1 by switching to splice).
  cache.byKey[makeKey(scope, projectId)] = predicate;
}

/**
 * True iff the cache has any entry (including a null predicate) for
 * (scope, projectId). Screens use this to decide whether to apply the
 * data-side default filter on first mount.
 */
export function hasFilter(
  scope: string,
  projectId: ID | null | undefined,
): boolean {
  return makeKey(scope, projectId) in cache.byKey;
}

/** The id of the active filter preset for (scope, projectId), or null
 *  when no preset is active (custom predicate or untouched). */
export function getActivePreset(
  scope: string,
  projectId: ID | null | undefined,
): ID | null {
  const v = cache.presetByKey[makeKey(scope, projectId)];
  return v === undefined || v === 0n ? null : v;
}

/** Record the active preset id. Pass `null` to mean "no preset"
 *  (e.g. the user edited the predicate manually). */
export function setActivePreset(
  scope: string,
  projectId: ID | null | undefined,
  presetId: ID | null,
): void {
  // Per-key proxy write — see setFilter for the FE-H2 rationale.
  cache.presetByKey[makeKey(scope, projectId)] = presetId ?? 0n;
}

/** Drop every cached predicate. Test-only; call sites in app code
 *  should narrow with setFilter(..., null) instead. */
export function clearAllFilters(): void {
  cache.byKey = {};
  cache.presetByKey = {};
}
