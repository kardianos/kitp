<!--
  AuthCallbackScreen.

  The OP redirects back to /auth/callback?code=...&state=...; this screen:
    1. Parses the URL.
    2. Hands the (code, state) pair to `OidcSession.handleCallback(url)`,
       which exchanges the code for tokens and populates AuthState.
    3. Navigates to /projects on success, or /login?error=... on failure.

  Toast notifications mirror the success/error paths so the outcome is
  visible even after the redirect.

  No keyboard shortcuts on this screen — `setActiveScope('global')` ensures
  the registry doesn't keep the previous screen's bindings live.

  Ports the `/auth/callback` handler from `client/lib/app.dart` together
  with `CallbackScreen` in `client/lib/ui/screens/login_screen.dart`.
-->
<script lang="ts">
  import { getContext, onMount } from 'svelte';
  import Spinner from '../ui/Spinner.svelte';
  import { navigate } from '../routing/router.svelte';
  import { setActiveScope } from '../keys/shortcut';
  import { notify } from '../ui/toast.svelte';
  import type { OidcSession } from '../auth/oidc_session';
  import { parseCallback } from './auth_callback_helpers';

  setActiveScope('global');

  const oidcSession = getContext<OidcSession | null>('oidcSession');

  // Surfaces only when the exchange fails *and* we are about to redirect to
  // /login. While the spinner is up we don't render any error — the user
  // sees it on the login screen via `?error=`.
  let errorMessage = $state<string | null>(null);

  onMount(() => {
    void run();
  });

  async function run(): Promise<void> {
    if (oidcSession === null) {
      // Hitting /auth/callback in dev mode is operator error — there is no
      // session to complete. Bounce back to /login with a sensible message.
      const msg = 'OIDC is not configured';
      errorMessage = msg;
      notify({ type: 'error', message: msg });
      navigate(`/login?error=${encodeURIComponent(msg)}`, { replace: true });
      return;
    }
    if (typeof window === 'undefined') return;
    try {
      const url = new URL(window.location.href);
      // `parseCallback` validates basic shape (and surfaces IdP-side
      // ?error=...) before we touch the OidcSession.
      parseCallback(url);
      await oidcSession.handleCallback(url);
      notify({ type: 'success', message: 'Signed in' });
      navigate('/projects', { replace: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errorMessage = msg;
      notify({ type: 'error', message: msg });
      navigate(`/login?error=${encodeURIComponent(msg)}`, { replace: true });
    }
  }
</script>

<main
  class="flex min-h-screen items-center justify-center bg-bg p-8 text-fg"
  aria-live="polite"
>
  <div
    class="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface p-6"
  >
    {#if errorMessage === null}
      <Spinner size="lg" />
      <p class="text-sm text-muted">Completing sign-in…</p>
    {:else}
      <p class="text-sm text-danger" role="alert">{errorMessage}</p>
    {/if}
  </div>
</main>
