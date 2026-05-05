<!--
  AppShell — chrome wrapper for every signed-in screen.

  Layout:
    +-----------------+--------------------------------------------+
    |                 | Header (48px): breadcrumbs + search + help |
    |  Sidebar (220)  +--------------------------------------------+
    |  collapsible    |                                            |
    |                 |  Outlet (children) padded 24px             |
    |                 |                                            |
    +-----------------+--------------------------------------------+

  - `collapsed` is persisted to localStorage so the user's choice
    survives reloads.
  - On mobile (≤700px) the sidebar slides off-canvas behind a hamburger.
    Pure CSS — no JS resize listener.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import NavSidebar from './NavSidebar.svelte';
  import { routerState } from '../routing/router.svelte';
  import { cx } from '../util/class_names';

  interface Props {
    children?: Snippet;
  }
  let { children }: Props = $props();

  const COLLAPSE_KEY = 'kitp.sidebar.collapsed';

  // Persisted collapse flag. localStorage may be unavailable (SSR / certain
  // privacy contexts) so we guard.
  function readCollapsed(): boolean {
    if (typeof localStorage === 'undefined') return false;
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  }
  function writeCollapsed(v: boolean): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0');
    } catch {
      // ignored
    }
  }

  let collapsed = $state(readCollapsed());
  let mobileOpen = $state(false);

  function toggleCollapse(): void {
    collapsed = !collapsed;
    writeCollapsed(collapsed);
  }

  function toggleMobile(): void {
    mobileOpen = !mobileOpen;
  }

  // Close mobile drawer on every route change.
  $effect(() => {
    // Touch the rune so the effect re-runs.
    void routerState.path;
    if (mobileOpen) mobileOpen = false;
  });

  /**
   * Build breadcrumb segments from the current path. Slugs render
   * verbatim except for known patterns:
   *   /task/:id        -> "Task #:id"
   *   /project/:id     -> "Project #:id"
   *   /admin/users     -> "Admin / Users"
   * Each segment carries an `href` of the cumulative path so users can
   * jump back up the tree. (No href on the last segment.)
   */
  type Crumb = { label: string; href?: string };
  const crumbs: Crumb[] = $derived.by(() => {
    const segs = routerState.path.split('/').filter(Boolean);
    if (segs.length === 0) return [{ label: 'Home' }];
    const out: Crumb[] = [];
    let cum = '';
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i] as string;
      cum += '/' + s;
      const prev = i > 0 ? (segs[i - 1] as string) : '';
      let label = s;
      if (prev === 'task') label = `Task #${s}`;
      else if (prev === 'project') label = `Project #${s}`;
      else label = s.charAt(0).toUpperCase() + s.slice(1);
      const isLast = i === segs.length - 1;
      out.push(isLast ? { label } : { label, href: cum });
    }
    return out;
  });

  // Mod+K placeholder: focus the search input. The real command palette
  // ships in a later task — for now `Mod+K` opens nothing global; the
  // input itself surfaces an autofocus when the icon button is clicked.
  let searchInputEl: HTMLInputElement | null = $state(null);
  function focusSearch(): void {
    searchInputEl?.focus();
  }
</script>

<div class="flex h-screen w-screen overflow-hidden bg-bg text-fg">
  <!-- Desktop sidebar (hidden on mobile via CSS). -->
  <div class="hidden md:flex h-full">
    <NavSidebar {collapsed} onToggle={toggleCollapse} />
  </div>

  <!-- Mobile drawer (visible only when toggled, ≤md). -->
  {#if mobileOpen}
    <div class="fixed inset-0 z-40 flex md:hidden" role="dialog" aria-modal="true">
      <div
        class="h-full"
      >
        <NavSidebar collapsed={false} onToggle={toggleCollapse} />
      </div>
      <button
        type="button"
        aria-label="Close navigation"
        class="flex-1 cursor-default bg-black/40"
        onclick={toggleMobile}
      ></button>
    </div>
  {/if}

  <div class="flex h-full min-w-0 flex-1 flex-col">
    <!-- Header -->
    <header
      class="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface px-3"
    >
      <!-- Mobile hamburger -->
      <button
        type="button"
        class="rounded p-1 text-muted hover:bg-border/40 md:hidden"
        aria-label="Open navigation"
        onclick={toggleMobile}
      >
        <span aria-hidden="true">☰</span>
      </button>

      <!-- Breadcrumbs -->
      <nav class="flex min-w-0 items-center gap-1 text-sm" aria-label="Breadcrumb">
        {#each crumbs as crumb, i (i)}
          {#if i > 0}
            <span class="text-muted" aria-hidden="true">/</span>
          {/if}
          {#if crumb.href}
            <a
              href={crumb.href}
              class="truncate text-muted hover:text-fg hover:underline"
            >
              {crumb.label}
            </a>
          {:else}
            <span class={cx('truncate', i === crumbs.length - 1 ? 'font-medium' : 'text-muted')}>
              {crumb.label}
            </span>
          {/if}
        {/each}
      </nav>

      <div class="flex-1"></div>

      <!-- Search input (placeholder for command palette) -->
      <input
        bind:this={searchInputEl}
        type="search"
        placeholder="Search…  Mod+K"
        class="hidden h-8 w-64 rounded border border-border bg-bg px-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:block"
        aria-label="Search"
      />

      <!-- Help icon (opens shortcut help via the registry's helpOpen flag) -->
      <button
        type="button"
        class="rounded p-1 text-muted hover:bg-border/40"
        title="Keyboard shortcuts (?)"
        aria-label="Show keyboard shortcuts"
        onclick={focusSearch}
      >
        <span aria-hidden="true">?</span>
      </button>
    </header>

    <!-- Outlet -->
    <main class="flex-1 overflow-auto p-6">
      {#if children}
        {@render children()}
      {/if}
    </main>
  </div>
</div>
