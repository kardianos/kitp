/**
 * Data tree — a path-addressed, signal-backed reactive state document.
 *
 * One observable document where every node is signal-backed. Server batch
 * results land by path; controls subscribe to subtrees by reading a node's
 * leaf inside an effect/computed. Replaces the Svelte client's scattering of
 * per-store rune classes with one addressable structure.
 *
 * How batch results land:
 *   tree.at(['screens', slug, 'tasks']).set(out.rows)   // leaf/array replace
 *   tree.at(['screens', slug]).merge(out)               // structural merge
 *
 * How controls subscribe:
 *   this.effect(() => { rowsEl.replaceChildren(...render(node.get())); });
 * Reading `node.get()` registers a dependency; only that path's change
 * re-runs the effect, and only the DOM it patches updates.
 */

import { Signal, signal, batch, type ReadonlySignal } from './signal.js';

export type PathSeg = string | number;
export type Path = readonly PathSeg[];

export class TreeNode {
  private readonly childMap = new Map<string, TreeNode>();
  private readonly leaf: Signal<unknown>;

  constructor(
    initial: unknown,
    readonly path: Path,
  ) {
    this.leaf = signal(initial, `tree:${path.join('.') || '<root>'}`);
  }

  /** Get-or-create the child node for `key`. */
  child(key: PathSeg): TreeNode {
    const k = String(key);
    let c = this.childMap.get(k);
    if (!c) {
      c = new TreeNode(undefined, [...this.path, key]);
      this.childMap.set(k, c);
    }
    return c;
  }

  /** Navigate (creating) a relative path. `at([])` returns this node. */
  at(path: Path): TreeNode {
    let n: TreeNode = this;
    for (const k of path) n = n.child(k);
    return n;
  }

  /** Reactive read of this node's leaf. Registers a dependency. */
  get<T = unknown>(): T {
    return this.leaf.get() as T;
  }

  /** Non-reactive snapshot of this node's leaf (no subscription). */
  peek<T = unknown>(): T {
    return this.leaf.peek() as T;
  }

  /** Write this node's leaf. Object.is gate: equal writes don't propagate. */
  set(value: unknown): void {
    this.leaf.set(value);
  }

  /**
   * Land a server value into this subtree. Plain objects recurse into named
   * children (structural sharing — only changed nodes bump); arrays and
   * primitives replace this leaf. Everything happens in one batch() so a
   * multi-field merge flushes once.
   */
  merge(value: unknown): void {
    batch(() => {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          this.child(k).merge(v);
        }
      } else {
        this.set(value);
      }
    });
  }
}

/** The single application data tree. */
export const tree = new TreeNode({}, []);

/**
 * A tree transaction for optimistic UI. Snapshots the node's current leaf,
 * applies `patch` immediately (one batch), and returns commit/rollback.
 * On failure, `rollback()` restores the snapshot in a single write — the
 * signal's Object.is gate means untouched siblings never churn.
 *
 *   const txn = optimistic(tasksNode, (cur) => applyMove(cur, ...));
 *   call(AttributeUpdate, ops, () => txn.commit());   // success: server overwrites on next read
 *   // on fault (via the centralized funnel) the caller invokes txn.rollback()
 */
export interface TreeTxn {
  commit(): void;
  rollback(): void;
}

export function optimistic<T>(node: TreeNode, patch: (cur: T) => T): TreeTxn {
  const snapshot = node.peek<T>();
  let settled = false;
  batch(() => node.set(patch(snapshot)));
  return {
    commit(): void {
      settled = true; // nothing to do: the next server read/merge overwrites
    },
    rollback(): void {
      if (settled) return;
      settled = true;
      batch(() => node.set(snapshot));
    },
  };
}

/** Convenience: a ReadonlySignal-like view of a node's leaf for binding. */
export function bind<T>(node: TreeNode): ReadonlySignal<T> {
  return {
    get: () => node.get<T>(),
    peek: () => node.peek<T>(),
  };
}
