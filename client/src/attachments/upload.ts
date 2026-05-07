/**
 * Chunked attachment upload + download.
 *
 * Upload protocol:
 *   1. Slice the File into ≤chunkBytes pieces.
 *   2. Hash each chunk client-side (Web Crypto SHA-256).
 *   3. cas.missing_chunks pre-flight: ask the server which addresses it
 *      already has so we don't ship bytes for anything that's already
 *      stored (re-upload of an unchanged file uploads zero bytes).
 *   4. POST raw bytes for the missing chunks to /api/v1/cas/chunk
 *      (Content-Type: application/octet-stream — multipart added ~200 B
 *      of envelope overhead which used to push exactly-MaxBytes chunks
 *      over the cap and produced spurious 413s). Up to N chunks fly in
 *      parallel.
 *   5. Dispatcher: file.create with the chunk list → file_id.
 *   6. Dispatcher: attachment.create with {cardId, fileId} → attachment row
 *      + an attachment_create activity (server-side).
 *
 * Download is the same single-route GET it always was — the server
 * stitches chunks back together server-side and streams them to the
 * response writer.
 */

import type { AuthState } from '../auth/auth_state.svelte';
import type { Dispatcher } from '../dispatch/dispatcher';
import { KITP_API_BASE } from '../env';
import {
  attachmentCreate,
  casMissingChunks,
  fileCreate,
} from '../reg/handlers';
import type {
  AttachmentCreateInput,
  AttachmentCreateOutput,
  FileCreateInput,
  FileCreateOutput,
  MissingChunksInput,
  MissingChunksOutput,
} from '../reg/types';

/** Reported back to the caller throughout the upload. */
export type UploadPhase = 'hashing' | 'uploading' | 'saving';

export interface UploadProgress {
  loaded: number;
  total: number;
  phase: UploadPhase;
}

export class UploadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'UploadError';
  }
}

/** Default per-chunk size when the server config hasn't loaded yet. */
const FALLBACK_CHUNK_BYTES = 1 * 1024 * 1024;
/** How many chunk uploads run concurrently. Browsers cap concurrent
 *  HTTP/1.1 connections to ~6 per origin anyway; 4 leaves headroom. */
const CONCURRENCY = 4;

export interface UploadOptions {
  /** Per-chunk cap in bytes. Defaults to the server's chunk_max_bytes. */
  chunkBytes?: number | undefined;
  /** Reports progress; loaded/total are over the whole file. */
  onProgress?: ((p: UploadProgress) => void) | undefined;
}

function authHeaders(authState?: AuthState | null): Record<string, string> {
  const tok = authState?.accessToken;
  if (tok && tok.length > 0) return { Authorization: `Bearer ${tok}` };
  return {};
}

/**
 * Compute the SHA-256 hex digest of a Blob via the Web Crypto API.
 * Native impl, fast — typically a few hundred MB/s.
 */
async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(hashBuf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Upload one file as an attachment on `cardId`. Slices, hashes, asks
 * the server which chunks are missing, parallel-uploads the missing
 * ones, then commits a `file` row + an `attachment` row through the
 * dispatcher.
 */
export async function uploadAttachment(
  dispatcher: Dispatcher,
  cardId: number,
  file: File,
  authState?: AuthState | null,
  opts: UploadOptions = {},
): Promise<AttachmentCreateOutput> {
  const chunkBytes =
    opts.chunkBytes && opts.chunkBytes > 0 ? opts.chunkBytes : FALLBACK_CHUNK_BYTES;
  const onProgress = opts.onProgress;

  // 1. Slice. Blob.slice produces a view — bytes are only read when
  // each chunk is fed to the hasher / fetch.
  const blobs: Blob[] = [];
  for (let off = 0; off < file.size; off += chunkBytes) {
    blobs.push(file.slice(off, Math.min(off + chunkBytes, file.size)));
  }
  if (blobs.length === 0) {
    // Empty file — one zero-byte chunk so the file row still has a
    // chunk to point at.
    blobs.push(file.slice(0, 0));
  }

  const total = file.size;
  const sizes = blobs.map((b) => b.size);
  const completed = new Array<number>(blobs.length).fill(0);

  function reportProgress(phase: UploadPhase) {
    if (!onProgress) return;
    const loaded = completed.reduce((a, b) => a + b, 0);
    onProgress({ loaded, total, phase });
  }

  // 2. Hash every chunk. CPU-bound; doing it sequentially keeps the
  // event loop responsive and matches typical per-chunk hashing cost
  // (~tens of ms for a 1 MB chunk on modern hardware).
  reportProgress('hashing');
  const addresses: string[] = new Array(blobs.length);
  for (let i = 0; i < blobs.length; i++) {
    addresses[i] = await sha256Hex(blobs[i]!);
  }

  // 3. Pre-flight: which addresses does the server already have? Send
  // the deduplicated set so a file with repeating chunks (rare for
  // real content but cheap to handle) doesn't waste a slot.
  const uniqueAddrs = Array.from(new Set(addresses));
  const preflight = await dispatcher.request<MissingChunksInput, MissingChunksOutput>({
    endpoint: casMissingChunks.endpoint,
    action: casMissingChunks.action,
    data: { addresses: uniqueAddrs },
  });
  const missingSet = new Set(preflight.missing);

  // Anything not in `missing` is already on the server — count it as
  // "loaded" so the progress bar reflects the saved bytes.
  for (let i = 0; i < addresses.length; i++) {
    if (!missingSet.has(addresses[i]!)) completed[i] = sizes[i]!;
  }
  reportProgress('uploading');

  // 4. Upload missing chunks in parallel. We work off the index list so
  // a finished worker can immediately pick up the next missing index.
  const missingIdx: number[] = [];
  for (let i = 0; i < addresses.length; i++) {
    if (missingSet.has(addresses[i]!)) missingIdx.push(i);
  }
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const next = cursor++;
      if (next >= missingIdx.length) return;
      const idx = missingIdx[next]!;
      const blob = blobs[idx]!;
      const got = await uploadOneChunk(blob, authState ?? null);
      if (got.address !== addresses[idx]) {
        // Sanity: if Web Crypto and Go's sha256 disagree we have bigger
        // problems. Surface it loudly rather than silently writing the
        // wrong address into file.create's chunk list.
        throw new UploadError(
          0,
          `address mismatch on chunk ${idx}: client=${addresses[idx]}, server=${got.address}`,
        );
      }
      completed[idx] = got.size_bytes;
      // Mark every other chunk that shares this address as completed
      // too — duplicate addresses in the input only need one upload.
      for (let j = 0; j < addresses.length; j++) {
        if (j !== idx && addresses[j] === got.address) completed[j] = sizes[j]!;
      }
      reportProgress('uploading');
    }
  }
  const workerCount = Math.min(CONCURRENCY, Math.max(1, missingIdx.length));
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) workers.push(worker());
  await Promise.all(workers);

  // 5. Commit the file + attachment via the JSON dispatcher.
  reportProgress('saving');
  const chunks = addresses.map((address, i) => ({
    address,
    size_bytes: sizes[i]!,
  }));
  const fileOut = await dispatcher.request<FileCreateInput, FileCreateOutput>({
    endpoint: fileCreate.endpoint,
    action: fileCreate.action,
    data: {
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      chunks,
    },
  });
  const attOut = await dispatcher.request<AttachmentCreateInput, AttachmentCreateOutput>({
    endpoint: attachmentCreate.endpoint,
    action: attachmentCreate.action,
    data: { cardId, fileId: fileOut.id },
  });
  return attOut;
}

async function uploadOneChunk(
  blob: Blob,
  authState: AuthState | null,
): Promise<{ address: string; size_bytes: number }> {
  const url = `${KITP_API_BASE}/api/v1/cas/chunk`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders(authState),
      'Content-Type': blob.type || 'application/octet-stream',
    },
    body: blob,
  });
  if (!resp.ok) {
    const msg = await readErrorMessage(resp);
    throw new UploadError(resp.status, msg);
  }
  const j = (await resp.json()) as { address: string; size_bytes: number };
  if (typeof j.address !== 'string' || typeof j.size_bytes !== 'number') {
    throw new UploadError(resp.status, 'bad chunk response shape');
  }
  return j;
}

/** Build the URL for a download — useful for `<a href="…">` direct links. */
export function downloadUrl(attachmentId: number): string {
  return `${KITP_API_BASE}/api/v1/attachment/${encodeURIComponent(String(attachmentId))}/download`;
}

/** Build the URL for the inline-view route (Content-Disposition: inline). */
export function viewUrl(attachmentId: number): string {
  return `${KITP_API_BASE}/api/v1/attachment/${encodeURIComponent(String(attachmentId))}/view`;
}

/** Build the URL for the server-generated thumbnail (image attachments). */
export function thumbUrl(attachmentId: number): string {
  return `${KITP_API_BASE}/api/v1/attachment/${encodeURIComponent(String(attachmentId))}/thumb`;
}

/**
 * Fetch attachment bytes through the auth'd path and hand back a Blob the
 * caller can convert to an object URL. The bearer token rides on
 * `Authorization` so `<img src="…/view">` (which can't carry headers in the
 * browser) is not an option — that's why we go via fetch.
 */
export async function fetchAttachmentBlob(
  attachmentId: number,
  kind: 'view' | 'thumb' | 'download',
  authState?: AuthState | null,
): Promise<Blob> {
  const url =
    kind === 'thumb'
      ? thumbUrl(attachmentId)
      : kind === 'view'
        ? viewUrl(attachmentId)
        : downloadUrl(attachmentId);
  const resp = await fetch(url, {
    method: 'GET',
    headers: authHeaders(authState ?? null),
  });
  if (!resp.ok) {
    const msg = await readErrorMessage(resp);
    throw new UploadError(resp.status, msg);
  }
  return await resp.blob();
}

/**
 * Trigger a save-as download for an attachment. Uses fetch + a temporary
 * blob URL so the Authorization header rides the request.
 */
export async function downloadAttachment(
  attachmentId: number,
  filename: string,
  authState?: AuthState | null,
): Promise<void> {
  const resp = await fetch(downloadUrl(attachmentId), {
    method: 'GET',
    headers: authHeaders(authState),
  });
  if (!resp.ok) {
    const msg = await readErrorMessage(resp);
    throw new UploadError(resp.status, msg);
  }
  const blob = await resp.blob();
  const objURL = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objURL;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objURL);
}

async function readErrorMessage(resp: Response): Promise<string> {
  try {
    const j = (await resp.json()) as { error?: string };
    if (typeof j.error === 'string' && j.error !== '') return j.error;
  } catch {
    // Non-JSON body — fall through.
  }
  return `${resp.status} ${resp.statusText}`;
}
