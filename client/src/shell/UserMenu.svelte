<!--
  Avatar + display name with a popover containing "Sign out".

  When OIDC_ENABLED is false (dev profile), the menu is hidden in favour
  of a "Dev mode" badge — there's nothing to sign out of and showing a
  disabled menu is misleading.
-->
<script lang="ts">
  import { getContext } from 'svelte';
  import Avatar from '../ui/Avatar.svelte';
  import type { AuthState } from '../auth/auth_state.svelte';
  import type { OidcSession } from '../auth/oidc_session';
  import { OIDC_ENABLED } from '../env';
  import { cx } from '../util/class_names';

  interface Props {
    collapsed: boolean;
  }
  let { collapsed }: Props = $props();

  const authState = getContext<AuthState>('authState');
  const oidcSession = getContext<OidcSession | null>('oidcSession');

  let popoverOpen = $state(false);

  function toggle(): void {
    popoverOpen = !popoverOpen;
  }
  function close(): void {
    popoverOpen = false;
  }

  function signOut(): void {
    popoverOpen = false;
    if (oidcSession) oidcSession.signOut();
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

{#if !OIDC_ENABLED}
  <!-- Dev mode badge: no auth backend wired. -->
  <div
    class={cx(
      'inline-flex items-center gap-2 rounded border border-dashed border-border px-2 py-1 text-xs text-muted',
      collapsed ? 'justify-center' : '',
    )}
    title="Running in dev mode — no OIDC configured"
  >
    {#if collapsed}
      <span aria-label="Dev mode">D</span>
    {:else}
      <span class="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true"></span>
      <span>Dev mode</span>
    {/if}
  </div>
{:else}
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
    >
      <Avatar name={labelName} size="sm" />
      {#if !collapsed}
        <span class="flex-1 truncate" title={labelName}>{labelName}</span>
        <span class="text-muted" aria-hidden="true">▾</span>
      {/if}
    </button>

    {#if popoverOpen}
      <div
        role="menu"
        aria-label="Account menu"
        class="absolute bottom-full left-0 z-30 mb-1 w-44 rounded-md border border-border bg-surface p-1 shadow-lg"
      >
        <button
          type="button"
          role="menuitem"
          class="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-border/40"
          onclick={signOut}
        >
          Sign out
        </button>
      </div>
    {/if}
  </div>
{/if}
