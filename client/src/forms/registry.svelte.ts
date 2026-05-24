/**
 * Form registry — lets <SubmitButton formId="..."> reach a <Form> that
 * lives outside its own DOM subtree (typical case: a Modal/SlideOver
 * footer renders in a `footer` snippet which is a SIBLING of the
 * children tree, not a descendant, so Svelte context doesn't reach).
 *
 * Form opt-in via `id` prop. Without an id, the registry isn't
 * touched and SubmitButton uses context as before. Two forms can't
 * share the same id (the registry warns and the second wins —
 * unmount order shouldn't matter in practice because forms are
 * dialog-scoped).
 */

import type { FormContext } from './context';

const byId = new Map<string, FormContext>();

export function registerForm(id: string, ctx: FormContext): void {
  if (byId.has(id)) {
    console.warn(`[forms] duplicate form id "${id}" — second registration wins`);
  }
  byId.set(id, ctx);
}

export function unregisterForm(id: string): void {
  byId.delete(id);
}

export function lookupForm(id: string): FormContext | undefined {
  return byId.get(id);
}
