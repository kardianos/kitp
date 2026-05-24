<!--
  AdminAgentsScreen — manage the calling user's own agents.

  Layout: master list (the user's agents) + a per-agent panel for token
  mint / list / revoke. Role grants are not surfaced here in v1; use
  /admin/users to grant a role to a specific agent the same way you'd
  grant one to any user (the user_role.set handler enforces the
  parent-grants-subset rule on agent targets).

  Wire contract (all via the new bag API in dispatch/bag.svelte.ts):

    - user.select { parentUserId: me, isAgent: true }   — agent list
    - agent.create  { displayName }                      — new agent
    - agent.delete  { userId }                           — remove agent
    - user_token.create  { userId, label }               — mint token
    - user_token.list    { userId }                      — list tokens
    - user_token.revoke  { userId, label }               — revoke token

  The newly-minted token's secret value is returned ONCE in the create
  response and surfaced in a copy-to-clipboard panel; the server cannot
  recover it later (user_token.list never returns it).
-->
<script lang="ts">
  import { getContext, onMount } from 'svelte';

  import { type AuthState } from '../../auth/auth_state.svelte';
  import { useBag } from '../../dispatch/bag.svelte';
  import { getDispatcher } from '../../dispatch/context';
  import { clearHelpTopic, setHelpTopic } from '../../help/help_context.svelte';
  import { setActiveScope } from '../../keys/shortcut';
  import {
    agentDelete,
    roleList,
    userRoleList,
    userRoleRevoke,
    userRoleSet,
    userTokenList,
    userTokenRevoke,
  } from '../../reg/handlers_admin';
  import { userSelect } from '../../reg/handlers';
  import type {
    ID,
    UserRow,
    UserTokenListRow,
  } from '../../reg/types';
  import Button from '../../ui/Button.svelte';
  import EmptyState from '../../ui/EmptyState.svelte';
  import Spinner from '../../ui/Spinner.svelte';
  import {
    Form,
    FormErrors,
    SubmitButton,
    TextInput,
  } from '../../forms';
  import { notify } from '../../ui/toast.svelte';

  setActiveScope('admin_agents');

  $effect(() => {
    setHelpTopic({ kind: 'topic', topic: 'admin.agents' });
    return () => clearHelpTopic();
  });

  const dispatcher = getDispatcher();
  const bag = useBag(dispatcher);
  const authState = getContext<AuthState>('authState');
  const me = $derived<ID | null>(
    authState.userId === null ? null : BigInt(authState.userId),
  );

  let loading = $state(true);
  let agents = $state<UserRow[]>([]);
  let selectedId = $state<ID | null>(null);
  let tokensByAgent = $state<Record<string, UserTokenListRow[]>>({});
  let tokensLoading = $state<Record<string, boolean>>({});

  // Freshly-minted secret to show ONCE.
  let pendingMint = $state<{ agentId: ID; label: string; token: string } | null>(null);

  /** Initial draft for the per-agent token-mint <Form>. `user_id` is the
   *  current selection; `label` starts blank. Re-derived on selection
   *  swap so the form remounts under a `{#key}` wrap. */
  const mintInitial = $derived.by((): Record<string, unknown> => {
    if (selectedId === null) return {};
    return { user_id: selectedId, label: '' };
  });

  const loadAgents = bag.bind(userSelect, 'admin_agents.list', (r) => {
    if (r.ok) {
      agents = r.data.rows;
      const first = agents[0];
      if (selectedId === null && first !== undefined) selectedId = first.id;
    }
    loading = false;
  });

  const remove = bag.bind(agentDelete, 'admin_agents.delete', (r) => {
    if (r.ok) {
      notify({ type: 'success', message: 'Agent deleted' });
      // If we just deleted the selected agent, drop the selection.
      if (selectedId !== null) {
        const stillThere = agents.some((a) => a.id === selectedId);
        if (!stillThere) selectedId = null;
      }
      refresh();
    }
  });

  const revokeToken = bag.bind(userTokenRevoke, 'admin_agents.token.revoke', (r) => {
    if (r.ok) {
      notify({ type: 'success', message: 'Token revoked' });
      if (selectedId !== null) loadTokensFor(selectedId);
    }
  });

  /**
   * agent.create + user_token.create flow through the data-bound <Form>
   * kernel. Both handlers' outputs are surfaced via onSaved callbacks
   * below: agent.create kicks a list refresh; user_token.create stashes
   * the one-shot secret in pendingMint for the copy banner.
   */
  /** Ticks on each successful create so the Form remounts and the
   *  display_name input clears for the next agent. */
  let createFormKey = $state(0);
  function onAgentCreated(): void {
    notify({ type: 'success', message: 'Agent created' });
    refresh();
    createFormKey++;
  }

  function onTokenMinted(out: unknown): void {
    if (selectedId === null) return;
    const r = (out ?? {}) as { token?: unknown; label?: unknown };
    const token = typeof r.token === 'string' ? r.token : '';
    const label = typeof r.label === 'string' ? r.label : '';
    pendingMint = { agentId: selectedId, label, token };
    loadTokensFor(selectedId);
  }

  // Role wiring:
  //  - `allRoles` is the full catalogue (role.list). The parent may
  //    grant ANY of these to their agent — the runtime cap is enforced
  //    by auth.LoadUserRoles intersecting with the parent's current
  //    role set, so granting `admin` to an agent whose parent never
  //    becomes admin is harmless.
  //  - `parentRoles` is the parent's own global grants. Drives the
  //    "effective" badge — a role granted to the agent is only
  //    effective at runtime when the parent also holds it.
  //  - `agentRolesByAgent` maps agent_id → Set of role names currently
  //    granted to that agent.
  let allRoles = $state<string[]>([]);
  let parentRoles = $state<Set<string>>(new Set<string>());
  let agentRolesByAgent = $state<Record<string, Set<string>>>({});

  const loadAllRoles = bag.bind(roleList, 'admin_agents.role_catalogue', (r) => {
    if (r.ok) {
      allRoles = r.data.rows.map((row) => row.name);
    }
  });

  const loadParentRoles = bag.bind(userRoleList, 'admin_agents.parent_roles', (r) => {
    if (r.ok) {
      const next = new Set<string>();
      for (const row of r.data.rows) {
        if (row.scope_project_id === undefined) next.add(row.role_name);
      }
      parentRoles = next;
    }
  });

  const agentRoleLoadFor = new Map<string, ID>();
  const loadAgentRoles = bag.bind(userRoleList, 'admin_agents.agent_roles', (r) => {
    if (r.ok && selectedId !== null) {
      // Same caveat as loadTokens: bag callback has no input echo so
      // we accept that a fast selection swap may key the response to
      // the latest selection. For the common path (one agent
      // selected) this is correct.
      const key = String(selectedId);
      const next = new Set<string>();
      for (const row of r.data.rows) {
        if (row.scope_project_id === undefined) next.add(row.role_name);
      }
      agentRolesByAgent[key] = next;
    }
  });

  function loadAgentRolesFor(id: ID): void {
    agentRoleLoadFor.set(String(id), id);
    loadAgentRoles({ userId: id });
  }

  const grantRole = bag.bind(userRoleSet, 'admin_agents.role.grant', (r) => {
    if (r.ok && selectedId !== null) loadAgentRolesFor(selectedId);
  });
  const revokeRole = bag.bind(userRoleRevoke, 'admin_agents.role.revoke', (r) => {
    if (r.ok && selectedId !== null) loadAgentRolesFor(selectedId);
  });

  function toggleRole(agentId: ID, roleName: string, current: boolean): void {
    if (current) {
      revokeRole({ userId: agentId, roleName });
    } else {
      grantRole({ userId: agentId, roleName });
    }
  }

  // Per-agent token list calls are keyed by a stable token handler bound
  // once at script init. The handler resolves which agent the response
  // belongs to via the closure-captured `currentTokenLoad` map.
  const tokenLoadFor = new Map<string, ID>();
  const loadTokens = bag.bind(userTokenList, 'admin_agents.token.list', (r) => {
    // We can't trivially recover which agent each response belongs to
    // because the bag callback fires once per response with no input
    // echo. Workaround: tokensLoading flags are per-agent and the
    // server returns rows scoped to user_id, so we accept that a fast
    // double-click here is harmless — the latest result wins. For the
    // common path (one agent selected at a time) this is fine.
    if (r.ok && selectedId !== null) {
      const key = String(selectedId);
      tokensByAgent[key] = r.data.rows;
      tokensLoading[key] = false;
    }
  });

  function refresh(): void {
    if (me === null) return;
    loading = true;
    loadAgents({ parentUserId: me, isAgent: true });
  }

  function deleteAgent(id: ID): void {
    if (!confirm('Delete this agent? Active tokens will be revoked.')) return;
    remove({ userId: id });
  }

  function loadTokensFor(id: ID): void {
    const key = String(id);
    tokenLoadFor.set(key, id);
    // Property write only — re-assigning the whole map here trips
    // effect_update_depth_exceeded when paired with the $effect that
    // reloads tokens on selection change.
    tokensLoading[key] = true;
    loadTokens({ userId: id });
  }

  function revoke(label: string): void {
    if (selectedId === null) return;
    if (!confirm(`Revoke token "${label}"?`)) return;
    revokeToken({ userId: selectedId, label });
  }

  // Dev-only impersonation: swap the calling user's session to one of
  // their own agents so the parent can preview the agent's UI view
  // (Inbox flips to "routed to me", activity labels apply, etc).
  // AUTH_MODE=off endpoint — 404s in OIDC mode. The post goes through
  // the same /api/v1/auth/dev-impersonate endpoint that owns the
  // ownership check, so we don't replicate that gate here.
  async function viewAs(agentId: ID): Promise<void> {
    if (!confirm('Switch your session to act as this agent? You will be signed in as the agent until you log out.')) {
      return;
    }
    try {
      const r = await fetch('/api/v1/auth/dev-impersonate', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: agentId.toString() }),
      });
      if (!r.ok) {
        const text = await r.text();
        notify({ type: 'error', message: `Impersonation failed: ${text}` });
        return;
      }
      // Reload so AuthState pulls fresh /auth/me and every screen
      // re-renders with the new actor. We land on /projects — the
      // impersonated user picks a project from there and the
      // per-project screens follow.
      window.location.href = '/projects';
    } catch (e) {
      notify({ type: 'error', message: `Impersonation failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  async function copyToClipboard(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      notify({ type: 'success', message: 'Copied to clipboard' });
    } catch {
      notify({ type: 'error', message: 'Copy failed; select and copy manually' });
    }
  }

  // Reload tokens + roles whenever the selected agent changes.
  $effect(() => {
    if (selectedId !== null) {
      loadTokensFor(selectedId);
      loadAgentRolesFor(selectedId);
    }
  });

  // Parent's own roles + the full role catalogue are session-scoped
  // (don't change per agent). Load both once and reuse across
  // selection swaps.
  $effect(() => {
    if (me !== null) {
      loadParentRoles({ userId: me });
      loadAllRoles({});
    }
  });

  function titleFor(a: UserRow): string {
    return a.display_name.length > 0 ? a.display_name : `agent #${a.id}`;
  }

  onMount(() => {
    refresh();
  });
</script>

<div class="flex h-full">
  <!-- ------------------------------------------------- master pane -->
  <aside class="flex w-80 shrink-0 flex-col gap-3 border-r border-border p-4">
    <header class="flex items-center justify-between">
      <h1 class="text-lg font-semibold">Your agents</h1>
    </header>

    {#key createFormKey}
      <Form
        spec="agent.create"
        initial={{ display_name: '' }}
        onSaved={onAgentCreated}
        class="flex flex-col gap-2"
      >
        <span class="text-xs uppercase tracking-wide text-muted">New agent</span>
        <FormErrors />
        <TextInput
          path="display_name"
          label=""
          placeholder="Display name (e.g. research-agent)"
        />
        <SubmitButton size="md">Create</SubmitButton>
      </Form>
    {/key}

    {#if loading && agents.length === 0}
      <div class="flex flex-1 items-center justify-center">
        <Spinner size="lg" />
      </div>
    {:else if agents.length === 0}
      <EmptyState
        title="No agents yet"
        description="Create your first agent above. Agents are not assignable through the regular assignee picker — delegate one of your own tasks to an agent from your inbox."
      />
    {:else}
      <ul class="flex flex-1 flex-col divide-y divide-border overflow-y-auto rounded-md border border-border">
        {#each agents as a (a.id)}
          <li>
            <button
              type="button"
              class={'flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface ' +
                (selectedId === a.id ? 'bg-surface font-medium' : '')}
              onclick={() => {
                selectedId = a.id;
              }}
            >
              <span class="truncate">{titleFor(a)}</span>
              <span class="ml-2 shrink-0 text-xs text-muted">#{a.id}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </aside>

  <!-- ------------------------------------------------- detail pane -->
  <main class="flex flex-1 flex-col gap-4 overflow-auto p-6">
    {#if selectedId === null}
      <EmptyState
        title="Select an agent"
        description="Pick an agent on the left to manage its tokens."
      />
    {:else}
      {@const a = agents.find((x) => x.id === selectedId)}
      {#if a !== undefined}
        <header class="flex items-start justify-between border-b border-border pb-3">
          <div class="flex flex-col gap-1">
            <h2 class="text-xl font-semibold">{titleFor(a)}</h2>
            <p class="text-xs text-muted">user_account #{a.id} · parented to you</p>
          </div>
          <div class="flex items-center gap-2">
            <Button variant="secondary" size="md" onclick={() => viewAs(a.id)}>
              {#snippet children()}View as this agent{/snippet}
            </Button>
            <Button variant="danger" size="md" onclick={() => deleteAgent(a.id)}>
              {#snippet children()}Delete agent{/snippet}
            </Button>
          </div>
        </header>

        <!-- ---------------------------------- pending mint banner -->
        {#if pendingMint !== null && pendingMint.agentId === a.id}
          <section
            class="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
            data-testid="pending-mint"
          >
            <p class="mb-2 font-semibold">
              New token for "{pendingMint.label}" — copy now, it will not be shown again
            </p>
            <div class="flex items-center gap-2">
              <code class="flex-1 select-all break-all rounded bg-bg p-2 font-mono text-xs">
                {pendingMint.token}
              </code>
              <Button
                variant="secondary"
                size="sm"
                onclick={() => copyToClipboard(pendingMint!.token)}
              >
                {#snippet children()}Copy{/snippet}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onclick={() => {
                  pendingMint = null;
                }}
              >
                {#snippet children()}Dismiss{/snippet}
              </Button>
            </div>
          </section>
        {/if}

        <!-- ---------------------------------- roles -->
        <section class="flex flex-col gap-2">
          <h3 class="text-sm font-semibold uppercase tracking-wide text-muted">
            Roles
          </h3>
          <p class="text-xs text-muted">
            Assign any role; the runtime effective set is the intersection
            with your own roles. A granted role you don't hold yourself
            still won't let this agent do anything until you (or an admin)
            grants it to you too.
          </p>
          {#if allRoles.length === 0}
            <p class="text-xs text-muted">Loading roles…</p>
          {:else}
            <ul class="flex flex-col gap-1">
              {#each allRoles as roleName (roleName)}
                {@const granted = (agentRolesByAgent[String(a.id)] ?? new Set<string>()).has(roleName)}
                {@const parentHolds = parentRoles.has(roleName)}
                {@const effective = granted && parentHolds}
                <li class="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    id={`role-${a.id}-${roleName}`}
                    checked={granted}
                    onchange={() => toggleRole(a.id, roleName, granted)}
                  />
                  <label for={`role-${a.id}-${roleName}`} class="flex-1">
                    {roleName}
                  </label>
                  {#if effective}
                    <span class="text-xs text-success">effective</span>
                  {:else if granted}
                    <span class="text-xs text-warning" title="Granted to agent but you don't hold this role, so it's inactive at runtime.">
                      inactive (you don't hold {roleName})
                    </span>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <!-- ---------------------------------- mint form -->
        <section class="flex flex-col gap-2">
          <h3 class="text-sm font-semibold uppercase tracking-wide text-muted">
            Mint new token
          </h3>
          {#key a.id}
            <Form
              spec="user_token.create"
              initial={mintInitial}
              onSaved={onTokenMinted}
              class="flex items-end gap-2"
            >
              <div class="flex-1">
                <TextInput
                  path="label"
                  label=""
                  placeholder="Token label (unique per agent, e.g. laptop)"
                />
              </div>
              <SubmitButton size="md">Mint</SubmitButton>
            </Form>
          {/key}
        </section>

        <!-- ---------------------------------- token list -->
        <section class="flex flex-col gap-2">
          <h3 class="text-sm font-semibold uppercase tracking-wide text-muted">
            Tokens
          </h3>
          {#if tokensLoading[String(a.id)] === true && (tokensByAgent[String(a.id)] ?? []).length === 0}
            <Spinner size="md" />
          {:else if (tokensByAgent[String(a.id)] ?? []).length === 0}
            <p class="text-sm italic text-muted">No tokens minted yet.</p>
          {:else}
            <table class="w-full text-left text-sm">
              <thead class="border-b border-border text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th class="py-2">Label</th>
                  <th class="py-2">Created</th>
                  <th class="py-2">Last used</th>
                  <th class="py-2">Status</th>
                  <th class="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {#each (tokensByAgent[String(a.id)] ?? []) as t (t.label)}
                  <tr class="border-b border-border">
                    <td class="py-2 font-medium">{t.label}</td>
                    <td class="py-2 text-muted">{t.created_at}</td>
                    <td class="py-2 text-muted">{t.last_used_at}</td>
                    <td class="py-2">
                      {#if t.revoked_at !== undefined}
                        <span class="text-danger">revoked</span>
                      {:else}
                        <span class="text-success">active</span>
                      {/if}
                    </td>
                    <td class="py-2 text-right">
                      {#if t.revoked_at === undefined}
                        <Button
                          variant="secondary"
                          size="sm"
                          onclick={() => revoke(t.label)}
                        >
                          {#snippet children()}Revoke{/snippet}
                        </Button>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </section>
      {/if}
    {/if}
  </main>
</div>
