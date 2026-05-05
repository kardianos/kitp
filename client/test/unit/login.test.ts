// Vitest suite for the LoginScreen + AuthCallbackScreen helpers.
//
// We deliberately do not render the Svelte components here — the project
// has no `@testing-library/svelte` dependency, and the screens themselves
// are thin shells around two pure helpers. Exercising the helpers covers
// the only branching logic worth testing.
//
// Coverage matrix:
//   1. parseLoginError: present, absent, empty, whitespace, special chars.
//   2. parseCallback: happy path, missing code, missing state, IdP error
//      payload (with and without description), repeated params (first wins).

import { describe, expect, it } from 'vitest';

import { parseLoginError } from '../../src/screens/login_helpers';
import { parseCallback } from '../../src/screens/auth_callback_helpers';

describe('parseLoginError', () => {
  it('returns null when ?error is absent', () => {
    const params = new URLSearchParams('');
    expect(parseLoginError(params)).toBeNull();
  });

  it('returns the message when ?error is set', () => {
    const params = new URLSearchParams('error=invalid_grant');
    expect(parseLoginError(params)).toEqual({ message: 'invalid_grant' });
  });

  it('returns null when ?error is the empty string', () => {
    const params = new URLSearchParams('error=');
    expect(parseLoginError(params)).toBeNull();
  });

  it('returns null when ?error is only whitespace', () => {
    const params = new URLSearchParams('error=%20%20');
    expect(parseLoginError(params)).toBeNull();
  });

  it('decodes percent-encoded values', () => {
    const params = new URLSearchParams(
      'error=' + encodeURIComponent('Sign-in failed: state mismatch'),
    );
    expect(parseLoginError(params)).toEqual({
      message: 'Sign-in failed: state mismatch',
    });
  });

  it('uses the first value when ?error appears multiple times', () => {
    const params = new URLSearchParams('error=first&error=second');
    expect(parseLoginError(params)).toEqual({ message: 'first' });
  });

  it('ignores other query params', () => {
    const params = new URLSearchParams('next=/projects&error=denied&foo=bar');
    expect(parseLoginError(params)).toEqual({ message: 'denied' });
  });
});

describe('parseCallback', () => {
  it('returns code + state on a well-formed URL', () => {
    const url = new URL('http://localhost/auth/callback?code=abc&state=xyz');
    expect(parseCallback(url)).toEqual({ code: 'abc', state: 'xyz' });
  });

  it('throws when code is missing', () => {
    const url = new URL('http://localhost/auth/callback?state=xyz');
    expect(() => parseCallback(url)).toThrow(/missing code/);
  });

  it('throws when state is missing', () => {
    const url = new URL('http://localhost/auth/callback?code=abc');
    expect(() => parseCallback(url)).toThrow(/missing state/);
  });

  it('throws when code is the empty string', () => {
    const url = new URL('http://localhost/auth/callback?code=&state=xyz');
    expect(() => parseCallback(url)).toThrow(/missing code/);
  });

  it('throws when state is the empty string', () => {
    const url = new URL('http://localhost/auth/callback?code=abc&state=');
    expect(() => parseCallback(url)).toThrow(/missing state/);
  });

  it('surfaces an IdP ?error= payload', () => {
    const url = new URL(
      'http://localhost/auth/callback?error=access_denied',
    );
    expect(() => parseCallback(url)).toThrow(/access_denied/);
  });

  it('includes error_description when the IdP provides one', () => {
    const url = new URL(
      'http://localhost/auth/callback?error=access_denied&error_description=' +
        encodeURIComponent('user cancelled'),
    );
    let captured: Error | null = null;
    try {
      parseCallback(url);
    } catch (e) {
      captured = e as Error;
    }
    expect(captured).not.toBeNull();
    expect(captured!.message).toMatch(/access_denied/);
    expect(captured!.message).toMatch(/user cancelled/);
  });

  it('prefers the IdP error over missing-code/state errors', () => {
    // No code/state, but error is present: report the IdP error, not
    // "missing code".
    const url = new URL(
      'http://localhost/auth/callback?error=server_error',
    );
    expect(() => parseCallback(url)).toThrow(/server_error/);
    expect(() => parseCallback(url)).not.toThrow(/missing code/);
  });

  it('uses the first value when params repeat', () => {
    const url = new URL(
      'http://localhost/auth/callback?code=first&code=second&state=s1&state=s2',
    );
    expect(parseCallback(url)).toEqual({ code: 'first', state: 's1' });
  });

  it('decodes percent-encoded code/state values', () => {
    const url = new URL(
      'http://localhost/auth/callback?code=' +
        encodeURIComponent('a/b+c=') +
        '&state=' +
        encodeURIComponent('x y'),
    );
    expect(parseCallback(url)).toEqual({ code: 'a/b+c=', state: 'x y' });
  });
});
