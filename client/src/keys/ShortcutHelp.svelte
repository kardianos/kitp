<script lang="ts">
  import { shortcuts } from './registry.svelte';
  import { formatBinding } from './shortcut';

  // Group visible entries by scope for display.
  const grouped = $derived.by(() => {
    const map = new Map<string, typeof shortcuts.visible>();
    for (const entry of shortcuts.visible) {
      const arr = map.get(entry.scope) ?? [];
      arr.push(entry);
      map.set(entry.scope, arr);
    }
    return [...map.entries()].sort(([a], [b]) => {
      // 'global' comes last; everything else alphabetic.
      if (a === 'global') return 1;
      if (b === 'global') return -1;
      return a.localeCompare(b);
    });
  });

  function close(): void {
    shortcuts.helpOpen = false;
  }
</script>

{#if shortcuts.helpOpen}
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Keyboard shortcuts"
    class="fixed inset-0 z-50 flex items-center justify-center p-4"
  >
    <button
      type="button"
      aria-label="Close shortcuts overlay"
      class="absolute inset-0 cursor-default bg-black/40"
      onclick={close}
    ></button>
    <div
      class="relative z-10 max-h-[80vh] w-full max-w-xl overflow-y-auto rounded-lg bg-white p-6 text-gray-900 shadow-xl dark:bg-gray-900 dark:text-gray-100"
    >
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-lg font-semibold">Keyboard shortcuts</h2>
        <button
          type="button"
          aria-label="Close"
          class="rounded px-2 py-1 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
          onclick={close}>Esc</button
        >
      </div>

      {#each grouped as [scope, entries] (scope)}
        <section class="mb-5 last:mb-0">
          <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
            {scope.replace(/_/g, ' ')}
          </h3>
          <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {#each entries as entry (entry.id)}
              <dt class="font-mono text-gray-700 dark:text-gray-300">
                {formatBinding(entry.binding)}
              </dt>
              <dd class="text-gray-900 dark:text-gray-100">{entry.label}</dd>
            {/each}
          </dl>
        </section>
      {/each}
    </div>
  </div>
{/if}
