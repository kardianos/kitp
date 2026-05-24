<!--
  ErrorAlert — standardised role=alert banner for inline error display.
  Replaces 15+ hand-rolled `<div role="alert" class="...bg-danger/10...">`
  scattered across the screens. Supports an optional onRetry callback
  that surfaces a "Retry" affordance — the common case for "Failed to
  load" rows.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cx } from '../util/class_names.js';

  interface Props {
    message: string;
    /** When set, renders a "Retry" button that invokes this on click. */
    onRetry?: () => void;
    /** Compact (text-only) vs default (with padding + border). */
    variant?: 'default' | 'inline';
    class?: string;
    /** Optional richer content — when present, overrides `message`. */
    children?: Snippet;
  }

  let { message, onRetry, variant = 'default', class: klass = '', children }: Props = $props();
</script>

<div
  role="alert"
  class={cx(
    variant === 'inline'
      ? 'text-xs text-danger'
      : 'rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger',
    klass,
  )}
>
  {#if children}
    {@render children()}
  {:else}
    {message}
  {/if}
  {#if onRetry}
    <button type="button" class="ml-3 underline" onclick={onRetry}>Retry</button>
  {/if}
</div>
