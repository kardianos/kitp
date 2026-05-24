<!--
  BulkPurgeDialog — type-to-confirm modal for permanently deleting many
  tasks at once. The single-task analog (PurgeTaskDialog) requires
  typing the task's exact title; that doesn't generalize, so the bulk
  variant requires the user to type the phrase `delete N` instead.

  Calls `task.purge` once per id and reports any failures. On full
  success it closes and fires `onPurged`.
-->
<script lang="ts">
  import { getDispatcher } from '../dispatch/context';
  import { taskPurge } from '../reg/handlers';
  import type { ID, TaskPurgeInput, TaskPurgeOutput } from '../reg/types';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import TextInput from '../ui/inputs/TextInput.svelte';
  import { notify } from '../ui/toast.svelte';

  interface Props {
    open: boolean;
    cardIds: ID[];
    /** Fired after every id has been attempted. The host should
     *  refresh and clear its selection. `purged` is the subset that
     *  succeeded. */
    onPurged?: (purged: ID[]) => void;
  }

  let { open = $bindable(), cardIds, onPurged }: Props = $props();

  const dispatcher = getDispatcher();

  let typedConfirm = $state('');
  let submitting = $state(false);

  const requiredPhrase = $derived(`delete ${cardIds.length}`);

  $effect(() => {
    if (open) typedConfirm = '';
  });

  const canPurge = $derived(
    cardIds.length > 0
      && typedConfirm === requiredPhrase
      && !submitting,
  );

  async function doPurge(): Promise<void> {
    if (cardIds.length === 0) return;
    submitting = true;
    const succeeded: ID[] = [];
    const failures: string[] = [];
    try {
      const results = await Promise.allSettled(
        cardIds.map((cardId) =>
          dispatcher.request<TaskPurgeInput, TaskPurgeOutput>({
            endpoint: taskPurge.endpoint,
            action: taskPurge.action,
            data: { cardId },
          }).then(() => cardId),
        ),
      );
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        if (r.status === 'fulfilled') succeeded.push(r.value);
        else failures.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
      }
      if (failures.length === 0) {
        notify({ type: 'success', message: `Purged ${succeeded.length} task${succeeded.length === 1 ? '' : 's'}` });
      } else {
        notify({
          type: 'error',
          message:
            `Purged ${succeeded.length} / ${cardIds.length}; `
            + `${failures.length} failed: ${failures[0]}`,
        });
      }
      open = false;
      onPurged?.(succeeded);
    } finally {
      submitting = false;
    }
  }
</script>

<Modal bind:open title="Delete {cardIds.length} task{cardIds.length === 1 ? '' : 's'} forever">
  <div class="flex flex-col gap-3 text-sm">
    <div class="rounded-md border border-danger/40 bg-danger/10 p-2 text-xs text-danger">
      <strong>This cannot be undone.</strong> The selected tasks,
      their comments, activity history, attachments, and any comms /
      reply bodies parented to them will be removed from the database.
      Tasks with live sub-tasks will be refused.
    </div>

    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted">
        To confirm, type:
        <span class="font-mono text-fg" data-testid="bulk-purge-required-phrase">{requiredPhrase}</span>
      </span>
      <TextInput
        bind:value={typedConfirm}
        placeholder={requiredPhrase}
        aria-label="Type the phrase to confirm bulk purge"
      />
    </label>

    <div class="mt-1 flex justify-end gap-2">
      <Button
        variant="ghost"
        size="sm"
        disabled={submitting}
        onclick={() => (open = false)}
      >
        {#snippet children()}Cancel{/snippet}
      </Button>
      <Button
        variant="danger"
        size="sm"
        disabled={!canPurge}
        loading={submitting}
        onclick={() => void doPurge()}
      >
        {#snippet children()}Delete forever{/snippet}
      </Button>
    </div>
  </div>
</Modal>
