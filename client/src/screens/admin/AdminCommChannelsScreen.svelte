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
-->
<script lang="ts">
  import { onMount } from 'svelte';

  import { BatchAbortedError, SubRequestError } from '../../dispatch/errors';
  import { getDispatcher } from '../../dispatch/context';
  import { setActiveScope } from '../../keys/shortcut';
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
    ID,
  } from '../../reg/types';
  import Button from '../../ui/Button.svelte';
  import Combobox from '../../ui/Combobox.svelte';
  import EmptyState from '../../ui/EmptyState.svelte';
  import Modal from '../../ui/Modal.svelte';
  import Spinner from '../../ui/Spinner.svelte';
  import { notify } from '../../ui/toast.svelte';
  import { cx } from '../../util/class_names';

  import {
    channelRowToDraft,
    draftToSetInput,
    emptyChannelDraft,
    errMsg,
    hostPortLabel,
    validateChannelDraft,
    type ChannelDraft,
  } from './admin_comm_channels_helpers';

  setActiveScope('admin_comm_channels');

  const dispatcher = getDispatcher();

  /* ----------------------------------------------------------------- state */

  let projects = $state<CardWithAttrs[]>([]);
  let channels = $state<ChannelRow[]>([]);
  let statuses = $state<CardWithAttrs[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  let selectedProjectId = $state<ID | null>(null);

  /** Form draft. `formOpen` flag governs visibility (so type narrowing
   *  inside the modal snippet works — Svelte's check doesn't propagate
   *  the outer `{#if draft !== null}` into snippet children). */
  let draft = $state<ChannelDraft>(emptyChannelDraft());
  let formOpen = $state(false);
  let draftErrors = $state<Record<string, string>>({});
  let saving = $state(false);

  /* --------------------------------------------------- derived options */

  const projectOptions = $derived(
    projects.map((p) => ({
      value: p.id.toString(),
      label: typeof p.attributes['title'] === 'string'
        ? (p.attributes['title'] as string)
        : `#${p.id}`,
    })),
  );

  const statusOptions = $derived([
    { value: '0', label: '(no intake status — use flow default)' },
    ...statuses.map((s) => ({
      value: s.id.toString(),
      label: typeof s.attributes['title'] === 'string'
        ? (s.attributes['title'] as string)
        : `#${s.id}`,
    })),
  ]);

  /* ----------------------------------------------------------- data fetch */

  async function loadProjects(): Promise<void> {
    try {
      const out = await dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: { cardTypeName: 'project' },
      });
      projects = out.rows;
      // Default to the first project so the screen renders something.
      if (selectedProjectId === null && projects.length > 0) {
        const first = projects[0];
        if (first !== undefined) selectedProjectId = first.id;
      }
    } catch (e) {
      if (e instanceof SubRequestError) error = e.message;
      else if (e instanceof BatchAbortedError) error = e.reason;
      else error = errMsg(e);
    }
  }

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
    await loadProjects();
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
    draft = emptyChannelDraft();
    draftErrors = {};
    formOpen = true;
  }

  function openEditForm(row: ChannelRow): void {
    draft = channelRowToDraft(row);
    draftErrors = {};
    formOpen = true;
  }

  function cancelForm(): void {
    formOpen = false;
    draftErrors = {};
  }

  async function saveDraft(): Promise<void> {
    if (selectedProjectId === null) {
      notify({ type: 'error', message: 'Pick a project first.' });
      return;
    }
    const errors = validateChannelDraft(draft);
    if (Object.keys(errors).length > 0) {
      draftErrors = errors;
      return;
    }
    draftErrors = {};
    saving = true;
    try {
      const input: ChannelSetInput = draftToSetInput(draft, selectedProjectId);
      const out = await dispatcher.request<ChannelSetInput, ChannelSetOutput>({
        endpoint: commChannelSet.endpoint,
        action: commChannelSet.action,
        data: input,
      });
      notify({
        type: 'success',
        message: input.id === undefined
          ? `Channel created (#${out.channel_id})`
          : `Channel updated`,
      });
      formOpen = false;
      if (selectedProjectId !== null) await loadChannelsFor(selectedProjectId);
    } catch (e) {
      notify({ type: 'error', message: `Save failed: ${errMsg(e)}` });
    } finally {
      saving = false;
    }
  }

  /* ----------------------------------------------------------- lifecycle */

  onMount(() => {
    void loadInitial();
  });

  /* ----------------------------------------------------------- helpers */

  function pickProject(v: string | string[] | null): void {
    if (v === null || typeof v !== 'string') {
      selectedProjectId = null;
      return;
    }
    try {
      selectedProjectId = BigInt(v);
    } catch {
      selectedProjectId = null;
    }
  }

  function pickIntakeStatus(v: string | string[] | null): void {
    if (typeof v === 'string') draft.intakeStatusId = v;
    else draft.intakeStatusId = '0';
  }

  function statusTitle(id: ID): string {
    if (id === 0n) return '';
    const s = statuses.find((x) => x.id === id);
    if (s === undefined) return `#${id}`;
    const t = s.attributes['title'];
    return typeof t === 'string' && t !== '' ? t : `#${id}`;
  }
</script>

<div class="flex h-full flex-col" data-testid="admin-comm-channels-screen">
  <header
    class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3"
  >
    <h1 class="text-lg font-semibold">Admin · Comm channels</h1>
    <span class="ml-4 flex items-center gap-2 text-sm">
      <span class="text-muted">Project:</span>
      <span class="w-56">
        <Combobox
          aria-label="Project"
          options={projectOptions}
          value={selectedProjectId === null ? null : selectedProjectId.toString()}
          searchable={projectOptions.length > 8}
          placeholder="Pick a project…"
          onchange={pickProject}
        />
      </span>
    </span>
    <Button
      variant="primary"
      size="sm"
      onclick={openCreateForm}
      disabled={selectedProjectId === null}
    >
      {#snippet children()}+ New channel{/snippet}
    </Button>
  </header>

  {#if loading && channels.length === 0 && projects.length === 0}
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
  {:else if selectedProjectId === null}
    <div class="flex flex-1 items-center justify-center">
      <EmptyState
        title="Pick a project"
        description="Comm channels are scoped to a project. Pick one from the header to manage its channels."
      />
    </div>
  {:else if channels.length === 0}
    <div class="flex flex-1 items-center justify-center" data-testid="comm-channels-empty">
      <EmptyState
        title="No channels"
        description="Click '+ New channel' to configure the first email channel for this project."
        action={{ label: '+ New channel', onClick: openCreateForm }}
      />
    </div>
  {:else}
    <div class="flex-1 overflow-auto px-4 pb-4">
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
              <td class="py-1.5 pr-3 text-right">
                <Button
                  variant="secondary"
                  size="sm"
                  onclick={() => openEditForm(ch)}
                >
                  {#snippet children()}Edit{/snippet}
                </Button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<!-- =================================================== Channel form modal -->
<Modal
  bind:open={formOpen}
  title={draft.id !== '0' ? 'Edit channel' : 'New channel'}
  size="md"
  onClose={cancelForm}
>
  {#snippet children()}
      <div class="flex flex-col gap-3 text-sm text-fg" data-testid="channel-form">
        <!-- Name -->
        <label class="flex flex-col gap-1">
          <span class="text-xs font-medium text-muted">Name</span>
          <input
            type="text"
            bind:value={draft.name}
            data-testid="channel-form-name"
            class={cx(
              'rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            )}
          />
          {#if draftErrors.name}
            <span class="text-xs text-danger">{draftErrors.name}</span>
          {/if}
        </label>

        <!-- Channel type — locked to 'email' in v1 -->
        <label class="flex flex-col gap-1">
          <span class="text-xs font-medium text-muted">Channel type</span>
          <input
            type="text"
            bind:value={draft.channelType}
            disabled
            data-testid="channel-form-type"
            class="rounded-md border border-border bg-surface px-3 py-2 text-sm text-muted"
          />
          <span class="text-xs text-muted">v1 supports email only.</span>
        </label>

        <!-- IMAP block -->
        <fieldset class="flex flex-col gap-2 rounded-md border border-border p-3">
          <legend class="px-1 text-xs font-semibold uppercase text-muted">IMAP (inbound)</legend>
          <div class="grid grid-cols-[2fr_1fr] gap-2">
            <label class="flex flex-col gap-1">
              <span class="text-xs font-medium text-muted">Host</span>
              <input
                type="text"
                bind:value={draft.imapHost}
                placeholder="imap.example.com"
                data-testid="channel-form-imap-host"
                class="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg"
              />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-xs font-medium text-muted">Port</span>
              <input
                type="text"
                bind:value={draft.imapPort}
                placeholder="993"
                data-testid="channel-form-imap-port"
                class="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg"
              />
              {#if draftErrors.imapPort}
                <span class="text-xs text-danger">{draftErrors.imapPort}</span>
              {/if}
            </label>
          </div>
          <label class="flex flex-col gap-1">
            <span class="text-xs font-medium text-muted">Username</span>
            <input
              type="text"
              bind:value={draft.imapUsername}
              data-testid="channel-form-imap-username"
              class="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs font-medium text-muted">
              Password
              {#if draft.id !== '0'}
                <span class="ml-1 text-muted">(blank = keep stored)</span>
              {/if}
            </span>
            <input
              type="password"
              bind:value={draft.imapPassword}
              data-testid="channel-form-imap-password"
              placeholder={draft.id !== '0' ? 'Leave blank to keep stored value' : ''}
              class="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg"
            />
          </label>
        </fieldset>

        <!-- SMTP block -->
        <fieldset class="flex flex-col gap-2 rounded-md border border-border p-3">
          <legend class="px-1 text-xs font-semibold uppercase text-muted">SMTP (outbound)</legend>
          <div class="grid grid-cols-[2fr_1fr] gap-2">
            <label class="flex flex-col gap-1">
              <span class="text-xs font-medium text-muted">Host</span>
              <input
                type="text"
                bind:value={draft.smtpHost}
                placeholder="smtp.example.com"
                data-testid="channel-form-smtp-host"
                class="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg"
              />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-xs font-medium text-muted">Port</span>
              <input
                type="text"
                bind:value={draft.smtpPort}
                placeholder="587"
                data-testid="channel-form-smtp-port"
                class="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg"
              />
              {#if draftErrors.smtpPort}
                <span class="text-xs text-danger">{draftErrors.smtpPort}</span>
              {/if}
            </label>
          </div>
          <label class="flex flex-col gap-1">
            <span class="text-xs font-medium text-muted">Username</span>
            <input
              type="text"
              bind:value={draft.smtpUsername}
              data-testid="channel-form-smtp-username"
              class="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs font-medium text-muted">
              Password
              {#if draft.id !== '0'}
                <span class="ml-1 text-muted">(blank = keep stored)</span>
              {/if}
            </span>
            <input
              type="password"
              bind:value={draft.smtpPassword}
              data-testid="channel-form-smtp-password"
              placeholder={draft.id !== '0' ? 'Leave blank to keep stored value' : ''}
              class="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg"
            />
          </label>
        </fieldset>

        <!-- From + intake -->
        <label class="flex flex-col gap-1">
          <span class="text-xs font-medium text-muted">From address</span>
          <input
            type="text"
            bind:value={draft.fromAddress}
            placeholder="support@example.com"
            data-testid="channel-form-from"
            class="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs font-medium text-muted">Intake status</span>
          <Combobox
            aria-label="Intake status"
            options={statusOptions}
            value={draft.intakeStatusId}
            searchable={statusOptions.length > 8}
            onchange={pickIntakeStatus}
          />
        </label>
      </div>
  {/snippet}
  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={cancelForm}>
      {#snippet children()}Cancel{/snippet}
    </Button>
    <Button
      variant="primary"
      size="sm"
      loading={saving}
      disabled={saving}
      onclick={() => void saveDraft()}
    >
      {#snippet children()}Save{/snippet}
    </Button>
  {/snippet}
</Modal>

