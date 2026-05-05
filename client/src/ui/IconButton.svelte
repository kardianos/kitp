<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cx } from '../util/class_names.js';
  import Spinner from './Spinner.svelte';

  interface Props {
    'aria-label': string;
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    size?: 'sm' | 'md' | 'lg';
    disabled?: boolean;
    loading?: boolean;
    type?: 'button' | 'submit';
    onclick?: (e: MouseEvent) => void;
    class?: string;
    title?: string;
    children?: Snippet;
  }

  let {
    'aria-label': ariaLabel,
    variant = 'ghost',
    size = 'md',
    disabled = false,
    loading = false,
    type = 'button',
    onclick,
    class: klass = '',
    title,
    children,
  }: Props = $props();

  const variantClass = $derived.by(() => {
    switch (variant) {
      case 'primary':
        return 'bg-accent text-accent-fg hover:opacity-90';
      case 'secondary':
        return 'bg-surface text-fg border border-border hover:bg-border/40';
      case 'ghost':
        return 'bg-transparent text-fg hover:bg-surface';
      case 'danger':
        return 'bg-danger text-white hover:opacity-90';
    }
  });

  const sizeClass = $derived.by(() => {
    switch (size) {
      case 'sm':
        return 'h-7 w-7 text-sm';
      case 'lg':
        return 'h-11 w-11 text-lg';
      default:
        return 'h-9 w-9 text-base';
    }
  });

  const isDisabled = $derived(disabled || loading);
</script>

<button
  {type}
  aria-label={ariaLabel}
  {title}
  disabled={isDisabled}
  aria-busy={loading}
  class={cx(
    'inline-flex shrink-0 items-center justify-center rounded-md',
    'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1',
    'disabled:cursor-not-allowed disabled:opacity-50',
    variantClass,
    sizeClass,
    klass,
  )}
  onclick={(e) => {
    if (isDisabled) return;
    onclick?.(e);
  }}
>
  {#if loading}
    <Spinner size="sm" />
  {:else if children}
    {@render children()}
  {/if}
</button>
