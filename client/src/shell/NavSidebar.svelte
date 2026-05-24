<!--
  Persistent left sidebar.

  - Top: brand mark.
  - Middle (project-independent): Projects link, then Activity link.
  - Middle (per-project): one row per screen card under the currently
    scoped project — title + chord hint. Driven entirely by data; gate 9
    removed the hardcoded "Inbox / Grid / Kanban" list.
  - Admin section (collapsible <details>) rendered only when `isAdmin`.
  - Bottom: <UserMenu /> with display name + sign-out (or a "Dev mode"
    badge when OIDC is disabled).

  Active-link highlighting reads `routerState.path`. Clicks go through
  `linkAction` so we don't full-page-reload.
-->
<script lang="ts">
  import { getContext } from 'svelte';
  import { readHotkey, readSlug, readTitle } from '../filter/screen_preset.svelte';
  import { routerState, linkAction } from '../routing/router.svelte';
  import { screenUrl } from '../routing/routes';
  import { projectScope } from './project_scope.svelte';
  import { projectScreensStore } from './project_screens_store.svelte';
  import { projectsStore } from './projects_store.svelte';
  import { cx } from '../util/class_names';
  import UserMenu from './UserMenu.svelte';
  import type { AuthState } from '../auth/auth_state.svelte';
  import type { CardWithAttrs } from '../reg/types';

  interface Props {
    collapsed: boolean;
    onToggle: () => void;
  }
  let { collapsed, onToggle }: Props = $props();

  const authState = getContext<AuthState>('authState');

  // Project-independent rows. The third (Activity) used to live in the
  // per-screen list; per gate 9 the sidebar splits cleanly between
  // "always visible" (Projects, Activity) and "per-project" (screens).
  const navItems: Array<{ href: string; label: string; chord: string }> = [
    { href: '/projects', label: 'Projects', chord: 'g p' },
    { href: '/activity', label: 'Activity', chord: 'g a' },
  ];

  const adminItems: Array<{ href: string; label: string }> = [
    { href: '/admin/users', label: 'Users' },
    { href: '/admin/contacts', label: 'People' },
    { href: '/admin/projects', label: 'Projects' },
    { href: '/admin/attributes', label: 'Attributes' },
    { href: '/admin/screens', label: 'Screens' },
    { href: '/admin/named-filters', label: 'Named filters' },
    { href: '/admin/flows', label: 'Flows' },
    { href: '/admin/agents', label: 'Agents' },
    { href: '/admin/comm-channels', label: 'Comm channels' },
    { href: '/admin/activity-sinks', label: 'Activity sinks' },
    { href: '/admin/comm-log', label: 'Comm log' },
  ];

  function isActive(href: string): boolean {
    const path = routerState.path;
    return path === href || path.startsWith(href + '/');
  }

  /**
   * Per-screen sidebar rows for the active project. Filters out screens
   * the actor lacks `view_requires_role` for so the sidebar hides what
   * the URL gate also blocks.
   */
  interface ScreenRow {
    href: string;
    label: string;
    chord: string | null;
    slug: string;
  }
  const screenRows = $derived.by((): ScreenRow[] => {
    const pid = projectScope.projectId;
    if (pid === null) return [];
    const rows: ScreenRow[] = [];
    for (const sc of projectScreensStore.screens) {
      if (isForbidden(sc)) continue;
      const slug = readSlug(sc);
      if (slug === null) continue;
      const hk = readHotkey(sc);
      rows.push({
        href: screenUrl(pid, slug),
        label: readTitle(sc),
        chord: hk === null ? null : `g ${hk}`,
        slug,
      });
    }
    return rows;
  });

  function isForbidden(card: CardWithAttrs): boolean {
    const v = card.attributes['view_requires_role'];
    if (typeof v !== 'bigint') return false;
    // Without a per-role-grant feed on the client, mirror ScreenHost's
    // conservative check: admins pass, others are blocked when the
    // attribute is set.
    return authState?.isAdmin !== true;
  }

  /**
   * Heading text for the per-project group. Falls back to a generic
   * label while the projects cache loads so the section never flashes
   * as "Project #7" before "Default Project" arrives.
   */
  const projectHeader = $derived.by((): string => {
    const pid = projectScope.projectId;
    if (pid === null) return 'Project';
    const t = projectsStore.titleFor(pid);
    return t ?? 'Project';
  });
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

    {#if screenRows.length > 0}
      <div class="my-3 border-t border-border"></div>
      {#if !collapsed}
        <div
          class="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted"
        >
          {projectHeader}
        </div>
      {/if}
      <ul class="flex flex-col gap-0.5">
        {#each screenRows as row (row.slug)}
          {@const initial = (row.chord ?? row.label).replace(/^g\s+/, '').charAt(0).toUpperCase()}
          <li>
            <a
              href={row.href}
              use:linkAction
              data-testid={`nav-screen-${row.slug}`}
              title={collapsed ? row.label : undefined}
              class={cx(
                'flex items-center rounded px-2 py-1.5 text-sm',
                'hover:bg-border/40',
                collapsed ? 'justify-center' : 'justify-between',
                isActive(row.href)
                  ? 'bg-accent/20 font-medium text-accent'
                  : 'text-fg',
              )}
              aria-current={isActive(row.href) ? 'page' : undefined}
            >
              {#if collapsed}
                <span class="sr-only">{row.label}</span>
                <span aria-hidden="true">{initial}</span>
              {:else}
                <span class="truncate">{row.label}</span>
                {#if row.chord !== null}
                  <span class="font-mono text-[10px] text-muted">{row.chord}</span>
                {/if}
              {/if}
            </a>
          </li>
        {/each}
      </ul>
    {/if}

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
