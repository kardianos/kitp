/**
 * Per-project predicate-snippet cache.
 *
 * A snippet is a `predicate_snippet` card parented to a project; its
 * `title` is the human label shown in the "Named" filter dropdown, and
 * its `predicate` attribute carries the JSON-encoded {@link Predicate}
 * tree the snippet stands for. Snippet leaves (op="snippet") reference
 * a snippet by card id — when a select hits the server, the predicate
 * tree compiler expands the leaf by fetching that card's predicate
 * inline, with cycle detection.
 *
 * This module holds the client-side cache. One Svelte rune store keyed
 * by `projectId` so every screen mounted under the same project shares
 * one fetch.
 */

import type { Dispatcher } from '../dispatch/dispatcher';
import { cardSelectWithAttributes } from '../reg/handlers';
import type {
  CardSelectWithAttributesInput,
  CardSelectWithAttributesOutput,
  CardWithAttrs,
  ID,
} from '../reg/types';
import { readPredicate } from './screen_preset.svelte';
import { andOf, snippetRef, type Predicate } from './predicate';

/* -------------------------------------------------------------------------- */
/* Cache                                                                      */
/* -------------------------------------------------------------------------- */

/** Sentinel key for "no project scope" (e.g. all-projects views). */
const NO_PROJECT = '_none_';

function keyOf(projectId: ID | null | undefined): string {
  return projectId === null || projectId === undefined
    ? NO_PROJECT
    : projectId.toString();
}

class SnippetStore {
  /** projectId-string → snippet cards, in stable order. */
  byProject = $state<Record<string, CardWithAttrs[]>>({});
  /** projectId-string → in-flight load promise, deduped so concurrent
   *  callers share one fetch. */
  inflight: Record<string, Promise<CardWithAttrs[]>> = {};
}

const store = new SnippetStore();

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read the cached snippets for [projectId]. Returns an empty array when
 * the project hasn't been loaded yet — callers should call
 * {@link loadSnippets} on mount.
 */
export function getCachedSnippets(
  projectId: ID | null | undefined,
): CardWithAttrs[] {
  return store.byProject[keyOf(projectId)] ?? [];
}

/**
 * Fetch the snippet card list for [projectId]. Concurrent callers share
 * one in-flight request. Result is cached; pass `force: true` to bypass
 * the cache and refetch (e.g. after save / delete).
 */
export async function loadSnippets(
  dispatcher: Pick<Dispatcher, 'request'>,
  projectId: ID | null | undefined,
  opts: { force?: boolean } = {},
): Promise<CardWithAttrs[]> {
  const k = keyOf(projectId);
  if (!opts.force && k in store.byProject) {
    return store.byProject[k]!;
  }
  const existing = store.inflight[k];
  if (existing !== undefined && !opts.force) return existing;

  const data: CardSelectWithAttributesInput = {
    cardTypeName: 'predicate_snippet',
    order: [{ field: 'attributes.title', direction: 'ASC' }],
  };
  if (projectId !== null && projectId !== undefined) {
    data.parentCardId = projectId;
  }
  const p = dispatcher
    .request<CardSelectWithAttributesInput, CardSelectWithAttributesOutput>({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data,
    })
    .then((out) => {
      store.byProject = { ...store.byProject, [k]: out.rows };
      return out.rows;
    })
    .finally(() => {
      delete store.inflight[k];
    });
  store.inflight[k] = p;
  return p;
}

/**
 * Drop the cached list for [projectId]. Next {@link loadSnippets} will
 * refetch. Use after `card.insert` / `card.update` / `card.delete` on a
 * snippet so the UI picks up the change without a hard reload.
 */
export function invalidateSnippets(projectId: ID | null | undefined): void {
  const k = keyOf(projectId);
  if (k in store.byProject) {
    const next = { ...store.byProject };
    delete next[k];
    store.byProject = next;
  }
}

/* -------------------------------------------------------------------------- */
/* Attribute accessors                                                        */
/* -------------------------------------------------------------------------- */

/** Title of [snippet] — falls back to `#<id>` when missing. */
export function readSnippetTitle(snippet: CardWithAttrs): string {
  const t = snippet.attributes['title'];
  return typeof t === 'string' && t !== '' ? t : `#${snippet.id}`;
}

/**
 * Decode [snippet]'s `predicate` attribute back into an AST. Uses the
 * shared {@link readPredicate} helper so card-ref revival stays
 * consistent with how filter-card predicates round-trip.
 */
export function readSnippetPredicate(
  snippet: CardWithAttrs,
): Predicate | null {
  return readPredicate(snippet);
}

/* -------------------------------------------------------------------------- */
/* Predicate AST helpers                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Collect the snippet card ids referenced by *top-level* snippet leaves
 * in [p]. Used to drive the "Named" multi-select dropdown's checked
 * state.
 *
 * Snippet leaves buried inside an OR / NOT subtree are intentionally
 * NOT reflected — those are owned by the Advanced editor, not the
 * top-bar dropdown.
 */
export function getSelectedSnippetIds(p: Predicate | null): ID[] {
  if (p === null) return [];
  if (p.kind === 'leaf') {
    return p.op === 'snippet' ? snippetIdOf(p.values) : [];
  }
  if (p.connective === 'and') {
    return p.children.flatMap((c) =>
      c.kind === 'leaf' && c.op === 'snippet' ? snippetIdOf(c.values) : [],
    );
  }
  return [];
}

function snippetIdOf(values: unknown[] | undefined): ID[] {
  const v = values?.[0];
  if (typeof v === 'bigint') return [v];
  return [];
}

/**
 * Replace the top-level snippet leaves of [p] with one leaf per id in
 * [ids]. Non-snippet leaves and nested groups in [p] are preserved.
 *
 * Result shape:
 *   - no leaves at all  → null
 *   - exactly one leaf  → that leaf (no AND wrapper)
 *   - two or more       → AND group
 *
 * If [p] is an OR / NOT subtree (non-AND group), it stays as a single
 * child of the resulting AND alongside the new snippet leaves. That
 * preserves the user's advanced structure when they toggle a snippet
 * from the top bar.
 */
export function setSelectedSnippets(
  p: Predicate | null,
  ids: ID[],
): Predicate | null {
  const kept: Predicate[] = [];
  if (p !== null) {
    if (p.kind === 'leaf') {
      if (p.op !== 'snippet') kept.push(p);
    } else if (p.connective === 'and') {
      for (const c of p.children) {
        if (c.kind === 'leaf' && c.op === 'snippet') continue;
        kept.push(c);
      }
    } else {
      // OR or NOT group — preserve as a single nested child.
      kept.push(p);
    }
  }
  for (const id of ids) kept.push(snippetRef(id));
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0]!;
  return andOf(kept);
}
