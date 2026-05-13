<!--
  Top-level Router. Resolves the current path → route, applies guards,
  loads the matched screen via dynamic import, and renders it either
  bare or wrapped in <AppShell> based on the route's `shell` flag.

  This component owns the popstate listener (installed in `$effect`) and
  the lazy-loaded screen module cache.
-->
<script lang="ts">
  import { getContext, onMount, type Component } from 'svelte';
  import { routerState, navigate, installPopstate } from './router.svelte';
  import { applyGuard } from './guards';
  import {
    interpolatePath,
    matchRoute,
    type Route,
    type ScreenModule,
  } from './routes';
  import AppShell from '../shell/AppShell.svelte';
  import type { AuthState } from '../auth/auth_state.svelte';
  import { setActiveScope } from '../keys/shortcut';

  /** Type alias for the screens we render — generic over their props record. */
  type AnyComponent = Component<Record<string, unknown>, Record<string, unknown>, string>;

  // Auth state is provided at App root via `setContext('authState', ...)`.
  const authState = getContext<AuthState>('authState');

  // Lazy-loaded component cache: path-pattern → resolved module.
  const moduleCache = new Map<string, ScreenModule>();
  // The component currently mounted (post-load).
  let activeComponent = $state<AnyComponent | null>(null);
  // Active route + params snapshot (kept separate from `match` so we only
  // re-render once the dynamic import resolves).
  let activeRoute = $state<Route | null>(null);
  let activeParams = $state<Record<string, string>>({});
  let loadError = $state<string | null>(null);

  onMount(() => installPopstate());

  /**
   * On every path change: match → guard → lazy-load → swap.
   * Redirects (route.redirectTo or guard rejection) navigate(..., replace)
   * and bail out — the rune update will fire `$effect` again.
   */
  $effect(() => {
    const path = routerState.path;
    const match = matchRoute(path);

    if (!match) {
      // 404 — render an inline NotFound state inside the shell when signed
      // in, otherwise bare.
      activeRoute = null;
      activeParams = {};
      activeComponent = null;
      loadError = `No route matched: ${path}`;
      return;
    }

    const route = match.route;

    // Pure redirect entry. The target is interpolated against the
    // matched params so patterns like `/project/:id` →
    // `/project/:id/screen/project` work without a bespoke handler.
    if (route.redirectTo !== undefined) {
      const dest = interpolatePath(route.redirectTo, match.params);
      navigate(dest, { replace: true });
      return;
    }

    // Guard.
    const guard = applyGuard(route.guard, authState);
    if (!guard.ok) {
      navigate(guard.redirectTo, { replace: true });
      return;
    }

    // Switch active scope before paint so screen-mounted shortcuts land
    // in the right bucket.
    if (route.scope !== undefined) {
      setActiveScope(route.scope);
    }

    // Load (or reuse) the screen module. Cache by path pattern so revisits
    // don't re-fetch.
    if (route.component === undefined) {
      activeRoute = route;
      activeParams = match.params;
      activeComponent = null;
      loadError = `Route ${route.path} has no component`;
      return;
    }

    const cached = moduleCache.get(route.path);
    if (cached) {
      activeRoute = route;
      activeParams = match.params;
      activeComponent = cached.default as AnyComponent;
      loadError = null;
      return;
    }

    // Async load — tag the in-flight path so a fast double-nav doesn't
    // race and clobber the newer screen with a stale resolution.
    const loadingPath = path;
    void route
      .component()
      .then((mod) => {
        moduleCache.set(route.path, mod);
        if (routerState.path !== loadingPath) return;
        activeRoute = route;
        activeParams = match.params;
        activeComponent = mod.default as AnyComponent;
        loadError = null;
      })
      .catch((e: unknown) => {
        if (routerState.path !== loadingPath) return;
        loadError = `Failed to load ${route.path}: ${String(e)}`;
        activeComponent = null;
      });
  });

  const useShell = $derived(activeRoute?.shell === true);
</script>

{#if useShell}
  <AppShell>
    {#if activeComponent}
      {@const Comp = activeComponent}
      <Comp params={activeParams} />
    {:else if loadError}
      <div class="p-6 text-sm text-danger">{loadError}</div>
    {:else}
      <div class="p-6 text-sm text-muted">Loading…</div>
    {/if}
  </AppShell>
{:else if activeComponent}
  {@const Comp = activeComponent}
  <Comp params={activeParams} />
{:else if loadError}
  <div class="p-6 text-sm text-danger">{loadError}</div>
{:else}
  <div class="p-6 text-sm text-muted">Loading…</div>
{/if}
