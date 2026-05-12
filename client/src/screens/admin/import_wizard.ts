/**
 * Pure helpers for the project-import wizard. The Svelte component
 * stays focused on rendering; this module owns:
 *
 *   - wire types for the three dispatcher endpoints
 *     (`project.import.upload` / `.set_mapping` / `.preview`),
 *   - a single-chunk CSV uploader that hits `/api/v1/cas/chunk`
 *     directly and resolves to a `file_id` via `file.create`,
 *   - the auto-mapping heuristic for the column-mapping step
 *     (snake_case match against the known target attributes).
 *
 * Tests cover the auto-mapping rules — the upload path uses the
 * existing CAS route exercised in `attachments/upload.ts`.
 */
import type { AuthState } from '../../auth/auth_state.svelte';
import type { Dispatcher } from '../../dispatch/dispatcher.js';
import { KITP_API_BASE } from '../../env';
import { fileCreate } from '../../reg/handlers.js';
import type { FileCreateInput, FileCreateOutput, ID } from '../../reg/types.js';

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                */
/* -------------------------------------------------------------------------- */

export interface ImportUploadInput {
  projectId: ID;
  fileId: ID;
}
export interface ImportUploadOutput {
  jobId: ID;
  headers: string[];
  previewRows: string[][];
  rowCount: number;
}

export interface ImportSetMappingInput {
  jobId: ID;
  mapping: Record<string, string>;
}
export interface ImportSetMappingOutput {
  ok: boolean;
  status: string;
}

export type ResolutionMode =
  | 'match_existing'
  | 'auto_create'
  | 'skip'
  | 'leave_blank';

export interface ImportResolution {
  persons?: ResolutionMode;
  milestones?: ResolutionMode;
  components?: ResolutionMode;
  tags?: ResolutionMode;
  /** Statuses only allow match_existing or skip. */
  statuses?: 'match_existing' | 'skip';
}

export interface ImportPreviewInput {
  jobId: ID;
  resolution: ImportResolution;
}
export interface ImportPreviewError {
  row: number;
  column?: string;
  message: string;
}
export interface ImportPreviewOutput {
  wouldCreate: {
    tasks: number;
    persons: number;
    milestones: number;
    components: number;
    tags: number;
  };
  errors: ImportPreviewError[];
  skippedRows: number;
  processedRows: number;
  status: string;
}

export interface ImportCommitInput {
  jobId: ID;
}

export interface ImportCommitOutput {
  created: {
    tasks: number;
    persons: number;
    milestones: number;
    components: number;
    tags: number;
  };
  errors: ImportPreviewError[];
  status: string;
  skippedRows: number;
  processedRows: number;
}

/** The closed list of target attribute names the importer accepts. */
export const TARGET_ATTRS: readonly string[] = [
  'id',
  'title',
  'assignee_email',
  'assignee_name',
  'milestone',
  'component',
  'tags',
  'description',
  'sort_order',
] as const;

/** Sentinel value the mapping uses to drop a column. */
export const IGNORE_COLUMN = '_ignore_';

/* -------------------------------------------------------------------------- */
/* Auto-mapping                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort mapping from CSV header names to target attribute names.
 * Snake-case match (case-insensitive); anything that doesn't match
 * lands as IGNORE_COLUMN so the user explicitly opts each column in.
 */
export function autoMapping(headers: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const canon = new Set(TARGET_ATTRS.map((s) => s.toLowerCase()));
  for (const h of headers) {
    const key = h.trim().toLowerCase().replace(/[\s\-]+/g, '_');
    if (canon.has(key)) {
      out[h] = key;
    } else {
      out[h] = IGNORE_COLUMN;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Upload (single-chunk)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Upload one CSV `File` to CAS as a single chunk and resolve the
 * created `file_id`. CSVs in practice are well under the chunk cap
 * (default 8 MB); larger uploads should fall back to the multi-chunk
 * helper in `attachments/upload.ts`.
 */
export async function uploadCsvFile(
  file: File,
  dispatcher: Dispatcher,
  authState: AuthState | null,
  fetchImpl?: typeof fetch,
): Promise<ID> {
  void authState; // BFF cookie carries the credential; kept on the
                  // signature for compatibility with call sites that
                  // still thread an AuthState through.
  const f = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const headers: Record<string, string> = {
    'Content-Type': file.type || 'text/csv',
  };
  const resp = await f(`${KITP_API_BASE}/api/v1/cas/chunk`, {
    method: 'POST',
    headers,
    body: file,
    credentials: 'same-origin',
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`chunk upload failed: ${resp.status} ${text}`);
  }
  const chunk = (await resp.json()) as { address: string; size_bytes: number };
  const fileOut = await dispatcher.request<FileCreateInput, FileCreateOutput>({
    endpoint: fileCreate.endpoint,
    action: fileCreate.action,
    data: {
      filename: file.name,
      mimeType: file.type || 'text/csv',
      chunks: [{ address: chunk.address, size_bytes: chunk.size_bytes }],
    },
  });
  return fileOut.id;
}
