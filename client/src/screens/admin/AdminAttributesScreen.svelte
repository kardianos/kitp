<!--
  AdminAttributesScreen — admin-only CRUD over attribute_def + edge rows
  plus value-card management for ref-typed attributes.

  Layout: 3-pane (master / detail / preview).

    LEFT (~280 px):   searchable list of attribute_def, grouped by
                      `is_built_in`. "+ New attribute" creates a draft.
    CENTER:           edit form for the selected def — name (read-only when
                      built-in), value_type (locked once any value exists),
                      ref-card-type combobox.
    RIGHT:            "Bound to" matrix — one row per card_type with
                      [Bound] checkbox, ordering input, [Required] checkbox.
                      Toggles fire `edge.insert` / `edge.delete` immediately;
                      same-tick batches into one POST.
                      Below: "Value cards" list when value_type is `ref:<type>`.

  Initial batch: ONE POST coalescing
    1. attribute_def.select
    2. card_type.select
  Plus, when the selected def is `ref:<type>`, ONE follow-up POST for that
  card_type's value cards.

  Keyboard:
    /        focus left-pane search
    n        focus "+ New attribute" button
    j / k    move selection in left pane
    Enter    save the center form (when in create mode)

  Notes:
    - The ref card_type is derived from the def's value_type (`ref:<name>`)
      so any new ref attribute automatically picks up its value-cards
      section. All pick-from-a-list attributes are unified under this
      mechanism — there is no separate enum value_type any longer.
    - Value-card drag-reorder dispatches `user_card_sort.set` (admin scope).
      Soft-delete + inline rename + "+ Add value" all hit the standard
      handlers (`card.delete`, `attribute.update`, `card.insert`).
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';

  import { getDispatcher } from '../../dispatch/context';
  import { BatchAbortedError, SubRequestError } from '../../dispatch/errors';
  import DragHandle from '../../dnd/DragHandle.svelte';
  import DropZone from '../../dnd/DropZone.svelte';
  import { setActiveScope, useShortcut } from '../../keys/shortcut';
  import { projectScope } from '../../shell/project_scope.svelte';
  import {
    attributeDefInsert,
    attributeDefSelect,
    attributeUpdate,
    cardDelete,
    cardInsert,
    cardSelectWithAttributes,
    cardTypeSelect,
    edgeDelete,
    edgeInsert,
  } from '../../reg/handlers';
  import type {
    AttributeDefInsertInput,
    AttributeDefInsertOutput,
    AttributeDefRow,
    AttributeDefSelectInput,
    AttributeDefSelectOutput,
    AttributeUpdateInput,
    AttributeUpdateOutput,
    CardDeleteInput,
    CardDeleteOutput,
    CardInsertInput,
    CardInsertOutput,
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardTypeRow,
    CardTypeSelectInput,
    CardTypeSelectOutput,
    CardWithAttrs,
    EdgeDeleteInput,
    EdgeDeleteOutput,
    EdgeInsertInput,
    EdgeInsertOutput,
    ID,
  } from '../../reg/types';
  import Button from '../../ui/Button.svelte';
  import Chip from '../../ui/Chip.svelte';
  import Combobox from '../../ui/Combobox.svelte';
  import EmptyState from '../../ui/EmptyState.svelte';
  import IconButton from '../../ui/IconButton.svelte';
  import Spinner from '../../ui/Spinner.svelte';
  import { notify } from '../../ui/toast.svelte';
  import { cx } from '../../util/class_names';

  import {
    applyAttrSearch,
    boundMatrix,
    groupDefs,
    parseRefCardType,
    validateNewAttr,
    type MatrixRow,
    type NewAttrDraft,
  } from './admin_attributes_helpers';

  setActiveScope('admin_attributes');

  /* ---------------------------------------------------------- dependencies */

  const dispatcher = getDispatcher();

  /* ----------------------------------------------------------------- state */

  let defs = $state<AttributeDefRow[]>([]);
  let cardTypes = $state<CardTypeRow[]>([]);
  /** Keyed by card_type name. Loaded lazily when a ref-typed def is selected. */
  let valueCards = $state<Record<string, CardWithAttrs[]>>({});
  let search = $state('');
  let selectedDefId = $state<ID | null>(null);
  let creating = $state(false);
  let draft = $state<NewAttrDraft>(blankDraft());
  let draftErrors = $state<Record<string, string>>({});
  let loading = $state(true);
  let error = $state<string | null>(null);
  let saving = $state(false);

  let searchEl: HTMLInputElement | null = $state(null);
  let newBtnEl: HTMLButtonElement | null = $state(null);

  function blankDraft(): NewAttrDraft {
    return {
      name: '',
      valueType: 'text',
    };
  }

  /* ------------------------------------------------------------ derivations */

  const filteredDefs = $derived(applyAttrSearch(defs, search));
  const grouped = $derived(groupDefs(filteredDefs));

  const flatList = $derived<AttributeDefRow[]>([
    ...grouped.builtIn,
    ...grouped.custom,
  ]);

  const selectedDef = $derived<AttributeDefRow | null>(
    selectedDefId === null
      ? null
      : (defs.find((d) => d.id === selectedDefId) ?? null),
  );

  const selectedRefCardType = $derived<string | null>(
    selectedDef === null
      ? null
      : parseRefCardType(selectedDef.value_type, selectedDef.target_card_type_name),
  );

  const matrix = $derived<MatrixRow[]>(
    boundMatrix(cardTypes, creating ? null : selectedDef),
  );

  const cardTypeOptions = $derived(
    cardTypes.map((t) => ({ value: t.name, label: t.name })),
  );

  const valueTypeOptions = [
    { value: 'text', label: 'text' },
    { value: 'number', label: 'number' },
    { value: 'bool', label: 'bool' },
    { value: 'date', label: 'date' },
    // ref:<type> handled via the Combobox below selecting a card type;
    // the form translates that into `ref:<name>` on save. There is no
    // separate "enum" type post-refactor: pick-from-a-list attributes
    // are card_refs to a per-project value-card list.
    { value: 'ref', label: 'ref:<card type>' },
  ];

  /** Lock value_type when any card already carries a value for this def. */
  const valueTypeLocked = $derived<boolean>(
    selectedDef !== null && defHasAnyValuesForSelected(),
  );

  function defHasAnyValuesForSelected(): boolean {
    if (selectedDef === null) return false;
    const refType = parseRefCardType(
      selectedDef.value_type,
      selectedDef.target_card_type_name,
    );
    if (refType === null) {
      // Without a ref load we can't cheaply know — be conservative and only
      // lock for ref types where we have the cards loaded.
      return false;
    }
    const cards = valueCards[refType];
    if (!cards) return false;
    for (const c of cards) {
      const v = c.attributes[selectedDef.name];
      if (v !== undefined && v !== null) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------ data fetch */

  async function loadInitial(): Promise<void> {
    loading = true;
    error = null;
    try {
      const fDefs = dispatcher.request<
        AttributeDefSelectInput,
        AttributeDefSelectOutput
      >({
        endpoint: attributeDefSelect.endpoint,
        action: attributeDefSelect.action,
        data: {},
      });
      const fTypes = dispatcher.request<
        CardTypeSelectInput,
        CardTypeSelectOutput
      >({
        endpoint: cardTypeSelect.endpoint,
        action: cardTypeSelect.action,
        data: {},
      });
      const [defsOut, typesOut] = await Promise.all([fDefs, fTypes]);
      defs = defsOut.rows;
      cardTypes = typesOut.rows;
      loading = false;
      if (selectedDefId === null && defs.length > 0) {
        const first = defs[0];
        if (first !== undefined) selectedDefId = first.id;
      }
    } catch (e) {
      loading = false;
      if (e instanceof SubRequestError) error = e.message;
      else if (e instanceof BatchAbortedError) error = e.reason;
      else error = e instanceof Error ? e.message : String(e);
    }
  }

  async function refreshDefs(): Promise<void> {
    try {
      const out = await dispatcher.request<
        AttributeDefSelectInput,
        AttributeDefSelectOutput
      >({
        endpoint: attributeDefSelect.endpoint,
        action: attributeDefSelect.action,
        data: {},
      });
      defs = out.rows;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Refresh failed: ${msg}` });
    }
  }

  async function loadValueCards(cardTypeName: string): Promise<void> {
    try {
      // milestones / components / tags / statuses are parented to a
      // project, so the admin list scopes to whichever project the
      // sidebar has pinned. Without a scope we leave parentCardId unset
      // so the admin still has a way to see every value card across
      // the installation, but the "(All projects)" rendering surfaces
      // a hint about which project each row belongs to.
      //
      // Order by sort_order ASC so drag-drop reorder writes (which
      // mutate the sort_order attribute) are reflected on the next
      // load. Cards with NULL sort_order land at the bottom (Postgres
      // ASC NULLS LAST by default on this server's CompileOrder).
      const data: CardSelectWithAttributesInput = {
        cardTypeName,
        includeDeleted: false,
        limit: 500,
        order: [{ field: 'attributes.sort_order', direction: 'ASC' }],
      };
      const scoped = projectScope.projectId;
      if (scoped !== null) data.parentCardId = scoped;
      const out = await dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data,
      });
      valueCards = { ...valueCards, [cardTypeName]: out.rows };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Load values failed: ${msg}` });
    }
  }

  // Auto-fetch the value cards whenever we hop to a ref-typed def or
  // the sidebar's project scope flips. Re-fetching on every scope
  // change keeps the admin's view aligned with whichever project
  // they've picked.
  $effect(() => {
    const t = selectedRefCardType;
    void projectScope.projectId; // tracked
    if (t === null) return;
    void loadValueCards(t);
  });

  /* --------------------------------------------------- selection handlers */

  function selectDef(id: ID): void {
    creating = false;
    selectedDefId = id;
  }

  function startCreate(): void {
    creating = true;
    selectedDefId = null;
    draft = blankDraft();
    draftErrors = {};
  }

  /* --------------------------------------------------- center pane: save */

  async function saveCreate(): Promise<void> {
    const result = validateNewAttr(draft);
    draftErrors = result.errors;
    if (!result.ok) return;
    saving = true;
    try {
      // Translate `ref` placeholder into `ref:<card_type>` for the wire.
      let valueType = draft.valueType.trim();
      if (valueType === 'ref') {
        const refTarget = (draft.refCardType ?? '').trim();
        valueType = `ref:${refTarget}`;
      }

      const data: AttributeDefInsertInput = {
        name: draft.name.trim(),
        valueType,
      };

      await dispatcher.request<
        AttributeDefInsertInput,
        AttributeDefInsertOutput
      >({
        endpoint: attributeDefInsert.endpoint,
        action: attributeDefInsert.action,
        data,
      });
      notify({ type: 'success', message: `Attribute "${draft.name}" created.` });
      creating = false;
      draft = blankDraft();
      draftErrors = {};
      await refreshDefs();
      // Select the newly created def by name.
      const created = defs.find((d) => d.name === data.name);
      if (created) selectedDefId = created.id;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      draftErrors = { ...draftErrors, _form: msg };
    } finally {
      saving = false;
    }
  }

  /* ----------------------------------------------- right pane: matrix ops */

  async function setBound(row: MatrixRow, next: boolean): Promise<void> {
    if (selectedDef === null) return;
    const def = selectedDef;
    if (next) {
      try {
        const data: EdgeInsertInput = {
          attributeDefId: def.id,
          cardTypeId: row.cardType.id,
        };
        if (row.required) data.isRequired = true;
        if (row.ordering !== 0) data.ordering = row.ordering;
        await dispatcher.request<EdgeInsertInput, EdgeInsertOutput>({
          endpoint: edgeInsert.endpoint,
          action: edgeInsert.action,
          data,
        });
        await refreshDefs();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        notify({ type: 'error', message: `Bind failed: ${msg}` });
      }
    } else {
      try {
        const out = await dispatcher.request<EdgeDeleteInput, EdgeDeleteOutput>({
          endpoint: edgeDelete.endpoint,
          action: edgeDelete.action,
          data: { attributeDefId: def.id, cardTypeId: row.cardType.id },
        });
        if (!out.ok) {
          notify({
            type: 'error',
            message:
              out.usage_count > 0
                ? `In use by ${out.usage_count} card(s); clear them first.`
                : 'Unbind refused (built-in or missing).',
          });
          return;
        }
        await refreshDefs();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        notify({ type: 'error', message: `Unbind failed: ${msg}` });
      }
    }
  }

  async function setRequired(row: MatrixRow, next: boolean): Promise<void> {
    if (selectedDef === null) return;
    const def = selectedDef;
    if (!row.bound) return;
    try {
      // edge.insert is idempotent and the server uses ON CONFLICT DO NOTHING,
      // which means we cannot UPDATE the required flag through the existing
      // surface. Best we can do today: delete + reinsert.
      await dispatcher.request<EdgeDeleteInput, EdgeDeleteOutput>({
        endpoint: edgeDelete.endpoint,
        action: edgeDelete.action,
        data: { attributeDefId: def.id, cardTypeId: row.cardType.id },
      });
      const ins: EdgeInsertInput = {
        attributeDefId: def.id,
        cardTypeId: row.cardType.id,
      };
      if (next) ins.isRequired = true;
      if (row.ordering !== 0) ins.ordering = row.ordering;
      await dispatcher.request<EdgeInsertInput, EdgeInsertOutput>({
        endpoint: edgeInsert.endpoint,
        action: edgeInsert.action,
        data: ins,
      });
      await refreshDefs();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Update required failed: ${msg}` });
    }
  }

  async function setOrdering(row: MatrixRow, next: number): Promise<void> {
    if (selectedDef === null) return;
    const def = selectedDef;
    if (!row.bound) return;
    try {
      await dispatcher.request<EdgeDeleteInput, EdgeDeleteOutput>({
        endpoint: edgeDelete.endpoint,
        action: edgeDelete.action,
        data: { attributeDefId: def.id, cardTypeId: row.cardType.id },
      });
      const ins: EdgeInsertInput = {
        attributeDefId: def.id,
        cardTypeId: row.cardType.id,
      };
      if (row.required) ins.isRequired = true;
      if (next !== 0) ins.ordering = next;
      await dispatcher.request<EdgeInsertInput, EdgeInsertOutput>({
        endpoint: edgeInsert.endpoint,
        action: edgeInsert.action,
        data: ins,
      });
      await refreshDefs();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Update ordering failed: ${msg}` });
    }
  }

  /* ------------------------------------------------- value-card actions */

  let newValueTitle = $state('');

  async function addValueCard(cardTypeName: string): Promise<void> {
    const t = newValueTitle.trim();
    if (t === '') return;
    // milestone / component / tag all have parent_card_type_id = project, so
    // the server requires a parent_card_id at insert time. Use whichever
    // project the title-bar picker has pinned; if the user is in
    // "(All projects)" mode we surface a helpful error instead of letting
    // the wire failure leak through.
    const parent = projectScope.projectId;
    if (parent === null) {
      notify({
        type: 'error',
        message: `Pick a project from a list screen before adding a ${cardTypeName}.`,
      });
      return;
    }
    try {
      const data: CardInsertInput = {
        cardTypeName,
        title: t,
        parentCardId: parent,
      };
      await dispatcher.request<CardInsertInput, CardInsertOutput>({
        endpoint: cardInsert.endpoint,
        action: cardInsert.action,
        data,
      });
      newValueTitle = '';
      await loadValueCards(cardTypeName);
      notify({ type: 'success', message: `Value "${t}" added.` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Add value failed: ${msg}` });
    }
  }

  async function renameValueCard(
    card: CardWithAttrs,
    cardTypeName: string,
    nextTitle: string,
  ): Promise<void> {
    const t = nextTitle.trim();
    if (t === '') return;
    try {
      const data: AttributeUpdateInput = {
        cardId: card.id,
        attributeName: 'title',
        value: t,
      };
      await dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
        endpoint: attributeUpdate.endpoint,
        action: attributeUpdate.action,
        data,
      });
      await loadValueCards(cardTypeName);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Rename failed: ${msg}` });
    }
  }

  async function deleteValueCard(
    card: CardWithAttrs,
    cardTypeName: string,
  ): Promise<void> {
    try {
      const out = await dispatcher.request<CardDeleteInput, CardDeleteOutput>({
        endpoint: cardDelete.endpoint,
        action: cardDelete.action,
        data: { cardId: card.id },
      });
      if (!out.ok) {
        notify({ type: 'error', message: 'Delete refused.' });
        return;
      }
      await loadValueCards(cardTypeName);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Delete failed: ${msg}` });
    }
  }

  /**
   * Flip a value card's `is_active` attribute (migration 0011 bool flag) so
   * the card stays in the dataset for activity-history / referential
   * integrity but disappears from picker dropdowns. Soft-archive — the
   * `card.delete` button is still the way to fully remove an unused card.
   */
  async function setValueCardActive(
    card: CardWithAttrs,
    cardTypeName: string,
    nextActive: boolean,
  ): Promise<void> {
    try {
      const data: AttributeUpdateInput = {
        cardId: card.id,
        attributeName: 'is_active',
        value: nextActive,
      };
      await dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
        endpoint: attributeUpdate.endpoint,
        action: attributeUpdate.action,
        data,
      });
      await loadValueCards(cardTypeName);
      notify({
        type: 'success',
        message: nextActive ? 'Restored.' : 'Archived.',
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Update failed: ${msg}` });
    }
  }

  /**
   * Move the dragged value-card to slot `slot` (0..N; N drops at the
   * end) and persist by writing the canonical `sort_order` attribute
   * on every row whose position changes. We normalise the whole list
   * to `(i + 1) * 100` so it stays well-spaced and works whether or
   * not the original rows already had sort_orders — important for
   * milestones / components / tags, which the demo seeds with no
   * sort_order at all.
   *
   * NOTE: We deliberately write the global `sort_order` attribute, not
   * `user_card_sort.set` (the per-user inbox-personal ordering). Admin
   * reorder is a project-wide change everyone should see.
   */
  async function reorderValueCard(
    payload: unknown,
    slot: number,
    cardTypeName: string,
  ): Promise<void> {
    const obj = payload as { id?: ID };
    const id = obj?.id;
    if (typeof id !== 'bigint') return;
    const cards = valueCards[cardTypeName] ?? [];
    const moved = cards.find((c) => c.id === id);
    if (moved === undefined) return;
    const without = cards.filter((c) => c.id !== id);

    // The original slot index counts BEFORE the moved row's slot; if
    // the drop target sits below the moved row's old position we offset
    // by one so the in-place move lands where the user expects.
    const origIdx = cards.findIndex((c) => c.id === id);
    let insertAt = slot;
    if (origIdx >= 0 && origIdx < slot) insertAt -= 1;
    if (insertAt < 0) insertAt = 0;
    if (insertAt > without.length) insertAt = without.length;

    const next = without.slice();
    next.splice(insertAt, 0, moved);

    // Build the minimal set of writes. A row only needs a write if its
    // desired `(i + 1) * 100` doesn't match its current sort_order.
    const updates: { cardId: ID; sortOrder: number }[] = [];
    for (let i = 0; i < next.length; i++) {
      const c = next[i];
      if (c === undefined) continue;
      const desired = (i + 1) * 100;
      const cur = c.attributes['sort_order'];
      const curNum =
        typeof cur === 'number' ? cur :
        typeof cur === 'bigint' ? Number(cur) :
        NaN;
      if (curNum === desired) continue;
      updates.push({ cardId: c.id, sortOrder: desired });
    }
    if (updates.length === 0) return;

    try {
      await Promise.all(
        updates.map((u) =>
          dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
            endpoint: attributeUpdate.endpoint,
            action: attributeUpdate.action,
            data: {
              cardId: u.cardId,
              attributeName: 'sort_order',
              value: u.sortOrder,
            },
          }),
        ),
      );
      await loadValueCards(cardTypeName);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Reorder failed: ${msg}` });
    }
  }

  /* ------------------------------------------------------ keyboard glue */

  async function focusSearch(): Promise<void> {
    await tick();
    searchEl?.focus();
    searchEl?.select();
  }

  async function focusNew(): Promise<void> {
    await tick();
    newBtnEl?.focus();
  }

  function moveSelection(delta: number): void {
    const list = flatList;
    if (list.length === 0) return;
    const cur = list.findIndex((d) => d.id === selectedDefId);
    let next = cur + delta;
    if (cur === -1) next = delta > 0 ? 0 : list.length - 1;
    if (next < 0) next = 0;
    if (next > list.length - 1) next = list.length - 1;
    const target = list[next];
    if (target !== undefined) selectDef(target.id);
  }

  useShortcut('admin_attributes', '/', () => void focusSearch(), 'Focus search', {
    fireInInputs: false,
  });
  useShortcut('admin_attributes', 'n', () => void focusNew(), 'New attribute', {
    fireInInputs: false,
  });
  useShortcut('admin_attributes', 'j', () => moveSelection(+1), 'Next attribute', {
    fireInInputs: false,
  });
  useShortcut('admin_attributes', 'k', () => moveSelection(-1), 'Previous attribute', {
    fireInInputs: false,
  });
  useShortcut(
    'admin_attributes',
    'Enter',
    () => {
      if (creating) void saveCreate();
    },
    'Save (create mode)',
    { fireInInputs: false },
  );

  /* ------------------------------------------------------------- mount */

  onMount(() => {
    void loadInitial();
  });
</script>

<div class="flex h-full flex-col">
  <header
    class="flex items-center justify-between border-b border-border px-4 py-2"
  >
    <h1 class="text-lg font-semibold">Admin · Attributes</h1>
  </header>

  {#if loading && defs.length === 0}
    <div class="flex flex-1 items-center justify-center">
      <Spinner size="lg" />
    </div>
  {:else if error !== null}
    <div
      role="alert"
      class="m-4 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      Failed to load: {error}
      <button
        type="button"
        class="ml-3 underline"
        onclick={() => void loadInitial()}
      >
        Retry
      </button>
    </div>
  {:else}
    <div class="grid flex-1 min-h-0 grid-cols-[280px_1fr_360px]">
      <!-- ---------------------------------------------------- LEFT -->
      <aside
        class="flex flex-col border-r border-border min-h-0"
        aria-label="Attribute list"
      >
        <div class="flex flex-col gap-2 border-b border-border p-2">
          <input
            type="search"
            bind:this={searchEl}
            bind:value={search}
            placeholder="Search attributes (press /)"
            aria-label="Search attributes"
            class={cx(
              'w-full rounded-md border border-border bg-bg px-2 py-1 text-sm',
              'text-fg placeholder:text-muted',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            )}
          />
          <button
            bind:this={newBtnEl}
            type="button"
            data-testid="new-attr-button"
            class={cx(
              'inline-flex h-8 select-none items-center justify-center rounded-md',
              'bg-accent px-2 text-sm font-medium text-accent-fg',
              'transition-colors hover:opacity-90',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            )}
            onclick={startCreate}
          >
            + New attribute
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto">
          {#if creating}
            <div
              class="border-b border-border bg-surface px-3 py-2 text-sm"
              data-testid="draft-row"
            >
              <span class="font-medium text-fg">{draft.name || '(new attribute)'}</span>
              <Chip label="draft" size="sm" />
            </div>
          {/if}

          {#if grouped.builtIn.length > 0}
            <div class="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
              Built-in
            </div>
            <ul>
              {#each grouped.builtIn as d (d.id)}
                <li>
                  <button
                    type="button"
                    data-testid={`attr-row-${d.id}`}
                    class={cx(
                      'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm',
                      'hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      d.id === selectedDefId && !creating ? 'bg-surface' : '',
                    )}
                    onclick={() => selectDef(d.id)}
                  >
                    <span class="flex min-w-0 flex-col">
                      <span class="truncate font-medium text-fg">{d.name}</span>
                      <span class="truncate text-xs text-muted">{d.value_type}</span>
                    </span>
                    <Chip label="built-in" size="sm" />
                  </button>
                </li>
              {/each}
            </ul>
          {/if}

          {#if grouped.custom.length > 0}
            <div class="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
              Custom
            </div>
            <ul>
              {#each grouped.custom as d (d.id)}
                <li>
                  <button
                    type="button"
                    data-testid={`attr-row-${d.id}`}
                    class={cx(
                      'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm',
                      'hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      d.id === selectedDefId && !creating ? 'bg-surface' : '',
                    )}
                    onclick={() => selectDef(d.id)}
                  >
                    <span class="flex min-w-0 flex-col">
                      <span class="truncate font-medium text-fg">{d.name}</span>
                      <span class="truncate text-xs text-muted">{d.value_type}</span>
                    </span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}

          {#if grouped.builtIn.length === 0 && grouped.custom.length === 0}
            <div class="p-4 text-center text-sm text-muted">
              No attributes match.
            </div>
          {/if}
        </div>
      </aside>

      <!-- ---------------------------------------------------- CENTER -->
      <section
        class="flex min-h-0 flex-col overflow-y-auto p-4"
        aria-label="Attribute detail"
      >
        {#if creating}
          <div class="flex flex-col gap-3" data-testid="create-form">
            <h2 class="text-base font-semibold">New attribute</h2>

            <label class="flex flex-col gap-1 text-sm">
              <span class="text-muted">Name</span>
              <input
                type="text"
                data-testid="new-attr-name"
                bind:value={draft.name}
                class={cx(
                  'rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-fg',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                )}
              />
              {#if draftErrors.name}
                <span class="text-xs text-danger">{draftErrors.name}</span>
              {/if}
            </label>

            <label class="flex flex-col gap-1 text-sm">
              <span class="text-muted">Value type</span>
              <Combobox
                value={draft.valueType}
                options={valueTypeOptions}
                searchable={false}
                onchange={(v) => {
                  if (typeof v === 'string') {
                    draft = { ...draft, valueType: v };
                  }
                }}
              />
              {#if draftErrors.valueType}
                <span class="text-xs text-danger">{draftErrors.valueType}</span>
              {/if}
            </label>

            {#if draft.valueType === 'ref'}
              <label class="flex flex-col gap-1 text-sm">
                <span class="text-muted">Card type</span>
                <Combobox
                  value={draft.refCardType ?? null}
                  options={cardTypeOptions}
                  onchange={(v) => {
                    if (typeof v === 'string') {
                      draft = { ...draft, refCardType: v };
                    }
                  }}
                />
                {#if draftErrors.refCardType}
                  <span class="text-xs text-danger">{draftErrors.refCardType}</span>
                {/if}
              </label>
            {/if}

            {#if draftErrors._form}
              <div class="rounded border border-danger/40 bg-danger/10 px-2 py-1 text-xs text-danger">
                {draftErrors._form}
              </div>
            {/if}

            <div class="flex items-center gap-2">
              <Button
                variant="primary"
                size="md"
                loading={saving}
                onclick={() => void saveCreate()}
              >
                {#snippet children()}Save{/snippet}
              </Button>
              <Button
                variant="ghost"
                size="md"
                onclick={() => {
                  creating = false;
                  draft = blankDraft();
                  draftErrors = {};
                }}
              >
                {#snippet children()}Cancel{/snippet}
              </Button>
            </div>
          </div>
        {:else if selectedDef !== null}
          {@const def = selectedDef}
          <div class="flex flex-col gap-3" data-testid="edit-form">
            <div class="flex items-center gap-2">
              <h2 class="text-base font-semibold">{def.name}</h2>
              <Chip label={def.value_type} size="sm" />
              {#if def.is_built_in}
                <Chip label="built-in" size="sm" />
              {/if}
            </div>

            <label class="flex flex-col gap-1 text-sm">
              <span class="text-muted">Name</span>
              <input
                type="text"
                value={def.name}
                disabled={def.is_built_in}
                readonly
                class={cx(
                  'rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-fg',
                  'disabled:opacity-50',
                )}
              />
              {#if def.is_built_in}
                <span class="text-xs text-muted">Built-in defs cannot be renamed.</span>
              {/if}
            </label>

            <label class="flex flex-col gap-1 text-sm">
              <span class="text-muted">Value type</span>
              <input
                type="text"
                value={def.value_type}
                readonly
                class={cx(
                  'rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-fg',
                  'opacity-70',
                )}
              />
              {#if valueTypeLocked}
                <span class="text-xs text-muted">
                  Locked — cards already carry values for this attribute.
                </span>
              {:else}
                <span class="text-xs text-muted">
                  Value type can only be changed via a database migration today.
                </span>
              {/if}
            </label>

            {#if selectedRefCardType !== null}
              <label class="flex flex-col gap-1 text-sm">
                <span class="text-muted">Referenced card type</span>
                <input
                  type="text"
                  value={selectedRefCardType}
                  readonly
                  class="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-fg opacity-70"
                />
              </label>
            {/if}
          </div>
        {:else}
          <EmptyState
            title="No attribute selected"
            description="Pick an attribute on the left, or create a new one."
            action={{ label: '+ New attribute', onClick: startCreate }}
          />
        {/if}
      </section>

      <!-- ---------------------------------------------------- RIGHT -->
      <aside
        class="flex min-h-0 flex-col border-l border-border"
        aria-label="Bound to and value cards"
      >
        <div class="flex flex-col gap-2 p-3">
          <h3 class="text-sm font-semibold">Bound to</h3>
          {#if creating || selectedDef === null}
            <p class="text-xs text-muted">
              Pick an attribute to manage its bindings.
            </p>
          {:else}
            <table class="w-full text-sm">
              <thead>
                <tr class="text-left text-[10px] font-semibold uppercase tracking-wide text-muted">
                  <th class="px-1 py-1">Card type</th>
                  <th class="px-1 py-1">Bound</th>
                  <th class="px-1 py-1">Order</th>
                  <th class="px-1 py-1">Required</th>
                </tr>
              </thead>
              <tbody>
                {#each matrix as row (row.cardType.id)}
                  <tr
                    data-testid={`matrix-row-${row.cardType.id}`}
                    class="border-t border-border"
                  >
                    <td class="px-1 py-1 truncate">{row.cardType.name}</td>
                    <td class="px-1 py-1">
                      <input
                        type="checkbox"
                        aria-label={`Bind ${row.cardType.name}`}
                        checked={row.bound}
                        onchange={(e) =>
                          void setBound(row, (e.target as HTMLInputElement).checked)}
                      />
                    </td>
                    <td class="px-1 py-1">
                      <input
                        type="number"
                        aria-label={`Ordering for ${row.cardType.name}`}
                        value={row.ordering}
                        disabled={!row.bound}
                        onchange={(e) => {
                          const n = Number((e.target as HTMLInputElement).value);
                          if (Number.isFinite(n)) void setOrdering(row, n);
                        }}
                        class="w-16 rounded border border-border bg-bg px-1 py-0.5 text-sm disabled:opacity-50"
                      />
                    </td>
                    <td class="px-1 py-1">
                      <input
                        type="checkbox"
                        aria-label={`Required for ${row.cardType.name}`}
                        checked={row.required}
                        disabled={!row.bound}
                        onchange={(e) =>
                          void setRequired(row, (e.target as HTMLInputElement).checked)}
                      />
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </div>

        {#if selectedRefCardType !== null && !creating}
          {@const refType = selectedRefCardType}
          {@const cards = valueCards[refType] ?? []}
          <div class="flex min-h-0 flex-1 flex-col border-t border-border">
            <div class="flex items-center justify-between gap-2 px-3 py-2">
              <h3 class="text-sm font-semibold">
                Value cards <span class="text-muted">({refType})</span>
              </h3>
            </div>
            <div class="flex items-center gap-2 px-3 pb-2">
              <input
                type="text"
                bind:value={newValueTitle}
                placeholder={`New ${refType}…`}
                aria-label={`New ${refType} title`}
                class="flex-1 rounded border border-border bg-bg px-2 py-1 text-sm"
                onkeydown={(e) => {
                  if (e.key === 'Enter') void addValueCard(refType);
                }}
              />
              <Button
                variant="secondary"
                size="sm"
                onclick={() => void addValueCard(refType)}
              >
                {#snippet children()}+ Add{/snippet}
              </Button>
            </div>
            <ul class="min-h-0 flex-1 overflow-y-auto">
              {#each cards as c, i (c.id)}
                {@const titleStr =
                  typeof c.attributes['title'] === 'string'
                    ? (c.attributes['title'] as string)
                    : `#${c.id}`}
                {@const isActive = c.attributes['is_active'] !== false}
                <DropZone
                  id={`vc-zone-${refType}-${c.id}`}
                  onDrop={(p) =>
                    void reorderValueCard(p, i, refType)}
                >
                  <li
                    data-testid={`value-card-${c.id}`}
                    class={cx(
                      'flex items-center gap-2 border-b border-border px-3 py-1.5 text-sm',
                      !isActive && 'opacity-60',
                    )}
                  >
                    <DragHandle payload={{ id: c.id }} previewLabel={titleStr}>
                      <span class="cursor-grab select-none text-muted" aria-hidden="true">
                        ⋮⋮
                      </span>
                    </DragHandle>
                    <input
                      type="text"
                      value={titleStr}
                      placeholder="Title"
                      class="flex-1 rounded border border-transparent bg-bg px-1 py-0.5 text-sm hover:border-border focus:border-border focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      onblur={(e) => {
                        const v = (e.target as HTMLInputElement).value;
                        if (v.trim() !== '' && v.trim() !== titleStr) {
                          void renameValueCard(c, refType, v);
                        }
                      }}
                      onkeydown={(e) => {
                        if (e.key === 'Enter') {
                          (e.target as HTMLInputElement).blur();
                        } else if (e.key === 'Escape') {
                          (e.target as HTMLInputElement).value = titleStr;
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                    />
                    {#if !isActive}
                      <span
                        class="rounded border border-border px-1 text-[10px] uppercase tracking-wide text-muted"
                      >archived</span>
                    {/if}
                    <IconButton
                      aria-label={isActive ? `Archive ${titleStr}` : `Restore ${titleStr}`}
                      title={isActive ? 'Archive (hide from pickers)' : 'Restore'}
                      size="sm"
                      variant="ghost"
                      onclick={() => void setValueCardActive(c, refType, !isActive)}
                    >
                      {#snippet children()}{isActive ? '🗄' : '↺'}{/snippet}
                    </IconButton>
                    <IconButton
                      aria-label={`Delete ${titleStr}`}
                      size="sm"
                      variant="danger"
                      onclick={() => void deleteValueCard(c, refType)}
                    >
                      {#snippet children()}🗑{/snippet}
                    </IconButton>
                  </li>
                </DropZone>
              {/each}
              {#if cards.length > 0}
                <DropZone
                  id={`vc-zone-${refType}-tail`}
                  onDrop={(p) =>
                    void reorderValueCard(p, cards.length, refType)}
                />
              {/if}
              {#if cards.length === 0}
                <li class="p-3 text-center text-xs text-muted">
                  No value cards yet.
                </li>
              {/if}
            </ul>
          </div>
        {/if}
      </aside>
    </div>
  {/if}
</div>
