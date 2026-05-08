<!--
  AdminWorkflowsScreen.

  Master/detail layout for managing workflow_def cards. workflow_def is
  a card_type, so CRUD goes through the regular card endpoints; this
  screen layers a workflow-shaped UX on top:

    - Master pane (~280px): list of workflow_def cards in the active
      project scope. Click to select.
    - Detail pane: the selected workflow's title, states (comma-separated
      text edit), initial_state, and transitions matrix. Saving the
      transitions calls workflow_transition.set in one batch.

  Initial-batch contract — one sub-request:
    1. card.select_with_attributes (card_type_name='workflow_def').

  Transitions are loaded on selection via workflow_transition.list.
  Saved via workflow_transition.set (bulk replace).
-->
<script lang="ts">
  import { onMount } from 'svelte';

  import { getDispatcher } from '../../dispatch/context';
  import { setActiveScope } from '../../keys/shortcut';
  import {
    attributeUpdate,
    cardDelete,
    cardInsert,
    cardSelectWithAttributes,
  } from '../../reg/handlers';
  import {
    workflowTransitionList,
    workflowTransitionSet,
  } from '../../reg/handlers_admin';
  import { projectScope } from '../../shell/project_scope.svelte';
  import type {
    AttributeUpdateInput,
    AttributeUpdateOutput,
    CardDeleteInput,
    CardDeleteOutput,
    CardInsertInput,
    CardInsertOutput,
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWithAttrs,
    WorkflowTransitionListInput,
    WorkflowTransitionListOutput,
    WorkflowTransitionRow,
    WorkflowTransitionSetInput,
    WorkflowTransitionSetOutput,
  } from '../../reg/types';
  import AggregateGuardEditor from '../../ui/widgets/AggregateGuardEditor.svelte';
  import Button from '../../ui/Button.svelte';
  import Spinner from '../../ui/Spinner.svelte';
  import { notify } from '../../ui/toast.svelte';
  import { cx } from '../../util/class_names';

  setActiveScope('admin_workflows');

  const dispatcher = getDispatcher();

  let workflows = $state<CardWithAttrs[]>([]);
  let selectedId = $state<number | null>(null);
  let transitions = $state<WorkflowTransitionRow[]>([]);
  let gateTemplates = $state<CardWithAttrs[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Local edit buffers; sync from selection.
  let editStates = $state('');
  let editInitial = $state('');
  let editTransitions = $state<
    { from: string; to: string; guard: unknown | undefined }[]
  >([]);
  let saving = $state(false);

  // New-workflow form state.
  let creatingOpen = $state(false);
  let newTitle = $state('');
  let newStates = $state('triaged, in_review, done');
  let newInitial = $state('triaged');
  let creating = $state(false);

  const selectedWorkflow = $derived(
    workflows.find((w) => w.id === selectedId) ?? null,
  );

  $effect(() => {
    const w = selectedWorkflow;
    if (w === null) {
      editStates = '';
      editInitial = '';
      editTransitions = [];
      return;
    }
    editStates = decodeStates(w.attributes['states']);
    editInitial = decodeText(w.attributes['initial_state']);
  });

  $effect(() => {
    if (selectedId === null) {
      gateTemplates = [];
      return;
    }
    void loadTransitions(selectedId);
    void loadGateTemplates(selectedId);
  });

  // New gate-template form state.
  let gtTitle = $state('');
  let gtKind = $state('signoff');
  let gtRequiredIn = $state('');
  let gtCreating = $state(false);

  function decodeText(v: unknown): string {
    if (typeof v === 'string') return v;
    return '';
  }

  function decodeStates(v: unknown): string {
    if (typeof v !== 'string') return '';
    // states is stored as a JSON array string, e.g. '["a","b"]'.
    // Display as comma-separated for editing.
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) return arr.join(', ');
    } catch {
      // fall through
    }
    return v;
  }

  function encodeStates(s: string): string {
    const parts = s
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '');
    return JSON.stringify(parts);
  }

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      const out = await dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: { cardTypeName: 'workflow_def' },
      });
      workflows = out.rows;
      if (workflows.length > 0 && (selectedId === null || !workflows.some((w) => w.id === selectedId))) {
        selectedId = workflows[0]!.id;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function loadGateTemplates(workflowId: number): Promise<void> {
    try {
      const out = await dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: { cardTypeName: 'gate_template', parentCardId: workflowId },
      });
      gateTemplates = out.rows;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Load gate templates failed: ${msg}` });
    }
  }

  function decodeRequiredInStates(v: unknown): string {
    if (typeof v !== 'string') return '';
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) return arr.join(', ');
    } catch {
      /* fall through */
    }
    return v;
  }

  function encodeRequiredInStates(s: string): string {
    const parts = s
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '');
    return JSON.stringify(parts);
  }

  async function addGateTemplate(): Promise<void> {
    if (selectedWorkflow === null) return;
    if (gtTitle.trim() === '') {
      notify({ type: 'error', message: 'Gate title is required' });
      return;
    }
    gtCreating = true;
    try {
      await dispatcher.request<CardInsertInput, CardInsertOutput>({
        endpoint: cardInsert.endpoint,
        action: cardInsert.action,
        data: {
          cardTypeName: 'gate_template',
          parentCardId: selectedWorkflow.id,
          title: gtTitle.trim(),
          attributes: {
            gate_kind: gtKind.trim() || 'signoff',
            required_in_states: encodeRequiredInStates(gtRequiredIn),
          },
        },
      });
      notify({ type: 'success', message: `Gate "${gtTitle.trim()}" added` });
      gtTitle = '';
      gtRequiredIn = '';
      await loadGateTemplates(selectedWorkflow.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Add failed: ${msg}` });
    } finally {
      gtCreating = false;
    }
  }

  async function deleteGateTemplate(t: CardWithAttrs): Promise<void> {
    const title = decodeText(t.attributes['title']) || `Gate ${t.id}`;
    if (!confirm(`Delete gate template "${title}"?`)) return;
    try {
      await dispatcher.request<CardDeleteInput, CardDeleteOutput>({
        endpoint: cardDelete.endpoint,
        action: cardDelete.action,
        data: { cardId: t.id },
      });
      notify({ type: 'success', message: `Deleted "${title}"` });
      if (selectedId !== null) await loadGateTemplates(selectedId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Delete failed: ${msg}` });
    }
  }

  async function loadTransitions(id: number): Promise<void> {
    try {
      const out = await dispatcher.request<
        WorkflowTransitionListInput,
        WorkflowTransitionListOutput
      >({
        endpoint: workflowTransitionList.endpoint,
        action: workflowTransitionList.action,
        data: { workflowDefId: id },
      });
      transitions = out.rows;
      editTransitions = out.rows.map((r) => ({
        from: r.from_state,
        to: r.to_state,
        guard: r.aggregate_guard ?? undefined,
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Load transitions failed: ${msg}` });
    }
  }

  function addTransition(): void {
    editTransitions = [
      ...editTransitions,
      { from: '', to: '', guard: undefined },
    ];
  }

  function setRowGuard(idx: number, g: unknown | undefined): void {
    editTransitions = editTransitions.map((row, i) =>
      i === idx ? { ...row, guard: g } : row,
    );
  }

  function removeTransition(idx: number): void {
    editTransitions = editTransitions.filter((_, i) => i !== idx);
  }

  async function save(): Promise<void> {
    if (selectedWorkflow === null) return;
    saving = true;
    try {
      // Save states + initial_state via attribute.update.
      const writes: Promise<AttributeUpdateOutput>[] = [];
      const statesValue = encodeStates(editStates);
      writes.push(
        dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
          endpoint: attributeUpdate.endpoint,
          action: attributeUpdate.action,
          data: {
            cardId: selectedWorkflow.id,
            attributeName: 'states',
            value: JSON.stringify(statesValue),
          },
        }),
      );
      writes.push(
        dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
          endpoint: attributeUpdate.endpoint,
          action: attributeUpdate.action,
          data: {
            cardId: selectedWorkflow.id,
            attributeName: 'initial_state',
            value: JSON.stringify(editInitial),
          },
        }),
      );
      // Save transitions in the same tick.
      const txn: Promise<WorkflowTransitionSetOutput> = dispatcher.request<
        WorkflowTransitionSetInput,
        WorkflowTransitionSetOutput
      >({
        endpoint: workflowTransitionSet.endpoint,
        action: workflowTransitionSet.action,
        data: {
          workflowDefId: selectedWorkflow.id,
          transitions: editTransitions
            .filter((t) => t.from !== '' && t.to !== '')
            .map((t) => {
              const m: { fromState: string; toState: string; aggregateGuard?: unknown } = {
                fromState: t.from,
                toState: t.to,
              };
              if (t.guard !== undefined) m.aggregateGuard = t.guard;
              return m;
            }),
        },
      });
      await Promise.all([...writes, txn]);
      notify({ type: 'success', message: 'Workflow saved' });
      await refresh();
      if (selectedId !== null) await loadTransitions(selectedId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Save failed: ${msg}` });
    } finally {
      saving = false;
    }
  }

  async function createWorkflow(): Promise<void> {
    if (newTitle.trim() === '') {
      notify({ type: 'error', message: 'Title is required' });
      return;
    }
    if (projectScope.projectId === null || projectScope.projectId === undefined) {
      notify({
        type: 'error',
        message: 'Pick a project in the sidebar before creating a workflow',
      });
      return;
    }
    const states = newStates
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    if (states.length === 0) {
      notify({ type: 'error', message: 'Add at least one state' });
      return;
    }
    const initial = newInitial.trim() === '' ? states[0]! : newInitial.trim();
    if (!states.includes(initial)) {
      notify({ type: 'error', message: `initial_state "${initial}" is not in the states list` });
      return;
    }
    creating = true;
    try {
      const out = await dispatcher.request<CardInsertInput, CardInsertOutput>({
        endpoint: cardInsert.endpoint,
        action: cardInsert.action,
        data: {
          cardTypeName: 'workflow_def',
          parentCardId: projectScope.projectId,
          title: newTitle.trim(),
          attributes: {
            states: JSON.stringify(states),
            initial_state: initial,
          },
        },
      });
      notify({ type: 'success', message: `Created workflow "${newTitle.trim()}"` });
      newTitle = '';
      newStates = 'triaged, in_review, done';
      newInitial = 'triaged';
      creatingOpen = false;
      await refresh();
      selectedId = out.id;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Create failed: ${msg}` });
    } finally {
      creating = false;
    }
  }

  onMount(() => {
    void refresh();
  });
</script>

<div class="flex h-full flex-col" data-testid="admin-workflows">
  <header class="flex items-center justify-between border-b border-border px-4 py-3">
    <h1 class="text-xl font-semibold">Admin · Workflows</h1>
    <span data-testid="new-workflow-button-wrap">
      <Button onclick={() => (creatingOpen = !creatingOpen)}>
        {creatingOpen ? 'Cancel' : '+ New workflow'}
      </Button>
    </span>
  </header>

  {#if creatingOpen}
    <div
      class="border-b border-border bg-surface-2 px-4 py-3"
      data-testid="new-workflow-form"
    >
      {#if projectScope.projectId === null || projectScope.projectId === undefined}
        <p class="mb-2 text-sm text-warn">
          Pick a project in the sidebar to scope the workflow to.
        </p>
      {/if}
      <div class="flex flex-wrap items-end gap-3">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-xs font-medium text-muted">Title</span>
          <input
            type="text"
            bind:value={newTitle}
            placeholder="e.g. Bug Lifecycle"
            data-testid="new-workflow-title"
            class={cx(
              'w-56 rounded-md border border-border bg-bg px-3 py-1.5 text-sm',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            )}
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-xs font-medium text-muted">States (comma-separated)</span>
          <input
            type="text"
            bind:value={newStates}
            data-testid="new-workflow-states"
            class={cx(
              'w-72 rounded-md border border-border bg-bg px-3 py-1.5 text-sm',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            )}
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-xs font-medium text-muted">Initial state</span>
          <input
            type="text"
            bind:value={newInitial}
            data-testid="new-workflow-initial"
            class={cx(
              'w-44 rounded-md border border-border bg-bg px-3 py-1.5 text-sm',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            )}
          />
        </label>
        <span data-testid="new-workflow-save-wrap">
          <Button onclick={() => void createWorkflow()} disabled={creating}>
            {creating ? 'Creating…' : 'Create'}
          </Button>
        </span>
      </div>
    </div>
  {/if}

  {#if loading && workflows.length === 0}
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
    <div class="flex flex-1 min-h-0">
      <aside
        class="flex w-[280px] shrink-0 flex-col gap-1 border-r border-border p-3"
        aria-label="Workflow list"
      >
        <p class="mb-2 text-xs text-muted">
          Workflow_def cards are created via the regular card flow.
          Pick one to edit its state graph.
        </p>
        <ul data-testid="workflow-list" class="flex flex-col gap-1">
          {#each workflows as wf (wf.id)}
            <li>
              <button
                type="button"
                class={cx(
                  'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm',
                  selectedId === wf.id
                    ? 'bg-accent/15 font-medium text-accent'
                    : 'hover:bg-surface-2',
                )}
                onclick={() => (selectedId = wf.id)}
                data-testid="workflow-row"
                data-row-id={wf.id}
              >
                <span>{decodeText(wf.attributes['title']) || `Workflow ${wf.id}`}</span>
              </button>
            </li>
          {:else}
            <li class="text-sm text-muted">
              No workflow_def cards yet.
            </li>
          {/each}
        </ul>
      </aside>

      <section
        class="flex flex-1 flex-col gap-4 overflow-y-auto p-4"
        data-testid="workflow-detail"
      >
        {#if selectedWorkflow === null}
          <p class="text-sm text-muted">Select a workflow to edit it.</p>
        {:else}
          <h2 class="text-lg font-medium">
            {decodeText(selectedWorkflow.attributes['title']) || `Workflow ${selectedWorkflow.id}`}
          </h2>

          <label class="flex flex-col gap-1 text-sm">
            <span class="text-xs font-medium text-muted">
              States (comma-separated)
            </span>
            <input
              type="text"
              bind:value={editStates}
              data-testid="workflow-states"
              class={cx(
                'w-full rounded-md border border-border bg-bg px-3 py-1.5 text-sm',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              )}
            />
          </label>

          <label class="flex flex-col gap-1 text-sm">
            <span class="text-xs font-medium text-muted">Initial state</span>
            <input
              type="text"
              bind:value={editInitial}
              data-testid="workflow-initial"
              class={cx(
                'w-72 rounded-md border border-border bg-bg px-3 py-1.5 text-sm',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              )}
            />
          </label>

          <div class="flex flex-col gap-2">
            <span class="text-xs font-medium text-muted">Transitions</span>
            <table
              class="w-full max-w-xl text-sm"
              data-testid="workflow-transitions"
            >
              <thead>
                <tr>
                  <th class="text-left font-medium">From</th>
                  <th class="text-left font-medium">To</th>
                  <th class="text-left font-medium">Aggregate guard (JSON)</th>
                  <th class="w-8"></th>
                </tr>
              </thead>
              <tbody>
                {#each editTransitions as t, i (i)}
                  <tr>
                    <td>
                      <input
                        type="text"
                        bind:value={t.from}
                        class="w-full rounded border border-border bg-bg px-2 py-1"
                        data-testid="transition-from"
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        bind:value={t.to}
                        class="w-full rounded border border-border bg-bg px-2 py-1"
                        data-testid="transition-to"
                      />
                    </td>
                    <td data-testid="transition-guard">
                      <AggregateGuardEditor
                        initial={t.guard}
                        onchange={(g) => setRowGuard(i, g)}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        class="text-muted hover:text-danger"
                        onclick={() => removeTransition(i)}
                        aria-label="Remove transition"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
            <span data-testid="add-transition-wrap">
              <Button onclick={addTransition} variant="secondary">
                + Add transition
              </Button>
            </span>
          </div>

          <div class="flex gap-2 pt-4">
            <span data-testid="save-workflow-wrap">
              <Button onclick={() => void save()} disabled={saving}>
                {saving ? 'Saving…' : 'Save workflow'}
              </Button>
            </span>
          </div>

          <div class="flex flex-col gap-2 pt-6 border-t border-border">
            <span class="text-xs font-medium text-muted">
              Gate templates (spawned as runtime gates when a card binds to this workflow)
            </span>
            <table
              class="w-full max-w-2xl text-sm"
              data-testid="workflow-gate-templates"
            >
              <thead>
                <tr>
                  <th class="text-left font-medium">Title</th>
                  <th class="text-left font-medium">Kind</th>
                  <th class="text-left font-medium">Required in states</th>
                  <th class="w-8"></th>
                </tr>
              </thead>
              <tbody>
                {#each gateTemplates as t (t.id)}
                  <tr data-testid="gate-template-row" data-template-id={t.id}>
                    <td>{decodeText(t.attributes['title']) || `#${t.id}`}</td>
                    <td>{decodeText(t.attributes['gate_kind']) || '—'}</td>
                    <td>{decodeRequiredInStates(t.attributes['required_in_states']) || '—'}</td>
                    <td>
                      <button
                        type="button"
                        class="text-muted hover:text-danger"
                        onclick={() => void deleteGateTemplate(t)}
                        aria-label="Delete gate template"
                        data-testid="gate-template-delete"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                {:else}
                  <tr>
                    <td colspan="4" class="text-sm text-muted py-2">
                      No gate templates yet.
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>

            <div
              class="flex flex-wrap items-end gap-3 rounded border border-border bg-surface-2 p-3"
              data-testid="new-gate-template-form"
            >
              <label class="flex flex-col gap-1 text-sm">
                <span class="text-xs font-medium text-muted">Title</span>
                <input
                  type="text"
                  bind:value={gtTitle}
                  placeholder="e.g. QA sign-off"
                  data-testid="new-gate-template-title"
                  class={cx(
                    'w-56 rounded-md border border-border bg-bg px-2 py-1 text-sm',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  )}
                />
              </label>
              <label class="flex flex-col gap-1 text-sm">
                <span class="text-xs font-medium text-muted">Kind</span>
                <input
                  type="text"
                  bind:value={gtKind}
                  placeholder="signoff / test_plan / review"
                  data-testid="new-gate-template-kind"
                  class={cx(
                    'w-48 rounded-md border border-border bg-bg px-2 py-1 text-sm',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  )}
                />
              </label>
              <label class="flex flex-col gap-1 text-sm">
                <span class="text-xs font-medium text-muted">
                  Required in states (comma-separated)
                </span>
                <input
                  type="text"
                  bind:value={gtRequiredIn}
                  placeholder="e.g. ready_qa, done"
                  data-testid="new-gate-template-required"
                  class={cx(
                    'w-72 rounded-md border border-border bg-bg px-2 py-1 text-sm',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  )}
                />
              </label>
              <span data-testid="add-gate-template-wrap">
                <Button onclick={() => void addGateTemplate()} disabled={gtCreating}>
                  {gtCreating ? 'Adding…' : '+ Add gate'}
                </Button>
              </span>
            </div>
          </div>
        {/if}
      </section>
    </div>
  {/if}
</div>
