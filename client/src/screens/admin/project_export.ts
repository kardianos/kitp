/**
 * Browser-side download helper for the project export endpoint
 * (`GET /api/v1/project/{id}/export.csv`). The endpoint lives outside
 * the JSON batch dispatcher because the response is `text/csv` with
 * `Content-Disposition: attachment`; we still want the Authorization
 * header attached when OIDC mode is active, so a plain `<a href>` is
 * not enough — we fetch the body, wrap it in an object URL, and
 * trigger a hidden anchor click to invoke the browser's save-as.
 *
 * Errors propagate as `Error` instances; the caller is responsible
 * for surfacing a toast / inline message.
 */
import type { AuthState } from '../../auth/auth_state.svelte';
import { stringifyBigInt } from '../../dispatch/dispatcher';
import { predicateToJson, type Predicate } from '../../filter/predicate';
import { KITP_API_BASE } from '../../env';
import type { ID } from '../../reg/types';

/** Options for {@link downloadProjectExportCsv}. */
export interface ExportOptions {
  /** Project id whose tasks are exported. */
  projectId: ID;
  /** When true, soft-deleted tasks are included in the CSV. */
  includeDeleted: boolean;
  /** Auth state; the Authorization header is set when a token is present. */
  authState: AuthState | null;
  /**
   * Optional predicate AST — the active screen filter. When set, the
   * server's task query is narrowed via the same compiler that powers
   * `card.select_with_attributes` (`tree` query param). Bigint
   * card-ref values are stringified via {@link stringifyBigInt} so
   * they survive JSON round-trip; the server's predicate compiler
   * accepts both string and number id shapes.
   */
  predicate?: Predicate | null;
  /** Optional fetch override for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

/** Options for {@link downloadProjectExportZip}. */
export interface ExportZipOptions extends ExportOptions {
  /** When true, every attachment's bytes are bundled under `attachments/`. */
  includeAttachments: boolean;
  /** When true, `activity.csv` is added to the archive. */
  includeActivity: boolean;
}

/**
 * Issue the export request and trigger a browser download. Resolves
 * once the download has been kicked off; rejects with `Error` when
 * the server returns a non-2xx status or the network fails.
 */
export async function downloadProjectExportCsv(opts: ExportOptions): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const params = new URLSearchParams();
  if (opts.includeDeleted) params.set('include_deleted', '1');
  appendTreeParam(params, opts.predicate);
  const query = params.toString();
  const url = `${KITP_API_BASE}/api/v1/project/${opts.projectId.toString()}/export.csv${
    query !== '' ? `?${query}` : ''
  }`;

  // BFF cookie-only: the kitp_session cookie rides on same-origin
  // GETs automatically, so we don't add an Authorization header.
  const resp = await fetchImpl(url, { method: 'GET', credentials: 'same-origin' });
  if (!resp.ok) {
    // Server emits a JSON {"error":"..."} body for non-2xx.
    let detail = `${resp.status} ${resp.statusText}`;
    try {
      const body = await resp.text();
      if (body !== '') detail = body;
    } catch {
      /* ignore body parse */
    }
    throw new Error(`export failed: ${detail}`);
  }

  // Filename: prefer the server's Content-Disposition; otherwise build
  // a fallback so the download is at least named.
  const filename = parseAttachmentFilename(resp.headers.get('Content-Disposition'))
    ?? `project-${opts.projectId.toString()}.csv`;

  const blob = await resp.blob();
  triggerBrowserDownload(blob, filename);
}

/**
 * Issue the full-ZIP export request (`GET /api/v1/project/{id}/export.zip`)
 * and trigger a browser download. Same auth + error semantics as
 * {@link downloadProjectExportCsv}.
 */
export async function downloadProjectExportZip(opts: ExportZipOptions): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const params = new URLSearchParams();
  if (opts.includeDeleted) params.set('include_deleted', '1');
  if (opts.includeAttachments) params.set('include_attachments', '1');
  if (opts.includeActivity) params.set('include_activity', '1');
  appendTreeParam(params, opts.predicate);
  const query = params.toString();
  const url = `${KITP_API_BASE}/api/v1/project/${opts.projectId.toString()}/export.zip${
    query !== '' ? `?${query}` : ''
  }`;

  // BFF cookie-only: the kitp_session cookie rides on same-origin
  // GETs automatically, so we don't add an Authorization header.
  const resp = await fetchImpl(url, { method: 'GET', credentials: 'same-origin' });
  if (!resp.ok) {
    let detail = `${resp.status} ${resp.statusText}`;
    try {
      const body = await resp.text();
      if (body !== '') detail = body;
    } catch {
      /* ignore */
    }
    throw new Error(`export failed: ${detail}`);
  }
  const filename = parseAttachmentFilename(resp.headers.get('Content-Disposition'))
    ?? `project-${opts.projectId.toString()}.zip`;
  const blob = await resp.blob();
  triggerBrowserDownload(blob, filename);
}

/**
 * Issue the .xlsx export request (`GET /api/v1/project/{id}/export.xlsx`)
 * and trigger a browser download. Same shape as the CSV (one row per
 * task) but rendered as an Excel workbook so the user can open it
 * directly in Sheets / Excel without a CSV import dance.
 */
export async function downloadProjectExportXlsx(opts: ExportOptions): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const params = new URLSearchParams();
  if (opts.includeDeleted) params.set('include_deleted', '1');
  appendTreeParam(params, opts.predicate);
  const query = params.toString();
  const url = `${KITP_API_BASE}/api/v1/project/${opts.projectId.toString()}/export.xlsx${
    query !== '' ? `?${query}` : ''
  }`;
  const resp = await fetchImpl(url, { method: 'GET', credentials: 'same-origin' });
  if (!resp.ok) {
    let detail = `${resp.status} ${resp.statusText}`;
    try {
      const body = await resp.text();
      if (body !== '') detail = body;
    } catch {
      /* ignore */
    }
    throw new Error(`export failed: ${detail}`);
  }
  const filename = parseAttachmentFilename(resp.headers.get('Content-Disposition'))
    ?? `project-${opts.projectId.toString()}.xlsx`;
  const blob = await resp.blob();
  triggerBrowserDownload(blob, filename);
}

/**
 * Append a `tree=` URL parameter encoding the predicate AST. Bigint
 * card-ref values are stringified through {@link stringifyBigInt}; the
 * server's predicate compiler accepts both string and number id
 * shapes (see `card.search` and `where.go: parent_status_phase`).
 */
function appendTreeParam(
  params: URLSearchParams,
  predicate: Predicate | null | undefined,
): void {
  if (predicate === null || predicate === undefined) return;
  params.set('tree', stringifyBigInt(predicateToJson(predicate)));
}

/**
 * Parse the `filename="..."` token out of a Content-Disposition header.
 * Returns null when the header is missing or malformed — callers fall
 * back to a synthetic name.
 */
export function parseAttachmentFilename(header: string | null): string | null {
  if (header === null || header === '') return null;
  // The simple case: `attachment; filename="foo.csv"`. We don't need
  // RFC-6266 filename* decoding — the server emits ASCII-safe slugs.
  const m = header.match(/filename="([^"]+)"/i);
  if (m !== null && m[1] !== undefined && m[1] !== '') return m[1];
  const m2 = header.match(/filename=([^;]+)/i);
  if (m2 !== null && m2[1] !== undefined) return m2[1].trim();
  return null;
}

/**
 * Build an object URL for `blob`, click a hidden anchor with the
 * `download` attribute, and revoke the URL after a tick so the
 * browser has time to start the save. Safe to call from any UI event
 * handler — no globals are mutated and the anchor is removed.
 */
function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to grab the bytes before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
