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
import { navigate } from './routing/router.svelte';
import { notify } from './ui/toast.svelte';
import { KITP_API_BASE } from './env';

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

// Probe the server for an existing session before <App> mounts so the
// initial route gate doesn't flicker through /login when the user is
// already signed in. The same orchestration also primes the shared
// schema cache, which registers every card_ref attribute name with the
// dispatcher's bigint-revival registry — without this preload the very
// first batched data fetch would see card_ref values as raw JSON
// numbers (and side-panel labels, terminal-action visibility, etc.
// would silently mis-render until a second batch arrives).
void (async () => {
  const ok = await loadSession(authState, KITP_API_BASE);
  if (ok) await sharedSchemaCache(dispatcher).load();
})();

const app = mount(App, {
  target,
  props: { dispatcher, authState },
});

export default app;
