<!--
  BulkActionBar — floating action bar shown when one or more rows are
  checked in the Grid. Mirrors the QuickEntry "+ Add field" pattern:
  the user picks an attribute from the palette, edits its value with
  ValueInput, and clicks "Assign" to fan the change out to every
  selected card (one attribute.update per (card, attribute)).

  The "..." kebab exposes destructive bulk actions; today that's just
  Delete forever, opened as BulkPurgeDialog (type-to-confirm modal).
-->
<script lang="ts">
  import { getDispatcher } from '../dispatch/context';
  import { attributeUpdate } from '../reg/handlers';
  import type {
    AttributeUpdateInput,
    AttributeUpdateOutput,
    ID,
  } from '../reg/types';
  import type { FilterAttribute } from '../filter/attribute_schema.svelte';
  import Button from '../ui/Button.svelte';
  import Combobox from '../ui/Combobox.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import ValueInput from '../filter/ValueInput.svelte';
  import { notify } from '../ui/toast.svelte';
  import BulkPurgeDialog from './BulkPurgeDialog.svelte';
  import BulkMoveDialog from './BulkMoveDialog.svelte';

  interface Props {
    /** Ids of the currently selected cards. Bar is hidden when empty. */
    selectedIds: ID[];
    /** Attribute palette — same shape the FilterBar / QuickEntry use.
     *  Each entry must already have its `options` populated for the
     *  ref:* types (persons / milestones / tags / …) so the inline
     *  ValueInput renders meaningful choices without a fetch. */
    attributePalette: FilterAttribute[];
    /** Source project — threaded through to BulkMoveDialog so the
     *  destination picker can hide the current project. Null when
     *  the host spans multiple projects. */
    sourceProjectId?: ID | null;
    /** Clears the host's selection without applying anything. */
    onClear?: () => void;
    /** Fired after a successful Assign. The host should refresh and
     *  clear selection (the new values won't appear otherwise). */
    onApplied?: () => void;
    /** Fired after a successful bulk purge. */
    onPurged?: (purged: ID[]) => void;
    /** Fired after a successful bulk move. */
    onMoved?: (moved: ID[]) => void;
  }

  let {
    selectedIds,
    attributePalette,
    sourceProjectId = null,
    onClear,
    onApplied,
    onPurged,
    onMoved,
  }: Props = $props();

  const dispatcher = getDispatcher();

  /** User-added attribute rows. Same shape as the QuickEntry palette
   *  rows so the +Add-field affordance behaves identically. */
  type AttrRow = { id: number; name: string | null; value: unknown };
  let attrRows = $state<AttrRow[]>([]);
  let nextRowId = 1;

  let submitting = $state(false);
  let kebabOpen = $state(false);
  let purgeOpen = $state(false);
  let moveOpen = $state(false);

  /** Names already chosen in another row — filtered out of new pickers
   *  so the user can't pick the same field twice (the second update
   *  would clobber the first). */
  const claimedNames = $derived.by((): ReadonlySet<string> => {
    const s = new Set<string>();
    for (const r of attrRows) if (r.name !== null) s.add(r.name);
    return s;
  });

  /** Bulk-assign currently excludes the title / description scalar
   *  fields — mass-overwriting free-text would be a footgun. Tag,
   *  status, milestone, component, ref:* and date attributes are all
   *  safe. */
  const SCALAR_TEXT_BLOCKLIST = new Set(['title', 'description']);

  const pickerOptions = $derived.by(() =>
    attributePalette
      .filter((a) => !SCALAR_TEXT_BLOCKLIST.has(a.name))
      .filter((a) => !claimedNames.has(a.name))
      .map((a) => ({ value: a.name, label: a.label })),
  );

  function attributeFor(name: string | null): FilterAttribute | null {
    if (name === null) return null;
    return attributePalette.find((a) => a.name === name) ?? null;
  }

  function addAttrRow(): void {
    attrRows = [...attrRows, { id: nextRowId++, name: null, value: undefined }];
  }

  function removeAttrRow(rowId: number): void {
    attrRows = attrRows.filter((r) => r.id !== rowId);
  }

  function setAttrName(rowId: number, name: string | null): void {
    attrRows = attrRows.map((r) =>
      r.id !== rowId ? r : { ...r, name, value: undefined },
    );
  }

  function setAttrValue(rowId: number, value: unknown): void {
    attrRows = attrRows.map((r) => (r.id === rowId ? { ...r, value } : r));
  }

  /** Rows that are ready to write — both name and (non-empty) value
   *  set. An empty array means "user added rows but filled nothing
   *  in"; we surface a toast rather than silently no-op so the user
   *  doesn't think Assign worked. */
  const pendingRows = $derived.by(() =>
    attrRows.filter((r) => {
      if (r.name === null) return false;
      const v = r.value;
      if (v === undefined || v === null) return false;
      if (typeof v === 'string' && v === '') return false;
      if (Array.isArray(v) && v.length === 0) return false;
      return true;
    }),
  );

  const canAssign = $derived(
    selectedIds.length > 0 && pendingRows.length > 0 && !submitting,
  );

  async function applyAll(): Promise<void> {
    if (!canAssign) return;
    submitting = true;
    const total = selectedIds.length * pendingRows.length;
    const results = await Promise.allSettled(
      selectedIds.flatMap((cardId) =>
        pendingRows.map((r) =>
          dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
            endpoint: attributeUpdate.endpoint,
            action: attributeUpdate.action,
            data: {
              cardId,
              attributeName: r.name as string,
              value: r.value,
            },
          }),
        ),
      ),
    );
    submitting = false;
    let failed = 0;
    let firstError = '';
    for (const r of results) {
      if (r.status === 'rejected') {
        failed += 1;
        if (firstError === '') {
          firstError = r.reason instanceof Error ? r.reason.message : String(r.reason);
        }
      }
    }
    if (failed === 0) {
      notify({
        type: 'success',
        message:
          `Assigned ${pendingRows.length} field${pendingRows.length === 1 ? '' : 's'} `
          + `to ${selectedIds.length} task${selectedIds.length === 1 ? '' : 's'}`,
      });
      attrRows = [];
      onApplied?.();
    } else {
      notify({
        type: 'error',
        message: `Assigned ${total - failed} / ${total}; ${failed} failed: ${firstError}`,
      });
      // Keep the rows around so the user can retry / inspect.
      onApplied?.();
    }
  }
</script>

{#if selectedIds.length > 0}
  <div
    class="pointer-events-auto fixed bottom-4 left-1/2 z-40 w-[min(720px,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-border bg-bg shadow-xl"
    role="region"
    aria-label="Bulk actions"
    data-testid="bulk-action-bar"
  >
    <!-- Header -->
    <div class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
      <div class="text-sm font-medium">
        {selectedIds.length} task{selectedIds.length === 1 ? '' : 's'} selected
      </div>
      <div class="flex items-center gap-1">
        <button
          type="button"
          class="text-xs text-muted hover:text-fg hover:underline focus:outline-none focus-visible:underline"
          onclick={() => onClear?.()}
          data-testid="bulk-clear"
        >
          Clear
        </button>
        <div class="relative" data-testid="bulk-kebab">
          <IconButton
            aria-label="More bulk actions"
            size="sm"
            variant="ghost"
            onclick={() => (kebabOpen = !kebabOpen)}
          >
            {#snippet children()}…{/snippet}
          </IconButton>
          {#if kebabOpen}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="fixed inset-0 z-0"
              onclick={() => (kebabOpen = false)}
            ></div>
            <div
              class="absolute right-0 top-full z-10 mt-1 w-44 rounded-md border border-border bg-bg shadow-lg"
              role="menu"
            >
              <button
                type="button"
                role="menuitem"
                class="block w-full px-3 py-1.5 text-left text-sm text-fg hover:bg-surface focus:outline-none"
                onclick={() => {
                  kebabOpen = false;
                  moveOpen = true;
                }}
                data-testid="bulk-move"
              >
                Move to project…
              </button>
              <button
                type="button"
                role="menuitem"
                class="block w-full border-t border-border px-3 py-1.5 text-left text-sm text-danger hover:bg-danger/10 focus:outline-none"
                onclick={() => {
                  kebabOpen = false;
                  purgeOpen = true;
                }}
                data-testid="bulk-purge"
              >
                Delete forever…
              </button>
            </div>
          {/if}
        </div>
      </div>
    </div>

    <!-- Attribute rows -->
    <div class="px-3 py-2">
      <div class="mb-1 flex items-center justify-between">
        <span class="text-xs font-medium text-muted">Attributes</span>
        <button
          type="button"
          class="text-xs text-accent hover:underline focus:outline-none focus-visible:underline disabled:opacity-50"
          disabled={submitting || pickerOptions.length === 0}
          onclick={addAttrRow}
          data-testid="bulk-add-attribute"
        >
          + Add field
        </button>
      </div>
      {#if attrRows.length === 0}
        <p class="text-[11px] italic text-muted">
          Click + Add field to assign an attribute across the selected
          tasks.
        </p>
      {/if}
      {#each attrRows as row (row.id)}
        {@const fa = attributeFor(row.name)}
        <div class="mb-1.5 flex items-start gap-1.5" data-testid="bulk-attr-row">
          <div class="w-40 shrink-0">
            <Combobox
              aria-label="Attribute"
              options={attributePalette
                .filter((a) => !SCALAR_TEXT_BLOCKLIST.has(a.name))
                .filter((a) => a.name === row.name || !claimedNames.has(a.name))
                .map((a) => ({ value: a.name, label: a.label }))}
              value={row.name}
              placeholder="Field…"
              disabled={submitting}
              onchange={(v) => setAttrName(row.id, typeof v === 'string' ? v : null)}
            />
          </div>
          <div class="min-w-0 flex-1">
            {#if fa !== null}
              <ValueInput
                attribute={fa}
                value={row.value}
                multiple={fa.valueType.endsWith('[]') || fa.valueType === 'card_ref[]'}
                onchange={(v) => setAttrValue(row.id, v)}
              />
            {:else}
              <span class="text-xs italic text-muted">Pick a field first.</span>
            {/if}
          </div>
          <IconButton
            aria-label="Remove field"
            size="sm"
            variant="ghost"
            onclick={() => removeAttrRow(row.id)}
          >
            {#snippet children()}×{/snippet}
          </IconButton>
        </div>
      {/each}
    </div>

    <!-- Footer -->
    <div class="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={submitting}
        onclick={() => onClear?.()}
      >
        {#snippet children()}Cancel{/snippet}
      </Button>
      <span data-testid="bulk-assign">
        <Button
          size="sm"
          variant="primary"
          disabled={!canAssign}
          loading={submitting}
          onclick={() => void applyAll()}
        >
          {#snippet children()}
            Assign to {selectedIds.length} task{selectedIds.length === 1 ? '' : 's'}
          {/snippet}
        </Button>
      </span>
    </div>
  </div>

  <BulkPurgeDialog
    bind:open={purgeOpen}
    cardIds={selectedIds}
    onPurged={(purged) => onPurged?.(purged)}
  />

  <BulkMoveDialog
    bind:open={moveOpen}
    cardIds={selectedIds}
    {sourceProjectId}
    onMoved={(moved) => onMoved?.(moved)}
  />
{/if}
