/**
 * SchemaStore — fetches the server's handler catalogue once at app
 * boot and caches it for the form kernel.
 *
 * The server publishes every registered handler (endpoint, action,
 * doc, allowed_roles, input/output JSON Schema) via proc.search.
 * Schemas are generated from Go struct tags (see docs/mcp-tags.md v2)
 * so the catalogue is the single source of truth for field shape,
 * required fields, format hints, length/value bounds, etc.
 *
 * Lifecycle:
 *   - main.ts calls `loadHandlerCatalog(dispatcher)` once after
 *     dispatcher init.
 *   - Forms read via `schemaStore.handler(endpoint, action)`.
 *   - Tests can seed via `schemaStore.seed(handlers)` without
 *     touching the dispatcher.
 *
 * The store is a Svelte 5 $state singleton — `ready` flips true once
 * the fetch resolves so `<Form>` can show a spinner instead of
 * rendering empty.
 */

import type { Dispatcher } from '../dispatch/dispatcher';
import { procSearch } from '../reg/handlers';
import type {
  HandlerDescriptor,
  JSONSchema,
  ProcSearchInput,
  ProcSearchOutput,
} from '../reg/types';

interface State {
  ready: boolean;
  error: string | null;
  byKey: Map<string, HandlerDescriptor>;
}

function makeState(): State {
  return { ready: false, error: null, byKey: new Map() };
}

const state = $state<State>(makeState());

function key(endpoint: string, action: string): string {
  return `${endpoint}.${action}`;
}

/**
 * Schema-store reads. `handler()` returns undefined when no entry is
 * cached (either the catalogue hasn't loaded yet OR the caller has
 * no role to invoke the handler — proc.search filters by default).
 */
export const schemaStore = {
  get ready(): boolean {
    return state.ready;
  },
  get error(): string | null {
    return state.error;
  },
  handler(endpoint: string, action: string): HandlerDescriptor | undefined {
    return state.byKey.get(key(endpoint, action));
  },
  inputSchema(endpoint: string, action: string): JSONSchema | undefined {
    return this.handler(endpoint, action)?.input_schema;
  },
  outputSchema(endpoint: string, action: string): JSONSchema | undefined {
    return this.handler(endpoint, action)?.output_schema;
  },
  /** Seed the store directly — for tests. Marks ready=true. */
  seed(handlers: HandlerDescriptor[]): void {
    state.byKey.clear();
    for (const h of handlers) state.byKey.set(key(h.endpoint, h.action), h);
    state.ready = true;
    state.error = null;
  },
  reset(): void {
    state.byKey.clear();
    state.ready = false;
    state.error = null;
  },
};

/**
 * Boot-time fetch. Call once from main.ts after the dispatcher is in
 * scope. Idempotent — re-calling refetches and replaces the cache.
 */
export async function loadHandlerCatalog(dispatcher: Dispatcher): Promise<void> {
  try {
    const out = await dispatcher.request<ProcSearchInput, ProcSearchOutput>({
      endpoint: procSearch.endpoint,
      action: procSearch.action,
      data: { all: true },
    });
    state.byKey.clear();
    for (const h of out.handlers) state.byKey.set(key(h.endpoint, h.action), h);
    state.ready = true;
    state.error = null;
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
    state.ready = true; // we still flip ready so forms can surface the error
  }
}
