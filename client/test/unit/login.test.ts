// Vitest suite for LoginScreen helpers.
//
// The pre-BFF suite also exercised parseCallback, but the OIDC callback
// is now handled server-side (no client helper exists), so only the
// shared `?error=…` parser is covered here. The screen itself is a
// thin shell around the helper + the auth_state.devLogin call.

import { describe, expect, it } from 'vitest';

import { parseLoginError } from '../../src/screens/login_helpers';

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
