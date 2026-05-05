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
    attributeDefSelect,
    cardSelectWithAttributes,
    inboxSelect,
    userCardSortSet,
    userSelect,
    attributeUpdate,
  } from '../reg/handlers';
  import type {
    AttributeDefSelectInput,
    AttributeDefSelectOutput,
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
    UserSelectInput,
    UserSelectOutput,
  } from '../reg/types';

  import FilterBar from '../filter/FilterBar.svelte';
  import {
    type FilterAttribute,
    type FilterAttributeOption,
  } from '../filter/attribute_schema.svelte';
  import {
    isFlatAndOfLeaves,
    predicateToJson,
    type Predicate,
  } from '../filter/predicate';
  import { defaultQuickChipsFor, type QuickChip } from '../filter/quick_chips';

  import DragHandle from '../dnd/DragHandle.svelte';
  import DropZone from '../dnd/DropZone.svelte';

  import { setActiveScope, useShortcut } from '../keys/shortcut';

  import { useQuickEntry } from '../quick_entry/use_quick_entry.svelte';
  import QuickEntryOverlay from '../quick_entry/QuickEntryOverlay.svelte';

  import { navigate } from '../routing/router.svelte';

  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Spinner from '../ui/Spinner.svelte';
  import { notify } from '../ui/toast.svelte';
  import TaskRow from '../ui/widgets/TaskRow.svelte';

  import { computeNewSortOrder, move, predicateToggleStatus } from './inbox_helpers';

  /* ------------------------------------------------------------------ scope */
  setActiveScope('inbox');

  /* ------------------------------------------------------------- dependencies */
  const dispatcher = getDispatcher();
  const authState = getContext<AuthState | undefined>('authState');

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
  let userNames = $state<Record<number, string>>({});
  let cardTitles = $state<Record<number, string>>({});
  let tagPaths = $state<Record<number, string>>({});
  let schemaDefs = $state<FilterAttribute[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let predicate = $state<Predicate | null>(null);
  let selectedIndex = $state(0);

  /* ----------------------------------------------------- computed filter UI */

  /** FilterBar `attributes` list. Mirrors the Dart `_filterAttributes`. */
  const filterAttributes = $derived.by((): FilterAttribute[] => {
    const assigneeOpts: FilterAttributeOption[] = Object.entries(userNames).map(
      ([id, name]) => ({ value: Number(id), label: name }),
    );
    const milestoneOpts: FilterAttributeOption[] = [];
    const componentOpts: FilterAttributeOption[] = [];
    for (const [id, title] of Object.entries(cardTitles)) {
      // We can't distinguish milestone/component by id alone here without
      // tracking type — but `cardTitles` already pools both. The picker just
      // shows titles; the wire op is the same regardless.
      milestoneOpts.push({ value: Number(id), label: title });
      componentOpts.push({ value: Number(id), label: title });
    }

    // Status: derive options from attribute_def cache when available; fall
    // back to the canonical set the Dart screen hardcoded.
    const statusDef = schemaDefs.find((d) => d.name === 'status');
    const statusOpts: FilterAttributeOption[] = statusDef?.options ?? [
      { value: 'todo', label: 'todo' },
      { value: 'doing', label: 'doing' },
      { value: 'review', label: 'review' },
      { value: 'done', label: 'done' },
    ];

    return [
      {
        name: 'status',
        label: 'Status',
        valueType: 'enum',
        options: statusOpts,
        ops: ['eq', 'ne', 'in', 'notIn', 'exists', 'notExists'],
      },
      {
        name: 'assignee',
        label: 'Assignee',
        valueType: 'ref:user',
        options: assigneeOpts,
        ops: ['eq', 'ne', 'in', 'notIn', 'exists', 'notExists'],
      },
      {
        name: 'milestone_ref',
        label: 'Milestone',
        valueType: 'ref:milestone',
        options: milestoneOpts,
        ops: ['eq', 'ne', 'in', 'notIn', 'exists', 'notExists'],
      },
      {
        name: 'component_ref',
        label: 'Component',
        valueType: 'ref:component',
        options: componentOpts,
        ops: ['eq', 'ne', 'in', 'notIn', 'exists', 'notExists'],
      },
    ];
  });

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
    const inboxData: InboxSelectInput = { userId: meId, limit: 200 };
    if (treeArg !== undefined) inboxData.tree = treeArg;

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
    const fSchema = dispatcher.request<
      AttributeDefSelectInput,
      AttributeDefSelectOutput
    >({
      endpoint: attributeDefSelect.endpoint,
      action: attributeDefSelect.action,
      data: {},
    });

    try {
      const [inboxOut, userOut, mOut, cOut, tagOut, schemaOut] = await Promise.all([
        fInbox,
        fUsers,
        fMilestones,
        fComponents,
        fTags,
        fSchema,
      ]);

      rows = inboxOut.rows;

      const nextUserNames: Record<number, string> = {};
      for (const u of userOut.rows) nextUserNames[u.id] = u.display_name;
      userNames = nextUserNames;

      const nextCardTitles: Record<number, string> = {};
      const merge = (out: CardSelectWithAttributesOutput): void => {
        for (const r of out.rows) {
          const t = r.attributes['title'];
          if (typeof t === 'string' && t.length > 0) nextCardTitles[r.id] = t;
        }
      };
      merge(mOut);
      merge(cOut);
      cardTitles = nextCardTitles;

      const nextTagPaths: Record<number, string> = {};
      for (const r of tagOut.rows) {
        const p = r.attributes['path'];
        if (typeof p === 'string') nextTagPaths[r.id] = p;
      }
      tagPaths = nextTagPaths;

      // Build a slim FilterAttribute view from attribute_def rows so the
      // chip generator can find the status enum's options.
      const nextSchema: FilterAttribute[] = schemaOut.rows.map((d) => {
        const fa: FilterAttribute = {
          name: d.name,
          label: d.name,
          valueType: d.value_type,
          ops: ['eq', 'ne', 'in', 'notIn', 'exists', 'notExists'],
        };
        if (d.options !== undefined && d.options.length > 0) {
          fa.options = d.options.map((o) => ({ value: o.value, label: o.label }));
        }
        return fa;
      });
      schemaDefs = nextSchema;

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

  // Initial fetch — fire once on mount. Use $effect with untrack so we don't
  // re-run when the rune dependencies referenced in `refresh` change shape.
  $effect(() => {
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
   * Move `row` to slot `slot`. Issues ONE `user_card_sort.set`. Optimistic
   * UI; on error we snap back and toast the message.
   */
  async function reorderToSlot(row: InboxRow, slot: number): Promise<void> {
    // Compute the destination list as it WOULD look post-move so the
    // sort_order math doesn't include the dragged row itself.
    const without = rows.filter((r) => r.id !== row.id);
    let insertAt = slot;
    const origIdx = rows.findIndex((r) => r.id === row.id);
    if (origIdx >= 0 && origIdx < slot) insertAt -= 1;
    if (insertAt < 0) insertAt = 0;
    if (insertAt > without.length) insertAt = without.length;

    const newSort = computeNewSortOrder(without, insertAt);

    const original = rows.slice();
    const moved: InboxRow = { ...row, personal_sort_order: newSort };
    const next = without.slice();
    next.splice(insertAt, 0, moved);
    rows = next;

    try {
      await dispatcher.request<UserCardSortSetInput, UserCardSortSetOutput>({
        endpoint: userCardSortSet.endpoint,
        action: userCardSortSet.action,
        data: { cardId: row.id, sortOrder: newSort },
      });
      // Refresh from the server so we pick up any normalisation it did.
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

  function openSelected(): void {
    const r = rows[selectedIndex];
    if (r === undefined) return;
    navigate(`/task/${r.id}`);
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

  useShortcut('inbox', 'j', () => {
    selectedIndex = move(rows.length, selectedIndex, 1);
  }, 'Move selection down');

  useShortcut('inbox', 'k', () => {
    selectedIndex = move(rows.length, selectedIndex, -1);
  }, 'Move selection up');

  useShortcut('inbox', 'Enter', () => {
    openSelected();
  }, 'Open selected task');

  useShortcut('inbox', 'Space', () => {
    void toggleSelectedDone();
  }, 'Toggle done on selected');

  useShortcut('inbox', 'Mod+ArrowDown', () => {
    void reorderSelected(1);
  }, 'Move selected row down');

  useShortcut('inbox', 'Mod+ArrowUp', () => {
    void reorderSelected(-1);
  }, 'Move selected row up');

  /* ------------------------------------------------------------- helpers */

  function previewLabelFor(row: InboxRow): string {
    const t = row.attributes['title'];
    if (typeof t === 'string' && t.length > 0) return t;
    return `#${row.id}`;
  }
</script>

<div class="flex h-full flex-col">
  <header class="flex items-center justify-between gap-3 px-4 py-3" data-testid="inbox-header">
    <h1 class="text-base font-semibold">
      Inbox — {rows.length} open task{rows.length === 1 ? '' : 's'}
    </h1>
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
          id={`inbox-slot-${i}`}
          onDrop={onSlotDrop(i)}
          accepts={acceptsInboxRow}
        />
        <DragHandle payload={row} previewLabel={previewLabelFor(row)}>
          <div class="my-1" data-row-id={row.id}>
            <TaskRow
              card={rowToCard(row)}
              selected={i === selectedIndex}
              onSelect={() => {
                selectedIndex = i;
              }}
              onOpen={() => navigate(`/task/${row.id}`)}
              userNames={userNames}
              cardTitles={cardTitles}
              tagPaths={tagPaths}
            />
          </div>
        </DragHandle>
      {/each}
      <DropZone
        id={`inbox-slot-${rows.length}`}
        onDrop={onSlotDrop(rows.length)}
        accepts={acceptsInboxRow}
      />
    </div>
  {/if}
</div>

<QuickEntryOverlay {...qe.props} />
