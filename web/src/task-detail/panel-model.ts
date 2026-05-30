/**
 * PanelModel — the typed store backing the TaskDetail attribute panel.
 *
 * Collapses what was previously THREE ad-hoc stores in the TaskDetail
 * control — `panelVersion: Signal<number>`, `attrErrors: Map<name, string>`,
 * `refLabels: Map<idStr, string>` — into one declared model where every
 * piece of state has a typed `Signal<LoadState<T>>`.
 *
 * Why this exists:
 *
 *   - Eliminates the "did I remember to bump panelVersion?" footgun. Each
 *     piece of state IS a signal; readers subscribe directly.
 *   - Eliminates the flicker class of bug. Consumers read the lifecycle
 *     (isResolved / isPending) rather than `value() === null`, so an
 *     in-flight commit doesn't transiently flip controls between
 *     enabled / disabled.
 *   - Centralises the "is this a meaningful value?" rule (used to be
 *     duplicated between the Unassign button + the summary renderer).
 *
 * Pattern:
 *
 *   const model = new PanelModel();
 *   model.seedAttr('title', 'Wire pickers');
 *   model.beginCommit('title', 'Wire pickers v2');
 *   await server.update(...).catch(e => model.rejectCommit('title', prev, e));
 *   model.confirmCommit('title');
 *
 *   // Anywhere a row, chip, or panel renders:
 *   bindText(el, () => summary(model.attr('title').get()));
 *   bindClass(btn, 'is-busy', () => isPending(model.attr('title').get()));
 *
 * The model owns NO DOM; it's pure typed signal state.  Tested directly.
 */

import { signal, type Signal } from '../core/signal.js';
import {
  Unset,
  loaded,
  pendingValue,
  errored,
  type LoadState,
} from '../core/load-state.js';

/* -------------------------------------------------------------------------- */
/* Type aliases — readable names for the two state shapes we carry.            */
/* -------------------------------------------------------------------------- */

/** State of one editable attribute on the focal task. */
export type AttrSignal = Signal<LoadState<unknown>>;

/** State of one (targetCardType, id) → display-label lookup. */
export type RefLabelSignal = Signal<LoadState<string>>;

/* -------------------------------------------------------------------------- */
/* PanelModel.                                                                */
/* -------------------------------------------------------------------------- */

export class PanelModel {
  private readonly attrs = new Map<string, AttrSignal>();
  private readonly refLabels = new Map<string, RefLabelSignal>();

  /* ------------------------------ attrs --------------------------------- */

  /** Get-or-create the signal for an attribute's state.  Returns the
   *  same signal across calls — consumers can subscribe once and the
   *  lifecycle updates push through. */
  attr(name: string): AttrSignal {
    let s = this.attrs.get(name);
    if (s === undefined) {
      s = signal<LoadState<unknown>>(Unset, `panel.attr.${name}`);
      this.attrs.set(name, s);
    }
    return s;
  }

  /**
   * Seed an attribute's state from a server-loaded value. `null` /
   * `undefined` / `''` (and the empty-array form) collapse to `Unset` —
   * this is THE one place that question is answered for the whole panel.
   */
  seedAttr(name: string, value: unknown): void {
    this.attr(name).set(isMeaningful(value) ? loaded(value) : Unset);
  }

  /** Bulk-seed from an attributes record (a freshly-loaded task). Existing
   *  attributes not present in the record are LEFT ALONE — schema-load and
   *  task-load may run in different orders. */
  seedFromAttributes(attributes: Record<string, unknown>): void {
    for (const name of Object.keys(attributes)) {
      this.seedAttr(name, attributes[name]);
    }
  }

  /**
   * Begin an optimistic commit on this attribute.  The state goes Pending
   * (carrying the tentative value).  Consumers reading `isResolved` / the
   * disabled property see a STABLE busy state for the entire round trip —
   * no flicker as raw value swings through null.
   */
  beginCommit(name: string, nextValue: unknown): void {
    this.attr(name).set(pendingValue(nextValue));
  }

  /**
   * Confirm the optimistic commit (the server agreed).  Pending → Value;
   * other kinds pass through unchanged so a stale confirm is a no-op.
   * Returns the now-confirmed value for callers that want to side-effect.
   */
  confirmCommit(name: string): unknown {
    const s = this.attr(name);
    const cur = s.peek();
    if (cur.kind === 'pending') {
      // Pending value is Unset if it's null/empty (the user cleared the field).
      s.set(isMeaningful(cur.value) ? loaded(cur.value) : Unset);
      return cur.value;
    }
    return cur.kind === 'value' ? cur.value : undefined;
  }

  /** Reject the optimistic commit.  Reverts to `previous` + surfaces the
   *  message.  The renderer reads `errorOf(state.get())` to show it. */
  rejectCommit(name: string, previous: unknown, message: string): void {
    this.attr(name).set(
      errored(message, isMeaningful(previous) ? previous : undefined),
    );
  }

  /** Dismiss an error and return the attribute to Value (or Unset).  Used
   *  when the user starts editing again — the next commit replaces it. */
  clearError(name: string): void {
    const s = this.attr(name);
    const cur = s.peek();
    if (cur.kind !== 'error') return;
    s.set(cur.value !== undefined ? loaded(cur.value) : Unset);
  }

  /* ------------------------------ refs ---------------------------------- */

  /** Get-or-create a ref-label signal for a `(targetCardType, id)` pair.
   *  The same signal across calls so a late-arriving label pushes through
   *  to every chip currently rendering this ref. */
  refLabel(targetCardType: string, id: bigint): RefLabelSignal {
    const key = `${targetCardType}#${id.toString()}`;
    let s = this.refLabels.get(key);
    if (s === undefined) {
      s = signal<LoadState<string>>(Unset, `panel.ref.${key}`);
      this.refLabels.set(key, s);
    }
    return s;
  }

  /** Land a freshly-loaded label.  Subsequent calls reseat the value (a
   *  rename of the referenced card propagates).  Unsafe inputs (`''` /
   *  `undefined`) keep the signal in `Unset`. */
  setRefLabel(targetCardType: string, id: bigint, label: string | undefined): void {
    const s = this.refLabel(targetCardType, id);
    if (label === undefined || label === '') s.set(Unset);
    else s.set(loaded(label));
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helper exported so the renderers + tests agree on the rule.            */
/* -------------------------------------------------------------------------- */

/** Whether a raw value is "meaningful" (i.e. NOT collapsing to Unset). The
 *  one place the question is answered for the panel — the Unassign disabled
 *  state + the summary's '—' branch + seedAttr / confirmCommit all consult
 *  this same predicate. */
export function isMeaningful(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string' && v === '') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}
