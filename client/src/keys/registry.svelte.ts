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

  /** Register a shortcut. Returns the id used for `unregister`. */
  register(entry: Omit<ShortcutEntry, 'id'>): number {
    const id = this.#nextId++;
    const full: ShortcutEntry = { ...entry, id };
    this.entries.push(full);
    return id;
  }

  /** Remove a previously registered entry by its id.
   *
   * The `e !== undefined` guard exists because Svelte 5's reactive
   * proxy can surface undefined indices when several `unregister`
   * calls fire back-to-back inside an effect cleanup: each splice
   * shortens the array between the iteration loop's prior length
   * read and the next index access, so the trailing index reads as
   * undefined. Without the guard, `e.id` throws and the cleanup
   * stops half-applied.
   *
   * Implemented as in-place splice (not whole-array reassignment) —
   * a reassignment fans out to every effect that read `entries`
   * via Svelte's class-field signal, which can multiply small
   * cleanups into long reactive cascades on screens that mount many
   * shortcut hooks. The splice path keeps the change scoped to a
   * single element.
   *
   * No-op when the id is missing — duplicate cleanups stay safe. */
  unregister(id: number): void {
    const idx = this.entries.findIndex((e) => e !== undefined && e.id === id);
    if (idx >= 0) this.entries.splice(idx, 1);
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
