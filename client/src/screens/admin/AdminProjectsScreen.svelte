<!--
  AdminProjectsScreen — admin-only list of every project (template +
  regular) with affordances for the template-aware workflow that landed
  in Gates 10–12 of FLOW_AND_SCREEN_KERNEL.

  The user-facing /projects screen ships the `is_template != true`
  exclusion leaf so end-users never see template projects. This admin
  screen omits that exclusion and renders:

    - One row per project, ordered by title.
    - A "Template" badge column that lights up when the row's
      `is_template` attribute is truthy.
    - A "is_template" toggle per row (V27): any user with
      attribute.update rights on the project card_type can flip the bit
      via `attribute.update`. Flipping to true makes the project
      disappear from user lists; flipping to false makes it reappear.
    - A "Stamp from this template" affordance per template row: opens a
      tiny prompt for the new project's name, then dispatches
      `project.stamp`, navigates to the freshly-stamped project on
      success.

  Header toggle "Show templates" (default OFF) hides template projects
  from this list too — admins start with the same view a normal user
  sees and opt in via the toggle.

  Wire surface (no new endpoints beyond the existing ones):
    - card.select_with_attributes  (card_type_name='project'; no
                                    is_template filter)
    - attribute.update             (toggle is_template)
    - project.stamp                (stamp new project from template)

  Keyboard:
    - `/`  focus the search input
    - `j` / `k` navigate the project list

  No initial-batch coalescing here — the screen issues a single fetch and
  the mutations route through their own request paths.
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';

  import { BatchAbortedError, SubRequestError } from '../../dispatch/errors';
  import { getDispatcher } from '../../dispatch/context';
  import { setActiveScope, useShortcut } from '../../keys/shortcut';
  import { useQuickEntry } from '../../quick_entry/use_quick_entry.svelte';
  import QuickEntryOverlay from '../../quick_entry/QuickEntryOverlay.svelte';
  import { projectScope } from '../../shell/project_scope.svelte';
  import {
    attributeUpdate,
    cardSelectWithAttributes,
    projectStamp,
  } from '../../reg/handlers';
  import type {
    AttributeUpdateInput,
    AttributeUpdateOutput,
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWithAttrs,
    ID,
    ProjectStampInput,
    ProjectStampOutput,
  } from '../../reg/types';
  import { navigate } from '../../routing/router.svelte';
  import Button from '../../ui/Button.svelte';
  import EmptyState from '../../ui/EmptyState.svelte';
  import Modal from '../../ui/Modal.svelte';
  import Spinner from '../../ui/Spinner.svelte';
  import { notify } from '../../ui/toast.svelte';
  import { cx } from '../../util/class_names';

  import {
    applyProjectFilters,
    errMsg,
    isTemplate,
    projectTitle,
    validateStampName,
  } from './admin_projects_helpers';

  setActiveScope('admin_projects');

  const dispatcher = getDispatcher();

  /* ---------------------------------------------------------------- state */

  let projects = $state<CardWithAttrs[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  /** Substring filter against title (case-insensitive). */
  let search = $state('');

  /** Header toggle. Default OFF — admins start with the user view. */
  let showTemplates = $state(false);

  /** Per-row pending state for the is_template checkbox so the UI doesn't
   *  let the operator double-toggle while the round-trip is in flight. */
  let togglingId = $state<ID | null>(null);

  /** Stamp dialog state. */
  let stampOpen = $state(false);
  let stampSourceId = $state<ID | null>(null);
  let stampName = $state('');
  let stampSubmitting = $state(false);
  let stampError = $state<string | null>(null);

  let searchEl: HTMLInputElement | null = $state(null);

  /* ----------------------------------------------------------- data fetch */

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      const data: CardSelectWithAttributesInput = { cardTypeName: 'project' };
      const out = await dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data,
      });
      projects = out.rows;
      loading = false;
    } catch (e) {
      loading = false;
      if (e instanceof SubRequestError) {
        error = e.message;
      } else if (e instanceof BatchAbortedError) {
        error = e.reason;
      } else {
        error = e instanceof Error ? e.message : String(e);
      }
    }
  }

  /* -------------------------------------------------------- derived data */

  const visible = $derived<CardWithAttrs[]>(
    applyProjectFilters(projects, search, showTemplates).slice().sort((a, b) => {
      const ta = projectTitle(a).toLowerCase();
      const tb = projectTitle(b).toLowerCase();
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    }),
  );

  const templateCount = $derived<number>(
    projects.filter((p) => isTemplate(p)).length,
  );

  /* --------------------------------------------------- mutations: toggle */

  async function toggleIsTemplate(card: CardWithAttrs): Promise<void> {
    if (togglingId !== null) return;
    togglingId = card.id;
    const next = !isTemplate(card);
    try {
      const data: AttributeUpdateInput = {
        cardId: card.id,
        attributeName: 'is_template',
        value: next,
      };
      await dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
        endpoint: attributeUpdate.endpoint,
        action: attributeUpdate.action,
        data,
      });
      notify({
        type: 'success',
        message: next
          ? `Marked "${projectTitle(card)}" as a template`
          : `Cleared template flag on "${projectTitle(card)}"`,
      });
      await refresh();
    } catch (e) {
      notify({
        type: 'error',
        message: `Toggle failed: ${errMsg(e)}`,
      });
    } finally {
      togglingId = null;
    }
  }

  /* ---------------------------------------------------- mutations: stamp */

  function openStampDialog(card: CardWithAttrs): void {
    stampSourceId = card.id;
    stampName = `Copy of ${projectTitle(card)}`;
    stampError = null;
    stampOpen = true;
  }

  function closeStampDialog(): void {
    stampOpen = false;
    stampSubmitting = false;
    stampSourceId = null;
    stampName = '';
    stampError = null;
  }

  async function submitStamp(): Promise<void> {
    if (stampSourceId === null) return;
    const v = validateStampName(stampName);
    if (!v.ok) {
      stampError = v.error;
      return;
    }
    stampError = null;
    stampSubmitting = true;
    try {
      const data: ProjectStampInput = {
        templateProjectId: stampSourceId,
        name: v.name,
      };
      const out = await dispatcher.request<
        ProjectStampInput,
        ProjectStampOutput
      >({
        endpoint: projectStamp.endpoint,
        action: projectStamp.action,
        data,
      });
      notify({
        type: 'success',
        message: `Stamped new project "${v.name}"`,
      });
      const warnings = out.warnings;
      if (warnings !== undefined) {
        for (const w of warnings) {
          if (w === '') continue;
          notify({ type: 'info', message: w });
        }
      }
      const newId = out.new_project_id;
      closeStampDialog();
      // Refresh in the background so the freshly-stamped project shows
      // up on the next admin visit; meanwhile navigate to the project's
      // default screen so the user lands on the new card.
      void refresh();
      navigate(`/project/${newId.toString()}`);
    } catch (e) {
      stampError = errMsg(e);
      stampSubmitting = false;
    }
  }

  /* ---------------------------------------------------- keyboard helpers */

  async function focusSearch(): Promise<void> {
    await tick();
    searchEl?.focus();
    searchEl?.select();
  }

  useShortcut('admin_projects', '/', () => void focusSearch(), 'Focus search', {
    fireInInputs: false,
  });

  /* --------------------------------------------------- new project flow */

  /**
   * Project creation lives here so the admin can spin up a new project
   * without leaving /admin/projects. After creation we refresh the local
   * table and bump the shared store so the title-bar picker sees it too.
   */
  const qe = useQuickEntry({
    scope: 'admin_projects',
    defaultCardType: 'project',
    onCreated: () => {
      projectScope.notifyProjectsChanged();
      void refresh();
    },
  });

  useShortcut('admin_projects', 'n', () => qe.open(), 'New project', {
    fireInInputs: false,
  });

  /* ------------------------------------------------------------- mount */

  onMount(() => {
    void refresh();
  });
</script>

<div class="flex h-full flex-col">
  <header class="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
    <div class="flex items-center gap-3">
      <h1 class="text-xl font-semibold">Admin &middot; Projects</h1>
      <span class="text-xs text-muted">
        {projects.length} total &middot; {templateCount} template{templateCount === 1 ? '' : 's'}
      </span>
    </div>
    <div class="flex items-center gap-4">
      <label class="flex items-center gap-2 text-sm text-fg">
        <input
          type="checkbox"
          bind:checked={showTemplates}
          class="h-4 w-4 rounded border-border"
          data-testid="show-templates-toggle"
        />
        <span>Show templates</span>
      </label>
      <span data-testid="admin-projects-new">
        <Button variant="primary" size="sm" onclick={() => qe.open()}>
          {#snippet children()}+ New project{/snippet}
        </Button>
      </span>
    </div>
  </header>

  {#if loading && projects.length === 0}
    <div class="flex flex-1 items-center justify-center">
      <Spinner size="lg" />
    </div>
  {:else if error !== null}
    <div
      role="alert"
      class="m-4 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      Failed to load: {error}
      <button type="button" class="ml-3 underline" onclick={() => void refresh()}>
        Retry
      </button>
    </div>
  {:else}
    <div class="flex flex-col gap-2 px-4 py-3">
      <input
        type="search"
        bind:this={searchEl}
        bind:value={search}
        placeholder="Search projects&hellip; (press / to focus)"
        aria-label="Search projects by title"
        class={cx(
          'w-full rounded-md border border-border bg-bg px-3 py-2 text-sm',
          'text-fg placeholder:text-muted',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        )}
      />
    </div>

    {#if visible.length === 0}
      <div class="flex flex-1 items-center justify-center">
        <EmptyState
          title={projects.length === 0 ? 'No projects' : 'No projects match'}
          description={projects.length === 0
            ? 'Create a project from /projects, or stamp one from a template.'
            : 'Try toggling "Show templates" or clearing the search.'}
        />
      </div>
    {:else}
      <div class="flex-1 overflow-auto px-4 pb-4">
        <table class="w-full text-sm">
          <thead class="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" class="py-2 pr-3">Title</th>
              <th scope="col" class="py-2 pr-3">Template</th>
              <th scope="col" class="py-2 pr-3">is_template</th>
              <th scope="col" class="py-2 pr-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            {#each visible as project (project.id)}
              {@const tpl = isTemplate(project)}
              <tr data-testid="admin-projects-row" data-project-id={project.id.toString()}>
                <td class="py-2 pr-3">
                  <a
                    href={`/project/${project.id.toString()}`}
                    class="font-medium text-fg hover:underline focus:underline"
                    onclick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                      e.preventDefault();
                      navigate(`/project/${project.id.toString()}`);
                    }}
                  >
                    {projectTitle(project)}
                  </a>
                </td>
                <td class="py-2 pr-3">
                  {#if tpl}
                    <span
                      class="inline-flex items-center rounded-md bg-accent/20 px-2 py-0.5 text-xs font-medium text-accent"
                      data-testid="template-badge"
                    >
                      Template
                    </span>
                  {:else}
                    <span class="text-xs text-muted">&mdash;</span>
                  {/if}
                </td>
                <td class="py-2 pr-3">
                  <label class="inline-flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={tpl}
                      disabled={togglingId !== null}
                      data-testid="is-template-toggle"
                      onchange={() => void toggleIsTemplate(project)}
                      aria-label={`Toggle is_template on ${projectTitle(project)}`}
                      class="h-4 w-4 rounded border-border"
                    />
                    <span class="text-muted">{tpl ? 'true' : 'false'}</span>
                  </label>
                </td>
                <td class="py-2 pr-3 text-right">
                  {#if tpl}
                    <Button
                      variant="secondary"
                      size="sm"
                      onclick={() => openStampDialog(project)}
                    >
                      {#snippet children()}Stamp new project{/snippet}
                    </Button>
                  {:else}
                    <span class="text-xs text-muted">&mdash;</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>

<!-- ============================================== Stamp-from-template dialog -->
<Modal
  bind:open={stampOpen}
  title="Stamp new project from template"
  size="sm"
  onClose={closeStampDialog}
>
  {#snippet children()}
    <div class="flex flex-col gap-3 text-sm text-fg">
      <p class="text-muted">
        Copies the template's value cards, flow, screens, and filters into
        a fresh project. Tasks, comments, and per-user state are not
        copied.
      </p>
      <label class="flex flex-col gap-1">
        <span class="text-xs font-medium text-muted">New project name</span>
        <input
          type="text"
          bind:value={stampName}
          data-testid="stamp-name-input"
          class={cx(
            'rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          )}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submitStamp();
            }
          }}
        />
      </label>
      {#if stampError !== null}
        <div
          role="alert"
          class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          {stampError}
        </div>
      {/if}
    </div>
  {/snippet}
  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={closeStampDialog}>
      {#snippet children()}Cancel{/snippet}
    </Button>
    <Button
      variant="primary"
      size="sm"
      loading={stampSubmitting}
      disabled={stampSubmitting}
      onclick={() => void submitStamp()}
    >
      {#snippet children()}Stamp{/snippet}
    </Button>
  {/snippet}
</Modal>

<QuickEntryOverlay {...qe.props} />
