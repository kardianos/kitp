<!--
  Application root.

  Responsibilities:
    1. Wire up the Dispatcher / AuthState from `main.ts` into Svelte
       context so any descendant can read them.
    2. Install the global keydown listener (the registry exposes its disposer).
    3. Mount the Router (which itself hosts the popstate listener and dynamic
       screen loading).
    4. Mount the toast stack and shortcut-help overlay so they live above
       every route.

  This component does NOT render its own chrome — every shell-bound screen
  goes through `<AppShell>`, which the Router selects per route.
-->
<script lang="ts">
  import { setContext, untrack } from 'svelte';
  import { setDispatcher } from './dispatch/context';
  import { installGlobalKeydown } from './keys/dispatcher';
  import Router from './routing/Router.svelte';
  import Toast from './ui/Toast.svelte';
  import ShortcutHelp from './keys/ShortcutHelp.svelte';
  import type { Dispatcher } from './dispatch/dispatcher';
  import type { AuthState } from './auth/auth_state.svelte';

  interface Props {
    dispatcher: Dispatcher;
    authState: AuthState;
  }
  let { dispatcher, authState }: Props = $props();

  // Props arrive from `main.ts` mount() and never change identity, but
  // Svelte's reactivity rules still warn when we read them at module top
  // level without untrack(). The contexts themselves are read in
  // descendants which are reactive normally.
  untrack(() => {
    setDispatcher(dispatcher);
    setContext<AuthState>('authState', authState);
  });

  $effect(() => installGlobalKeydown());
</script>

<Router />
<Toast />
<ShortcutHelp />
