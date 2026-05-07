<script lang="ts">
  import { shortcuts } from './registry.svelte';
  import { formatBinding } from './shortcut';

  /** One display row in the help overlay — collapses N alias bindings
   *  for the same (scope, label, handler) into a single line. */
  interface DisplayRow {
    /** Stable key for the {#each} block. */
    key: string;
    /** Comma-joined formatted bindings, e.g. "j, ]". */
    bindings: string;
    label: string;
  }

  // Group visible entries by scope, then collapse alias rows. Two
  // entries collapse when they share scope + label + handler reference
  // — `useShortcut(scope, [a, b], fn, label)` registers two entries
  // with that exact shape, so the merge is precise to the alias intent
  // and won't accidentally fold two unrelated shortcuts that happen to
  // share a label.
  const grouped = $derived.by((): [string, DisplayRow[]][] => {
    const byScope = new Map<string, DisplayRow[]>();
    /** Per-scope lookup keyed by `${label}\0${handler-id}` so we can
     *  find an existing row in O(1). The handler is identity-compared,
     *  so two unrelated registrations with the same label but
     *  different handlers stay on their own rows. */
    const idx = new Map<string, Map<string, DisplayRow>>();

    for (const entry of shortcuts.visible) {
      const rows = byScope.get(entry.scope) ?? [];
      const map =
        idx.get(entry.scope) ?? new Map<string, DisplayRow>();
      // We don't have a stable id for the handler closure, but
      // handlerKey only needs to be unique-per-handler within a scope —
      // identity via WeakMap would be cleaner; a Map keyed on the
      // function reference works the same for our scale.
      const handlerKey = handlerKeys.get(entry.handler) ?? assignHandlerKey(entry.handler);
      const k = `${entry.label}\0${handlerKey}`;
      const existing = map.get(k);
      const formatted = formatBinding(entry.binding);
      if (existing !== undefined) {
        // Append alias to the existing row.
        existing.bindings = `${existing.bindings}, ${formatted}`;
      } else {
        const row: DisplayRow = {
          key: `${entry.scope}\0${k}`,
          bindings: formatted,
          label: entry.label,
        };
        rows.push(row);
        map.set(k, row);
      }
      byScope.set(entry.scope, rows);
      idx.set(entry.scope, map);
    }

    return [...byScope.entries()].sort(([a], [b]) => {
      // 'global' comes last; everything else alphabetic.
      if (a === 'global') return 1;
      if (b === 'global') return -1;
      return a.localeCompare(b);
    });
  });

  /** Cheap stable id-per-handler. We only need monotonic ids inside a
   *  single help-overlay open; the WeakMap drops entries when handlers
   *  are GC'd as their components unmount. */
  const handlerKeys = new WeakMap<() => void, number>();
  let nextHandlerKey = 1;
  function assignHandlerKey(h: () => void): number {
    const id = nextHandlerKey++;
    handlerKeys.set(h, id);
    return id;
  }

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
            {#each entries as row (row.key)}
              <dt class="font-mono text-gray-700 dark:text-gray-300">
                {row.bindings}
              </dt>
              <dd class="text-gray-900 dark:text-gray-100">{row.label}</dd>
            {/each}
          </dl>
        </section>
      {/each}
    </div>
  </div>
{/if}
