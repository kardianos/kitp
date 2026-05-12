<!--
  Avatar + display name with a popover containing user info + Sign out.

  Both dev mode (AUTH_MODE=off) and OIDC mode now drive a real BFF
  session cookie, so the popover renders in both — only the cosmetic
  "Dev mode" hint inside the popover differentiates them.
-->
<script lang="ts">
  import { getContext } from 'svelte';
  import Avatar from '../ui/Avatar.svelte';
  import { type AuthState, logout } from '../auth/auth_state.svelte';
  import { OIDC_ENABLED, KITP_API_BASE } from '../env';
  import { navigate } from '../routing/router.svelte';
  import { cx } from '../util/class_names';

  interface Props {
    collapsed: boolean;
  }
  let { collapsed }: Props = $props();

  const authState = getContext<AuthState>('authState');

  let popoverOpen = $state(false);

  function toggle(): void {
    popoverOpen = !popoverOpen;
  }
  function close(): void {
    popoverOpen = false;
  }

  async function signOut(): Promise<void> {
    popoverOpen = false;
    await logout(authState, KITP_API_BASE);
    navigate('/login');
  }

  // Hide on outside-click. We use a window click-capture listener so any
  // click outside our root collapses the popover.
  let rootEl: HTMLDivElement | null = $state(null);
  $effect(() => {
    if (!popoverOpen) return;
    function onDocClick(ev: MouseEvent): void {
      const t = ev.target;
      if (rootEl && t instanceof Node && !rootEl.contains(t)) close();
    }
    window.addEventListener('mousedown', onDocClick, true);
    return () => window.removeEventListener('mousedown', onDocClick, true);
  });

  const displayName = $derived(authState?.displayName ?? '');
  const labelName = $derived(displayName.length > 0 ? displayName : 'Anonymous');
</script>

<div bind:this={rootEl} class="relative">
  <button
    type="button"
    class={cx(
      'flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-border/40',
      collapsed ? 'justify-center' : '',
    )}
    aria-haspopup="menu"
    aria-expanded={popoverOpen}
    onclick={toggle}
    data-testid="user-menu-trigger"
  >
    <Avatar name={labelName} size="sm" />
    {#if !collapsed}
      <span class="flex-1 truncate" title={labelName}>{labelName}</span>
      {#if !OIDC_ENABLED}
        <span
          class="inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
          aria-hidden="true"
          title="Dev mode"
        ></span>
      {/if}
      <span class="text-muted" aria-hidden="true">▾</span>
    {/if}
  </button>

  {#if popoverOpen}
    <div
      role="menu"
      aria-label="Account menu"
      class="absolute bottom-full left-0 z-30 mb-1 w-52 rounded-md border border-border bg-surface p-1 text-sm shadow-lg"
    >
      <div class="border-b border-border px-2 py-1.5">
        <div class="truncate font-medium" title={labelName}>{labelName}</div>
        {#if !OIDC_ENABLED}
          <div class="mt-0.5 inline-flex items-center gap-1.5 text-[11px] text-muted">
            <span class="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true"></span>
            Dev mode (AUTH_MODE=off)
          </div>
        {/if}
      </div>
      <button
        type="button"
        role="menuitem"
        class="block w-full rounded px-2 py-1.5 text-left hover:bg-border/40 focus:outline-none focus-visible:bg-border/40"
        onclick={() => void signOut()}
        data-testid="user-menu-sign-out"
      >
        Sign out
      </button>
    </div>
  {/if}
</div>
