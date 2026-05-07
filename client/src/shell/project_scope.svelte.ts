/**
 * Persistent project context.
 *
 * The user picks one project (or "All projects") via the sidebar's
 * `<ProjectSelector>`; that choice scopes the Inbox / Grid / Kanban
 * server queries until they pick something else. The selection survives
 * a tab refresh via `sessionStorage` (deliberately session-scoped — a
 * fresh window starts in the All projects view so a deep link doesn't
 * silently smuggle a stale scope onto the next person at the keyboard).
 *
 * Screens read `projectScope.projectId`; admin handlers (e.g. add
 * milestone) read it via `currentProjectId()` so insertions end up
 * parented under whichever project the user is sitting in.
 */

const STORAGE_KEY = 'kitp.projectScope.id';

function readInitial(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) return n;
  } catch {
    /* sessionStorage may be unavailable (private mode quirks) — treat as "All". */
  }
  return null;
}

function persist(value: number | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value === null) {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(STORAGE_KEY, String(value));
    }
  } catch {
    /* ignore quota / unavailable */
  }
}

class ProjectScope {
  /** Current scope: a project card id, or `null` for "All projects". */
  projectId = $state<number | null>(readInitial());

  setProject(id: number | null): void {
    this.projectId = id;
    persist(id);
  }
}

export const projectScope = new ProjectScope();

/**
 * Read the current scope without taking a reactive dependency. Use this
 * inside imperative handlers (e.g. admin "add milestone") that need to
 * read the scope at call time, not subscribe to it.
 */
export function currentProjectId(): number | null {
  return projectScope.projectId;
}
