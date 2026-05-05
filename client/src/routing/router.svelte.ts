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
  return window.location.pathname || '/';
}

/**
 * Reactive path holder. Importers read `routerState.path` (rune-tracked).
 * The class wrapper lets us export a single instance + clear methods.
 */
class RouterState {
  path = $state<string>(readInitialPath());

  /** Currently matched route (or null if 404). */
  get match(): RouteMatch | null {
    return matchRoute(this.path);
  }
}

export const routerState = new RouterState();

/** Replace `currentPath` from the live URL. Used by `popstate`. */
function syncFromLocation(): void {
  if (typeof window === 'undefined') return;
  routerState.path = window.location.pathname || '/';
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
  if (path === window.location.pathname) {
    // Same page; still ensure rune fires (defensive — it should be
    // identity-equal already, so no-op is fine).
    return;
  }
  if (opts?.replace === true) {
    window.history.replaceState({}, '', path);
  } else {
    window.history.pushState({}, '', path);
  }
  routerState.path = path;
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
 * Usage: `<a href="/inbox" use:linkAction>Inbox</a>`
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
