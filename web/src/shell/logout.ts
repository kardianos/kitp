/**
 * Logout (#21). A plain one-way POST to the auth endpoint — logout is NOT a
 * batch handler, so it bypasses the dispatcher. The server revokes EVERY
 * session the user holds (all devices) and clears the cookie, then returns
 * `{ ok, redirect? }`: in OIDC mode `redirect` is the OP's RP-initiated
 * logout URL (unified logout — ends the IdP session too), so we navigate
 * there; otherwise we fall back to the app root (which re-bounces to SSO /
 * dev-login). Fire-and-forget: a redirect always runs, whether the POST
 * resolves or rejects. Guards keep it a no-op without a DOM (tests).
 */

export const LOGOUT_PATH = '/api/v1/auth/logout';

export function logout(): void {
  const go = (dest: string): void => {
    if (typeof location !== 'undefined') location.assign(dest || '/');
  };
  if (typeof fetch !== 'function') {
    go('/');
    return;
  }
  void fetch(LOGOUT_PATH, { method: 'POST', credentials: 'same-origin' }).then(
    async (res) => {
      let dest = '/';
      try {
        const body = (await res.json()) as { redirect?: unknown };
        if (typeof body.redirect === 'string' && body.redirect !== '') dest = body.redirect;
      } catch {
        // No / non-JSON body → local logout, return to root.
      }
      go(dest);
    },
    () => go('/'),
  );
}
