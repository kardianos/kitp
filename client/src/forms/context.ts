/**
 * Form context — the data environment a <Form> establishes for its
 * descendant controls. Controls reach this via getFormContext() and
 * never own state themselves.
 *
 * Shape:
 *   - draft       — a Svelte 5 $state proxy of the input payload.
 *                   Controls read/write `draft[path]` directly.
 *   - schema      — the JSON Schema for the handler's input (from
 *                   schemaStore). Drives validation + per-field
 *                   metadata (description, required, format).
 *   - errors      — current validation / submission errors keyed by
 *                   field path. Controls render the entry at their
 *                   own path; the form re-validates on submit.
 *   - dirty       — true once any control has written to draft.
 *   - submitting  — true while submit() is in flight.
 *   - submit      — runs validation, dispatches if clean, captures
 *                   server errors back into the errors map.
 *   - setError    — programmatic per-field error setter (rare; used
 *                   when a control needs to report a parse failure
 *                   the schema can't catch).
 */

import { getContext, setContext } from 'svelte';
import type { JSONSchema } from '../reg/types';

/** Walk a JSON Schema by dotted path. Stops at the first missing
 *  segment. Used by the form kernel and exported for any consumer
 *  that needs the same logic (e.g. a custom control). */
export function walkSchema(schema: JSONSchema | undefined, path: string): JSONSchema | undefined {
  if (!schema) return undefined;
  if (!path) return schema;
  let cur: JSONSchema | undefined = schema;
  for (const seg of path.split('.')) {
    cur = cur?.properties?.[seg];
    if (!cur) return undefined;
  }
  return cur;
}

const KEY: symbol = Symbol('kitp.form');

export interface FormContext {
  /** Wire endpoint (e.g. "activity_sink"). */
  endpoint: string;
  /** Wire action (e.g. "set"). */
  action: string;
  /** Input JSON Schema from the server catalogue. May be undefined
   *  during the brief window before catalog load completes. */
  schema: JSONSchema | undefined;
  /** Reactive draft — controls read/write directly. */
  draft: Record<string, unknown>;
  /** Current field errors. */
  errors: Record<string, string>;
  /** Form-level (non-field) error message, or null. */
  formError: string | null;
  dirty: boolean;
  submitting: boolean;
  submit: () => Promise<void>;
  setError: (path: string, msg: string | null) => void;
  /** Read the value at a field path, with optional default. */
  get: (path: string) => unknown;
  /** Write a value at a field path; also flips dirty=true. */
  set: (path: string, value: unknown) => void;
  /** Resolve the JSON Schema for a field path. Walks dotted paths
   *  into nested object schemas (e.g. "resolution.persons" descends
   *  into resolution's `properties.persons`). Returns undefined if
   *  the field doesn't exist in the schema. */
  fieldSchema: (path: string) => JSONSchema | undefined;
  /** True when `path` is in the root schema's `required` list. Does
   *  NOT currently traverse into nested-object required lists — only
   *  top-level requireds. */
  isRequired: (path: string) => boolean;
}

export function setFormContext(ctx: FormContext): void {
  setContext(KEY, ctx);
}

export function getFormContext(): FormContext {
  const c = getContext<FormContext | undefined>(KEY);
  if (c === undefined) {
    throw new Error(
      'getFormContext(): no Form in context — wrap your control in <Form spec="...">.',
    );
  }
  return c;
}

/** Returns null when no Form ancestor — for controls that want to be
 *  usable both inside and outside a Form (rare; most should require
 *  the context). */
export function tryFormContext(): FormContext | null {
  return getContext<FormContext | undefined>(KEY) ?? null;
}
