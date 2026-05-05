// Pure OIDC PKCE helpers — no Svelte, no DOM.
//
// Authorization Code + PKCE flow:
//   1. Client generates a 256-bit `code_verifier` (base64url-without-padding,
//      43..128 chars).
//   2. Client derives `code_challenge = base64url(sha256(verifier))`,
//      `code_challenge_method = S256`.
//   3. Verifier is stored in sessionStorage by the orchestrator (see
//      session_storage.ts) — never localStorage.
//   4. On callback the client posts `code` + `verifier` to the OP's token
//      endpoint, gets back `id_token` / `access_token` / `refresh_token`,
//      and the orchestrator hands them to `AuthState` (memory only).
//
// This file ports `client/lib/auth/oidc_client.dart` plus the token
// exchange / refresh bodies from `oidc_session.dart` so the orchestrator
// can stay free of crypto + http details.

import {
  KITP_OIDC_ISSUER,
  KITP_OIDC_CLIENT_ID,
  KITP_OIDC_REDIRECT_URI,
  KITP_OIDC_SCOPES,
  OIDC_ENABLED,
} from '../env';

export interface OidcConfig {
  /// OP issuer base URL (e.g. http://localhost:5556/dex). Used to derive
  /// the discovery / authorize / token endpoints.
  issuer: string;
  /// Client ID registered with the OP for this SPA.
  clientId: string;
  /// Where the OP should redirect after auth. Must match the OP-side
  /// registration exactly.
  redirectUri: string;
  /// Space-delimited scope list (OIDC requires `openid`).
  scopes: string;
}

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

export interface Claims {
  sub?: string;
  name?: string;
  preferred_username?: string;
  email?: string;
  groups?: string[];
  exp?: number;
  // Other claims pass through untyped for callers that need them.
  [k: string]: unknown;
}

/// Build a full OidcConfig from the env-time values when OIDC is enabled.
/// Returns null when the build was made without OIDC settings — the client
/// then runs in dev mode (no auth UI, no auth header).
export function oidcConfigFromEnv(): OidcConfig | null {
  if (!OIDC_ENABLED) return null;
  return {
    issuer: KITP_OIDC_ISSUER,
    clientId: KITP_OIDC_CLIENT_ID,
    redirectUri: KITP_OIDC_REDIRECT_URI,
    scopes: KITP_OIDC_SCOPES,
  };
}

// ---------------------------------------------------------------------------
// PKCE primitives
// ---------------------------------------------------------------------------

/// Encode bytes as base64url-without-padding (RFC 7636 §4.1).
export function base64UrlEncode(bytes: Uint8Array): string {
  // Browsers + Node 20 both have btoa. We avoid Buffer to keep the module
  // browser-clean.
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] as number);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/// Decode a base64url-without-padding string back to bytes.
export function base64UrlDecode(input: string): Uint8Array {
  let s = input.replace(/-/g, '+').replace(/_/g, '/');
  const mod = s.length % 4;
  if (mod !== 0) s += '='.repeat(4 - mod);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  // Node 20 and all modern browsers have globalThis.crypto.getRandomValues.
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.getRandomValues) {
    throw new Error('WebCrypto not available: crypto.getRandomValues missing');
  }
  c.getRandomValues(buf);
  return buf;
}

/// Generate a PKCE code_verifier — 32 random bytes → 43-char base64url.
export function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(32));
}

/// Derive the S256 code_challenge for a given verifier.
export async function codeChallengeS256(verifier: string): Promise<string> {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) {
    throw new Error('WebCrypto subtle digest not available');
  }
  const data = new TextEncoder().encode(verifier);
  const digest = await c.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

/// Generate a random `state` (16 random bytes → 22-char base64url) used to
/// bind the redirect to its initiator.
export function generateState(): string {
  return base64UrlEncode(randomBytes(16));
}

/// Generate a verifier + S256 challenge in one call. Convenient for the
/// orchestrator and tests.
export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = generateCodeVerifier();
  const challenge = await codeChallengeS256(verifier);
  return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/// Default authorize endpoint = `${issuer}/auth` (dex shape). Auth0/Okta
/// users should pass an explicit `authorizationEndpoint` via discovery.
export function defaultAuthorizationEndpoint(issuer: string): string {
  return `${trimTrailingSlash(issuer)}/auth`;
}

/// Default token endpoint = `${issuer}/token` (dex shape).
export function defaultTokenEndpoint(issuer: string): string {
  return `${trimTrailingSlash(issuer)}/token`;
}

/// Build the OP authorize URL given a config + state + challenge. The
/// caller is responsible for having generated and persisted the verifier.
export function buildAuthorizeUrl(
  config: OidcConfig,
  state: string,
  codeChallenge: string,
  authorizationEndpoint: string = defaultAuthorizationEndpoint(config.issuer),
): string {
  const u = new URL(authorizationEndpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', config.clientId);
  u.searchParams.set('redirect_uri', config.redirectUri);
  u.searchParams.set('scope', config.scopes);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

export class OidcError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'OidcError';
  }
}

type FetchFn = typeof fetch;

async function postForm(
  url: string,
  body: Record<string, string>,
  fetchFn: FetchFn,
): Promise<Tokens> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) params.set(k, v);
  const resp = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new OidcError(
      `token endpoint failed: ${resp.status}`,
      resp.status,
      text,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OidcError('token endpoint returned non-JSON body', resp.status, text);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new OidcError('token endpoint returned non-object body', resp.status, text);
  }
  const obj = parsed as Record<string, unknown>;
  const access = obj.access_token;
  if (typeof access !== 'string' || access.length === 0) {
    throw new OidcError('token response missing access_token', resp.status, text);
  }
  const refresh = typeof obj.refresh_token === 'string' ? obj.refresh_token : undefined;
  const id = typeof obj.id_token === 'string' ? obj.id_token : undefined;
  const exp =
    typeof obj.expires_in === 'number'
      ? obj.expires_in
      : typeof obj.expires_in === 'string' && /^\d+$/.test(obj.expires_in)
        ? Number(obj.expires_in)
        : undefined;
  const out: Tokens = { access_token: access };
  if (refresh !== undefined) out.refresh_token = refresh;
  if (id !== undefined) out.id_token = id;
  if (exp !== undefined) out.expires_in = exp;
  return out;
}

/// Exchange an authorization code + PKCE verifier for tokens.
export async function exchangeCode(
  config: OidcConfig,
  code: string,
  codeVerifier: string,
  fetchFn: FetchFn = fetch,
  tokenEndpoint: string = defaultTokenEndpoint(config.issuer),
): Promise<Tokens> {
  return postForm(
    tokenEndpoint,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: codeVerifier,
    },
    fetchFn,
  );
}

/// Rotate a refresh_token for a fresh access_token (and possibly new
/// refresh_token). On any non-2xx the caller should sign out.
export async function refreshToken(
  config: OidcConfig,
  refresh: string,
  fetchFn: FetchFn = fetch,
  tokenEndpoint: string = defaultTokenEndpoint(config.issuer),
): Promise<Tokens> {
  return postForm(
    tokenEndpoint,
    {
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: config.clientId,
    },
    fetchFn,
  );
}

// ---------------------------------------------------------------------------
// JWT payload decoding (no signature check; server validates)
// ---------------------------------------------------------------------------

/// Decode a JWT's payload section into a Claims object. JWT format is
/// `header.payload.signature` — base64url-encoded. We only read the
/// payload; signature verification happens server-side.
export function decodeIdTokenClaims(idToken: string): Claims | null {
  const parts = idToken.split('.');
  if (parts.length < 2) return null;
  try {
    const bytes = base64UrlDecode(parts[1] as string);
    const text = new TextDecoder().decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Claims;
    }
  } catch {
    // Malformed token — fall through.
  }
  return null;
}
