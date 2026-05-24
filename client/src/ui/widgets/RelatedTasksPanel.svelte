<script lang="ts">
  /**
   * RelatedTasksPanel — task ↔ task relations on the task detail screen.
   *
   * Data model (see seed.hcsv): one attribute pair on each task carries
   * the relation —
   *   - `parent_task`: card_ref → another task (nullable).
   *   - `parent_relationship`: text annotation (subtask / blocker / related,
   *     open string).
   * The inverse direction is computed by querying for tasks whose
   * `parent_task` points back at this card.
   *
   * Editing surfaces:
   *   - Parent section: shows the parent chip with the relationship pill;
   *     "Set parent" picks a target; "Remove" clears both attrs.
   *   - Children section: every task with `parent_task = me` listed with
   *     its own relationship pill; "Add child" picks an existing task and
   *     writes ITS parent_task back to me. "New sub-task" hands off to
   *     QuickEntryOverlay via the host screen.
   *
   * Writes go via plain `attribute.update` — no new endpoint needed. The
   * host screen owns the after-write refresh.
   */
  import { getDispatcher } from '../../dispatch/context';
  import { attributeUpdate, cardSearch } from '../../reg/handlers';
  import type {
    AttributeUpdateInput,
    AttributeUpdateOutput,
    CardSearchInput,
    CardSearchOutput,
    CardWithAttrs,
    ID,
    TransitionPhase,
  } from '../../reg/types';
  import Button from '../Button.svelte';
  import Combobox from '../Combobox.svelte';
  import IconButton from '../IconButton.svelte';
  import { notify } from '../toast.svelte';
  import { cx } from '../../util/class_names';
  import TaskRefLink from './TaskRefLink.svelte';

  interface Props {
    /** The task this panel is mounted on. */
    cardId: ID;
    /** The current parent task, already fetched by the host screen (the
     *  host already issues the per-card lookup in its initial batch). */
    parent: CardWithAttrs | null;
    /** Relationship label stored on THIS card pointing at the parent
     *  (subtask / blocker / related / arbitrary). Read separately because
     *  it lives on the child side, not on the parent card. */
    selfRelationship: string | null;
    /** Children — tasks whose `parent_task` is this card. */
    children: readonly CardWithAttrs[];
    /** Project scope for the picker — restricts card.search to siblings
     *  in the same project so a cross-project link can't slip in. */
    projectId: ID | null;
    /** Resolved (status card id → display label) so the chip can show a
     *  status pill without an extra fetch. Pass an empty map to skip. */
    statusLabels: Record<string, { label: string; phase: TransitionPhase }>;
    /** Host hook: re-fetch parent / children after a write. */
    onChanged: () => void;
    /** Host hook: open QuickEntry with `parent_task = cardId` prefilled. */
    onCreateSubtask: () => void;
    /**
     * Two-way bound flags so the host (TaskDetailScreen) can drive the
     * pickers from keyboard chords like `e p` / `e a`. When the host
     * flips `parentPickerOpen` to true, the parent picker takes
     * precedence over the existing parent chip — "change parent"
     * works in one keystroke instead of forcing the user to first
     * click Remove.
     */
    parentPickerOpen?: boolean;
    childPickerOpen?: boolean;
  }

  let {
    cardId,
    parent,
    selfRelationship,
    children,
    projectId,
    statusLabels,
    onChanged,
    onCreateSubtask,
    parentPickerOpen = $bindable(false),
    childPickerOpen = $bindable(false),
  }: Props = $props();

  const dispatcher = getDispatcher();

  /** Relationship label the user is choosing for a parent link. The
   *  parent picker writes this onto the *current task*'s
   *  `parent_relationship` so the relationship is stored on the child
   *  side (the side that holds the parent_task pointer). Seeded from
   *  `selfRelationship` whenever the picker opens so re-binding an
   *  existing parent keeps its relationship label by default. */
  let pendingRelationship = $state<string>('subtask');
  $effect(() => {
    if (parentPickerOpen) {
      // Snap to the current relationship (when set) so "change parent"
      // via `e p` doesn't silently reset blocker / related to subtask.
      pendingRelationship = selfRelationship ?? 'subtask';
    }
  });

  /** Combobox `value` while picking — single bigint or null. */
  let parentPickValue = $state<ID | null>(null);
  let childPickValue = $state<ID | null>(null);

  /** Refs to the picker Comboboxes so an effect can pop them open
   *  (and auto-focus their search inputs) when the picker is shown
   *  via the host's keyboard chord. Structural type — only `openMenu`
   *  matters at this call site. */
  type ComboboxRef = { openMenu: () => Promise<void> };
  let parentCombobox = $state<ComboboxRef | null>(null);
  let childCombobox = $state<ComboboxRef | null>(null);
  $effect(() => {
    // Fires when the parent picker mounts (parentCombobox null → ref)
    // while the picker is open. Svelte tracks both reads as deps; the
    // Combobox internally guards re-opens so this is safe to re-fire.
    if (parentPickerOpen && parentCombobox !== null) {
      void parentCombobox.openMenu();
    }
  });
  $effect(() => {
    if (childPickerOpen && childCombobox !== null) {
      void childCombobox.openMenu();
    }
  });

  const relationshipOptions: { value: string; label: string }[] = [
    { value: 'subtask', label: 'Sub-task' },
    { value: 'blocker', label: 'Blocker' },
    { value: 'related', label: 'Related' },
  ];

  /* ----------------------------------------------- card-search loader --- */

  /** Build a card.search loader scoped to this project's tasks, with the
   *  current card excluded so a task can't pick itself as parent/child.
   *
   *  Server returns recently-created tasks first on empty query (so the
   *  just-opened picker shows the user's latest 20 cards) and falls back
   *  to a substring-match on title — plus an exact id-match — when a
   *  query is typed (so "42" finds task #42 even if no title contains
   *  that string).
   *
   *  Both `label` (dropdown list) and `selectedLabel` (trigger
   *  once chosen) use the same `#42 Title` form — matches the
   *  read-view TaskRefLink rendering so users see one consistent
   *  shape across pick, picked-trigger, and persisted view. */
  function makeLoader(
    exclude: ID,
  ): (q: string) => Promise<
    { value: ID; label: string; selectedLabel: string }[]
  > {
    return async (q) => {
      const data: CardSearchInput = { cardTypeName: 'task', limit: 20 };
      if (projectId !== null) data.parentCardId = projectId;
      if (q !== '') data.query = q;
      const out = await dispatcher.request<CardSearchInput, CardSearchOutput>({
        endpoint: cardSearch.endpoint,
        action: cardSearch.action,
        data,
      });
      return out.rows
        .filter((r) => r.id !== exclude)
        .map((r) => {
          const title = r.title !== '' ? r.title : '(untitled)';
          const formatted = `#${r.id} ${title}`;
          return {
            value: r.id,
            label: formatted,
            selectedLabel: formatted,
          };
        });
    };
  }

  const parentLoader = $derived(makeLoader(cardId));
  const childLoader = $derived(makeLoader(cardId));

  /* ----------------------------------------------- write helpers ---------- */

  /**
   * Set an attribute on `target` to `value`. Centralises the wire-call
   * + toast routing so the four callers below don't duplicate plumbing.
   * `value` is forwarded to the server as-is (the dispatcher serialises
   * bigints + null correctly; the server treats JSON null as "clear").
   */
  async function writeAttr(
    target: ID,
    name: string,
    value: unknown,
    failLabel: string,
  ): Promise<boolean> {
    try {
      await dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
        endpoint: attributeUpdate.endpoint,
        action: attributeUpdate.action,
        data: { cardId: target, attributeName: name, value },
      });
      return true;
    } catch (e) {
      notify({
        type: 'error',
        message: `${failLabel}: ${e instanceof Error ? e.message : String(e)}`,
      });
      return false;
    }
  }

  /** Set this task's parent + relationship in one tick (one batch). */
  async function setParent(parentId: ID, relationship: string): Promise<void> {
    const p1 = writeAttr(cardId, 'parent_task', parentId, 'Set parent failed');
    const p2 = writeAttr(
      cardId,
      'parent_relationship',
      relationship,
      'Set relationship failed',
    );
    const [okA, okB] = await Promise.all([p1, p2]);
    if (okA && okB) {
      notify({ type: 'success', message: 'Parent set' });
      parentPickerOpen = false;
      parentPickValue = null;
      onChanged();
    }
  }

  /** Clear parent_task + parent_relationship — "make standalone". */
  async function removeParent(): Promise<void> {
    const p1 = writeAttr(cardId, 'parent_task', null, 'Remove parent failed');
    const p2 = writeAttr(cardId, 'parent_relationship', null, 'Remove parent failed');
    const [okA, okB] = await Promise.all([p1, p2]);
    if (okA && okB) {
      notify({ type: 'success', message: 'Parent removed' });
      onChanged();
    }
  }

  /** Update only the relationship label on this task's parent link. */
  async function updateRelationship(next: string): Promise<void> {
    if (!(await writeAttr(cardId, 'parent_relationship', next, 'Update failed'))) {
      return;
    }
    onChanged();
  }

  /** "Add child" = set the picked task's parent_task to this card. The
   *  relationship for the child defaults to `subtask` so the chip carries
   *  some classification; the user can edit it inline after. */
  async function addChild(childId: ID): Promise<void> {
    const p1 = writeAttr(childId, 'parent_task', cardId, 'Add child failed');
    const p2 = writeAttr(
      childId,
      'parent_relationship',
      'subtask',
      'Add child failed',
    );
    const [okA, okB] = await Promise.all([p1, p2]);
    if (okA && okB) {
      notify({ type: 'success', message: 'Child linked' });
      childPickerOpen = false;
      childPickValue = null;
      onChanged();
    }
  }

  /** Unlink one child by clearing its parent_task. */
  async function removeChild(childId: ID): Promise<void> {
    const p1 = writeAttr(childId, 'parent_task', null, 'Unlink failed');
    const p2 = writeAttr(childId, 'parent_relationship', null, 'Unlink failed');
    const [okA, okB] = await Promise.all([p1, p2]);
    if (okA && okB) {
      notify({ type: 'success', message: 'Child unlinked' });
      onChanged();
    }
  }

  /** Change a single child's relationship label. */
  async function updateChildRelationship(
    childId: ID,
    next: string,
  ): Promise<void> {
    if (!(await writeAttr(childId, 'parent_relationship', next, 'Update failed'))) {
      return;
    }
    onChanged();
  }

  /* ----------------------------------------------- render helpers --------- */

  function statusOf(c: CardWithAttrs): { label: string; phase: TransitionPhase } | null {
    const sid = c.attributes['status'];
    if (typeof sid !== 'bigint') return null;
    return statusLabels[sid.toString()] ?? null;
  }

  function relationshipOf(c: CardWithAttrs): string {
    const v = c.attributes['parent_relationship'];
    return typeof v === 'string' && v !== '' ? v : 'subtask';
  }

  function relationshipLabel(r: string): string {
    const o = relationshipOptions.find((x) => x.value === r);
    return o?.label ?? r;
  }

  function relationshipPillClass(r: string): string {
    if (r === 'blocker') return 'bg-danger/15 text-danger';
    if (r === 'related') return 'bg-muted/15 text-muted';
    return 'bg-accent/10 text-accent';
  }

</script>

<section
  aria-labelledby="related-heading"
  class="flex flex-col border border-section bg-bg"
  data-testid="related-tasks-panel"
>
  <h2
    id="related-heading"
    class="border-b border-fg/40 bg-surface/40 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg"
  >
    Related tasks
  </h2>

  <!-- Parent -------------------------------------------------------- -->
  <div class="flex flex-col gap-1.5 border-b border-section px-2 py-1.5">
    <div class="text-[10px] font-semibold uppercase tracking-wide text-muted">
      Parent
    </div>
    {#if parentPickerOpen}
      <!-- Picker takes precedence over the chip so the `e p` chord on
           TaskDetail (and the "+ Set parent" button) can re-bind an
           already-set parent in one keystroke. Saving overwrites
           parent_task + parent_relationship; cancelling drops back to
           the existing chip render below. -->
      <div class="flex flex-col gap-1" data-testid="related-parent-picker">
        <Combobox
          bind:this={parentCombobox}
          aria-label="Parent task"
          options={[]}
          loadOptions={parentLoader}
          value={parentPickValue}
          placeholder="Search tasks…"
          onchange={(v) => {
            parentPickValue = typeof v === 'bigint' ? v : null;
          }}
        />
        <div class="flex items-center gap-1">
          <span class="w-24">
            <Combobox
              aria-label="Relationship"
              options={relationshipOptions}
              value={pendingRelationship}
              searchable={false}
              onchange={(v) => {
                if (typeof v === 'string') pendingRelationship = v;
              }}
            />
          </span>
          <Button
            variant="primary"
            size="sm"
            disabled={parentPickValue === null}
            onclick={() => {
              if (parentPickValue !== null) {
                void setParent(parentPickValue, pendingRelationship);
              }
            }}
          >
            {#snippet children()}Save{/snippet}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onclick={() => {
              parentPickerOpen = false;
              parentPickValue = null;
            }}
          >
            {#snippet children()}Cancel{/snippet}
          </Button>
        </div>
      </div>
    {:else if parent !== null}
      {@const status = statusOf(parent)}
      <div
        class="flex items-center gap-1.5"
        data-testid="related-parent-row"
        data-parent-id={parent.id}
      >
        <TaskRefLink card={parent} {status} />
        <span class="w-24">
          <Combobox
            aria-label="Relationship"
            options={relationshipOptions}
            value={selfRelationship ?? 'subtask'}
            searchable={false}
            onchange={(v) => {
              if (typeof v === 'string') void updateRelationship(v);
            }}
          />
        </span>
        <IconButton
          aria-label="Remove parent"
          size="sm"
          variant="ghost"
          title="Remove parent (make standalone)"
          onclick={() => void removeParent()}
        >
          {#snippet children()}×{/snippet}
        </IconButton>
      </div>
    {:else}
      <button
        type="button"
        class="self-start text-xs text-accent hover:underline focus:outline-none focus-visible:underline"
        onclick={() => (parentPickerOpen = true)}
        data-testid="related-set-parent"
      >
        + Set parent
      </button>
    {/if}
  </div>

  <!-- Children ----------------------------------------------------- -->
  <div class="flex flex-col gap-1.5 px-2 py-1.5">
    <div class="flex items-center justify-between">
      <div class="text-[10px] font-semibold uppercase tracking-wide text-muted">
        Children ({children.length})
      </div>
    </div>
    {#if children.length === 0}
      <p class="text-xs text-muted">No related tasks yet.</p>
    {:else}
      <ul class="flex flex-col gap-1" data-testid="related-children-list">
        {#each children as child (child.id)}
          {@const status = statusOf(child)}
          {@const rel = relationshipOf(child)}
          <li
            class="flex items-center gap-1.5"
            data-testid="related-child-row"
            data-child-id={child.id}
          >
            <TaskRefLink card={child} {status} />
            <span
              class={cx(
                'inline-block rounded px-1.5 py-0.5 text-[10px] font-medium',
                relationshipPillClass(rel),
              )}
              title={`relationship: ${relationshipLabel(rel)}`}
            >
              {relationshipLabel(rel)}
            </span>
            <span class="w-20">
              <Combobox
                aria-label="Relationship"
                options={relationshipOptions}
                value={rel}
                searchable={false}
                onchange={(v) => {
                  if (typeof v === 'string') void updateChildRelationship(child.id, v);
                }}
              />
            </span>
            <IconButton
              aria-label="Unlink"
              size="sm"
              variant="ghost"
              title="Unlink (clears child's parent)"
              onclick={() => void removeChild(child.id)}
            >
              {#snippet children()}×{/snippet}
            </IconButton>
          </li>
        {/each}
      </ul>
    {/if}

    {#if childPickerOpen}
      <div class="mt-1 flex items-center gap-1" data-testid="related-child-picker">
        <span class="flex-1">
          <Combobox
            bind:this={childCombobox}
            aria-label="Child task"
            options={[]}
            loadOptions={childLoader}
            value={childPickValue}
            placeholder="Search tasks…"
            onchange={(v) => {
              childPickValue = typeof v === 'bigint' ? v : null;
            }}
          />
        </span>
        <Button
          variant="primary"
          size="sm"
          disabled={childPickValue === null}
          onclick={() => {
            if (childPickValue !== null) void addChild(childPickValue);
          }}
        >
          {#snippet children()}Add{/snippet}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onclick={() => {
            childPickerOpen = false;
            childPickValue = null;
          }}
        >
          {#snippet children()}Cancel{/snippet}
        </Button>
      </div>
    {:else}
      <div class="mt-1 flex items-center gap-2">
        <button
          type="button"
          class="text-xs text-accent hover:underline focus:outline-none focus-visible:underline"
          onclick={() => (childPickerOpen = true)}
          data-testid="related-add-child"
        >
          + Add child
        </button>
        <span class="text-xs text-muted">·</span>
        <button
          type="button"
          class="text-xs text-accent hover:underline focus:outline-none focus-visible:underline"
          onclick={onCreateSubtask}
          data-testid="related-new-subtask"
        >
          + New sub-task
        </button>
      </div>
    {/if}
  </div>
</section>
