<!--
  AdminActivitySinksScreen — admin-only authoring surface for
  activity_sink cards.

  Demonstrates the data-bound form kernel:
    - <Form> declares its handler ("activity_sink.set") and holds the
      draft + errors + submitting state.
    - Path-bound controls (TextInput, PasswordInput, Textarea) read
      values from the form context by path name (matching the
      server's JSON Schema property names — snake_case).
    - Validation comes from the schema (required, format, maxLength)
      so the screen doesn't restate it.
    - <SubmitButton> calls form.submit(); on success, onSaved fires
      and we refresh the list.

  The screen still owns its READ surface (list + status toggle) via
  direct dispatcher calls — those aren't forms.
-->
<script lang="ts">
  import { onMount } from 'svelte';

  import { getDispatcher } from '../../dispatch/context';
  import { clearHelpTopic, setHelpTopic } from '../../help/help_context.svelte';
  import { setActiveScope } from '../../keys/shortcut';
  import { projectScope } from '../../shell/project_scope.svelte';
  import {
    activitySinkList,
    activitySinkSet,
    attributeDefSelect,
    userSelect,
  } from '../../reg/handlers';
  import type {
    AttributeDefSelectInput,
    AttributeDefSelectOutput,
    ChannelStatus,
    SinkListInput,
    SinkListOutput,
    SinkRow,
    SinkSetInput,
    SinkSetOutput,
    UserRow,
    UserSelectInput,
    UserSelectOutput,
  } from '../../reg/types';
  import Button from '../../ui/Button.svelte';
  import EmptyState from '../../ui/EmptyState.svelte';
  import ErrorAlert from '../../ui/ErrorAlert.svelte';
  import PageShell from '../../ui/PageShell.svelte';
  import SlideOver from '../../ui/SlideOver.svelte';
  import Spinner from '../../ui/Spinner.svelte';
  import {
    Form,
    FormErrors,
    PasswordInput,
    SubmitButton,
    TextInput,
  } from '../../forms';
  import { notify } from '../../ui/toast.svelte';
  import { cx } from '../../util/class_names';
  import ActivityFilterEditor from './ActivityFilterEditor.svelte';
  import {
    activityPredicateFromString,
    activityPredicateToString,
    summarizeActivityPredicate,
    type ActivityPredicate,
  } from './activity_predicate';

  setActiveScope('admin_activity_sinks');

  $effect(() => {
    setHelpTopic({ kind: 'topic', topic: 'admin.activity_sinks' });
    return () => clearHelpTopic();
  });

  const dispatcher = getDispatcher();

  let sinks = $state<SinkRow[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  /** Attribute names for the visual builder's `attr_in` value picker.
   *  Loaded once on mount via `attribute_def.select` — the list is
   *  globally scoped so a project switch doesn't invalidate it. */
  let attributeNames = $state<string[]>([]);
  /** Real users for the visual builder's `actor_in` value picker.
   *  Filtered to non-agents server-side via `is_agent=false`. */
  let actorUsers = $state<UserRow[]>([]);

  const selectedProjectId = $derived(projectScope.projectId);

  // The form is parameterised by an `initial` payload the kernel
  // seeds into the draft. For create: just the project scope + the
  // single non-schema-default ("sink_kind"). For edit: hydrate from
  // the selected row, taking care to NOT round-trip the client_secret
  // (it's never returned by the list handler — must stay blank).
  let editing: SinkRow | null = $state(null);
  let formOpen = $state(false);

  /** Working copy of the activity_filter being authored in the SlideOver.
   *  Kept out of the `<Form>` draft so the visual builder doesn't have
   *  to round-trip JSON strings through a hidden field — we splice it
   *  into the submit payload via `onBeforeSubmit`. */
  let workingFilter = $state<ActivityPredicate | null>(null);
  let visualEditorOpen = $state(false);

  const formInitial = $derived.by((): Record<string, unknown> => {
    if (selectedProjectId === null) return {};
    if (editing === null) {
      return {
        project_id: selectedProjectId,
        sink_kind: 'msgraph_teams',
      };
    }
    return {
      id: editing.id,
      project_id: selectedProjectId,
      name: editing.name,
      sink_kind: editing.sink_kind || 'msgraph_teams',
      msgraph_tenant_id: editing.msgraph_tenant_id,
      msgraph_client_id: editing.msgraph_client_id,
      msgraph_team_id: editing.msgraph_team_id,
      msgraph_channel_id: editing.msgraph_channel_id,
    };
  });

  async function loadSinks(projectId: bigint): Promise<void> {
    try {
      const out = await dispatcher.request<SinkListInput, SinkListOutput>({
        endpoint: activitySinkList.endpoint,
        action: activitySinkList.action,
        data: { projectId },
      });
      if (selectedProjectId !== projectId) return;
      sinks = out.rows;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    if (selectedProjectId !== null) {
      await loadSinks(selectedProjectId);
    } else {
      sinks = [];
    }
    loading = false;
  }

  /** Load attribute names + non-agent users for the visual builder's
   *  value pickers. Both lists are globally scoped (not per project),
   *  so we fetch them once on mount. The dispatcher batches concurrent
   *  requests so this is a single round-trip. */
  async function loadBuilderInputs(): Promise<void> {
    try {
      const attrReq = dispatcher.request<
        AttributeDefSelectInput,
        AttributeDefSelectOutput
      >({
        endpoint: attributeDefSelect.endpoint,
        action: attributeDefSelect.action,
        data: {},
      });
      const userReq = dispatcher.request<UserSelectInput, UserSelectOutput>({
        endpoint: userSelect.endpoint,
        action: userSelect.action,
        data: { isAgent: false },
      });
      const [attrOut, userOut] = await Promise.all([attrReq, userReq]);
      attributeNames = attrOut.rows
        .map((r) => r.name)
        .sort((a, b) => a.localeCompare(b));
      actorUsers = userOut.rows;
    } catch (e) {
      notify({
        type: 'error',
        message: `Load filter options failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  onMount(() => {
    void refresh();
    void loadBuilderInputs();
  });

  $effect(() => {
    void selectedProjectId;
    void refresh();
  });

  function openCreate(): void {
    editing = null;
    workingFilter = null;
    formOpen = true;
  }

  function openEdit(s: SinkRow): void {
    editing = s;
    // Parse the stored JSON; if it's corrupt, surface a toast and start
    // the editor from "match everything" so the admin can rebuild from
    // a clean slate rather than confronting raw JSON.
    try {
      workingFilter = activityPredicateFromString(s.activity_filter);
    } catch (e) {
      workingFilter = null;
      notify({
        type: 'error',
        message: `Stored activity_filter could not be parsed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    formOpen = true;
  }

  function closeForm(): void {
    formOpen = false;
    editing = null;
    workingFilter = null;
  }

  function onSinkSaved(): void {
    notify({ type: 'success', message: editing !== null ? 'Sink updated' : 'Sink created' });
    closeForm();
    void refresh();
  }

  /** Splice the visually-built predicate into the form payload at submit
   *  time. `<Form transform>` runs after validation, before dispatch —
   *  the draft is a shallow copy so mutating it in place is safe. */
  function transformDraft(draft: Record<string, unknown>): Record<string, unknown> {
    draft.activity_filter = activityPredicateToString(workingFilter);
    return draft;
  }

  // Status toggle isn't a form — it's a single-field update fired
  // from a button. Direct dispatcher call.
  async function setStatus(s: SinkRow, status: ChannelStatus): Promise<void> {
    if (selectedProjectId === null) return;
    try {
      await dispatcher.request<SinkSetInput, SinkSetOutput>({
        endpoint: activitySinkSet.endpoint,
        action: activitySinkSet.action,
        data: {
          id: s.id,
          projectId: selectedProjectId,
          name: s.name,
          sinkKind: s.sink_kind || 'msgraph_teams',
          channelStatus: status,
        },
      });
      await refresh();
    } catch (e) {
      notify({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  function statusPillClass(s: ChannelStatus): string {
    if (s === 'enabled') return 'bg-success/10 text-success';
    if (s === 'disabled-admin') return 'bg-muted/10 text-muted';
    return 'bg-danger/10 text-danger';
  }

  function statusLabel(s: ChannelStatus): string {
    if (s === 'enabled') return 'Enabled';
    if (s === 'disabled-admin') return 'Paused';
    return 'Fault';
  }
</script>

<PageShell title="Admin · Activity sinks" testid="admin-activity-sinks-screen" pad="none">
  {#snippet actions()}
    <Button
      variant="primary"
      size="sm"
      onclick={openCreate}
      disabled={selectedProjectId === null}
    >
      {#snippet children()}+ New sink{/snippet}
    </Button>
  {/snippet}
  {#snippet children()}
  {#if loading && sinks.length === 0}
    <div class="flex h-full items-center justify-center"><Spinner size="lg" /></div>
  {:else if error !== null}
    <ErrorAlert class="m-4" message={`Failed to load: ${error}`} onRetry={() => void refresh()} />
  {:else if selectedProjectId === null}
    <div class="flex h-full items-center justify-center">
      <EmptyState
        title="Pick a project"
        description="Activity sinks are scoped to a project. Pick one from the header to manage its sinks."
      />
    </div>
  {:else if sinks.length === 0}
    <div class="flex h-full items-center justify-center" data-testid="activity-sinks-empty">
      <EmptyState
        title="No sinks"
        description="Click '+ New sink' to push this project's activity stream to MS Teams."
        action={{ label: '+ New sink', onClick: openCreate }}
      />
    </div>
  {:else}
    <div class="px-4 pb-4">
      <table class="w-full text-sm" data-testid="activity-sinks-table">
        <thead class="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" class="py-2 pr-3">Name</th>
            <th scope="col" class="py-2 pr-3">Kind</th>
            <th scope="col" class="py-2 pr-3">Team / Channel</th>
            <th scope="col" class="py-2 pr-3">Secret</th>
            <th scope="col" class="py-2 pr-3">Pointer</th>
            <th scope="col" class="py-2 pr-3">Last push</th>
            <th scope="col" class="py-2 pr-3">Status</th>
            <th scope="col" class="py-2 pr-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border">
          {#each sinks as s (s.id)}
            <tr data-testid="activity-sink-row" data-sink-id={s.id.toString()}>
              <td class="py-1.5 pr-3 font-medium">{s.name}</td>
              <td class="py-1.5 pr-3 text-xs text-muted">{s.sink_kind}</td>
              <td class="py-1.5 pr-3 text-xs">
                {s.msgraph_team_id || '—'} / {s.msgraph_channel_id || '—'}
              </td>
              <td class="py-1.5 pr-3 text-xs">
                <span class={cx(s.has_client_secret ? 'text-success' : 'text-muted')}>
                  {s.has_client_secret ? '✓ stored' : '— missing'}
                </span>
              </td>
              <td class="py-1.5 pr-3 text-xs">
                #{s.last_activity_id.toString()} ({s.last_pushed_count.toString()} pushed)
              </td>
              <td class="py-1.5 pr-3 text-xs text-muted">
                {s.last_pushed_at || '—'}
                {#if s.last_error !== ''}
                  <div class="text-danger" data-testid="sink-last-error">{s.last_error}</div>
                {/if}
              </td>
              <td class="py-1.5 pr-3 text-xs" data-testid="sink-status-cell">
                <span
                  class={cx(
                    'inline-block rounded px-1.5 py-0.5 text-xs font-medium',
                    statusPillClass(s.channel_status),
                  )}
                  data-sink-status={s.channel_status}
                >
                  {statusLabel(s.channel_status)}
                </span>
                {#if s.channel_status === 'disabled-fault' && s.channel_fault_reason !== ''}
                  <div class="mt-1 text-xs text-danger" data-testid="sink-fault-reason">
                    {s.channel_fault_reason}
                  </div>
                {/if}
              </td>
              <td class="py-1.5 pr-3 text-right">
                <div class="flex items-center justify-end gap-1.5">
                  {#if s.channel_status === 'enabled'}
                    <Button variant="secondary" size="sm" onclick={() => void setStatus(s, 'disabled-admin')}>
                      {#snippet children()}Pause{/snippet}
                    </Button>
                  {:else}
                    <Button variant="secondary" size="sm" onclick={() => void setStatus(s, 'enabled')}>
                      {#snippet children()}Enable{/snippet}
                    </Button>
                  {/if}
                  <Button variant="secondary" size="sm" onclick={() => openEdit(s)}>
                    {#snippet children()}Edit{/snippet}
                  </Button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
  {/snippet}
</PageShell>

<SlideOver
  bind:open={formOpen}
  title={editing !== null ? 'Edit activity sink' : 'New activity sink'}
  width="md"
  onClose={closeForm}
>
  {#snippet children()}
    <Form
      spec="activity_sink.set"
      initial={formInitial}
      transform={transformDraft}
      onSaved={onSinkSaved}
      class="flex flex-col gap-3"
    >
      <FormErrors />
      <TextInput path="name" />
      <TextInput path="msgraph_tenant_id" />
      <TextInput path="msgraph_client_id" />
      <PasswordInput
        path="msgraph_client_secret"
        caption={editing !== null ? 'leave blank to keep stored value' : undefined}
      />
      <TextInput path="msgraph_team_id" />
      <TextInput path="msgraph_channel_id" />
      <div class="flex flex-col gap-1">
        <span class="text-xs font-medium text-fg">Activity filter</span>
        <div
          class="flex items-start gap-2 rounded border border-border bg-surface/40 px-2 py-1.5"
          data-testid="activity-filter-summary"
        >
          <span class="flex-1 break-words text-xs text-muted">
            {summarizeActivityPredicate(workingFilter)}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onclick={() => (visualEditorOpen = true)}
          >
            {#snippet children()}Visual builder{/snippet}
          </Button>
        </div>
        <span class="text-[11px] text-muted">
          Restricts which activity rows are pushed downstream. Empty = push every row.
        </span>
      </div>
      <div class="mt-2 flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button variant="secondary" size="sm" onclick={closeForm}>
          {#snippet children()}Cancel{/snippet}
        </Button>
        <SubmitButton size="sm">Save</SubmitButton>
      </div>
    </Form>
  {/snippet}
</SlideOver>

<ActivityFilterEditor
  bind:open={visualEditorOpen}
  predicate={workingFilter}
  attributeNames={attributeNames}
  users={actorUsers}
  onSave={(p) => {
    workingFilter = p;
  }}
/>
