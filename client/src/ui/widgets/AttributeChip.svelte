<script lang="ts">
  /**
   * Read-only inline chip for an attribute reference (e.g. "Assignee: alice",
   * "Milestone: M1"). Renders compactly inline with TaskRow.
   *
   * When `onclick` is supplied the chip becomes a focusable button that
   * activates on Enter / Space, matching the rest of the UI primitives in
   * this codebase. Hover state is applied only to the clickable variant so
   * read-only chips stay visually quiet.
   */

  import { cx } from '../../util/class_names.js';

  interface Props {
    /** Short attribute label rendered as a muted prefix. */
    label: string;
    /** Already-resolved value text. */
    value: string;
    /** Optional click handler — when set, the chip is rendered as a button. */
    onclick?: () => void;
    class?: string;
  }

  let {
    label,
    value,
    onclick,
    class: klass = '',
  }: Props = $props();

  const baseClass =
    'inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-xs font-medium text-fg';
  const interactiveClass =
    'transition-colors hover:bg-border/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent';
</script>

{#if onclick}
  <button
    type="button"
    class={cx(baseClass, interactiveClass, klass)}
    title="{label}: {value}"
    {onclick}
  >
    <span class="text-muted">{label}:</span>
    <span class="truncate">{value}</span>
  </button>
{:else}
  <span class={cx(baseClass, klass)} title="{label}: {value}">
    <span class="text-muted">{label}:</span>
    <span class="truncate">{value}</span>
  </span>
{/if}
