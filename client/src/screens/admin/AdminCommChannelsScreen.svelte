<!--
  AdminCommChannelsScreen — admin-only authoring surface for
  comm_channel cards (Comm Gate 9 of email_comm_spec.md).

  A `comm_channel` configures one external system (in v1: an email
  account: IMAP for inbound, SMTP for outbound). Each channel lives
  under a project; the screen surfaces a project picker in the header
  followed by the channel list and an inline form for new / edit.

  Password fields are write-only: ChannelRow surfaces the
  has_*_password booleans so the GUI can show "configured" without
  ever revealing the encrypted bytes. Leaving the password input blank
  on edit preserves the stored value (spec L94).

  Wire surface (Gate 9 admin-only):
    - card.select_with_attributes  (project picker + intake-status options)
    - comm_channel.list             (per-project channel rows)
    - comm_channel.set              (create / update; encrypts passwords)

  The create / edit form is driven by the data-bound <Form> kernel
  (src/forms). The list, status toggle buttons, and intake-status
  combobox source are still direct dispatcher reads — those are not
  forms.
-->
<script lang="ts">
  import { onMount } from 'svelte';

  import { getDispatcher } from '../../dispatch/context';
  import { clearHelpTopic, setHelpTopic } from '../../help/help_context.svelte';
  import { setActiveScope } from '../../keys/shortcut';
  import { projectScope } from '../../shell/project_scope.svelte';
  import { projectsStore, watchProjects } from '../../shell/projects_store.svelte';
  import {
    cardSelectWithAttributes,
    commChannelList,
    commChannelSet,
  } from '../../reg/handlers';
  import type {
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWithAttrs,
    ChannelListInput,
    ChannelListOutput,
    ChannelRow,
    ChannelSetInput,
    ChannelSetOutput,
    ChannelStatus,
    ID,
  } from '../../reg/types';
  import Button from '../../ui/Button.svelte';
  import EmptyState from '../../ui/EmptyState.svelte';
  import ErrorAlert from '../../ui/ErrorAlert.svelte';
  import Modal from '../../ui/Modal.svelte';
  import PageShell from '../../ui/PageShell.svelte';
  import Spinner from '../../ui/Spinner.svelte';
  import {
    Form,
    FormErrors,
    NumberInput,
    PasswordInput,
    Select,
    SubmitButton,
    TextInput,
  } from '../../forms';
  import { notify } from '../../ui/toast.svelte';
  import { cx } from '../../util/class_names';

  import {
    errMsg,
    hostPortLabel,
  } from './admin_comm_channels_helpers';

  setActiveScope('admin_comm_channels');

  $effect(() => {
    setHelpTopic({ kind: 'topic', topic: 'admin.comm_channels' });
    return () => clearHelpTopic();
  });

  const dispatcher = getDispatcher();
  // Keep the shared project cache warm so the title-bar picker has
  // entries on first paint.
  $effect(watchProjects(dispatcher));

  /* ----------------------------------------------------------------- state */

  let channels = $state<ChannelRow[]>([]);
  let statuses = $state<CardWithAttrs[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  /** The title-bar `ProjectTitlePicker` is the only project picker on
   *  this screen; `selectedProjectId` is a $derived view of the global
   *  scope so channel + status fetches re-fire when the admin picks a
   *  different project from the breadcrumb. */
  const selectedProjectId = $derived(projectScope.projectId);
  const projects = $derived(projectsStore.projects);

  /** Form open + which channel (null for create) is being edited. */
  let editing = $state<ChannelRow | null>(null);
  let formOpen = $state(false);

  /* --------------------------------------------------- derived options */

  const statusOptions = $derived<{ value: ID; label: string }[]>([
    { value: 0n, label: '(no intake status — use flow default)' },
    ...statuses.map((s) => ({
      value: s.id,
      label: typeof s.attributes['title'] === 'string'
        ? (s.attributes['title'] as string)
        : `#${s.id}`,
    })),
  ]);

  /**
   * Initial draft seed for <Form>. snake_case keys to match the
   * handler's JSON Schema. For edit, hydrate from `editing`; passwords
   * always start blank (write-only — spec L94). intake_status_id is
   * stringified so the Combobox compares correctly.
   */
  const formInitial = $derived.by((): Record<string, unknown> => {
    if (selectedProjectId === null) return {};
    if (editing === null) {
      return {
        project_id: selectedProjectId,
        channel_type: 'email',
        imap_port: 0,
        smtp_port: 0,
        imap_password: null,
        smtp_password: null,
        intake_status_id: 0n,
      };
    }
    return {
      id: editing.id,
      project_id: selectedProjectId,
      name: editing.name,
      channel_type: editing.channel_type === '' ? 'email' : editing.channel_type,
      imap_host: editing.imap_host,
      imap_port: editing.imap_port,
      imap_username: editing.imap_username,
      imap_password: null,
      smtp_host: editing.smtp_host,
      smtp_port: editing.smtp_port,
      smtp_username: editing.smtp_username,
      smtp_password: null,
      from_address: editing.from_address,
      intake_status_id: editing.intake_status_id,
    };
  });

  /* ----------------------------------------------------------- data fetch */

  async function loadChannelsFor(projectId: ID): Promise<void> {
    try {
      const out = await dispatcher.request<ChannelListInput, ChannelListOutput>({
        endpoint: commChannelList.endpoint,
        action: commChannelList.action,
        data: { projectId },
      });
      if (selectedProjectId !== projectId) return; // user switched mid-flight
      channels = out.rows;
    } catch (e) {
      error = errMsg(e);
    }
  }

  async function loadStatusesFor(projectId: ID): Promise<void> {
    try {
      const data: CardSelectWithAttributesInput = {
        cardTypeName: 'status',
        parentCardId: projectId,
        order: [{ field: 'attributes.sort_order', direction: 'ASC' }],
        limit: 500,
      };
      const out = await dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data,
      });
      if (selectedProjectId !== projectId) return;
      statuses = out.rows;
    } catch (e) {
      // Non-fatal: the picker just shows "(no intake status)".
      void e;
    }
  }

  async function loadInitial(): Promise<void> {
    loading = true;
    error = null;
    if (selectedProjectId !== null) {
      await Promise.all([
        loadChannelsFor(selectedProjectId),
        loadStatusesFor(selectedProjectId),
      ]);
    }
    loading = false;
  }

  /* ----------------------------------------------------------- effects */

  $effect(() => {
    const pid = selectedProjectId;
    if (pid === null) {
      channels = [];
      statuses = [];
      return;
    }
    void loadChannelsFor(pid);
    void loadStatusesFor(pid);
  });

  /* ----------------------------------------------------------- mutations */

  function openCreateForm(): void {
    editing = null;
    formOpen = true;
  }

  function openEditForm(row: ChannelRow): void {
    editing = row;
    formOpen = true;
  }

  function cancelForm(): void {
    formOpen = false;
    editing = null;
  }

  /** Pre-submit transform: blank password inputs become null in the wire
   *  payload, matching the server's *string convention (null = keep
   *  stored secret; "" = explicit clear). Without this the kernel would
   *  send "" and clobber rotated passwords every time an admin saves
   *  unrelated fields. Runs after validation, before dispatch. */
  function blankPasswordsToNull(draft: Record<string, unknown>): Record<string, unknown> {
    for (const key of ['imap_password', 'smtp_password']) {
      if (draft[key] === '') draft[key] = null;
    }
    return draft;
  }

  function onChannelSaved(): void {
    notify({
      type: 'success',
      message: editing !== null ? 'Channel updated' : 'Channel created',
    });
    formOpen = false;
    const wasEditing = editing !== null;
    editing = null;
    if (selectedProjectId !== null) void loadChannelsFor(selectedProjectId);
    void wasEditing;
  }

  /**
   * Send a status-only update. Used by the Enable / Disable row buttons.
   * Every other field is left undefined so the server preserves the
   * stored values (the partial-update path) — name + channel_type are
   * required by the wire so we forward the row's current values.
   *
   * The runtime owns 'disabled-fault'; the UI only sets 'enabled' or
   * 'disabled-admin'. Re-enabling a faulted channel also clears the
   * fault reason server-side (see channelFieldWrites).
   */
  async function setStatus(row: ChannelRow, next: ChannelStatus): Promise<void> {
    if (selectedProjectId === null) return;
    const input: ChannelSetInput = {
      id: row.id,
      projectId: selectedProjectId,
      name: row.name,
      channelType: row.channel_type,
      channelStatus: next,
    };
    try {
      await dispatcher.request<ChannelSetInput, ChannelSetOutput>({
        endpoint: commChannelSet.endpoint,
        action: commChannelSet.action,
        data: input,
      });
      notify({
        type: 'success',
        message: next === 'enabled' ? 'Channel enabled' : 'Channel disabled',
      });
      await loadChannelsFor(selectedProjectId);
    } catch (e) {
      notify({ type: 'error', message: `Status change failed: ${errMsg(e)}` });
    }
  }

  /** Tailwind class triplet for the status pill. Keeping color choices
   *  centralised so the three states stay visually distinct (a faulted
   *  channel must read differently from one an admin paused on purpose). */
  function statusPillClass(s: ChannelStatus): string {
    switch (s) {
      case 'enabled':
        return 'bg-success/15 text-success';
      case 'disabled-admin':
        return 'bg-muted/20 text-muted';
      case 'disabled-fault':
        return 'bg-danger/15 text-danger';
    }
  }

  function statusLabel(s: ChannelStatus): string {
    switch (s) {
      case 'enabled':
        return 'Enabled';
      case 'disabled-admin':
        return 'Disabled';
      case 'disabled-fault':
        return 'Fault';
    }
  }

  /* ----------------------------------------------------------- lifecycle */

  onMount(() => {
    void loadInitial();
  });

  /* ----------------------------------------------------------- helpers */

  function statusTitle(id: ID): string {
    if (id === 0n) return '';
    const s = statuses.find((x) => x.id === id);
    if (s === undefined) return `#${id}`;
    const t = s.attributes['title'];
    return typeof t === 'string' && t !== '' ? t : `#${id}`;
  }
</script>

<PageShell title="Admin · Comm channels" testid="admin-comm-channels-screen" pad="none">
  {#snippet actions()}
    <Button
      variant="primary"
      size="sm"
      onclick={openCreateForm}
      disabled={selectedProjectId === null}
    >
      {#snippet children()}+ New channel{/snippet}
    </Button>
  {/snippet}
  {#snippet children()}
  {#if loading && channels.length === 0 && projects.length === 0}
    <div class="flex h-full items-center justify-center">
      <Spinner size="lg" />
    </div>
  {:else if error !== null}
    <ErrorAlert
      class="m-4"
      message={`Failed to load: ${error}`}
      onRetry={() => void loadInitial()}
    />
  {:else if selectedProjectId === null}
    <div class="flex h-full items-center justify-center">
      <EmptyState
        title="Pick a project"
        description="Comm channels are scoped to a project. Pick one from the header to manage its channels."
      />
    </div>
  {:else if channels.length === 0}
    <div class="flex h-full items-center justify-center" data-testid="comm-channels-empty">
      <EmptyState
        title="No channels"
        description="Click '+ New channel' to configure the first email channel for this project."
        action={{ label: '+ New channel', onClick: openCreateForm }}
      />
    </div>
  {:else}
    <div class="px-4 pb-4">
      <table class="w-full text-sm" data-testid="comm-channels-table">
        <thead class="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" class="py-2 pr-3">Name</th>
            <th scope="col" class="py-2 pr-3">Type</th>
            <th scope="col" class="py-2 pr-3">IMAP</th>
            <th scope="col" class="py-2 pr-3">SMTP</th>
            <th scope="col" class="py-2 pr-3">From</th>
            <th scope="col" class="py-2 pr-3">Intake</th>
            <th scope="col" class="py-2 pr-3">Passwords</th>
            <th scope="col" class="py-2 pr-3">Status</th>
            <th scope="col" class="py-2 pr-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border">
          {#each channels as ch (ch.id)}
            <tr data-testid="comm-channel-row" data-channel-id={ch.id.toString()}>
              <td class="py-1.5 pr-3 font-medium">{ch.name}</td>
              <td class="py-1.5 pr-3 text-xs text-muted">{ch.channel_type}</td>
              <td class="py-1.5 pr-3 text-xs">
                {hostPortLabel(ch.imap_host, ch.imap_port) || '—'}
                {#if ch.imap_username !== ''}
                  <span class="text-muted">({ch.imap_username})</span>
                {/if}
              </td>
              <td class="py-1.5 pr-3 text-xs">
                {hostPortLabel(ch.smtp_host, ch.smtp_port) || '—'}
                {#if ch.smtp_username !== ''}
                  <span class="text-muted">({ch.smtp_username})</span>
                {/if}
              </td>
              <td class="py-1.5 pr-3 text-xs">{ch.from_address || '—'}</td>
              <td class="py-1.5 pr-3 text-xs">{statusTitle(ch.intake_status_id) || '—'}</td>
              <td class="py-1.5 pr-3 text-xs">
                <span class={cx(ch.has_imap_password ? 'text-success' : 'text-muted')}>
                  IMAP {ch.has_imap_password ? '✓' : '—'}
                </span>
                <span class="mx-1">·</span>
                <span class={cx(ch.has_smtp_password ? 'text-success' : 'text-muted')}>
                  SMTP {ch.has_smtp_password ? '✓' : '—'}
                </span>
              </td>
              <td class="py-1.5 pr-3 text-xs" data-testid="channel-status-cell">
                <span
                  class={cx(
                    'inline-block rounded px-1.5 py-0.5 text-xs font-medium',
                    statusPillClass(ch.channel_status),
                  )}
                  data-channel-status={ch.channel_status}
                >
                  {statusLabel(ch.channel_status)}
                </span>
                {#if ch.channel_status === 'disabled-fault' && ch.channel_fault_reason !== ''}
                  <div class="mt-1 text-xs text-danger" data-testid="channel-fault-reason">
                    {ch.channel_fault_reason}
                  </div>
                {/if}
              </td>
              <td class="py-1.5 pr-3 text-right">
                <div class="flex items-center justify-end gap-1.5">
                  {#if ch.channel_status === 'enabled'}
                    <Button
                      variant="secondary"
                      size="sm"
                      onclick={() => void setStatus(ch, 'disabled-admin')}
                    >
                      {#snippet children()}Disable{/snippet}
                    </Button>
                  {:else}
                    <Button
                      variant="secondary"
                      size="sm"
                      onclick={() => void setStatus(ch, 'enabled')}
                    >
                      {#snippet children()}Enable{/snippet}
                    </Button>
                  {/if}
                  <Button
                    variant="secondary"
                    size="sm"
                    onclick={() => openEditForm(ch)}
                  >
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

<!-- =================================================== Channel form modal -->
<Modal
  bind:open={formOpen}
  title={editing !== null ? 'Edit channel' : 'New channel'}
  size="md"
  onClose={cancelForm}
>
  {#snippet children()}
    <Form
      spec="comm_channel.set"
      initial={formInitial}
      onSaved={onChannelSaved}
      transform={blankPasswordsToNull}
      class="flex flex-col gap-3 text-sm text-fg"
    >
      <div data-testid="channel-form" class="flex flex-col gap-3">
        <FormErrors />
        <TextInput path="name" label="Name" />
        <TextInput
          path="channel_type"
          label="Channel type"
          caption="v1 supports email only."
          disabled
        />

        <!-- IMAP block -->
        <div class="flex flex-col gap-2 rounded border border-border p-3">
          <div class="text-xs uppercase tracking-wide text-muted">IMAP (inbound)</div>
          <div class="grid grid-cols-[2fr_1fr] gap-2">
            <TextInput path="imap_host" label="Host" placeholder="imap.example.com" />
            <NumberInput path="imap_port" label="Port" placeholder="993" />
          </div>
          <TextInput path="imap_username" label="Username" />
          <PasswordInput
            path="imap_password"
            label="Password"
            caption={editing !== null ? '(blank = keep stored)' : undefined}
            placeholder={editing !== null ? 'Leave blank to keep stored value' : ''}
          />
        </div>

        <!-- SMTP block -->
        <div class="flex flex-col gap-2 rounded border border-border p-3">
          <div class="text-xs uppercase tracking-wide text-muted">SMTP (outbound)</div>
          <div class="grid grid-cols-[2fr_1fr] gap-2">
            <TextInput path="smtp_host" label="Host" placeholder="smtp.example.com" />
            <NumberInput path="smtp_port" label="Port" placeholder="587" />
          </div>
          <TextInput path="smtp_username" label="Username" />
          <PasswordInput
            path="smtp_password"
            label="Password"
            caption={editing !== null ? '(blank = keep stored)' : undefined}
            placeholder={editing !== null ? 'Leave blank to keep stored value' : ''}
          />
        </div>

        <TextInput
          path="from_address"
          label="From address"
          placeholder="support@example.com"
        />
        <Select
          path="intake_status_id"
          label="Intake status"
          options={statusOptions}
          searchable={statusOptions.length > 8}
        />
        <div class="mt-2 flex items-center justify-end gap-2 border-t border-border pt-3">
          <Button variant="ghost" size="sm" onclick={cancelForm}>
            {#snippet children()}Cancel{/snippet}
          </Button>
          <SubmitButton size="sm">Save</SubmitButton>
        </div>
      </div>
    </Form>
  {/snippet}
</Modal>
