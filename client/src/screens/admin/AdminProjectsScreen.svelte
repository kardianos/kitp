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
  import { clearHelpTopic, setHelpTopic } from '../../help/help_context.svelte';
  import { setActiveScope, useShortcut } from '../../keys/shortcut';
  import { useQuickEntry } from '../../quick_entry/use_quick_entry.svelte';
  import QuickEntryOverlay from '../../quick_entry/QuickEntryOverlay.svelte';
  import { projectScope } from '../../shell/project_scope.svelte';
  import {
    attributeUpdate,
    cardSelectWithAttributes,
  } from '../../reg/handlers';
  import type {
    AttributeUpdateInput,
    AttributeUpdateOutput,
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWithAttrs,
    ID,
    ProjectStampOutput,
  } from '../../reg/types';
  import { navigate } from '../../routing/router.svelte';
  import Button from '../../ui/Button.svelte';
  import EmptyState from '../../ui/EmptyState.svelte';
  import ErrorAlert from '../../ui/ErrorAlert.svelte';
  import Modal from '../../ui/Modal.svelte';
  import PageShell from '../../ui/PageShell.svelte';
  import Spinner from '../../ui/Spinner.svelte';
  import Checkbox from '../../ui/inputs/Checkbox.svelte';
  import TextInput from '../../ui/inputs/TextInput.svelte';
  import {
    Form,
    FormErrors,
    SubmitButton,
    TextInput as FormTextInput,
  } from '../../forms';
  import { notify } from '../../ui/toast.svelte';
  import { cx } from '../../util/class_names';

  import {
    applyProjectFilters,
    errMsg,
    isTemplate,
    projectTitle,
  } from './admin_projects_helpers';

  setActiveScope('admin_projects');

  $effect(() => {
    setHelpTopic({ kind: 'topic', topic: 'admin.projects' });
    return () => clearHelpTopic();
  });

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

  /** Stamp dialog state — the <Form> kernel owns the draft + submitting
   *  state; the screen only tracks which template the dialog is for. */
  let stampOpen = $state(false);
  let stampSourceId = $state<ID | null>(null);
  let stampSourceTitle = $state('');

  const stampInitial = $derived.by((): Record<string, unknown> => {
    if (stampSourceId === null) return {};
    return {
      template_project_id: stampSourceId,
      name: `Copy of ${stampSourceTitle}`,
    };
  });

  const SEARCH_INPUT_ID = 'admin-projects-search';

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
    stampSourceTitle = projectTitle(card);
    stampOpen = true;
  }

  function closeStampDialog(): void {
    stampOpen = false;
    stampSourceId = null;
    stampSourceTitle = '';
  }

  function onStampSaved(out: unknown): void {
    // Cast: the server output decoder returned ProjectStampOutput-shaped
    // data. requestRaw doesn't run the registered decoder, so we narrow
    // by hand. Missing fields surface as the structural-type checks
    // below (warnings? new_project_id?).
    const r = (out ?? {}) as Partial<ProjectStampOutput> & {
      new_project_id?: unknown;
      warnings?: unknown;
    };
    const newId = typeof r.new_project_id === 'bigint'
      ? r.new_project_id
      : 0n;
    const nameDraft = stampSourceTitle;
    notify({
      type: 'success',
      message: `Stamped new project from "${nameDraft}"`,
    });
    if (Array.isArray(r.warnings)) {
      for (const w of r.warnings) {
        if (typeof w !== 'string' || w === '') continue;
        notify({ type: 'info', message: w });
      }
    }
    closeStampDialog();
    void refresh();
    if (newId !== 0n) navigate(`/project/${newId.toString()}`);
  }

  /* ---------------------------------------------------- keyboard helpers */

  async function focusSearch(): Promise<void> {
    await tick();
    const el = document.getElementById(SEARCH_INPUT_ID);
    if (el instanceof HTMLInputElement) {
      el.focus();
      el.select();
    }
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

<PageShell title="Admin · Projects" pad="none">
  {#snippet actions()}
    <span class="text-xs text-muted">
      {projects.length} total &middot; {templateCount} template{templateCount === 1 ? '' : 's'}
    </span>
    <label class="inline-flex items-center gap-2 text-sm text-fg" data-testid="show-templates-toggle">
      <Checkbox bind:checked={showTemplates} />
      Show templates
    </label>
    <span data-testid="admin-projects-new">
      <Button variant="primary" size="sm" onclick={() => qe.open()}>
        {#snippet children()}+ New project{/snippet}
      </Button>
    </span>
  {/snippet}
  {#snippet children()}
  {#if loading && projects.length === 0}
    <div class="flex h-full items-center justify-center">
      <Spinner size="lg" />
    </div>
  {:else if error !== null}
    <ErrorAlert
      class="m-4"
      message={`Failed to load: ${error}`}
      onRetry={() => void refresh()}
    />
  {:else}
    <div class="flex flex-col gap-2 px-4 py-3">
      <TextInput
        id={SEARCH_INPUT_ID}
        type="search"
        bind:value={search}
        placeholder="Search projects… (press / to focus)"
        aria-label="Search projects by title"
      />
    </div>

    {#if visible.length === 0}
      <div class="flex h-full items-center justify-center">
        <EmptyState
          title={projects.length === 0 ? 'No projects' : 'No projects match'}
          description={projects.length === 0
            ? 'Create a project from /projects, or stamp one from a template.'
            : 'Try toggling "Show templates" or clearing the search.'}
        />
      </div>
    {:else}
      <div class="overflow-auto px-4 pb-4">
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
                    <span data-testid="is-template-toggle">
                      <Checkbox
                        checked={tpl}
                        disabled={togglingId !== null}
                        onchange={() => void toggleIsTemplate(project)}
                        aria-label={`Toggle is_template on ${projectTitle(project)}`}
                      />
                    </span>
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
  {/snippet}
</PageShell>

<!-- ============================================== Stamp-from-template dialog -->
<Modal
  bind:open={stampOpen}
  title="Stamp new project from template"
  size="sm"
  onClose={closeStampDialog}
>
  {#snippet children()}
    {#key stampSourceId}
      <Form
        spec="project.stamp"
        initial={stampInitial}
        onSaved={onStampSaved}
        class="flex flex-col gap-3 text-sm text-fg"
      >
        <p class="text-muted">
          Copies the template's value cards, flow, screens, and filters into
          a fresh project. Tasks, comments, and per-user state are not
          copied.
        </p>
        <FormErrors />
        <span data-testid="stamp-name-input">
          <FormTextInput path="name" label="New project name" />
        </span>
        <div class="mt-2 flex items-center justify-end gap-2 border-t border-border pt-3">
          <Button variant="ghost" size="sm" onclick={closeStampDialog}>
            {#snippet children()}Cancel{/snippet}
          </Button>
          <SubmitButton size="sm">Stamp</SubmitButton>
        </div>
      </Form>
    {/key}
  {/snippet}
</Modal>

<QuickEntryOverlay {...qe.props} />
