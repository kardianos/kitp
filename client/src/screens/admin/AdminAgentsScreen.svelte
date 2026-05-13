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
  import { setActiveScope } from '../../keys/shortcut';
  import {
    agentCreate,
    agentDelete,
    userTokenCreate,
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
  import { notify } from '../../ui/toast.svelte';

  setActiveScope('admin_agents');

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

  // New-agent inline form.
  let newName = $state('');

  // Per-agent token-mint form (keyed by agent.id string).
  let mintLabelByAgent = $state<Record<string, string>>({});

  // Freshly-minted secret to show ONCE.
  let pendingMint = $state<{ agentId: ID; label: string; token: string } | null>(null);

  const loadAgents = bag.bind(userSelect, 'admin_agents.list', (r) => {
    if (r.ok) {
      agents = r.data.rows;
      const first = agents[0];
      if (selectedId === null && first !== undefined) selectedId = first.id;
    }
    loading = false;
  });

  // bag.bind closes over `selectedId` etc. via the calling helpers below.
  const create = bag.bind(agentCreate, 'admin_agents.create', (r) => {
    if (r.ok) {
      notify({ type: 'success', message: `Created agent "${r.data.user_id}"` });
      newName = '';
      refresh();
    }
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

  const mintToken = bag.bind(userTokenCreate, 'admin_agents.token.create', (r) => {
    if (r.ok && selectedId !== null) {
      pendingMint = { agentId: selectedId, label: r.data.label, token: r.data.token };
      // Reset the input + reload that agent's token list. Property
      // writes on $state objects are reactive on their own — do NOT
      // do `mintLabelByAgent = { ...mintLabelByAgent }`, that read +
      // write pair re-fires any $effect that calls this code path
      // and produces a depth-exceeded loop.
      mintLabelByAgent[String(selectedId)] = '';
      loadTokensFor(selectedId);
    }
  });
  const revokeToken = bag.bind(userTokenRevoke, 'admin_agents.token.revoke', (r) => {
    if (r.ok) {
      notify({ type: 'success', message: 'Token revoked' });
      if (selectedId !== null) loadTokensFor(selectedId);
    }
  });

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

  function createAgent(): void {
    const name = newName.trim();
    if (name.length === 0) return;
    create({ displayName: name });
  }

  function deleteAgent(id: ID): void {
    if (!confirm('Delete this agent? Active tokens will be revoked.')) return;
    remove({ userId: id });
  }

  function loadTokensFor(id: ID): void {
    const key = String(id);
    tokenLoadFor.set(key, id);
    // Property write only — see comment in mintToken handler about
    // why a `tokensLoading = { ...tokensLoading }` reassignment here
    // causes effect_update_depth_exceeded.
    tokensLoading[key] = true;
    loadTokens({ userId: id });
  }

  function mint(): void {
    if (selectedId === null) return;
    const label = (mintLabelByAgent[String(selectedId)] ?? '').trim();
    if (label.length === 0) {
      notify({ type: 'error', message: 'Label is required' });
      return;
    }
    mintToken({ userId: selectedId, label });
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
      // re-renders with the new actor.
      window.location.href = '/inbox';
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

  // Reload tokens whenever the selected agent changes.
  $effect(() => {
    if (selectedId !== null) loadTokensFor(selectedId);
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

    <form
      class="flex flex-col gap-2"
      onsubmit={(e) => {
        e.preventDefault();
        createAgent();
      }}
    >
      <label for="agent-new-name" class="text-xs uppercase tracking-wide text-muted">
        New agent
      </label>
      <input
        id="agent-new-name"
        type="text"
        bind:value={newName}
        placeholder="Display name (e.g. research-agent)"
        class="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      <Button variant="primary" size="md" type="submit">
        {#snippet children()}Create{/snippet}
      </Button>
    </form>

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

        <!-- ---------------------------------- mint form -->
        <section class="flex flex-col gap-2">
          <h3 class="text-sm font-semibold uppercase tracking-wide text-muted">
            Mint new token
          </h3>
          <form
            class="flex items-center gap-2"
            onsubmit={(e) => {
              e.preventDefault();
              mint();
            }}
          >
            <input
              type="text"
              bind:value={mintLabelByAgent[String(a.id)]}
              placeholder="Token label (unique per agent, e.g. laptop)"
              class="flex-1 rounded-md border border-border bg-bg px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
            <Button variant="primary" size="md" type="submit">
              {#snippet children()}Mint{/snippet}
            </Button>
          </form>
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
