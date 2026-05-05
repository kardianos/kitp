// `OidcSession` orchestrates the authorization-code-with-PKCE flow:
// build the authorize URL, persist the verifier in sessionStorage, and
// (after redirect) exchange the code for tokens.
//
// Ports the runtime side of `client/lib/auth/oidc_session.dart`. The
// equivalent of the Dart conditional-import session storage shim is in
// `session_storage.ts`, which falls back to an in-memory map under tests.
//
// Discovery: the Dart implementation discovered authorization_endpoint /
// token_endpoint via `/.well-known/openid-configuration`. To keep the
// orchestrator easily testable (and to match the simpler endpoint shape
// kitpd's dex serves), we default to `${issuer}/auth` + `${issuer}/token`
// here. If a future OP needs different paths, a discovery layer can be
// added without touching the public API.

import type { OidcConfig, Tokens } from './oidc_client';
import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  generateState,
  refreshToken as refreshTokenCall,
} from './oidc_client';
import type { AuthState } from './auth_state.svelte';
import {
  clear as clearStorage,
  getVerifier,
  setVerifier,
  type MinimalStorage,
} from './session_storage';

type FetchFn = typeof fetch;

/// Pluggable navigation hook. Defaults to `window.location.assign(url)` in
/// the browser; tests pass a no-op or recorder.
type Navigate = (url: string) => void;

function defaultNavigate(url: string): void {
  const w = (globalThis as { location?: Location }).location;
  if (w && typeof w.assign === 'function') {
    w.assign(url);
  }
}

export interface OidcSessionOptions {
  storage?: MinimalStorage;
  fetchFn?: FetchFn;
  navigate?: Navigate;
}

export class OidcSession {
  private readonly config: OidcConfig;
  private readonly authState: AuthState;
  private readonly storage: MinimalStorage | undefined;
  private readonly fetchFn: FetchFn;
  private readonly navigate: Navigate;

  constructor(config: OidcConfig, authState: AuthState, opts: OidcSessionOptions = {}) {
    this.config = config;
    this.authState = authState;
    this.storage = opts.storage;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.navigate = opts.navigate ?? defaultNavigate;
  }

  /// Begin the login flow: stash a verifier in sessionStorage, then
  /// redirect the browser to the authorize URL.
  async startSignIn(): Promise<void> {
    const { verifier, challenge } = await generatePkce();
    const state = generateState();
    if (this.storage) setVerifier(state, verifier, this.storage);
    else setVerifier(state, verifier);
    const url = buildAuthorizeUrl(this.config, state, challenge);
    this.navigate(url);
  }

  /// Handle the OP redirect back to redirect_uri. Validates state, looks
  /// the verifier back out of sessionStorage, posts to the token endpoint,
  /// and populates `authState`. Throws on state mismatch / missing
  /// verifier / token endpoint failure.
  async handleCallback(url: URL): Promise<void> {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code) throw new Error('oidc callback missing code');
    if (!state) throw new Error('oidc callback missing state');
    const verifier = this.storage
      ? getVerifier(state, this.storage)
      : getVerifier(state);
    if (verifier === null) {
      throw new Error('oidc state mismatch or verifier missing');
    }
    const tokens = await exchangeCode(this.config, code, verifier, this.fetchFn);
    this.authState.setTokens(tokens);
    if (this.storage) clearStorage(this.storage);
    else clearStorage();
  }

  /// Use the refresh_token to rotate. Returns true on success, false
  /// otherwise (the caller — typically the dispatcher's onUnauthorized
  /// hook — should sign out on false). Matches Dart `OidcSession.refresh`.
  async refreshIfNeeded(): Promise<boolean> {
    const rt = this.authState.refreshToken;
    if (rt === null || rt === '') {
      this.signOut();
      return false;
    }
    let tokens: Tokens;
    try {
      tokens = await refreshTokenCall(this.config, rt, this.fetchFn);
    } catch {
      this.signOut();
      return false;
    }
    this.authState.setTokens(tokens);
    return true;
  }

  /// Local sign-out: wipes tokens + clears the verifier from
  /// sessionStorage. Does NOT call the OP's end-session endpoint — that is
  /// a deliberate choice matching the Dart client.
  signOut(): void {
    this.authState.signOut();
    if (this.storage) clearStorage(this.storage);
    else clearStorage();
  }
}
