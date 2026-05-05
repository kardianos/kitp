<!--
  KanbanScreen.

  Column + (optional) swim-lane board over tasks. Drag a card between
  columns / lanes; the drop computes a new `sort_order` halfway between
  neighbours and issues ONE batch combining the sort + column-attribute
  + lane-attribute updates. The dispatcher coalesces the per-tick
  attribute.update fan-out into a single `POST /api/v1/batch`.

  Initial-batch contract (one POST):
    1. `card.select_with_attributes`  card_type_name='task', limit=500
    2. `user.select`
    3. `card.select_with_attributes`  card_type_name='milestone'
    4. `card.select_with_attributes`  card_type_name='component'
    5. `card.select_with_attributes`  card_type_name='tag'
    6. `attribute_def.select` (cached on AttributeSchemaCache)

  The column attribute defaults to `'status'`; the lane attribute
  defaults to `'(none)'` and the user picks both via header `<Combobox>`s.
  Options come from any enum-typed attribute_def or any `ref:*` def.

  Keyboard:
    - `n`                      open quick-entry overlay (via useQuickEntry)
    - `j` / `k`                move selection within a column
    - `h` / `l`                move selection across columns
    - `Mod+ArrowLeft/Right`    move selected card to prev/next column
    - `Mod+Shift+Up/Down`      move selected card up/down within column
    - `Enter`                  open selected → /task/<id>

  Ports `client/lib/ui/screens/kanban_screen.dart` (973 LOC).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { getDispatcher } from '../dispatch/context';
  import { BatchAbortedError, SubRequestError } from '../dispatch/errors';
  import {
    AttributeSchemaCache,
    type FilterAttribute,
  } from '../filter/attribute_schema.svelte';
  import FilterBar from '../filter/FilterBar.svelte';
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
  import {
    attributeUpdate,
    cardSelectWithAttributes,
    userSelect,
  } from '../reg/handlers';
  import type {
    AttributeUpdateInput,
    AttributeUpdateOutput,
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWithAttrs,
    UserRow,
    UserSelectInput,
    UserSelectOutput,
  } from '../reg/types';
  import { navigate } from '../routing/router.svelte';
  import Combobox from '../ui/Combobox.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Spinner from '../ui/Spinner.svelte';
  import { notify } from '../ui/toast.svelte';
  import { cx } from '../util/class_names';
  import {
    computeMoveBatch,
    computeNewSortOrder,
    nextColumnIndex,
    sortByOrder,
    type UpdateOp,
  } from './kanban_helpers';

  setActiveScope('kanban');

  /* ------------------------------------------------------------------ deps */

  const dispatcher = getDispatcher();
  const schema = new AttributeSchemaCache(dispatcher);

  /* ----------------------------------------------------------------- state */

  /** Sentinel column key for cards whose grouping attribute is unset. */
  const UNSET_KEY = '__unset__';
  /** Sentinel lane attribute name meaning "no swim lanes". */
  const NO_LANE = '__none__';

  /** Default column ordering for the well-known `status` attribute. */
  const STATUS_COLUMN_ORDER = ['todo', 'doing', 'review', 'done'];

  let tasks = $state<CardWithAttrs[]>([]);
  let users = $state<UserRow[]>([]);
  /** card-id → display title for milestone / component refs. */
  let cardTitles = $state<Record<number, string>>({});
  /** tag-id → path string. */
  let tagPaths = $state<Record<number, string>>({});

  let loading = $state(true);
  let error = $state<string | null>(null);

  let predicate = $state<Predicate | null>(null);
  let columnAttr = $state<string>('status');
  let laneAttr = $state<string>(NO_LANE);

  /** Keyboard navigation focus. */
  let focused = $state<{
    columnIdx: number;
    rowIdxWithinColumn: number;
    laneIdx: number;
  }>({ columnIdx: 0, rowIdxWithinColumn: 0, laneIdx: 0 });

  /* -------------------------------------------------------------- ref data */

  /** assignee_id → display name. */
  const userNames = $derived<Record<number, string>>(
    Object.fromEntries(users.map((u) => [u.id, u.display_name])),
  );

  /* ------------------------------------------------------- column / lane keys */

  /**
   * Build the ordered list of column keys for [attr]. For `status` we
   * use the canonical four-step order (plus an UNSET sentinel); for any
   * other attribute we walk every task to enumerate distinct values, then
   * append UNSET as the trailing column.
   */
  function columnKeysForAttr(attr: string): string[] {
    if (attr === 'status') {
      return [...STATUS_COLUMN_ORDER, UNSET_KEY];
    }
    const seen = new Set<string>();
    const keys: string[] = [];
    for (const t of tasks) {
      const k = keyOf(t.attributes[attr]);
      if (k === '' || k === UNSET_KEY) continue;
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
    keys.push(UNSET_KEY);
    return keys;
  }

  function laneKeysForAttr(attr: string): string[] {
    if (attr === NO_LANE) return [NO_LANE];
    return columnKeysForAttr(attr);
  }

  const columnKeys = $derived(columnKeysForAttr(columnAttr));
  const laneKeys = $derived(laneKeysForAttr(laneAttr));

  /** Map an attribute value to the bucket key used for grouping. */
  function keyOf(v: unknown): string {
    if (v === null || v === undefined) return UNSET_KEY;
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return String(v);
  }

  /** Inverse of {@link keyOf}: turn a bucket key back into a wire value. */
  function valueForKey(attr: string, key: string): unknown {
    if (key === UNSET_KEY) return null;
    if (attr === 'status') return key;
    const n = Number(key);
    if (Number.isFinite(n) && key !== '' && /^-?\d+(?:\.\d+)?$/.test(key)) {
      return n;
    }
    return key;
  }

  /** Human label for a column / lane bucket. */
  function labelFor(attr: string, key: string): string {
    if (key === UNSET_KEY || key === '') return '(unset)';
    if (attr === 'status') return key;
    if (attr === 'assignee') {
      const id = Number(key);
      if (Number.isFinite(id)) {
        return userNames[id] ?? `user#${id}`;
      }
      return key;
    }
    const id = Number(key);
    if (Number.isFinite(id)) {
      return cardTitles[id] ?? `card#${id}`;
    }
    return key;
  }

  /* --------------------------------------------------------- group cells --- */

  /**
   * `cells[laneKey][columnKey]` — the (sorted) list of cards for one
   * (column, lane) pair. Built off the active filter predicate (which
   * already narrowed the server query) so this is a pure local re-bucket.
   */
  const cells = $derived.by((): Record<string, Record<string, CardWithAttrs[]>> => {
    const out: Record<string, Record<string, CardWithAttrs[]>> = {};
    for (const lk of laneKeys) {
      out[lk] = {};
      for (const ck of columnKeys) {
        out[lk]![ck] = [];
      }
    }
    for (const t of tasks) {
      const ck = keyOf(t.attributes[columnAttr]);
      const lk = laneAttr === NO_LANE ? NO_LANE : keyOf(t.attributes[laneAttr]);
      const laneMap = out[lk] ?? (out[lk] = {});
      const list = laneMap[ck] ?? (laneMap[ck] = []);
      list.push(t);
    }
    for (const lk of Object.keys(out)) {
      const laneMap = out[lk] ?? {};
      for (const ck of Object.keys(laneMap)) {
        const list = laneMap[ck];
        if (list !== undefined) sortByOrder(list);
      }
    }
    return out;
  });

  /* --------------------------------------------------- attribute pickers --- */

  /**
   * Options for the "Columns by" / "Swim lanes by" comboboxes — every
   * enum or `ref:*` attribute_def the schema knows about, plus the four
   * built-ins the Dart source hard-coded so the picker is never empty
   * before the schema fetch resolves.
   */
  const groupOptions = $derived.by((): { value: string; label: string }[] => {
    const seen = new Map<string, string>();
    seen.set('status', 'Status');
    seen.set('assignee', 'Assignee');
    seen.set('milestone_ref', 'Milestone');
    seen.set('component_ref', 'Component');
    for (const def of schema.defs) {
      if (def.value_type === 'enum' || def.value_type.startsWith('ref:')) {
        if (!seen.has(def.name)) seen.set(def.name, def.name);
      }
    }
    return Array.from(seen.entries()).map(([value, label]) => ({ value, label }));
  });

  const laneOptions = $derived<{ value: string; label: string }[]>([
    { value: NO_LANE, label: '(none)' },
    ...groupOptions,
  ]);

  /* ------------------------------------------------------------ filter --- */

  /** FilterBar attribute palette derived from the schema cache. */
  const filterAttributes = $derived.by((): FilterAttribute[] => {
    const out: FilterAttribute[] = [];
    // status — hard-coded enum until migration 0011 lands the server-side def.
    out.push({
      name: 'status',
      label: 'Status',
      valueType: 'enum',
      ops: ['eq', 'ne', 'in', 'notIn', 'exists', 'notExists'],
      options: STATUS_COLUMN_ORDER.map((s) => ({ value: s, label: s })),
    });
    out.push({
      name: 'assignee',
      label: 'Assignee',
      valueType: 'enum',
      ops: ['eq', 'ne', 'in', 'notIn', 'exists', 'notExists'],
      options: users.map((u) => ({ value: u.id, label: u.display_name })),
    });
    out.push({
      name: 'milestone_ref',
      label: 'Milestone',
      valueType: 'ref:milestone',
      ops: ['eq', 'ne', 'in', 'notIn', 'exists', 'notExists'],
    });
    out.push({
      name: 'component_ref',
      label: 'Component',
      valueType: 'ref:component',
      ops: ['eq', 'ne', 'in', 'notIn', 'exists', 'notExists'],
    });
    return out;
  });

  const quickChips = $derived<QuickChip[]>(
    filterAttributes.flatMap((a) => defaultQuickChipsFor(a)),
  );

  /** Encode the current filter for the wire `tree` field. */
  function buildTree(): Record<string, unknown> | undefined {
    if (predicate === null) return undefined;
    if (predicate.kind === 'group') {
      return predicateToJson(predicate) as Record<string, unknown>;
    }
    void isFlatAndOfLeaves; // documentation; tree-shake elides.
    return {
      connective: 'and',
      children: [predicateToJson(predicate)],
    };
  }

  /* -------------------------------------------------------- initial batch */

  /**
   * Fire the screen's six sub-requests in one render tick. The
   * dispatcher coalesces them into a single `POST /api/v1/batch`
   * (REQUIREMENTS N-CLI-1/2/3).
   */
  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      const tasksData: CardSelectWithAttributesInput = {
        cardTypeName: 'task',
        limit: 500,
        order: [{ field: 'attributes.sort_order', direction: 'ASC' }],
      };
      const tree = buildTree();
      if (tree !== undefined) tasksData.tree = tree;

      const tasksP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: tasksData,
      });
      const usersP = dispatcher.request<UserSelectInput, UserSelectOutput>({
        endpoint: userSelect.endpoint,
        action: userSelect.action,
      });
      const milestonesP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: { cardTypeName: 'milestone' },
      });
      const componentsP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: { cardTypeName: 'component' },
      });
      const tagsP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: { cardTypeName: 'tag' },
      });
      const schemaP = schema.load();

      const [tOut, uOut, mOut, cOut, gOut] = await Promise.all([
        tasksP,
        usersP,
        milestonesP,
        componentsP,
        tagsP,
        schemaP,
      ]);

      tasks = tOut.rows;
      users = uOut.rows;

      const titles: Record<number, string> = {};
      for (const m of mOut.rows) {
        const t = m.attributes['title'];
        if (typeof t === 'string') titles[m.id] = t;
      }
      for (const c of cOut.rows) {
        const t = c.attributes['title'];
        if (typeof t === 'string') titles[c.id] = t;
      }
      cardTitles = titles;

      const paths: Record<number, string> = {};
      for (const g of gOut.rows) {
        const p = g.attributes['path'];
        if (typeof p === 'string') paths[g.id] = p;
      }
      tagPaths = paths;

      // Reset selection if it falls outside the new visible range.
      focused = { columnIdx: 0, rowIdxWithinColumn: 0, laneIdx: 0 };
    } catch (e) {
      if (e instanceof SubRequestError) {
        error = e.message;
      } else if (e instanceof BatchAbortedError) {
        error = e.reason;
      } else {
        error = e instanceof Error ? e.message : String(e);
      }
    } finally {
      loading = false;
    }
  }

  /* ----------------------------------------------------- drag-drop logic */

  /** Issue [ops] as one tick of `attribute.update` calls. */
  async function applyOps(ops: UpdateOp[]): Promise<void> {
    if (ops.length === 0) return;
    await Promise.all(
      ops.map((op) =>
        dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
          endpoint: attributeUpdate.endpoint,
          action: attributeUpdate.action,
          data: op,
        }),
      ),
    );
  }

  /**
   * Move [card] into the (column, lane) cell whose children are
   * [destStack] (post-move display order — the dragged card is excluded
   * by the caller) at [slot]. ONE batch coalesces sort_order + column +
   * lane updates; on error we snap-back the optimistic move + toast.
   */
  async function handleDrop(
    card: CardWithAttrs,
    destStack: CardWithAttrs[],
    slot: number,
    targetColumnKey: string,
    targetLaneKey: string,
  ): Promise<void> {
    const newSortOrder = computeNewSortOrder(destStack, slot);
    const targetColVal = valueForKey(columnAttr, targetColumnKey);
    const targetLaneVal =
      laneAttr === NO_LANE ? null : valueForKey(laneAttr, targetLaneKey);
    const ops = computeMoveBatch(
      card,
      targetColVal,
      targetLaneVal,
      newSortOrder,
      columnAttr,
      laneAttr === NO_LANE ? null : laneAttr,
    );
    if (ops.length === 0) return;

    // Optimistic update. Patch the card's attributes so the re-bucket
    // happens immediately — Promise.all will replace `tasks` on success
    // (next refresh() tick) or rollback on failure.
    const original = tasks;
    const patched: CardWithAttrs[] = tasks.map((t) => {
      if (t.id !== card.id) return t;
      const next = { ...t.attributes };
      for (const op of ops) {
        if (op.value === null || op.value === undefined) {
          delete next[op.attributeName];
        } else {
          next[op.attributeName] = op.value;
        }
      }
      return { ...t, attributes: next };
    });
    tasks = patched;

    try {
      await applyOps(ops);
    } catch (e) {
      tasks = original;
      const msg =
        e instanceof SubRequestError
          ? e.message
          : e instanceof BatchAbortedError
            ? e.reason
            : e instanceof Error
              ? e.message
              : String(e);
      notify({ type: 'error', message: `Move failed: ${msg}` });
    }
  }

  /** Wire-level drop adapter: builds the post-move stack from cells. */
  function onZoneDrop(
    payload: unknown,
    columnKey: string,
    laneKey: string,
    slot: number,
  ): void {
    const card = payload as CardWithAttrs;
    if (typeof card?.id !== 'number') return;
    const lane = cells[laneKey];
    const destStack = (lane?.[columnKey] ?? []).filter((c) => c.id !== card.id);
    void handleDrop(card, destStack, slot, columnKey, laneKey);
  }

  /* ----------------------------------------------------- keyboard moves */

  /** Cards in the focused (lane, column) cell, in display order. */
  function focusedCell(): CardWithAttrs[] {
    const lk = laneKeys[focused.laneIdx] ?? laneKeys[0];
    const ck = columnKeys[focused.columnIdx] ?? columnKeys[0];
    if (lk === undefined || ck === undefined) return [];
    return cells[lk]?.[ck] ?? [];
  }

  function focusedCard(): CardWithAttrs | undefined {
    return focusedCell()[focused.rowIdxWithinColumn];
  }

  function moveFocusInColumn(delta: number): void {
    const cell = focusedCell();
    if (cell.length === 0) return;
    let next = focused.rowIdxWithinColumn + delta;
    if (next < 0) next = 0;
    if (next > cell.length - 1) next = cell.length - 1;
    focused = { ...focused, rowIdxWithinColumn: next };
  }

  function moveFocusAcrossColumns(delta: number): void {
    const next = nextColumnIndex(focused.columnIdx, columnKeys.length, delta);
    focused = { ...focused, columnIdx: next, rowIdxWithinColumn: 0 };
  }

  function moveFocusAcrossLanes(delta: number): void {
    const len = laneKeys.length;
    let next = focused.laneIdx + delta;
    if (next < 0) next = 0;
    if (next > len - 1) next = len - 1;
    focused = { ...focused, laneIdx: next, rowIdxWithinColumn: 0 };
  }

  /** `Mod+Arrow{Left,Right}` — move selected card to neighbour column. */
  function moveSelectedToColumn(delta: number): void {
    const card = focusedCard();
    if (card === undefined) return;
    const targetIdx = nextColumnIndex(focused.columnIdx, columnKeys.length, delta);
    if (targetIdx === focused.columnIdx) return;
    const targetColKey = columnKeys[targetIdx];
    const lk = laneKeys[focused.laneIdx] ?? laneKeys[0] ?? NO_LANE;
    if (targetColKey === undefined) return;
    const dest = (cells[lk]?.[targetColKey] ?? []).filter((c) => c.id !== card.id);
    void handleDrop(card, dest, dest.length, targetColKey, lk);
    focused = { ...focused, columnIdx: targetIdx, rowIdxWithinColumn: 0 };
  }

  /** `Mod+Shift+Arrow{Up,Down}` — move selected card up/down within column. */
  function moveSelectedWithinColumn(delta: number): void {
    const card = focusedCard();
    if (card === undefined) return;
    const cell = focusedCell();
    const idx = cell.findIndex((c) => c.id === card.id);
    if (idx < 0) return;
    const newSlot = Math.max(0, Math.min(cell.length, idx + delta + (delta > 0 ? 1 : 0)));
    const dest = cell.filter((c) => c.id !== card.id);
    const ck = columnKeys[focused.columnIdx];
    const lk = laneKeys[focused.laneIdx] ?? laneKeys[0] ?? NO_LANE;
    if (ck === undefined) return;
    void handleDrop(card, dest, newSlot, ck, lk);
    const nextRow = Math.max(0, Math.min(cell.length - 1, idx + delta));
    focused = { ...focused, rowIdxWithinColumn: nextRow };
  }

  function openSelected(): void {
    const card = focusedCard();
    if (card === undefined) return;
    navigate(`/task/${card.id}`);
  }

  /* ----------------------------------------------------------- shortcuts */

  // `n` is bound by useQuickEntry; everything else here.
  useShortcut('kanban', 'j', () => moveFocusInColumn(+1), 'Next card');
  useShortcut('kanban', 'k', () => moveFocusInColumn(-1), 'Previous card');
  useShortcut('kanban', 'l', () => moveFocusAcrossColumns(+1), 'Next column');
  useShortcut('kanban', 'h', () => moveFocusAcrossColumns(-1), 'Previous column');
  useShortcut(
    'kanban',
    'Mod+ArrowRight',
    () => moveSelectedToColumn(+1),
    'Move card to next column',
  );
  useShortcut(
    'kanban',
    'Mod+ArrowLeft',
    () => moveSelectedToColumn(-1),
    'Move card to previous column',
  );
  useShortcut(
    'kanban',
    'Mod+Shift+ArrowDown',
    () => moveSelectedWithinColumn(+1),
    'Move card down',
  );
  useShortcut(
    'kanban',
    'Mod+Shift+ArrowUp',
    () => moveSelectedWithinColumn(-1),
    'Move card up',
  );
  useShortcut('kanban', 'Enter', openSelected, 'Open selected card', {
    fireInInputs: false,
  });

  /* ---------------------------------------------------------- quick entry */

  /**
   * Quick-entry overlay — `n` opens it. Prefill the new card's status
   * from the focused column and the lane attribute (if active) from the
   * focused lane so rapid creation in one column lands in that column.
   */
  const focusedColumnKey = $derived(columnKeys[focused.columnIdx]);
  const focusedLaneKey = $derived(laneKeys[focused.laneIdx]);

  const qePrefill = $derived.by(() => {
    const out: { statusValue?: string; laneAttribute?: { name: string; value: unknown } } = {};
    if (
      columnAttr === 'status' &&
      focusedColumnKey !== undefined &&
      focusedColumnKey !== UNSET_KEY
    ) {
      out.statusValue = focusedColumnKey;
    }
    if (
      laneAttr !== NO_LANE &&
      focusedLaneKey !== undefined &&
      focusedLaneKey !== UNSET_KEY
    ) {
      out.laneAttribute = {
        name: laneAttr,
        value: valueForKey(laneAttr, focusedLaneKey),
      };
    }
    return out;
  });

  // NOTE: `useQuickEntry` captures `prefill` and `assigneeOptions` once at
  // construction (its public `props` getter reads them through the closure).
  // The svelte-ignore directive below silences the "captures initial value"
  // hint — the rapid-fire-create flow doesn't need them to refresh per
  // submission (the focused column is sticky between presses) and the
  // overlay re-fetches on `onCreated`.
  // svelte-ignore state_referenced_locally
  const qe = useQuickEntry({
    scope: 'kanban',
    defaultCardType: 'task',
    prefill: qePrefill,
    assigneeOptions: users.map((u) => ({ value: u.id, label: u.display_name })),
    onCreated: () => {
      void refresh();
    },
  });

  /* ----------------------------------------------------------- card body */

  function titleFor(c: CardWithAttrs): string {
    const t = c.attributes['title'];
    if (typeof t === 'string' && t.length > 0) return t;
    return '(untitled)';
  }

  function tagsForCard(c: CardWithAttrs): string[] {
    const ids = c.attributes['tags'];
    if (!Array.isArray(ids)) return [];
    const out: string[] = [];
    for (const id of ids) {
      if (typeof id === 'number') {
        const p = tagPaths[id];
        if (p !== undefined) out.push(p);
      }
    }
    return out;
  }

  function assigneeForCard(c: CardWithAttrs): string | undefined {
    const v = c.attributes['assignee'];
    if (typeof v !== 'number') return undefined;
    return userNames[v];
  }

  /* ----------------------------------------------------------- mount */

  onMount(() => {
    void refresh();
  });

  /* re-fetch when the filter changes. */
  function onFilterChange(p: Predicate | null): void {
    predicate = p;
    void refresh();
  }

  /** User-facing label for a group attribute (used by the lane header). */
  function labelForAttr(attr: string): string {
    switch (attr) {
      case 'status':
        return 'Status';
      case 'assignee':
        return 'Assignee';
      case 'milestone_ref':
        return 'Milestone';
      case 'component_ref':
        return 'Component';
      default:
        return attr;
    }
  }
</script>

<div class="flex h-full flex-col gap-3 p-4">
  <header class="flex flex-wrap items-center gap-3">
    <h1 class="text-xl font-semibold">Kanban</h1>

    <label class="flex items-center gap-2 text-sm text-muted">
      Columns by:
      <span class="w-44">
        <Combobox
          aria-label="Columns by"
          options={groupOptions}
          value={columnAttr}
          searchable={false}
          onchange={(v) => {
            if (typeof v === 'string') columnAttr = v;
          }}
        />
      </span>
    </label>

    <label class="flex items-center gap-2 text-sm text-muted">
      Swim lanes by:
      <span class="w-44">
        <Combobox
          aria-label="Swim lanes by"
          options={laneOptions}
          value={laneAttr}
          searchable={false}
          onchange={(v) => {
            if (typeof v === 'string') laneAttr = v;
          }}
        />
      </span>
    </label>

    <span class="ml-auto text-sm text-muted">
      {tasks.length} task{tasks.length === 1 ? '' : 's'}
    </span>
  </header>

  <FilterBar
    attributes={filterAttributes}
    bind:predicate
    scope="kanban"
    {quickChips}
    onchange={onFilterChange}
  />

  {#if loading && tasks.length === 0}
    <div class="flex flex-1 items-center justify-center">
      <Spinner size="lg" />
    </div>
  {:else if error !== null}
    <div
      role="alert"
      class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      Failed to load kanban: {error}
      <button
        type="button"
        class="ml-3 underline"
        onclick={() => void refresh()}
      >
        Retry
      </button>
    </div>
  {:else if tasks.length === 0}
    <div class="flex flex-1 items-center justify-center">
      <EmptyState
        title="No tasks yet"
        description="Create your first task with the n shortcut."
        action={{ label: 'Create task', onClick: () => qe.open() }}
      />
    </div>
  {:else}
    <div class="flex flex-1 flex-col gap-4 overflow-auto">
      {#each laneKeys as laneKey, laneIdx (laneKey)}
        {#if laneAttr !== NO_LANE}
          <div
            class="sticky left-0 inline-flex items-center gap-2 rounded bg-surface px-3 py-1.5 text-sm font-medium"
            data-lane={laneKey}
          >
            <span class="text-muted">{labelForAttr(laneAttr)}:</span>
            <span>{labelFor(laneAttr, laneKey)}</span>
          </div>
        {/if}
        <div class="flex min-h-[16rem] gap-3">
          {#each columnKeys as columnKey, columnIdx (columnKey)}
            {@const stack = cells[laneKey]?.[columnKey] ?? []}
            <section
              class="flex w-64 shrink-0 flex-col rounded-md border border-border bg-surface/40"
              data-kanban-column
              data-column={columnKey}
              data-lane={laneKey}
            >
              <header
                class="flex items-center justify-between border-b border-border px-3 py-2 text-sm font-semibold"
              >
                <span>{labelFor(columnAttr, columnKey)}</span>
                <span class="text-xs font-normal text-muted">{stack.length}</span>
              </header>
              <div
                class={cx(
                  'flex flex-1 flex-col gap-1 p-2',
                  stack.length === 0 && 'min-h-[200px]',
                )}
              >
                <DropZone
                  id={`col:${columnAttr}:${columnKey}:lane:${laneAttr}:${laneKey}:slot:0`}
                  onDrop={(payload) => onZoneDrop(payload, columnKey, laneKey, 0)}
                  padding={24}
                />
                {#each stack as card, slot (card.id)}
                  {@const isFocused =
                    focused.columnIdx === columnIdx &&
                    focused.laneIdx === laneIdx &&
                    focused.rowIdxWithinColumn === slot}
                  <DragHandle
                    payload={card}
                    previewLabel={titleFor(card)}
                  >
                    {#snippet children()}
                      <!-- svelte-ignore a11y_click_events_have_key_events -->
                      <!-- svelte-ignore a11y_no_static_element_interactions -->
                      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                      <div
                        class={cx(
                          'flex flex-col gap-1 rounded-md border border-border bg-bg p-2 text-sm shadow-sm',
                          'cursor-grab focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                          isFocused && 'ring-2 ring-accent',
                        )}
                        data-card-id={card.id}
                        data-focused={isFocused ? 'true' : undefined}
                        tabindex="0"
                        onclick={(e) => {
                          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                          navigate(`/task/${card.id}`);
                        }}
                        onfocus={() => {
                          focused = {
                            columnIdx,
                            laneIdx,
                            rowIdxWithinColumn: slot,
                          };
                        }}
                      >
                        <span class="font-medium text-fg">{titleFor(card)}</span>
                        <div class="flex flex-wrap items-center gap-1 text-xs text-muted">
                          <span class="font-mono">#{card.id}</span>
                          {#if assigneeForCard(card) !== undefined}
                            <span>· {assigneeForCard(card)}</span>
                          {/if}
                          {#each tagsForCard(card) as path (path)}
                            <span class="rounded bg-surface px-1">{path}</span>
                          {/each}
                        </div>
                      </div>
                    {/snippet}
                  </DragHandle>
                  <DropZone
                    id={`col:${columnAttr}:${columnKey}:lane:${laneAttr}:${laneKey}:slot:${slot + 1}`}
                    onDrop={(payload) =>
                      onZoneDrop(payload, columnKey, laneKey, slot + 1)}
                    padding={24}
                  />
                {/each}
                {#if stack.length === 0}
                  <DropZone
                    id={`col:${columnAttr}:${columnKey}:lane:${laneAttr}:${laneKey}:slot:end`}
                    onDrop={(payload) => onZoneDrop(payload, columnKey, laneKey, 0)}
                    padding={24}
                    class="min-h-[200px]"
                  />
                {/if}
              </div>
            </section>
          {/each}
        </div>
      {/each}
    </div>
  {/if}
</div>

<QuickEntryOverlay {...qe.props} />
