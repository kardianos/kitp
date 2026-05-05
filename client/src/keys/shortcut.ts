import { onMount, onDestroy } from 'svelte';
import type { ShortcutScope } from './scopes';
import { shortcuts } from './registry.svelte';

/**
 * Register a keyboard shortcut for the lifetime of the calling
 * component. Must be called during component initialization (it uses
 * `onMount` / `onDestroy` from Svelte).
 */
export function useShortcut(
  scope: ShortcutScope,
  binding: string,
  handler: () => void,
  label: string,
  opts?: { fireInInputs?: boolean },
): void {
  let id: number | null = null;
  onMount(() => {
    const entry: Omit<import('./registry.svelte').ShortcutEntry, 'id'> = {
      scope,
      binding,
      handler,
      label,
      ...(opts?.fireInInputs !== undefined ? { fireInInputs: opts.fireInInputs } : {}),
    };
    id = shortcuts.register(entry);
  });
  onDestroy(() => {
    if (id !== null) {
      shortcuts.unregister(id);
      id = null;
    }
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
