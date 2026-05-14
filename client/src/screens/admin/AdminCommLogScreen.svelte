<!--
  AdminCommLogScreen — admin-only stream of the per-project comm_log
  ring buffer (Comm Gate 9 of email_comm_spec.md, §"Comm log admin
  area" L188).

  Three controls in the header:
    - Per-project filter (default: all projects the admin can see).
      "all" issues one comm_log.list per project and merges results.
    - Kind filter (chips for the 8 closed-set kinds; "any" clears).
    - Time-window filter (1h / 24h / 7d / custom). Default: 24h
      (matches the server's fallback when `since` is empty).

  Each row renders: time, kind chip, channel label, structured detail
  via `renderCommLogDetail` (the per-kind formatter lives in
  admin_comm_log_helpers.ts so it's testable without a DOM).

  Auto-refresh is opt-in (toggle in the header), default OFF. When ON,
  the screen refetches every AUTO_REFRESH_INTERVAL_MS.

  Wire surface (Gate 9 admin-only):
    - card.select_with_attributes  (project picker options)
    - comm_log.list                (one request per visible project)
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  import { BatchAbortedError, SubRequestError } from '../../dispatch/errors';
  import { getDispatcher } from '../../dispatch/context';
  import { setActiveScope } from '../../keys/shortcut';
  import { projectScope } from '../../shell/project_scope.svelte';
  import { projectsStore, watchProjects } from '../../shell/projects_store.svelte';
  import { commLogList } from '../../reg/handlers';
  import type {
    CommLogListInput,
    CommLogListOutput,
    CommLogRow,
    ID,
  } from '../../reg/types';
  import Button from '../../ui/Button.svelte';
  import Chip from '../../ui/Chip.svelte';
  import EmptyState from '../../ui/EmptyState.svelte';
  import Spinner from '../../ui/Spinner.svelte';
  import { cx } from '../../util/class_names';

  import {
    AUTO_REFRESH_INTERVAL_MS,
    COMM_LOG_KINDS_ORDERED,
    DEFAULT_TIME_WINDOW,
    TIME_WINDOWS,
    renderCommLogDetail,
    windowSince,
    type TimeWindowKey,
  } from './admin_comm_log_helpers';

  setActiveScope('admin_comm_log');

  const dispatcher = getDispatcher();
  // Keep the shared project cache warm so the title-bar picker has
  // entries on first paint + the "all projects" fan-out below has a
  // target list as soon as the screen loads.
  $effect(watchProjects(dispatcher));

  /* ------------------------------------------------------------------ state */

  /** Decorated row: comm_log row plus the project_id whose response carried it. */
  interface DecoratedRow extends CommLogRow {
    /** The project this row belongs to; tracked client-side because the
     *  server doesn't echo project_id in CommLogRow. */
    _project_id: ID;
  }

  let rows = $state<DecoratedRow[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  /** Project list comes from the shared store (the title-bar picker
   *  drives selection). */
  const projects = $derived(projectsStore.projects);
  /**
   * The title-bar `ProjectTitlePicker`'s "All projects" choice
   * (`projectScope.projectId === null`) doubles as the fan-out
   * trigger for this screen — we sum comm_log rows across every
   * visible project. A specific project id scopes to one fetch.
   */
  const projectFilter = $derived<ID | 'all'>(
    projectScope.projectId === null ? 'all' : projectScope.projectId,
  );
  /** '' = no kind filter. */
  let kindFilter = $state('');
  let windowKey = $state<TimeWindowKey>(DEFAULT_TIME_WINDOW);
  /** ISO timestamp (only used when windowKey === 'custom'). */
  let customSince = $state('');

  let autoRefresh = $state(false);
  let autoRefreshHandle: ReturnType<typeof setInterval> | null = null;

  /* ----------------------------------------------------------- data fetch */

  async function loadRows(): Promise<void> {
    loading = true;
    error = null;
    try {
      const since = windowSince(windowKey, new Date(), customSince);
      const targets: ID[] =
        projectFilter === 'all' ? projects.map((p) => p.id) : [projectFilter];
      if (targets.length === 0) {
        rows = [];
        loading = false;
        return;
      }
      const reqs = targets.map(async (pid) => {
        const data: CommLogListInput = { projectId: pid };
        if (kindFilter !== '') data.kind = kindFilter;
        if (since !== '') data.since = since;
        const out = await dispatcher.request<CommLogListInput, CommLogListOutput>({
          endpoint: commLogList.endpoint,
          action: commLogList.action,
          data,
        });
        return { pid, rows: out.rows };
      });
      const outs = await Promise.all(reqs);
      // Merge + sort newest first (server already sorts each request
      // independently; merging requires re-sort).
      const merged: DecoratedRow[] = outs.flatMap(({ pid, rows: rs }) =>
        rs.map((r): DecoratedRow => ({ ...r, _project_id: pid })),
      );
      merged.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      rows = merged;
    } catch (e) {
      if (e instanceof SubRequestError) error = e.message;
      else if (e instanceof BatchAbortedError) error = e.reason;
      else error = errMsg(e);
    } finally {
      loading = false;
    }
  }

  /* ------------------------------------------------------------- effects */

  // Reload whenever a filter changes — except autoRefresh (it owns its
  // own interval below).
  $effect(() => {
    // Touch each filter so the effect re-runs.
    void projectFilter;
    void kindFilter;
    void windowKey;
    void customSince;
    // Only fire once we have projects loaded (avoids a transient blank
    // request before `loadProjects` resolves).
    if (projects.length === 0 && projectFilter === 'all') return;
    void loadRows();
  });

  // Auto-refresh toggle: spec says default OFF, 10 s tick.
  $effect(() => {
    if (autoRefreshHandle !== null) {
      clearInterval(autoRefreshHandle);
      autoRefreshHandle = null;
    }
    if (autoRefresh) {
      autoRefreshHandle = setInterval(() => {
        void loadRows();
      }, AUTO_REFRESH_INTERVAL_MS);
    }
  });

  /* ----------------------------------------------------------- lifecycle */

  onMount(() => {
    void loadRows();
  });

  onDestroy(() => {
    if (autoRefreshHandle !== null) {
      clearInterval(autoRefreshHandle);
      autoRefreshHandle = null;
    }
  });

  /* ----------------------------------------------------------- helpers */

  function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  function pickKind(k: string): void {
    kindFilter = kindFilter === k ? '' : k;
  }

  function pickWindow(k: TimeWindowKey): void {
    windowKey = k;
  }

  function projectTitle(id: ID): string {
    const p = projects.find((x) => x.id === id);
    if (p === undefined) return `#${id}`;
    const t = p.attributes['title'];
    return typeof t === 'string' && t !== '' ? t : `#${id}`;
  }

  function rowChannelLabel(r: CommLogRow): string {
    if (r.channel_id === 0n) return '—';
    if (r.channel_name !== '') return r.channel_name;
    return `#${r.channel_id}`;
  }

  function rowTimeLabel(at: string): string {
    if (at === '') return '';
    // Drop the millisecond + 'Z' for compactness; show local time.
    try {
      const d = new Date(at);
      if (!Number.isNaN(d.getTime())) {
        return d.toLocaleString();
      }
    } catch {
      // fallthrough
    }
    return at;
  }
</script>

<div class="flex h-full flex-col" data-testid="admin-comm-log-screen">
  <header
    class="flex flex-col gap-3 border-b border-border px-4 py-3"
    aria-label="Comm log filters"
  >
    <div class="flex flex-wrap items-center gap-3">
      <h1 class="text-lg font-semibold">Admin · Comm log</h1>
      <span class="text-xs text-muted">{rows.length} rows</span>

      <label class="ml-auto flex items-center gap-2 text-sm text-fg">
        <input
          type="checkbox"
          bind:checked={autoRefresh}
          data-testid="comm-log-auto-refresh-toggle"
          class="h-4 w-4 rounded border-border"
        />
        <span>Auto-refresh</span>
      </label>
      <Button variant="secondary" size="sm" onclick={() => void loadRows()}>
        {#snippet children()}Refresh{/snippet}
      </Button>
    </div>

    <!-- Kind chips -->
    <div class="flex flex-wrap items-center gap-2" data-testid="comm-log-kind-chips">
      <span class="text-sm text-muted">Kind:</span>
      <button
        type="button"
        class={cx(
          'rounded-full border px-2 py-0.5 text-xs',
          kindFilter === ''
            ? 'border-accent bg-accent/10 text-accent'
            : 'border-border text-muted hover:bg-surface',
        )}
        onclick={() => (kindFilter = '')}
        data-testid="comm-log-kind-chip-any"
      >
        any
      </button>
      {#each COMM_LOG_KINDS_ORDERED as k (k)}
        <button
          type="button"
          class={cx(
            'rounded-full border px-2 py-0.5 text-xs font-mono',
            kindFilter === k
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border text-muted hover:bg-surface',
          )}
          onclick={() => pickKind(k)}
          data-testid={`comm-log-kind-chip-${k}`}
        >
          {k}
        </button>
      {/each}
    </div>

    <!-- Window chips -->
    <div
      class="flex flex-wrap items-center gap-2"
      data-testid="comm-log-window-chips"
    >
      <span class="text-sm text-muted">Window:</span>
      {#each TIME_WINDOWS as w (w.key)}
        <button
          type="button"
          class={cx(
            'rounded-full border px-2 py-0.5 text-xs',
            windowKey === w.key
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border text-muted hover:bg-surface',
          )}
          onclick={() => pickWindow(w.key)}
          data-testid={`comm-log-window-chip-${w.key}`}
        >
          {w.label}
        </button>
      {/each}
      {#if windowKey === 'custom'}
        <input
          type="text"
          bind:value={customSince}
          placeholder="ISO timestamp e.g. 2026-05-01T00:00:00Z"
          data-testid="comm-log-window-custom"
          class={cx(
            'rounded-md border border-border bg-bg px-2 py-1 text-xs',
            'text-fg placeholder:text-muted',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          )}
        />
      {/if}
    </div>
  </header>

  {#if loading && rows.length === 0}
    <div class="flex flex-1 items-center justify-center">
      <Spinner size="lg" />
    </div>
  {:else if error !== null}
    <div
      role="alert"
      class="m-4 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      Failed to load: {error}
      <button type="button" class="ml-3 underline" onclick={() => void loadRows()}>
        Retry
      </button>
    </div>
  {:else if rows.length === 0}
    <div class="flex flex-1 items-center justify-center" data-testid="comm-log-empty">
      <EmptyState
        title="No log entries"
        description="The IMAP poller and SMTP sender write here on every cycle. Configure a comm channel and ensure it has IMAP / SMTP passwords set."
      />
    </div>
  {:else}
    <div class="flex-1 overflow-auto px-4 pb-4">
      <table class="w-full text-sm" data-testid="comm-log-table">
        <thead class="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" class="py-2 pr-3">Time</th>
            <th scope="col" class="py-2 pr-3">Kind</th>
            {#if projectFilter === 'all'}
              <th scope="col" class="py-2 pr-3">Project</th>
            {/if}
            <th scope="col" class="py-2 pr-3">Channel</th>
            <th scope="col" class="py-2 pr-3">Detail</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border">
          {#each rows as r (r.id)}
            <tr data-testid="comm-log-row" data-kind={r.kind}>
              <td class="py-1.5 pr-3 font-mono text-xs text-muted">
                {rowTimeLabel(r.at)}
              </td>
              <td class="py-1.5 pr-3">
                <Chip label={r.kind} size="sm" />
              </td>
              {#if projectFilter === 'all'}
                <td class="py-1.5 pr-3 text-xs text-muted">
                  {projectTitle(r._project_id)}
                </td>
              {/if}
              <td class="py-1.5 pr-3 text-xs">{rowChannelLabel(r)}</td>
              <td class="py-1.5 pr-3 text-xs" data-testid="comm-log-detail">
                {renderCommLogDetail(r.kind, r.detail)}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
