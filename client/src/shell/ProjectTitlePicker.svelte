<script lang="ts">
  /**
   * Title-styled project switcher.
   *
   * Renders as an h1-sized button showing the active project's name with
   * a chevron; clicking opens an inline list of projects. Pinned at the
   * top of project-scoped screens (Inbox / Grid / Kanban) in place of
   * the old static title.
   *
   * Reads / writes `projectScope`; mirrors the fetch pattern from the
   * (now-removed) sidebar selector, including the stale-id eviction on
   * load.
   */
  import { tick } from 'svelte';
  import {
    autoUpdate,
    computePosition,
    flip,
    offset,
  } from '@floating-ui/dom';
  import { getDispatcher } from '../dispatch/context';
  import type { CardWithAttrs, ID } from '../reg/types';
  import { navigate, routerState } from '../routing/router.svelte';
  import { screenUrl } from '../routing/routes';
  import { isTemplate } from '../screens/admin/admin_projects_helpers';
  import { cx } from '../util/class_names';
  import { projectScope } from './project_scope.svelte';
  import { projectsStore, watchProjects } from './projects_store.svelte';

  const dispatcher = getDispatcher();

  // Lazy-load shared projects cache; auto-refetch on projectsVersion bumps.
  $effect(watchProjects(dispatcher));

  const projects = $derived(projectsStore.projects);
  const loaded = $derived(projectsStore.loaded);

  function titleOf(c: CardWithAttrs): string {
    const t = c.attributes['title'];
    return typeof t === 'string' && t.length > 0 ? t : `#${c.id}`;
  }

  const activeLabel = $derived.by((): string => {
    const pid = projectScope.projectId;
    if (pid === null) return 'All projects';
    const found = projects.find((p) => p.id === pid);
    if (found !== undefined) return titleOf(found);
    return loaded ? `#${pid}` : '…';
  });

  type Opt = { id: ID | null; label: string; template: boolean };
  const options = $derived.by((): Opt[] => {
    const out: Opt[] = [{ id: null, label: 'All projects', template: false }];
    for (const p of projects) {
      out.push({ id: p.id, label: titleOf(p), template: isTemplate(p) });
    }
    return out;
  });

  /**
   * Templates toggle is only exposed under /admin/* — pickers on regular
   * routes never need to surface template projects. The route check is
   * a string prefix off the live path so it tracks navigation reactively.
   */
  const inAdminMode = $derived(routerState.path.startsWith('/admin'));

  let open = $state(false);
  let query = $state('');
  let triggerEl: HTMLButtonElement | null = $state(null);
  let popupEl: HTMLDivElement | null = $state(null);
  let searchEl: HTMLInputElement | null = $state(null);
  let cleanupFloat: (() => void) | null = null;

  const filtered = $derived.by((): Opt[] => {
    const q = query.trim().toLowerCase();
    if (q === '') return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  });

  async function openMenu(): Promise<void> {
    open = true;
    query = '';
    await tick();
    if (!triggerEl || !popupEl) return;
    cleanupFloat?.();
    cleanupFloat = autoUpdate(triggerEl, popupEl, () => {
      if (!triggerEl || !popupEl) return;
      void computePosition(triggerEl, popupEl, {
        placement: 'bottom-start',
        middleware: [offset(4), flip()],
      }).then(({ x, y }) => {
        if (!popupEl) return;
        Object.assign(popupEl.style, {
          left: `${x}px`,
          top: `${y}px`,
          opacity: '1',
          pointerEvents: 'auto',
        });
      });
    });
    if (projects.length > 8) searchEl?.focus();
  }

  function closeMenu(): void {
    open = false;
    cleanupFloat?.();
    cleanupFloat = null;
  }

  /**
   * Resolve where to land after picking a project (or "All projects").
   *
   * Rule: only navigate when the project id is actually IN the URL. On
   * /admin/*, /projects, /activity, /task/:id, … the project lives in
   * `projectScope` (which downstream screens read reactively); jumping
   * to /project/X would yank the user off the screen they're managing.
   *
   *   pick X         + on /project/:id/screen/:slug  →  /project/X/screen/:slug
   *   pick X         + on /project/:id (bare)        →  /project/X
   *   pick X         + anywhere else                 →  scope only, no nav
   *   pick null      + on /project/...               →  /projects
   *   pick null      + anywhere else                 →  scope only, no nav
   *
   * Returns null when the caller should not navigate.
   */
  function nextPathFor(id: ID | null, currentPath: string): string | null {
    const screenMatch = currentPath.match(
      /^\/project\/[^/]+\/screen\/([^/]+)/,
    );
    const onProjectUrl = currentPath.startsWith('/project/');
    if (id !== null) {
      if (screenMatch !== null) return screenUrl(id, screenMatch[1] as string);
      if (onProjectUrl) return `/project/${id.toString()}`;
      return null;
    }
    if (onProjectUrl) return '/projects';
    return null;
  }

  function pick(id: ID | null): void {
    projectScope.setProject(id);
    closeMenu();
    triggerEl?.focus();
    const target = nextPathFor(id, routerState.path);
    if (target !== null && target !== routerState.path) navigate(target);
  }

  function onDocPointerDown(e: PointerEvent): void {
    if (!open) return;
    const t = e.target as Node | null;
    if (!t) return;
    if (popupEl?.contains(t)) return;
    if (triggerEl?.contains(t)) return;
    closeMenu();
  }

  function onTriggerKeydown(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void openMenu();
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      closeMenu();
    }
  }

  $effect(() => {
    if (open) {
      document.addEventListener('pointerdown', onDocPointerDown, true);
      return () => {
        document.removeEventListener('pointerdown', onDocPointerDown, true);
      };
    }
    return undefined;
  });

  $effect(() => {
    return () => {
      cleanupFloat?.();
    };
  });
</script>

<div class="relative inline-flex max-w-full">
  <button
    bind:this={triggerEl}
    type="button"
    class="inline-flex max-w-[14rem] items-center gap-1 rounded px-1.5 py-0.5 text-sm font-medium text-fg hover:bg-border/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label="Switch project"
    data-testid="project-title-picker"
    onclick={() => (open ? closeMenu() : void openMenu())}
    onkeydown={onTriggerKeydown}
  >
    <span class="truncate">{activeLabel}</span>
    <svg viewBox="0 0 12 12" class="h-3 w-3 shrink-0 text-muted" aria-hidden="true">
      <path
        d="M2 4 L6 8 L10 4"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        fill="none"
      />
    </svg>
  </button>

  {#if open}
    <div
      bind:this={popupEl}
      class="z-50 flex w-64 flex-col overflow-hidden rounded-md border border-border bg-bg shadow-lg"
      style="position: fixed; left: 0; top: 0; opacity: 0; pointer-events: none;"
    >
      {#if inAdminMode}
        <!-- Admin-only template toggle. Flipping it bumps
             projectsVersion so the shared cache refetches without the
             is_template != true predicate; templates then appear in
             the listbox below with a "(tpl)" chip. -->
        <label
          class="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted hover:bg-surface"
        >
          <input
            type="checkbox"
            checked={projectScope.showTemplates}
            data-testid="project-picker-show-templates"
            onchange={(e) =>
              projectScope.setShowTemplates(
                (e.target as HTMLInputElement).checked,
              )}
          />
          <span>Show templates</span>
        </label>
      {/if}
      {#if projects.length > 8}
        <div class="border-b border-border p-1.5">
          <input
            bind:this={searchEl}
            type="text"
            placeholder="Search projects…"
            bind:value={query}
            class="w-full rounded border border-border bg-bg px-2 py-1 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </div>
      {/if}
      <ul
        role="listbox"
        aria-label="Projects"
        class="max-h-72 flex-1 overflow-auto py-1 text-sm"
      >
        {#if filtered.length === 0}
          <li class="px-3 py-2 text-muted">
            {loaded ? 'No matches' : 'Loading…'}
          </li>
        {:else}
          {#each filtered as opt (opt.id ?? '__all__')}
            {@const selected = opt.id === projectScope.projectId}
            <li>
              <button
                type="button"
                role="option"
                aria-selected={selected}
                class={cx(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface',
                  selected ? 'font-medium text-accent' : 'text-fg',
                )}
                onclick={() => pick(opt.id)}
              >
                <span class="truncate">{opt.label}</span>
                {#if opt.template}
                  <span
                    class="ml-auto shrink-0 rounded border border-border px-1 text-[10px] uppercase tracking-wide text-muted"
                  >tpl</span>
                {/if}
              </button>
            </li>
          {/each}
        {/if}
      </ul>
    </div>
  {/if}
</div>
