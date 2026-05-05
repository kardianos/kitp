<script lang="ts">
  /**
   * Tag badge with an optional X button for removal. Wraps the lower-level
   * `<Chip>` primitive so the visual style stays consistent with the rest of
   * the chip family (combobox tokens, etc).
   */

  import Chip from '../Chip.svelte';

  interface Props {
    label: string;
    removable?: boolean;
    onRemove?: () => void;
    class?: string;
  }

  let {
    label,
    removable = false,
    onRemove,
    class: klass = '',
  }: Props = $props();
</script>

{#if onRemove !== undefined}
  <Chip {label} {removable} {onRemove} variant="default" class={klass} />
{:else}
  <Chip {label} {removable} variant="default" class={klass} />
{/if}
