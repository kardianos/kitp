<script lang="ts">
  import { cx } from '../util/class_names.js';

  interface Props {
    label: string;
    removable?: boolean;
    onRemove?: () => void;
    variant?: 'default' | 'accent' | 'danger';
    size?: 'sm' | 'md';
    class?: string;
  }

  let {
    label,
    removable = false,
    onRemove,
    variant = 'default',
    size = 'sm',
    class: klass = '',
  }: Props = $props();

  const variantClass = $derived.by(() => {
    switch (variant) {
      case 'accent':
        return 'bg-accent text-accent-fg border-transparent';
      case 'danger':
        return 'bg-danger text-danger-fg border-transparent';
      default:
        return 'bg-surface text-fg border-border';
    }
  });

  const sizeClass = $derived(
    size === 'md' ? 'h-7 text-sm px-2.5' : 'h-6 text-xs px-2',
  );
</script>

<span
  class={cx(
    'inline-flex items-center gap-1 rounded-full border font-medium',
    variantClass,
    sizeClass,
    klass,
  )}
>
  <span class="truncate">{label}</span>
  {#if removable}
    <button
      type="button"
      class="-mr-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full hover:bg-black/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      aria-label="Remove {label}"
      onclick={(e) => {
        e.stopPropagation();
        onRemove?.();
      }}
      onpointerdown={(e) => {
        // Prevent the chip click bubbling into a parent (e.g. combobox trigger).
        e.stopPropagation();
      }}
    >
      <svg viewBox="0 0 12 12" class="h-3 w-3" aria-hidden="true">
        <path
          d="M2 2 L10 10 M10 2 L2 10"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          fill="none"
        />
      </svg>
    </button>
  {/if}
</span>
