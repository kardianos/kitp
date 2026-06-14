/**
 * AttachmentsSection (#36) — the attachments control for the Task detail.
 *
 * Mounts into the TaskDetail's `[data-slot="attachments"]` region (the right
 * rail). Ports `client/src/ui/widgets/AttachmentsSection.svelte` (+ the thumb /
 * inline-view / gallery widgets) onto the web framework's direct-DOM, callback,
 * zero-promise posture:
 *
 *   - `attachment.list { cardId }` loads the existing rows (newest-first) on
 *     mount and after every mutating action.
 *   - Drag-and-drop onto the section OR a "Choose files…" picker → the upload
 *     SERVICE (`upload.ts`): SHA-256 chunk → `cas.missing_chunks` → parallel raw
 *     `POST /api/v1/cas/chunk` → `file.create` + `attachment.create`. The
 *     service exposes a CALLBACK surface; progress (hashing / uploading / saving)
 *     paints an in-flight row per upload.
 *   - Download via the raw GET `/api/v1/attachment/:id/download` (an `<a>` with a
 *     fetched-blob object URL so a future auth header could ride along).
 *   - Soft-delete via `attachment.delete { id }` (optimistic remove + rollback).
 *   - Image rows show a server thumbnail (`/attachment/:id/thumb`, fetched as a
 *     blob → object URL, revoked on rebuild / destroy).
 *   - Clicking an image / pdf row opens a full-screen GALLERY overlay: the
 *     inline `/view` bytes, ←/→ to page between viewable rows, Esc to close;
 *     every object URL is revoked on close.
 *
 * Cascade-safe + declarative: every load / mutation routes through
 * `api.callByName(..., onOk, { alive, onErr })` or the upload service's callback
 * surface; no `.then` / `await` here. The single place doing chunk hashing + raw
 * POSTs is the upload service.
 *
 * Reference (NOT imported): client/src/ui/widgets/{AttachmentsSection,
 * AttachmentThumbImage, AttachmentInlineView, AttachmentsPreviewStrip}.svelte.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import {
  ATTACHMENT_DELETE_SPEC,
  ATTACHMENT_LIST_SPEC,
  type AttachmentDeleteOutput,
  type AttachmentListOutput,
  type AttachmentRow,
} from './attachment-specs.js';
import {
  downloadUrl,
  thumbUrl,
  uploadFile,
  viewUrl,
  type PostChunk,
  type UploadPhase,
} from './upload.js';

import { icon } from '../ui/icons.js';
/* -------------------------------------------------------------------------- */
/* Config + declaration-merged registry type.                                  */
/* -------------------------------------------------------------------------- */

export interface AttachmentsSectionConfig extends BaseControlConfig {
  type: 'AttachmentsSection';
  /** The focal card the attachments hang off (string → bigint). */
  cardId: string;
  /**
   * Inject the raw chunk-POST sink (tests pass a mock). Production leaves it
   * unset → the upload service uses a same-origin fetch to `/api/v1/cas/chunk`.
   */
  postChunk?: PostChunk;
  /**
   * Inject the blob fetcher for thumbnails / inline views (tests pass a mock so
   * jsdom doesn't issue real network GETs). Defaults to a same-origin fetch.
   */
  fetchBlob?: (url: string, onDone: (b: Blob) => void, onError: (e: Error) => void) => void;
  /** Optional per-chunk cap in bytes (forwarded to the upload service). */
  chunkBytes?: number;
  /** Called after every successful upload / delete so the parent can refresh. */
  onChanged?: () => void;
  /**
   * Optional MAIN-column host the section paints a preview STRIP into (image +
   * PDF tiles → the same gallery), like the Svelte AttachmentsPreviewStrip. The
   * section owns the data + thumb cache + gallery, so the strip stays in sync
   * with the right-rail list for free; it's hidden when nothing is previewable.
   */
  previewHost?: HTMLElement;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    AttachmentsSection: AttachmentsSectionConfig;
  }
}

/* -------------------------------------------------------------------------- */
/* In-flight upload state.                                                      */
/* -------------------------------------------------------------------------- */

interface InFlight {
  uid: number;
  name: string;
  loaded: number;
  total: number;
  phase: UploadPhase;
}

/* -------------------------------------------------------------------------- */
/* Control.                                                                     */
/* -------------------------------------------------------------------------- */

export class AttachmentsSection extends Control<AttachmentsSectionConfig> {
  private readonly cardId: bigint | null;
  private readonly postChunk?: PostChunk;
  private readonly fetchBlob: (url: string, onDone: (b: Blob) => void, onError: (e: Error) => void) => void;
  private readonly onChanged?: () => void;
  /** MAIN-column host for the preview strip (image + PDF tiles), or undefined. */
  private readonly previewHost?: HTMLElement;

  /** The loaded attachment rows (newest-first). */
  private rows: AttachmentRow[] = [];
  /** True between the first load fire and its response. */
  private loading = false;
  /** In-flight uploads keyed by a per-upload synthetic id. */
  private readonly uploads = new Map<number, InFlight>();
  private nextUploadId = 0;
  /** Drag-over highlight state. */
  private dragOver = false;

  /** Thumb object-URL cache: attachment-id-as-string → blob URL. Revoked on destroy. */
  private readonly thumbUrls = new Map<string, string>();
  /** In-flight thumb fetches → the <img> targets awaiting the blob, so the strip
   *  tile + the list row for the same attachment share ONE fetch / object URL. */
  private readonly thumbPending = new Map<string, HTMLImageElement[]>();

  /** The open gallery overlay (or null). Owns its own object URL. */
  private gallery: { root: HTMLElement; viewerHost: HTMLElement; index: number; objUrl: string | null } | null = null;

  /* DOM regions held so loads / uploads repaint without a full re-render. */
  private dropzone!: HTMLElement;
  private listHost!: HTMLElement;
  private uploadsHost!: HTMLElement;
  private fileInput!: HTMLInputElement;
  private countEl!: HTMLElement;

  constructor(...args: ConstructorParameters<typeof Control<AttachmentsSectionConfig>>) {
    super(...args);
    this.cardId = parseId(this.config.cardId);
    if (this.config.postChunk !== undefined) this.postChunk = this.config.postChunk;
    this.fetchBlob = this.config.fetchBlob ?? defaultFetchBlob;
    this.onChanged = this.config.onChanged;
    this.previewHost = this.config.previewHost;
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'attachments';
    el.dataset.control = 'AttachmentsSection';
    el.setAttribute('aria-labelledby', 'attachments-heading');
    return el;
  }

  protected render(): void {
    const head = document.createElement('h2');
    head.id = 'attachments-heading';
    head.className = 'task-detail__panel-head';
    head.dataset.attachmentsHeading = '';
    const headText = document.createElement('span');
    headText.textContent = 'ATTACHMENTS';
    const count = document.createElement('span');
    count.className = 'attachments__count muted';
    count.dataset.attachmentsCount = '';
    this.countEl = count;
    head.append(headText, count);
    this.el.append(head);

    const zone = document.createElement('div');
    zone.className = 'attachments__zone';
    zone.dataset.attachmentsDropzone = '';
    this.dropzone = zone;
    this.listen(zone, 'dragover', (e) => this.onDragOver(e as DragEvent));
    this.listen(zone, 'dragleave', () => this.onDragLeave());
    this.listen(zone, 'drop', (e) => this.onDrop(e as DragEvent));
    this.el.append(zone);

    const listHost = document.createElement('div');
    listHost.className = 'attachments__list-host';
    listHost.dataset.attachmentsListHost = '';
    this.listHost = listHost;
    zone.append(listHost);

    const uploadsHost = document.createElement('div');
    uploadsHost.className = 'attachments__uploads';
    uploadsHost.dataset.attachmentsUploads = '';
    this.uploadsHost = uploadsHost;
    zone.append(uploadsHost);

    const foot = document.createElement('div');
    foot.className = 'attachments__foot';
    const hint = document.createElement('p');
    hint.className = 'attachments__hint muted';
    hint.textContent = 'Drag & drop, or click to browse.';
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'btn attachments__pick';
    pick.dataset.attachmentsPick = '';
    pick.textContent = 'Choose files…';
    this.listen(pick, 'click', () => this.fileInput.click());
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.className = 'attachments__input';
    input.dataset.attachmentsInput = '';
    input.style.display = 'none';
    this.fileInput = input;
    this.listen(input, 'change', () => {
      if (input.files && input.files.length > 0) {
        this.handleFiles(input.files);
        input.value = '';
      }
    });
    foot.append(hint, pick, input);
    zone.append(foot);

    this.paintList();
    this.paintUploads();
    this.loadList();
  }

  override destroy(): void {
    this.closeGallery();
    for (const url of this.thumbUrls.values()) URL.revokeObjectURL(url);
    this.thumbUrls.clear();
    this.thumbPending.clear();
    // The strip lives in a host this control doesn't own — clear it on teardown.
    this.previewHost?.replaceChildren();
    super.destroy();
  }

  /* -------------------------------- loads ------------------------------- */

  /** Public refresh hook (parent can re-pull after an external change). */
  reload(): void {
    this.loadList();
  }

  private loadList(): void {
    if (this.cardId === null) {
      this.loading = false;
      this.paintList();
      return;
    }
    this.loading = true;
    this.paintList();
    this.ctx.api.callByName(
      ATTACHMENT_LIST_SPEC,
      { cardId: this.cardId },
      (out) => {
        if (!this.isAlive()) return;
        this.rows = (out as AttachmentListOutput).rows ?? [];
        this.loading = false;
        this.paintList();
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          if (!this.isAlive()) return;
          this.loading = false;
          this.paintList();
        },
      },
    );
  }

  /* ------------------------------- uploads ------------------------------ */

  private handleFiles(files: FileList | File[]): void {
    if (this.cardId === null) return;
    for (const file of Array.from(files)) this.startUpload(file);
  }

  private startUpload(file: File): void {
    const cardId = this.cardId;
    if (cardId === null) return;
    const uid = ++this.nextUploadId;
    this.uploads.set(uid, { uid, name: file.name, loaded: 0, total: file.size, phase: 'hashing' });
    this.paintUploads();

    uploadFile(this.ctx.api, cardId, file, {
      ...(this.postChunk ? { postChunk: this.postChunk } : {}),
      ...(this.config.chunkBytes !== undefined ? { chunkBytes: this.config.chunkBytes } : {}),
      alive: () => this.isAlive(),
      onProgress: (p) => {
        const cur = this.uploads.get(uid);
        if (cur === undefined) return;
        cur.loaded = p.loaded;
        cur.total = p.total;
        cur.phase = p.phase;
        this.paintUploads();
      },
      onDone: (row) => {
        if (!this.isAlive()) return;
        this.uploads.delete(uid);
        // Optimistic prepend so the new row shows instantly; reload reconciles.
        this.rows = [row, ...this.rows.filter((r) => r.id !== row.id)];
        this.paintUploads();
        this.paintList();
        this.onChanged?.();
        this.loadList();
      },
      onError: () => {
        if (!this.isAlive()) return;
        // The central funnel toasts decode/network/sub_error already; for raw
        // chunk-POST errors surface a per-upload failed state briefly then drop.
        const cur = this.uploads.get(uid);
        if (cur !== undefined) {
          this.uploads.delete(uid);
          this.paintUploads();
        }
      },
    });
  }

  private onDragOver(e: DragEvent): void {
    e.preventDefault();
    if (!this.dragOver) {
      this.dragOver = true;
      this.dropzone.classList.add('attachments__zone--drag');
    }
  }
  private onDragLeave(): void {
    this.dragOver = false;
    this.dropzone.classList.remove('attachments__zone--drag');
  }
  private onDrop(e: DragEvent): void {
    e.preventDefault();
    this.onDragLeave();
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) this.handleFiles(files);
  }

  /* -------------------------------- delete ------------------------------ */

  /**
   * Soft-delete an attachment via `attachment.delete`, OPTIMISTICALLY: drop the
   * row immediately; restore it on fault (the central funnel already toasted).
   */
  private onDelete(row: AttachmentRow): void {
    if (this.cardId === null) return;
    const prev = this.rows;
    this.rows = this.rows.filter((r) => r.id !== row.id);
    this.releaseThumb(row.id);
    this.paintList();

    this.ctx.api.callByName(
      ATTACHMENT_DELETE_SPEC,
      { id: row.id },
      (out) => {
        void (out as AttachmentDeleteOutput);
        if (!this.isAlive()) return;
        this.onChanged?.();
        this.loadList();
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          if (!this.isAlive()) return;
          this.rows = prev;
          this.paintList();
        },
      },
    );
  }

  /* ------------------------------- download ----------------------------- */

  /** Save-as download via a fetched blob → object URL (auth-path friendly). */
  private onDownload(row: AttachmentRow): void {
    this.fetchBlob(
      downloadUrl(row.id),
      (blob) => {
        if (!this.isAlive()) return;
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objUrl;
        a.download = row.filename;
        document.body.append(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objUrl);
      },
      () => {
        // Failure already surfaced by the fetcher's own error path; nothing to
        // roll back for a read-only download.
      },
    );
  }

  /* -------------------------------- list -------------------------------- */

  private paintList(): void {
    // Keep the main-column preview strip in sync on every list repaint.
    this.paintPreviews();
    this.listHost.replaceChildren();
    this.countEl.textContent = this.rows.length > 0 ? `(${this.rows.length})` : '';

    if (this.loading && this.rows.length === 0) {
      const wait = document.createElement('p');
      wait.className = 'attachments__loading muted';
      wait.dataset.attachmentsLoading = '';
      wait.textContent = 'Loading attachments…';
      this.listHost.append(wait);
      return;
    }

    if (this.rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'attachments__empty muted';
      empty.dataset.attachmentsEmpty = '';
      empty.textContent = 'No attachments. Drag a file here or choose one below.';
      this.listHost.append(empty);
      return;
    }

    const ul = document.createElement('ul');
    ul.className = 'attachments__items';
    ul.dataset.attachmentsList = '';
    for (const row of this.rows) ul.append(this.renderRow(row));
    this.listHost.append(ul);
  }

  private renderRow(row: AttachmentRow): HTMLElement {
    const li = document.createElement('li');
    li.className = 'attachments__item';
    li.dataset.attachmentRow = row.id.toString();
    li.dataset.attachmentKind = row.kind;

    // Thumbnail (image) or a kind glyph. Image thumbs + viewable (image/pdf)
    // rows open the gallery on click.
    const viewable = row.kind === 'image' || row.kind === 'pdf';
    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'attachments__thumb';
    thumb.dataset.attachmentThumb = row.id.toString();
    thumb.disabled = !viewable;
    if (viewable) {
      thumb.title = `View ${row.filename}`;
      thumb.setAttribute('aria-label', `View ${row.filename}`);
      this.listen(thumb, 'click', () => this.openGallery(row));
    }
    if (row.kind === 'image' && row.thumbFileId !== 0n) {
      const img = document.createElement('img');
      img.className = 'attachments__thumb-img';
      img.alt = row.filename;
      thumb.append(img);
      this.loadThumb(row, img);
    } else {
      const glyph = document.createElement('span');
      glyph.className = 'attachments__thumb-glyph';
      glyph.textContent = row.kind === 'pdf' ? '📄' : row.kind === 'image' ? '🖼' : '📎';
      thumb.append(glyph);
    }
    li.append(thumb);

    const meta = document.createElement('div');
    meta.className = 'attachments__meta';

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'attachments__name';
    name.dataset.attachmentName = '';
    name.title = `${row.filename} (${formatBytes(row.sizeBytes)}) — download`;
    name.textContent = row.filename;
    this.listen(name, 'click', () => this.onDownload(row));
    meta.append(name);

    const size = document.createElement('span');
    size.className = 'attachments__size muted';
    size.textContent = formatBytes(row.sizeBytes);
    meta.append(size);
    li.append(meta);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'attachments__del';
    del.dataset.attachmentDelete = row.id.toString();
    del.title = `Remove ${row.filename}`;
    del.setAttribute('aria-label', `Remove ${row.filename}`);
    del.append(icon('x', 14));
    this.listen(del, 'click', () => this.onDelete(row));
    li.append(del);

    return li;
  }

  /** Fetch an image thumbnail blob → object URL and apply it to the <img>.
   *  Coalesces concurrent calls for the same attachment (the preview-strip tile
   *  and the right-rail row request the same thumb) onto one fetch + URL. */
  private loadThumb(row: AttachmentRow, img: HTMLImageElement): void {
    const key = row.id.toString();
    const cached = this.thumbUrls.get(key);
    if (cached !== undefined) {
      img.src = cached;
      return;
    }
    const pending = this.thumbPending.get(key);
    if (pending !== undefined) {
      pending.push(img);
      return;
    }
    this.thumbPending.set(key, [img]);
    this.fetchBlob(
      thumbUrl(row.id),
      (blob) => {
        const targets = this.thumbPending.get(key) ?? [];
        this.thumbPending.delete(key);
        if (!this.isAlive()) return;
        const objUrl = URL.createObjectURL(blob);
        this.thumbUrls.set(key, objUrl);
        // Targets may have been re-rendered; only set if still attached.
        for (const t of targets) if (t.isConnected) t.src = objUrl;
      },
      () => {
        // Thumb missing/failed — leave the empty image(s); not fatal.
        this.thumbPending.delete(key);
      },
    );
  }

  private releaseThumb(id: bigint): void {
    const key = id.toString();
    const url = this.thumbUrls.get(key);
    if (url !== undefined) {
      URL.revokeObjectURL(url);
      this.thumbUrls.delete(key);
    }
  }

  /* ---------------------------- preview strip --------------------------- */

  /**
   * Paint the MAIN-column preview strip (image + PDF tiles) into `previewHost`,
   * if one was provided. Reuses the section's rows + thumb cache + gallery, so
   * it tracks the right-rail list automatically. Hidden when nothing previewable.
   */
  private paintPreviews(): void {
    const host = this.previewHost;
    if (host === undefined) return;
    host.replaceChildren();
    const previewable = this.viewableRows();
    host.style.display = previewable.length === 0 ? 'none' : '';
    if (previewable.length === 0) return;

    const strip = document.createElement('div');
    strip.className = 'attachments-strip';
    strip.dataset.attachmentsStrip = '';
    for (const row of previewable) strip.append(this.renderTile(row));
    host.append(strip);
  }

  /** One preview tile: a thumbnail box (image thumb / PDF or fallback glyph) +
   *  a truncated filename; clicking opens the shared gallery at that item. */
  private renderTile(row: AttachmentRow): HTMLElement {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'attachments-strip__tile';
    tile.dataset.attachmentTile = row.id.toString();
    tile.title = row.filename;
    tile.setAttribute('aria-label', `View ${row.filename}`);
    this.listen(tile, 'click', () => this.openGallery(row));

    const box = document.createElement('div');
    box.className = 'attachments-strip__box';
    if (row.kind === 'image' && row.thumbFileId !== 0n) {
      const img = document.createElement('img');
      img.className = 'attachments-strip__img';
      img.alt = '';
      box.append(img);
      this.loadThumb(row, img);
    } else {
      const glyph = document.createElement('span');
      glyph.className = 'attachments-strip__glyph';
      glyph.dataset.kind = row.kind;
      // PDFs (and images whose server thumb failed) get a kind glyph.
      glyph.textContent = row.kind === 'pdf' ? 'PDF' : '🖼';
      box.append(glyph);
    }
    tile.append(box);

    const name = document.createElement('span');
    name.className = 'attachments-strip__name';
    name.textContent = truncateFilename(row.filename);
    tile.append(name);
    return tile;
  }

  /* ------------------------------- uploads UI --------------------------- */

  private paintUploads(): void {
    this.uploadsHost.replaceChildren();
    for (const up of this.uploads.values()) {
      const row = document.createElement('div');
      row.className = 'attachments__upload';
      row.dataset.attachmentUpload = '';

      const name = document.createElement('span');
      name.className = 'attachments__upload-name';
      name.title = up.name;
      name.textContent = up.name;
      row.append(name);

      const status = document.createElement('span');
      status.className = 'attachments__upload-status muted';
      status.dataset.uploadPhase = up.phase;
      status.textContent =
        up.phase === 'hashing'
          ? 'Hashing…'
          : up.phase === 'saving'
            ? 'Saving…'
            : `${formatBytes(up.loaded)} / ${formatBytes(up.total)}`;
      row.append(status);

      this.uploadsHost.append(row);
    }
  }

  /* ------------------------------- gallery ------------------------------ */

  /** The rows that can be shown in the gallery (image + pdf), in list order. */
  private viewableRows(): AttachmentRow[] {
    return this.rows.filter((r) => r.kind === 'image' || r.kind === 'pdf');
  }

  private openGallery(row: AttachmentRow): void {
    const viewable = this.viewableRows();
    const index = viewable.findIndex((r) => r.id === row.id);
    if (index < 0) return;
    this.closeGallery();

    const root = document.createElement('div');
    root.className = 'attachments__gallery';
    root.dataset.attachmentsGallery = '';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.tabIndex = -1;

    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'attachments__gallery-nav attachments__gallery-prev';
    prev.dataset.galleryPrev = '';
    prev.setAttribute('aria-label', 'Previous');
    prev.append(icon('chevron-left'));
    this.listen(prev, 'click', (e) => {
      e.stopPropagation();
      this.galleryStep(-1);
    });

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'attachments__gallery-nav attachments__gallery-next';
    next.dataset.galleryNext = '';
    next.setAttribute('aria-label', 'Next');
    next.append(icon('chevron-right'));
    this.listen(next, 'click', (e) => {
      e.stopPropagation();
      this.galleryStep(1);
    });

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'attachments__gallery-close';
    close.dataset.galleryClose = '';
    close.setAttribute('aria-label', 'Close');
    close.append(icon('x'));
    this.listen(close, 'click', (e) => {
      e.stopPropagation();
      this.closeGallery();
    });

    const viewerHost = document.createElement('div');
    viewerHost.className = 'attachments__gallery-viewer';
    viewerHost.dataset.galleryViewer = '';

    root.append(close, prev, viewerHost, next);
    // Click on the backdrop (not the viewer) closes.
    this.listen(root, 'click', (e) => {
      if (e.target === root) this.closeGallery();
    });
    this.listen(root, 'keydown', (e) => this.onGalleryKey(e as KeyboardEvent));

    document.body.append(root);
    this.gallery = { root, viewerHost, index, objUrl: null };
    this.paintGallery();
    queueMicrotask(() => root.focus());
  }

  private galleryStep(delta: number): void {
    const g = this.gallery;
    if (g === null) return;
    const viewable = this.viewableRows();
    if (viewable.length === 0) return;
    g.index = (g.index + delta + viewable.length) % viewable.length;
    this.paintGallery();
  }

  private onGalleryKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.closeGallery();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this.galleryStep(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      this.galleryStep(1);
    }
  }

  private paintGallery(): void {
    const g = this.gallery;
    if (g === null) return;
    const viewable = this.viewableRows();
    const row = viewable[g.index];
    g.viewerHost.replaceChildren();
    // Revoke any prior view object URL before fetching the next.
    if (g.objUrl !== null) {
      URL.revokeObjectURL(g.objUrl);
      g.objUrl = null;
    }
    if (row === undefined) {
      this.closeGallery();
      return;
    }

    const caption = document.createElement('div');
    caption.className = 'attachments__gallery-caption';
    caption.dataset.galleryCaption = '';
    caption.textContent = `${row.filename} (${g.index + 1}/${viewable.length})`;
    g.viewerHost.append(caption);

    const loading = document.createElement('div');
    loading.className = 'attachments__gallery-loading muted';
    loading.textContent = 'Loading…';
    g.viewerHost.append(loading);

    const showingId = row.id;
    this.fetchBlob(
      viewUrl(row.id),
      (blob) => {
        const cur = this.gallery;
        // Drop a late delivery if the gallery closed or paged away.
        if (cur === null || !this.isAlive()) return;
        const stillShowing = this.viewableRows()[cur.index];
        if (stillShowing === undefined || stillShowing.id !== showingId) return;
        const objUrl = URL.createObjectURL(blob);
        cur.objUrl = objUrl;
        loading.remove();
        if (row.kind === 'pdf') {
          const frame = document.createElement('iframe');
          frame.className = 'attachments__gallery-frame';
          frame.title = row.filename;
          frame.src = objUrl;
          cur.viewerHost.append(frame);
        } else {
          const img = document.createElement('img');
          img.className = 'attachments__gallery-img';
          img.alt = row.filename;
          img.src = objUrl;
          cur.viewerHost.append(img);
        }
      },
      () => {
        if (this.gallery === null) return;
        loading.textContent = 'Failed to load.';
      },
    );
  }

  private closeGallery(): void {
    const g = this.gallery;
    if (g === null) return;
    if (g.objUrl !== null) URL.revokeObjectURL(g.objUrl);
    g.root.remove();
    this.gallery = null;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                     */
/* -------------------------------------------------------------------------- */

/** Parse a config id string to a positive bigint, or null when malformed. */
function parseId(raw: string | undefined): bigint | null {
  if (raw === undefined || raw === '') return null;
  if (!/^\d+$/.test(raw)) return null;
  try {
    const n = BigInt(raw);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

/** Human-readable byte size. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** `prefix…suffix.ext` — keep the head + tail + extension so a long filename
 *  stays recognisable under a tile (ports the Svelte strip's truncation). */
export function truncateFilename(name: string, max = 20): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  const base = dot > 0 ? name.slice(0, dot) : name;
  const keep = max - 1 - ext.length; // 1 for the ellipsis
  if (keep < 4) return `${name.slice(0, Math.max(1, max - 1))}…`;
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${base.slice(0, head)}…${base.slice(base.length - tail)}${ext}`;
}

/** The default same-origin blob fetcher (cookie auth). Callback surface. */
function defaultFetchBlob(
  url: string,
  onDone: (b: Blob) => void,
  onError: (e: Error) => void,
): void {
  void (async () => {
    try {
      const resp = await fetch(url, { method: 'GET' });
      if (!resp.ok) {
        onError(new Error(`HTTP ${resp.status}`));
        return;
      }
      onDone(await resp.blob());
    } catch (e) {
      onError(e instanceof Error ? e : new Error(String(e)));
    }
  })();
}

export function registerAttachmentsSection(): void {
  Control.register('AttachmentsSection', AttachmentsSection);
}
