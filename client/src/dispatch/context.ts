/**
 * Svelte 5 context helpers for the {@link Dispatcher}.
 *
 * The App root calls {@link setDispatcher} once during boot; every screen /
 * component reaches the dispatcher via {@link getDispatcher}, which throws if
 * the context was never set (saves us from `dispatcher!` non-null assertions
 * scattered across screens).
 */

import { getContext, setContext } from 'svelte';

import { Dispatcher } from './dispatcher.js';

const KEY: symbol = Symbol('kitp.dispatcher');

/** Provide a {@link Dispatcher} to descendant components. Call once at root. */
export function setDispatcher(d: Dispatcher): void {
  setContext(KEY, d);
}

/** Resolve the dispatcher provided by an ancestor. Throws when missing. */
export function getDispatcher(): Dispatcher {
  const d = getContext<Dispatcher | undefined>(KEY);
  if (d === undefined) {
    throw new Error(
      'getDispatcher(): no Dispatcher in context — did you forget to call setDispatcher() at the App root?',
    );
  }
  return d;
}
