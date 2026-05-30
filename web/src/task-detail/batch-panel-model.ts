/**
 * BatchPanelModel — the typed signal store for batch attribute edits
 * across a SELECTION of cards.
 *
 * Why this is a separate class from `PanelModel`:
 *   - Different semantic.  PanelModel's `attr(name)` answers "what is the
 *     value of `name` on the one focal task?".  BatchPanelModel answers
 *     "what is the value of `name` across the selection?" — which is
 *     `Mixed` when rows disagree.
 *   - Different commit shape.  PanelModel's commit is a single
 *     `attribute.update`; BatchPanelModel's is a FAN-OUT across the
 *     selection (with partial-failure handling).
 *
 * Per the project's composition principle (STRUCTURAL_PLAN): we do NOT
 * grow `PanelModel` with a `mode: 'single' | 'batch'` knob.  We build a
 * second class with focused duty.  Higher-level controls
 * (`BatchTaskEditor`) compose this with the SAME `AttributeRow` /
 * `FieldEditor` lower-level primitives `TaskAttributePanel` uses against
 * the single-card `PanelModel`.
 *
 * The shared primitive is the contract — `Signal<LoadState<T>>` — and
 * `AttributeRow` reads through it the same way regardless of which store
 * sits behind it.
 */

import { signal, type Signal } from '../core/signal.js';
import {
  Unset,
  Mixed,
  loaded,
  pendingValue,
  errored,
  type LoadState,
} from '../core/load-state.js';
import { isMeaningful } from './panel-model.js';

/* -------------------------------------------------------------------------- */
/* Types.                                                                      */
/* -------------------------------------------------------------------------- */

/** State of one attribute across the selection. */
export type BatchAttrSignal = Signal<LoadState<unknown>>;

/** Outcome of a fan-out commit: how many rows landed cleanly. */
export interface FanOutResult {
  /** Rows the server confirmed. */
  ok: number;
  /** Rows the server rejected — one message per failure. */
  failed: Array<{ cardId: bigint; message: string }>;
}

/* -------------------------------------------------------------------------- */
/* BatchPanelModel.                                                            */
/* -------------------------------------------------------------------------- */

export class BatchPanelModel {
  /** The selection this model is keyed against.  Set via `setSelection`;
   *  re-seeding from the new tasks happens through `seedFromTasks`. */
  private selection: bigint[] = [];

  private readonly attrs = new Map<string, BatchAttrSignal>();

  /* ------------------------------ selection ----------------------------- */

  /** Replace the selection (typically driven by the grid's selection set).
   *  Doesn't auto-clear state — call `clear()` or `seedFromTasks()` to
   *  reseat.  Returns the new selection size. */
  setSelection(cardIds: readonly bigint[]): number {
    this.selection = [...cardIds];
    return this.selection.length;
  }

  /** The current selection (defensive copy). */
  selectedCards(): bigint[] {
    return [...this.selection];
  }

  /** Drop every attribute signal — used when the selection size goes to 0
   *  or the user explicitly clears the panel. */
  clear(): void {
    for (const s of this.attrs.values()) s.set(Unset);
  }

  /* ------------------------------ attrs --------------------------------- */

  /** Get-or-create the signal for an attribute's state. */
  attr(name: string): BatchAttrSignal {
    let s = this.attrs.get(name);
    if (s === undefined) {
      s = signal<LoadState<unknown>>(Unset, `batchPanel.attr.${name}`);
      this.attrs.set(name, s);
    }
    return s;
  }

  /**
   * Seed an attribute's state from a list of values across the selection.
   * Folds the rule:
   *
   *   - every value is Unset (null/empty)             → Unset
   *   - every meaningful value is === the same `v`    → Value(v)
   *   - the meaningful values disagree                → Mixed
   *
   * Equality is by `Object.is` for scalars and by stringified id for
   * bigints (so a wire-revived `42n` and a digit-string `"42"` collapse).
   */
  seedAttrAcross(name: string, values: readonly unknown[]): void {
    const meaningful = values.filter(isMeaningful);
    if (meaningful.length === 0) {
      this.attr(name).set(Unset);
      return;
    }
    const canonical = canonicalize(meaningful[0]);
    let agree = true;
    for (let i = 1; i < meaningful.length; i++) {
      if (canonicalize(meaningful[i]) !== canonical) {
        agree = false;
        break;
      }
    }
    if (!agree) {
      this.attr(name).set(Mixed);
      return;
    }
    // All rows agree — emit the raw value (not the canonical key).
    this.attr(name).set(loaded(meaningful[0]));
  }

  /** Bulk-seed every attribute appearing in any of the passed tasks.  An
   *  attribute not present on a task is treated as Unset for that task. */
  seedFromTasks(
    attributeNames: readonly string[],
    tasks: ReadonlyArray<{ attributes: Record<string, unknown> }>,
  ): void {
    for (const name of attributeNames) {
      const vals = tasks.map((t) => t.attributes[name]);
      this.seedAttrAcross(name, vals);
    }
  }

  /* ------------------------------ commit -------------------------------- */

  /** Begin an optimistic fan-out: every row's panel sees Pending(v).  The
   *  parent does the actual fan-out call; on settle it calls confirm or
   *  reject with the outcome. */
  beginCommit(name: string, nextValue: unknown): void {
    this.attr(name).set(pendingValue(nextValue));
  }

  /**
   * Settle a fan-out.  Inputs:
   *
   *   - `result.ok > 0 && result.failed.length === 0`  → Value(applied)
   *     (the selection is now homogeneous on this attr)
   *   - `result.failed.length > 0 && result.ok > 0`    → Error("N of M
   *     saved; …") with `previousValue` as the carried fallback (best-
   *     effort: rows that failed keep the old value; rows that succeeded
   *     have the new one — strictly the selection is Mixed afterwards).
   *     The `panel.refreshFromTasks()` follow-up reconciles.
   *   - `result.failed.length === total`               → Error("none
   *     saved") carrying `previousValue` as the unanimous fallback.
   */
  settleCommit(
    name: string,
    appliedValue: unknown,
    previousValue: unknown,
    result: FanOutResult,
  ): void {
    const total = result.ok + result.failed.length;
    if (result.failed.length === 0) {
      this.attr(name).set(
        isMeaningful(appliedValue) ? loaded(appliedValue) : Unset,
      );
      return;
    }
    if (result.ok === 0) {
      this.attr(name).set(
        errored(
          'No rows saved. ' + (result.failed[0]?.message ?? 'Try again.'),
          isMeaningful(previousValue) ? previousValue : undefined,
        ),
      );
      return;
    }
    // Partial — surface a summary; the caller can re-seed from a refresh
    // to get the precise per-row truth back into the model.
    this.attr(name).set(
      errored(
        `${result.ok} of ${total} saved; ${result.failed.length} failed.`,
        isMeaningful(previousValue) ? previousValue : undefined,
      ),
    );
  }

  /** Dismiss an error and return the attribute to Value/Unset.  The caller
   *  reseeds from a refresh if it wants the canonical post-fan-out state. */
  clearError(name: string): void {
    const s = this.attr(name);
    const cur = s.peek();
    if (cur.kind !== 'error') return;
    s.set(cur.value !== undefined ? loaded(cur.value) : Unset);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                    */
/* -------------------------------------------------------------------------- */

/** Reduce a value to a string key for equality testing across the selection.
 *  `42n` / `42` / `"42"` collapse to `"42"`; primitives stringify; arrays
 *  + objects fall back to a stable JSON-ish form.  Pure. */
function canonicalize(v: unknown): string {
  if (v === null || v === undefined) return ' unset';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  return JSON.stringify(v);
}
