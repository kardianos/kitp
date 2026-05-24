<!--
  AdminContactsScreen.

  Manage person cards (kind ∈ {member, contact}). Contacts are
  person cards materialised from inbound emails or the comm
  recipient picker; they're invisible to assignee dropdowns until
  promoted to a member.

  Promote / demote is a one-attribute flip — `person_kind` —
  dispatched through the standard `attribute.update` handler.
  No new server endpoint needed.

  Initial-batch contract — one batch:
    1. `card.select_with_attributes` (card_type_name='person')
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { getDispatcher } from '../../dispatch/context';
  import { clearHelpTopic, setHelpTopic } from '../../help/help_context.svelte';
  import { setActiveScope } from '../../keys/shortcut';
  import {
    attributeUpdate,
    cardSelectWithAttributes,
  } from '../../reg/handlers';
  import {
    userListWithRoles,
    userUnlinkPerson,
  } from '../../reg/handlers_admin';
  import type {
    AttributeUpdateInput,
    AttributeUpdateOutput,
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWithAttrs,
    ID,
    UserListWithRolesInput,
    UserListWithRolesOutput,
    UserListWithRolesRow,
    UserUnlinkPersonInput,
    UserUnlinkPersonOutput,
  } from '../../reg/types';
  import Button from '../../ui/Button.svelte';
  import EmptyState from '../../ui/EmptyState.svelte';
  import ErrorAlert from '../../ui/ErrorAlert.svelte';
  import PageShell from '../../ui/PageShell.svelte';
  import Spinner from '../../ui/Spinner.svelte';
  import TextInput from '../../ui/inputs/TextInput.svelte';
  import { notify } from '../../ui/toast.svelte';
  import { cx } from '../../util/class_names';
  import AddPersonDialog from './AddPersonDialog.svelte';

  setActiveScope('admin_contacts');

  $effect(() => {
    setHelpTopic({ kind: 'topic', topic: 'admin.contacts' });
    return () => clearHelpTopic();
  });

  const dispatcher = getDispatcher();

  /**
   * Three explicit tiers per person card, derived from two axes:
   *   - person_kind   ∈ {member, contact}            (assignable axis)
   *   - has user link in user_account_person table   (login axis)
   *
   * Containment: user ⊆ assignee ⊆ contact. We render the higher tier
   * each card has reached, but the demote actions always step down by
   * one tier at a time so the user can't accidentally lose the login
   * link AND the assignable flag in one click.
   */
  type Tier = 'contact' | 'assignee' | 'user';
  type TierFilter = 'all' | Tier;

  let rows = $state<CardWithAttrs[]>([]);
  let users = $state<UserListWithRolesRow[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let tierFilter = $state<TierFilter>('all');
  let search = $state('');
  let pending = $state<Set<string>>(new Set());
  let addOpen = $state(false);

  function titleOf(p: CardWithAttrs): string {
    const t = p.attributes['title'];
    if (typeof t === 'string' && t.length > 0) return t;
    const e = p.attributes['email'];
    if (typeof e === 'string' && e.length > 0) return e;
    return `#${p.id}`;
  }

  function emailOf(p: CardWithAttrs): string {
    const e = p.attributes['email'];
    return typeof e === 'string' ? e : '';
  }

  function kindOf(p: CardWithAttrs): 'member' | 'contact' {
    return p.attributes['person_kind'] === 'contact' ? 'contact' : 'member';
  }

  /** person_card_id → user_account row, for the "User" tier lookup. */
  const userByPerson = $derived.by((): Map<string, UserListWithRolesRow> => {
    const m = new Map<string, UserListWithRolesRow>();
    for (const u of users) {
      if (u.person_card_id !== undefined) m.set(u.person_card_id.toString(), u);
    }
    return m;
  });

  function tierOf(p: CardWithAttrs): Tier {
    if (kindOf(p) === 'contact') return 'contact';
    if (userByPerson.has(p.id.toString())) return 'user';
    return 'assignee';
  }

  async function loadRows(): Promise<void> {
    loading = true;
    error = null;
    try {
      const personsP = dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: { cardTypeName: 'person' },
      });
      // Loading users gives us the user_account_person links — the
      // "User" tier axis. Same handler the AdminUsers screen calls.
      const usersP = dispatcher.request<
        UserListWithRolesInput,
        UserListWithRolesOutput
      >({
        endpoint: userListWithRoles.endpoint,
        action: userListWithRoles.action,
        data: {},
      });
      const [personsOut, usersOut] = await Promise.all([personsP, usersP]);
      rows = personsOut.rows;
      users = usersOut.rows;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void loadRows();
  });

  const filteredRows = $derived.by((): CardWithAttrs[] => {
    const q = search.trim().toLowerCase();
    return rows.filter((p) => {
      if (tierFilter !== 'all' && tierOf(p) !== tierFilter) return false;
      if (q === '') return true;
      return (
        titleOf(p).toLowerCase().includes(q)
        || emailOf(p).toLowerCase().includes(q)
      );
    });
  });

  const counts = $derived.by(() => {
    let contact = 0, assignee = 0, user = 0;
    for (const p of rows) {
      const t = tierOf(p);
      if (t === 'contact') contact += 1;
      else if (t === 'assignee') assignee += 1;
      else user += 1;
    }
    return { contact, assignee, user, total: rows.length };
  });

  async function setKind(p: CardWithAttrs, next: 'member' | 'contact'): Promise<void> {
    const key = p.id.toString();
    if (pending.has(key)) return;
    // Demoting an assignee to contact is fine; demoting a USER to
    // contact would orphan the login. Refuse and surface what to do
    // instead. The user has to drop the login link first.
    if (next === 'contact' && userByPerson.has(key)) {
      notify({
        type: 'error',
        message: 'Unlink the login first — this person has a user_account.',
      });
      return;
    }
    const nextPending = new Set(pending);
    nextPending.add(key);
    pending = nextPending;
    try {
      await dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
        endpoint: attributeUpdate.endpoint,
        action: attributeUpdate.action,
        data: { cardId: p.id, attributeName: 'person_kind', value: next },
      });
      notify({
        type: 'success',
        message: next === 'member'
          ? `Promoted ${titleOf(p)} to assignee`
          : `Demoted ${titleOf(p)} to contact`,
      });
      rows = rows.map((r) =>
        r.id === p.id
          ? { ...r, attributes: { ...r.attributes, person_kind: next } }
          : r,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Failed: ${msg}` });
    } finally {
      const np = new Set(pending);
      np.delete(key);
      pending = np;
    }
  }

  /**
   * Demote user → assignee: drop the user_account_person link. The
   * user_account row itself stays (their sign-in history + role
   * grants are preserved) but the person card is no longer marked as
   * "logs in as". Reload `users` afterwards so the tier flips back.
   */
  async function unlinkUser(p: CardWithAttrs): Promise<void> {
    const u = userByPerson.get(p.id.toString());
    if (u === undefined) return;
    const key = `unlink-${p.id}`;
    if (pending.has(key)) return;
    const nextPending = new Set(pending);
    nextPending.add(key);
    pending = nextPending;
    try {
      await dispatcher.request<UserUnlinkPersonInput, UserUnlinkPersonOutput>({
        endpoint: userUnlinkPerson.endpoint,
        action: userUnlinkPerson.action,
        data: { userAccountId: u.id },
      });
      notify({
        type: 'success',
        message: `Demoted ${titleOf(p)} to assignee (login retained on Admin · Users)`,
      });
      // Strip the link locally so the row flips to "assignee" without
      // a refetch round-trip. `exactOptionalPropertyTypes` rejects
      // person_card_id=undefined; rebuild the object without the key.
      users = users.map((row) => {
        if (row.id !== u.id) return row;
        const { person_card_id: _drop, ...rest } = row;
        void _drop;
        return rest;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Failed: ${msg}` });
    } finally {
      const np = new Set(pending);
      np.delete(key);
      pending = np;
    }
  }
</script>

<PageShell title="Admin · People" testid="admin-contacts-screen" pad="none">
  {#snippet actions()}
    <span class="text-xs text-muted">
      {counts.user} users · {counts.assignee} assignees · {counts.contact} contacts
    </span>
    <Button variant="primary" size="sm" onclick={() => (addOpen = true)}>
      {#snippet children()}+ Add person{/snippet}
    </Button>
    <Button variant="secondary" size="sm" onclick={() => void loadRows()}>
      {#snippet children()}Refresh{/snippet}
    </Button>
  {/snippet}
  {#snippet children()}
  <div class="flex flex-col gap-3 border-b border-border px-4 py-3">
    <!-- Tier filter chips -->
    <div class="flex flex-wrap items-center gap-2" data-testid="admin-contacts-tier-chips">
      <span class="text-sm text-muted">Tier:</span>
      {#each ['all', 'user', 'assignee', 'contact'] as const as t (t)}
        <button
          type="button"
          class={cx(
            'rounded-full border px-2 py-0.5 text-xs',
            tierFilter === t
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border text-muted hover:bg-surface',
          )}
          onclick={() => (tierFilter = t)}
          data-testid="admin-contacts-tier-chip-{t}"
        >
          {t}
          {#if t === 'user'}
            <span class="ml-1 text-[10px] opacity-70">{counts.user}</span>
          {:else if t === 'assignee'}
            <span class="ml-1 text-[10px] opacity-70">{counts.assignee}</span>
          {:else if t === 'contact'}
            <span class="ml-1 text-[10px] opacity-70">{counts.contact}</span>
          {:else}
            <span class="ml-1 text-[10px] opacity-70">{counts.total}</span>
          {/if}
        </button>
      {/each}
    </div>

    <!-- Search -->
    <div class="flex items-center gap-2">
      <TextInput
        bind:value={search}
        placeholder="Search by name or email…"
        aria-label="Search contacts"
        class="max-w-md"
      />
      <span class="text-xs text-muted">{filteredRows.length} shown</span>
    </div>
  </div>

  {#if error !== null}
    <div class="px-4 py-3">
      <ErrorAlert message={`Failed to load contacts: ${error}`} onRetry={() => void loadRows()} />
    </div>
  {/if}

  {#if loading && rows.length === 0 && error === null}
    <div class="flex flex-1 items-center justify-center py-10">
      <Spinner size="lg" />
    </div>
  {:else if filteredRows.length === 0 && error === null}
    <div class="flex flex-1 items-center justify-center py-10">
      <EmptyState
        title="No matching people"
        description={search.trim() === ''
          ? 'No person cards exist for this filter yet.'
          : 'Adjust the search or kind filter above.'}
      />
    </div>
  {:else}
    <!-- Table -->
    <div class="flex-1 overflow-auto" data-testid="admin-contacts-table">
      <table class="w-full text-sm">
        <thead class="sticky top-0 z-10 bg-surface text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th class="px-4 py-2 font-semibold">Name</th>
            <th class="px-4 py-2 font-semibold">Email</th>
            <th class="px-4 py-2 font-semibold">Tier</th>
            <th class="px-4 py-2 font-semibold">Login</th>
            <th class="px-4 py-2 font-semibold text-right">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border">
          {#each filteredRows as p (p.id)}
            {@const tier = tierOf(p)}
            {@const key = p.id.toString()}
            {@const busy = pending.has(key)}
            {@const unlinkBusy = pending.has(`unlink-${p.id}`)}
            {@const linkedUser = userByPerson.get(key)}
            <tr data-testid="admin-contacts-row" data-card-id={p.id}>
              <td class="px-4 py-1.5">
                <div class="flex flex-col">
                  <span class="text-fg">{titleOf(p)}</span>
                  <span class="font-mono text-[10px] text-muted">#{p.id}</span>
                </div>
              </td>
              <td class="px-4 py-1.5 text-muted">
                {emailOf(p) === '' ? '—' : emailOf(p)}
              </td>
              <td class="px-4 py-1.5">
                <span
                  class={cx(
                    'inline-flex h-5 items-center rounded-full border px-2 text-[10px] font-medium uppercase tracking-wide',
                    tier === 'user'
                      ? 'border-accent bg-accent/15 text-accent'
                      : tier === 'assignee'
                        ? 'border-accent/40 bg-accent/10 text-accent'
                        : 'border-border text-muted',
                  )}
                  data-testid="admin-contacts-tier-badge"
                  data-tier={tier}
                >
                  {tier}
                </span>
              </td>
              <td class="px-4 py-1.5 text-muted">
                {#if linkedUser !== undefined}
                  <span class="text-fg" title="user_account.id #{linkedUser.id}">
                    {linkedUser.display_name}
                  </span>
                {:else}
                  —
                {/if}
              </td>
              <td class="px-4 py-1.5 text-right">
                <div class="flex justify-end gap-2">
                  {#if tier === 'contact'}
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      loading={busy}
                      onclick={() => void setKind(p, 'member')}
                    >
                      {#snippet children()}Promote to assignee{/snippet}
                    </Button>
                  {:else if tier === 'assignee'}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      loading={busy}
                      onclick={() => void setKind(p, 'contact')}
                    >
                      {#snippet children()}Demote to contact{/snippet}
                    </Button>
                  {:else}
                    <!-- User tier: unlinking the login demotes one step
                         to assignee (login row stays on Admin · Users). -->
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={unlinkBusy}
                      loading={unlinkBusy}
                      onclick={() => void unlinkUser(p)}
                    >
                      {#snippet children()}Demote to assignee{/snippet}
                    </Button>
                  {/if}
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <AddPersonDialog
    bind:open={addOpen}
    defaultTier={tierFilter === 'all' ? 'assignee' : tierFilter}
    onCreated={() => void loadRows()}
  />
  {/snippet}
</PageShell>
