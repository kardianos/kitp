/**
 * Application route table.
 *
 * The router is a tiny home-grown path-based implementation (see
 * `./router.svelte.ts` and `./Router.svelte`) since the existing Go server
 * already does SPA fallback (`spaHandler` in `server/internal/api/api.go`),
 * meaning paths like `/projects` and `/task/42` work without a hash prefix.
 * This matches what the existing Dart client did with `go_router`.
 *
 * Each `Route` carries:
 *   - `path`: a pattern such as `/task/:id`. Named params are extracted at
 *     match time and passed as props to the screen component.
 *   - `component`: a dynamic-import callback returning the screen module.
 *     Stub screens live next to the planned real ones in `src/screens/`.
 *   - `guard`: optional pre-render predicate. When the guard rejects, the
 *     router redirects to the indicated path before rendering.
 *   - `shell`: when true, the matched screen renders inside the AppShell
 *     (sidebar + header + outlet). Standalone screens (Login, Auth callback,
 *     dev component gallery) opt out via `shell: false`.
 *   - `scope`: which keyboard-shortcut scope to switch to when the screen
 *     mounts. Most screens already call `setActiveScope(...)` themselves, but
 *     the route table is the single source of truth used by the router for
 *     redirects.
 *   - `redirectTo`: when set, the route is a pure redirect entry — the path
 *     matches and we navigate to `redirectTo`. The string may include
 *     `:name` segments that interpolate from the matched params (e.g.
 *     `/project/:id` → `/project/:id/screen/project`).
 *
 * Gate 9 (FLOW_AND_SCREEN_KERNEL): per-layout routes (`/inbox`, `/grid`,
 * `/kanban`, `/project/:id`) are removed. Every screen URL is now
 * `/project/:id/screen/:slug`; `<ScreenHost>` resolves the screen card by
 * `(project_id, slug)` and dispatches to the matching body layout.
 * `/project/:id` redirects to `/project/:id/screen/project` so the
 * projects-list click path still lands somewhere sensible.
 */

import type { ShortcutScope } from '../keys/scopes';

/** Result of a dynamic Svelte import — `import('./X.svelte')`. */
// `unknown` here side-steps the typing dance around Svelte's `Component`
// generic; the router treats the value opaquely and hands it off to
// `<svelte:component>`.
export type ScreenModule = { default: unknown };

export interface Route {
  /** Path pattern, e.g. `/task/:id`. */
  path: string;
  /** Dynamic import of the screen component. Optional for redirect entries. */
  component?: () => Promise<ScreenModule>;
  /** Pre-render auth/role gate. */
  guard?: 'requireAuth' | 'requireAdmin' | 'redirectIfSignedIn';
  /** True = render inside AppShell. False = standalone (login, callback). */
  shell?: boolean;
  /** Keyboard shortcut scope this screen activates. */
  scope?: ShortcutScope;
  /**
   * When set the route redirects to this path immediately on match.
   * `:name` segments are interpolated from the matched route params, so
   * `/project/:id` → `/project/:id/screen/project` works without a
   * bespoke handler in Router.svelte.
   */
  redirectTo?: string;
}

export const routes: Route[] = [
  {
    path: '/login',
    component: () => import('../screens/LoginScreen.svelte'),
    guard: 'redirectIfSignedIn',
    shell: false,
    scope: 'login',
  },
  { path: '/', redirectTo: '/projects' },
  {
    path: '/projects',
    component: () => import('../screens/ProjectsScreen.svelte'),
    guard: 'requireAuth',
    shell: true,
    scope: 'projects',
  },
  {
    path: '/activity',
    component: () => import('../screens/ActivityScreen.svelte'),
    guard: 'requireAuth',
    shell: true,
    scope: 'activity',
  },
  // `/project/:id` is no longer a real screen — every screen URL is
  // `/project/:id/screen/:slug`. The projects-list click path still
  // navigates to `/project/:id`; redirect to the project-detail screen
  // (slug=`project`) so the user lands somewhere meaningful.
  {
    path: '/project/:id',
    redirectTo: '/project/:id/screen/project',
  },
  {
    path: '/project/:id/screen/:slug',
    component: () => import('../screens/ScreenHost.svelte'),
    guard: 'requireAuth',
    shell: true,
    scope: 'screen_host',
  },
  {
    path: '/task/:id',
    component: () => import('../screens/TaskDetailScreen.svelte'),
    guard: 'requireAuth',
    shell: true,
    scope: 'task_detail',
  },
  {
    path: '/admin/users',
    component: () => import('../screens/admin/AdminUsersScreen.svelte'),
    guard: 'requireAdmin',
    shell: true,
    scope: 'admin_users',
  },
  {
    path: '/admin/attributes',
    component: () => import('../screens/admin/AdminAttributesScreen.svelte'),
    guard: 'requireAdmin',
    shell: true,
    scope: 'admin_attributes',
  },
  {
    path: '/admin/screens',
    component: () => import('../screens/admin/AdminScreensScreen.svelte'),
    guard: 'requireAdmin',
    shell: true,
    scope: 'admin_screens',
  },
  {
    path: '/admin/agents',
    component: () => import('../screens/admin/AdminAgentsScreen.svelte'),
    // Any signed-in non-agent can own their own agents — the screen lists
    // only the calling user's agents. We still file it under /admin/* in
    // the nav so it sits next to the other infra-management screens.
    guard: 'requireAuth',
    shell: true,
    scope: 'admin_agents',
  },
  {
    path: '/_dev/components',
    component: () => import('../screens/_dev/Components.svelte'),
    shell: false,
    scope: 'global',
  },
];

/**
 * URL helper for screen routes. Every screen lives under a project; this
 * keeps the join in one place so callers don't sprinkle string-concat
 * across the code base. Use everywhere that today builds an old
 * `/inbox` / `/grid` / `/kanban` URL.
 */
export function screenUrl(projectId: bigint | string, slug: string): string {
  return `/project/${projectId.toString()}/screen/${slug}`;
}

/** Match outcome used by the router. */
export interface RouteMatch {
  route: Route;
  params: Record<string, string>;
}

/**
 * Match `pathname` against the route table. First-match wins. Returns null
 * if no route matches (the router treats null as a 404 and renders the
 * NotFound shell screen).
 */
export function matchRoute(pathname: string): RouteMatch | null {
  // Normalise: strip trailing slash except for the bare root.
  let p = pathname || '/';
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);

  for (const route of routes) {
    const params = matchPath(route.path, p);
    if (params !== null) return { route, params };
  }
  return null;
}

/**
 * Interpolate `:name` segments in a path template (typically a
 * `Route.redirectTo`) from a params record. Unknown segments are left
 * untouched so the dev sees the broken URL instead of a silent empty
 * substitution.
 */
export function interpolatePath(
  template: string,
  params: Record<string, string>,
): string {
  return template
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        const name = seg.slice(1);
        const v = params[name];
        return v !== undefined ? encodeURIComponent(v) : seg;
      }
      return seg;
    })
    .join('/');
}

/**
 * Match a single pattern against a pathname. `:name` segments capture into
 * the returned params record. Returns null on no match.
 */
function matchPath(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patParts.length; i++) {
    const pp = patParts[i] as string;
    const pv = pathParts[i] as string;
    if (pp.startsWith(':')) {
      params[pp.slice(1)] = decodeURIComponent(pv);
    } else if (pp !== pv) {
      return null;
    }
  }
  return params;
}
