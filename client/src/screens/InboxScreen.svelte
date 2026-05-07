<!--
  InboxScreen — per-user list of "open work assigned to me", sortable by
  personal_sort_order, with drag-drop reorder and a FilterBar with
  quick-chips. Ports `client/lib/ui/screens/inbox_screen.dart`.

  Initial batch (one POST /api/v1/batch via the dispatcher's per-tick
  coalescing):
    1. inbox.select   (with optional userId, tree, limit=200)
    2. user.select    (assignee labels)
    3. card.select_with_attributes for milestones (cardTypeName='milestone')
    4. card.select_with_attributes for components (cardTypeName='component')
    5. card.select_with_attributes for tags       (cardTypeName='tag')
    6. attribute_def.select  (cached schema; powers filter quick chips)

  Drag-drop reorder fires ONE `user_card_sort.set`. On error the optimistic
  update snaps back and a toast surfaces the message.

  TEMPORARY: until OIDC fully drives a userId we hard-wire kCurrentUserId=2
  (alice) — same as the Dart screen.
-->
<script lang="ts">
  import { getContext, untrack } from 'svelte';

  import type { AuthState } from '../auth/auth_state.svelte';
  import { getDispatcher } from '../dispatch/context';
  import {
    cardSelectWithAttributes,
    inboxSelect,
    userCardSortSet,
    userSelect,
    attributeUpdate,
  } from '../reg/handlers';
  import type {
    AttributeUpdateInput,
    AttributeUpdateOutput,
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWhereTree,
    CardWithAttrs,
    InboxRow,
    InboxSelectInput,
    InboxSelectOutput,
    UserCardSortSetInput,
    UserCardSortSetOutput,
    UserRow,
    UserSelectInput,
    UserSelectOutput,
  } from '../reg/types';

  import FilterBar from '../filter/FilterBar.svelte';
  import {
    AttributeSchemaCache,
    type FilterAttribute,
  } from '../filter/attribute_schema.svelte';
  import {
    isFlatAndOfLeaves,
    predicateToJson,
    type Predicate,
  } from '../filter/predicate';
  import { defaultQuickChipsFor, type QuickChip } from '../filter/quick_chips';
  import { buildTaskFilterPalette } from '../filter/task_palette';

  import DragHandle from '../dnd/DragHandle.svelte';
  import DropZone from '../dnd/DropZone.svelte';

  import { setActiveScope, useShortcut } from '../keys/shortcut';
  import { projectScope } from '../shell/project_scope.svelte';

  import { useQuickEntry } from '../quick_entry/use_quick_entry.svelte';
  import QuickEntryOverlay from '../quick_entry/QuickEntryOverlay.svelte';

  import { navigate } from '../routing/router.svelte';
  import { setTaskNavList } from '../routing/task_nav_list.svelte';

  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Spinner from '../ui/Spinner.svelte';
  import { notify } from '../ui/toast.svelte';
  import TaskRow from '../ui/widgets/TaskRow.svelte';
  import { cx } from '../util/class_names';

  import {
    move,
    planReorder,
    predicateToggleStatus,
    SORT_ORDER_STEP,
  } from './inbox_helpers';

  /* ------------------------------------------------------------------ scope */
  setActiveScope('inbox');

  /* ------------------------------------------------------------- dependencies */
  const dispatcher = getDispatcher();
  const authState = getContext<AuthState | undefined>('authState');
  const schemaCache = new AttributeSchemaCache(dispatcher);

  /**
   * TEMPORARY: System User has no assigned tasks; until OIDC-driven user
   * resolution lands we pin to alice (id=2) so the screen looks lived-in.
   * Mirrors `kCurrentUserId` in the Dart source.
   */
  const kCurrentUserId = 2;

  function parseMeId(): number {
    const sub = authState?.claims?.sub;
    if (typeof sub === 'string' && sub.length > 0) {
      const n = Number(sub);
      if (Number.isFinite(n) && Number.isInteger(n) && n > 0) return n;
    }
    return kCurrentUserId;
  }

  const meId = parseMeId();

  /* ------------------------------------------------------------------- state */

  let rows = $state<InboxRow[]>([]);
  let users = $state<UserRow[]>([]);
  let milestones = $state<CardWithAttrs[]>([]);
  let components = $state<CardWithAttrs[]>([]);
  let tagsRows = $state<CardWithAttrs[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let predicate = $state<Predicate | null>(null);
  let selectedIndex = $state(0);

  /** Derived lookup tables for `<TaskRow>` props. */
  const userNames = $derived.by((): Record<number, string> => {
    const out: Record<number, string> = {};
    for (const u of users) out[u.id] = u.display_name;
    return out;
  });
  const cardTitles = $derived.by((): Record<number, string> => {
    const out: Record<number, string> = {};
    for (const r of milestones) {
      const t = r.attributes['title'];
      if (typeof t === 'string') out[r.id] = t;
    }
    for (const r of components) {
      const t = r.attributes['title'];
      if (typeof t === 'string') out[r.id] = t;
    }
    return out;
  });
  const tagPaths = $derived.by((): Record<number, string> => {
    const out: Record<number, string> = {};
    for (const r of tagsRows) {
      const p = r.attributes['path'];
      if (typeof p === 'string') out[r.id] = p;
    }
    return out;
  });
  /** "mine" (default) shows only tasks assigned to the actor; "all" drops
   *  the assignee filter so the inbox doubles as a project-wide open-tasks
   *  list. Lives in component state — not persisted across visits because
   *  "all" + a wide project scope can flood the screen. */
  let viewMode = $state<'mine' | 'all'>('mine');

  /* ----------------------------------------------------- computed filter UI */

  /**
   * FilterBar palette. One source of truth lives in `task_palette.ts` so
   * the same names / labels / option lists render across Inbox, Grid,
   * Kanban, and ProjectDetail.
   */
  const filterAttributes = $derived<FilterAttribute[]>(
    buildTaskFilterPalette({
      schema: schemaCache,
      users,
      milestones,
      components,
      tags: tagsRows,
    }),
  );
  /** Status attribute pulled from the palette, for label resolution in
   *  list rows so the row chip and the FilterBar chip stay in sync. */
  const statusAttribute = $derived(
    filterAttributes.find((a) => a.name === 'status'),
  );

  /** Quick chips: status enum chips + Mine + (auto) milestone/component chips. */
  const quickChips = $derived.by((): QuickChip[] => {
    const out: QuickChip[] = [];
    for (const attr of filterAttributes) {
      out.push(...defaultQuickChipsFor(attr, meId));
    }
    return out;
  });

  /* --------------------------------------------------------- quick-entry */

  // We deliberately omit `assigneeOptions` here: the inbox always prefills
  // the current user, and the overlay's combobox reads from a static prop
  // (it would not reactively re-render if `userNames` changed). Users who
  // need to retarget can do it from the task detail screen.
  const qe = useQuickEntry({
    scope: 'inbox',
    defaultCardType: 'task',
    prefill: { assigneeUserId: meId },
    onCreated: () => {
      void refresh();
    },
  });

  /* ---------------------------------------------------------- data fetch */

  /** Build the `tree` field from the active filter predicate; null when off. */
  function buildTree(): CardWhereTree | undefined {
    if (predicate === null) return undefined;
    if (isFlatAndOfLeaves(predicate)) {
      // Server's CardWhereGroup expects a `connective` at the root; wrap a
      // bare leaf in a single-child AND so the wire shape is always a group.
      if (predicate.kind === 'leaf') {
        return predicateToJson({
          kind: 'group',
          connective: 'and',
          children: [predicate],
        }) as CardWhereTree;
      }
    }
    return predicateToJson(predicate) as CardWhereTree;
  }

  async function refresh(): Promise<void> {
    loading = true;
    error = null;

    const treeArg = buildTree();
    const inboxData: InboxSelectInput = { userId: meId, limit: 200, scope: viewMode };
    if (treeArg !== undefined) inboxData.tree = treeArg;
    const scoped = projectScope.projectId;
    if (scoped !== null) inboxData.parentCardId = scoped;

    // Issue every sub-request synchronously this tick so the dispatcher folds
    // them into ONE POST /api/v1/batch.
    const fInbox = dispatcher.request<InboxSelectInput, InboxSelectOutput>({
      endpoint: inboxSelect.endpoint,
      action: inboxSelect.action,
      data: inboxData,
    });
    const fUsers = dispatcher.request<UserSelectInput, UserSelectOutput>({
      endpoint: userSelect.endpoint,
      action: userSelect.action,
      data: {},
    });
    const fMilestones = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: { cardTypeName: 'milestone' },
    });
    const fComponents = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: { cardTypeName: 'component' },
    });
    const fTags = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: { cardTypeName: 'tag' },
    });
    // `AttributeSchemaCache.load()` issues `attribute_def.select` on the
    // same tick (and short-circuits on subsequent screen mounts).
    const fSchema = schemaCache.load();

    try {
      const [inboxOut, userOut, mOut, cOut, tagOut] = await Promise.all([
        fInbox,
        fUsers,
        fMilestones,
        fComponents,
        fTags,
        fSchema,
      ]);

      rows = inboxOut.rows;
      users = userOut.rows;
      milestones = mOut.rows;
      components = cOut.rows;
      tagsRows = tagOut.rows;

      // Keep the row selection in range.
      if (selectedIndex >= rows.length) {
        selectedIndex = rows.length === 0 ? 0 : rows.length - 1;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  // Initial fetch + refetch whenever the project scope or view mode flips.
  // We deliberately enumerate the tracked deps so unrelated state mutations
  // don't trigger a refetch storm. Other re-fetches go through explicit
  // handlers (`onFilterChange`, reorder).
  $effect(() => {
    void projectScope.projectId;
    void viewMode;
    untrack(() => {
      void refresh();
    });
  });

  /* ----------------------------------------------------- filter changes */

  function onFilterChange(_p: Predicate | null): void {
    // `predicate` is bound from <FilterBar bind:predicate>, so its new value is
    // already in scope by the time onchange fires. Re-fetch with the new tree.
    void refresh();
  }

  /* --------------------------------------------------- TaskRow adapter */

  function rowToCard(r: InboxRow): CardWithAttrs {
    const out: CardWithAttrs = {
      id: r.id,
      card_type_id: r.card_type_id,
      card_type_name: 'task',
      attributes: r.attributes,
    };
    if (r.parent_card_id !== undefined) out.parent_card_id = r.parent_card_id;
    return out;
  }

  /* -------------------------------------------------------------- reorder */

  /**
   * Move `row` to slot `slot`. The plan may issue multiple
   * `user_card_sort.set` writes (see {@link planReorder} for why); they
   * fly in one render tick and the dispatcher coalesces them into a
   * single batch. Optimistic UI; on error we snap back and toast.
   */
  async function reorderToSlot(row: InboxRow, slot: number): Promise<void> {
    // Convert the slot index (0..N, where N == rows.length means "tail")
    // into the equivalent position in the destination list (where the
    // moved row has been removed first). insertAt counts BEFORE row[i],
    // so an in-place move that crosses the moved row's old slot gets a
    // -1 correction.
    let insertAt = slot;
    const origIdx = rows.findIndex((r) => r.id === row.id);
    if (origIdx >= 0 && origIdx < slot) insertAt -= 1;

    const updates = planReorder(rows, row.id, insertAt);
    if (updates.length === 0) return; // no-op move (slot equals current position)

    // Optimistic update: replace `rows` with the new order, applying the
    // synthetic sort_orders so the visible list matches the commit
    // before the server round-trip resolves.
    const original = rows.slice();
    const without = rows.filter((r) => r.id !== row.id);
    let target = insertAt;
    if (target < 0) target = 0;
    if (target > without.length) target = without.length;
    const next = without.slice();
    next.splice(target, 0, row);
    rows = next.map((r, i) => ({
      ...r,
      personal_sort_order: (i + 1) * SORT_ORDER_STEP,
    }));

    try {
      await Promise.all(
        updates.map((u) =>
          dispatcher.request<UserCardSortSetInput, UserCardSortSetOutput>({
            endpoint: userCardSortSet.endpoint,
            action: userCardSortSet.action,
            data: u,
          }),
        ),
      );
      // Refresh from the server so we pick up any normalisation it did
      // (e.g. clamped sort_orders, post-move filter changes).
      await refresh();
    } catch (e) {
      rows = original;
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Reorder failed: ${msg}` });
    }
  }

  /**
   * Convenience wrapper for keyboard reorder — moves the currently selected
   * row by `delta` (±1) and issues the `user_card_sort.set`.
   */
  async function reorderSelected(delta: number): Promise<void> {
    if (rows.length < 2) return;
    if (selectedIndex < 0 || selectedIndex >= rows.length) return;
    const row = rows[selectedIndex];
    if (row === undefined) return;
    const newIdx = move(rows.length, selectedIndex, delta);
    if (newIdx === selectedIndex) return;
    // Slot semantics: row landing at index `newIdx` from index `selectedIndex`.
    // For up moves the slot is `newIdx`; for down moves the slot is `newIdx + 1`
    // (because slots sit BEFORE rows). Either way, reorderToSlot handles the
    // origIdx adjustment.
    const slot = delta > 0 ? newIdx + 1 : newIdx;
    await reorderToSlot(row, slot);
    selectedIndex = newIdx;
  }

  /* ----------------------------------------------------- DropZone helpers */

  function acceptsInboxRow(payload: unknown): boolean {
    if (payload === null || typeof payload !== 'object') return false;
    return 'id' in (payload as Record<string, unknown>) &&
      'attributes' in (payload as Record<string, unknown>);
  }

  function onSlotDrop(slot: number): (p: unknown) => void {
    return (p: unknown) => {
      if (!acceptsInboxRow(p)) return;
      void reorderToSlot(p as InboxRow, slot);
    };
  }

  /* ---------------------------------------------------- keyboard shortcuts */

  /** Capture the rendered inbox order into the task nav-list store and
   *  navigate to the chosen task. Both keyboard `Enter` and a row click
   *  funnel through here so the prev/next chevrons on the detail screen
   *  see the same list either way. */
  function openTaskById(id: number): void {
    setTaskNavList({
      label: viewMode === 'mine' ? 'Inbox' : 'Inbox (all open)',
      ids: rows.map((r) => r.id),
    });
    navigate(`/task/${id}`);
  }

  function openSelected(): void {
    const r = rows[selectedIndex];
    if (r === undefined) return;
    openTaskById(r.id);
  }

  async function toggleSelectedDone(): Promise<void> {
    const r = rows[selectedIndex];
    if (r === undefined) return;
    const { payload } = predicateToggleStatus(r.attributes['status']);
    try {
      await dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
        endpoint: attributeUpdate.endpoint,
        action: attributeUpdate.action,
        data: {
          cardId: r.id,
          attributeName: payload.attributeName,
          value: payload.value,
        },
      });
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Toggle failed: ${msg}` });
    }
  }

  // Plain navigation: j/k or arrow keys. The pair lets vim-style users
  // and arrow-key users coexist without remapping anything.
  useShortcut('inbox', ['j', 'ArrowDown'], () => {
    selectedIndex = move(rows.length, selectedIndex, 1);
  }, 'Down');

  useShortcut('inbox', ['k', 'ArrowUp'], () => {
    selectedIndex = move(rows.length, selectedIndex, -1);
  }, 'Up');

  useShortcut('inbox', 'Enter', () => {
    openSelected();
  }, 'Open selected task');

  useShortcut('inbox', 'Space', () => {
    void toggleSelectedDone();
  }, 'Toggle done on selected');

  // Reorder: Shift modifier on the same nav keys (or Shift+arrow) moves
  // the row itself rather than just the cursor. Replaces the older
  // Mod+ArrowUp/Down pair which Chrome on some Linux setups intercepts
  // for tab/page nav, so the binding never reached the dispatcher.
  useShortcut('inbox', ['Shift+j', 'Shift+ArrowDown'], () => {
    void reorderSelected(1);
  }, 'Move row down');

  useShortcut('inbox', ['Shift+k', 'Shift+ArrowUp'], () => {
    void reorderSelected(-1);
  }, 'Move row up');

  /* ------------------------------------------------------------- helpers */

  function previewLabelFor(row: InboxRow): string {
    const t = row.attributes['title'];
    if (typeof t === 'string' && t.length > 0) return t;
    return `#${row.id}`;
  }
</script>

<div class="flex h-full flex-col">
  <header class="flex items-center justify-between gap-3 px-4 py-3" data-testid="inbox-header">
    <div class="flex items-center gap-3">
      <h1 class="text-base font-semibold">
        Inbox — {rows.length} open task{rows.length === 1 ? '' : 's'}
      </h1>
      <div
        class="inline-flex overflow-hidden rounded-md border border-border text-xs"
        role="group"
        aria-label="Inbox scope"
      >
        <button
          type="button"
          class={cx(
            'px-2 py-1 transition-colors',
            viewMode === 'mine'
              ? 'bg-accent text-accent-fg'
              : 'bg-bg text-fg hover:bg-surface',
          )}
          aria-pressed={viewMode === 'mine'}
          onclick={() => {
            viewMode = 'mine';
          }}
        >Mine</button>
        <button
          type="button"
          class={cx(
            'border-l border-border px-2 py-1 transition-colors',
            viewMode === 'all'
              ? 'bg-accent text-accent-fg'
              : 'bg-bg text-fg hover:bg-surface',
          )}
          aria-pressed={viewMode === 'all'}
          onclick={() => {
            viewMode = 'all';
          }}
        >All open</button>
      </div>
    </div>
    <Button size="sm" variant="secondary" onclick={() => qe.open()}>
      {#snippet children()}New task{/snippet}
    </Button>
  </header>

  <div class="border-b border-border px-4 pb-3" data-testid="inbox-filter-bar">
    <FilterBar
      attributes={filterAttributes}
      bind:predicate
      scope="inbox"
      onchange={onFilterChange}
      {quickChips}
    />
  </div>

  {#if loading && rows.length === 0 && predicate === null}
    <div class="flex flex-1 items-center justify-center" data-testid="inbox-loading">
      <Spinner size="lg" />
    </div>
  {:else if error !== null}
    <div class="flex flex-1 items-center justify-center p-6" data-testid="inbox-error">
      <EmptyState
        title="Failed to load inbox"
        description={error}
        action={{ label: 'Retry', onClick: () => void refresh() }}
      />
    </div>
  {:else if rows.length === 0}
    <div class="flex flex-1 items-center justify-center" data-testid="inbox-empty">
      <EmptyState title="Your inbox is clear." description="Nothing assigned to you right now." />
    </div>
  {:else}
    <div class="flex-1 overflow-auto px-4 py-2" data-testid="inbox-list">
      {#each rows as row, i (row.id)}
        <DropZone
          id={`inbox-before-${row.id}`}
          onDrop={onSlotDrop(i)}
          accepts={acceptsInboxRow}
        />
        <div class="my-1 flex items-stretch gap-1" data-row-id={row.id}>
          <DragHandle
            payload={row}
            previewLabel={previewLabelFor(row)}
            class="row-grip"
          >
            <span
              aria-label="Drag to reorder"
              title="Drag to reorder"
              class="row-grip-glyph flex h-full w-4 cursor-grab select-none items-center justify-center rounded-sm border border-transparent text-muted hover:border-border hover:bg-surface"
            >⋮⋮</span>
          </DragHandle>
          <div class="min-w-0 flex-1">
            <TaskRow
              card={rowToCard(row)}
              selected={i === selectedIndex}
              onSelect={() => {
                selectedIndex = i;
              }}
              onOpen={() => openTaskById(row.id)}
              userNames={userNames}
              cardTitles={cardTitles}
              tagPaths={tagPaths}
              statusOptions={statusAttribute?.options}
            />
          </div>
        </div>
      {/each}
      <DropZone
        id="inbox-tail"
        onDrop={onSlotDrop(rows.length)}
        accepts={acceptsInboxRow}
      />
    </div>
  {/if}
</div>

<QuickEntryOverlay {...qe.props} />
