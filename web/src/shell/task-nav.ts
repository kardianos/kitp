/**
 * Task jump-navigation list + source-list URL — the context the task-detail
 * screen needs to (a) walk prev/next (`[`/`]`, `j`/`k`) through the SAME
 * sequence the originating list/grid/kanban showed, and (b) return to that list
 * on `q`/`Esc` / the Back button.
 *
 * A list screen calls {@link publishTaskNav} with its current ordered ids right
 * before it navigates into a task; that ALSO records the screen's own URL (the
 * live `location` at publish time, since the list is the active route). The two
 * live at `nav.taskList` (ids as strings) and `nav.listUrl` (the screen path).
 * TaskDetail reads the neighbor via {@link taskNavNeighbor} and the return
 * target via {@link taskNavListUrl}.
 *
 * Walking task→task (jumpTask) navigates to `/task/:id` but never republishes,
 * so the saved list URL survives a chain of next/prev jumps — `Esc` from the
 * third task still lands back on the list the user opened the first task from. A
 * cold deep-link (no published list) leaves both leaves empty → jump nav is a
 * no-op and Back falls back to the task's project board. Mirrors the Svelte
 * `task_nav_list.svelte.ts`.
 */

import type { TreeNode } from '../core/tree.js';

const NAV_PATH = ['nav', 'taskList'] as const;
const NAV_LIST_URL_PATH = ['nav', 'listUrl'] as const;

/** The live document URL (path + query), or null where there's no `location`. */
function currentListUrl(): string | null {
  if (typeof location === 'undefined') return null;
  return (location.pathname || '/') + (location.search || '');
}

/**
 * Publish the ordered task ids of the current list (called on open) AND the
 * list screen's own URL so the task detail can return to it. `sourceUrl`
 * defaults to the live `location` (correct because the list IS the active route
 * when it publishes); tests pass it explicitly.
 */
export function publishTaskNav(
  tree: TreeNode,
  ids: ReadonlyArray<bigint | string>,
  sourceUrl: string | null = currentListUrl(),
): void {
  tree.at([...NAV_PATH]).set(ids.map((id) => String(id)));
  if (sourceUrl !== null && sourceUrl !== '') {
    tree.at([...NAV_LIST_URL_PATH]).set(sourceUrl);
  }
}

/** The saved source-list URL (inbox/grid/kanban) to return to, or null. */
export function taskNavListUrl(tree: TreeNode): string | null {
  const u = tree.at([...NAV_LIST_URL_PATH]).peek<string>();
  return typeof u === 'string' && u !== '' ? u : null;
}

/**
 * The neighbor task id `dir` steps from `currentId` in the published list, or
 * null when there's no list, the current id isn't in it, or we're at the end.
 */
export function taskNavNeighbor(
  tree: TreeNode,
  currentId: bigint | string,
  dir: -1 | 1,
): string | null {
  const list = (tree.at([...NAV_PATH]).peek<string[]>() ?? []) as string[];
  const i = list.indexOf(String(currentId));
  if (i < 0) return null;
  const j = i + dir;
  return j >= 0 && j < list.length ? (list[j] ?? null) : null;
}
