<!--
  ScreenHost — dispatch entry for every per-project screen URL.

  Gate 9 (FLOW_AND_SCREEN_KERNEL) collapses the per-layout routes
  (`/inbox`, `/grid`, `/kanban`, `/project/:id`) into a single shape:
  `/project/:id/screen/:slug`. This component resolves the screen card by
  `(parent_card_id=projectId, slug)`, reads its `layout` attribute, and
  mounts one of four body components:

    - `list`    -> InboxLayout      (the per-user task list)
    - `grid`    -> GridLayout       (dense sortable table)
    - `kanban`  -> KanbanLayout     (column board)
    - `project` -> ProjectLayout    (project header + task list)

  The body components were the former top-level screens before the
  rename. They still own their data fetch / filter bar / quick-entry —
  ScreenHost's job is purely the lookup + dispatch + project-scope
  sync. A future gate (per the spec) lifts the data fetch up here.

  Failure modes rendered inline (no navigation away):
    - Bad / missing project id  → "Invalid project id."
    - Screen card not found     → "Screen not found." plus a back link.
    - Project loads but screen card lacks a `layout` we recognise → same.
    - Future: `view_requires_role` mismatch → "Forbidden." For now the
      screen card list is already loaded so we surface the guard here as
      well as in the sidebar; admins still see every screen.
-->
<script lang="ts">
  import { getContext } from 'svelte';
  import type { Component } from 'svelte';

  import { getDispatcher } from '../dispatch/context';
  import { cardSelectWithAttributes } from '../reg/handlers';
  import type {
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWithAttrs,
    ID,
  } from '../reg/types';

  import {
    readLayout,
    readSlug,
  } from '../filter/screen_preset.svelte';
  import { clearHelpTopic, setHelpTopic } from '../help/help_context.svelte';
  import { setActiveScope } from '../keys/shortcut';
  import { projectScope } from '../shell/project_scope.svelte';
  import { navigate } from '../routing/router.svelte';
  import type { AuthState } from '../auth/auth_state.svelte';

  import EmptyState from '../ui/EmptyState.svelte';
  import Spinner from '../ui/Spinner.svelte';

  import InboxLayout from './InboxLayout.svelte';
  import GridLayout from './GridLayout.svelte';
  import KanbanLayout from './KanbanLayout.svelte';
  import ProjectLayout from './ProjectLayout.svelte';

  /* ----------------------------------------------------------------- props */

  interface Props {
    params?: Record<string, string>;
  }
  let { params = {} }: Props = $props();

  setActiveScope('screen_host');

  const dispatcher = getDispatcher();
  const authState = getContext<AuthState | undefined>('authState');

  /* ----------------------------------------------------------------- ids */

  // Capture the route params at mount time. The router unmounts +
  // remounts on path change (different :slug or :id), so a snapshot is
  // sufficient — the rune dependency would just churn for no reason.
  // svelte-ignore state_referenced_locally
  const projectId = $derived.by((): ID | null => {
    const raw = params['id'] ?? '';
    if (raw === '') return null;
    try {
      const n = BigInt(raw);
      return n > 0n ? n : null;
    } catch {
      return null;
    }
  });

  const slug = $derived.by((): string => {
    const raw = params['slug'] ?? '';
    return typeof raw === 'string' ? raw : '';
  });

  /* ---------------------------------------------------- project scope sync */

  // Visiting any screen URL pins the global project scope so the
  // sidebar picker and other affordances follow along. Idempotent; the
  // store dedupes equal writes.
  $effect(() => {
    const id = projectId;
    if (id !== null && id > 0n) projectScope.setProject(id);
  });

  /* ------------------------------------------------------------- state */

  let loading = $state(true);
  let error = $state<string | null>(null);
  let screen = $state<CardWithAttrs | null>(null);

  /**
   * Fetch the screen card by `(parent_card_id=projectId, slug)`. We use
   * the existing `card.select_with_attributes` handler with a parent
   * filter, then pick by slug client-side — same posture as
   * `screen_preset.svelte.ts`'s `loadScreenAndFilters` (no dedicated
   * server query for this lookup yet). The wire fan-out is one
   * sub-request; the dispatcher folds it into the per-tick batch.
   */
  async function loadScreen(): Promise<void> {
    loading = true;
    error = null;
    screen = null;
    const id = projectId;
    if (id === null) {
      loading = false;
      error = 'Invalid project id.';
      return;
    }
    const wanted = slug;
    if (wanted === '') {
      loading = false;
      error = 'Missing screen slug.';
      return;
    }
    try {
      const out = await dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: { cardTypeName: 'screen', parentCardId: id },
      });
      const match = out.rows.find((r) => readSlug(r) === wanted) ?? null;
      screen = match;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  // Re-fetch whenever the (projectId, slug) pair changes. The router
  // unmounts and remounts on path change today, but the fetch is keyed
  // off the runes so a future router that reuses the component on
  // adjacent navigations would still refresh.
  $effect(() => {
    void projectId;
    void slug;
    void loadScreen();
  });

  // Publish the help topic for the help-modal button as soon as the
  // screen card resolves. Cleared on unmount so the next screen's
  // mount overwrites cleanly instead of inheriting our id.
  $effect(() => {
    const s = screen;
    if (s !== null) {
      setHelpTopic({ kind: 'screen', screenCardId: s.id });
    }
    return () => clearHelpTopic();
  });

  /* --------------------------------------------------- access control */

  /**
   * The screen card's `view_requires_role` attribute (card_ref → role).
   * When set and the actor lacks the role, we render Forbidden and stop.
   * Admins always pass. Today this is a no-op for every seeded screen
   * (none carry the attribute); the gate exists so future role-locked
   * screens (e.g. an internal-only Ideas backlog) hide cleanly via
   * data only — no per-screen branching code.
   */
  const viewRequiresRole = $derived.by((): ID | null => {
    if (screen === null) return null;
    const v = screen.attributes['view_requires_role'];
    return typeof v === 'bigint' ? v : null;
  });

  // Best-effort role check. `AuthState.isAdmin` flag exists; the per-role
  // grant table isn't shipped to the client yet, so for now any
  // non-admin actor is conservatively blocked when the attribute is set.
  // When the role-grant feed lands the check becomes data-driven.
  const forbidden = $derived(
    viewRequiresRole !== null && authState?.isAdmin !== true,
  );

  /* --------------------------------------------------- layout dispatch */

  type AnyComponent = Component<Record<string, unknown>, Record<string, unknown>, string>;

  const layout = $derived.by((): string | null => {
    if (screen === null) return null;
    return readLayout(screen);
  });

  // Eight cases collapsed into a four-way map. Unknown layouts fall
  // through to the "Screen not found" state — the kernel's `layout`
  // attribute is unvalidated text on the wire, so the renderer is the
  // authoritative gate.
  const Body = $derived.by((): AnyComponent | null => {
    switch (layout) {
      case 'list':
        return InboxLayout as AnyComponent;
      case 'grid':
        return GridLayout as AnyComponent;
      case 'kanban':
        return KanbanLayout as AnyComponent;
      case 'project':
        return ProjectLayout as AnyComponent;
      default:
        return null;
    }
  });

  /**
   * The Project layout's existing data fetch keys off `params.id`
   * (project id). Every other layout reads `projectScope.projectId`
   * implicitly. We forward the `params` record so ProjectLayout stays a
   * drop-in body; the other three layouts ignore the prop today and
   * still pick up the project scope we set above.
   */
  const childParams = $derived(params);
</script>

{#if loading && screen === null}
  <div class="flex flex-1 items-center justify-center" data-testid="screen-host-loading">
    <Spinner size="lg" />
  </div>
{:else if error !== null}
  <div class="flex flex-1 items-center justify-center p-6" data-testid="screen-host-error">
    <EmptyState
      title="Failed to load screen"
      description={error}
      action={{ label: 'Back to projects', onClick: () => navigate('/projects') }}
    />
  </div>
{:else if forbidden}
  <div class="flex flex-1 items-center justify-center p-6" data-testid="screen-host-forbidden">
    <EmptyState
      title="Forbidden"
      description="You don't have access to this screen."
      action={{ label: 'Back to projects', onClick: () => navigate('/projects') }}
    />
  </div>
{:else if screen === null || Body === null}
  <div class="flex flex-1 items-center justify-center p-6" data-testid="screen-host-not-found">
    <EmptyState
      title="Screen not found"
      description={`No screen with slug "${slug}" in this project.`}
      action={{ label: 'Back to projects', onClick: () => navigate('/projects') }}
    />
  </div>
{:else}
  {@const Comp = Body}
  <Comp params={childParams} />
{/if}
