<!--
  LoginScreen.

  Two modes:
    1. OIDC enabled (oidcSession provided in context): render a "Sign in with
       OIDC" button that hands off to the OP via `oidcSession.startSignIn()`.
    2. OIDC disabled (dev build, oidcSession === null): render a notice and
       a "Continue as System User" button. The router's `requireAuth` guard
       gates strictly on `authState.isSignedIn`, so to enter the app we
       directly flip `authState.isSignedIn = true` (matching the dev-mode
       affordance — there is no real session to lose).

  Pressing Enter triggers the primary action (matches the Dart screen's
  expected behaviour and the keyboard-first project convention).

  Ports `client/lib/ui/screens/login_screen.dart`.
-->
<script lang="ts">
  import { getContext, onMount } from 'svelte';
  import Button from '../ui/Button.svelte';
  import type { AuthState } from '../auth/auth_state.svelte';
  import type { OidcSession } from '../auth/oidc_session';
  import { setActiveScope, useShortcut } from '../keys/shortcut';
  import { navigate } from '../routing/router.svelte';
  import { parseLoginError, type LoginError } from './login_helpers';

  setActiveScope('login');

  const authState = getContext<AuthState>('authState');
  const oidcSession = getContext<OidcSession | null>('oidcSession');

  // `?error=...` surfaces auth-callback failures that bounced us back here.
  // We snapshot once on mount; reactive updates aren't needed because the
  // user can only get a new error by leaving and re-entering this screen.
  let loginError = $state<LoginError | null>(null);
  // In-flight flag for the IdP redirect — keeps the user from double-clicking
  // while `startSignIn()` is mid-PKCE-derivation.
  let signingIn = $state(false);

  onMount(() => {
    if (typeof window !== 'undefined') {
      loginError = parseLoginError(new URLSearchParams(window.location.search));
    }
  });

  async function startSignIn(): Promise<void> {
    if (signingIn) return;
    if (oidcSession !== null) {
      signingIn = true;
      try {
        await oidcSession.startSignIn();
      } catch (e) {
        signingIn = false;
        loginError = { message: e instanceof Error ? e.message : String(e) };
      }
      // On success the browser is redirecting; keep `signingIn` truthy so
      // the button stays disabled during the (very short) gap.
      return;
    }
    // Dev mode: no OIDC. Flip auth state and bounce to the home tab. Seed
    // `claims.groups` with the admin role so `requireAdmin` lets dev users
    // (and the e2e harness) into `/admin/*`. In OIDC mode this is replaced
    // by real claims from the id_token.
    if (authState !== undefined) {
      authState.isSignedIn = true;
      authState.claims = { sub: 'dev', name: 'System', groups: ['kitp.admin'] };
    }
    navigate('/projects');
  }

  // Enter triggers the primary button. `fireInInputs: true` so the binding
  // works even when (in some future iteration) we add a focusable input.
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

    {#if oidcSession !== null}
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
