/**
 * Application entry. Constructs the root services (HandlerRegistry,
 * Dispatcher, AuthState) and mounts <App> with them as props.
 *
 * BFF auth model: the browser never sees an access / id / refresh
 * token. On boot we probe `GET /api/v1/auth/me`; a 200 populates
 * AuthState, a 401 leaves it blank and the router gate steers the
 * user to /login. All authenticated API calls rely on the
 * kitp_session httpOnly cookie set by the server.
 */

import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';

import { Dispatcher } from './dispatch/dispatcher';
import { HandlerRegistry } from './reg/handler_registry';
import { registerBuiltInHandlers } from './reg/handlers';
import { AuthState, loadSession } from './auth/auth_state.svelte';
import { sharedSchemaCache } from './filter/attribute_schema.svelte';
import { loadHandlerCatalog } from './schema/store.svelte';
import { navigate } from './routing/router.svelte';
import { notify } from './ui/toast.svelte';
import { KITP_API_BASE, OIDC_ENABLED } from './env';

const target = document.getElementById('app');
if (!target) {
  throw new Error('mount target #app not found');
}

const registry = new HandlerRegistry();
registerBuiltInHandlers(registry);

const authState = new AuthState();

const dispatcher = new Dispatcher({
  apiBase: KITP_API_BASE,
  registry,
  authState,
});

// Central kernel: every failure path the dispatcher reaches flows
// through these listeners. Per-screen bound handlers see the same
// fault as `{ ok: false, error }` for any UI specialisation; the
// global concerns (session expiry ⇒ /login, generic error toast) live
// here in exactly one place. Adding a new global behaviour means
// adding one listener — no per-call try/catch ever needed.
dispatcher.onFault('http', (f) => {
  if (f.kind !== 'http') return;
  if (f.status === 401) {
    authState.signOut();
    if (OIDC_ENABLED) {
      // SSO mode: the server gates the SPA document and expects a
      // full-page bounce to the OIDC start endpoint, which threads the
      // deep link back through the flow. The SPA renders no login UI.
      location.assign(
        `${KITP_API_BASE}/api/v1/auth/oidc/start?redirect=${encodeURIComponent(
          location.pathname + location.search,
        )}`,
      );
      return;
    }
    // Dev / dev-login path: in-app navigation to the local login screen.
    navigate('/login');
    return;
  }
  notify({ type: 'error', message: `Server error (HTTP ${f.status})` });
});
dispatcher.onFault('network', (f) => {
  if (f.kind !== 'network') return;
  notify({ type: 'error', message: `Network error: ${f.message}` });
});
dispatcher.onFault('sub_error', (f) => {
  if (f.kind !== 'sub_error') return;
  notify({ type: 'error', message: f.message.length > 0 ? f.message : f.code });
});
dispatcher.onFault('decode', (f) => {
  if (f.kind !== 'decode') return;
  console.error('dispatch decode error:', f.message);
});
dispatcher.onFault('aborted', (f) => {
  if (f.kind !== 'aborted') return;
  console.warn('dispatch aborted:', f.reason);
});

// Probe the server for an existing session BEFORE <App> mounts so the
// initial route gate runs against the live auth state. Fire-and-forget
// here races the Router: on a hard refresh of any auth-gated URL
// (admin/*, /project/..., /task/...) the guard would see isSignedIn=
// false, redirect to /login or /projects, and the auth probe would
// land too late — the URL would already have moved away from where
// the user was.
//
// The same orchestration primes the shared schema cache, which
// registers every card_ref attribute name with the dispatcher's
// bigint-revival registry. Without this preload the first batched
// data fetch would see card_ref values as raw JSON numbers and
// side-panel labels, terminal-action visibility, etc. would silently
// mis-render until a second batch arrives.
//
// Cost: ~one network round-trip of blank page on cold load. That's
// the existing index.html background; no flash, no flicker.
let appHandle: ReturnType<typeof mount> | null = null;
void (async () => {
  const ok = await loadSession(authState, KITP_API_BASE);
  if (ok) {
    // Both caches are session-gated: schemaCache primes card_ref
    // attribute names for bigint revival; handlerCatalog primes the
    // form kernel with every handler's input/output JSON Schema.
    // Fired in parallel — they hit independent server endpoints.
    await Promise.all([
      sharedSchemaCache(dispatcher).load(),
      loadHandlerCatalog(dispatcher),
    ]);
  }
  appHandle = mount(App, {
    target,
    props: { dispatcher, authState },
  });
})();

export default appHandle;
