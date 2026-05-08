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
 *     matches and we navigate to `redirectTo`.
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
  /** When set the route redirects to this path immediately on match. */
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
  {
    path: '/auth/callback',
    component: () => import('../screens/AuthCallbackScreen.svelte'),
    shell: false,
    scope: 'global',
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
    path: '/inbox',
    component: () => import('../screens/InboxScreen.svelte'),
    guard: 'requireAuth',
    shell: true,
    scope: 'inbox',
  },
  {
    path: '/grid',
    component: () => import('../screens/GridScreen.svelte'),
    guard: 'requireAuth',
    shell: true,
    scope: 'grid',
  },
  {
    path: '/kanban',
    component: () => import('../screens/KanbanScreen.svelte'),
    guard: 'requireAuth',
    shell: true,
    scope: 'kanban',
  },
  {
    path: '/activity',
    component: () => import('../screens/ActivityScreen.svelte'),
    guard: 'requireAuth',
    shell: true,
    scope: 'activity',
  },
  {
    path: '/project/:id',
    component: () => import('../screens/ProjectDetailScreen.svelte'),
    guard: 'requireAuth',
    shell: true,
    scope: 'project_detail',
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
    path: '/admin/project-types',
    component: () => import('../screens/admin/AdminProjectTypesScreen.svelte'),
    guard: 'requireAdmin',
    shell: true,
    scope: 'admin_project_types',
  },
  {
    path: '/admin/workflows',
    component: () => import('../screens/admin/AdminWorkflowsScreen.svelte'),
    guard: 'requireAdmin',
    shell: true,
    scope: 'admin_workflows',
  },
  {
    path: '/_dev/components',
    component: () => import('../screens/_dev/Components.svelte'),
    shell: false,
    scope: 'global',
  },
];

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
