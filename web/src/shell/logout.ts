/**
 * Logout (#21). A plain one-way POST to the auth endpoint — logout is NOT a
 * batch handler, so it bypasses the dispatcher — then a redirect to the app
 * root (which re-bounces to SSO / dev-login). Fire-and-forget: the redirect
 * runs whether the POST resolves or rejects. Guards keep it a no-op without a
 * DOM (tests).
 */

export const LOGOUT_PATH = '/api/v1/auth/logout';

export function logout(): void {
  const go = (): void => {
    if (typeof location !== 'undefined') location.assign('/');
  };
  if (typeof fetch !== 'function') {
    go();
    return;
  }
  void fetch(LOGOUT_PATH, { method: 'POST', credentials: 'same-origin' }).then(go, go);
}
