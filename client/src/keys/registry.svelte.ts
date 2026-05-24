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
  /**
   * Optional fine-grained ordering within a scope tier. The
   * dispatcher resolves matches by:
   *   1. Scope tier — `overlay` > active > `global`.
   *   2. Within a tier, higher `priority` wins; ties go to the
   *      most recently registered entry.
   * Most callers leave this undefined (treated as 0). Used by
   * transient overlays that want to elbow past a peer overlay
   * registered earlier (e.g. a nested confirm dialog inside a
   * larger modal).
   */
  priority?: number;
  /** Unique id used by useShortcut to remove on unmount. */
  id: number;
}

/**
 * A reactive provider of shortcut entries that aren't imperatively
 * register/unregister'd. The function is evaluated inside the
 * dispatcher's / `visible`'s reactive read, so a `$derived` closure
 * passed here stays live: when its inputs change the merged entry list
 * recomputes with no imperative mutation of `entries`.
 *
 * This is how the per-project screen chords are wired (see AppShell):
 * the chord list is a pure `$derived` of the loaded screen cards, NOT
 * an `$effect` that pushes/splices `entries` on every project switch.
 * Removing that effect is what closes the AppShell ↔ project-scope
 * cascade — there is no longer a body that both reads `projectScope`
 * and writes `entries`.
 */
export type DynamicShortcutSource = () => readonly ShortcutEntry[];

class ShortcutRegistry {
  entries = $state<ShortcutEntry[]>([]);
  activeScope = $state<ShortcutScope>('global');
  helpOpen = $state(false);

  /**
   * Registered dynamic sources, keyed by an opaque token. Held as plain
   * (non-`$state`) data on purpose: a source is a `$derived` getter, so
   * its *output* is already reactive — the set of sources itself only
   * changes on mount/unmount, which the consumers re-read on their next
   * reactive pass. Iterating it inside a tracked read subscribes the
   * reader to whatever signals each source touches.
   */
  #sources = new Map<symbol, DynamicShortcutSource>();

  #nextId = 1;

  /** Register a shortcut. Returns the id used for `unregister`.
   *
   * Wrapped in `untrack` because the access `this.entries.push(...)`
   * reads the entries field signal. Without untrack a caller running
   * inside a `$effect` would pick up `entries` as a tracked dep — the
   * subsequent push fires the same signal, Svelte re-schedules the
   * effect, and the cycle climbs to `effect_update_depth_exceeded`.
   * The dynamic-chord path (registerSource) avoids this class of bug
   * entirely by not mutating `entries` at all.
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

  /**
   * Register a reactive source of shortcut entries. Returns a disposer
   * that removes the source. Unlike {@link register}, this never
   * mutates `entries`; the source's output is folded into {@link all}
   * (and thus the dispatcher + {@link visible}) at read time. Use this
   * for data-driven chord sets — e.g. the per-project screen hotkeys
   * derived from the loaded screen cards.
   */
  registerSource(source: DynamicShortcutSource): () => void {
    const token = Symbol('shortcut-source');
    this.#sources.set(token, source);
    return () => {
      this.#sources.delete(token);
    };
  }

  /**
   * All live entries: the imperatively-registered `entries` plus every
   * dynamic source's current output. Reading this inside a reactive
   * context (the dispatcher's match loops, `visible`) subscribes to
   * both `entries` and whatever each source's `$derived` reads.
   *
   * Dynamic entries carry no real id (they're never unregistered by
   * id); negative synthetic ids keep the `ShortcutEntry` shape valid
   * without colliding with the positive `#nextId` space.
   */
  get all(): ShortcutEntry[] {
    const out: ShortcutEntry[] = [];
    for (const e of this.entries) {
      if (e !== undefined) out.push(e);
    }
    let synthetic = -1;
    for (const source of this.#sources.values()) {
      for (const e of source()) {
        out.push(e.id < 0 ? e : { ...e, id: synthetic-- });
      }
    }
    return out;
  }

  /** Entries visible for the current scope plus the always-on
   * `global` tier and any open-overlay entries (so a help dialog's
   * own Esc binding shows up in its own keyboard-shortcuts list).
   *
   * `e !== undefined` is the same Svelte 5 reactive-array splice guard
   * that `unregister` uses — a concurrent splice can surface an
   * undefined index mid-iteration through the proxy. */
  get visible(): ShortcutEntry[] {
    return this.all.filter(
      (e) =>
        e !== undefined &&
        (e.scope === 'global' ||
          e.scope === 'overlay' ||
          e.scope === this.activeScope),
    );
  }

  /** Reset the registry. Test-only; do not call in production code. */
  _reset(): void {
    this.entries = [];
    this.activeScope = 'global';
    this.helpOpen = false;
    this.#sources.clear();
    this.#nextId = 1;
  }
}

export const shortcuts = new ShortcutRegistry();
