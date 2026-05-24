<!--
  MoveTaskDialog — bump one task to another project.

  Opens from the TaskDetail kebab. The user picks the destination
  project; we then lazy-load that project's status / milestone /
  component / tag value-cards and offer pickers (status defaults to
  the destination's first option). Cascade vs break radio controls
  sub-task behaviour; cascade is the default.

  Backed by the server's task.move endpoint — see
  server/internal/dom/card/task_move.go. The dialog never tries to
  auto-map per-project attributes from source to destination; the
  user re-classifies in the destination as part of the move.
-->
<script lang="ts">
  import { untrack } from 'svelte';

  import { getDispatcher } from '../../dispatch/context';
  import {
    cardSelectWithAttributes,
    taskMove,
  } from '../../reg/handlers';
  import type {
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWithAttrs,
    ID,
    TaskMoveInput,
    TaskMoveOutput,
  } from '../../reg/types';
  import { projectsStore } from '../../shell/projects_store.svelte';
  import Button from '../Button.svelte';
  import Combobox from '../Combobox.svelte';
  import Modal from '../Modal.svelte';
  import { notify } from '../toast.svelte';

  interface Props {
    open: boolean;
    /** Task card id to move. */
    cardId: ID | null;
    /** Source project (used to filter the destination picker so the
     *  user can't pick the same project). Pass null when unknown —
     *  the dialog will still work but the destination list won't
     *  filter the source out. */
    sourceProjectId: ID | null;
    /** Fired after a successful move so the host can re-fetch or
     *  navigate. */
    onMoved?: (out: TaskMoveOutput) => void;
  }

  let {
    open = $bindable(),
    cardId,
    sourceProjectId,
    onMoved,
  }: Props = $props();

  const dispatcher = getDispatcher();

  // Reset the form whenever the modal re-opens so a previous move
  // doesn't bleed into the next attempt.
  let destProjectId = $state<ID | null>(null);
  let destStatuses = $state<readonly CardWithAttrs[]>([]);
  let destMilestones = $state<readonly CardWithAttrs[]>([]);
  let destComponents = $state<readonly CardWithAttrs[]>([]);
  let destTags = $state<readonly CardWithAttrs[]>([]);
  let destLoading = $state(false);
  let chosenStatusId = $state<ID | null>(null);
  let chosenMilestoneId = $state<ID | null>(null);
  let chosenComponentId = $state<ID | null>(null);
  let chosenTagIds = $state<ID[]>([]);
  let subtaskStrategy = $state<'cascade' | 'break'>('cascade');
  let submitting = $state(false);

  $effect(() => {
    if (open) {
      untrack(() => {
        destProjectId = null;
        destStatuses = [];
        destMilestones = [];
        destComponents = [];
        destTags = [];
        chosenStatusId = null;
        chosenMilestoneId = null;
        chosenComponentId = null;
        chosenTagIds = [];
        subtaskStrategy = 'cascade';
        // Pull the global project list if it isn't loaded yet. Errors
        // surface via the dispatcher's fault registry; the picker
        // simply renders an empty list in that case.
        void projectsStore.load(dispatcher);
      });
    }
  });

  // When the destination project changes, fetch its value-cards in a
  // single batched tick so the four pickers populate together.
  $effect(() => {
    const pid = destProjectId;
    untrack(() => {
      if (pid === null) {
        destStatuses = [];
        destMilestones = [];
        destComponents = [];
        destTags = [];
        chosenStatusId = null;
        chosenMilestoneId = null;
        chosenComponentId = null;
        chosenTagIds = [];
        return;
      }
      void loadDestination(pid);
    });
  });

  async function loadDestination(pid: ID): Promise<void> {
    destLoading = true;
    try {
      const req = (
        d: CardSelectWithAttributesInput,
      ): Promise<CardSelectWithAttributesOutput> =>
        dispatcher.request<
          CardSelectWithAttributesInput,
          CardSelectWithAttributesOutput
        >({
          endpoint: cardSelectWithAttributes.endpoint,
          action: cardSelectWithAttributes.action,
          data: d,
        });
      const [sOut, mOut, cOut, tOut] = await Promise.all([
        req({ cardTypeName: 'status', parentCardId: pid }),
        req({ cardTypeName: 'milestone', parentCardId: pid }),
        req({ cardTypeName: 'component', parentCardId: pid }),
        req({ cardTypeName: 'tag', parentCardId: pid }),
      ]);
      if (destProjectId !== pid) return;
      destStatuses = sOut.rows;
      destMilestones = mOut.rows;
      destComponents = cOut.rows;
      destTags = tOut.rows;
      // Default status = the first one in the list. The server will
      // re-pick if we leave it blank, but showing the user the
      // pre-picked value avoids a "what just happened" moment.
      chosenStatusId = sOut.rows[0]?.id ?? null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Load options failed: ${msg}` });
    } finally {
      destLoading = false;
    }
  }

  const projectOptions = $derived(
    projectsStore.projects
      .filter((p) => p.id !== sourceProjectId)
      .map((p) => {
        const t = p.attributes['title'];
        return {
          value: p.id,
          label: typeof t === 'string' && t.length > 0 ? t : `#${p.id}`,
        };
      }),
  );

  const statusOptions = $derived(refOptions(destStatuses));
  const milestoneOptions = $derived(refOptions(destMilestones));
  const componentOptions = $derived(refOptions(destComponents));
  const tagOptions = $derived(
    destTags.map((t) => {
      const p = t.attributes['path'];
      return {
        value: t.id,
        label: typeof p === 'string' && p.length > 0 ? p : `#${t.id}`,
      };
    }),
  );

  function refOptions(
    rows: readonly CardWithAttrs[],
  ): { value: ID; label: string }[] {
    return rows.map((r) => {
      const t = r.attributes['title'];
      return {
        value: r.id,
        label: typeof t === 'string' && t.length > 0 ? t : `#${r.id}`,
      };
    });
  }

  const canMove = $derived(
    cardId !== null
      && destProjectId !== null
      && chosenStatusId !== null
      && !submitting,
  );

  async function doMove(): Promise<void> {
    if (cardId === null || destProjectId === null || chosenStatusId === null) {
      return;
    }
    submitting = true;
    try {
      const data: TaskMoveInput = {
        cardId,
        newProjectId: destProjectId,
        newStatusId: chosenStatusId,
        subtaskStrategy,
      };
      if (chosenMilestoneId !== null) data.newMilestoneId = chosenMilestoneId;
      if (chosenComponentId !== null) data.newComponentId = chosenComponentId;
      if (chosenTagIds.length > 0) data.newTagIds = chosenTagIds;
      const out = await dispatcher.request<TaskMoveInput, TaskMoveOutput>({
        endpoint: taskMove.endpoint,
        action: taskMove.action,
        data,
      });
      const cascadedCount = Math.max(0, out.movedCardIds.length - 1);
      const summary = cascadedCount > 0
        ? `Moved task and ${cascadedCount} sub-task${cascadedCount === 1 ? '' : 's'}`
        : 'Task moved';
      notify({ type: 'success', message: summary });
      open = false;
      onMoved?.(out);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Move failed: ${msg}` });
    } finally {
      submitting = false;
    }
  }
</script>

<Modal bind:open title="Move task to another project">
  <div class="flex flex-col gap-3 text-sm">
    <label class="flex flex-col gap-1">
      <span class="text-xs uppercase tracking-wide text-muted">Destination project</span>
      <Combobox
        aria-label="Destination project"
        options={projectOptions}
        value={destProjectId}
        searchable={projectOptions.length > 8}
        placeholder="Pick a project…"
        onchange={(v) => {
          destProjectId = typeof v === 'bigint' ? v : null;
        }}
      />
    </label>

    {#if destProjectId !== null}
      {#if destLoading}
        <p class="text-xs text-muted">Loading destination options…</p>
      {:else}
        <div class="flex flex-col gap-2 rounded-md border border-border bg-surface/30 p-2">
          <p class="text-[10px] uppercase tracking-wide text-muted">
            Re-classify in destination
          </p>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-muted">Status <span class="text-danger">*</span></span>
            <Combobox
              aria-label="Status"
              options={statusOptions}
              value={chosenStatusId}
              searchable={statusOptions.length > 8}
              placeholder="Pick a status…"
              onchange={(v) => {
                chosenStatusId = typeof v === 'bigint' ? v : null;
              }}
            />
          </label>
          {#if milestoneOptions.length > 0}
            <label class="flex flex-col gap-1">
              <span class="text-xs text-muted">Milestone (optional)</span>
              <Combobox
                aria-label="Milestone"
                options={milestoneOptions}
                value={chosenMilestoneId}
                searchable={milestoneOptions.length > 8}
                placeholder="(none)"
                onchange={(v) => {
                  chosenMilestoneId = typeof v === 'bigint' ? v : null;
                }}
              />
            </label>
          {/if}
          {#if componentOptions.length > 0}
            <label class="flex flex-col gap-1">
              <span class="text-xs text-muted">Component (optional)</span>
              <Combobox
                aria-label="Component"
                options={componentOptions}
                value={chosenComponentId}
                searchable={componentOptions.length > 8}
                placeholder="(none)"
                onchange={(v) => {
                  chosenComponentId = typeof v === 'bigint' ? v : null;
                }}
              />
            </label>
          {/if}
          {#if tagOptions.length > 0}
            <label class="flex flex-col gap-1">
              <span class="text-xs text-muted">Tags (optional)</span>
              <Combobox
                aria-label="Tags"
                multiple
                options={tagOptions}
                value={chosenTagIds}
                searchable={tagOptions.length > 8}
                placeholder="(none)"
                onchange={(v) => {
                  chosenTagIds = Array.isArray(v) ? v : [];
                }}
              />
            </label>
          {/if}
        </div>
      {/if}
    {/if}

    <div class="flex flex-col gap-1 rounded-md border border-border bg-surface/30 p-2 text-xs">
      <span class="text-[10px] uppercase tracking-wide text-muted">Sub-tasks</span>
      <label class="flex items-center gap-2">
        <input
          type="radio"
          name="subtask-strategy"
          value="cascade"
          checked={subtaskStrategy === 'cascade'}
          onchange={() => (subtaskStrategy = 'cascade')}
        />
        <span>Move sub-tasks along (each gets re-classified the same way)</span>
      </label>
      <label class="flex items-center gap-2">
        <input
          type="radio"
          name="subtask-strategy"
          value="break"
          checked={subtaskStrategy === 'break'}
          onchange={() => (subtaskStrategy = 'break')}
        />
        <span>Break — leave sub-tasks behind and clear their parent link</span>
      </label>
    </div>

    <p class="text-xs text-muted">
      Attachments and comments come along automatically — they live on
      the task, not the project.
    </p>

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
        variant="primary"
        size="sm"
        disabled={!canMove}
        loading={submitting}
        onclick={() => void doMove()}
      >
        {#snippet children()}Move task{/snippet}
      </Button>
    </div>
  </div>
</Modal>
