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

  import { getDispatcher } from '../../dispatch/context';
  import {
    AttributeSchemaCache,
    type FilterAttribute,
  } from '../../filter/attribute_schema.svelte';
  import {
    attributeUpdate,
    cardSearch,
    cardSelectWithAttributes,
    userSelect,
  } from '../../reg/handlers';
  import type {
    AttributeUpdateInput,
    AttributeUpdateOutput,
    CardSearchInput,
    CardSearchOutput,
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWithAttrs,
    UserRow,
    UserSelectInput,
    UserSelectOutput,
  } from '../../reg/types';
  import SlideOver from '../SlideOver.svelte';
  import Spinner from '../Spinner.svelte';
  import { notify } from '../toast.svelte';
  import AttributeSidePanel from './AttributeSidePanel.svelte';

  interface Props {
    open: boolean;
    cardId: number | null;
    onSaved?: () => void;
  }

  let { open = $bindable(), cardId, onSaved }: Props = $props();

  const dispatcher = getDispatcher();
  const schemaCache = new AttributeSchemaCache(dispatcher);

  let project = $state<CardWithAttrs | null>(null);
  let users = $state<readonly UserRow[]>([]);
  let loading = $state(false);
  let errorMsg = $state<string | null>(null);

  let titleDraft = $state('');
  let descDraft = $state('');
  let titleSaving = $state(false);
  let descSaving = $state(false);

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

  const refOptions = $derived.by((): Record<string, { value: unknown; label: string }[]> => {
    const out: Record<string, { value: unknown; label: string }[]> = {};
    out['assignee'] = users.map((u) => ({ value: u.id, label: u.display_name }));
    return out;
  });

  /**
   * Async loaders for ref:* attributes. `ref:user` filters the eagerly-
   * loaded `users` list in memory; every other ref type goes through
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
      if (cardType === 'user') {
        out[fa.name] = async (q: string) => {
          const needle = q.trim().toLowerCase();
          const matched = needle === ''
            ? users
            : users.filter((u) => u.display_name.toLowerCase().includes(needle));
          return matched.slice(0, 50).map((u) => ({
            value: u.id,
            label: u.display_name,
          }));
        };
      } else {
        out[fa.name] = async (q: string) => {
          const res = await dispatcher.request<CardSearchInput, CardSearchOutput>({
            endpoint: cardSearch.endpoint,
            action: cardSearch.action,
            data: { cardTypeName: cardType, query: q, limit: 50 },
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
    const fUsers = dispatcher.request<UserSelectInput, UserSelectOutput>({
      endpoint: userSelect.endpoint,
      action: userSelect.action,
      data: {},
    });
    // The card being edited IS the project — pass it as projectCardId
    // so per-project enum options are visible in pickers (migration 0020).
    const fSchema = schemaCache.load(
      cardId > 0 ? { projectCardId: cardId } : undefined,
    );
    try {
      const [pOut, uOut] = await Promise.all([fProj, fUsers]);
      await fSchema;
      const found = pOut.rows.find((r) => r.id === id) ?? null;
      project = found;
      users = uOut.rows;
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
    </div>
  {/if}
</SlideOver>
