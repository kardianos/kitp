<!--
  BulkMoveDialog — bulk variant of MoveTaskDialog. Picks one
  destination project + re-classification (status / milestone /
  component / tags) and fans the same task.move call out across every
  selected card.

  Mirrors MoveTaskDialog's UX so users moving one task on the detail
  screen and a batch from the Grid have the same affordances. The
  per-card requests are dispatched in parallel; the dispatcher batches
  them on the wire. Partial failures surface in the summary toast and
  keep the dialog open so the user can retry.
-->
<script lang="ts">
  import { untrack } from 'svelte';

  import { getDispatcher } from '../dispatch/context';
  import {
    cardSelectWithAttributes,
    taskMove,
  } from '../reg/handlers';
  import type {
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWithAttrs,
    ID,
    TaskMoveInput,
    TaskMoveOutput,
  } from '../reg/types';
  import { projectsStore } from '../shell/projects_store.svelte';
  import Button from '../ui/Button.svelte';
  import Combobox from '../ui/Combobox.svelte';
  import Modal from '../ui/Modal.svelte';
  import { notify } from '../ui/toast.svelte';

  interface Props {
    open: boolean;
    cardIds: ID[];
    /** Source project — when known (Grid is project-scoped) we hide
     *  it from the destination picker so the user can't pick the
     *  same project. Null is allowed for cross-project selections. */
    sourceProjectId: ID | null;
    onMoved?: (movedIds: ID[]) => void;
  }

  let { open = $bindable(), cardIds, sourceProjectId, onMoved }: Props = $props();

  const dispatcher = getDispatcher();

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
        void projectsStore.load(dispatcher);
      });
    }
  });

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
      chosenStatusId = sOut.rows[0]?.id ?? null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Load options failed: ${msg}` });
    } finally {
      destLoading = false;
    }
  }

  function refOptions(rows: readonly CardWithAttrs[]): { value: ID; label: string }[] {
    return rows.map((r) => {
      const t = r.attributes['title'];
      return {
        value: r.id,
        label: typeof t === 'string' && t.length > 0 ? t : `#${r.id}`,
      };
    });
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

  const canMove = $derived(
    cardIds.length > 0
      && destProjectId !== null
      && chosenStatusId !== null
      && !submitting,
  );

  async function doMove(): Promise<void> {
    if (destProjectId === null || chosenStatusId === null || cardIds.length === 0) {
      return;
    }
    submitting = true;
    try {
      const results = await Promise.allSettled(
        cardIds.map((cardId) => {
          const data: TaskMoveInput = {
            cardId,
            newProjectId: destProjectId as ID,
            newStatusId: chosenStatusId as ID,
            subtaskStrategy,
          };
          if (chosenMilestoneId !== null) data.newMilestoneId = chosenMilestoneId;
          if (chosenComponentId !== null) data.newComponentId = chosenComponentId;
          if (chosenTagIds.length > 0) data.newTagIds = chosenTagIds;
          return dispatcher.request<TaskMoveInput, TaskMoveOutput>({
            endpoint: taskMove.endpoint,
            action: taskMove.action,
            data,
          }).then(() => cardId);
        }),
      );
      const moved: ID[] = [];
      const failures: string[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') moved.push(r.value);
        else failures.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
      }
      if (failures.length === 0) {
        notify({
          type: 'success',
          message: `Moved ${moved.length} task${moved.length === 1 ? '' : 's'}`,
        });
        open = false;
      } else {
        notify({
          type: 'error',
          message:
            `Moved ${moved.length} / ${cardIds.length}; ${failures.length} failed: ${failures[0]}`,
        });
      }
      onMoved?.(moved);
    } finally {
      submitting = false;
    }
  }
</script>

<Modal bind:open title="Move {cardIds.length} task{cardIds.length === 1 ? '' : 's'} to another project">
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
            Re-classify all selected tasks in destination
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
          name="bulk-subtask-strategy"
          value="cascade"
          checked={subtaskStrategy === 'cascade'}
          onchange={() => (subtaskStrategy = 'cascade')}
        />
        <span>Move sub-tasks along (each gets re-classified the same way)</span>
      </label>
      <label class="flex items-center gap-2">
        <input
          type="radio"
          name="bulk-subtask-strategy"
          value="break"
          checked={subtaskStrategy === 'break'}
          onchange={() => (subtaskStrategy = 'break')}
        />
        <span>Break — leave sub-tasks behind and clear their parent link</span>
      </label>
    </div>

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
        {#snippet children()}
          Move {cardIds.length} task{cardIds.length === 1 ? '' : 's'}
        {/snippet}
      </Button>
    </div>
  </div>
</Modal>
