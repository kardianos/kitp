<!--
  PurgeTaskDialog — strong-confirm modal for permanently deleting a
  task. The user must type the task's exact title before the
  destructive button enables. Matches the GitHub "type the repo name
  to delete" pattern that's catch-on-error before the click.

  Only shown from the TaskDetail kebab. On success, fires `onPurged`
  so the host can navigate away.
-->
<script lang="ts">
  import { getDispatcher } from '../../dispatch/context';
  import { taskPurge } from '../../reg/handlers';
  import type { ID, TaskPurgeInput, TaskPurgeOutput } from '../../reg/types';
  import Button from '../Button.svelte';
  import Modal from '../Modal.svelte';
  import TextInput from '../inputs/TextInput.svelte';
  import { notify } from '../toast.svelte';

  interface Props {
    open: boolean;
    cardId: ID | null;
    /** The task's current title — drives the type-to-confirm gate.
     *  Empty/missing falls back to `#<id>`. */
    taskTitle: string;
    /** Fired after a successful purge. The host should navigate away
     *  because the focal card no longer exists. */
    onPurged?: (out: TaskPurgeOutput) => void;
  }

  let {
    open = $bindable(),
    cardId,
    taskTitle,
    onPurged,
  }: Props = $props();

  const dispatcher = getDispatcher();

  let typedConfirm = $state('');
  let submitting = $state(false);

  // Effective confirm phrase: prefer the task's real title; fall
  // back to the id when title is empty. The user types this exact
  // string (case-sensitive) to enable Delete.
  const requiredPhrase = $derived(
    taskTitle.trim() !== '' ? taskTitle : (cardId !== null ? `#${cardId}` : ''),
  );

  // Reset on (re)open so a previous attempt's typed-text doesn't
  // bleed in.
  $effect(() => {
    if (open) {
      typedConfirm = '';
    }
  });

  const canPurge = $derived(
    cardId !== null
      && requiredPhrase !== ''
      && typedConfirm === requiredPhrase
      && !submitting,
  );

  async function doPurge(): Promise<void> {
    if (cardId === null) return;
    submitting = true;
    try {
      const out = await dispatcher.request<TaskPurgeInput, TaskPurgeOutput>({
        endpoint: taskPurge.endpoint,
        action: taskPurge.action,
        data: { cardId },
      });
      // Show how many cards rode along (comms / reply_bodies) so the
      // user has a clear signal that the cascade did something.
      const extra = Math.max(0, out.purgedCardIds.length - 1);
      const summary = extra > 0
        ? `Task purged (+${extra} comm / reply${extra === 1 ? '' : 's'})`
        : 'Task purged';
      notify({ type: 'success', message: summary });
      open = false;
      onPurged?.(out);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Purge failed: ${msg}` });
    } finally {
      submitting = false;
    }
  }
</script>

<Modal bind:open title="Delete this task forever">
  <div class="flex flex-col gap-3 text-sm">
    <div class="rounded-md border border-danger/40 bg-danger/10 p-2 text-xs text-danger">
      <strong>This cannot be undone.</strong> The task, its comments,
      its activity history, its attachments, and any comms /
      reply bodies parented to it will be removed from the database.
      Soft-delete (the trash icon elsewhere) is reversible — this is
      not.
    </div>

    <div class="text-xs text-muted">
      Refused if the task has live sub-tasks (clean those up first).
    </div>

    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted">
        To confirm, type the task's title exactly:
        <span class="font-mono text-fg" data-testid="purge-required-phrase">{requiredPhrase}</span>
      </span>
      <TextInput
        bind:value={typedConfirm}
        placeholder={requiredPhrase}
        aria-label="Type the task title to confirm purge"
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
