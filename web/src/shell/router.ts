/**
 * History-API URL router — the source of truth for what the AppShell outlet
 * renders. Replaces the old `shell.view` signal ('projects'/'board'/'admin:*').
 *
 * Design (one-way, cascade-safe):
 *   - `matchRoute(pathname)` parses `location.pathname` → `{ name, params }`
 *     against a first-match-wins route table. No regex engine — a tiny
 *     segment matcher with `:param` capture, same shape as the Svelte
 *     reference (`client/src/routing/routes.ts`).
 *   - `navigate(path, { replace })` writes `history.pushState` /
 *     `replaceState` AND THEN writes the route into a tree leaf
 *     (`router.route`). It NEVER reads that leaf, so there is no
 *     write-inside-an-effect cascade.
 *   - `installRouter(tree)` wires the `popstate` listener (browser back /
 *     forward) and lands the INITIAL route parsed from the live URL (the
 *     deep-link path). Returns a disposer.
 *   - The AppShell outlet effect READS the `router.route` leaf and derives the
 *     outlet content + scope from it — one-way. The effect never calls
 *     `navigate`; navigation is always an out-of-effect user action (a click,
 *     a hotkey, a popstate event).
 *
 * The Go server already serves SPA fallback, so clean paths like `/projects`
 * and `/project/42/screen/grid` resolve to index.html and deep-link directly.
 *
 * Guards:
 *   - `requireAuth` is HANDLED by the API SSO-bounce: a 401 (or auth 403) on
 *     any batch request bounces the whole page to the OIDC start endpoint (see
 *     main.ts `bounceToSso`). So the route-level auth guard is a pass-through
 *     here — there is no separate client auth fetch to gate on.
 *   - `requireAdmin` gates `/admin/*` on the landed `auth.user` identity (the
 *     boot `/api/v1/auth/me` probe lands `auth.user.isAdmin`). A non-admin is
 *     redirected to `/projects`; an admin (or an as-yet-unresolved identity, so
 *     a cold deep-link to `/admin/*` isn't bounced before the probe lands) is
 *     admitted. The server STILL enforces — this is a UI affordance gate that
 *     keeps non-admins out of the admin rail/routes; an admin read a caller
 *     can't make returns 403 → the centralized fault funnel surfaces it.
 */

import type { TreeNode } from '../core/tree.js';
import { AUTH_USER_PATH, peekIsAdmin, peekHasRole, type AuthUser } from '../auth/auth-state.js';

/** Where the parsed current route lives in the data tree. */
export const ROUTER_PATH = ['router', 'route'] as const;

/** The set of matched route names the AppShell outlet derives from. */
export type RouteName =
  | 'projects'
  | 'project'
  | 'screen'
  | 'task'
  | 'activity'
  | 'account'
  | 'admin'
  | 'notfound';

/** A parsed route: the matched name + its captured path params. */
export interface RouteMatch {
  name: RouteName;
  /** Captured `:param` segments (decoded). e.g. { id: '42', slug: 'grid' }. */
  params: Record<string, string>;
  /** The pathname this match was parsed from (for round-trip / debugging). */
  path: string;
}

/* -------------------------------------------------------------------------- */
/* Route table — first match wins. `:name` segments capture into params.       */
/* -------------------------------------------------------------------------- */

interface RoutePattern {
  /** Path template, e.g. `/project/:id/screen/:slug`. */
  pattern: string;
  name: RouteName;
  /** Guard seam — applied by `routeGuard`. `requireAuth` is a pass-through
   *  (the SSO bounce handles it); `requireAdmin` is a SEAM (see routeGuard). */
  guard?: 'requireAuth' | 'requireAdmin';
}

/**
 * The route table. Order matters (first match wins): the two-segment
 * `/project/:id` sits BEFORE `/project/:id/screen/:slug` only because the
 * matcher requires an exact segment-count match, so the order is actually
 * not load-bearing here — but we keep the more-specific routes grouped for
 * readability.
 */
const ROUTES: readonly RoutePattern[] = [
  { pattern: '/', name: 'projects', guard: 'requireAuth' },
  { pattern: '/projects', name: 'projects', guard: 'requireAuth' },
  { pattern: '/project/:id', name: 'project', guard: 'requireAuth' },
  { pattern: '/project/:id/screen/:slug', name: 'screen', guard: 'requireAuth' },
  { pattern: '/task/:id', name: 'task', guard: 'requireAuth' },
  { pattern: '/activity', name: 'activity', guard: 'requireAuth' },
  { pattern: '/account', name: 'account', guard: 'requireAuth' },
  { pattern: '/admin/:key', name: 'admin', guard: 'requireAdmin' },
];

/** `/activity` — the active-project activity feed. */
export function activityUrl(): string {
  return '/activity';
}

// (No screenLayoutForSlug seam: a screen's layout is resolved from its `screen`
//  card by the ScreenHost — no slug is mapped to a layout. The help overlay
//  reads the resolved layout from the `screen.layout` leaf the host publishes.)

/**
 * The embedded-help TOPIC key for a route — what `help.get_topic` looks up to
 * render the screen's authored prose in the help overlay. Maps to the server's
 * `topicFiles` keys (see server/internal/dom/help):
 *   - task                  → `task_detail`
 *   - admin/:key            → `admin.<key>`
 *   - project/:id/screen/:slug → `layout.<layout>`
 *   - project/:id (default board) → `layout.kanban`
 * null when there's no authored topic (the all-projects landing / not-found),
 * which leaves the overlay showing keybindings only.
 */
export function helpTopicForRoute(route: RouteMatch): string | null {
  switch (route.name) {
    case 'task':
      return 'task_detail';
    case 'admin': {
      const key = route.params['key'];
      return key !== undefined && key !== '' ? `admin.${key}` : null;
    }
    // screen / project: the topic is `layout.<resolved layout>`, but the layout
    // is known only once the screen card resolves — the caller (main.ts) reads
    // the ScreenHost-published `screen.layout` leaf for these routes. Returning
    // null here is just the no-leaf fallback.
    case 'screen':
    case 'project':
      return null;
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Matching.                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Parse a pathname into a route match. First-match wins; an unmatched path
 * resolves to the `notfound` route (never null) so the outlet always has
 * something to render.
 */
export function matchRoute(pathname: string): RouteMatch {
  // Normalise: drop a trailing slash except for the bare root, strip query/hash
  // (the matcher works on the pathname only).
  let p = (pathname || '/').split('?')[0]!.split('#')[0]!;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);

  for (const route of ROUTES) {
    const params = matchPattern(route.pattern, p);
    if (params !== null) return { name: route.name, params, path: p };
  }
  return { name: 'notfound', params: {}, path: p };
}

/** The RoutePattern for a matched route name (for guard lookup). */
function routePatternFor(match: RouteMatch): RoutePattern | undefined {
  // We re-match the path to find the pattern; cheap and avoids stashing the
  // pattern on the match. notfound has no pattern.
  if (match.name === 'notfound') return undefined;
  for (const route of ROUTES) {
    if (route.name === match.name && matchPattern(route.pattern, match.path) !== null) {
      return route;
    }
  }
  return undefined;
}

/**
 * Match a single pattern against a pathname. `:name` segments capture into the
 * returned params record (decoded). Returns null on no match.
 */
function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  const patParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patParts.length; i++) {
    const pp = patParts[i]!;
    const pv = pathParts[i]!;
    if (pp.startsWith(':')) {
      params[pp.slice(1)] = decodeURIComponent(pv);
    } else if (pp !== pv) {
      return null;
    }
  }
  return params;
}

/* -------------------------------------------------------------------------- */
/* URL builders — keep path-construction in one place (no string-concat       */
/* sprinkled across controls).                                                  */
/* -------------------------------------------------------------------------- */

/** `/project/:id` — the project landing (default screen). */
export function projectUrl(id: bigint | string): string {
  return `/project/${id.toString()}`;
}

/** `/project/:id/screen/:slug` — an explicit screen under a project. */
export function screenUrl(id: bigint | string, slug: string): string {
  return `/project/${id.toString()}/screen/${slug}`;
}

/** `/task/:id` — a task-detail screen. */
export function taskUrl(id: bigint | string): string {
  return `/task/${id.toString()}`;
}

/** `/admin/:key` — an admin MasterDetail screen. */
export function adminUrl(key: string): string {
  return `/admin/${key}`;
}

/* -------------------------------------------------------------------------- */
/* Guards.                                                                      */
/* -------------------------------------------------------------------------- */

export type GuardResult = { ok: true } | { ok: false; redirectTo: string };

/**
 * Apply the matched route's guard.
 *
 *   - requireAuth → PASS-THROUGH. The API SSO-bounce (401/403 → full-page
 *     redirect to the OIDC start endpoint, see main.ts) is the real auth gate;
 *     there is no separate client auth state to test, so this guard always
 *     admits and lets the screen's first batch read trigger the bounce if the
 *     session is gone.
 *
 *   - requireAdmin → gate on the landed `auth.user` identity. A NON-admin is
 *     redirected to `/projects`. An admin — OR an as-yet-unresolved identity
 *     (null userId, before the boot `/auth/me` probe lands) — is admitted so a
 *     cold deep-link to `/admin/*` isn't bounced in the brief window before the
 *     probe resolves; the probe then re-evaluates on the next route landing,
 *     and the server enforces regardless. The admin status is peeked from the
 *     router's bound tree (set by `installRouter`).
 */
export function routeGuard(match: RouteMatch): GuardResult {
  const route = routePatternFor(match);
  switch (route?.guard) {
    case 'requireAuth':
      // Pass-through: the SSO bounce handles unauthenticated access.
      return { ok: true };
    case 'requireAdmin': {
      if (routerTree === null) return { ok: true }; // no tree bound (early test) → admit
      const user = routerTree.at([...AUTH_USER_PATH]).peek<AuthUser | undefined>();
      // Unresolved identity (boot probe not landed yet) → admit; once it lands,
      // a non-admin is redirected away on the next route landing.
      if (user === undefined || user.userId === null) return { ok: true };
      if (peekIsAdmin(routerTree)) return { ok: true };
      // A (project-scoped) manager may reach the manager-permitted admin keys
      // (e.g. 'enums' / Manage values). The set is supplied by installRouter so
      // the router stays generic; the backend enforces the per-project scope.
      const key = match.params['key'];
      if (key !== undefined && managerAdminKeys.has(key) && peekHasRole(routerTree, 'manager')) {
        return { ok: true };
      }
      return { ok: false, redirectTo: '/projects' };
    }
    default:
      return { ok: true };
  }
}

/* -------------------------------------------------------------------------- */
/* Navigation + history.                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The tree the router writes the parsed route into. Set by `installRouter`;
 * `navigate` writes `tree.at(ROUTER_PATH)`. Held module-level so the rail
 * links / project selection can call the bare `navigate(path)` without
 * threading the tree through every call site.
 */
let routerTree: TreeNode | null = null;

/** Admin route keys (`/admin/:key`) a manager may also reach. Supplied by
 *  installRouter; the requireAdmin guard consults it. Empty until installed. */
let managerAdminKeys: ReadonlySet<string> = new Set();

/** Read the current route reactively (subscribes the caller's effect). */
export function currentRoute(tree: TreeNode): RouteMatch {
  return (tree.at([...ROUTER_PATH]).get<RouteMatch>() ?? matchRoute(currentPathname()));
}

/** Read the current route without subscribing. */
export function peekRoute(tree: TreeNode): RouteMatch {
  return (tree.at([...ROUTER_PATH]).peek<RouteMatch>() ?? matchRoute(currentPathname()));
}

function currentPathname(): string {
  if (typeof location === 'undefined') return '/';
  return (location.pathname || '/') + (location.search || '');
}

/**
 * Programmatic navigation. Writes history (push or replace) THEN lands the
 * parsed route into the tree leaf the outlet derives from. A one-way write
 * outside any tracked effect — cascade-safe. A no-op when the target equals
 * the current path AND a route is already landed.
 */
export function navigate(path: string, opts?: { replace?: boolean }): void {
  const match = matchRoute(path);
  if (routerTree) {
    const node = routerTree.at([...ROUTER_PATH]);
    const cur = node.peek<RouteMatch>();
    // Object.is on the leaf won't catch this (fresh object each time); guard on
    // a value-equal route so a redundant navigate is a true no-op.
    if (cur && sameRoute(cur, match) && samePath(path)) return;
  }
  if (typeof history !== 'undefined') {
    const state = { path };
    if (opts?.replace === true) history.replaceState(state, '', path);
    else history.pushState(state, '', path);
  }
  landRoute(match);
}

/**
 * Land a parsed route into the tree (the single write the outlet watches),
 * AFTER applying the route's guard. A guard that rejects (e.g. a non-admin
 * hitting `/admin/*`) redirects: we rewrite history to the guard's target and
 * land THAT route instead, so the outlet never paints the forbidden screen.
 * Covers every entry point (navigate / popstate / installRouter deep-link).
 */
function landRoute(match: RouteMatch): void {
  if (!routerTree) return;
  const guard = routeGuard(match);
  if (!guard.ok) {
    const target = matchRoute(guard.redirectTo);
    if (typeof history !== 'undefined') {
      history.replaceState({ path: target.path }, '', guard.redirectTo);
    }
    routerTree.at([...ROUTER_PATH]).set(target);
    return;
  }
  routerTree.at([...ROUTER_PATH]).set(match);
}

function sameRoute(a: RouteMatch, b: RouteMatch): boolean {
  if (a.name !== b.name) return false;
  const ak = Object.keys(a.params);
  const bk = Object.keys(b.params);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a.params[k] !== b.params[k]) return false;
  return true;
}

function samePath(path: string): boolean {
  return matchRoute(path).path === matchRoute(currentPathname()).path;
}

/**
 * Wire the router into a tree: lands the INITIAL route from the live URL (the
 * deep-link), installs the `popstate` listener (back / forward re-parse the
 * URL and re-land the route), and returns a disposer. Idempotent per tree —
 * the last installed tree wins (the app has one).
 */
export function installRouter(
  tree: TreeNode,
  opts?: { managerAdminKeys?: Iterable<string> },
): () => void {
  routerTree = tree;
  managerAdminKeys = new Set(opts?.managerAdminKeys ?? []);
  // Initial route: parse the live URL so a cold deep-link renders the right
  // screen. replaceState seeds history.state without adding an entry.
  const initial = matchRoute(currentPathname());
  if (typeof history !== 'undefined') {
    history.replaceState({ path: initial.path }, '', currentPathname());
  }
  landRoute(initial);

  if (typeof window === 'undefined') {
    return () => {
      routerTree = null;
    };
  }
  const onPopState = (): void => {
    landRoute(matchRoute(currentPathname()));
  };
  window.addEventListener('popstate', onPopState);
  return () => {
    window.removeEventListener('popstate', onPopState);
    routerTree = null;
  };
}

/**
 * TEST SEAM: reset the module-level tree binding. Used by tests that install
 * the router against a fresh tree per case (the app installs exactly once).
 */
export function _resetRouterForTest(): void {
  routerTree = null;
}
