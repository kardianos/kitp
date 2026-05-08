<!--
  ClassifyDialog.

  Modal that binds a card to a workflow_def via card.classify. Shown
  on TaskDetailScreen when the card has no workflow_def_ref yet.

  Loads workflow_def cards in the active project's parent scope on
  open. On confirm, fires card.classify, then notifies the parent
  to refresh.
-->
<script lang="ts">
  import { getDispatcher } from '../../dispatch/context';
  import { cardSelectWithAttributes } from '../../reg/handlers';
  import { cardClassify } from '../../reg/handlers_admin';
  import type {
    CardClassifyInput,
    CardClassifyOutput,
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWithAttrs,
  } from '../../reg/types';
  import Button from '../Button.svelte';
  import Modal from '../Modal.svelte';
  import { notify } from '../toast.svelte';

  let {
    open = $bindable(false),
    cardId,
    onClassified,
  }: {
    open?: boolean;
    cardId: number;
    onClassified?: () => void;
  } = $props();

  const dispatcher = getDispatcher();

  let workflows = $state<CardWithAttrs[]>([]);
  let selectedWorkflowId = $state<number | null>(null);
  let loading = $state(false);
  let submitting = $state(false);

  $effect(() => {
    if (open) void load();
  });

  async function load(): Promise<void> {
    loading = true;
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
      if (workflows.length > 0 && selectedWorkflowId === null) {
        selectedWorkflowId = workflows[0]!.id;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Could not load workflows: ${msg}` });
    } finally {
      loading = false;
    }
  }

  function decodeText(v: unknown): string {
    if (typeof v === 'string') return v;
    return '';
  }

  async function classify(): Promise<void> {
    if (selectedWorkflowId === null) return;
    submitting = true;
    try {
      const out = await dispatcher.request<CardClassifyInput, CardClassifyOutput>({
        endpoint: cardClassify.endpoint,
        action: cardClassify.action,
        data: { cardId, workflowDefId: selectedWorkflowId },
      });
      if (!out.ok) throw new Error('classify returned not-ok');
      notify({ type: 'success', message: `Classified to ${out.initial_state}` });
      open = false;
      onClassified?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Classify failed: ${msg}` });
    } finally {
      submitting = false;
    }
  }
</script>

<Modal bind:open title="Classify card">
  <div class="flex flex-col gap-3" data-testid="classify-dialog">
    <p class="text-sm text-muted">
      Pick a workflow to bind this card to. The card will move to the
      workflow's initial state.
    </p>
    {#if loading}
      <p class="text-sm text-muted">Loading…</p>
    {:else if workflows.length === 0}
      <p class="text-sm text-warn">
        No workflow_def cards exist yet. Create one under
        <code>/admin/workflows</code> first.
      </p>
    {:else}
      <ul class="flex flex-col gap-1" data-testid="classify-workflow-list">
        {#each workflows as wf (wf.id)}
          <li>
            <label class="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-surface-2">
              <input
                type="radio"
                name="workflow"
                value={wf.id}
                checked={selectedWorkflowId === wf.id}
                onchange={() => (selectedWorkflowId = wf.id)}
                data-testid="classify-workflow-radio"
              />
              <span>{decodeText(wf.attributes['title']) || `Workflow ${wf.id}`}</span>
            </label>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="flex justify-end gap-2 pt-2">
      <Button variant="secondary" onclick={() => (open = false)}>Cancel</Button>
      <span data-testid="classify-confirm-wrap">
        <Button
          onclick={() => void classify()}
          disabled={submitting || workflows.length === 0 || selectedWorkflowId === null}
        >
          {submitting ? 'Classifying…' : 'Classify'}
        </Button>
      </span>
    </div>
  </div>
</Modal>
