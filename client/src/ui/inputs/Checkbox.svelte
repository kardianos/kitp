<!--
  Checkbox — boolean input. Native control with theme styling; wrap
  in a <label> at the call site if you want a label-on-the-right
  layout (this primitive doesn't render the label itself so it
  stays composable).
-->
<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { cx } from '../../util/class_names.js';

  interface Props extends Omit<HTMLInputAttributes, 'checked' | 'class' | 'type'> {
    checked?: boolean;
    class?: string | undefined;
  }

  let { checked = $bindable(false), class: klass = '', ...rest }: Props = $props();
</script>

<input
  type="checkbox"
  {...rest}
  class={cx(
    'h-4 w-4 rounded border-border text-accent focus:ring-2 focus:ring-accent',
    'disabled:opacity-50',
    klass,
  )}
  bind:checked
/>
