/**
 * export-helpers — pure URL-builders + the browser-download trigger for the
 * project export endpoints (server/internal/dom/projectexport).
 *
 * These routes live OUTSIDE the JSON batch dispatcher: each is a direct
 * same-origin HTTP GET that streams a download (the `kitp_session` cookie
 * rides along automatically on a same-origin request):
 *
 *   GET /api/v1/project/{id}/export.csv?include_deleted=1[&tree=…]
 *       → text/csv; charset=utf-8 — one row per task.
 *   GET /api/v1/project/{id}/export.xlsx?include_deleted=1[&tree=…]
 *       → application/vnd.openxmlformats-officedocument.spreadsheetml.sheet —
 *         the same shape as the CSV as a single-sheet workbook.
 *   GET /api/v1/project/{id}/export.zip
 *         ?include_deleted=1&include_attachments=1&include_activity=1[&tree=…]
 *       → application/zip — a self-contained archive (project / tasks /
 *         comments / milestones / components / tags / persons CSVs, plus the
 *         optional activity.csv + attachments/ folder).
 *
 * The toggle query params the routes read:
 *   - `include_deleted=1`      (CSV / XLSX / ZIP) — soft-deleted tasks too.
 *   - `include_attachments=1`  (ZIP only) — stream every attachment's bytes.
 *   - `include_activity=1`     (ZIP only) — add activity.csv.
 * Only `=1` is truthy server-side; the param is OMITTED entirely when off so
 * the URL stays minimal.
 *
 * Cascade-safe: nothing here touches a signal or a tracked effect. The two
 * download mechanisms are pure DOM/navigation:
 *   - {@link exportNavUrl} + a hidden `<a download>` click (the simplest path
 *     for CSV — a same-origin navigation the browser saves);
 *   - {@link downloadViaBlob} — a `fetch` → object-URL → `<a download>` click,
 *     used for zip/xlsx where we want a clean filename from the server's
 *     Content-Disposition and to surface a non-2xx as an Error rather than
 *     navigating to an error page.
 *
 * The cookie travels on same-origin GETs for BOTH paths, so OIDC mode needs no
 * Authorization header here (the web client is the BFF; see the Svelte
 * reference client/src/screens/admin/project_export.ts, NOT imported).
 */

/** The three export formats the routes expose. */
export type ExportFormat = 'csv' | 'xlsx' | 'zip';

/** The toggle set; only the params a given format supports are emitted. */
export interface ExportToggles {
  /** Include soft-deleted tasks (CSV / XLSX / ZIP). */
  includeDeleted: boolean;
  /** Stream every attachment's bytes into the archive (ZIP only). */
  includeAttachments: boolean;
  /** Add activity.csv to the archive (ZIP only). */
  includeActivity: boolean;
}

/** A fresh toggle set with everything off. */
export function defaultToggles(): ExportToggles {
  return { includeDeleted: false, includeAttachments: false, includeActivity: false };
}

/** The file extension for a format — also the route suffix. */
export function formatExtension(format: ExportFormat): string {
  return format; // csv | xlsx | zip — the route is `export.<ext>`.
}

/**
 * Build the same-origin export URL for `(projectId, format, toggles)`.
 *
 * The route path is `/api/v1/project/{id}/export.<format>`; the toggle query
 * params are appended only when ON, and only when the format supports them
 * (attachments / activity are ZIP-only — including them on a CSV/XLSX URL
 * would be ignored by the server, but we keep the URL honest by omitting
 * them). `apiBase` defaults to '' (same-origin) — the production path; tests
 * may pass a base to assert against an absolute URL.
 */
export function exportNavUrl(
  projectId: bigint,
  format: ExportFormat,
  toggles: ExportToggles,
  apiBase = '',
): string {
  const params = new URLSearchParams();
  if (toggles.includeDeleted) params.set('include_deleted', '1');
  if (format === 'zip') {
    if (toggles.includeAttachments) params.set('include_attachments', '1');
    if (toggles.includeActivity) params.set('include_activity', '1');
  }
  const query = params.toString();
  const path = `${apiBase}/api/v1/project/${encodeURIComponent(
    projectId.toString(),
  )}/export.${formatExtension(format)}`;
  return query !== '' ? `${path}?${query}` : path;
}

/** A fallback download filename when the server omits Content-Disposition. */
export function fallbackFilename(projectId: bigint, format: ExportFormat): string {
  return `project-${projectId.toString()}.${formatExtension(format)}`;
}

/**
 * Parse the `filename="…"` token out of a Content-Disposition header.
 * Returns null when the header is absent or has no filename — callers fall
 * back to {@link fallbackFilename}. The server emits ASCII-safe slugs so we
 * don't need RFC-6266 `filename*` decoding.
 */
export function parseAttachmentFilename(header: string | null): string | null {
  if (header === null || header === '') return null;
  const quoted = header.match(/filename="([^"]+)"/i);
  if (quoted !== null && quoted[1] !== undefined && quoted[1] !== '') return quoted[1];
  const bare = header.match(/filename=([^;]+)/i);
  if (bare !== null && bare[1] !== undefined && bare[1].trim() !== '') return bare[1].trim();
  return null;
}

/**
 * Trigger a same-origin download by clicking a hidden `<a download href=url>`.
 * The browser fetches the URL itself (cookie attached) and saves it via its
 * Content-Disposition. Synchronous + side-effect-only — no promise, safe from
 * any UI event handler. The anchor is appended, clicked, and removed.
 *
 * `doc` defaults to the ambient `document`; tests pass a fake to capture the
 * anchor without a real navigation.
 */
export function downloadViaAnchor(url: string, doc: Document = document): void {
  const a = doc.createElement('a');
  a.href = url;
  // `download` (even empty) hints the browser to save rather than navigate;
  // the server's Content-Disposition still names the file.
  a.setAttribute('download', '');
  a.rel = 'noopener';
  doc.body.appendChild(a);
  a.click();
  a.remove();
}

/** Injectable bits for {@link downloadViaBlob} so tests can stub the network. */
export interface BlobDownloadDeps {
  fetchImpl?: typeof fetch;
  doc?: Document;
  /** Object-URL factory; defaults to URL.createObjectURL. */
  createObjectUrl?: (blob: Blob) => string;
  /** Object-URL revoker; defaults to URL.revokeObjectURL. */
  revokeObjectUrl?: (url: string) => void;
}

/**
 * Fetch the export URL and trigger a save-as via an object URL. Used for the
 * binary formats (xlsx / zip) where we want the server's Content-Disposition
 * filename and to surface a non-2xx as a rejected promise rather than letting
 * the browser navigate to a JSON error page.
 *
 * Resolves once the save has been kicked off; rejects with an Error on a
 * non-2xx status or a network failure. The PROMISE is a private detail of this
 * helper — callers (the ExportMenu control) consume it through a callback /
 * try-catch and never let it cross a control boundary into a tracked effect.
 */
export async function downloadViaBlob(
  url: string,
  fallbackName: string,
  deps: BlobDownloadDeps = {},
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const doc = deps.doc ?? document;
  const createObjectUrl = deps.createObjectUrl ?? ((b: Blob) => URL.createObjectURL(b));
  const revokeObjectUrl = deps.revokeObjectUrl ?? ((u: string) => URL.revokeObjectURL(u));

  const resp = await fetchImpl(url, { method: 'GET', credentials: 'same-origin' });
  if (!resp.ok) {
    // The server emits a JSON {"error":"…"} body for non-2xx.
    let detail = `${resp.status} ${resp.statusText}`;
    try {
      const body = await resp.text();
      if (body !== '') detail = body;
    } catch {
      /* body unreadable — keep the status line */
    }
    throw new Error(`export failed: ${detail}`);
  }

  const filename =
    parseAttachmentFilename(resp.headers.get('Content-Disposition')) ?? fallbackName;
  const blob = await resp.blob();
  const objectUrl = createObjectUrl(blob);
  const a = doc.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  a.rel = 'noopener';
  doc.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a tick to grab the bytes before revoking.
  setTimeout(() => revokeObjectUrl(objectUrl), 0);
}
