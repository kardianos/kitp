/**
 * Route guards — pure predicates over `AuthState`.
 *
 * Each guard returns either `{ ok: true }` (render the route) or
 * `{ ok: false, redirectTo }` (router navigates and tries again). The
 * Router applies guards on every path change, so an OIDC sign-in flowing
 * back through `/auth/callback` correctly transitions an authed user from
 * `/login` → `/projects`.
 */

import type { AuthState } from '../auth/auth_state.svelte';

export type GuardResult = { ok: true } | { ok: false; redirectTo: string };

/** Reject when not signed in; redirect to the login screen. */
export function requireAuth(authState: AuthState): GuardResult {
  return authState.isSignedIn
    ? { ok: true }
    : { ok: false, redirectTo: '/login' };
}

/**
 * Reject when the signed-in user is not an admin. Server still enforces;
 * this guard is only a UI affordance to keep non-admins out of the admin
 * surface.
 */
export function requireAdmin(authState: AuthState): GuardResult {
  return authState.isAdmin
    ? { ok: true }
    : { ok: false, redirectTo: '/projects' };
}

/**
 * Reject when *already* signed in — used to bounce signed-in users away
 * from `/login`. They land on `/projects` (the home tab).
 */
export function redirectIfSignedIn(authState: AuthState): GuardResult {
  return authState.isSignedIn
    ? { ok: false, redirectTo: '/projects' }
    : { ok: true };
}

/** Apply a named guard from `Route.guard`. */
export function applyGuard(
  guard: 'requireAuth' | 'requireAdmin' | 'redirectIfSignedIn' | undefined,
  authState: AuthState,
): GuardResult {
  switch (guard) {
    case 'requireAuth':
      return requireAuth(authState);
    case 'requireAdmin':
      return requireAdmin(authState);
    case 'redirectIfSignedIn':
      return redirectIfSignedIn(authState);
    default:
      return { ok: true };
  }
}
