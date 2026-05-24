<!--
  AddPersonDialog — admin modal for creating a new person card from
  the People screen. Picks a tier (contact / assignee / user) and
  fans out to the right server-side shape:

    - contact  → person card with person_kind='contact'
    - assignee → person card with person_kind='member'
    - user     → person card with person_kind='member' AND a fresh
                 user_account row + user_account_person link in the
                 same transaction. oidc_sub stays NULL until first
                 sign-in (pending an OIDC enhancement that attaches
                 by email when no sub matches).

  Email is required for `user` tier (it's the future OIDC match key)
  and optional otherwise. The host receives the new ids via
  `onCreated` and is expected to refetch its lists.
-->
<script lang="ts">
  import { getDispatcher } from '../../dispatch/context';
  import { personCreate } from '../../reg/handlers';
  import type {
    PersonCreateInput,
    PersonCreateOutput,
  } from '../../reg/types';
  import Button from '../../ui/Button.svelte';
  import Modal from '../../ui/Modal.svelte';
  import TextInput from '../../ui/inputs/TextInput.svelte';
  import { notify } from '../../ui/toast.svelte';
  import { cx } from '../../util/class_names';

  interface Props {
    open: boolean;
    /** Default tier the modal opens with. The host may pre-pick this
     *  from the currently-active filter chip so the most common path
     *  is one click. */
    defaultTier?: 'contact' | 'assignee' | 'user';
    /** Fired after a successful create. The host should refetch its
     *  person + user lists to surface the new row. */
    onCreated?: (out: PersonCreateOutput) => void;
  }

  let { open = $bindable(), defaultTier = 'assignee', onCreated }: Props = $props();

  const dispatcher = getDispatcher();

  let title = $state('');
  let email = $state('');
  // Initialised to the same default `defaultTier` falls back to, then
  // re-seeded from props each time the modal opens (see effect below).
  // Avoids the Svelte 5 warning about capturing a prop's initial value
  // in a $state initialiser.
  let tier = $state<'contact' | 'assignee' | 'user'>('assignee');
  let submitting = $state(false);

  // Reset on every (re)open so a previous attempt's draft doesn't
  // bleed into the next one. We also re-seed the tier from the host's
  // prop in case the user opened the dialog from a different chip.
  $effect(() => {
    if (open) {
      title = '';
      email = '';
      tier = defaultTier;
    }
  });

  const TIERS: { value: 'contact' | 'assignee' | 'user'; label: string; hint: string }[] = [
    {
      value: 'contact',
      label: 'Contact',
      hint: 'Email-only correspondent. Not assignable. Not a login.',
    },
    {
      value: 'assignee',
      label: 'Assignee',
      hint: 'Appears in assignee dropdowns. Not a login.',
    },
    {
      value: 'user',
      label: 'User',
      hint: 'Assignable AND can sign in (creates a user_account row; OIDC sub attached on first sign-in).',
    },
  ];

  const canSubmit = $derived.by(() => {
    if (submitting) return false;
    if (title.trim() === '') return false;
    if (tier === 'user' && email.trim() === '') return false;
    return true;
  });

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    submitting = true;
    try {
      const data: PersonCreateInput = {
        title: title.trim(),
        tier,
      };
      const e = email.trim();
      if (e !== '') data.email = e;
      const out = await dispatcher.request<PersonCreateInput, PersonCreateOutput>({
        endpoint: personCreate.endpoint,
        action: personCreate.action,
        data,
      });
      notify({
        type: 'success',
        message: tier === 'user'
          ? `Created ${title.trim()} as user (login pending first sign-in)`
          : `Created ${title.trim()} as ${tier}`,
      });
      open = false;
      onCreated?.(out);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Create failed: ${msg}` });
    } finally {
      submitting = false;
    }
  }
</script>

<Modal bind:open title="Add person">
  <div class="flex flex-col gap-3 text-sm">
    <label class="flex flex-col gap-1">
      <span class="text-xs uppercase tracking-wide text-muted">Name</span>
      <TextInput
        bind:value={title}
        placeholder="e.g. Alice Chen"
        aria-label="Person name"
        disabled={submitting}
      />
    </label>

    <label class="flex flex-col gap-1">
      <span class="text-xs uppercase tracking-wide text-muted">
        Email
        {#if tier === 'user'}
          <span class="text-danger">*</span>
        {:else}
          <span class="text-muted">(optional)</span>
        {/if}
      </span>
      <TextInput
        bind:value={email}
        type="email"
        placeholder="alice@example.com"
        aria-label="Email"
        disabled={submitting}
      />
    </label>

    <fieldset class="flex flex-col gap-2 rounded-md border border-border bg-surface/30 p-2">
      <legend class="px-1 text-[10px] uppercase tracking-wide text-muted">Tier</legend>
      {#each TIERS as t (t.value)}
        <label class={cx(
          'flex cursor-pointer items-start gap-2 rounded px-1 py-0.5',
          tier === t.value ? 'bg-accent/5' : '',
        )}>
          <input
            type="radio"
            name="add-person-tier"
            value={t.value}
            checked={tier === t.value}
            disabled={submitting}
            onchange={() => (tier = t.value)}
            class="mt-1"
          />
          <span class="flex flex-col">
            <span class="font-medium text-fg">{t.label}</span>
            <span class="text-[11px] text-muted">{t.hint}</span>
          </span>
        </label>
      {/each}
    </fieldset>

    {#if tier === 'user'}
      <p class="rounded-md border border-accent/30 bg-accent/5 p-2 text-[11px] text-muted">
        The user_account row is created with no OIDC subject; it gets attached
        when the named email first signs in. (Until that lands as a server
        enhancement, the row exists for assignment purposes but the actual
        sign-in path won't recognise it.)
      </p>
    {/if}

    <div class="mt-1 flex justify-end gap-2">
      <Button
        variant="ghost"
        size="sm"
        disabled={submitting}
        onclick={() => (open = false)}
      >
        {#snippet children()}Cancel{/snippet}
      </Button>
      <Button
        variant="primary"
        size="sm"
        disabled={!canSubmit}
        loading={submitting}
        onclick={() => void submit()}
      >
        {#snippet children()}Add person{/snippet}
      </Button>
    </div>
  </div>
</Modal>
