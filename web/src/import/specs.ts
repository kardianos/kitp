/**
 * Project-import API specs — the four `project.import.*` handlers backing the
 * CSV import wizard (#41). Declared up front and registered via `api.define`,
 * addressed by the wizard's `callByName` through their `endpoint.action` string
 * keys. They target the REAL `/api/v1/batch` wire and match the Go handlers'
 * input/output shapes verbatim
 * (server/internal/dom/projectimport/projectimport.go +
 *  db/schema/functions/project_import_*_batch.sql):
 *
 *   - project.import.upload  (project_import_upload_batch.sql)
 *       in : { project_id, file_id }   — ids are wire strings
 *       out: { job_id, headers: string[], preview_rows: string[][], row_count }
 *     The CSV reaches the server by FILE ID: the wizard first uploads the .csv
 *     to CAS + materialises it via `file.create` (single chunk — CSVs sit well
 *     under the chunk cap; see {@link uploadCsv}), then passes the file_id here.
 *     The Go PreRun hook reads the bytes by file_id, parses header + first 20
 *     rows + total count, and injects them so the SQL function walks JSON.
 *   - project.import.set_mapping  (project_import_set_mapping_batch.sql)
 *       in : { job_id, mapping: { <csv header> -> <target attr | '_ignore_'> } }
 *       out: { ok, status }   — status advances 'uploaded' -> 'mapped'.
 *   - project.import.preview  (project_import_preview_batch.sql)
 *       in : { job_id, resolution: { persons?, milestones?, components?, tags? } }
 *       out: { would_create:{tasks,persons,milestones,components,tags},
 *              errors:[{row,column?,message}], skipped_rows, processed_rows,
 *              status }   — dry-run; advances status -> 'previewed'.
 *   - project.import.commit  (project_import_commit_batch.sql)
 *       in : { job_id }   — mapping + resolution are read off the job row.
 *       out: { created:{...}, errors:[...], status:'completed', skipped_rows,
 *              processed_rows }
 *
 * Every id field is a JSON string on the wire; the dispatcher revives id-shaped
 * keys (`*_id`, `id`) to bigint. The encoders take the camelCase surface the
 * wizard assembles and emit the server's snake_case keys; the decoders
 * normalise rows into the wizard's camelCase model and stay defensive about
 * either string or bigint id forms.
 */

import type { Api } from '../core/api.js';

/* -------------------------------------------------------------------------- */
/* Spec keys (addressed by the wizard's callByName).                           */
/* -------------------------------------------------------------------------- */

export const IMPORT_SPEC = {
  upload: 'project.import.upload',
  setMapping: 'project.import.set_mapping',
  preview: 'project.import.preview',
  commit: 'project.import.commit',
} as const;

/* -------------------------------------------------------------------------- */
/* Mapping target attributes + resolution modes.                               */
/* -------------------------------------------------------------------------- */

/** The closed list of task columns a CSV column may map to (mirrors the SQL
 *  function's `_allowed_targets`). */
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

/** The per-category instruction for unknown referenced values during commit. */
export type ResolutionMode = 'match_existing' | 'auto_create' | 'skip' | 'leave_blank';

/** The categories the resolution step configures (server-validated). */
export const RESOLUTION_CATEGORIES = ['persons', 'milestones', 'components', 'tags'] as const;
export type ResolutionCategory = (typeof RESOLUTION_CATEGORIES)[number];

export interface ImportResolution {
  persons?: ResolutionMode;
  milestones?: ResolutionMode;
  components?: ResolutionMode;
  tags?: ResolutionMode;
}

/* -------------------------------------------------------------------------- */
/* Input/output types (the camelCase surface the wizard assembles / consumes). */
/* -------------------------------------------------------------------------- */

export interface UploadInput {
  projectId: bigint;
  fileId: bigint;
}
export interface UploadOutput {
  jobId: bigint;
  headers: string[];
  previewRows: string[][];
  rowCount: number;
}

export interface SetMappingInput {
  jobId: bigint;
  mapping: Record<string, string>;
}
export interface SetMappingOutput {
  ok: boolean;
  status: string;
}

export interface ImportError {
  row: number;
  column?: string;
  message: string;
}

/** would_create (preview) / created (commit) share this count shape. */
export interface ImportCounts {
  tasks: number;
  persons: number;
  milestones: number;
  components: number;
  tags: number;
}

export interface PreviewInput {
  jobId: bigint;
  resolution: ImportResolution;
}
export interface PreviewOutput {
  wouldCreate: ImportCounts;
  errors: ImportError[];
  skippedRows: number;
  processedRows: number;
  status: string;
}

export interface CommitInput {
  jobId: bigint;
}
export interface CommitOutput {
  created: ImportCounts;
  errors: ImportError[];
  status: string;
  skippedRows: number;
  processedRows: number;
}

/* -------------------------------------------------------------------------- */
/* Decode helpers (defensive, no exceptions on missing fields).                */
/* -------------------------------------------------------------------------- */

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
/** Coerce a wire id (bigint after revival, or number/string) to bigint. */
function asId(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
}
function asStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (v === null || v === undefined) return '';
  return String(v);
}
function asNum(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  if (typeof v === 'bigint') return Number(v);
  return 0;
}

function decodeCounts(v: unknown): ImportCounts {
  const j = asObj(v);
  return {
    tasks: asNum(j['tasks']),
    persons: asNum(j['persons']),
    milestones: asNum(j['milestones']),
    components: asNum(j['components']),
    tags: asNum(j['tags']),
  };
}

function decodeError(v: unknown): ImportError {
  const j = asObj(v);
  const out: ImportError = { row: asNum(j['row']), message: asStr(j['message']) };
  const col = j['column'];
  if (typeof col === 'string' && col.length > 0) out.column = col;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Registration.                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Register the four project.import.* specs against `api`. Call once at boot,
 * BEFORE the wizard mounts (the wizard resolves specs by key at fire time).
 * Idempotent-by-presence so a test harness may register them first.
 */
export function registerImportSpecs(api: Api): void {
  if (!api.registry.has({ endpoint: 'project.import', action: 'upload' })) {
    api.define<UploadInput, UploadOutput>({
      endpoint: 'project.import',
      action: 'upload',
      encode: (i) => ({ project_id: i.projectId, file_id: i.fileId }),
      decode: (raw): UploadOutput => {
        const j = asObj(raw);
        return {
          jobId: asId(j['job_id']),
          headers: asArray(j['headers']).map((h) => asStr(h)),
          previewRows: asArray(j['preview_rows']).map((r) => asArray(r).map((c) => asStr(c))),
          rowCount: asNum(j['row_count']),
        };
      },
    });
  }

  if (!api.registry.has({ endpoint: 'project.import', action: 'set_mapping' })) {
    api.define<SetMappingInput, SetMappingOutput>({
      endpoint: 'project.import',
      action: 'set_mapping',
      encode: (i) => ({ job_id: i.jobId, mapping: i.mapping }),
      decode: (raw): SetMappingOutput => {
        const j = asObj(raw);
        return { ok: j['ok'] === true, status: asStr(j['status']) };
      },
    });
  }

  if (!api.registry.has({ endpoint: 'project.import', action: 'preview' })) {
    api.define<PreviewInput, PreviewOutput>({
      endpoint: 'project.import',
      action: 'preview',
      encode: (i) => ({ job_id: i.jobId, resolution: encodeResolution(i.resolution) }),
      decode: (raw): PreviewOutput => {
        const j = asObj(raw);
        return {
          wouldCreate: decodeCounts(j['would_create']),
          errors: asArray(j['errors']).map(decodeError),
          skippedRows: asNum(j['skipped_rows']),
          processedRows: asNum(j['processed_rows']),
          status: asStr(j['status']),
        };
      },
    });
  }

  if (!api.registry.has({ endpoint: 'project.import', action: 'commit' })) {
    api.define<CommitInput, CommitOutput>({
      endpoint: 'project.import',
      action: 'commit',
      encode: (i) => ({ job_id: i.jobId }),
      decode: (raw): CommitOutput => {
        const j = asObj(raw);
        return {
          created: decodeCounts(j['created']),
          errors: asArray(j['errors']).map(decodeError),
          status: asStr(j['status']),
          skippedRows: asNum(j['skipped_rows']),
          processedRows: asNum(j['processed_rows']),
        };
      },
    });
  }
}

/** Emit only the set resolution modes (the server defaults empty → match). */
function encodeResolution(r: ImportResolution): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cat of RESOLUTION_CATEGORIES) {
    const mode = r[cat];
    if (mode !== undefined) out[cat] = mode;
  }
  return out;
}
