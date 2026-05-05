// Vitest suite for the OIDC + AuthState port.
//
// Coverage matrix:
//   1. PKCE pair: verifier in 43..128 chars + base64url; challenge =
//      base64url(SHA256(verifier)).
//   2. buildAuthorizeUrl wires every required PKCE param.
//   3. handleCallback: state mismatch throws; happy path exchanges code,
//      populates AuthState, clears storage.
//   4. AuthState.setTokens / displayName claim fall-through.
//   5. signOut wipes tokens and storage.
//   6. refreshIfNeeded: success rotates accessToken; failure signs out.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  base64UrlDecode,
  base64UrlEncode,
  buildAuthorizeUrl,
  codeChallengeS256,
  decodeIdTokenClaims,
  generatePkce,
  type OidcConfig,
  type Tokens,
} from '../../src/auth/oidc_client';
import { AuthState } from '../../src/auth/auth_state.svelte';
import { OidcSession } from '../../src/auth/oidc_session';
import {
  clear as clearStorage,
  getVerifier,
  setVerifier,
  type MinimalStorage,
} from '../../src/auth/session_storage';

const config: OidcConfig = {
  issuer: 'https://op.example/dex',
  clientId: 'kitp-web',
  redirectUri: 'http://localhost:5173/auth/callback',
  scopes: 'openid profile email',
};

function memoryStorage(): MinimalStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => {
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
  };
}

// Build a forged JWT (header.payload.sig) with arbitrary claims. Signature
// is a placeholder — `decodeIdTokenClaims` does not verify it.
function makeJwt(payload: Record<string, unknown>): string {
  const enc = (obj: Record<string, unknown>): string => {
    const json = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(json);
    return base64UrlEncode(bytes);
  };
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(payload)}.signature`;
}

// ---------------------------------------------------------------------------
// 1. PKCE pair
// ---------------------------------------------------------------------------

describe('PKCE primitives', () => {
  it('generates a 43-char base64url verifier', async () => {
    const { verifier } = await generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('challenge is base64url(SHA256(verifier))', async () => {
    const { verifier, challenge } = await generatePkce();
    const expected = await codeChallengeS256(verifier);
    expect(challenge).toBe(expected);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    // SHA-256 = 32 bytes → base64url-without-padding = 43 chars.
    expect(challenge.length).toBe(43);
  });

  it('base64url encode/decode round-trips', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const s = base64UrlEncode(bytes);
    expect(s).not.toContain('+');
    expect(s).not.toContain('/');
    expect(s).not.toContain('=');
    const back = base64UrlDecode(s);
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });

  it('decodeIdTokenClaims parses payload', () => {
    const jwt = makeJwt({ sub: 'u1', email: 'u@e.com', groups: ['kitp.admin'] });
    const claims = decodeIdTokenClaims(jwt);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe('u1');
    expect(claims!.email).toBe('u@e.com');
    expect(claims!.groups).toEqual(['kitp.admin']);
  });

  it('decodeIdTokenClaims returns null on malformed token', () => {
    // Single-part token: split returns [token], which is < 2 parts.
    expect(decodeIdTokenClaims('only-one-part')).toBeNull();
    // Payload bytes don't decode to JSON.
    expect(decodeIdTokenClaims('a.@@@.c')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. buildAuthorizeUrl
// ---------------------------------------------------------------------------

describe('buildAuthorizeUrl', () => {
  it('includes every required PKCE param', () => {
    const url = new URL(buildAuthorizeUrl(config, 'state-xyz', 'challenge-abc'));
    expect(url.origin + url.pathname).toBe('https://op.example/dex/auth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(config.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(url.searchParams.get('scope')).toBe(config.scopes);
    expect(url.searchParams.get('state')).toBe('state-xyz');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('honors a custom authorization endpoint', () => {
    const url = new URL(
      buildAuthorizeUrl(config, 's', 'c', 'https://op.example/custom/authorize'),
    );
    expect(url.origin + url.pathname).toBe('https://op.example/custom/authorize');
  });
});

// ---------------------------------------------------------------------------
// 3. handleCallback
// ---------------------------------------------------------------------------

describe('OidcSession.handleCallback', () => {
  let storage: MinimalStorage;
  let authState: AuthState;

  beforeEach(() => {
    storage = memoryStorage();
    authState = new AuthState();
  });

  it('throws on state mismatch', async () => {
    setVerifier('expected-state', 'verifier-stored', storage);
    const fetchFn = vi.fn();
    const session = new OidcSession(config, authState, {
      storage,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const callbackUrl = new URL(
      'http://localhost:5173/auth/callback?code=abc&state=other-state',
    );
    await expect(session.handleCallback(callbackUrl)).rejects.toThrow(/state/i);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(authState.isSignedIn).toBe(false);
  });

  it('throws when code is missing', async () => {
    const session = new OidcSession(config, authState, { storage });
    const callbackUrl = new URL('http://localhost:5173/auth/callback?state=s1');
    await expect(session.handleCallback(callbackUrl)).rejects.toThrow(/code/);
  });

  it('happy path exchanges code and populates authState', async () => {
    setVerifier('s1', 'verifier-s1', storage);

    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://op.example/dex/token');
      expect(init.method).toBe('POST');
      const body = String(init.body);
      expect(body).toContain('grant_type=authorization_code');
      expect(body).toContain('code=the-code');
      expect(body).toContain('code_verifier=verifier-s1');
      expect(body).toContain('client_id=kitp-web');
      expect(body).toContain(
        'redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Fauth%2Fcallback',
      );
      return new Response(
        JSON.stringify({
          access_token: 'at-1',
          refresh_token: 'rt-1',
          id_token: makeJwt({ sub: 'u1', email: 'u@e.com' }),
          expires_in: 600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const session = new OidcSession(config, authState, {
      storage,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await session.handleCallback(
      new URL('http://localhost:5173/auth/callback?code=the-code&state=s1'),
    );

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(authState.isSignedIn).toBe(true);
    expect(authState.accessToken).toBe('at-1');
    expect(authState.refreshToken).toBe('rt-1');
    expect(authState.claims?.sub).toBe('u1');
    // Storage should be cleared on success.
    expect(getVerifier('s1', storage)).toBeNull();
  });

  it('surfaces token endpoint errors', async () => {
    setVerifier('s2', 'verifier-s2', storage);
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );
    const session = new OidcSession(config, authState, {
      storage,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(
      session.handleCallback(
        new URL('http://localhost:5173/auth/callback?code=bad&state=s2'),
      ),
    ).rejects.toThrow(/token endpoint failed/);
    expect(authState.isSignedIn).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. AuthState
// ---------------------------------------------------------------------------

describe('AuthState', () => {
  it('setTokens flips isSignedIn and decodes claims', () => {
    const a = new AuthState();
    const tokens: Tokens = {
      access_token: 'at',
      refresh_token: 'rt',
      id_token: makeJwt({ sub: 'u', name: 'Ada Lovelace' }),
      expires_in: 60,
    };
    a.setTokens(tokens);
    expect(a.isSignedIn).toBe(true);
    expect(a.accessToken).toBe('at');
    expect(a.refreshToken).toBe('rt');
    expect(a.claims?.name).toBe('Ada Lovelace');
    expect(a.expiresAt).not.toBeNull();
  });

  it('displayName falls through name → preferred_username → email → sub', () => {
    const a = new AuthState();

    a.setTokens({ access_token: 'x', id_token: makeJwt({ sub: 'sub-1' }) });
    expect(a.displayName).toBe('sub-1');

    a.setTokens({
      access_token: 'x',
      id_token: makeJwt({ sub: 'sub-1', email: 'u@e.com' }),
    });
    expect(a.displayName).toBe('u@e.com');

    a.setTokens({
      access_token: 'x',
      id_token: makeJwt({
        sub: 'sub-1',
        email: 'u@e.com',
        preferred_username: 'ada',
      }),
    });
    expect(a.displayName).toBe('ada');

    a.setTokens({
      access_token: 'x',
      id_token: makeJwt({
        sub: 'sub-1',
        email: 'u@e.com',
        preferred_username: 'ada',
        name: 'Ada Lovelace',
      }),
    });
    expect(a.displayName).toBe('Ada Lovelace');
  });

  it('isAdmin reflects the kitp.admin group claim', () => {
    const a = new AuthState();
    a.setTokens({ access_token: 'x', id_token: makeJwt({ sub: 's' }) });
    expect(a.isAdmin).toBe(false);
    a.setTokens({
      access_token: 'x',
      id_token: makeJwt({ sub: 's', groups: ['kitp.admin', 'kitp.user'] }),
    });
    expect(a.isAdmin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. signOut
// ---------------------------------------------------------------------------

describe('OidcSession.signOut', () => {
  it('clears auth state and storage', () => {
    const storage = memoryStorage();
    const a = new AuthState();
    a.setTokens({
      access_token: 'at',
      refresh_token: 'rt',
      id_token: makeJwt({ sub: 'u' }),
      expires_in: 60,
    });
    setVerifier('persisted-state', 'persisted-verifier', storage);

    const session = new OidcSession(config, a, { storage });
    session.signOut();

    expect(a.isSignedIn).toBe(false);
    expect(a.accessToken).toBeNull();
    expect(a.refreshToken).toBeNull();
    expect(a.idToken).toBeNull();
    expect(a.claims).toBeNull();
    expect(a.expiresAt).toBeNull();
    expect(getVerifier('persisted-state', storage)).toBeNull();
  });

  it('session_storage clear() wipes both keys', () => {
    const storage = memoryStorage();
    setVerifier('s', 'v', storage);
    expect(getVerifier('s', storage)).toBe('v');
    clearStorage(storage);
    expect(getVerifier('s', storage)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. refreshIfNeeded
// ---------------------------------------------------------------------------

describe('OidcSession.refreshIfNeeded', () => {
  it('success path rotates tokens and returns true', async () => {
    const a = new AuthState();
    a.setTokens({
      access_token: 'old-at',
      refresh_token: 'rt-1',
      id_token: makeJwt({ sub: 'u' }),
      expires_in: 60,
    });

    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://op.example/dex/token');
      const body = String(init.body);
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('refresh_token=rt-1');
      expect(body).toContain('client_id=kitp-web');
      return new Response(
        JSON.stringify({
          access_token: 'new-at',
          refresh_token: 'rt-2',
          expires_in: 600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const session = new OidcSession(config, a, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const ok = await session.refreshIfNeeded();
    expect(ok).toBe(true);
    expect(a.accessToken).toBe('new-at');
    expect(a.refreshToken).toBe('rt-2');
  });

  it('failure path returns false and signs out', async () => {
    const a = new AuthState();
    a.setTokens({
      access_token: 'old-at',
      refresh_token: 'rt-1',
      id_token: makeJwt({ sub: 'u' }),
      expires_in: 60,
    });

    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );
    const session = new OidcSession(config, a, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const ok = await session.refreshIfNeeded();
    expect(ok).toBe(false);
    expect(a.isSignedIn).toBe(false);
    expect(a.accessToken).toBeNull();
  });

  it('returns false when no refresh_token is present', async () => {
    const a = new AuthState();
    // Signed in but with no refresh_token.
    a.setTokens({ access_token: 'at', id_token: makeJwt({ sub: 'u' }) });
    const fetchFn = vi.fn();
    const session = new OidcSession(config, a, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const ok = await session.refreshIfNeeded();
    expect(ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(a.isSignedIn).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cleanup any storage shim we leaked onto globalThis between tests.
// ---------------------------------------------------------------------------

afterEach(() => {
  // The session_storage module stamps a fallback onto globalThis.sessionStorage
  // when no real one exists. Clear it so tests don't leak state into one
  // another. We don't delete it because that would force re-allocation.
  const g = globalThis as { sessionStorage?: MinimalStorage };
  if (g.sessionStorage) {
    // Best-effort wipe of the two keys we know about.
    g.sessionStorage.removeItem('kitp_oidc_verifier');
    g.sessionStorage.removeItem('kitp_oidc_state');
  }
});
