<!--
  AppShell — chrome wrapper for every signed-in screen.

  Layout:
    +-----------------+--------------------------------------------+
    |                 | Header (48px): breadcrumbs + help          |
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
  import ProjectTitlePicker from './ProjectTitlePicker.svelte';
  import { watchProjects } from './projects_store.svelte';
  import {
    projectScreensStore,
    watchProjectScreens,
  } from './project_screens_store.svelte';
  import { projectScope } from './project_scope.svelte';
  import { getDispatcher } from '../dispatch/context';
  import { shortcuts } from '../keys/registry.svelte';
  import { useShortcut } from '../keys/shortcut';
  import { readHotkey, readSlug, readTitle } from '../filter/screen_preset.svelte';
  import HelpButton from '../help/HelpButton.svelte';
  import { goBackOrFallback, navigate, routerState } from '../routing/router.svelte';
  import { screenUrl } from '../routing/routes';
  import ThemeToggle from './ThemeToggle.svelte';
  import { cx } from '../util/class_names';

  /**
   * Project-independent navigation chords. The per-project screen
   * chords (`g i`, `g g`, `g k`, …) come from the loaded screen cards
   * for the active project — see the dynamic registration effect below.
   * These two stay hardcoded because they don't live under a project.
   */
  useShortcut('global', 'g p', () => navigate('/projects'), 'Go to Projects');
  useShortcut('global', 'g a', () => navigate('/activity'), 'Go to Activity');

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

  // Keep the projects cache warm so /project/:id crumbs can resolve to
  // the project's title instead of a raw "#7". Idempotent — the store
  // collapses concurrent calls and gates on projectsVersion.
  const dispatcher = getDispatcher();
  $effect(watchProjects(dispatcher));

  // Keep the per-project screen list warm so the sidebar can render
  // dynamic screen links and the chord registration effect below can
  // see the live set.
  $effect(watchProjectScreens(dispatcher));

  /**
   * Register `g <hotkey>` chords for every screen in the active
   * project; unregister them on project change. The hardcoded
   * `NAV_CHORDS` table this replaces lived at the top of AppShell —
   * gate 9 makes it data-driven so a freshly-seeded screen comes with
   * a working hotkey on the next project visit, no code change.
   *
   * `useShortcut` is bound to component lifecycle (onMount/onDestroy)
   * and so can't be used inside an effect; we go through the registry
   * directly. The cleanup closure unregisters the previous batch on
   * the next run.
   */
  $effect(() => {
    // Track the per-project screen list. `forProjectId` is part of the
    // dependency set so a project switch retriggers; `screens` so a
    // mutation through `bumpVersion()` does too.
    const list = projectScreensStore.screens;
    void projectScreensStore.forProjectId;
    const pid = projectScope.projectId;
    const ids: number[] = [];
    if (pid !== null) {
      for (const sc of list) {
        const hk = readHotkey(sc);
        const slug = readSlug(sc);
        if (hk === null || slug === null) continue;
        const title = readTitle(sc);
        const id = shortcuts.register({
          scope: 'global',
          binding: `g ${hk}`,
          handler: () => navigate(screenUrl(pid, slug)),
          label: `Go to ${title}`,
        });
        ids.push(id);
      }
    }
    return () => {
      for (const id of ids) shortcuts.unregister(id);
    };
  });

  /**
   * Build breadcrumb segments from the current path. Slugs render
   * verbatim except for known patterns:
   *   /task/:id                       -> "Task #:id"
   *   /project/:id/screen/:slug       -> "<screen title>" (slug-cased)
   *   /admin/users                    -> "Admin / Users"
   *
   * The picker stands in for the project, so when the path enters under
   * `/project/...` both the literal `project` segment and the project
   * id crumb are skipped — otherwise the header reads "[Foo ▾] /
   * Project / Foo / Inbox". The literal `screen` segment between the id
   * and the slug is skipped the same way; the slug crumb is enough.
   */
  type Crumb = { label: string; href?: string; onClick?: () => void };
  const crumbs: Crumb[] = $derived.by(() => {
    const segs = routerState.path.split('/').filter(Boolean);
    if (segs.length === 0) return [{ label: 'Home' }];
    const out: Crumb[] = [];
    let cum = '';
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i] as string;
      cum += '/' + s;
      const prev = i > 0 ? (segs[i - 1] as string) : '';
      // Suppress the project/id pair — the title-bar picker shows it.
      if (s === 'project' && i === 0) continue;
      if (prev === 'project' && i === 1) continue;
      // Skip the literal `screen` segment between the id and the slug.
      if (s === 'screen' && i > 0 && (segs[i - 2] ?? '') === 'project') {
        continue;
      }
      let label = s;
      if (prev === 'task') label = `Task #${s}`;
      else if (prev === 'screen') {
        // Resolve `<slug>` against the loaded screens; fall back to a
        // titlecased slug when the list isn't loaded yet so the crumb
        // never reads as "inbox" instead of "Inbox".
        const found = projectScreensStore.screens.find(
          (r) => readSlug(r) === s,
        );
        if (found) label = readTitle(found);
        else label = s.charAt(0).toUpperCase() + s.slice(1);
      } else label = s.charAt(0).toUpperCase() + s.slice(1);
      const isLast = i === segs.length - 1;
      if (isLast) {
        out.push({ label });
      } else if (s === 'task') {
        // `/task` is not a route — `/task/:id` is. Clicking the literal
        // `task` crumb should pop back to whichever list view the user
        // came from (same effect as Esc / q in TaskDetailScreen).
        const pid = projectScope.projectId;
        const fallback = pid !== null ? screenUrl(pid, 'project') : '/projects';
        out.push({ label, onClick: () => goBackOrFallback(fallback) });
      } else {
        out.push({ label, href: cum });
      }
    }
    return out;
  });

  function toggleHelp(): void {
    shortcuts.helpOpen = !shortcuts.helpOpen;
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
        <ProjectTitlePicker />
        {#each crumbs as crumb, i (i)}
          <span class="text-muted" aria-hidden="true">/</span>
          {#if crumb.href}
            <a
              href={crumb.href}
              class="truncate text-muted hover:text-fg hover:underline"
            >
              {crumb.label}
            </a>
          {:else if crumb.onClick}
            <button
              type="button"
              class="truncate text-muted hover:text-fg hover:underline"
              onclick={crumb.onClick}
            >
              {crumb.label}
            </button>
          {:else}
            <span class={cx('truncate', i === crumbs.length - 1 ? 'font-medium' : 'text-muted')}>
              {crumb.label}
            </span>
          {/if}
        {/each}
      </nav>

      <div class="flex-1"></div>

      <!-- Theme toggle (sun / moon). Persisted to localStorage; the
           inline boot script in index.html applies the saved choice
           before the bundle loads, so reloads don't flash light. -->
      <ThemeToggle />

      <!-- Per-page help (markdown modal) sits to the left of the ? icon
           so the two affordances share visual weight; click the book
           for "about this screen", the ? for keyboard shortcuts. -->
      <HelpButton />

      <!-- Help icon (opens shortcut help via the registry's helpOpen flag) -->
      <button
        type="button"
        class="rounded p-1 text-muted hover:bg-border/40"
        title="Keyboard shortcuts (?)"
        aria-label="Show keyboard shortcuts"
        onclick={toggleHelp}
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
