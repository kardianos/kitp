/**
 * Application entry. Constructs the root services (HandlerRegistry,
 * Dispatcher, AuthState, OidcSession) and mounts <App> with them as
 * props. App.svelte itself wires them into Svelte context for the rest
 * of the tree.
 *
 * In dev mode (no VITE_KITP_OIDC_* env vars set) `oidcConfigFromEnv()`
 * returns null — we surface that as `oidcSession === null` and the
 * dispatcher runs without an `Authorization` header.
 */

import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';

import { Dispatcher } from './dispatch/dispatcher';
import { HandlerRegistry } from './reg/handler_registry';
import { registerBuiltInHandlers } from './reg/handlers';
import { AuthState } from './auth/auth_state.svelte';
import { OidcSession } from './auth/oidc_session';
import { oidcConfigFromEnv } from './auth/oidc_client';
import { KITP_API_BASE } from './env';

const target = document.getElementById('app');
if (!target) {
  throw new Error('mount target #app not found');
}

const registry = new HandlerRegistry();
registerBuiltInHandlers(registry);

const authState = new AuthState();
const oidcConfig = oidcConfigFromEnv();
const oidcSession =
  oidcConfig !== null ? new OidcSession(oidcConfig, authState) : null;

const dispatcher = new Dispatcher({
  apiBase: KITP_API_BASE,
  registry,
  authState,
  ...(oidcSession !== null
    ? { onUnauthorized: () => oidcSession.refreshIfNeeded() }
    : {}),
});

const app = mount(App, {
  target,
  props: { dispatcher, authState, oidcSession },
});

export default app;
