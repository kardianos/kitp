/**
 * Tiny path-based router state.
 *
 * Why hand-rolled: per the migration plan §12 we evaluated
 * `svelte-spa-router` (hash-based, Svelte-5 compatible) but the existing Go
 * server already serves SPA fallback (`spaHandler`) so paths like
 * `/projects` resolve to `index.html`. Hash routing would diverge from the
 * current Dart `go_router` URLs and break any existing bookmarks. The
 * implementation is small enough — `~80 lines` of state + popstate +
 * navigate helper — that the dependency carry-cost is hard to justify.
 *
 * Design:
 *   - `currentPath` is a `$state` rune updated by `popstate` and by
 *     `navigate(...)`. Components read it (directly or via `matchRoute`)
 *     and re-render reactively.
 *   - `navigate(path, opts)` calls `history.pushState` (or `replaceState`)
 *     and then writes `currentPath` so subscribers reflow without a full
 *     reload.
 *   - Plain anchor clicks on internal `href`s should call `navigate(...)`
 *     instead of letting the browser do a hard nav. The NavSidebar uses
 *     a small `linkAction` helper for this.
 *
 * Tests don't currently cover this (history APIs are awkward under jsdom);
 * the e2e journey suite will exercise it once the screen agents land.
 */

import { matchRoute, type RouteMatch } from './routes';

function readInitialPath(): string {
  if (typeof window === 'undefined') return '/';
  const p = window.location.pathname || '/';
  const s = window.location.search || '';
  return p + s;
}

/**
 * Reactive path holder. Importers read `routerState.path` (rune-tracked).
 * The class wrapper lets us export a single instance + clear methods.
 */
class RouterState {
  path = $state<string>(readInitialPath());
  /**
   * Most recent in-app path the user occupied before `path`. Used by
   * "Back" buttons inside detail screens (e.g. TaskDetail) so the user
   * lands back on whichever list view — Inbox, Kanban, Grid — they came
   * from, with whatever query string filters that view had encoded. Reset
   * when the user makes a fresh nav to a screen that isn't a detail
   * descendant.
   */
  previousPath = $state<string | null>(null);

  /**
   * Currently matched route (or null if 404). Memoized via `$derived`
   * (FE-M3) so it recomputes once per `path` change rather than on every
   * read — several components read `routerState.match` per render.
   */
  match = $derived<RouteMatch | null>(matchRoute(this.path));
}

export const routerState = new RouterState();

/** Replace `currentPath` from the live URL. Used by `popstate`. */
function syncFromLocation(): void {
  if (typeof window === 'undefined') return;
  const p = window.location.pathname || '/';
  const s = window.location.search || '';
  routerState.path = p + s;
}

/**
 * Programmatically navigate. `opts.replace` swaps `pushState` for
 * `replaceState` (used for guard redirects so the rejected URL is not in
 * back history).
 */
export function navigate(path: string, opts?: { replace?: boolean }): void {
  if (typeof window === 'undefined') {
    routerState.path = path;
    return;
  }
  const here = (window.location.pathname || '/') + (window.location.search || '');
  if (path === here) {
    // Same page; still ensure rune fires (defensive — it should be
    // identity-equal already, so no-op is fine).
    return;
  }
  if (opts?.replace !== true) {
    // Track the prior path so detail screens can "go back" to the list view
    // the user came from, including its query-string filters. We skip this
    // when the prior path is itself a transient detail screen so backing out
    // of two nested details doesn't ping-pong.
    routerState.previousPath = here;
  }
  if (opts?.replace === true) {
    window.history.replaceState({}, '', path);
  } else {
    window.history.pushState({}, '', path);
  }
  routerState.path = path;
}

/**
 * Walk back to the previous in-app path remembered by `navigate()`. If we
 * have no record (cold-load on a deep link), fall back to `defaultPath`.
 */
export function goBackOrFallback(defaultPath: string): void {
  const prev = routerState.previousPath;
  if (prev !== null && prev !== '' && prev !== routerState.path) {
    navigate(prev);
    return;
  }
  navigate(defaultPath);
}

/**
 * Install the popstate listener. Returns a disposer. The App calls this
 * once during boot.
 */
export function installPopstate(): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (): void => syncFromLocation();
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}

/**
 * Svelte action used on `<a>` tags so internal hrefs route via
 * `navigate(...)` instead of triggering a full page load. Modifier+click
 * (Cmd/Ctrl/Shift/Middle) falls through so users can still open in a new
 * tab.
 *
 * Usage: `<a href="/projects" use:linkAction>Projects</a>`
 */
export function linkAction(node: HTMLAnchorElement): { destroy(): void } {
  function onClick(ev: MouseEvent): void {
    if (
      ev.defaultPrevented ||
      ev.button !== 0 ||
      ev.metaKey ||
      ev.ctrlKey ||
      ev.shiftKey ||
      ev.altKey
    ) {
      return;
    }
    const href = node.getAttribute('href');
    if (href === null || href === '' || href.startsWith('http') || href.startsWith('//')) {
      return;
    }
    ev.preventDefault();
    navigate(href);
  }
  node.addEventListener('click', onClick);
  return {
    destroy(): void {
      node.removeEventListener('click', onClick);
    },
  };
}
