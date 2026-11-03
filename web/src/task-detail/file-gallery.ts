/**
 * FileGallery — the full-screen viewer for files kitp holds: an image, a PDF
 * (in a frame) or a markdown file (rendered). ←/→ (or the side buttons) page
 * through the viewable files, Esc / × / a click on the backdrop closes it.
 *
 * Shared by the task's Attachments section and the conversation's message
 * files (task-comm-threads.ts), so both look and behave the same. The owner
 * passes a getter for its current files (the list can change while the
 * gallery is open: it re-reads it on every page) and the blob fetcher it uses;
 * it must call {@link FileGallery.close} when it is destroyed. The gallery's
 * listeners live on its own elements and go with them.
 */

import { icon } from '../ui/icons.js';
import { setMarkdown } from '../util/markdown-control.js';
import { viewUrl } from './upload.js';
import type { AttachmentKind } from './attachment-specs.js';

/** One file the gallery can be asked to show. */
export interface GalleryFile {
  id: bigint;
  filename: string;
  kind: AttachmentKind;
}

/** Fetch a URL's bytes (cookie auth); callbacks, like the rest of the client. */
export type FetchBlob = (url: string, onDone: (b: Blob) => void, onError: (e: Error) => void) => void;

/** Whether the gallery can show a file of this kind (image / pdf / markdown). */
export function isViewableKind(kind: string): boolean {
  return kind === 'image' || kind === 'pdf' || kind === 'markdown';
}

/** The default fetcher: a same-origin GET. */
export function fetchBlobDefault(url: string, onDone: (b: Blob) => void, onError: (e: Error) => void): void {
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

export interface FileGalleryOptions {
  /** The owner's files now; only the viewable ones are shown, in order. */
  files: () => readonly GalleryFile[];
  fetchBlob: FetchBlob;
  /** False once the owner is gone: late deliveries are dropped. */
  alive?: () => boolean;
}

export class FileGallery {
  private state: { root: HTMLElement; viewerHost: HTMLElement; index: number; objUrl: string | null } | null = null;

  constructor(private readonly opts: FileGalleryOptions) {}

  get isOpen(): boolean {
    return this.state !== null;
  }

  private viewable(): GalleryFile[] {
    return this.opts.files().filter((f) => isViewableKind(f.kind));
  }

  private alive(): boolean {
    return this.opts.alive === undefined || this.opts.alive();
  }

  /** Open at the file with this id; a file that can't be shown opens nothing. */
  open(id: bigint): void {
    const index = this.viewable().findIndex((f) => f.id === id);
    if (index < 0) return;
    this.close();

    const root = document.createElement('div');
    root.className = 'attachments__gallery';
    root.dataset.attachmentsGallery = '';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.tabIndex = -1;

    const button = (cls: string, data: string, label: string, glyph: 'chevron-left' | 'chevron-right' | 'x', fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.dataset[data] = '';
      b.setAttribute('aria-label', label);
      b.append(icon(glyph));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };
    const prev = button('attachments__gallery-nav attachments__gallery-prev', 'galleryPrev', 'Previous', 'chevron-left', () => this.step(-1));
    const next = button('attachments__gallery-nav attachments__gallery-next', 'galleryNext', 'Next', 'chevron-right', () => this.step(1));
    const close = button('attachments__gallery-close', 'galleryClose', 'Close', 'x', () => this.close());

    const viewerHost = document.createElement('div');
    viewerHost.className = 'attachments__gallery-viewer';
    viewerHost.dataset.galleryViewer = '';

    root.append(close, prev, viewerHost, next);
    // A click on the backdrop (not the viewer) closes.
    root.addEventListener('click', (e) => {
      if (e.target === root) this.close();
    });
    root.addEventListener('keydown', (e) => this.onKey(e));

    document.body.append(root);
    this.state = { root, viewerHost, index, objUrl: null };
    this.paint();
    queueMicrotask(() => root.focus());
  }

  /** Page by delta (wrapping). */
  step(delta: number): void {
    const g = this.state;
    if (g === null) return;
    const viewable = this.viewable();
    if (viewable.length === 0) return;
    g.index = (g.index + delta + viewable.length) % viewable.length;
    this.paint();
  }

  close(): void {
    const g = this.state;
    if (g === null) return;
    if (g.objUrl !== null) URL.revokeObjectURL(g.objUrl);
    g.root.remove();
    this.state = null;
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this.step(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      this.step(1);
    }
  }

  private paint(): void {
    const g = this.state;
    if (g === null) return;
    const viewable = this.viewable();
    const file = viewable[g.index];
    g.viewerHost.replaceChildren();
    // Revoke any prior view object URL before fetching the next.
    if (g.objUrl !== null) {
      URL.revokeObjectURL(g.objUrl);
      g.objUrl = null;
    }
    if (file === undefined) {
      this.close();
      return;
    }

    const caption = document.createElement('div');
    caption.className = 'attachments__gallery-caption';
    caption.dataset.galleryCaption = '';
    caption.textContent = `${file.filename} (${g.index + 1}/${viewable.length})`;
    g.viewerHost.append(caption);

    const loading = document.createElement('div');
    loading.className = 'attachments__gallery-loading muted';
    loading.textContent = 'Loading…';
    g.viewerHost.append(loading);

    const showing = file.id;
    const stillShowing = (cur: typeof g): boolean => this.state === cur && this.viewable()[cur.index]?.id === showing;
    this.opts.fetchBlob(
      viewUrl(file.id),
      (blob) => {
        // Drop a late delivery if the gallery closed or paged away.
        if (!this.alive() || !stillShowing(g)) return;
        if (file.kind === 'markdown') {
          blob.text().then(
            (text) => {
              if (!stillShowing(g)) return;
              loading.remove();
              const doc = document.createElement('div');
              doc.className = 'attachments__gallery-doc';
              doc.dataset.galleryDoc = '';
              setMarkdown(doc, text);
              g.viewerHost.append(doc);
            },
            () => {
              if (this.state === g) loading.textContent = 'Failed to load.';
            },
          );
          return;
        }
        const objUrl = URL.createObjectURL(blob);
        g.objUrl = objUrl;
        loading.remove();
        if (file.kind === 'pdf') {
          const frame = document.createElement('iframe');
          frame.className = 'attachments__gallery-frame';
          frame.title = file.filename;
          frame.src = objUrl;
          g.viewerHost.append(frame);
        } else {
          const img = document.createElement('img');
          img.className = 'attachments__gallery-img';
          img.alt = file.filename;
          img.src = objUrl;
          g.viewerHost.append(img);
        }
      },
      () => {
        if (this.state === g) loading.textContent = 'Failed to load.';
      },
    );
  }
}
