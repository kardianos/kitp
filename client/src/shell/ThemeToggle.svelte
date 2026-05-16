<!--
  ThemeToggle — sun/moon icon button that flips the app between light
  and dark themes. Lives in the AppShell header alongside the help
  affordances. Click toggles; the persisted choice survives reloads
  via localStorage (see theme.svelte.ts).

  The icon shown is the *target* state, not the current one — a moon
  icon means "click to go dark", a sun means "click to go light". This
  matches the convention used by GitHub and most Linux DEs and avoids
  the second-guessing of "is that icon what I am or what I'd become?".
-->
<script lang="ts">
  import { themeStore } from './theme.svelte';

  const isDark = $derived(themeStore.mode === 'dark');
</script>

<button
  type="button"
  class="rounded p-1 text-muted hover:bg-border/40"
  title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
  aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
  aria-pressed={isDark}
  onclick={() => themeStore.toggle()}
>
  {#if isDark}
    <!-- Sun: shown while dark, indicates clicking goes light. -->
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
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="M4.93 4.93l1.41 1.41" />
      <path d="M17.66 17.66l1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="M4.93 19.07l1.41-1.41" />
      <path d="M17.66 6.34l1.41-1.41" />
    </svg>
  {:else}
    <!-- Moon: shown while light, indicates clicking goes dark. -->
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
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  {/if}
</button>
