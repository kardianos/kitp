// `AuthState` is a Svelte 5 rune store holding tokens + parsed claims in
// memory only (never localStorage / sessionStorage). Any UI bit that wants
// to react to sign-in / sign-out (admin nav link, top-nav user chip)
// observes its rune-backed fields.
//
// On sign-in the dispatcher attaches `Authorization: Bearer <access>` to
// every `POST /api/v1/batch`. On 401 the dispatcher forces a token
// refresh; on a second 401 we clear state and route to login.
//
// Ports `client/lib/auth/auth_state.dart`. The rune-backed assignment
// pattern replaces ChangeNotifier — Svelte runes already implement
// fine-grained subscription.

import type { Claims, Tokens } from './oidc_client';
import { decodeIdTokenClaims } from './oidc_client';

export class AuthState {
  // Public reactive state — runes only work in `.svelte` / `.svelte.ts`
  // modules, which is why this file has the `.svelte.ts` extension.
  isSignedIn = $state(false);
  accessToken = $state<string | null>(null);
  refreshToken = $state<string | null>(null);
  idToken = $state<string | null>(null);
  claims = $state<Claims | null>(null);
  /// Epoch seconds; null when the token endpoint omitted `expires_in`.
  expiresAt = $state<number | null>(null);

  /// Update tokens after a successful token-endpoint exchange. Decodes the
  /// id_token (if present) into `claims`.
  setTokens(t: Tokens): void {
    this.accessToken = t.access_token;
    this.refreshToken = t.refresh_token ?? null;
    this.idToken = t.id_token ?? null;
    this.claims = t.id_token ? decodeIdTokenClaims(t.id_token) : null;
    if (t.expires_in !== undefined) {
      this.expiresAt = Math.floor(Date.now() / 1000) + t.expires_in;
    } else {
      this.expiresAt = null;
    }
    this.isSignedIn = true;
  }

  /// Wipe all state — logout or rotation failure.
  signOut(): void {
    this.accessToken = null;
    this.refreshToken = null;
    this.idToken = null;
    this.claims = null;
    this.expiresAt = null;
    this.isSignedIn = false;
  }

  /// The display name we show in the nav. Falls through name →
  /// preferred_username → email → sub. Returns the empty string if none of
  /// those claims is present (matches the Dart `?? ''` fallback at call
  /// sites; the Dart getter returned String?).
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

  /// True when the signed-in user has the conventional `kitp.admin`
  /// group. UI affordance gate only — server still enforces.
  get isAdmin(): boolean {
    return this.groups.includes('kitp.admin');
  }
}
