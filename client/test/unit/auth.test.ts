// BFF AuthState tests.
//
// The pre-BFF suite covered PKCE primitives + the in-browser OIDC
// client. Both moved server-side in the cookie-based session pass, so
// what's left to verify here is the small client-side AuthState
// shape: identity bits round-trip through /api/v1/auth/me, dev-login
// flips state, logout wipes state, and the displayName / isAdmin
// derived getters still work.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AuthState,
  devLogin,
  loadSession,
  logout,
} from '../../src/auth/auth_state.svelte';

describe('AuthState', () => {
  it('setFromMe populates identity bits and flips isSignedIn', () => {
    const a = new AuthState();
    a.setFromMe({ user_id: '2', display_name: 'Alice', groups: ['kitp.admin'] });
    expect(a.isSignedIn).toBe(true);
    expect(a.userId).toBe('2');
    expect(a.displayName).toBe('Alice');
    expect(a.groups).toEqual(['kitp.admin']);
    expect(a.isAdmin).toBe(true);
  });

  it('displayName falls through name → preferred_username → email → sub', () => {
    const a = new AuthState();
    a.setFromMe({ user_id: 'sub-1', display_name: '' });
    a.claims = { sub: 'sub-1' };
    expect(a.displayName).toBe('sub-1');
    a.claims = { sub: 'sub-1', email: 'u@e.com' };
    expect(a.displayName).toBe('u@e.com');
    a.claims = { sub: 'sub-1', email: 'u@e.com', preferred_username: 'ada' };
    expect(a.displayName).toBe('ada');
    a.claims = { sub: 'sub-1', email: 'u@e.com', preferred_username: 'ada', name: 'Ada Lovelace' };
    expect(a.displayName).toBe('Ada Lovelace');
  });

  it('signOut wipes state', () => {
    const a = new AuthState();
    a.setFromMe({ user_id: '7', display_name: 'X', groups: ['kitp.admin'] });
    a.signOut();
    expect(a.isSignedIn).toBe(false);
    expect(a.userId).toBeNull();
    expect(a.claims).toBeNull();
    expect(a.isAdmin).toBe(false);
  });

  it('isAdmin requires the kitp.admin group', () => {
    const a = new AuthState();
    a.setFromMe({ user_id: '3', display_name: 'B', groups: ['kitp.user'] });
    expect(a.isAdmin).toBe(false);
    a.setFromMe({ user_id: '3', display_name: 'B', groups: ['kitp.admin'] });
    expect(a.isAdmin).toBe(true);
  });
});

describe('loadSession / devLogin / logout', () => {
  let origFetch: typeof fetch | undefined;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    if (origFetch !== undefined) globalThis.fetch = origFetch;
  });

  it('loadSession flips isSignedIn on 200 from /auth/me', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ user_id: '2', display_name: 'Alice' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchFn as unknown as typeof fetch;
    const a = new AuthState();
    const ok = await loadSession(a, '');
    expect(ok).toBe(true);
    expect(a.isSignedIn).toBe(true);
    expect(a.userId).toBe('2');
    expect(a.displayName).toBe('Alice');
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/auth/me',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' }),
    );
  });

  it('loadSession leaves state blank on 401', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    const a = new AuthState();
    a.setFromMe({ user_id: 'stale', display_name: 'Stale' });
    const ok = await loadSession(a, '');
    expect(ok).toBe(false);
    expect(a.isSignedIn).toBe(false);
  });

  it('devLogin POSTs and populates state', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ user_id: '1', display_name: 'System' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchFn as unknown as typeof fetch;
    const a = new AuthState();
    const ok = await devLogin(a, '');
    expect(ok).toBe(true);
    expect(a.isSignedIn).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/auth/dev-login',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('logout POSTs and wipes state', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    globalThis.fetch = fetchFn as unknown as typeof fetch;
    const a = new AuthState();
    a.setFromMe({ user_id: '2', display_name: 'Alice' });
    await logout(a, '');
    expect(a.isSignedIn).toBe(false);
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/auth/logout',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
