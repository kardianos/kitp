<!--
  AdminNamedFiltersScreen — CRUD over `predicate_snippet` cards for the
  project pinned by the title-bar picker.

  A named filter (predicate_snippet) is a project-scoped, reusable
  predicate tree. Users compose them into a screen's active filter via
  the FilterBar's "Named" multi-select; the Advanced editor also lets
  them reference snippets as leaves inside an OR / NOT subtree.

  This screen is the single creation/editing surface. The FilterBar
  itself no longer carries a "Save current as named filter" action —
  see commit notes for the rationale (one place to find / rename /
  delete instead of a parallel save path).

  Wire surface (no new endpoints):
    - card.select_with_attributes  (predicate_snippet, milestone, …)
    - card.insert / card.delete    (predicate_snippet)
    - attribute.update             (title / predicate)
-->
<script lang="ts">
  import { untrack } from 'svelte';

  import { getDispatcher } from '../../dispatch/context';
  import { stringifyBigInt } from '../../dispatch/dispatcher';
  import {
    sharedSchemaCache,
    type FilterAttribute,
  } from '../../filter/attribute_schema.svelte';
  import FilterTreeEditor from '../../filter/FilterTreeEditor.svelte';
  import { predicateToJson, toText, type Predicate } from '../../filter/predicate';
  import { buildTaskFilterPalette } from '../../filter/task_palette';
  import {
    invalidateSnippets,
    loadSnippets,
    readSnippetPredicate,
    readSnippetTitle,
  } from '../../filter/snippet_store.svelte';
  import { clearHelpTopic, setHelpTopic } from '../../help/help_context.svelte';
  import { setActiveScope } from '../../keys/shortcut';
  import { projectScope } from '../../shell/project_scope.svelte';
  import {
    attributeUpdate,
    cardDelete,
    cardInsert,
    cardSelectWithAttributes,
  } from '../../reg/handlers';
  import type {
    AttributeUpdateInput,
    AttributeUpdateOutput,
    CardDeleteInput,
    CardDeleteOutput,
    CardInsertInput,
    CardInsertOutput,
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWithAttrs,
    ID,
  } from '../../reg/types';
  import Button from '../../ui/Button.svelte';
  import EmptyState from '../../ui/EmptyState.svelte';
  import IconButton from '../../ui/IconButton.svelte';
  import PageShell from '../../ui/PageShell.svelte';
  import Spinner from '../../ui/Spinner.svelte';
  import TextInput from '../../ui/inputs/TextInput.svelte';
  import { notify } from '../../ui/toast.svelte';

  setActiveScope('admin_named_filters');

  // Hook the help button (top-bar `?`) up to this page's authored
  // markdown. Cleared on unmount so other screens get their own topic.
  $effect(() => {
    setHelpTopic({ kind: 'topic', topic: 'admin.named_filters' });
    return () => clearHelpTopic();
  });

  const dispatcher = getDispatcher();
  const schemaCache = sharedSchemaCache(dispatcher);

  const projectId = $derived<ID | null>(projectScope.projectId);

  /* ------------------------------------------------------- snippet list -- */

  let snippets = $state<CardWithAttrs[]>([]);
  let loading = $state(false);

  async function refresh(): Promise<void> {
    const pid = projectId;
    if (pid === null) {
      snippets = [];
      return;
    }
    loading = true;
    try {
      const rows = await loadSnippets(dispatcher, pid, { force: true });
      if (projectId === pid) snippets = rows;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Load failed: ${msg}` });
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void projectId;
    untrack(() => {
      void refresh();
    });
  });

  /* ------------------------------------------------------- palette load -- */
  //
  // FilterTreeEditor needs the per-project FilterAttribute palette so
  // ref pickers (status, milestone, …) render with their options. We
  // load all five value-card lists alongside the schema in one tick;
  // the dispatcher coalesces into a single batch request. Mirrors the
  // pattern in AdminScreensScreen.

  let palettePersons = $state<CardWithAttrs[]>([]);
  let paletteMilestones = $state<CardWithAttrs[]>([]);
  let paletteComponents = $state<CardWithAttrs[]>([]);
  let paletteTags = $state<CardWithAttrs[]>([]);
  let paletteStatuses = $state<CardWithAttrs[]>([]);
  let paletteLoadedForProject = $state<ID | null>(null);
  let paletteLoading = $state(false);

  async function loadPaletteFor(pid: ID): Promise<void> {
    if (paletteLoadedForProject === pid && !paletteLoading) return;
    paletteLoading = true;
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
      const schemaLoad = schemaCache.load();
      const [pOut, mOut, cOut, tOut, sOut] = await Promise.all([
        req({ cardTypeName: 'person' }),
        req({ cardTypeName: 'milestone', parentCardId: pid }),
        req({ cardTypeName: 'component', parentCardId: pid }),
        req({ cardTypeName: 'tag', parentCardId: pid }),
        req({ cardTypeName: 'status', parentCardId: pid }),
      ]);
      await schemaLoad;
      if (projectId !== pid) return;
      palettePersons = pOut.rows;
      paletteMilestones = mOut.rows;
      paletteComponents = cOut.rows;
      paletteTags = tOut.rows;
      paletteStatuses = sOut.rows;
      paletteLoadedForProject = pid;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Load options failed: ${msg}` });
    } finally {
      paletteLoading = false;
    }
  }

  $effect(() => {
    const pid = projectId;
    if (pid === null) return;
    untrack(() => {
      void loadPaletteFor(pid);
    });
  });

  const filterAttributes = $derived<FilterAttribute[]>(
    buildTaskFilterPalette({
      schema: schemaCache,
      persons: palettePersons,
      milestones: paletteMilestones,
      components: paletteComponents,
      tags: paletteTags,
      statuses: paletteStatuses,
    }),
  );

  /* -------------------------------------------- editor state (modal) ---- */

  let editorOpen = $state(false);
  /** Snippet being edited, or null when creating a new one. */
  let editingSnippet = $state<CardWithAttrs | null>(null);
  /** Title input for the editing modal (mirrors the snippet card's
   *  title; used both for create + rename). */
  let editorTitle = $state<string>('');
  /** Predicate currently being edited; seeded from the snippet on open. */
  let editorPredicate = $state<Predicate | null>(null);
  /** Sub-modal flag — the FilterTreeEditor is itself modal, so we open
   *  the title-input modal first, then the tree editor when the user
   *  clicks "Edit predicate". */
  let treeEditorOpen = $state(false);

  function openNew(): void {
    editingSnippet = null;
    editorTitle = '';
    editorPredicate = null;
    editorOpen = true;
  }

  function openEdit(s: CardWithAttrs): void {
    editingSnippet = s;
    editorTitle = readSnippetTitle(s);
    editorPredicate = readSnippetPredicate(s);
    editorOpen = true;
  }

  function closeEditor(): void {
    editorOpen = false;
    treeEditorOpen = false;
    editingSnippet = null;
  }

  async function saveEditor(): Promise<void> {
    const pid = projectId;
    if (pid === null) {
      notify({ type: 'error', message: 'Pick a project first.' });
      return;
    }
    const title = editorTitle.trim();
    if (title === '') {
      notify({ type: 'error', message: 'Name is required.' });
      return;
    }
    if (editorPredicate === null) {
      notify({ type: 'error', message: 'Define a predicate before saving.' });
      return;
    }
    const predicateJSON = stringifyBigInt(predicateToJson(editorPredicate));
    try {
      if (editingSnippet === null) {
        await dispatcher.request<CardInsertInput, CardInsertOutput>({
          endpoint: cardInsert.endpoint,
          action: cardInsert.action,
          data: {
            cardTypeName: 'predicate_snippet',
            parentCardId: pid,
            title,
            attributes: { predicate: predicateJSON },
          },
        });
      } else {
        const id = editingSnippet.id;
        const ops: Promise<unknown>[] = [];
        if (title !== readSnippetTitle(editingSnippet)) {
          ops.push(
            dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
              endpoint: attributeUpdate.endpoint,
              action: attributeUpdate.action,
              data: { cardId: id, attributeName: 'title', value: title },
            }),
          );
        }
        ops.push(
          dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
            endpoint: attributeUpdate.endpoint,
            action: attributeUpdate.action,
            data: { cardId: id, attributeName: 'predicate', value: predicateJSON },
          }),
        );
        await Promise.all(ops);
      }
      invalidateSnippets(pid);
      await refresh();
      notify({ type: 'success', message: `Saved "${title}"` });
      closeEditor();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Save failed: ${msg}` });
    }
  }

  async function deleteSnippet(s: CardWithAttrs): Promise<void> {
    const title = readSnippetTitle(s);
    if (!window.confirm(`Delete named filter "${title}"?`)) return;
    try {
      const out = await dispatcher.request<CardDeleteInput, CardDeleteOutput>({
        endpoint: cardDelete.endpoint,
        action: cardDelete.action,
        data: { cardId: s.id },
      });
      if (!out.ok) {
        notify({ type: 'error', message: 'Delete refused.' });
        return;
      }
      invalidateSnippets(projectId);
      await refresh();
      notify({ type: 'success', message: `Deleted "${title}"` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Delete failed: ${msg}` });
    }
  }
</script>

<PageShell title="Named filters">
  {#if projectId === null}
    <EmptyState
      title="Pick a project"
      description="Named filters are scoped to a project. Pick one from the title-bar picker to manage its filters."
    />
  {:else}
    <div class="flex flex-col gap-3 p-4">
      <div class="flex items-center justify-between">
        <p class="text-sm text-muted">
          Reusable predicates for this project. Reference them from any
          screen's "Named" dropdown or from inside the Advanced filter
          editor.
        </p>
        <Button variant="primary" size="sm" onclick={openNew}>
          {#snippet children()}+ New named filter{/snippet}
        </Button>
      </div>

      {#if loading && snippets.length === 0}
        <Spinner size="md" />
      {:else if snippets.length === 0}
        <EmptyState
          title="No named filters yet"
          description="Create one to share a complex predicate across screens."
        />
      {:else}
        <ul class="flex flex-col gap-1" data-testid="admin-named-filters-list">
          {#each snippets as snip (snip.id)}
            {@const title = readSnippetTitle(snip)}
            {@const p = readSnippetPredicate(snip)}
            <li
              class="flex items-center justify-between gap-3 rounded-md border border-border bg-bg px-3 py-2"
              data-snippet-id={snip.id}
            >
              <div class="min-w-0 flex-1">
                <div class="truncate font-medium text-fg">{title}</div>
                <div class="truncate text-xs text-muted">
                  {p === null ? '(empty predicate)' : toText(p)}
                </div>
              </div>
              <Button variant="ghost" size="sm" onclick={() => openEdit(snip)}>
                {#snippet children()}Edit{/snippet}
              </Button>
              <IconButton
                aria-label="Delete named filter"
                variant="ghost"
                size="sm"
                onclick={() => void deleteSnippet(snip)}
              >
                {#snippet children()}×{/snippet}
              </IconButton>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</PageShell>

<!--
  Editor modal: a small dialog wrapping the title input + a "Edit
  predicate" button that pops the recursive FilterTreeEditor. We host
  the title separately so renaming doesn't force the user back into
  the tree editor.
-->
{#if editorOpen}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    aria-label="Edit named filter"
  >
    <div class="flex w-full max-w-lg flex-col gap-3 rounded-md border border-border bg-bg p-4 shadow-xl">
      <h2 class="text-base font-semibold">
        {editingSnippet === null ? 'New named filter' : 'Edit named filter'}
      </h2>
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-muted">Name</span>
        <TextInput bind:value={editorTitle} placeholder="e.g. Heads" />
      </label>
      <div class="flex flex-col gap-1 text-sm">
        <span class="text-muted">Predicate</span>
        <div class="rounded border border-border bg-surface/40 px-2 py-1.5 text-xs text-fg">
          {editorPredicate === null ? '(none yet — click "Edit predicate")' : toText(editorPredicate)}
        </div>
        <Button
          variant="secondary"
          size="sm"
          onclick={() => (treeEditorOpen = true)}
        >
          {#snippet children()}Edit predicate{/snippet}
        </Button>
      </div>
      <div class="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onclick={closeEditor}>
          {#snippet children()}Cancel{/snippet}
        </Button>
        <Button variant="primary" size="sm" onclick={() => void saveEditor()}>
          {#snippet children()}Save{/snippet}
        </Button>
      </div>
    </div>
  </div>
{/if}

<FilterTreeEditor
  attributes={filterAttributes}
  snippets={snippets.filter((s) => s.id !== (editingSnippet?.id ?? -1n))}
  predicate={editorPredicate}
  bind:open={treeEditorOpen}
  onSave={(p) => {
    editorPredicate = p;
    treeEditorOpen = false;
  }}
/>
