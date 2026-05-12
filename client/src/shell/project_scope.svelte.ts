/**
 * Persistent project context.
 *
 * The user picks one project (or "All projects") via the title-bar
 * `<ProjectTitlePicker>` on each list screen; that choice scopes the
 * Inbox / Grid / Kanban server queries until they pick something else.
 * The selection survives a tab refresh via `sessionStorage`
 * (deliberately session-scoped — a fresh window starts in the All
 * projects view so a deep link doesn't silently smuggle a stale scope
 * onto the next person at the keyboard).
 *
 * Screens read `projectScope.projectId`; admin handlers (e.g. add
 * milestone) read it via `currentProjectId()` so insertions end up
 * parented under whichever project the user is sitting in.
 */

import type { ID } from '../reg/types';

const STORAGE_KEY = 'kitp.projectScope.id';

function readInitial(): ID | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw === null || raw === '') return null;
    const n = BigInt(raw);
    if (n > 0n) return n;
  } catch {
    /* sessionStorage may be unavailable (private mode quirks) — treat as "All". */
  }
  return null;
}

function persist(value: ID | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value === null) {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(STORAGE_KEY, value.toString());
    }
  } catch {
    /* ignore quota / unavailable */
  }
}

class ProjectScope {
  /** Current scope: a project card id, or `null` for "All projects". */
  projectId = $state<ID | null>(readInitial());

  /**
   * Monotonic counter callers bump after a project is created, renamed,
   * or deleted. The title-bar `<ProjectTitlePicker>` watches this and
   * refetches its list. Bumping is intentionally explicit (vs. a
   * server push) because every screen already knows when it has just
   * mutated the project list — coupling it through the cache keeps
   * the wire chatty-but-correct without adding a global event bus.
   */
  projectsVersion = $state(0);

  setProject(id: ID | null): void {
    this.projectId = id;
    persist(id);
  }

  /** Signal that the project list has changed; sidebar will reload. */
  notifyProjectsChanged(): void {
    this.projectsVersion += 1;
  }
}

export const projectScope = new ProjectScope();

/**
 * Read the current scope without taking a reactive dependency. Use this
 * inside imperative handlers (e.g. admin "add milestone") that need to
 * read the scope at call time, not subscribe to it.
 */
export function currentProjectId(): ID | null {
  return projectScope.projectId;
}
