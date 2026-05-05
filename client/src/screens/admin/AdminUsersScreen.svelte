<!--
  AdminUsersScreen.

  Master/detail layout for managing user role assignments. Per migration
  plan §5.10:

    - Master pane (left, ~300px): search by display_name, filter by role,
      a list of users (display_name + email + role badges).
    - Detail pane (right): selected user header, table of role assignments
      with per-row "Revoke" buttons, an inline "+ Assign role" form, and
      a "CSV export" button at top-right.

  Initial-batch contract — three sub-requests fired in one render tick,
  coalesced by the Dispatcher into a single `POST /api/v1/batch`:

    1. `user.list_with_roles` — users + their role assignments.
    2. `role.list`            — role catalogue for the assign form.
    3. `card.select_with_attributes` (card_type_name='project') — used to
       label project scopes by title in both the user list and the CSV.

  Keyboard:
    - `j` / `k`  move user selection in the master list
    - `/`        focus the search input
    - `n`        open the "Assign role" form (focused on the role Combobox)

  Ports `client/lib/ui/screens/admin_users_screen.dart` (225 LOC) but
  swaps the dialog-per-user UX for an inline detail pane.
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';

  import { getDispatcher } from '../../dispatch/context';
  import { BatchAbortedError, SubRequestError } from '../../dispatch/errors';
  import { setActiveScope, useShortcut } from '../../keys/shortcut';
  import {
    cardSelectWithAttributes,
  } from '../../reg/handlers';
  import {
    roleList,
    userListWithRoles,
    userRoleRevoke,
    userRoleSet,
  } from '../../reg/handlers_admin';
  import type {
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWithAttrs,
    RoleAssignmentRow,
    RoleListInput,
    RoleListOutput,
    RoleRow,
    UserListWithRolesInput,
    UserListWithRolesOutput,
    UserListWithRolesRow,
    UserRoleRevokeInput,
    UserRoleRevokeOutput,
    UserRoleSetInput,
    UserRoleSetOutput,
  } from '../../reg/types';
  import Button from '../../ui/Button.svelte';
  import Chip from '../../ui/Chip.svelte';
  import Combobox from '../../ui/Combobox.svelte';
  import ConfirmDialog from '../../ui/ConfirmDialog.svelte';
  import EmptyState from '../../ui/EmptyState.svelte';
  import IconButton from '../../ui/IconButton.svelte';
  import Spinner from '../../ui/Spinner.svelte';
  import { notify } from '../../ui/toast.svelte';
  import { cx } from '../../util/class_names';
  import {
    applyUserFilters,
    assignRolePayload,
    buildRolesCsv,
    downloadCsv,
    scopeLabel,
  } from './admin_users_helpers';

  setActiveScope('admin_users');

  const dispatcher = getDispatcher();

  /* ---------------------------------------------------------------- state */

  let users = $state<UserListWithRolesRow[]>([]);
  let roles = $state<RoleRow[]>([]);
  let projects = $state<CardWithAttrs[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  let search = $state('');
  let roleFilter = $state<string | null>(null);
  let selectedUserId = $state<number | null>(null);

  /** Inline assign-role form state. */
  let assignRole = $state<string | null>(null);
  let assignProject = $state<number | null>(null);
  let assigning = $state(false);
  let assignFormOpen = $state(false);

  /** Confirm-dialog state for revoke. */
  let confirmOpen = $state(false);
  let pendingRevoke = $state<{ user: UserListWithRolesRow; ra: RoleAssignmentRow } | null>(null);

  let searchEl: HTMLInputElement | null = $state(null);
  let listEl: HTMLUListElement | null = $state(null);

  /* -------------------------------------------------------- initial batch */

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      const usersP = dispatcher.request<
        UserListWithRolesInput,
        UserListWithRolesOutput
      >({
        endpoint: userListWithRoles.endpoint,
        action: userListWithRoles.action,
        data: {},
      });
      const rolesP = dispatcher.request<RoleListInput, RoleListOutput>({
        endpoint: roleList.endpoint,
        action: roleList.action,
        data: {},
      });
      const projectsP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: { cardTypeName: 'project' },
      });

      const [usersOut, rolesOut, projectsOut] = await Promise.all([
        usersP,
        rolesP,
        projectsP,
      ]);
      users = usersOut.rows;
      roles = rolesOut.rows;
      projects = projectsOut.rows;
      loading = false;

      // Keep the current selection if it still exists; otherwise pick the
      // first visible user (or null if the filtered list is empty).
      if (selectedUserId !== null) {
        const stillThere = users.some((u) => u.id === selectedUserId);
        if (!stillThere) selectedUserId = null;
      }
    } catch (e) {
      if (e instanceof SubRequestError) {
        error = e.message;
      } else if (e instanceof BatchAbortedError) {
        error = e.reason;
      } else {
        error = e instanceof Error ? e.message : String(e);
      }
      loading = false;
    }
  }

  /* ---------------------------------------------------------- derived data */

  const visibleUsers = $derived<UserListWithRolesRow[]>(
    applyUserFilters(users, search, roleFilter),
  );

  /** The currently selected user, if any (resolved against the live list). */
  const selectedUser = $derived<UserListWithRolesRow | null>(
    selectedUserId === null
      ? null
      : (users.find((u) => u.id === selectedUserId) ?? null),
  );

  /** Combobox options. */
  const roleFilterOptions = $derived<{ value: string | null; label: string }[]>([
    { value: null, label: 'All roles' },
    ...roles
      .filter((r) => r.name !== 'system')
      .map((r) => ({ value: r.name, label: r.name })),
  ]);

  const roleAssignOptions = $derived<{ value: string; label: string }[]>(
    roles
      .filter((r) => r.name !== 'system')
      .map((r) => ({ value: r.name, label: r.name })),
  );

  /** Project label by id, used to render the scope chip + CSV. */
  function projectTitle(id: number): string | undefined {
    const p = projects.find((x) => x.id === id);
    if (p === undefined) return undefined;
    const t = p.attributes['title'];
    return typeof t === 'string' && t.length > 0 ? t : undefined;
  }

  const projectAssignOptions = $derived<{ value: number | null; label: string }[]>([
    { value: null, label: 'Global (no scope)' },
    ...projects.map((p) => ({
      value: p.id,
      label: projectTitle(p.id) ?? `#${p.id}`,
    })),
  ]);

  /**
   * Enrich each user's role assignments with a project title pulled from
   * the local project cache so the detail pane and the CSV both render
   * "Acme Co" instead of "project #42" when the server response did not
   * include `scope_project_title`.
   */
  function withProjectTitle(ra: RoleAssignmentRow): RoleAssignmentRow {
    if (ra.scope_project_id === undefined) return ra;
    if (ra.scope_project_title !== undefined && ra.scope_project_title !== '') {
      return ra;
    }
    const t = projectTitle(ra.scope_project_id);
    if (t === undefined) return ra;
    return { ...ra, scope_project_title: t };
  }

  /** Users with each `roles[]` entry's scope title resolved (for CSV + UI). */
  const usersForExport = $derived<UserListWithRolesRow[]>(
    users.map((u) => ({
      ...u,
      roles: u.roles.map(withProjectTitle),
    })),
  );

  /* ----------------------------------------------------- mutation: assign */

  async function doAssign(): Promise<void> {
    if (selectedUser === null) return;
    if (assignRole === null) return;
    assigning = true;
    try {
      const data: UserRoleSetInput = assignRolePayload(
        selectedUser.id,
        assignRole,
        assignProject,
      );
      await dispatcher.request<UserRoleSetInput, UserRoleSetOutput>({
        endpoint: userRoleSet.endpoint,
        action: userRoleSet.action,
        data,
      });
      notify({ type: 'success', message: 'Role assigned' });
      // Reset the form and reload.
      assignRole = null;
      assignProject = null;
      assignFormOpen = false;
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Assign failed: ${msg}` });
    } finally {
      assigning = false;
    }
  }

  /* ----------------------------------------------------- mutation: revoke */

  function askRevoke(user: UserListWithRolesRow, ra: RoleAssignmentRow): void {
    pendingRevoke = { user, ra };
    confirmOpen = true;
  }

  async function doRevoke(): Promise<void> {
    if (pendingRevoke === null) return;
    const { user, ra } = pendingRevoke;
    pendingRevoke = null;
    try {
      const data: UserRoleRevokeInput = {
        userId: user.id,
        roleName: ra.role_name,
      };
      if (ra.scope_project_id !== undefined) {
        data.scopeProjectId = ra.scope_project_id;
      }
      await dispatcher.request<UserRoleRevokeInput, UserRoleRevokeOutput>({
        endpoint: userRoleRevoke.endpoint,
        action: userRoleRevoke.action,
        data,
      });
      notify({
        type: 'success',
        message: `Revoked ${ra.role_name} from ${user.display_name}`,
      });
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Revoke failed: ${msg}` });
    }
  }

  /* ------------------------------------------------------------- CSV export */

  function exportCsv(): void {
    const csv = buildRolesCsv(usersForExport);
    downloadCsv('users-roles.csv', csv);
  }

  /* ----------------------------------------------------- keyboard helpers */

  function moveSelection(delta: number): void {
    if (visibleUsers.length === 0) {
      selectedUserId = null;
      return;
    }
    const cur = selectedUserId;
    let idx = cur === null ? -1 : visibleUsers.findIndex((u) => u.id === cur);
    if (idx < 0) {
      idx = delta > 0 ? 0 : visibleUsers.length - 1;
    } else {
      idx += delta;
      if (idx < 0) idx = 0;
      if (idx > visibleUsers.length - 1) idx = visibleUsers.length - 1;
    }
    const next = visibleUsers[idx];
    selectedUserId = next ? next.id : null;
  }

  async function focusSearch(): Promise<void> {
    await tick();
    searchEl?.focus();
    searchEl?.select();
  }

  async function openAssignForm(): Promise<void> {
    if (selectedUser === null) {
      // Pick the first visible user as a courtesy so `n` works even before
      // the operator clicks one.
      const first = visibleUsers[0];
      if (first === undefined) return;
      selectedUserId = first.id;
    }
    assignFormOpen = true;
    // Combobox focus management is internal — opening the form is enough
    // to surface it; users tab into the role picker.
    await tick();
  }

  useShortcut('admin_users', 'j', () => moveSelection(+1), 'Next user');
  useShortcut('admin_users', 'k', () => moveSelection(-1), 'Previous user');
  useShortcut('admin_users', '/', () => void focusSearch(), 'Focus search', {
    fireInInputs: false,
  });
  useShortcut('admin_users', 'n', () => void openAssignForm(), 'Assign role');

  /* ---------------------------------------------------------------- mount */

  onMount(() => {
    void refresh();
  });
</script>

<div class="flex h-full flex-col">
  <header class="flex items-center justify-between border-b border-border px-4 py-3">
    <h1 class="text-xl font-semibold">Admin · Users &amp; Roles</h1>
  </header>

  {#if loading && users.length === 0}
    <div class="flex flex-1 items-center justify-center">
      <Spinner size="lg" />
    </div>
  {:else if error !== null}
    <div
      role="alert"
      class="m-4 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      Failed to load: {error}
      <button type="button" class="ml-3 underline" onclick={() => void refresh()}>
        Retry
      </button>
    </div>
  {:else}
    <div class="flex flex-1 min-h-0">
      <!-- ============================================== Master pane -->
      <aside
        class="flex w-[300px] shrink-0 flex-col gap-2 border-r border-border p-3"
        aria-label="User list"
      >
        <input
          type="search"
          bind:this={searchEl}
          bind:value={search}
          placeholder="Search by display name… ( / )"
          aria-label="Search by display name"
          class={cx(
            'w-full rounded-md border border-border bg-bg px-3 py-1.5 text-sm',
            'text-fg placeholder:text-muted',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          )}
        />

        <div>
          <label
            for="admin-users-role-filter"
            class="mb-1 block text-xs font-medium text-muted"
          >
            Filter by role
          </label>
          <Combobox
            id="admin-users-role-filter"
            value={roleFilter}
            options={roleFilterOptions}
            placeholder="All roles"
            searchable={false}
            onchange={(v) => {
              roleFilter = v as string | null;
            }}
          />
        </div>

        <ul
          bind:this={listEl}
          class="flex-1 overflow-y-auto rounded-md border border-border"
          aria-label="Users"
        >
          {#if visibleUsers.length === 0}
            <li class="p-3 text-sm text-muted">No users match.</li>
          {:else}
            {#each visibleUsers as user (user.id)}
              {@const isSel = user.id === selectedUserId}
              <li class="border-b border-border last:border-b-0">
                <button
                  type="button"
                  class={cx(
                    'flex w-full flex-col gap-1 px-3 py-2 text-left text-sm hover:bg-surface',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                    isSel && 'bg-surface',
                  )}
                  data-user-id={user.id}
                  aria-current={isSel ? 'true' : undefined}
                  onclick={() => {
                    selectedUserId = user.id;
                  }}
                >
                  <span class="font-medium text-fg">{user.display_name}</span>
                  {#if user.email !== undefined}
                    <span class="text-xs text-muted">{user.email}</span>
                  {/if}
                  {#if user.roles.length > 0}
                    <span class="mt-1 flex flex-wrap gap-1">
                      {#each user.roles as ra (ra.role_name + '@' + (ra.scope_project_id ?? 0))}
                        <Chip
                          label={ra.scope_project_id === undefined
                            ? ra.role_name
                            : `${ra.role_name} @ ${ra.scope_project_title ?? projectTitle(ra.scope_project_id) ?? '#' + ra.scope_project_id}`}
                          variant="default"
                        />
                      {/each}
                    </span>
                  {/if}
                </button>
              </li>
            {/each}
          {/if}
        </ul>
      </aside>

      <!-- ============================================== Detail pane -->
      <section class="flex flex-1 flex-col overflow-y-auto p-4">
        {#if selectedUser === null}
          <div class="flex flex-1 items-center justify-center">
            <EmptyState
              title="Select a user"
              description="Choose a user from the list to view and manage their role assignments."
            />
          </div>
        {:else}
          <header class="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 class="text-lg font-semibold text-fg">{selectedUser.display_name}</h2>
              {#if selectedUser.email !== undefined}
                <p class="text-sm text-muted">{selectedUser.email}</p>
              {/if}
            </div>
            <Button variant="secondary" size="sm" onclick={exportCsv}>
              {#snippet children()}CSV export{/snippet}
            </Button>
          </header>

          <!-- ============================================ Roles table -->
          <h3 class="mb-2 text-sm font-semibold text-fg">Role assignments</h3>
          {#if selectedUser.roles.length === 0}
            <p class="mb-4 text-sm text-muted">No roles assigned yet.</p>
          {:else}
            <table class="mb-4 w-full text-sm">
              <thead class="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th scope="col" class="py-2 pr-3">Role</th>
                  <th scope="col" class="py-2 pr-3">Scope</th>
                  <th scope="col" class="py-2 pr-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-border">
                {#each selectedUser.roles as ra (ra.role_name + '@' + (ra.scope_project_id ?? 0))}
                  <tr>
                    <td class="py-2 pr-3 font-medium">{ra.role_name}</td>
                    <td class="py-2 pr-3">
                      <Chip
                        label={ra.scope_project_id === undefined
                          ? 'global'
                          : (ra.scope_project_title ?? projectTitle(ra.scope_project_id) ?? `project #${ra.scope_project_id}`)}
                        variant={ra.scope_project_id === undefined ? 'accent' : 'default'}
                      />
                    </td>
                    <td class="py-2 pr-3 text-right">
                      <IconButton
                        aria-label={`Revoke ${ra.role_name} from ${selectedUser.display_name}`}
                        variant="danger"
                        size="sm"
                        title="Revoke"
                        onclick={() => askRevoke(selectedUser, ra)}
                      >
                        {#snippet children()}
                          <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" aria-hidden="true">
                            <path
                              d="M3 4 L13 4 M5 4 L5 13 L11 13 L11 4 M6.5 7 L6.5 11 M9.5 7 L9.5 11 M6 4 L6 2 L10 2 L10 4"
                              stroke="currentColor"
                              stroke-width="1.4"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              fill="none"
                            />
                          </svg>
                        {/snippet}
                      </IconButton>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}

          <!-- ============================================ Assign form -->
          <div class="mt-2 rounded-md border border-border p-3">
            {#if !assignFormOpen}
              <Button
                variant="secondary"
                size="sm"
                onclick={() => {
                  assignFormOpen = true;
                }}
              >
                {#snippet children()}+ Assign role{/snippet}
              </Button>
            {:else}
              <h4 class="mb-2 text-sm font-semibold text-fg">Assign role</h4>
              <div class="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div class="flex-1">
                  <label
                    for="admin-users-assign-role"
                    class="mb-1 block text-xs font-medium text-muted"
                  >
                    Role
                  </label>
                  <Combobox
                    id="admin-users-assign-role"
                    value={assignRole}
                    options={roleAssignOptions}
                    placeholder="Pick a role"
                    onchange={(v) => {
                      assignRole = v as string | null;
                    }}
                  />
                </div>
                <div class="flex-1">
                  <label
                    for="admin-users-assign-project"
                    class="mb-1 block text-xs font-medium text-muted"
                  >
                    Scope (project)
                  </label>
                  <Combobox
                    id="admin-users-assign-project"
                    value={assignProject}
                    options={projectAssignOptions}
                    placeholder="Global (no scope)"
                    onchange={(v) => {
                      assignProject = v as number | null;
                    }}
                  />
                </div>
                <div class="flex shrink-0 gap-2">
                  <Button
                    variant="primary"
                    size="md"
                    disabled={assignRole === null || assigning}
                    loading={assigning}
                    onclick={() => void doAssign()}
                  >
                    {#snippet children()}Add{/snippet}
                  </Button>
                  <Button
                    variant="ghost"
                    size="md"
                    onclick={() => {
                      assignFormOpen = false;
                      assignRole = null;
                      assignProject = null;
                    }}
                  >
                    {#snippet children()}Cancel{/snippet}
                  </Button>
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </section>
    </div>
  {/if}
</div>

<ConfirmDialog
  bind:open={confirmOpen}
  title="Revoke role"
  message={pendingRevoke === null
    ? ''
    : `Revoke ${pendingRevoke.ra.role_name} from ${pendingRevoke.user.display_name}` +
      (pendingRevoke.ra.scope_project_id === undefined
        ? '?'
        : ` (scope: ${scopeLabel(pendingRevoke.ra)})?`)}
  confirmLabel="Revoke"
  cancelLabel="Cancel"
  danger
  onConfirm={() => void doRevoke()}
  onCancel={() => {
    pendingRevoke = null;
  }}
/>
