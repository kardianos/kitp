/**
 * Shared "current ordered list of task IDs" the TaskDetailScreen uses to
 * power its prev/next navigation (header chevrons + j/k/[/] shortcuts).
 *
 * Each list screen (Inbox, Grid, ProjectDetail, Kanban) calls
 * {@link setTaskNavList} just before invoking `navigate(`/task/${id}`)`.
 * The store records the ordered ids the user is currently looking at —
 * already filtered, already sorted by the screen's rules — and the
 * detail screen finds its own `taskId` in that list to compute
 * neighbours.
 *
 * Why a module-scoped rune store rather than a route param / query
 * string: the full ordered list can be hundreds of items, which would
 * blow the URL up and survive copy-paste in unhelpful ways. The store
 * lives in memory, scoped to the SPA session, which exactly matches
 * what we want — paste a /task/123 link into a new tab and you just
 * land on the detail with the chevrons hidden (no list to flip
 * through).
 *
 * The store does not persist across hard reloads, navigation back to a
 * list (which overwrites it next time the list mounts), or browser tab
 * close. That's intentional — the source of truth is whichever list
 * screen the user is actively flipping out of.
 */

import type { ID } from '../reg/types';

class TaskNavList {
  /** Ordered task ids, in the same order the source screen rendered them. */
  ids = $state<ID[]>([]);
  /** Human label for the source ("Inbox", "Kanban: Doing", "Project: Foo").
   *  Surfaced as the chevrons' tooltip so the user knows what list they're
   *  walking through. */
  label = $state<string>('');
}

export const taskNavList = new TaskNavList();

/**
 * Replace the nav list. Call this right before `navigate(`/task/${id}`)`
 * — the detail screen reads from the same module instance and matches
 * its own `taskId` against `ids[]`.
 */
export function setTaskNavList(args: {
  label: string;
  ids: readonly ID[];
}): void {
  taskNavList.label = args.label;
  taskNavList.ids = args.ids.slice();
}

/** Drop the nav list (used by tests; not invoked from app code). */
export function clearTaskNavList(): void {
  taskNavList.label = '';
  taskNavList.ids = [];
}
