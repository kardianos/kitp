<!--
  GateStrip.

  Shows the *effective* gates on a parent card: private (sub-cards
  under the parent) plus inherited (gates on cards referenced via
  propagating attributes such as milestone_ref). Server returns the
  union via gate.list_effective; this widget renders both populations
  with a visual cue distinguishing them.

  Approving an inherited gate flips it for every referrer; the click
  handler surfaces a confirm via the source-card link rather than
  approving in place.
-->
<script lang="ts">
  import { getDispatcher } from '../../dispatch/context';
  import { attributeUpdate } from '../../reg/handlers';
  import { gateListEffective } from '../../reg/handlers_admin';
  import type {
    AttributeUpdateInput,
    AttributeUpdateOutput,
    EffectiveGateRow,
    GateListEffectiveInput,
    GateListEffectiveOutput,
  } from '../../reg/types';
  import { notify } from '../toast.svelte';
  import { cx } from '../../util/class_names';

  let { parentCardId, onChanged }: {
    parentCardId: number;
    onChanged?: () => void;
  } = $props();

  const dispatcher = getDispatcher();

  let gates = $state<EffectiveGateRow[]>([]);
  let loading = $state(false);

  $effect(() => {
    if (parentCardId > 0) void load();
  });

  async function load(): Promise<void> {
    loading = true;
    try {
      const out = await dispatcher.request<
        GateListEffectiveInput,
        GateListEffectiveOutput
      >({
        endpoint: gateListEffective.endpoint,
        action: gateListEffective.action,
        data: { cardId: parentCardId },
      });
      gates = out.rows;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Load gates failed: ${msg}` });
    } finally {
      loading = false;
    }
  }

  async function setStatus(g: EffectiveGateRow, status: string): Promise<void> {
    if (g.source === 'inherited') {
      const ok = confirm(
        `Approving "${g.title}" will affect every card that inherits it. Continue?`,
      );
      if (!ok) return;
    }
    try {
      await dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>({
        endpoint: attributeUpdate.endpoint,
        action: attributeUpdate.action,
        data: {
          cardId: g.id,
          attributeName: 'gate_status',
          value: JSON.stringify(status),
        },
      });
      notify({ type: 'success', message: `Gate "${g.title}" → ${status}` });
      await load();
      onChanged?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Update failed: ${msg}` });
    }
  }

  function statusColour(s: string): string {
    switch (s) {
      case 'approved':
        return 'bg-emerald-500/15 text-emerald-300';
      case 'rejected':
        return 'bg-rose-500/15 text-rose-300';
      case 'n_a':
        return 'bg-muted/15 text-muted';
      default:
        return 'bg-amber-500/15 text-amber-300';
    }
  }
</script>

{#if gates.length > 0}
  <div
    class="flex flex-wrap items-center gap-2 border-b border-border bg-surface/40 px-3 py-2"
    data-testid="gate-strip"
  >
    <span class="text-xs font-medium uppercase tracking-wide text-muted">
      Gates
    </span>
    {#each gates as g (g.id)}
      <div
        class={cx(
          'flex items-center gap-1 rounded-full px-2 py-0.5 text-xs',
          statusColour(g.status),
        )}
        data-testid="gate-chip"
        data-gate-id={g.id}
        data-gate-source={g.source}
      >
        <span class="font-medium">{g.title}</span>
        {#if g.source === 'inherited'}
          <span
            class="rounded bg-bg/30 px-1 text-[10px] uppercase tracking-wide opacity-80"
            title="Inherited from card #{g.source_card_id}"
          >
            ↳ shared
          </span>
        {/if}
        <span class="opacity-70">· {g.status}</span>
        {#if g.status === 'pending'}
          <button
            type="button"
            class="ml-1 rounded px-1 hover:bg-emerald-500/20"
            title="Approve"
            onclick={() => void setStatus(g, 'approved')}
            data-testid="gate-approve"
          >
            ✓
          </button>
          <button
            type="button"
            class="rounded px-1 hover:bg-rose-500/20"
            title="Reject"
            onclick={() => void setStatus(g, 'rejected')}
            data-testid="gate-reject"
          >
            ✕
          </button>
        {/if}
      </div>
    {/each}
  </div>
{/if}
