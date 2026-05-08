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

import { untrack } from 'svelte';

import type { Predicate } from '../filter/predicate';

/**
 * One cache key. We embed projectId because the same screen scope
 * (e.g. 'kanban') can be visited in different project contexts and we
 * don't want a Project A filter to bleed into Project B.
 *
 * `projectId === null` means "no project scope" — Inbox in 'all'
 * view, or Grid loaded without `:id`. Keep it as a distinct key from
 * any numeric id.
 */
function makeKey(scope: string, projectId: number | null | undefined): string {
  return `${scope}:${projectId ?? '_none_'}`;
}

class FilterCache {
  /**
   * Plain Record so reads via property access participate in Svelte's
   * fine-grained reactivity. Writes go through `set` / `clear` to
   * keep the API consistent.
   */
  byKey = $state<Record<string, Predicate | null>>({});
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
  projectId: number | null | undefined,
): Predicate | null {
  return cache.byKey[makeKey(scope, projectId)] ?? null;
}

/**
 * Persist `predicate` for `(scope, projectId)`. A `null` predicate
 * clears the entry rather than storing a literal null — keeps the
 * map small and lets `getFilter` distinguish "cleared" from "never
 * touched" identically (both return null).
 */
export function setFilter(
  scope: string,
  projectId: number | null | undefined,
  predicate: Predicate | null,
): void {
  const k = makeKey(scope, projectId);
  // Read inside untrack so callers running in a $effect aren't
  // re-triggered by the subsequent write — cache.byKey is both read
  // (the spread) and written here, which without untrack creates an
  // effect_update_depth_exceeded loop.
  untrack(() => {
    if (predicate === null) {
      if (k in cache.byKey) {
        const next = { ...cache.byKey };
        delete next[k];
        cache.byKey = next;
      }
      return;
    }
    cache.byKey = { ...cache.byKey, [k]: predicate };
  });
}

/** Drop every cached predicate. Test-only; call sites in app code
 *  should narrow with setFilter(..., null) instead. */
export function clearAllFilters(): void {
  cache.byKey = {};
}
