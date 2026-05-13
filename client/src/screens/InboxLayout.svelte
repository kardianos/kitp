<!--
  InboxScreen — per-user list of "open work assigned to me", sortable by
  personal_sort_order, with drag-drop reorder and a FilterBar with
  quick-chips. Ports `client/lib/ui/screens/inbox_screen.dart`.

  Initial batch (one POST /api/v1/batch via the dispatcher's per-tick
  coalescing):
    1. inbox.select   (with optional userId, tree, limit=200)
    2. card.select_with_attributes for persons    (cardTypeName='person'; assignee labels)
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
    flowStepListForCard,
    userCardSortSet,
  } from '../reg/handlers';
  import type {
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWhereTree,
    CardWithAttrs,
    FlowStepListForCardInput,
    FlowStepListForCardOutput,
    ID,
    TransitionRow,
    UserCardSortSetInput,
    UserCardSortSetOutput,
  } from '../reg/types';

  import ScreenFilterBar from '../filter/ScreenFilterBar.svelte';
  import {
    sharedSchemaCache,
    type FilterAttribute,
  } from '../filter/attribute_schema.svelte';
  import {
    isFlatAndOfLeaves,
    predicateToJson,
    type Predicate,
  } from '../filter/predicate';
  import { buildTaskFilterPalette } from '../filter/task_palette';

  import DragHandle from '../dnd/DragHandle.svelte';
  import DropZone from '../dnd/DropZone.svelte';

  import { setActiveScope, useShortcut } from '../keys/shortcut';
  import { projectScope } from '../shell/project_scope.svelte';

  import { useQuickEntry } from '../quick_entry/use_quick_entry.svelte';
  import QuickEntryOverlay from '../quick_entry/QuickEntryOverlay.svelte';

  import { navigate } from '../routing/router.svelte';
  import { setTaskNavList } from '../routing/task_nav_list.svelte';
  import { getFilter } from './filter_state.svelte';

  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Spinner from '../ui/Spinner.svelte';
  import { notify } from '../ui/toast.svelte';
  import TaskRow from '../ui/widgets/TaskRow.svelte';

  import {
    move,
    planReorder,
    SORT_ORDER_STEP,
  } from './inbox_helpers';

  import { useBag } from '../dispatch/bag.svelte';
  import { userSelect } from '../reg/handlers';
  import {
    userCardAgentClear,
    userCardAgentList,
    userCardAgentSet,
  } from '../reg/handlers_admin';
  import type {
    UserCardAgentClearInput,
    UserCardAgentClearOutput,
    UserCardAgentListInput,
    UserCardAgentListOutput,
    UserCardAgentSetInput,
    UserCardAgentSetOutput,
    UserRow,
  } from '../reg/types';

  /* ------------------------------------------------------------------ scope */
  setActiveScope('inbox');

  /* ------------------------------------------------------------- dependencies */
  const dispatcher = getDispatcher();
  const authState = getContext<AuthState | undefined>('authState');
  const schemaCache = sharedSchemaCache(dispatcher);

  /**
   * TEMPORARY: System User has no assigned tasks; until OIDC-driven user
   * resolution lands we pin to alice (id=2) so the screen looks lived-in.
   * Mirrors `kCurrentUserId` in the Dart source.
   */
  const kCurrentUserId: ID = 2n;

  function parseMeId(): ID {
    const sub = authState?.claims?.sub;
    if (typeof sub === 'string' && sub.length > 0) {
      try {
        const n = BigInt(sub);
        if (n > 0n) return n;
      } catch {
        /* fall through */
      }
    }
    return kCurrentUserId;
  }

  const meId = parseMeId();

  /* ------------------------------------------------------------------- state */

  let rows = $state<CardWithAttrs[]>([]);
  let persons = $state<CardWithAttrs[]>([]);
  let milestones = $state<CardWithAttrs[]>([]);
  let components = $state<CardWithAttrs[]>([]);
  let tagsRows = $state<CardWithAttrs[]>([]);
  let statuses = $state<CardWithAttrs[]>([]);
  /**
   * Available transitions per task card. Keys are id.toString().
   * Populated after the main row batch lands by issuing one
   * `flow_step.list_for_card` per visible card — coalesced by the
   * dispatcher into ONE POST /api/v1/batch.
   *
   * TODO(perf): swap for a batched `flow_step.list_for_cards
   * { card_ids[] }` once the server exposes one. N+1 is fine while we
   * have ~200 rows max and the dispatcher folds them into one HTTP call,
   * but it grows the per-request workload server-side.
   */
  let transitionsByCardId = $state<Record<string, TransitionRow[]>>({});
  let loading = $state(true);
  let error = $state<string | null>(null);
  // <ScreenFilterBar> owns the predicate, the active preset id, and the
  // load-on-scope-change effect. We just bind to `predicate` and react
  // to its onchange callback.
  let predicate = $state<Predicate | null>(
    untrack(() => getFilter('inbox', projectScope.projectId)),
  );
  let selectedIndex = $state(0);

  /* ----------------------------- delegate-to-agent (per-row) -----------
   * Cards assigned to me show a small "delegate to" picker on each row
   * in Mine view. Picking an agent writes user_card_agent.set; choosing
   * "—" clears it. The picker is hidden when the signed-in user is
   * themselves an agent (agents see routed-to-me view; they cannot
   * sub-delegate further) or when they have no agents to delegate to.
   * Routings are loaded as part of the initial refresh batch and held
   * in `routingByCardId` so the picker reflects the current state. */
  const bag = useBag(dispatcher);
  let myAgents = $state<UserRow[]>([]);
  /** card_id.toString() → agent user_account id currently routed for that card. */
  let routingByCardId = $state<Record<string, ID>>({});

  const loadMyAgents = bag.bind(userSelect, 'inbox.my_agents', (r) => {
    if (r.ok) myAgents = r.data.rows;
  });

  const showAgentPicker = $derived(
    authState?.isAgent !== true && myAgents.length > 0,
  );

  function setRouting(cardId: ID, agentId: ID): void {
    const key = cardId.toString();
    const prev = routingByCardId[key];
    routingByCardId[key] = agentId;
    dispatcher
      .request<UserCardAgentSetInput, UserCardAgentSetOutput>({
        endpoint: userCardAgentSet.endpoint,
        action: userCardAgentSet.action,
        data: { cardId, agentUserId: agentId },
      })
      .catch((e) => {
        if (prev === undefined) delete routingByCardId[key];
        else routingByCardId[key] = prev;
        const msg = e instanceof Error ? e.message : String(e);
        notify({ type: 'error', message: `Delegate failed: ${msg}` });
      });
  }

  function clearRouting(cardId: ID): void {
    const key = cardId.toString();
    const prev = routingByCardId[key];
    delete routingByCardId[key];
    dispatcher
      .request<UserCardAgentClearInput, UserCardAgentClearOutput>({
        endpoint: userCardAgentClear.endpoint,
        action: userCardAgentClear.action,
        data: { cardId },
      })
      .catch((e) => {
        if (prev !== undefined) routingByCardId[key] = prev;
        const msg = e instanceof Error ? e.message : String(e);
        notify({ type: 'error', message: `Clear delegation failed: ${msg}` });
      });
  }

  function onPickAgent(cardId: ID, ev: Event): void {
    const v = (ev.currentTarget as HTMLSelectElement).value;
    if (v === '') {
      clearRouting(cardId);
      return;
    }
    try {
      setRouting(cardId, BigInt(v));
    } catch {
      notify({ type: 'error', message: 'Invalid agent id' });
    }
  }

  /** Derived lookup tables for `<TaskRow>` props. */
  const personNames = $derived.by((): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const p of persons) {
      const t = p.attributes['title'];
      if (typeof t === 'string') out[p.id.toString()] = t;
    }
    return out;
  });
  const cardTitles = $derived.by((): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const r of milestones) {
      const t = r.attributes['title'];
      if (typeof t === 'string') out[r.id.toString()] = t;
    }
    for (const r of components) {
      const t = r.attributes['title'];
      if (typeof t === 'string') out[r.id.toString()] = t;
    }
    return out;
  });
  const tagPaths = $derived.by((): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const r of tagsRows) {
      const p = r.attributes['path'];
      if (typeof p === 'string') out[r.id.toString()] = p;
    }
    return out;
  });
  /**
   * Per-card transition lookup for `<TaskRow transitions={...}>`. Falls
   * back to an empty array so the row renders cleanly while
   * transitionsByCardId is still loading or for cards without flows.
   */
  function transitionsFor(card: CardWithAttrs): TransitionRow[] {
    return transitionsByCardId[card.id.toString()] ?? [];
  }
  /* ----------------------------------------------------- computed filter UI */

  /**
   * FilterBar palette. One source of truth lives in `task_palette.ts` so
   * the same names / labels / option lists render across Inbox, Grid,
   * Kanban, and ProjectDetail.
   */
  const filterAttributes = $derived<FilterAttribute[]>(
    buildTaskFilterPalette({
      schema: schemaCache,
      // Assignee is a card_ref → person card; the palette resolves it
      // via its refResolver from this list.
      persons,
      milestones,
      components,
      tags: tagsRows,
      statuses,
    }),
  );

  /* --------------------------------------------------------- quick-entry */

  // We deliberately omit `assigneeOptions` here: the inbox always prefills
  // the current user, and the overlay's combobox reads from a static prop
  // (it would not reactively re-render if `personNames` changed). Users who
  // need to retarget can do it from the task detail screen.
  //
  // Gate 6: statuses are threaded through as the candidate set for the
  // default-create-status chain (no flow yet — that lands when the
  // client gains a flow.list handler). The Inbox doesn't load its own
  // screen card (ScreenFilterBar handles that internally), so the
  // screen-level override is absent here; the chain falls through to
  // first-triage / first-active. The getter form keeps the rune
  // reactive: when statuses populate asynchronously the latest list
  // is read at submit time, not at construction.
  const qe = useQuickEntry({
    scope: 'inbox',
    defaultCardType: 'task',
    prefill: { assigneeUserId: meId },
    candidateStatuses: () => statuses,
    onCreated: () => {
      void refresh();
    },
  });

  // Preload my agents so the routing dropdown has options ready. Cheap
  // single request that piggy-backs onto the same batch as the inbox's
  // own initial fetches when selection mode is engaged.
  $effect(() => {
    loadMyAgents({ parentUserId: meId, isAgent: true });
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

  /**
   * AND an `assignee = me` leaf onto the user's existing tree so the
   * Inbox shows only the actor's tasks. The leaf is inserted into the
   * existing AND group when present so the wire shape stays a single
   * connected tree (matches the legacy inbox.select behaviour without
   * re-using its server endpoint).
   *
   * The Inbox screen card's `toggle_groups.scope.mine_only` item
   * (default_on=true) is the data-side declaration of this same scope;
   * once `<ScreenToggleGroups>` lands it will emit the leaf instead of
   * this inline hardcode.
   */
  function applyAssigneeScope(
    tree: CardWhereTree | undefined,
    userId: ID,
  ): CardWhereTree | undefined {
    const meLeaf = { attr: 'assignee', op: '=', values: [userId] };
    if (tree === undefined) {
      return { connective: 'and', children: [meLeaf] };
    }
    if (tree.connective === 'and' && Array.isArray(tree.children)) {
      return {
        connective: 'and',
        children: [meLeaf, ...(tree.children as unknown[])],
      };
    }
    // Non-AND root (or, not) — AND it together with the assignee leaf.
    return { connective: 'and', children: [meLeaf, tree] };
  }

  async function refresh(): Promise<void> {
    loading = true;
    error = null;

    // The inbox is just a per-user task list with the personal sort
    // join — the same handler Grid / Kanban / ProjectDetail call. The
    // assignee filter is the seeded `toggle_groups.scope.mine_only`
    // item layered onto the user's saved predicate. When the signed-in
    // user is an agent (#50), the assignee filter is replaced with the
    // `routed_to_me` flag so the result is the parent's routings to
    // this agent rather than tasks the agent is itself assigned to.
    const userTree = buildTree();
    const taskInput: CardSelectWithAttributesInput = {
      cardTypeName: 'task',
      limit: 200,
      withPersonalSort: true,
      order: [
        { field: 'personal_sort_order', direction: 'ASC' },
        { field: 'created_at', direction: 'DESC' },
      ],
    };
    if (authState?.isAgent === true) {
      taskInput.routedToMe = true;
      // Agent view skips the assignee scope — the routed-to-me filter
      // already narrows to the actor's queue; user-authored predicates
      // still apply on top.
      if (userTree !== undefined) taskInput.tree = userTree;
    } else {
      const treeArg = applyAssigneeScope(userTree, meId);
      if (treeArg !== undefined) taskInput.tree = treeArg;
    }
    const scoped = projectScope.projectId;
    if (scoped !== null) taskInput.parentCardId = scoped;

    // Issue every sub-request synchronously this tick so the dispatcher folds
    // them into ONE POST /api/v1/batch.
    const fInbox = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: taskInput,
    });
    const fPersons = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: { cardTypeName: 'person' },
    });
    // Picker queries inherit the active project scope. Milestones,
    // components, and tags sit one level under their project in v1, so
    // filtering by `parentCardId` is equivalent to "in this project."
    // The all-projects view leaves the filter unset so every option
    // shows up (callers see them grouped by project at the chip level).
    const milestoneData: CardSelectWithAttributesInput = { cardTypeName: 'milestone' };
    const componentData: CardSelectWithAttributesInput = { cardTypeName: 'component' };
    const tagData: CardSelectWithAttributesInput = { cardTypeName: 'tag' };
    const statusData: CardSelectWithAttributesInput = { cardTypeName: 'status' };
    if (scoped !== null) {
      milestoneData.parentCardId = scoped;
      componentData.parentCardId = scoped;
      tagData.parentCardId = scoped;
      statusData.parentCardId = scoped;
    }
    const fMilestones = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: milestoneData,
    });
    const fComponents = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: componentData,
    });
    const fTags = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: tagData,
    });
    const fStatuses = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: statusData,
    });
    // Existing routings the actor owns. Folded into the same batch so
    // the per-row picker can display the current target on first paint.
    // Agents skip this — they're the routing target, not the owner.
    const fRoutings = authState?.isAgent === true
      ? Promise.resolve<UserCardAgentListOutput>({ rows: [] })
      : dispatcher.request<UserCardAgentListInput, UserCardAgentListOutput>({
          endpoint: userCardAgentList.endpoint,
          action: userCardAgentList.action,
          data: scoped !== null ? { parentCardId: scoped } : {},
        });
    // `AttributeSchemaCache.load()` issues `attribute_def.select` on the
    // same tick (and short-circuits on subsequent screen mounts).
    const fSchema = schemaCache.load();

    try {
      const [inboxOut, personOut, mOut, cOut, tagOut, sOut, routingsOut] = await Promise.all([
        fInbox,
        fPersons,
        fMilestones,
        fComponents,
        fTags,
        fStatuses,
        fRoutings,
        fSchema,
      ]);

      rows = inboxOut.rows;
      persons = personOut.rows;
      milestones = mOut.rows;
      components = cOut.rows;
      tagsRows = tagOut.rows;
      statuses = sOut.rows;
      const nextRouting: Record<string, ID> = {};
      for (const r of routingsOut.rows) {
        nextRouting[r.card_id.toString()] = r.agent_user_id;
      }
      routingByCardId = nextRouting;

      // Keep the row selection in range.
      if (selectedIndex >= rows.length) {
        selectedIndex = rows.length === 0 ? 0 : rows.length - 1;
      }

      // Fetch flow_step.list_for_card per row in a fresh batched tick so
      // the dispatcher coalesces them into one POST. TODO(perf): replace
      // with a batched `flow_step.list_for_cards` once the server exposes
      // a multi-id variant — see comment on `transitionsByCardId`.
      void loadTransitionsFor(rows);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  /**
   * Issue one `flow_step.list_for_card` per row. Every call goes out on
   * the same render tick so the dispatcher folds them into ONE POST. The
   * resulting per-card transition map drives TaskRow's TransitionBar
   * affordance.
   */
  async function loadTransitionsFor(cards: readonly CardWithAttrs[]): Promise<void> {
    if (cards.length === 0) {
      transitionsByCardId = {};
      return;
    }
    const futures = cards.map((c) =>
      dispatcher
        .request<FlowStepListForCardInput, FlowStepListForCardOutput>({
          endpoint: flowStepListForCard.endpoint,
          action: flowStepListForCard.action,
          data: { cardId: c.id },
        })
        .then((out) => ({ id: c.id, rows: out.rows }))
        .catch(() => ({ id: c.id, rows: [] as TransitionRow[] })),
    );
    const results = await Promise.all(futures);
    const next: Record<string, TransitionRow[]> = {};
    for (const r of results) next[r.id.toString()] = r.rows;
    transitionsByCardId = next;
  }

  // Initial fetch + refetch whenever the project scope flips. We
  // deliberately enumerate the tracked deps so unrelated state mutations
  // don't trigger a refetch storm. Other re-fetches go through explicit
  // handlers (`onFilterChange`, reorder).
  //
  // Gated on `filterReady` so the first request waits for ScreenFilterBar
  // to apply the seeded default — otherwise the screen briefly shows the
  // un-filtered row set before the second refresh replaces it.
  let filterReady = $state(false);
  $effect(() => {
    void projectScope.projectId;
    void filterReady;
    untrack(() => {
      if (!filterReady) return;
      void refresh();
    });
  });


  /* ----------------------------------------------------- filter changes */

  function onFilterChange(_p: Predicate | null): void {
    // `predicate` is bound from <FilterBar bind:predicate>, so its new value is
    // already in scope by the time onchange fires. Re-fetch with the new tree.
    void refresh();
  }

  /* -------------------------------------------------------------- reorder */

  /**
   * Move `row` to slot `slot`. The plan may issue multiple
   * `user_card_sort.set` writes (see {@link planReorder} for why); they
   * fly in one render tick and the dispatcher coalesces them into a
   * single batch. Optimistic UI; on error we snap back and toast.
   */
  async function reorderToSlot(row: CardWithAttrs, slot: number): Promise<void> {
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
      void reorderToSlot(p as CardWithAttrs, slot);
    };
  }

  /* ---------------------------------------------------- keyboard shortcuts */

  /** Capture the rendered inbox order into the task nav-list store and
   *  navigate to the chosen task. Both keyboard `Enter` and a row click
   *  funnel through here so the prev/next chevrons on the detail screen
   *  see the same list either way. */
  function openTaskById(id: ID): void {
    setTaskNavList({
      label: 'Inbox',
      ids: rows.map((r) => r.id),
    });
    navigate(`/task/${id}`);
  }

  function openSelected(): void {
    const r = rows[selectedIndex];
    if (r === undefined) return;
    openTaskById(r.id);
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

  function previewLabelFor(row: CardWithAttrs): string {
    const t = row.attributes['title'];
    if (typeof t === 'string' && t.length > 0) return t;
    return `#${row.id}`;
  }
</script>

<div class="flex h-full flex-col">
  <header class="flex items-center justify-between gap-3 px-4 py-2" data-testid="inbox-header">
    <div class="flex items-center gap-3">
      {#if authState?.isAgent === true}
        <span
          class="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-xs font-medium text-accent"
          data-testid="inbox-agent-banner"
          title="Showing tasks routed to you by your parent user"
        >
          <span aria-hidden="true">⚡</span>
          Agent view · routed work
        </span>
      {/if}
    </div>
    <div class="flex items-center gap-2">
      <Button size="sm" variant="secondary" onclick={() => qe.open()}>
        {#snippet children()}New task{/snippet}
      </Button>
    </div>
  </header>

  <div class="border-b border-border px-4 pb-3" data-testid="inbox-filter-bar">
    <ScreenFilterBar
      screenType="list"
      projectId={projectScope.projectId}
      {dispatcher}
      {filterAttributes}
      bind:predicate
      bind:filterReady
      onchange={onFilterChange}
    >
      {#snippet trailing()}
        <span>{rows.length} open task{rows.length === 1 ? '' : 's'}</span>
        {#if loading}
          <Spinner size="sm" />
        {/if}
      {/snippet}
    </ScreenFilterBar>
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
              card={row}
              selected={i === selectedIndex}
              onSelect={() => {
                selectedIndex = i;
              }}
              onOpen={() => openTaskById(row.id)}
              personNames={personNames}
              cardTitles={cardTitles}
              tagPaths={tagPaths}
              transitions={transitionsFor(row)}
              onTransitioned={() => void refresh()}
            />
          </div>
          {#if showAgentPicker}
            {@const routedTo = routingByCardId[row.id.toString()]}
            <label
              class="flex items-center gap-1 self-center pl-2 text-xs text-muted"
              data-testid="inbox-row-delegate"
            >
              <span class="hidden sm:inline">Delegate</span>
              <select
                value={routedTo === undefined ? '' : routedTo.toString()}
                onchange={(ev) => onPickAgent(row.id, ev)}
                class="rounded-md border border-border bg-bg px-2 py-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                aria-label="Delegate task to one of your agents"
              >
                <option value="">— none —</option>
                {#each myAgents as a (a.id)}
                  <option value={a.id.toString()}>{a.display_name}</option>
                {/each}
              </select>
            </label>
          {/if}
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
