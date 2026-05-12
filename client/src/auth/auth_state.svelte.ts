// `AuthState` is a Svelte 5 rune store reflecting the BFF auth model.
// The browser never sees an access / id / refresh token — the server's
// `kitp_session` httpOnly cookie carries the credential. AuthState only
// caches the identity bits the UI needs (user id, display name, group
// claims) after a successful `GET /api/v1/auth/me`.
//
// On app load the orchestrator calls `loadSession(state)` once. A 200
// flips `isSignedIn` true and populates the fields below. A 401 leaves
// everything blank and the router gate sends the user to /login.

export interface Claims {
  sub?: string;
  name?: string;
  preferred_username?: string;
  email?: string;
  groups?: string[];
}

export class AuthState {
  isSignedIn = $state(false);
  userId = $state<string | null>(null);
  claims = $state<Claims | null>(null);
  /** Server-evaluated role names (e.g. ["system","admin"]). */
  roles = $state<string[]>([]);
  /** Server-precomputed admin flag — drives the sidebar Admin section. */
  serverIsAdmin = $state(false);

  /// Mirror the shape /api/v1/auth/me returns into the rune-backed
  /// fields the UI subscribes to.
  setFromMe(me: {
    user_id: string;
    display_name: string;
    groups?: string[];
    roles?: string[];
    is_admin?: boolean;
  }): void {
    this.userId = me.user_id;
    this.claims = {
      sub: me.user_id,
      name: me.display_name,
      groups: me.groups ?? [],
    };
    this.roles = Array.isArray(me.roles) ? me.roles : [];
    this.serverIsAdmin = me.is_admin === true;
    this.isSignedIn = true;
  }

  /// Wipe local state — logout or 401.
  signOut(): void {
    this.userId = null;
    this.claims = null;
    this.roles = [];
    this.serverIsAdmin = false;
    this.isSignedIn = false;
  }

  /// Display name from the cached claims; '' when not signed in.
  get displayName(): string {
    const c = this.claims;
    if (!c) return '';
    if (typeof c.name === 'string' && c.name.length > 0) return c.name;
    if (typeof c.preferred_username === 'string' && c.preferred_username.length > 0) {
      return c.preferred_username;
    }
    if (typeof c.email === 'string' && c.email.length > 0) return c.email;
    if (typeof c.sub === 'string' && c.sub.length > 0) return c.sub;
    return '';
  }

  /// Group claim values (typically "kitp.admin", "kitp.manager", ...).
  /// Returns an empty list when the claim is missing or non-list.
  get groups(): string[] {
    const raw = this.claims?.groups;
    if (Array.isArray(raw)) {
      return raw.filter((g): g is string => typeof g === 'string');
    }
    return [];
  }

  /// True when the server flagged the session as admin (any of the
  /// 'admin' / 'system' roles, evaluated server-side and shipped via
  /// /api/v1/auth/me). Falls back to the legacy 'kitp.admin' group
  /// claim for OIDC sessions that haven't been re-issued yet.
  /// UI affordance gate only — server still enforces.
  get isAdmin(): boolean {
    if (this.serverIsAdmin) return true;
    return this.groups.includes('kitp.admin');
  }
}

/**
 * Probe the server-side session via `GET /api/v1/auth/me`. Sets the
 * rune-backed identity bits on success; leaves AuthState untouched
 * (and returns false) on 401 / network error.
 */
export async function loadSession(state: AuthState, apiBase = ''): Promise<boolean> {
  try {
    const r = await fetch(`${apiBase}/api/v1/auth/me`, {
      method: 'GET',
      credentials: 'same-origin',
    });
    if (!r.ok) {
      state.signOut();
      return false;
    }
    const body = (await r.json()) as {
      user_id: string;
      display_name: string;
      groups?: string[];
    };
    state.setFromMe(body);
    return true;
  } catch {
    state.signOut();
    return false;
  }
}

/**
 * POST `/api/v1/auth/dev-login` and load the resulting session. Only
 * usable when the server runs in AUTH_MODE=off (the endpoint 404s
 * otherwise).
 */
export async function devLogin(state: AuthState, apiBase = ''): Promise<boolean> {
  const r = await fetch(`${apiBase}/api/v1/auth/dev-login`, {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!r.ok) return false;
  const body = (await r.json()) as {
    user_id: string;
    display_name: string;
    groups?: string[];
  };
  state.setFromMe(body);
  return true;
}

/**
 * POST `/api/v1/auth/logout`. Clears server-side session + cookie and
 * resets local AuthState. The router gate kicks the user to /login on
 * the next path push.
 */
export async function logout(state: AuthState, apiBase = ''): Promise<void> {
  try {
    await fetch(`${apiBase}/api/v1/auth/logout`, {
      method: 'POST',
      credentials: 'same-origin',
    });
  } catch {
    // Cookie eviction is best-effort; we still want to drop local state.
  }
  state.signOut();
}
