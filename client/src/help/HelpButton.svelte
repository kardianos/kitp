<!--
  HelpButton — the book icon dropped next to the keyboard-shortcuts ?
  icon in AppShell. Clicking opens <HelpModal>; the modal binds back
  to `open` here so ESC / backdrop click re-close it cleanly.

  The button stays clickable even when no topic is published — the
  modal surfaces a "no help for this page" message in that case. This
  matches the principle that the affordance should not silently change
  shape between screens; users learn the icon, not the rules behind it.
-->
<script lang="ts">
  import HelpModal from './HelpModal.svelte';

  let open = $state<boolean>(false);
</script>

<button
  type="button"
  class="rounded p-1 text-muted hover:bg-border/40"
  title="About this screen"
  aria-label="About this screen"
  onclick={() => (open = true)}
>
  <!-- Open-book glyph; matches the muted weight of the ? icon next to it. -->
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M2 6.5A2.5 2.5 0 0 1 4.5 4H11v16H4.5A2.5 2.5 0 0 1 2 17.5v-11Z" />
    <path d="M22 6.5A2.5 2.5 0 0 0 19.5 4H13v16h6.5a2.5 2.5 0 0 0 2.5-2.5v-11Z" />
  </svg>
</button>

<HelpModal bind:open />
