<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cx } from '../util/class_names.js';
  import Spinner from './Spinner.svelte';

  interface Props {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    size?: 'sm' | 'md' | 'lg';
    disabled?: boolean;
    loading?: boolean;
    type?: 'button' | 'submit';
    onclick?: (e: MouseEvent) => void;
    class?: string;
    'aria-label'?: string;
    title?: string;
    children?: Snippet;
  }

  let {
    variant = 'primary',
    size = 'md',
    disabled = false,
    loading = false,
    type = 'button',
    onclick,
    class: klass = '',
    'aria-label': ariaLabel,
    title,
    children,
  }: Props = $props();

  const variantClass = $derived.by(() => {
    switch (variant) {
      case 'primary':
        return 'bg-accent text-accent-fg hover:opacity-90 active:opacity-80';
      case 'secondary':
        return 'bg-surface text-fg border border-border hover:bg-border/40';
      case 'ghost':
        return 'bg-transparent text-fg hover:bg-surface';
      case 'danger':
        return 'bg-danger text-danger-fg hover:opacity-90 active:opacity-80';
    }
  });

  const sizeClass = $derived.by(() => {
    switch (size) {
      case 'sm':
        return 'h-7 px-2.5 text-xs gap-1';
      case 'lg':
        return 'h-11 px-5 text-base gap-2';
      default:
        return 'h-9 px-3.5 text-sm gap-1.5';
    }
  });

  const isDisabled = $derived(disabled || loading);
</script>

<button
  {type}
  class={cx(
    'inline-flex select-none items-center justify-center rounded-md font-medium',
    'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1',
    'disabled:cursor-not-allowed disabled:opacity-50',
    variantClass,
    sizeClass,
    klass,
  )}
  disabled={isDisabled}
  aria-busy={loading}
  aria-label={ariaLabel}
  {title}
  onclick={(e) => {
    if (isDisabled) return;
    onclick?.(e);
  }}
>
  {#if loading}
    <Spinner size={size === 'lg' ? 'md' : 'sm'} />
  {/if}
  {#if children}
    {@render children()}
  {/if}
</button>
