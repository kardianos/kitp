/**
 * LoadState — the tri-state lifecycle every async-loaded or async-commit
 * value moves through.
 *
 * Modelling "is there a value, and what state is it in?" EXPLICITLY rather
 * than overloading `null` / `undefined` / `''` sentinels.  Those sentinels
 * collide with legitimate values (a deliberately-cleared attribute is null
 * too; a not-yet-loaded label is undefined too) and force every renderer
 * to derive the lifecycle ad-hoc.  That's where the flicker comes from:
 * `bindProp(disabled, () => !value())` reads the raw value and so flips
 * the moment the value swings through null during an optimistic commit.
 *
 * With `LoadState<T>` the renderer reads the LIFECYCLE, not the raw value:
 *
 *   bindClass(el, 'is-pending', () => isPending(state.get()));
 *   bindProp(btn, 'disabled', () => !isResolved(state.get()) ||
 *                                   !hasMeaningfulValue(valueOf(state.get())));
 *
 * Now the button stays "pending" for the entire round trip — no flicker.
 *
 * Lifecycle:
 *
 *   Unset          ──beginCommit──▶ Pending(next)
 *                                       │
 *                          confirmCommit │
 *                                       ▼
 *                                    Value(next)
 *                                       │
 *                          beginCommit  │
 *                                       ▼
 *                                   Pending(next2) ──reject──▶ Error(prev, msg)
 *
 *   The 'Error' state remembers the value to RESTORE (the prior committed
 *   value) and the message; `clearError` returns it to Value/Unset.
 */

/* -------------------------------------------------------------------------- */
/* The union.                                                                  */
/* -------------------------------------------------------------------------- */

export type LoadState<T> =
  | { kind: 'unset' }
  | { kind: 'pending'; value: T }
  | { kind: 'value'; value: T }
  | { kind: 'mixed' }
  | { kind: 'error'; value: T | undefined; message: string };

/**
 * `Mixed` exists for the batch-edit case: a selection where rows DISAGREE on
 * the attribute's current value.  No single display value applies — the
 * renderer shows a "[mixed]" placeholder.  Distinct from `Unset` (which
 * means "no value anywhere") and from `Value(v)` (which means "every row
 * agrees on v").  Adding it as an explicit kind keeps every consumer
 * branching on `state.kind` instead of inferring heterogeneity ad-hoc.
 */

/* -------------------------------------------------------------------------- */
/* Constructors — frozen Unset singleton + the value-bearing constructors.    */
/* -------------------------------------------------------------------------- */

/** The singleton "no value here" state. Frozen so accidental mutation throws. */
export const Unset: LoadState<never> = Object.freeze({ kind: 'unset' });

/** The singleton "selection disagrees" state for batch edit. Frozen. */
export const Mixed: LoadState<never> = Object.freeze({ kind: 'mixed' });

/** Optimistic in-flight value: rendered, but the renderer should mark it
 *  busy (disabled controls, soft tone) until {@link confirmValue} lands. */
export function pendingValue<T>(value: T): LoadState<T> {
  return { kind: 'pending', value };
}

/** Confirmed value — the renderer is free to take it at face value. */
export function loaded<T>(value: T): LoadState<T> {
  return { kind: 'value', value };
}

/** Confirm a transition: returns Value if the input was Pending, otherwise
 *  forwards unchanged. The "server agreed" path. */
export function confirmValue<T>(s: LoadState<T>): LoadState<T> {
  return s.kind === 'pending' ? loaded(s.value) : s;
}

/** Failed commit — the renderer surfaces the message and falls back to
 *  the carried value (the PRIOR confirmed value, so the row reverts). */
export function errored<T>(message: string, fallback: T | undefined): LoadState<T> {
  return { kind: 'error', value: fallback, message };
}

/* -------------------------------------------------------------------------- */
/* Predicates — read the lifecycle without unwrapping the union by hand.      */
/* -------------------------------------------------------------------------- */

export function isUnset<T>(s: LoadState<T>): boolean {
  return s.kind === 'unset';
}
export function isPending<T>(s: LoadState<T>): boolean {
  return s.kind === 'pending';
}
export function isResolved<T>(s: LoadState<T>): boolean {
  return s.kind === 'value';
}
export function isMixed<T>(s: LoadState<T>): boolean {
  return s.kind === 'mixed';
}
export function isError<T>(s: LoadState<T>): boolean {
  return s.kind === 'error';
}
/** Anything except Unset / Mixed has a single displayable value. */
export function hasValue<T>(s: LoadState<T>): boolean {
  return s.kind === 'pending' || s.kind === 'value' || (s.kind === 'error' && s.value !== undefined);
}

/* -------------------------------------------------------------------------- */
/* Accessors.                                                                  */
/* -------------------------------------------------------------------------- */

/** Pull a displayable value out of a state. `undefined` for Unset / Mixed
 *  (and for Error with no fallback). The renderer's branch on whether to
 *  show '—' / '[mixed]'. */
export function valueOf<T>(s: LoadState<T>): T | undefined {
  switch (s.kind) {
    case 'unset':
      return undefined;
    case 'pending':
      return s.value;
    case 'value':
      return s.value;
    case 'mixed':
      return undefined;
    case 'error':
      return s.value;
  }
}

/** Pull the error message out (only for Error). */
export function errorOf<T>(s: LoadState<T>): string | undefined {
  return s.kind === 'error' ? s.message : undefined;
}
