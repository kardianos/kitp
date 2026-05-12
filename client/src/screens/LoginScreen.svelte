<!--
  LoginScreen.

  Two modes:
    1. OIDC enabled (KITP_OIDC_* baked into the bundle): "Sign in with OIDC"
       redirects the browser to the server-side OIDC start endpoint. The
       server then drives the PKCE dance, validates the ID token, mints a
       session, sets the kitp_session cookie, and bounces the user back to /.
    2. OIDC disabled (dev build): "Continue as System User" POSTs the
       BFF dev-login endpoint; the server hands back a session cookie
       and we navigate to /projects.

  In both paths the browser never holds an access / id / refresh token.
-->
<script lang="ts">
  import { getContext, onMount } from 'svelte';
  import Button from '../ui/Button.svelte';
  import { type AuthState, devLogin } from '../auth/auth_state.svelte';
  import { OIDC_ENABLED, KITP_API_BASE } from '../env';
  import { setActiveScope, useShortcut } from '../keys/shortcut';
  import { navigate } from '../routing/router.svelte';
  import { parseLoginError, type LoginError } from './login_helpers';

  setActiveScope('login');

  const authState = getContext<AuthState>('authState');

  // `?error=...` surfaces server-side OIDC callback failures.
  let loginError = $state<LoginError | null>(null);
  // In-flight flag — disables the button while the redirect / POST is mid-flight.
  let signingIn = $state(false);

  onMount(() => {
    if (typeof window !== 'undefined') {
      loginError = parseLoginError(new URLSearchParams(window.location.search));
    }
  });

  async function startSignIn(): Promise<void> {
    if (signingIn) return;
    signingIn = true;
    if (OIDC_ENABLED) {
      // Hand control to the server-side OIDC redirect endpoint.
      // It'll set the session cookie before bouncing back to '/'.
      window.location.assign(`${KITP_API_BASE}/api/v1/auth/oidc/start`);
      return;
    }
    // Dev mode: POST dev-login, then route in.
    try {
      const ok = await devLogin(authState, KITP_API_BASE);
      if (!ok) {
        signingIn = false;
        loginError = { message: 'dev-login refused' };
        return;
      }
      navigate('/projects');
    } catch (e) {
      signingIn = false;
      loginError = { message: e instanceof Error ? e.message : String(e) };
    }
  }

  // Enter triggers the primary button.
  useShortcut('login', 'Enter', () => void startSignIn(), 'Sign in', {
    fireInInputs: true,
  });
</script>

<main
  class="flex min-h-screen items-center justify-center bg-bg p-8 text-fg"
  aria-labelledby="login-heading"
>
  <div
    class="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-sm"
  >
    <h1 id="login-heading" class="text-center text-2xl font-semibold">
      Sign in to kitp
    </h1>

    {#if OIDC_ENABLED}
      <p class="mt-2 text-center text-sm text-muted">
        Authenticate with your OpenID Connect provider.
      </p>
      <div class="mt-6 flex justify-center">
        <Button
          variant="primary"
          size="lg"
          loading={signingIn}
          onclick={() => void startSignIn()}
        >
          {#snippet children()}Sign in with OIDC{/snippet}
        </Button>
      </div>
    {:else}
      <p class="mt-2 text-center text-sm text-muted">
        OIDC is not configured. Set <code class="font-mono">KITP_OIDC_*</code>
        env vars and rebuild.
      </p>
      <div class="mt-6 flex justify-center">
        <Button
          variant="primary"
          size="lg"
          loading={signingIn}
          onclick={() => void startSignIn()}
        >
          {#snippet children()}Continue as System User{/snippet}
        </Button>
      </div>
    {/if}

    {#if loginError !== null}
      <div
        class="mt-6 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
        role="alert"
      >
        {loginError.message}
      </div>
    {/if}
  </div>
</main>
