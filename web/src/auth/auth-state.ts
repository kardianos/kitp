/**
 * Current-user identity — the auth-state service.
 *
 * SSO-only auth: the SPA renders NO login screen and never holds a token; the
 * server's httpOnly session cookie carries the credential. This service does
 * ONE thing at boot: probe `GET /api/v1/auth/me` (same-origin, cookie) and land
 * the identity bits the role-aware UI needs at `auth.user` in the data tree.
 *
 * Shape (mirrors server/internal/auth/session/http.go MeResponse, camelCased):
 *
 *   interface AuthUser {
 *     userId: bigint | null;     // user_account id (json:",string" on the wire)
 *     displayName: string;
 *     roles: string[];           // e.g. ['worker','manager']
 *     isAdmin: boolean;          // server-precomputed convenience flag
 *     isAgent: boolean;          // user_account.is_agent
 *     parentUserId: bigint | null; // owning human when isAgent
 *   }
 *
 * Zero promise crosses the control surface: `loadAuthUser` takes the fetch as an
 * injectable callback-style probe (the SAME shape as the dispatcher transport),
 * lands `auth.user` on success, and routes a 401/403 to the SSO-bounce callback.
 * Controls READ `auth.user` reactively (the boot fetch writes it ONCE), so the
 * one-way cascade rule holds: nobody writes the leaf inside a tracked effect.
 *
 * Reference (NOT imported): client/src/auth/auth_state.svelte.ts (loadSession).
 */

import type { TreeNode } from '../core/tree.js';

/** Where the current-user identity lives in the data tree. */
export const AUTH_USER_PATH = ['auth', 'user'] as const;

/**
 * The landed current-user identity. `userId` is the user_account id (the same id
 * space the `assignee` attribute compares against — see the Inbox mine_only
 * wiring + server personal_sort_test.go). Null userId means "not resolved"
 * (pre-fetch, or an unauthenticated probe before the SSO bounce fires).
 */
export interface AuthUser {
  userId: bigint | null;
  displayName: string;
  roles: string[];
  isAdmin: boolean;
  isAgent: boolean;
  parentUserId: bigint | null;
}

/** The wire shape of `GET /api/v1/auth/me` (ids are JSON strings). */
interface MeWire {
  authenticated?: boolean;
  user_id?: string;
  display_name?: string;
  roles?: string[];
  is_admin?: boolean;
  is_agent?: boolean;
  parent_user_id?: string;
}

/**
 * A callback-style probe of `/api/v1/auth/me`. Production passes
 * {@link fetchMe} (same-origin cookie fetch); tests pass a stub. The single
 * allowed promise (the fetch) lives privately inside the probe and never
 * escapes — the control surface is `onResult` / `onUnauthorized` / `onError`.
 */
export interface MeProbe {
  probe(
    onResult: (status: number, body: unknown) => void,
    onError: (message: string) => void,
  ): void;
}

/** Production probe: same-origin fetch to `/api/v1/auth/me` (cookie auth). */
export function fetchMe(apiBase = ''): MeProbe {
  return {
    probe(onResult, onError): void {
      // The one private promise; nothing leaks past the callbacks.
      void (async () => {
        try {
          const r = await fetch(`${apiBase}/api/v1/auth/me`, {
            method: 'GET',
            credentials: 'same-origin',
          });
          let body: unknown = null;
          try {
            body = await r.json();
          } catch {
            // A non-JSON body (e.g. a 401 HTML page) → treat as no body; the
            // status drives the unauthenticated / bounce decision below.
            body = null;
          }
          onResult(r.status, body);
        } catch (e) {
          onError(String(e));
        }
      })();
    },
  };
}

/** Coerce a wire id string (or number/bigint) to a positive bigint, else null. */
function parseId(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v > 0n ? v : null;
  if (typeof v === 'number' && Number.isInteger(v)) return v > 0 ? BigInt(v) : null;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) {
    try {
      const n = BigInt(v);
      return n > 0n ? n : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Map the `/auth/me` wire body to the landed {@link AuthUser} shape. */
export function authUserFromWire(body: unknown): AuthUser {
  const j = (body && typeof body === 'object' ? body : {}) as MeWire;
  return {
    userId: parseId(j.user_id),
    displayName: typeof j.display_name === 'string' ? j.display_name : '',
    roles: Array.isArray(j.roles) ? j.roles.filter((r): r is string => typeof r === 'string') : [],
    isAdmin: j.is_admin === true,
    isAgent: j.is_agent === true,
    parentUserId: parseId(j.parent_user_id),
  };
}

export interface LoadAuthUserOpts {
  /**
   * The probe to use. Defaults to the production same-origin fetch. Tests pass
   * a stub that delivers a canned `(status, body)` synchronously.
   */
  probe?: MeProbe;
  /**
   * Called when the probe reports an unauthenticated session (HTTP 401 / 403,
   * OR a 200 with `authenticated:false`). The boot wiring points this at the
   * existing SSO bounce (main.ts `bounceToSso`) so the 401-at-/auth/me path and
   * the 401-on-a-batch path share one redirect. `auth.user` is left at its
   * default (unresolved) — the bounce takes over the page.
   */
  onUnauthorized?: () => void;
  /**
   * Called on a successful authenticated probe (200 + `authenticated:true`),
   * after `auth.user` is landed. The boot wiring uses it to clear the dev-login
   * recovery guard so a later mid-session expiry can re-attempt recovery.
   */
  onAuthed?: () => void;
}

/**
 * Boot service: probe `/api/v1/auth/me` and land `auth.user` in the tree.
 *
 *   - 200 + authenticated → land the decoded identity at `auth.user`.
 *   - 401 / 403 / authenticated:false → call `onUnauthorized` (SSO bounce).
 *   - network error → leave `auth.user` unresolved; the first batch read's own
 *     401 will trigger the bounce. (The funnel is the real auth gate.)
 *
 * Cascade-safe: the landing `set` is a one-way write outside any tracked effect
 * (it runs from the probe callback at boot, before/around the AppShell mount).
 * Returns nothing — callers read `auth.user` reactively.
 */
export function loadAuthUser(tree: TreeNode, opts: LoadAuthUserOpts = {}): void {
  const probe = opts.probe ?? fetchMe();
  // Seed the leaf so a reactive read before the probe lands sees the unresolved
  // default rather than `undefined` (every helper treats null userId as "not
  // signed in yet"; the boot fetch overwrites this once).
  if (tree.at([...AUTH_USER_PATH]).peek() === undefined) {
    tree.at([...AUTH_USER_PATH]).set(unresolvedUser());
  }
  probe.probe(
    (status, body) => {
      if (status === 401 || status === 403) {
        opts.onUnauthorized?.();
        return;
      }
      const wire = (body && typeof body === 'object' ? body : {}) as MeWire;
      if (status >= 200 && status < 300 && wire.authenticated === true) {
        tree.at([...AUTH_USER_PATH]).set(authUserFromWire(wire));
        opts.onAuthed?.();
        return;
      }
      // A 200 with authenticated:false (the cold-boot probe shape the server
      // returns instead of a noisy 401) → unauthenticated.
      if (wire.authenticated === false) {
        opts.onUnauthorized?.();
        return;
      }
      // Any other status (5xx, etc.): leave the leaf unresolved; the batch
      // funnel will surface the fault and bounce if it's an auth failure.
    },
    () => {
      // Network error: leave `auth.user` unresolved (no bounce here — a real
      // auth failure surfaces on the first batch read via the central funnel).
    },
  );
}

/** The default, unresolved identity (null userId, no roles). */
function unresolvedUser(): AuthUser {
  return {
    userId: null,
    displayName: '',
    roles: [],
    isAdmin: false,
    isAgent: false,
    parentUserId: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers — read `auth.user` from the tree. The `*` variants subscribe the    */
/* caller's effect (reactive); the `peek*` variants do not.                    */
/* -------------------------------------------------------------------------- */

/** Reactive read of the landed identity (or the unresolved default). */
export function authUser(tree: TreeNode): AuthUser {
  return (tree.at([...AUTH_USER_PATH]).get<AuthUser>() ?? unresolvedUser()) as AuthUser;
}

/** Non-reactive snapshot of the landed identity. */
export function peekAuthUser(tree: TreeNode): AuthUser {
  return (tree.at([...AUTH_USER_PATH]).peek<AuthUser>() ?? unresolvedUser()) as AuthUser;
}

/** Reactive: is the signed-in user an admin? (UI affordance gate; server still enforces.) */
export function isAdmin(tree: TreeNode): boolean {
  return authUser(tree).isAdmin === true;
}

/** Non-reactive: is the signed-in user an admin? */
export function peekIsAdmin(tree: TreeNode): boolean {
  return peekAuthUser(tree).isAdmin === true;
}

/** Reactive: does the signed-in user hold `role` (by name, any scope)? */
export function hasRole(tree: TreeNode, role: string): boolean {
  return authUser(tree).roles.includes(role);
}

/** Non-reactive: does the signed-in user hold `role` (by name, any scope)? */
export function peekHasRole(tree: TreeNode, role: string): boolean {
  return peekAuthUser(tree).roles.includes(role);
}

/** Reactive: the signed-in user's id, or null when unresolved. */
export function currentUserId(tree: TreeNode): bigint | null {
  return authUser(tree).userId;
}

/** Non-reactive: the signed-in user's id, or null when unresolved. */
export function peekCurrentUserId(tree: TreeNode): bigint | null {
  return peekAuthUser(tree).userId;
}
