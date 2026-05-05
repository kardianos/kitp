<script lang="ts">
  import { cx } from '../util/class_names.js';

  interface Props {
    size?: 'sm' | 'md' | 'lg';
    class?: string;
  }

  let { size = 'md', class: klass = '' }: Props = $props();

  const sizeClass = $derived(
    size === 'sm' ? 'h-3 w-3' : size === 'lg' ? 'h-6 w-6' : 'h-4 w-4',
  );
</script>

<svg
  class={cx('spinner inline-block animate-spin text-current', sizeClass, klass)}
  viewBox="0 0 24 24"
  fill="none"
  role="img"
  aria-label="Loading"
>
  <circle
    cx="12"
    cy="12"
    r="9"
    stroke="currentColor"
    stroke-opacity="0.25"
    stroke-width="3"
  />
  <path
    d="M21 12a9 9 0 0 0-9-9"
    stroke="currentColor"
    stroke-width="3"
    stroke-linecap="round"
  />
</svg>

<style>
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
