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
  import { attributeUpdate, cardSelectWithAttributes } from '../../reg/handlers';
  import {
    workflowTransitionList,
    workflowTransitionSet,
  } from '../../reg/handlers_admin';
  import type {
    AttributeUpdateInput,
    AttributeUpdateOutput,
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWithAttrs,
    WorkflowTransitionListInput,
    WorkflowTransitionListOutput,
    WorkflowTransitionRow,
    WorkflowTransitionSetInput,
    WorkflowTransitionSetOutput,
  } from '../../reg/types';
  import Button from '../../ui/Button.svelte';
  import Spinner from '../../ui/Spinner.svelte';
  import { notify } from '../../ui/toast.svelte';
  import { cx } from '../../util/class_names';

  setActiveScope('admin_workflows');

  const dispatcher = getDispatcher();

  let workflows = $state<CardWithAttrs[]>([]);
  let selectedId = $state<number | null>(null);
  let transitions = $state<WorkflowTransitionRow[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Local edit buffers; sync from selection.
  let editStates = $state('');
  let editInitial = $state('');
  let editTransitions = $state<{ from: string; to: string }[]>([]);
  let saving = $state(false);

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
    if (selectedId === null) return;
    void loadTransitions(selectedId);
  });

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
      editTransitions = out.rows.map((r) => ({ from: r.from_state, to: r.to_state }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Load transitions failed: ${msg}` });
    }
  }

  function addTransition(): void {
    editTransitions = [...editTransitions, { from: '', to: '' }];
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
            .map((t) => ({ fromState: t.from, toState: t.to })),
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

  onMount(() => {
    void refresh();
  });
</script>

<div class="flex h-full flex-col" data-testid="admin-workflows">
  <header class="flex items-center justify-between border-b border-border px-4 py-3">
    <h1 class="text-xl font-semibold">Admin · Workflows</h1>
  </header>

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
        {/if}
      </section>
    </div>
  {/if}
</div>
