import { untrack } from 'svelte';
import type { ShortcutScope } from './scopes';

/**
 * A registered keyboard shortcut.
 *
 * `binding` is the canonical key string: `[Mod+][Shift+][Alt+]<key>`,
 * with chord shortcuts written `'g p'` (space-separated). `<key>` is
 * lowercased for printable keys; named keys use `Enter`, `Esc`, `Tab`,
 * `ArrowUp`/`ArrowDown`/`ArrowLeft`/`ArrowRight`, `Space`, `?`, `/`.
 *
 * `fireInInputs` defaults to false; the dispatcher then ignores key
 * events whose target is an `<input>`, `<textarea>`, or contenteditable.
 * `Esc` and `Mod+Enter` are treated as `fireInInputs: true` by default
 * inside the dispatcher.
 */
export interface ShortcutEntry {
  scope: ShortcutScope;
  binding: string;
  handler: () => void;
  label: string;
  fireInInputs?: boolean;
  /** Unique id used by useShortcut to remove on unmount. */
  id: number;
}

class ShortcutRegistry {
  entries = $state<ShortcutEntry[]>([]);
  activeScope = $state<ShortcutScope>('global');
  helpOpen = $state(false);

  #nextId = 1;

  /** Register a shortcut. Returns the id used for `unregister`.
   *
   * Wrapped in `untrack` because the access `this.entries.push(...)`
   * reads the entries field signal. Without untrack a caller running
   * inside a `$effect` (e.g. AppShell's per-project chord registration)
   * would pick up `entries` as a tracked dep — the subsequent push
   * fires the same signal, Svelte re-schedules the effect, the next
   * run's cleanup + body re-enters here, and the cycle climbs to
   * Svelte's `effect_update_depth_exceeded` ceiling.
   *
   * Untrack only suppresses reads from being added to the caller's
   * dep set; the push still fires its signal so legitimate subscribers
   * (ShortcutHelp's `visible` derived) see the change. */
  register(entry: Omit<ShortcutEntry, 'id'>): number {
    return untrack(() => {
      const id = this.#nextId++;
      const full: ShortcutEntry = { ...entry, id };
      this.entries.push(full);
      return id;
    });
  }

  /** Remove a previously registered entry by its id.
   *
   * Same untrack rationale as `register` — keeps the registry's
   * mutation API from threading the caller's effect into the entries
   * dep graph. The `e !== undefined` guard handles a separate Svelte
   * 5 reactive-array quirk: back-to-back splices can surface an
   * undefined index mid-iteration through the proxy. */
  unregister(id: number): void {
    untrack(() => {
      const idx = this.entries.findIndex(
        (e) => e !== undefined && e.id === id,
      );
      if (idx >= 0) this.entries.splice(idx, 1);
    });
  }

  /** Entries visible for the current scope plus the always-on `global`. */
  get visible(): ShortcutEntry[] {
    return this.entries.filter(
      (e) => e.scope === 'global' || e.scope === this.activeScope,
    );
  }

  /** Reset the registry. Test-only; do not call in production code. */
  _reset(): void {
    this.entries = [];
    this.activeScope = 'global';
    this.helpOpen = false;
    this.#nextId = 1;
  }
}

export const shortcuts = new ShortcutRegistry();
