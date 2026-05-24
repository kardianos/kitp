<!--
  TaskRefLink — read-view link to another task, in a stable
  `#<id> Title` format with an optional status pill.

  Owns the visual rules so callers (RelatedTasksPanel's parent + child
  rows, future call sites that surface task refs) all render the
  same shape:

    [#123]  Card title here       [status pill]

  The id is rendered first so two same-named tasks can be told apart
  at a glance and so callers don't need to decide between "Title
  #id" and "#id Title" formats — there's one true form.
-->
<script lang="ts">
  import type { CardWithAttrs, TransitionPhase } from '../../reg/types.js';
  import { cx } from '../../util/class_names.js';

  interface Props {
    card: CardWithAttrs;
    /** Optional resolved status — when set, renders a small phase-
     *  coloured pill after the title. */
    status?: { label: string; phase: TransitionPhase } | null;
    /** Override the destination href. Defaults to /task/<id>. */
    href?: string;
    class?: string;
  }

  let { card, status = null, href, class: klass = '' }: Props = $props();

  const resolvedHref = $derived(href ?? `/task/${card.id}`);

  function titleOf(c: CardWithAttrs): string {
    const t = c.attributes['title'];
    return typeof t === 'string' && t !== '' ? t : '(untitled)';
  }

  function phasePillClass(phase: TransitionPhase): string {
    if (phase === 'terminal') return 'bg-muted/15 text-muted';
    if (phase === 'triage') return 'bg-warning/15 text-warning';
    return 'bg-success/15 text-success';
  }
</script>

<a
  href={resolvedHref}
  class={cx(
    'flex min-w-0 flex-1 items-center gap-1.5 text-sm hover:underline focus:outline-none focus-visible:underline',
    klass,
  )}
>
  <span class="shrink-0 font-mono text-[11px] text-muted">#{card.id}</span>
  <span class="truncate">{titleOf(card)}</span>
  {#if status !== null}
    <span
      class={cx(
        'inline-block shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
        phasePillClass(status.phase),
      )}
    >
      {status.label}
    </span>
  {/if}
</a>
