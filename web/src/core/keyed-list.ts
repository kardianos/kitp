/**
 * Keyed list reconciliation — the one non-trivial rendering primitive.
 *
 * Reconciles a host element's child controls against a signal-derived key
 * list: creates new keys, moves existing nodes into order (preserving focus /
 * scroll / animation state — no recreate), destroys removed keys. This is the
 * explicit equivalent of Svelte's `{#each items as item (key)}`.
 *
 * `items()` reads tree signals, so the reconciler runs inside an effect and
 * re-reconciles whenever the underlying data changes.
 */

import { effect } from './signal.js';
import type { Control } from './control.js';

export interface KeyedListOptions<Item> {
  /** DOM element the child controls mount into. */
  host: HTMLElement;
  /** Reactive item list (reads tree signals). */
  items: () => Item[];
  /** Stable key per item. */
  key: (item: Item) => string;
  /** Create a control for a new item (usually parent.spawn(...)). */
  create: (item: Item) => Control;
  /** Optional update hook for an existing control when its item reappears. */
  update?: (control: Control, item: Item) => void;
  /** Debug name for the underlying effect. */
  name?: string;
}

/** Returns a disposer that destroys all live children. */
export function keyedList<Item>(opts: KeyedListOptions<Item>): () => void {
  const live = new Map<string, Control>();

  const disposeEffect = effect(() => {
    const next = opts.items();
    const seen = new Set<string>();

    let anchor: ChildNode | null = null; // the previously-placed node
    for (const item of next) {
      const k = opts.key(item);
      seen.add(k);
      let c = live.get(k);
      if (!c) {
        c = opts.create(item);
        live.set(k, c);
        c.mount(opts.host);
      } else if (opts.update) {
        opts.update(c, item);
      }
      // Place c.el immediately after `anchor` (or at the front when anchor is null).
      const before: ChildNode | null = anchor ? anchor.nextSibling : opts.host.firstChild;
      if (c.el !== before) opts.host.insertBefore(c.el, before);
      anchor = c.el;
    }

    for (const [k, c] of [...live]) {
      if (!seen.has(k)) {
        c.destroy();
        live.delete(k);
      }
    }
  }, opts.name ?? 'keyedList');

  return () => {
    disposeEffect();
    for (const c of live.values()) c.destroy();
    live.clear();
  };
}
