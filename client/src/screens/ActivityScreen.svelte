<!--
  ActivityScreen — global cross-card activity stream.

  Ports `client/lib/ui/screens/activity_screen.dart` (293 LOC) per
  SVELTE_MIGRATION_PLAN §7.7.

  Dispatcher contract (one POST per refresh, N-CLI-2):
    1. activity.select         — limit=100, cross-card mode (no card_id).
    2. user.select             — actor name resolution.
    3. card.select_with_attributes (milestone)
    4. card.select_with_attributes (component)
    5. card.select_with_attributes (tag)        — `path` attr surfaces tag names.

  Pagination:
    "Load more" issues a fresh activity.select with `before_activity_id`
    set to the oldest visible row, appending the result.

  Filters (client-side):
    - kind: multi-select Combobox of activity kinds.
    - actor: single-select Combobox populated from user.select.
    - date range: two DatePickers (from / to).

  Keyboard:
    - j/k     move row selection (within the filtered list).
    - Enter   navigate to /task/<row.card_id>.
    - f       focus the kind Combobox.
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';

  import { getDispatcher } from '../dispatch/context';
  import { BatchAbortedError, SubRequestError } from '../dispatch/errors';
  import type {
    ActivityRow,
    ActivitySelectInput,
    ActivitySelectOutput,
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    ID,
    UserSelectInput,
    UserSelectOutput,
  } from '../reg/types';
  import { setActiveScope, useShortcut } from '../keys/shortcut';
  import { navigate } from '../routing/router.svelte';

  import Button from '../ui/Button.svelte';
  import Combobox from '../ui/Combobox.svelte';
  import DatePicker from '../ui/DatePicker.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Spinner from '../ui/Spinner.svelte';
  import { notify } from '../ui/toast.svelte';
  import ActivityRowView from '../ui/widgets/ActivityRow.svelte';

  import {
    ACTIVITY_PAGE_SIZE,
    applyFilters,
    paginatePayload,
  } from './activity_helpers';

  setActiveScope('activity');
  const dispatcher = getDispatcher();

  // Canonical kind set; server emits these strings (see
  // server/internal/dom/activity/activity.go and the per-domain `Kind:`
  // constants in card/attribute/tag/comment/move_delete).
  const KIND_OPTIONS: { value: string; label: string }[] = [
    { value: 'card_create', label: 'Card created' },
    { value: 'attr_update', label: 'Attribute updated' },
    { value: 'comment', label: 'Comment' },
    { value: 'tag_apply', label: 'Tag applied' },
    { value: 'tag_remove', label: 'Tag removed' },
    { value: 'card_delete', label: 'Card deleted' },
  ];

  // ---------------------------------------------------------------------------
  // Reactive state
  // ---------------------------------------------------------------------------

  let rows = $state<ActivityRow[]>([]);
  let userNames = $state<Record<string, string>>({});
  let cardTitles = $state<Record<string, string>>({});
  let tagPaths = $state<Record<string, string>>({});
  /** Sorted user list backing the actor Combobox. */
  let userOptions = $state<{ value: ID; label: string }[]>([]);
  /** No more rows on the server beyond what we've loaded. */
  let exhausted = $state(false);

  // Filters.
  let kinds = $state<string[]>([]);
  let actorId = $state<ID | null>(null);
  let fromDate = $state<string | null>(null);
  let toDate = $state<string | null>(null);

  // UI state.
  let loading = $state(true);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  let selectedIndex = $state(0);

  // Refs for keyboard nav.
  let kindFilterEl: HTMLDivElement | null = $state(null);

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const visible = $derived(
    applyFilters(rows, { kinds, actorId, fromDate, toDate }),
  );

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  onMount(() => {
    void refresh();
  });

  /**
   * Initial load — issues all 5 sub-requests in one tick so the dispatcher
   * coalesces them into a single POST /api/v1/batch.
   */
  async function refresh(): Promise<void> {
    loading = true;
    error = null;

    const fActivity = dispatcher.request<ActivitySelectInput, ActivitySelectOutput>({
      endpoint: 'activity',
      action: 'select',
      data: { limit: ACTIVITY_PAGE_SIZE },
    });
    const fUsers = dispatcher.request<UserSelectInput, UserSelectOutput>({
      endpoint: 'user',
      action: 'select',
    });
    const fMilestones = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: 'card',
      action: 'select_with_attributes',
      data: { cardTypeName: 'milestone' },
    });
    const fComponents = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: 'card',
      action: 'select_with_attributes',
      data: { cardTypeName: 'component' },
    });
    const fTags = dispatcher.request<
      CardSelectWithAttributesInput,
      CardSelectWithAttributesOutput
    >({
      endpoint: 'card',
      action: 'select_with_attributes',
      data: { cardTypeName: 'tag' },
    });

    try {
      const [actOut, usersOut, mOut, cOut, tOut] = await Promise.all([
        fActivity,
        fUsers,
        fMilestones,
        fComponents,
        fTags,
      ]);

      rows = actOut.rows;
      exhausted = actOut.rows.length < ACTIVITY_PAGE_SIZE;

      // Build the actor-label map. For agents we render
      // "<agent_name> (agent of <parent_name>)" so activity rows make
      // sense at a glance — readers shouldn't have to memorise which
      // user ids are agents. user.select now surfaces parent_user_id +
      // is_agent on every row, so we resolve the parent in the same
      // pass without a second query.
      const uMap: Record<string, string> = {};
      const byId: Record<string, typeof usersOut.rows[number]> = {};
      for (const u of usersOut.rows) byId[u.id.toString()] = u;
      for (const u of usersOut.rows) {
        if (u.is_agent === true && u.parent_user_id !== undefined) {
          const parent = byId[u.parent_user_id.toString()];
          const parentName = parent?.display_name ?? `#${u.parent_user_id}`;
          uMap[u.id.toString()] = `${u.display_name} (agent of ${parentName})`;
        } else {
          uMap[u.id.toString()] = u.display_name;
        }
      }
      userNames = uMap;
      userOptions = usersOut.rows
        .map((u) => ({ value: u.id, label: u.display_name }))
        .sort((a, b) => a.label.localeCompare(b.label));

      // Card titles: harvest from milestones + components + tags. Tags
      // surface their `path` attribute as the display string; fall back
      // to title when path is missing.
      const titles: Record<string, string> = {};
      const tags: Record<string, string> = {};
      for (const m of mOut.rows) {
        const t = m.attributes.title;
        if (typeof t === 'string') titles[m.id.toString()] = t;
      }
      for (const c of cOut.rows) {
        const t = c.attributes.title;
        if (typeof t === 'string') titles[c.id.toString()] = t;
      }
      for (const tag of tOut.rows) {
        const p = tag.attributes.path;
        if (typeof p === 'string') {
          titles[tag.id.toString()] = p;
          tags[tag.id.toString()] = p;
        } else {
          const t = tag.attributes.title;
          if (typeof t === 'string') titles[tag.id.toString()] = t;
        }
      }
      cardTitles = titles;
      tagPaths = tags;

      selectedIndex = 0;
    } catch (e) {
      error = errorMessage(e);
    } finally {
      loading = false;
    }
  }

  /**
   * Append the next page of activity rows. Issues a single
   * `activity.select` with `before_activity_id` = oldest visible row id.
   */
  async function loadMore(): Promise<void> {
    if (loadingMore || exhausted) return;
    const oldest = rows[rows.length - 1];
    if (oldest === undefined) return;
    loadingMore = true;
    try {
      const payload = paginatePayload(oldest);
      const out = await dispatcher.request<
        ActivitySelectInput,
        ActivitySelectOutput
      >({
        endpoint: 'activity',
        action: 'select',
        data: {
          beforeActivityId: payload.before_activity_id,
          limit: payload.limit,
        },
      });
      if (out.rows.length === 0) {
        exhausted = true;
      } else {
        rows = [...rows, ...out.rows];
        if (out.rows.length < ACTIVITY_PAGE_SIZE) exhausted = true;
      }
    } catch (e) {
      notify({ type: 'error', message: `Load more failed: ${errorMessage(e)}` });
    } finally {
      loadingMore = false;
    }
  }

  function errorMessage(e: unknown): string {
    if (e instanceof SubRequestError) return e.message;
    if (e instanceof BatchAbortedError) return e.reason;
    if (e instanceof Error) return e.message;
    return String(e);
  }

  // ---------------------------------------------------------------------------
  // Selection / open
  // ---------------------------------------------------------------------------

  function clampSelection(): void {
    if (visible.length === 0) {
      selectedIndex = 0;
      return;
    }
    if (selectedIndex >= visible.length) selectedIndex = visible.length - 1;
    if (selectedIndex < 0) selectedIndex = 0;
  }

  // Re-clamp whenever the visible list shrinks below the cursor.
  $effect(() => {
    void visible.length;
    clampSelection();
  });

  function openSelected(): void {
    const r = visible[selectedIndex];
    if (r === undefined) return;
    if (r.card_id === 0n) return;
    navigate(`/task/${r.card_id}`);
  }

  function openCard(cardId: ID): void {
    if (cardId === 0n) return;
    navigate(`/task/${cardId}`);
  }

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------

  useShortcut(
    'activity',
    'j',
    () => {
      if (visible.length === 0) return;
      selectedIndex = Math.min(selectedIndex + 1, visible.length - 1);
    },
    'Move selection down',
  );
  useShortcut(
    'activity',
    'k',
    () => {
      if (visible.length === 0) return;
      selectedIndex = Math.max(selectedIndex - 1, 0);
    },
    'Move selection up',
  );
  useShortcut('activity', 'Enter', openSelected, 'Open task');
  useShortcut(
    'activity',
    'f',
    () => {
      void tick().then(() => {
        const btn = kindFilterEl?.querySelector<HTMLButtonElement>(
          'button[role="combobox"]',
        );
        btn?.focus();
      });
    },
    'Focus kind filter',
  );
</script>

<div class="flex h-full flex-col">
  <!-- Header: filters --------------------------------------------------- -->
  <header
    class="flex flex-wrap items-end gap-3 border-b border-border bg-surface px-4 py-3"
  >
    <div class="flex flex-col gap-1" bind:this={kindFilterEl}>
      <label
        class="text-[11px] font-medium uppercase tracking-wide text-muted"
        for="activity-filter-kind"
      >
        Kind
      </label>
      <div class="min-w-[14rem]">
        <Combobox
          id="activity-filter-kind"
          aria-label="Filter by kind"
          bind:value={kinds}
          options={KIND_OPTIONS}
          multiple
          placeholder="All kinds"
          onchange={(v) => {
            kinds = Array.isArray(v) ? (v as string[]) : [];
          }}
        />
      </div>
    </div>

    <div class="flex flex-col gap-1">
      <label
        class="text-[11px] font-medium uppercase tracking-wide text-muted"
        for="activity-filter-actor"
      >
        Actor
      </label>
      <div class="min-w-[12rem]">
        <Combobox
          id="activity-filter-actor"
          aria-label="Filter by actor"
          bind:value={actorId}
          options={userOptions}
          placeholder="Anyone"
          onchange={(v) => {
            actorId = typeof v === 'bigint' ? v : null;
          }}
        />
      </div>
    </div>

    <div class="flex flex-col gap-1">
      <span class="text-[11px] font-medium uppercase tracking-wide text-muted">
        From
      </span>
      <DatePicker
        bind:value={fromDate}
        aria-label="Filter from date"
        placeholder="Any time"
        onchange={(v) => {
          fromDate = v;
        }}
      />
    </div>

    <div class="flex flex-col gap-1">
      <span class="text-[11px] font-medium uppercase tracking-wide text-muted">
        To
      </span>
      <DatePicker
        bind:value={toDate}
        aria-label="Filter to date"
        placeholder="Any time"
        onchange={(v) => {
          toDate = v;
        }}
      />
    </div>

    {#if kinds.length > 0 || actorId !== null || fromDate !== null || toDate !== null}
      <Button
        variant="ghost"
        size="sm"
        onclick={() => {
          kinds = [];
          actorId = null;
          fromDate = null;
          toDate = null;
        }}
      >
        {#snippet children()}Clear filters{/snippet}
      </Button>
    {/if}
  </header>

  <!-- Body --------------------------------------------------------------- -->
  <div class="flex-1 overflow-auto">
    {#if loading && rows.length === 0}
      <div class="flex h-full items-center justify-center">
        <Spinner size="lg" />
      </div>
    {:else if error !== null}
      <div class="p-6">
        <EmptyState
          title="Failed to load activity"
          description={error}
          action={{ label: 'Retry', onClick: () => void refresh() }}
        />
      </div>
    {:else if visible.length === 0}
      <EmptyState
        title="No activity"
        description={rows.length === 0
          ? 'No activity has been recorded yet.'
          : 'No rows match the current filters.'}
      />
    {:else}
      <ul
        class="divide-y divide-border"
        aria-label="Activity stream"
        data-testid="activity-list"
      >
        {#each visible as row, i (row.id)}
          {@const cardLabel = cardTitles[row.card_id.toString()] ?? `Card #${row.card_id}`}
          <li
            class={
              'px-4 py-2 ' +
              (i === selectedIndex ? 'bg-surface' : '')
            }
            data-activity-id={row.id}
          >
            {#if row.card_id !== 0n}
              <button
                type="button"
                class="text-left text-sm font-semibold text-accent underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                onclick={() => {
                  selectedIndex = i;
                  openCard(row.card_id);
                }}
              >
                {cardLabel}
              </button>
            {/if}
            <ActivityRowView
              {row}
              {userNames}
              {cardTitles}
              {tagPaths}
              onOpenCard={openCard}
            />
          </li>
        {/each}
      </ul>

      <!-- Pagination ---------------------------------------------------- -->
      <div class="flex items-center justify-center p-4">
        {#if exhausted}
          <span class="text-xs text-muted">No more activity.</span>
        {:else}
          <Button
            variant="secondary"
            size="md"
            loading={loadingMore}
            onclick={() => void loadMore()}
          >
            {#snippet children()}Load more{/snippet}
          </Button>
        {/if}
      </div>
    {/if}
  </div>
</div>
