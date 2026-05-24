<!--
  KanbanScreen.

  Column + (optional) swim-lane board over tasks. Drag a card between
  columns / lanes; the drop computes a new `sort_order` halfway between
  neighbours and issues ONE batch combining the sort + column-attribute
  + lane-attribute updates. The dispatcher coalesces the per-tick
  attribute.update fan-out into a single `POST /api/v1/batch`.

  Initial-batch contract (one POST):
    1. `card.select_with_attributes`  card_type_name='task', limit=500
    2. `card.select_with_attributes`  card_type_name='person'  (assignee labels)
    3. `card.select_with_attributes`  card_type_name='milestone'
    4. `card.select_with_attributes`  card_type_name='component'
    5. `card.select_with_attributes`  card_type_name='tag'
    6. `attribute_def.select` (cached on AttributeSchemaCache)

  The column attribute defaults to `'status'`; the lane attribute
  defaults to `'(none)'` and the user picks both via header `<Combobox>`s.
  Options come from any enum-typed attribute_def or any `ref:*` def.

  Keyboard:
    - `n`                          open quick-entry overlay (via useQuickEntry)
    - `j`/`k` (or arrows)          move selection within a column
    - `h`/`l` (or arrows)          move selection across columns
    - `Shift+J`/`Shift+K`          move card up/down within column
    - `Shift+H`/`Shift+L`          move card to prev/next column
    - `Alt+J`/`Alt+K`              move selection across swim lanes
    - `Enter`                      open selected → /task/<id>

  Ports `client/lib/ui/screens/kanban_screen.dart` (973 LOC).
-->
<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { flip } from 'svelte/animate';
  import { prefersReducedMotion } from 'svelte/motion';
  import { getDispatcher } from '../dispatch/context';
  import { BatchAbortedError, SubRequestError } from '../dispatch/errors';
  import {
    sharedSchemaCache,
    friendlyLabel,
    type FilterAttribute,
  } from '../filter/attribute_schema.svelte';
  import {
    buildTaskFilterPalette,
    resolveAttributeLabel,
  } from '../filter/task_palette';
  import ScreenFilterBar from '../filter/ScreenFilterBar.svelte';
  import {
    isFlatAndOfLeaves,
    predicateToJson,
    type Predicate,
  } from '../filter/predicate';
  import {
    readColumnAttr,
    readGroupByAttr,
  } from '../filter/screen_preset.svelte';
  import DragHandle from '../dnd/DragHandle.svelte';
  import DropZone from '../dnd/DropZone.svelte';
  import { setActiveScope, useShortcut } from '../keys/shortcut';
  import { projectScope } from '../shell/project_scope.svelte';
  import { useQuickEntry } from '../quick_entry/use_quick_entry.svelte';
  import { isAssignablePerson } from '../util/person';
  import QuickEntryOverlay from '../quick_entry/QuickEntryOverlay.svelte';
  import {
    attributeUpdate,
    cardSelectWithAttributes,
  } from '../reg/handlers';
  import type {
    AttributeUpdateInput,
    AttributeUpdateOutput,
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWithAttrs,
    ID,
  } from '../reg/types';
  import { navigate } from '../routing/router.svelte';
  import { setTaskNavList } from '../routing/task_nav_list.svelte';
  import { getFilter } from './filter_state.svelte';
  import Combobox from '../ui/Combobox.svelte';
  import Spinner from '../ui/Spinner.svelte';
  import { notify } from '../ui/toast.svelte';
  import { cx } from '../util/class_names';
  import {
    computeMoveBatch,
    nextColumnIndex,
    planSortRewrite,
    sortByOrder,
    type UpdateOp,
  } from './kanban_helpers';

  setActiveScope('kanban');

  /* ------------------------------------------------------------------ props */

  interface Props {
    params?: Record<string, string>;
  }
  let { params = {} }: Props = $props();

  /** Active screen slug from `/project/:id/screen/:slug`. Drives the
   *  preset cache scope so two kanban-layout screens in the same
   *  project don't share state. */
  const slug = $derived.by((): string => {
    const v = params['slug'];
    return typeof v === 'string' && v !== '' ? v : 'kanban';
  });

  /* ------------------------------------------------------------------ deps */

  const dispatcher = getDispatcher();
  const schema = sharedSchemaCache(dispatcher);

  /* ----------------------------------------------------------------- state */

  /** Sentinel column key for cards whose grouping attribute is unset. */
  const UNSET_KEY = '__unset__';
  /** Sentinel lane attribute name meaning "no swim lanes". */
  const NO_LANE = '__none__';

  let tasks = $state<CardWithAttrs[]>([]);
  /**
   * Monotonic generation for `tasks`. Bumped every time a refresh
   * replaces the array. The optimistic-drop rollback (FE-M5) captures
   * this before its await and only restores the snapshot if the
   * generation is unchanged — otherwise a refresh landed mid-drop and
   * restoring the stale snapshot would clobber it, so we re-refresh
   * instead.
   */
  let taskGen = $state(0);
  let persons = $state<CardWithAttrs[]>([]);
  let milestones = $state<CardWithAttrs[]>([]);
  let components = $state<CardWithAttrs[]>([]);
  let tagsRows = $state<CardWithAttrs[]>([]);
  let statuses = $state<CardWithAttrs[]>([]);
  /** card-id → display title for milestone / component refs. */
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
  /** tag-id → path string. */
  const tagPaths = $derived.by((): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const r of tagsRows) {
      const p = r.attributes['path'];
      if (typeof p === 'string') out[r.id.toString()] = p;
    }
    return out;
  });

  let loading = $state(true);
  let error = $state<string | null>(null);

  let predicate = $state<Predicate | null>(
    // Cache scope is the URL slug — see ScreenFilterBar. Two
    // kanban-layout screens in the same project keep their predicates
    // separate.
    untrack(() => getFilter(slug, projectScope.projectId)),
  );
  // The active filter card, bound from <ScreenFilterBar>. Kanban reads
  // its `column_attr` (primary axis) and `group_by_attr` (secondary
  // axis — what we call "lane" in this layout) off this card via an
  // effect so the axis combobox updates whenever the user picks a
  // different preset (or one is applied on first visit).
  let activeFilter = $state<CardWithAttrs | null>(null);
  let columnAttr = $state<string>('milestone_ref');
  let laneAttr = $state<string>(NO_LANE);
  // The active filter card OWNS the axes. Reset to defaults whenever a
  // preset omits column_attr / group_by_attr so switching from a 2-axis
  // preset to a 1-axis preset doesn't leave the lane stuck on the
  // previous value.
  $effect(() => {
    if (activeFilter === null) return;
    columnAttr = readColumnAttr(activeFilter) ?? 'milestone_ref';
    laneAttr = readGroupByAttr(activeFilter) ?? NO_LANE;
  });

  /** Keyboard navigation focus. */
  let focused = $state<{
    columnIdx: number;
    rowIdxWithinColumn: number;
    laneIdx: number;
  }>({ columnIdx: 0, rowIdxWithinColumn: 0, laneIdx: 0 });

  /* -------------------------------------------------------------- ref data */

  /** person-card-id → title. Keys are id.toString(). Used for the
   *  assignee chip on each kanban card after the schema flipped
   *  `assignee` from user_ref to card_ref(person). */
  const personNames = $derived<Record<string, string>>(
    Object.fromEntries(
      persons
        .map((p) => {
          const t = p.attributes['title'];
          return typeof t === 'string' ? [p.id.toString(), t] : null;
        })
        .filter((e): e is [string, string] => e !== null),
    ),
  );

  /* ------------------------------------------------------- column / lane keys */

  /**
   * Build the ordered list of column keys for [attr]. We seed the keys
   * from the schema's option list (so an empty project still renders
   * every known column / lane), then merge in any extra keys observed
   * on the loaded tasks before appending UNSET. Status works the same
   * way as milestone / component — its options are the project's
   * `status` cards, in their sort_order.
   */
  function columnKeysForAttr(attr: string): string[] {
    const seen = new Set<string>();
    const keys: string[] = [];
    const fa = filterAttributes.find((a) => a.name === attr);
    for (const opt of fa?.options ?? []) {
      const k = keyOf(opt.value);
      if (k === '' || k === UNSET_KEY) continue;
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
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

  /** Inverse of {@link keyOf}: turn a bucket key back into a wire value.
   *  Numeric keys (every card_ref attribute — status / milestone_ref /
   *  component_ref / assignee) decode back to bigint so the option
   *  lookup in resolveAttributeLabel matches the picker's
   *  `value: <card-id>n`. */
  function valueForKey(_attr: string, key: string): unknown {
    if (key === UNSET_KEY) return null;
    if (/^-?\d+$/.test(key)) {
      try {
        return BigInt(key);
      } catch {
        /* fall through */
      }
    }
    return key;
  }

  /** Human label for a column / lane bucket. */
  function labelFor(attr: string, key: string): string {
    if (key === UNSET_KEY || key === '') return '(unset)';
    // Look the attribute up in the active palette and resolve `key`
    // through its options. Enums get their `attribute_def.options[].label`
    // ("To do" instead of "todo"); ref:* attrs get the resolved card
    // title (or display name for users) — same data path as the filter
    // chip, so the column header and the FilterBar agree.
    const fa = filterAttributes.find((a) => a.name === attr);
    const value = valueForKey(attr, key);
    return resolveAttributeLabel(fa, value);
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
    // Built-ins are always offered so the picker is non-empty before
    // schema arrives. `friendlyLabel` produces "Milestone" not
    // "milestone_ref".
    for (const n of ['assignee', 'milestone_ref', 'component_ref']) {
      seen.set(n, friendlyLabel(n));
    }
    for (const def of schema.defs) {
      // Every pick-from-a-list attribute is a card_ref; offer them
      // all as group-by candidates.
      if (def.value_type === 'card_ref' || def.value_type === 'card_ref[]') {
        if (!seen.has(def.name)) seen.set(def.name, friendlyLabel(def.name));
      }
    }
    return Array.from(seen.entries()).map(([value, label]) => ({ value, label }));
  });

  const laneOptions = $derived<{ value: string; label: string }[]>([
    { value: NO_LANE, label: '(none)' },
    ...groupOptions,
  ]);

  /* ------------------------------------------------------------ filter --- */

  /**
   * FilterBar palette. Single source of truth: see `filter/task_palette.ts`.
   * Same names / labels / option lists across Inbox, Grid, Kanban,
   * ProjectDetail.
   */
  const filterAttributes = $derived<FilterAttribute[]>(
    buildTaskFilterPalette({
      schema,
      // Assignee → person cards. The palette resolves it via its
      // refResolver from this list.
      persons,
      milestones,
      components,
      tags: tagsRows,
      statuses,
    }),
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
      const scoped = projectScope.projectId;
      if (scoped !== null) tasksData.parentCardId = scoped;

      const tasksP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: tasksData,
      });
      const personsP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: { cardTypeName: 'person' },
      });
      // Picker queries inherit the active project scope. Milestones,
      // components, and tags sit one level under their project in v1,
      // so filtering by `parentCardId` is equivalent to "in this
      // project." The all-projects view leaves the filter unset so
      // every option shows up.
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
      const milestonesP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: milestoneData,
      });
      const componentsP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: componentData,
      });
      const tagsP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: tagData,
      });
      const statusesP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: statusData,
      });
      const schemaP = schema.load();

      const [tOut, pOut, mOut, cOut, gOut, sOut] = await Promise.all([
        tasksP,
        personsP,
        milestonesP,
        componentsP,
        tagsP,
        statusesP,
        schemaP,
      ]);

      tasks = tOut.rows;
      taskGen++;
      persons = pOut.rows;
      milestones = mOut.rows;
      components = cOut.rows;
      tagsRows = gOut.rows;
      statuses = sOut.rows;

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
    const sortUpdates = planSortRewrite(destStack, card, slot);
    const targetColVal = valueForKey(columnAttr, targetColumnKey);
    const targetLaneVal =
      laneAttr === NO_LANE ? null : valueForKey(laneAttr, targetLaneKey);
    const ops = computeMoveBatch(
      card,
      targetColVal,
      targetLaneVal,
      sortUpdates,
      columnAttr,
      laneAttr === NO_LANE ? null : laneAttr,
    );
    if (ops.length === 0) return;

    // Optimistic update. Patch sort_order across every card the rewrite
    // touched (the cell gets renumbered, not just the moved card) and
    // apply the moved card's column/lane changes so the re-bucket
    // happens immediately. Refresh will replace `tasks` on success or
    // rollback on failure.
    const sortByCardId = new Map<bigint, number>();
    for (const u of sortUpdates) sortByCardId.set(u.cardId, u.sortOrder);
    const original = tasks;
    const patched: CardWithAttrs[] = tasks.map((t) => {
      const newSort = sortByCardId.get(t.id);
      const isMoved = t.id === card.id;
      if (newSort === undefined && !isMoved) return t;
      const next = { ...t.attributes };
      if (newSort !== undefined) next['sort_order'] = newSort;
      if (isMoved) {
        for (const op of ops) {
          if (op.cardId !== card.id || op.attributeName === 'sort_order') continue;
          if (op.value === null || op.value === undefined) {
            delete next[op.attributeName];
          } else {
            next[op.attributeName] = op.value;
          }
        }
      }
      return { ...t, attributes: next };
    });
    tasks = patched;
    // Capture the generation of the optimistic snapshot. If a refresh
    // replaces `tasks` while the batch is in flight, `taskGen` advances
    // and the rollback below must NOT stomp the fresher data.
    const genAtDrop = taskGen;

    try {
      await applyOps(ops);
    } catch (e) {
      // Only restore the pre-drop snapshot if no refresh landed
      // mid-flight (FE-M5). If one did, re-issue a refresh so we
      // converge on server truth instead of clobbering it with `original`.
      if (taskGen === genAtDrop) {
        tasks = original;
      } else {
        void refresh();
      }
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
    // Card ids cross the wire as bigint (see dispatcher.reviveIds);
    // the legacy `number` guard here silently dropped every drop.
    if (typeof card?.id !== 'bigint') return;
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

  /** Push the (laneKey, columnKey) cell as the nav-list and navigate.
   *  Kanban deliberately scopes prev/next to the column the user clicked
   *  out of: walking through "Doing" should not silently jump to "Done"
   *  because the cards happened to come right after each other in the
   *  flat task list. */
  function openTaskInCell(card: CardWithAttrs, columnKey: string, laneKey: string): void {
    const stack = cells[laneKey]?.[columnKey] ?? [];
    const colLabel = labelFor(columnAttr, columnKey);
    const laneSuffix = laneAttr === NO_LANE ? '' : ` / ${labelFor(laneAttr, laneKey)}`;
    setTaskNavList({
      label: `Kanban: ${colLabel}${laneSuffix}`,
      ids: stack.map((c) => c.id),
    });
    navigate(`/task/${card.id}`);
  }

  function openSelected(): void {
    const card = focusedCard();
    if (card === undefined) return;
    const ck = columnKeys[focused.columnIdx];
    const lk = laneKeys[focused.laneIdx] ?? laneKeys[0] ?? NO_LANE;
    if (ck === undefined) return;
    openTaskInCell(card, ck, lk);
  }

  /* ----------------------------------------------------------- shortcuts */

  // `n` is bound by useQuickEntry; everything else here.
  // Plain navigation: hjkl or arrow keys.
  useShortcut('kanban', ['j', 'ArrowDown'], () => moveFocusInColumn(+1), 'Down');
  useShortcut('kanban', ['k', 'ArrowUp'], () => moveFocusInColumn(-1), 'Up');
  useShortcut('kanban', ['l', 'ArrowRight'], () => moveFocusAcrossColumns(+1), 'Next column');
  useShortcut('kanban', ['h', 'ArrowLeft'], () => moveFocusAcrossColumns(-1), 'Previous column');

  // Move card: Shift on the same nav keys re-orders the focused card.
  // Same hand position, no Chord/Mod gymnastics. Vertical Shift+J/K
  // moves within the column; horizontal Shift+H/L hops the card to the
  // adjacent column. Shift+Arrow alternates for arrow-only users.
  useShortcut(
    'kanban',
    ['Shift+j', 'Shift+ArrowDown'],
    () => moveSelectedWithinColumn(+1),
    'Move card down',
  );
  useShortcut(
    'kanban',
    ['Shift+k', 'Shift+ArrowUp'],
    () => moveSelectedWithinColumn(-1),
    'Move card up',
  );
  useShortcut(
    'kanban',
    ['Shift+l', 'Shift+ArrowRight'],
    () => moveSelectedToColumn(+1),
    'Move card to next column',
  );
  useShortcut(
    'kanban',
    ['Shift+h', 'Shift+ArrowLeft'],
    () => moveSelectedToColumn(-1),
    'Move card to previous column',
  );

  // Swim-lane navigation lives on Alt+J/K to free Shift+J/K for the
  // primary "move card" semantics above. Plain swim-lanes are rare
  // enough that Alt doesn't materially worsen the ergonomics.
  useShortcut(
    'kanban',
    'Alt+j',
    () => moveFocusAcrossLanes(+1),
    'Next swim lane',
  );
  useShortcut(
    'kanban',
    'Alt+k',
    () => moveFocusAcrossLanes(-1),
    'Previous swim lane',
  );

  useShortcut('kanban', 'Enter', openSelected, 'Open selected card', {
    fireInInputs: false,
  });

  /* -------------------------------------------------- search ⇄ list nav -- */

  /** Focus the FilterBar's search input; bound to `/`. */
  async function focusSearch(): Promise<void> {
    await tick();
    const el = document.querySelector<HTMLInputElement>(
      '[data-testid="text-search-input"]',
    );
    if (el !== null) {
      el.focus();
      el.select();
    }
  }
  useShortcut('kanban', '/', () => void focusSearch(), 'Focus search', {
    fireInInputs: false,
  });

  /** Focus the first card in the focused column when ArrowDown is
   *  pressed in the search input. The card's title button carries
   *  tabindex=0; scope to `[data-kanban-column]` rows so we don't
   *  jump across lanes. */
  async function focusFirstCard(): Promise<void> {
    await tick();
    const card = document.querySelector<HTMLElement>(
      '[data-kanban-column] [data-card-id] button[tabindex="0"]',
    );
    if (card === null) return;
    // Reset focus to row 0 of column 0 / lane 0 so subsequent j/k
    // moves are coherent.
    focused = { columnIdx: 0, laneIdx: 0, rowIdxWithinColumn: 0 };
    card.focus();
  }
  function onSearchNavigateOut(direction: 'down' | 'up'): void {
    if (direction === 'down') void focusFirstCard();
  }

  /* ---------------------------------------------------------- quick entry */

  /**
   * Quick-entry overlay — `n` opens it. Prefill the new card's status
   * from the focused column and the lane attribute (if active) from the
   * focused lane so rapid creation in one column lands in that column.
   */
  const focusedColumnKey = $derived(columnKeys[focused.columnIdx]);
  const focusedLaneKey = $derived(laneKeys[focused.laneIdx]);

  const qePrefill = $derived.by(() => {
    const out: { laneAttribute?: { name: string; value: unknown }; extraAttributes?: { name: string; value: unknown }[] } = {};
    if (focusedColumnKey !== undefined && focusedColumnKey !== UNSET_KEY) {
      out.laneAttribute = {
        name: columnAttr,
        value: valueForKey(columnAttr, focusedColumnKey),
      };
    }
    if (
      laneAttr !== NO_LANE &&
      focusedLaneKey !== undefined &&
      focusedLaneKey !== UNSET_KEY
    ) {
      const extra = {
        name: laneAttr,
        value: valueForKey(laneAttr, focusedLaneKey),
      };
      if (out.laneAttribute === undefined) {
        out.laneAttribute = extra;
      } else {
        out.extraAttributes = [extra];
      }
    }
    return out;
  });

  // NOTE: `useQuickEntry` captures `prefill` and `assigneeOptions` once at
  // construction (its public `props` getter reads them through the closure).
  // The svelte-ignore directive below silences the "captures initial value"
  // hint — the rapid-fire-create flow doesn't need them to refresh per
  // submission (the focused column is sticky between presses) and the
  // overlay re-fetches on `onCreated`.
  //
  // Gate 6: candidateStatuses uses the getter form so the resolved
  // default-create-status reads the latest async-loaded list at submit
  // time. The kanban column "+" path pins status via prefill so the
  // resolver is skipped — but `n`-key creates from arbitrary focus
  // still need the chain.
  // svelte-ignore state_referenced_locally
  const qe = useQuickEntry({
    scope: 'kanban',
    defaultCardType: 'task',
    prefill: qePrefill,
    // assignee is a card_ref → person card, so options are person cards.
    // Excludes contact-kind persons (email-only contacts materialised
    // by the comm recipient picker) from the assignment dropdown.
    assigneeOptions: persons.filter(isAssignablePerson).map((p) => {
      const t = p.attributes['title'];
      return {
        value: p.id,
        label: typeof t === 'string' && t.length > 0 ? t : `#${p.id}`,
      };
    }),
    candidateStatuses: () => statuses,
    attributePalette: () => filterAttributes,
    tagOptions: () =>
      tagsRows.map((r) => {
        const p = r.attributes['path'];
        return {
          value: r.id,
          label: typeof p === 'string' && p !== '' ? p : `#${r.id}`,
        };
      }),
    onCreated: () => {
      void refresh();
    },
  });

  /**
   * Open the quick-entry overlay with a one-shot prefill that targets a
   * specific (column, lane) cell. Built so the per-column "+" buttons drop
   * the new task into exactly the bucket the user clicked, regardless of
   * where keyboard focus happens to be.
   *
   * Both axes are honored uniformly: the column attribute lands in
   * `laneAttribute`, the lane axis (when active) in `extraAttributes`.
   * Status is just another card_ref attribute — no dedicated slot.
   */
  function openColumnAdd(columnKey: string, laneKey: string): void {
    const prefill: {
      laneAttribute?: { name: string; value: unknown };
      extraAttributes?: { name: string; value: unknown }[];
    } = {};
    const setAxis = (attr: string, key: string): void => {
      if (key === UNSET_KEY || key === '') return;
      const a = { name: attr, value: valueForKey(attr, key) };
      if (prefill.laneAttribute === undefined) {
        prefill.laneAttribute = a;
        return;
      }
      const arr = prefill.extraAttributes ?? [];
      arr.push(a);
      prefill.extraAttributes = arr;
    };
    setAxis(columnAttr, columnKey);
    if (laneAttr !== NO_LANE) setAxis(laneAttr, laneKey);
    qe.open(prefill);
  }

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
      // The dispatcher reviver normalises card-ref attribute arrays
      // to bigint; `tagPaths` is keyed by id.toString() so we use
      // that form for the lookup.
      if (typeof id !== 'bigint') continue;
      const p = tagPaths[id.toString()];
      if (p !== undefined) out.push(p);
    }
    return out;
  }

  function assigneeForCard(c: CardWithAttrs): string | undefined {
    const v = c.attributes['assignee'];
    if (typeof v !== 'bigint') return undefined;
    return personNames[v.toString()];
  }

  /* ----------------------------------------------------------- mount */

  // Initial fetch + refetch when the global project scope flips.
  // Gated on `filterReady` so the first request waits for
  // ScreenFilterBar's default-filter probe.
  let filterReady = $state(false);
  $effect(() => {
    void projectScope.projectId; // tracked dep
    void filterReady;
    if (!filterReady) return;
    void refresh();
  });

  /* re-fetch when the filter changes. */
  function onFilterChange(p: Predicate | null): void {
    predicate = p;
    void refresh();
  }

</script>

<div class="flex h-full flex-col gap-3 p-4">
  <header class="flex flex-wrap items-center gap-3">
    <!--
      Use <div>, not <label>: clicking a Combobox option bubbles to the
      label, which forwards a synthetic click to the trigger button and
      re-opens the menu. Combobox already supplies aria-label.
    -->
    <div class="flex items-center gap-2 text-sm text-muted">
      <span>Columns by:</span>
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
    </div>

    <div class="flex items-center gap-2 text-sm text-muted">
      <span>Swim lanes by:</span>
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
    </div>

  </header>

  <ScreenFilterBar
    screenSlug={slug}
    projectId={projectScope.projectId}
    {dispatcher}
    {filterAttributes}
    bind:predicate
    bind:activeFilter
    bind:filterReady
    extraAttributes={{
      column_attr: columnAttr,
      group_by_attr: laneAttr === NO_LANE ? null : laneAttr,
    }}
    onchange={onFilterChange}
    onNavigateOut={onSearchNavigateOut}
  >
    {#snippet trailing()}
      <span>{tasks.length} task{tasks.length === 1 ? '' : 's'}</span>
      {#if loading}
        <Spinner size="sm" />
      {/if}
    {/snippet}
  </ScreenFilterBar>

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
  {:else}
    <div
      class={cx(
        'flex flex-1 flex-col gap-4',
        // With swim lanes active we let the outer area scroll because
        // each lane row carries its own per-column max-height cap (so
        // many cards in one column don't push the next lane row down).
        // With a single (NO_LANE) row, we drop both the outer scroll
        // and the inner column cap so the columns themselves fill the
        // remaining viewport height and each scrolls independently.
        laneAttr === NO_LANE ? 'min-h-0 overflow-hidden' : 'overflow-auto',
      )}
    >
      {#each laneKeys as laneKey, laneIdx (laneKey)}
        {#if laneAttr !== NO_LANE}
          <div
            class="sticky left-0 inline-flex items-center gap-2 rounded bg-surface px-3 py-1.5 text-sm font-medium"
            data-lane={laneKey}
          >
            <span class="text-muted">{friendlyLabel(laneAttr)}:</span>
            <span>{labelFor(laneAttr, laneKey)}</span>
          </div>
        {/if}
        <div
          class={cx(
            'flex gap-3',
            laneAttr === NO_LANE ? 'min-h-0 flex-1' : 'min-h-[16rem]',
          )}
        >
          {#each columnKeys as columnKey, columnIdx (columnKey)}
            {@const stack = cells[laneKey]?.[columnKey] ?? []}
            <section
              class="flex w-64 shrink-0 flex-col rounded-md border border-border bg-surface/40"
              data-kanban-column
              data-column={columnKey}
              data-lane={laneKey}
            >
              <header
                class="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-sm font-semibold"
              >
                <span class="truncate">{labelFor(columnAttr, columnKey)}</span>
                <span class="flex items-center gap-1">
                  <span class="text-xs font-normal text-muted">{stack.length}</span>
                  <button
                    type="button"
                    class="inline-flex h-5 w-5 items-center justify-center rounded text-muted hover:bg-border/40 hover:text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    aria-label={`Add task to ${labelFor(columnAttr, columnKey)}${laneAttr === NO_LANE ? '' : ` / ${labelFor(laneAttr, laneKey)}`}`}
                    title="Add card here"
                    onclick={() =>
                      openColumnAdd(columnKey, laneKey)}
                  >+</button>
                </span>
              </header>
              <div
                class={cx(
                  'flex flex-1 flex-col gap-1 overflow-y-auto p-2',
                  // With swim lanes active, the cap keeps a column with
                  // many cards from pushing its lane row past the next
                  // one — without it the lane rows below get bumped
                  // down off-screen (and visually "overlap" because the
                  // outer `gap-4` is smaller than the overflow). 28rem
                  // ≈ 10-12 cards; anything longer scrolls inside the
                  // cell.
                  //
                  // With NO_LANE we drop the cap: the single lane row
                  // is `flex-1` so the column body fills the viewport
                  // and scrolls independently. No second lane to crowd.
                  laneAttr === NO_LANE ? 'min-h-0' : 'max-h-[28rem] min-h-0',
                  stack.length === 0 && laneAttr !== NO_LANE && 'min-h-[200px]',
                )}
              >
                <DropZone
                  id={`col:${columnAttr}:${columnKey}:lane:${laneAttr}:${laneKey}:top`}
                  onDrop={(payload) => onZoneDrop(payload, columnKey, laneKey, 0)}
                  padding={24}
                />
                {#each stack as card, slot (card.id)}
                  {@const isFocused =
                    focused.columnIdx === columnIdx &&
                    focused.laneIdx === laneIdx &&
                    focused.rowIdxWithinColumn === slot}
                  <!-- Wrapper exists so animate:flip has a single top-level
                       child of the keyed each block; the trailing DropZone
                       below rides along inside it. -->
                  <div animate:flip={{ duration: prefersReducedMotion.current ? 0 : 420 }}>
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                  <div
                    class={cx(
                      'flex items-stretch gap-1 rounded-md border border-border bg-bg p-1 text-sm shadow-sm',
                      'focus-within:ring-2 focus-within:ring-accent',
                      isFocused && 'ring-2 ring-accent',
                    )}
                    data-card-id={card.id}
                    data-focused={isFocused ? 'true' : undefined}
                  >
                    <DragHandle
                      payload={card}
                      previewLabel={titleFor(card)}
                      class="kanban-grip"
                    >
                      <span
                        aria-label="Drag to move"
                        title="Drag to move"
                        class="flex h-full w-4 cursor-grab select-none items-center justify-center rounded-sm border border-transparent text-muted hover:border-border hover:bg-surface"
                      >⋮⋮</span>
                    </DragHandle>
                    <button
                      type="button"
                      class="flex min-w-0 flex-1 flex-col gap-1 rounded-sm px-1 py-0.5 text-left focus:outline-none"
                      tabindex="0"
                      onclick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                        openTaskInCell(card, columnKey, laneKey);
                      }}
                      onfocus={() => {
                        focused = {
                          columnIdx,
                          laneIdx,
                          rowIdxWithinColumn: slot,
                        };
                      }}
                    >
                      <span class="truncate font-medium text-fg">{titleFor(card)}</span>
                      <div class="flex flex-wrap items-center gap-1 text-xs text-muted">
                        <span class="font-mono">#{card.id}</span>
                        {#if assigneeForCard(card) !== undefined}
                          <span>· {assigneeForCard(card)}</span>
                        {/if}
                        {#each tagsForCard(card) as path (path)}
                          <span class="rounded bg-surface px-1">{path}</span>
                        {/each}
                      </div>
                    </button>
                  </div>
                  <DropZone
                    id={`col:${columnAttr}:${columnKey}:lane:${laneAttr}:${laneKey}:after:${card.id}`}
                    onDrop={(payload) =>
                      onZoneDrop(payload, columnKey, laneKey, slot + 1)}
                    padding={24}
                  />
                  </div>
                {/each}
                {#if stack.length === 0}
                  <DropZone
                    id={`col:${columnAttr}:${columnKey}:lane:${laneAttr}:${laneKey}:empty`}
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
