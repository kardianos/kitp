<!--
  GateStrip.

  Renders the gate sub-cards under a parent (the task currently open).
  Each gate shows its title, status, and a quick approve/reject control.
  Clicking the title navigates to the gate's own card view.

  Loads via card.select_with_attributes filtered to card_type=gate and
  parent_card_id=<task>. Updates via attribute.update on gate_status.
-->
<script lang="ts">
  import { getDispatcher } from '../../dispatch/context';
  import { attributeUpdate, cardSelectWithAttributes } from '../../reg/handlers';
  import type {
    AttributeUpdateInput,
    AttributeUpdateOutput,
    CardSelectWithAttributesInput,
    CardSelectWithAttributesOutput,
    CardWithAttrs,
  } from '../../reg/types';
  import { notify } from '../toast.svelte';
  import { cx } from '../../util/class_names';

  let { parentCardId, onChanged }: {
    parentCardId: number;
    onChanged?: () => void;
  } = $props();

  const dispatcher = getDispatcher();

  let gates = $state<CardWithAttrs[]>([]);
  let loading = $state(false);

  $effect(() => {
    if (parentCardId > 0) void load();
  });

  async function load(): Promise<void> {
    loading = true;
    try {
      const out = await dispatcher.request<
        CardSelectWithAttributesInput,
        CardSelectWithAttributesOutput
      >({
        endpoint: cardSelectWithAttributes.endpoint,
        action: cardSelectWithAttributes.action,
        data: { cardTypeName: 'gate', parentCardId },
      });
      gates = out.rows;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify({ type: 'error', message: `Load gates failed: ${msg}` });
    } finally {
      loading = false;
    }
  }

  function gateTitle(g: CardWithAttrs): string {
    const t = g.attributes['title'];
    return typeof t === 'string' ? t : `Gate ${g.id}`;
  }
  function gateStatus(g: CardWithAttrs): string {
    const s = g.attributes['gate_status'];
    return typeof s === 'string' ? s : 'pending';
  }

  async function setStatus(g: CardWithAttrs, status: string): Promise<void> {
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
      notify({ type: 'success', message: `Gate "${gateTitle(g)}" → ${status}` });
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
          statusColour(gateStatus(g)),
        )}
        data-testid="gate-chip"
        data-gate-id={g.id}
      >
        <span class="font-medium">{gateTitle(g)}</span>
        <span class="opacity-70">· {gateStatus(g)}</span>
        {#if gateStatus(g) === 'pending'}
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
