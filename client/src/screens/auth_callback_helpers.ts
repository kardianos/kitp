/**
 * Pure helpers used by `AuthCallbackScreen.svelte`.
 *
 * `OidcSession.handleCallback` itself validates `code` / `state` and throws
 * specific OIDC errors, but the screen needs to (a) read the URL safely on
 * first paint and (b) surface friendly errors when the IdP redirects with
 * `?error=...&error_description=...` instead of the expected pair. This
 * module captures both responsibilities so the screen stays declarative.
 */

/** Validated callback payload, mirrors the params expected by `handleCallback`. */
export interface CallbackParams {
  code: string;
  state: string;
}

/**
 * Extract `code` + `state` from a callback URL.
 *
 * Throws when:
 *   - The IdP returned an explicit `?error=...` (turned into an `Error`
 *     whose message includes the error_description when present).
 *   - Either `code` or `state` is missing or empty.
 *
 * Multiple values for a param are not expected from a real IdP; we use
 * `URLSearchParams.get` which returns the first.
 */
export function parseCallback(url: URL): CallbackParams {
  const params = url.searchParams;

  const idpError = params.get('error');
  if (idpError !== null && idpError.trim().length > 0) {
    const desc = params.get('error_description');
    const detail =
      desc !== null && desc.trim().length > 0 ? `: ${desc.trim()}` : '';
    throw new Error(`oidc callback error: ${idpError.trim()}${detail}`);
  }

  const code = params.get('code');
  const state = params.get('state');
  if (code === null || code.length === 0) {
    throw new Error('oidc callback missing code');
  }
  if (state === null || state.length === 0) {
    throw new Error('oidc callback missing state');
  }
  return { code, state };
}
