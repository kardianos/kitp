<script lang="ts">
  import { tick } from 'svelte';
  import Modal from './Modal.svelte';
  import Button from './Button.svelte';

  interface Props {
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    onConfirm: () => void;
    onCancel?: () => void;
    danger?: boolean;
  }

  let {
    open = $bindable(),
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    onConfirm,
    onCancel,
    danger = false,
  }: Props = $props();

  let cancelBtn: HTMLButtonElement | null = $state(null);

  function doCancel() {
    open = false;
    onCancel?.();
  }
  function doConfirm() {
    open = false;
    onConfirm();
  }

  $effect(() => {
    if (open) {
      void tick().then(() => cancelBtn?.focus());
    }
  });
</script>

<Modal bind:open {title} {...onCancel ? { onClose: onCancel } : {}} size="sm">
  <p class="text-sm leading-relaxed text-fg">{message}</p>
  {#snippet footer()}
    <button
      bind:this={cancelBtn}
      type="button"
      class="inline-flex h-9 select-none items-center justify-center rounded-md border border-border bg-surface px-3.5 text-sm font-medium text-fg transition-colors hover:bg-border/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
      onclick={doCancel}
    >
      {cancelLabel}
    </button>
    <Button variant={danger ? 'danger' : 'primary'} onclick={doConfirm}>
      {#snippet children()}{confirmLabel}{/snippet}
    </Button>
  {/snippet}
</Modal>
