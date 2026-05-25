/**
 * Pure helpers + the CSV-upload callback for the import wizard. The wizard
 * control owns rendering + the step machine; this module owns:
 *
 *   - the auto-mapping heuristic for the column-mapping step (snake_case match
 *     against the known target attributes — anything else lands on `_ignore_`
 *     so the user explicitly opts each column in);
 *   - {@link uploadCsv}, which gets the picked .csv to the server as a `file`
 *     row by reusing the shared {@link prepareFile} pipeline (SHA-256 chunk →
 *     cas.missing_chunks → POST /cas/chunk → file.create) and surfaces the
 *     resulting file id through a callback (NO promise crosses the surface —
 *     same zero-promise posture as the rest of the framework). The wizard then
 *     hands that file id to `project.import.upload`.
 *
 * Tests cover the auto-mapping rules + the wizard's step machine end-to-end;
 * the upload path reuses the CAS pipeline already exercised in
 * `task-detail/upload.ts`.
 */

import type { Api } from '../core/api.js';
import { prepareFile, type PostChunk } from '../task-detail/upload.js';
import { IGNORE_COLUMN, TARGET_ATTRS } from './specs.js';

/* -------------------------------------------------------------------------- */
/* Auto-mapping                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort mapping from CSV header names to target attribute names.
 * Snake-case match (case-insensitive, spaces/dashes → underscore); anything
 * that doesn't match a known target lands as IGNORE_COLUMN. Mirrors the Svelte
 * client's `autoMapping`.
 */
export function autoMapping(headers: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const canon = new Set(TARGET_ATTRS.map((s) => s.toLowerCase()));
  for (const h of headers) {
    const key = h.trim().toLowerCase().replace(/[\s-]+/g, '_');
    out[h] = canon.has(key) ? key : IGNORE_COLUMN;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* CSV upload (CAS file pipeline → file id)                                    */
/* -------------------------------------------------------------------------- */

export interface UploadCsvCallbacks {
  /** Success: the materialised file's bigint id (the upload step's bind target). */
  onDone: (fileId: bigint) => void;
  /** Failure: a single Error describing the first fatal step. */
  onError: (e: Error) => void;
  /** A liveness gate so a torn-down wizard's callbacks are dropped. */
  alive?: () => boolean;
  /** Inject the raw chunk-POST sink (tests pass an in-memory CAS store). */
  postChunk?: PostChunk;
}

/**
 * Upload one CSV `File` to CAS + materialise it via `file.create`, yielding the
 * new file id. A thin wrapper over the shared {@link prepareFile} pipeline (so
 * the chunking / dedup / file.create wire shape stays in one place); the only
 * job here is to narrow the result to the file id the wizard needs. Callback
 * surface — no promise escapes.
 */
export function uploadCsv(api: Api, file: File, cb: UploadCsvCallbacks): void {
  prepareFile(api, file, {
    ...(cb.alive ? { alive: cb.alive } : {}),
    ...(cb.postChunk ? { postChunk: cb.postChunk } : {}),
    onDone: (fileOut) => cb.onDone(fileOut.id),
    onError: (e) => cb.onError(e),
  });
}
