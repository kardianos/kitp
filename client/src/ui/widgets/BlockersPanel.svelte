<!--
  BlockersPanel.

  "What's blocking me" diagnostic for a workflow-bound task. Renders a
  compact list of outgoing transitions from the card's current state,
  showing per-transition pass/fail with the offending gates and any
  aggregate-guard message.

  Hidden when the card has no workflow_def_ref or when no outgoing
  transitions exist.
-->
<script lang="ts">
  import { getDispatcher } from '../../dispatch/context';
  import { cardBlockers } from '../../reg/handlers_admin';
  import type {
    CardBlockersInput,
    CardBlockersOutput,
  } from '../../reg/types';
  import { cx } from '../../util/class_names';

  let { cardId, version }: { cardId: number; version: number } = $props();

  const dispatcher = getDispatcher();
  let data = $state<CardBlockersOutput | null>(null);
  let loading = $state(false);

  $effect(() => {
    // Track cardId + version (parent bumps it on refresh / gate change /
    // transition write) so the panel re-loads.
    void cardId;
    void version;
    if (cardId > 0) void load();
  });

  async function load(): Promise<void> {
    loading = true;
    try {
      const out = await dispatcher.request<
        CardBlockersInput,
        CardBlockersOutput
      >({
        endpoint: cardBlockers.endpoint,
        action: cardBlockers.action,
        data: { cardId },
      });
      data = out;
    } catch {
      data = null;
    } finally {
      loading = false;
    }
  }
</script>

{#if data !== null && data.workflow_bound && data.transitions.length > 0}
  <section
    class="flex flex-col gap-1 border-b border-border bg-surface/40 px-3 py-2 text-xs"
    data-testid="blockers-panel"
  >
    <span class="font-medium uppercase tracking-wide text-muted">
      Outgoing transitions from {data.current_state}
    </span>
    <ul class="flex flex-col gap-1">
      {#each data.transitions as t (t.to_state)}
        <li
          class={cx(
            'flex items-start gap-2 rounded px-1.5 py-1',
            t.ok ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300',
          )}
          data-testid="blocker-row"
          data-target-state={t.to_state}
        >
          <span class="font-mono">{t.ok ? '✓' : '×'}</span>
          <div class="flex-1">
            <div class="font-medium">→ {t.to_state}</div>
            {#if t.gates_blocking.length > 0}
              <div class="text-[11px] opacity-80">
                Gates: {t.gates_blocking.join(', ')}
              </div>
            {/if}
            {#if t.aggregate_msg !== '' && !t.aggregate_ok}
              <div class="text-[11px] opacity-80">{t.aggregate_msg}</div>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  </section>
{/if}
