<script lang="ts">
  /**
   * Slide-out editor for a project card's own properties (title, description,
   * and any attribute_def bound to `project`). Self-contained: it issues its
   * own initial batch when opened and refetches after each commit so callers
   * only need to bind `open` and the `cardId` to edit.
   *
   * Title / description commit on blur or Enter (Mod+Enter for description).
   * Attributes commit through the embedded `AttributeSidePanel`.
   */

  import { getContext } from 'svelte';

  import type { AuthState } from '../../auth/auth_state.svelte';
  import { getDispatcher } from '../../dispatch/context';
  import {
    sharedSchemaCache,
    type FilterAttribute,
  } from '../../filter/attribute_schema.svelte';
  import {
    attributeUpdate,
    cardSearch,
    cardSelectWithAttributes,
  } from '../../reg/handlers';
  import ImportWizard from '../../screens/admin/ImportWizard.svelte';
  import {
    downloadProjectExportCsv,
    downloadProjectExportZip,
  } from '../../screens/admin/project_export';
  import type {
    AttributeUpdateInput,
    AttributeUpdateOutput,
    CardSearchInput,
    CardSearchOutput,
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWithAttrs,
    ID,
  } from '../../reg/types';
  import SlideOver from '../SlideOver.svelte';
  import Spinner from '../Spinner.svelte';
  import { notify } from '../toast.svelte';
  import AttributeSidePanel from './AttributeSidePanel.svelte';

  interface Props {
    open: boolean;
    cardId: ID | null;
    onSaved?: () => void;
  }

  let { open = $bindable(), cardId, onSaved }: Props = $props();

  const dispatcher = getDispatcher();
  const schemaCache = sharedSchemaCache(dispatcher);

  let project = $state<CardWithAttrs | null>(null);
  let persons = $state<readonly CardWithAttrs[]>([]);
  let loading = $state(false);
  let errorMsg = $state<string | null>(null);

  let titleDraft = $state('');
  let descDraft = $state('');
  let titleSaving = $state(false);
  let descSaving = $state(false);

  // Export state. The three checkboxes flip the endpoint's query
  // params; `exporting` disables the buttons while bytes are flowing
  // so double-clicks don't fire two requests. `includeAttachments`
  // and `includeActivity` apply only to the full-ZIP export.
  let includeDeleted = $state(false);
  let includeAttachments = $state(false);
  let includeActivity = $state(false);
  let exporting = $state(false);
  let importOpen = $state(false);

  // Auth state is provided by the App root via setContext('authState',
  // ...). We read it lazily here so test harnesses that don't wire it
  // (e.g. unit tests that mount the panel in isolation) still work.
  const authState = getContext<AuthState | undefined>('authState') ?? null;

  /** Schema for the AttributeSidePanel — defs bound to the `project` card
   *  type, minus the built-ins we render with dedicated fields above. */
  const schema = $derived.by((): FilterAttribute[] => {
    if (!schemaCache.loaded) return [];
    const out: FilterAttribute[] = [];
    for (const def of schemaCache.defs) {
      if (
        def.name === 'title' ||
        def.name === 'description' ||
        def.name === 'tags' ||
        def.name === 'sort_order'
      ) {
        continue;
      }
      const boundToProject = def.bound_to.some(
        (b) => b.card_type_name === 'project',
      );
      if (!boundToProject) continue;
      const fa = schemaCache.toFilterAttribute(def.name);
      if (fa !== null) out.push(fa);
    }
    return out;
  });

  /** Pull the person-card title (used wherever we need the display name). */
  function personLabel(p: CardWithAttrs): string {
    const t = p.attributes['title'];
    return typeof t === 'string' && t.length > 0 ? t : `#${p.id}`;
  }

  const refOptions = $derived.by((): Record<string, { value: unknown; label: string }[]> => {
    const out: Record<string, { value: unknown; label: string }[]> = {};
    // assignee is now a card_ref to a `person` card. We still pre-resolve
    // the option list here so the side-panel trigger button can render a
    // label for the currently-set value without a round-trip.
    out['assignee'] = persons.map((p) => ({ value: p.id, label: personLabel(p) }));
    return out;
  });

  /**
   * Async loaders for ref:* attributes. The `assignee` attribute is
   * special-cased: the def is a generic `card_ref` (the schema cache
   * normalises that to `ref:card` because the attribute name doesn't
   * end in `_ref`), but the picker is restricted to `person` cards by
   * convention — so we filter the eagerly-loaded `persons` list in
   * memory rather than dispatching `card.search` with an unhelpful
   * `cardTypeName='card'`. Every other `ref:<card_type>` goes through
   * `card.search` so the picker scales for large card counts.
   */
  const refLoaders = $derived.by(() => {
    const out: Record<
      string,
      (q: string) => Promise<{ value: unknown; label: string }[]>
    > = {};
    for (const fa of schema) {
      if (!fa.valueType.startsWith('ref:')) continue;
      const cardType = fa.valueType.slice('ref:'.length);
      if (fa.name === 'assignee') {
        out[fa.name] = async (q: string) => {
          const needle = q.trim().toLowerCase();
          const matched = needle === ''
            ? persons
            : persons.filter((p) => personLabel(p).toLowerCase().includes(needle));
          return matched.slice(0, 50).map((p) => ({
            value: p.id,
            label: personLabel(p),
          }));
        };
      } else {
        // Ref:* typeahead is project-scoped: the project being edited
        // IS the enclosing project, so milestones/components/tags
        // under it have parent_card_id == cardId. person refs are
        // global so we leave parent_card_id unset.
        const scopeParent =
          cardType !== 'person' && cardId !== null ? cardId : undefined;
        out[fa.name] = async (q: string) => {
          const data: CardSearchInput = { cardTypeName: cardType, query: q, limit: 50 };
          if (scopeParent !== undefined) data.parentCardId = scopeParent;
          const res = await dispatcher.request<CardSearchInput, CardSearchOutput>({
            endpoint: cardSearch.endpoint,
            action: cardSearch.action,
            data,
          });
          return res.rows.map((r) => ({ value: r.id, label: r.title }));
        };
      }
    }
    return out;
  });

  /** Refetch the project + ref tables. Issues a single coalesced batch. */
  async function refresh(): Promise<void> {
    if (cardId === null) return;
    loading = true;
    errorMsg = null;
    const id = cardId;
    const fProj = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: { cardTypeName: 'project' },
    });
    const fPersons = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: cardSelectWithAttributes.endpoint,
      action: cardSelectWithAttributes.action,
      data: { cardTypeName: 'person' },
    });
    const fSchema = schemaCache.load();
    try {
      const [pOut, personsOut] = await Promise.all([fProj, fPersons]);
      await fSchema;
      const found = pOut.rows.find((r) => r.id === id) ?? null;
      project = found;
      persons = personsOut.rows;
      if (found !== null) {
        const t = found.attributes['title'];
        const d = found.attributes['description'];
        titleDraft = typeof t === 'string' ? t : '';
        descDraft = typeof d === 'string' ? d : '';
      }
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  // Reload whenever we're opened against a (possibly different) project.
  $effect(() => {
    if (open && cardId !== null) {
      void refresh();
    } else if (!open) {
      project = null;
      titleDraft = '';
      descDraft = '';
      errorMsg = null;
    }
  });

  async function commitTitle(): Promise<void> {
    if (project === null || cardId === null || titleSaving) return;
    const next = titleDraft.trim();
    const cur = project.attributes['title'];
    const curStr = typeof cur === 'string' ? cur : '';
    if (next === '' || next === curStr) return;
    titleSaving = true;
    try {
      await dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
        endpoint: attributeUpdate.endpoint,
        action: attributeUpdate.action,
        data: { cardId, attributeName: 'title', value: next },
      });
      notify({ type: 'success', message: 'Title saved' });
      await refresh();
      onSaved?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: msg.length > 0 ? msg : 'Failed to save title' });
    } finally {
      titleSaving = false;
    }
  }

  async function commitDescription(): Promise<void> {
    if (project === null || cardId === null || descSaving) return;
    const next = descDraft;
    const cur = project.attributes['description'];
    const curStr = typeof cur === 'string' ? cur : '';
    if (next === curStr) return;
    descSaving = true;
    try {
      await dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
        endpoint: attributeUpdate.endpoint,
        action: attributeUpdate.action,
        data: { cardId, attributeName: 'description', value: next },
      });
      notify({ type: 'success', message: 'Description saved' });
      await refresh();
      onSaved?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: msg.length > 0 ? msg : 'Failed to save description' });
    } finally {
      descSaving = false;
    }
  }

  function onTitleKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.currentTarget as HTMLInputElement).blur();
    }
  }

  function onDescKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      (e.currentTarget as HTMLTextAreaElement).blur();
    }
  }

  function onAttributeChanged(): void {
    notify({ type: 'success', message: 'Saved' });
    void refresh().then(() => onSaved?.());
  }

  /**
   * Trigger a browser download of this project's CSV export. The
   * helper handles fetch + Authorization + anchor click; we only own
   * the loading/error UX here.
   */
  async function onExportClick(): Promise<void> {
    if (cardId === null || exporting) return;
    exporting = true;
    try {
      await downloadProjectExportCsv({
        projectId: cardId,
        includeDeleted,
        authState,
      });
      notify({ type: 'success', message: 'Export started' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: msg.length > 0 ? msg : 'Export failed' });
    } finally {
      exporting = false;
    }
  }

  /**
   * Trigger a browser download of the full-ZIP export. The two extra
   * checkboxes (includeAttachments / includeActivity) decide whether
   * the server bundles attachment bytes and the activity stream.
   */
  async function onExportFullClick(): Promise<void> {
    if (cardId === null || exporting) return;
    exporting = true;
    try {
      await downloadProjectExportZip({
        projectId: cardId,
        includeDeleted,
        includeAttachments,
        includeActivity,
        authState,
      });
      notify({ type: 'success', message: 'Export started' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: msg.length > 0 ? msg : 'Export failed' });
    } finally {
      exporting = false;
    }
  }
</script>

<SlideOver bind:open title="Project properties" width="md">
  {#if loading && project === null}
    <div class="flex items-center justify-center py-8" aria-live="polite">
      <Spinner size="md" />
    </div>
  {:else if errorMsg !== null}
    <div
      role="alert"
      class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      Failed to load: {errorMsg}
    </div>
  {:else if project === null}
    <p class="text-sm text-muted">Project not found.</p>
  {:else}
    <div class="flex flex-col gap-4">
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-xs font-semibold uppercase tracking-wide text-muted">Title</span>
        <input
          type="text"
          bind:value={titleDraft}
          disabled={titleSaving}
          aria-label="Project title"
          class="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onkeydown={onTitleKey}
          onblur={() => void commitTitle()}
        />
      </label>

      <label class="flex flex-col gap-1 text-sm">
        <span class="text-xs font-semibold uppercase tracking-wide text-muted">Description</span>
        <textarea
          bind:value={descDraft}
          rows="5"
          disabled={descSaving}
          aria-label="Project description"
          placeholder="Add a description… (Mod+Enter to save)"
          class="resize-y rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onkeydown={onDescKey}
          onblur={() => void commitDescription()}
        ></textarea>
      </label>

      <AttributeSidePanel
        cardId={project.id}
        attributes={project.attributes}
        {schema}
        {refOptions}
        {refLoaders}
        onChanged={onAttributeChanged}
      />

      <section class="flex flex-col gap-2 border-t border-border pt-4">
        <span class="text-xs font-semibold uppercase tracking-wide text-muted">Export</span>
        <label class="flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            bind:checked={includeDeleted}
            class="h-4 w-4 rounded border-border accent-accent"
          />
          Include deleted tasks
        </label>
        <label class="flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            bind:checked={includeAttachments}
            class="h-4 w-4 rounded border-border accent-accent"
          />
          Include attachments <span class="text-muted">(full export only)</span>
        </label>
        <label class="flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            bind:checked={includeActivity}
            class="h-4 w-4 rounded border-border accent-accent"
          />
          Include activity log <span class="text-muted">(full export only)</span>
        </label>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={exporting}
            onclick={() => void onExportClick()}
            class="rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg hover:bg-bg-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
          <button
            type="button"
            disabled={exporting}
            onclick={() => void onExportFullClick()}
            class="rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg hover:bg-bg-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
          >
            {exporting ? 'Exporting…' : 'Export full (ZIP)'}
          </button>
          <button
            type="button"
            onclick={() => (importOpen = true)}
            class="rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg hover:bg-bg-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Import CSV…
          </button>
        </div>
      </section>
    </div>
  {/if}
</SlideOver>

<ImportWizard bind:open={importOpen} projectId={cardId} />
