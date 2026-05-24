<!--
  TextInput — single-line text input with theme-correct styling.

  Layer-1 primitive in the form kernel. Owns the canonical class
  string (`bg-bg text-fg ...`) so dark mode renders consistently.
  Every other prop forwards to the underlying <input> via spread —
  pass any standard HTML input attribute (id, name, autocomplete,
  data-testid, autofocus, oninput, onblur, …) without it needing a
  dedicated prop slot here.
-->
<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { cx } from '../../util/class_names.js';

  interface Props extends Omit<HTMLInputAttributes, 'value' | 'class'> {
    value?: string;
    /** Render an error ring; FormField sets this from its `error` prop. */
    invalid?: boolean | undefined;
    /** Extra classes appended after the canonical theme string. */
    class?: string | undefined;
  }

  let { value = $bindable(''), invalid = false, class: klass = '', ...rest }: Props = $props();
</script>

<input
  type="text"
  {...rest}
  aria-invalid={invalid || undefined}
  class={cx(
    'w-full rounded-md border bg-bg px-2 py-1.5 text-sm text-fg placeholder:text-muted',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
    'disabled:opacity-50 disabled:cursor-not-allowed',
    invalid ? 'border-danger' : 'border-border',
    klass,
  )}
  bind:value
/>
