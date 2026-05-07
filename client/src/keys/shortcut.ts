import { onMount, onDestroy } from 'svelte';
import type { ShortcutScope } from './scopes';
import { shortcuts } from './registry.svelte';

/**
 * Register a keyboard shortcut for the lifetime of the calling
 * component. Must be called during component initialization (it uses
 * `onMount` / `onDestroy` from Svelte).
 *
 * Pass an array for `binding` to register multiple aliases that share a
 * single label and handler — e.g. `['j', ']']` for "Next task". The
 * help overlay groups aliased entries onto one row ("j, ]") when it
 * sees the same `label` + `handler` reference under one scope, so all
 * the caller has to do is pass the array.
 */
export function useShortcut(
  scope: ShortcutScope,
  binding: string | readonly string[],
  handler: () => void,
  label: string,
  opts?: { fireInInputs?: boolean },
): void {
  const ids: number[] = [];
  const bindings = typeof binding === 'string' ? [binding] : Array.from(binding);
  onMount(() => {
    for (const b of bindings) {
      const entry: Omit<import('./registry.svelte').ShortcutEntry, 'id'> = {
        scope,
        binding: b,
        handler,
        label,
        ...(opts?.fireInInputs !== undefined
          ? { fireInInputs: opts.fireInInputs }
          : {}),
      };
      ids.push(shortcuts.register(entry));
    }
  });
  onDestroy(() => {
    for (const id of ids) {
      shortcuts.unregister(id);
    }
    ids.length = 0;
  });
}

/** Set the currently active scope. Called when a screen mounts. */
export function setActiveScope(scope: ShortcutScope): void {
  shortcuts.activeScope = scope;
}

/**
 * True when running on macOS or iOS. Uses `navigator.platform`; safe to
 * import in non-browser environments (returns false there).
 */
export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

/**
 * Format a canonical binding string into a user-facing label.
 *
 *   formatBinding('Mod+/')      -> '⌘+/' on Mac, 'Ctrl+/' elsewhere
 *   formatBinding('Mod+Enter')  -> '⌘+Enter' / 'Ctrl+Enter'
 *   formatBinding('g p')        -> 'g then p'
 *   formatBinding('Esc')        -> 'Esc'
 */
export function formatBinding(binding: string): string {
  if (binding.includes(' ')) {
    return binding.split(' ').join(' then ');
  }
  const parts = binding.split('+');
  return parts
    .map((p) => {
      if (p === 'Mod') return isMac ? '⌘' : 'Ctrl';
      if (p === 'Shift') return isMac ? '⇧' : 'Shift';
      if (p === 'Alt') return isMac ? '⌥' : 'Alt';
      return p;
    })
    .join('+');
}
