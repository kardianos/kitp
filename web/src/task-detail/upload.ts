/**
 * Chunked attachment upload SERVICE — the one place in the web client that does
 * SHA-256 chunk hashing + raw out-of-batch HTTP POSTs.
 *
 * Ports the algorithm from `client/src/attachments/upload.ts` (NOT imported):
 *
 *   1. Slice the File into ≤chunkBytes pieces (Blob.slice — a view).
 *   2. Hash each chunk client-side via the Web Crypto SHA-256 digest.
 *   3. `cas.missing_chunks` pre-flight (through the batch dispatcher): ask the
 *      server which addresses it already holds so an unchanged re-upload ships
 *      zero bytes.
 *   4. POST raw bytes for the missing chunks to `/api/v1/cas/chunk`
 *      (Content-Type: application/octet-stream — NOT multipart, which added
 *      envelope overhead that pushed exactly-MaxBytes chunks over the cap). Up
 *      to CONCURRENCY chunks fly in parallel.
 *   5. `file.create` with the full chunk list → file id (through the batch).
 *   6. `attachment.create` with { cardId, fileId } → the attachment row (+ a
 *      server-side attachment_create activity row) (through the batch).
 *
 * CALLBACK CONTROL SURFACE (matches the framework's zero-promise rule). The
 * service's PUBLIC surface (`uploadFile`) takes `onProgress` / `onDone` /
 * `onError` callbacks and returns nothing — NO promise crosses the control
 * boundary. The async (crypto.subtle, fetch, the dispatcher's internal flush)
 * lives PRIVATELY inside the service, exactly like the dispatcher's transport.
 *
 * The two async dependencies are INJECTED so a test can drive the pipeline with
 * an in-memory chunk sink + the dispatcher's mock transport:
 *   - `api.callByName` for the three batch sub-requests (the team's surface),
 *   - `postChunk` for the raw octet-stream POST (defaults to a same-origin
 *     fetch, cookie auth — overridable in tests with a mock sink).
 *
 * Download / view / thumb are same-origin GETs (the server stitches chunks back
 * together); their URL builders live here too. Fetching bytes through the
 * auth'd path (rather than an `<img src>`) lets a future bearer-header scheme
 * ride along; today the kitp_session cookie travels on same-origin requests.
 */

import type { Api } from '../core/api.js';
import {
  ATTACHMENT_CREATE_SPEC,
  CAS_MISSING_CHUNKS_SPEC,
  FILE_CREATE_SPEC,
  type AttachmentRow,
  type FileCreateOutput,
  type MissingChunksOutput,
} from './attachment-specs.js';

/* -------------------------------------------------------------------------- */
/* Progress + result shapes.                                                   */
/* -------------------------------------------------------------------------- */

/** Reported back to the caller throughout the upload. */
export type UploadPhase = 'hashing' | 'uploading' | 'saving';

export interface UploadProgress {
  loaded: number;
  total: number;
  phase: UploadPhase;
}

/** The raw chunk-POST response shape (`/api/v1/cas/chunk`). */
export interface ChunkPostResult {
  address: string;
  sizeBytes: number;
}

/** The injectable raw chunk sink: posts one chunk's bytes, yields its address. */
export type PostChunk = (blob: Blob, onDone: (r: ChunkPostResult) => void, onError: (e: Error) => void) => void;

export interface UploadCallbacks {
  /** Progress over the whole file (loaded/total bytes + the current phase). */
  onProgress?: (p: UploadProgress) => void;
  /** Success: the committed attachment row (id + kind + thumb_file_id). */
  onDone?: (row: AttachmentRow) => void;
  /** Failure: a single Error describing the first fatal step. */
  onError?: (e: Error) => void;
}

/** Callbacks for the file-only pass (no attachment.create — see {@link prepareFile}). */
export interface PrepareFileCallbacks {
  /** Progress over the whole file (loaded/total bytes + the current phase). */
  onProgress?: (p: UploadProgress) => void;
  /** Success: the materialised file row (its `id` is the bind target). */
  onDone?: (file: FileCreateOutput) => void;
  /** Failure: a single Error describing the first fatal step. */
  onError?: (e: Error) => void;
}

export interface PrepareFileConfig extends PrepareFileCallbacks {
  /** Per-chunk cap in bytes. Defaults to FALLBACK_CHUNK_BYTES (1 MiB). */
  chunkBytes?: number;
  /** Inject the raw chunk-POST sink (tests pass a mock). */
  postChunk?: PostChunk;
  /** A liveness gate so a destroyed control's callbacks are dropped. */
  alive?: () => boolean;
}

export interface UploadConfig extends UploadCallbacks {
  /** Per-chunk cap in bytes. Defaults to FALLBACK_CHUNK_BYTES (1 MiB). */
  chunkBytes?: number;
  /**
   * Inject the raw chunk-POST sink (tests pass a mock). Defaults to a
   * same-origin fetch to `/api/v1/cas/chunk` (octet-stream, cookie auth).
   */
  postChunk?: PostChunk;
  /** A liveness gate so a destroyed control's callbacks are dropped. */
  alive?: () => boolean;
}

/** Default per-chunk size (the client's fallback when server config is absent). */
export const FALLBACK_CHUNK_BYTES = 1 * 1024 * 1024;

/** How many chunk POSTs run concurrently (browsers cap ~6 per origin). */
const CONCURRENCY = 4;

/* -------------------------------------------------------------------------- */
/* Same-origin URL builders + the default fetch chunk sink.                    */
/* -------------------------------------------------------------------------- */

/** Build the URL for a save-as download (Content-Disposition: attachment). */
export function downloadUrl(attachmentId: bigint): string {
  return `/api/v1/attachment/${encodeURIComponent(attachmentId.toString())}/download`;
}
/** Build the URL for the inline-view route (Content-Disposition: inline). */
export function viewUrl(attachmentId: bigint): string {
  return `/api/v1/attachment/${encodeURIComponent(attachmentId.toString())}/view`;
}
/** Build the URL for the server-generated thumbnail (image attachments). */
export function thumbUrl(attachmentId: bigint): string {
  return `/api/v1/attachment/${encodeURIComponent(attachmentId.toString())}/thumb`;
}

/**
 * The default raw chunk sink: a same-origin POST of the chunk bytes as
 * `application/octet-stream` (the kitp_session cookie rides along). Stays a
 * CALLBACK SURFACE — the single private promise (the fetch) is awaited inside
 * and never escapes.
 */
export function fetchPostChunk(apiBase = ''): PostChunk {
  return (blob, onDone, onError) => {
    void (async () => {
      try {
        const resp = await fetch(`${apiBase}/api/v1/cas/chunk`, {
          method: 'POST',
          headers: { 'Content-Type': blob.type || 'application/octet-stream' },
          body: blob,
        });
        if (!resp.ok) {
          onError(new Error(`chunk upload failed: HTTP ${resp.status}`));
          return;
        }
        const j = (await resp.json()) as { address?: unknown; size_bytes?: unknown };
        if (typeof j.address !== 'string' || typeof j.size_bytes !== 'number') {
          onError(new Error('chunk upload: bad response shape'));
          return;
        }
        onDone({ address: j.address, sizeBytes: j.size_bytes });
      } catch (e) {
        onError(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  };
}

/* -------------------------------------------------------------------------- */
/* SHA-256 (Web Crypto).                                                       */
/* -------------------------------------------------------------------------- */

/** Compute the SHA-256 hex digest of a Blob via the Web Crypto API. */
async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(hashBuf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}

/* -------------------------------------------------------------------------- */
/* The service.                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Upload one File as an attachment on `cardId`, running the full pipeline and
 * surfacing progress / completion / failure through the supplied callbacks.
 * Returns nothing: the control NEVER sees a promise (the async lives here).
 *
 * Internally a single private async IIFE drives the crypto + the dispatcher's
 * callback round-trips (each batch sub-request is wrapped in a tiny promise so
 * the linear pipeline reads top-to-bottom); none of it escapes the surface.
 */
export function uploadFile(api: Api, cardId: bigint, file: File, cfg: UploadConfig): void {
  const alive = cfg.alive ?? ((): boolean => true);
  void (async () => {
    try {
      // Steps 1-5: chunk + CAS + file.create.
      const fileOut = await runFilePipeline(api, file, cfg, alive);
      // Step 6: bind the file to the card.
      const attachment = await callBatch<AttachmentRow>(
        api,
        ATTACHMENT_CREATE_SPEC,
        { cardId, fileId: fileOut.id },
        alive,
      );
      if (alive()) cfg.onDone?.(attachment);
    } catch (e) {
      if (alive()) cfg.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  })();
}

/**
 * Upload one File to CAS + materialise it via `file.create`, surfacing the
 * resulting file row — WITHOUT binding it to any card (no `attachment.create`).
 *
 * The QuickEntry overlay pre-uploads its dropped files this way: the new card
 * doesn't exist yet, so the bind can't happen here. Once every file has an id,
 * the overlay fires `card.insert` + one `attachment.create` per id in ONE
 * dispatcher tick so the whole submission rides a single batch/transaction.
 * Same CALLBACK control surface as {@link uploadFile} (no promise escapes).
 */
export function prepareFile(api: Api, file: File, cfg: PrepareFileConfig): void {
  const alive = cfg.alive ?? ((): boolean => true);
  void (async () => {
    try {
      const fileOut = await runFilePipeline(api, file, cfg, alive);
      if (alive()) cfg.onDone?.(fileOut);
    } catch (e) {
      if (alive()) cfg.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  })();
}

/**
 * Steps 1-5 shared by {@link uploadFile} + {@link prepareFile}: slice → hash →
 * `cas.missing_chunks` preflight → POST the missing chunks → `file.create`.
 * Resolves with the materialised file row; throws on the first fatal step.
 */
async function runFilePipeline(
  api: Api,
  file: File,
  cfg: { chunkBytes?: number; postChunk?: PostChunk; onProgress?: (p: UploadProgress) => void },
  alive: () => boolean,
): Promise<FileCreateOutput> {
  const chunkBytes = cfg.chunkBytes && cfg.chunkBytes > 0 ? cfg.chunkBytes : FALLBACK_CHUNK_BYTES;
  const postChunk = cfg.postChunk ?? fetchPostChunk('');
  const emitProgress = (loaded: number, total: number, phase: UploadPhase): void => {
    if (alive()) cfg.onProgress?.({ loaded, total, phase });
  };

  /* 1. Slice. Blob.slice produces a view — bytes read lazily on hash/POST. */
  const blobs: Blob[] = [];
  for (let off = 0; off < file.size; off += chunkBytes) {
    blobs.push(file.slice(off, Math.min(off + chunkBytes, file.size)));
  }
  if (blobs.length === 0) blobs.push(file.slice(0, 0)); // empty file → one 0-byte chunk

  const total = file.size;
  const sizes = blobs.map((b) => b.size);
  const completed = new Array<number>(blobs.length).fill(0);
  const sumCompleted = (): number => completed.reduce((a, b) => a + b, 0);

  /* 2. Hash every chunk (sequential keeps the event loop responsive). */
  emitProgress(0, total, 'hashing');
  const addresses: string[] = new Array(blobs.length);
  for (let i = 0; i < blobs.length; i++) addresses[i] = await sha256Hex(blobs[i]!);

  /* 3. Pre-flight: which deduped addresses does the server already hold? */
  const uniqueAddrs = Array.from(new Set(addresses));
  const preflight = await callBatch<MissingChunksOutput>(
    api,
    CAS_MISSING_CHUNKS_SPEC,
    { addresses: uniqueAddrs },
    alive,
  );
  const missingSet = new Set(preflight.missing);
  // Anything not missing is already stored — count it as loaded.
  for (let i = 0; i < addresses.length; i++) {
    if (!missingSet.has(addresses[i]!)) completed[i] = sizes[i]!;
  }
  emitProgress(sumCompleted(), total, 'uploading');

  /* 4. Upload missing chunks in parallel (worker pool over the index list). */
  const missingIdx: number[] = [];
  for (let i = 0; i < addresses.length; i++) {
    if (missingSet.has(addresses[i]!)) missingIdx.push(i);
  }
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const next = cursor++;
      if (next >= missingIdx.length) return;
      const idx = missingIdx[next]!;
      const got = await postChunkOnce(postChunk, blobs[idx]!);
      if (got.address !== addresses[idx]) {
        throw new Error(
          `address mismatch on chunk ${idx}: client=${addresses[idx]}, server=${got.address}`,
        );
      }
      completed[idx] = got.sizeBytes;
      // Mark every other chunk sharing this address completed too.
      for (let j = 0; j < addresses.length; j++) {
        if (j !== idx && addresses[j] === got.address) completed[j] = sizes[j]!;
      }
      emitProgress(sumCompleted(), total, 'uploading');
    }
  };
  const workerCount = Math.min(CONCURRENCY, Math.max(1, missingIdx.length));
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) workers.push(worker());
  await Promise.all(workers);

  /* 5. Commit the file row. */
  emitProgress(total, total, 'saving');
  const chunks = addresses.map((address, i) => ({ address, sizeBytes: sizes[i]! }));
  return callBatch<FileCreateOutput>(
    api,
    FILE_CREATE_SPEC,
    { filename: file.name, mimeType: file.type || 'application/octet-stream', chunks },
    alive,
  );
}

/* -------------------------------------------------------------------------- */
/* Private promise adapters (kept inside the service surface).                 */
/* -------------------------------------------------------------------------- */

/**
 * Wrap one batch sub-request in a promise so the linear pipeline reads top to
 * bottom. The PUBLIC `uploadFile` surface never exposes this promise — it is an
 * internal detail like the dispatcher's `transport.send` await. A torn-down
 * control's `alive` gate rejects so the pipeline stops cleanly.
 */
function callBatch<O>(
  api: Api,
  specKey: string,
  data: unknown,
  alive: () => boolean,
): Promise<O> {
  return new Promise<O>((resolve, reject) => {
    api.callByName(
      specKey,
      data,
      (out) => {
        if (!alive()) {
          reject(new Error('upload aborted (control destroyed)'));
          return;
        }
        resolve(out as O);
      },
      {
        alive,
        onErr: (fault) => {
          reject(new Error(`${specKey}: ${describeFault(fault)}`));
        },
      },
    );
  });
}

/** Wrap the injected callback chunk sink in a promise for the worker loop. */
function postChunkOnce(postChunk: PostChunk, blob: Blob): Promise<ChunkPostResult> {
  return new Promise<ChunkPostResult>((resolve, reject) => {
    postChunk(blob, resolve, reject);
  });
}

/** Render a dispatcher ApiFault into a short message string. */
function describeFault(f: { kind: string } & Record<string, unknown>): string {
  switch (f.kind) {
    case 'sub_error':
      return `${String(f['code'] ?? 'error')}: ${String(f['message'] ?? '')}`;
    case 'http':
      return `http ${String(f['status'])}`;
    case 'network':
      return `network: ${String(f['message'])}`;
    case 'decode':
      return `decode: ${String(f['message'])}`;
    case 'aborted':
      return `aborted: ${String(f['reason'])}`;
    default:
      return f.kind;
  }
}
