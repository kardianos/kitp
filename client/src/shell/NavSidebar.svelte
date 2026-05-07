<!--
  Persistent left sidebar.

  - Top: brand mark.
  - Middle: five top-level nav links; admin section (collapsible <details>)
    rendered only when `authState.isAdmin`.
  - Bottom: <UserMenu /> with display name + sign-out (or a "Dev mode"
    badge when OIDC is disabled).

  Active-link highlighting reads `routerState.path`. Clicks go through
  `linkAction` so we don't full-page-reload.
-->
<script lang="ts">
  import { getContext } from 'svelte';
  import { routerState, linkAction } from '../routing/router.svelte';
  import { cx } from '../util/class_names';
  import ProjectSelector from './ProjectSelector.svelte';
  import UserMenu from './UserMenu.svelte';
  import type { AuthState } from '../auth/auth_state.svelte';

  interface Props {
    collapsed: boolean;
    onToggle: () => void;
  }
  let { collapsed, onToggle }: Props = $props();

  const authState = getContext<AuthState>('authState');

  const navItems: Array<{ href: string; label: string; chord: string }> = [
    { href: '/projects', label: 'Projects', chord: 'g p' },
    { href: '/inbox', label: 'Inbox', chord: 'g i' },
    { href: '/grid', label: 'Grid', chord: 'g g' },
    { href: '/kanban', label: 'Kanban', chord: 'g k' },
    { href: '/activity', label: 'Activity', chord: 'g a' },
  ];

  const adminItems: Array<{ href: string; label: string }> = [
    { href: '/admin/users', label: 'Users' },
    { href: '/admin/attributes', label: 'Attributes' },
  ];

  function isActive(href: string): boolean {
    const path = routerState.path;
    return path === href || path.startsWith(href + '/');
  }
</script>

<aside
  class={cx(
    'flex h-full shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-150',
    collapsed ? 'w-12' : 'w-[220px]',
  )}
  aria-label="Primary navigation"
>
  <!-- Brand row + collapse toggle -->
  <div class="flex h-12 items-center justify-between border-b border-border px-3">
    {#if !collapsed}
      <span class="text-sm font-semibold tracking-tight">kitp</span>
    {/if}
    <button
      type="button"
      class="rounded p-1 text-muted hover:bg-border/40"
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      onclick={onToggle}
    >
      <span aria-hidden="true">{collapsed ? '›' : '‹'}</span>
    </button>
  </div>

  {#if !collapsed}
    <div class="border-b border-border px-3 py-2">
      <ProjectSelector />
    </div>
  {/if}

  <!-- Top-level nav -->
  <nav class="flex-1 overflow-y-auto p-2" aria-label="Sections">
    <ul class="flex flex-col gap-0.5">
      {#each navItems as item (item.href)}
        <li>
          <a
            href={item.href}
            use:linkAction
            class={cx(
              'flex items-center justify-between rounded px-2 py-1.5 text-sm',
              'hover:bg-border/40',
              isActive(item.href)
                ? 'bg-accent/20 font-medium text-accent'
                : 'text-fg',
            )}
            aria-current={isActive(item.href) ? 'page' : undefined}
          >
            {#if collapsed}
              <span class="sr-only">{item.label}</span>
              <span aria-hidden="true">{item.label.charAt(0)}</span>
            {:else}
              <span>{item.label}</span>
              <span class="font-mono text-[10px] text-muted">{item.chord}</span>
            {/if}
          </a>
        </li>
      {/each}
    </ul>

    {#if authState?.isAdmin && !collapsed}
      <div class="my-3 border-t border-border"></div>
      <details class="group" open={isActive('/admin')}>
        <summary
          class="cursor-pointer list-none rounded px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-muted hover:bg-border/40"
        >
          Admin
        </summary>
        <ul class="mt-1 flex flex-col gap-0.5 pl-2">
          {#each adminItems as item (item.href)}
            <li>
              <a
                href={item.href}
                use:linkAction
                class={cx(
                  'block rounded px-2 py-1.5 text-sm',
                  'hover:bg-border/40',
                  isActive(item.href)
                    ? 'bg-accent/20 font-medium text-accent'
                    : 'text-fg',
                )}
                aria-current={isActive(item.href) ? 'page' : undefined}
              >
                {item.label}
              </a>
            </li>
          {/each}
        </ul>
      </details>
    {/if}
  </nav>

  <!-- Bottom: user menu -->
  <div class="border-t border-border p-2">
    <UserMenu {collapsed} />
  </div>
</aside>
