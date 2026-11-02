/**
 * ThemeFiles — the FILES panel of the Themes admin screen: what a theme is
 * made of, and how it is forked.
 *
 * A theme card starts from a built-in theme (Side menu, Newspaper, …) whose
 * files are read-only. The panel lists the base's files together with the
 * theme's own (`theme_file` rows), each marked "Built in", "Yours" or "Yours,
 * replaces the built-in one":
 *
 *   - View a built-in file (read-only), or Customize it: a copy is saved as
 *     the theme's own file and opened for editing.
 *   - Edit a text file of the theme's own (templates, CSS, theme.json) and
 *     Save; a template the server can't render is refused with its file and
 *     line. Revert drops the copy so the built-in file applies again; Delete
 *     removes a file the base doesn't have.
 *   - Upload any file (an image, a font, a whole page.html); Logo and
 *     Favicon upload logo.* / favicon.* (replacing the previous one).
 *   - New file starts an empty text file (custom.css, blocks.html …).
 *
 * It reads the master's `${parentScope}.selectedId` + `.items` (the decoded
 * theme.list rows) and, after every write, re-issues theme.list into
 * `.items` so the file list shows server truth. Zero promises: every call is
 * api.callByName(..., { alive }); the one browser read (a picked file) is a
 * FileReader callback.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { ApiFault } from '../core/dispatch.js';
import type { MasterDetailItem } from './master-detail.js';
import { faultText } from './record-form.js';
import {
  THEME_SPEC,
  type ThemeBase,
  type ThemeBasesOutput,
  type ThemeFileContent,
  type ThemeOwnFile,
  type ThemeRow,
} from '../bundles/specs.js';

export interface ThemeFilesConfig extends BaseControlConfig {
  type: 'ThemeFiles';
  /** The MasterDetail scope whose `.selectedId` / `.items` this follows. */
  parentScope: string;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    ThemeFiles: ThemeFilesConfig;
  }
}

/** Where a listed file comes from. */
export type ThemeFileOrigin = 'base' | 'own' | 'override';

export interface ThemeFileListRow {
  path: string;
  origin: ThemeFileOrigin;
  /** Edited as text (templates, stylesheets, JSON, SVG). */
  isText: boolean;
  sizeBytes: number;
}

const TEXT_EXT = /\.(html|css|json|txt|svg)$/;

/**
 * The files a theme is made of: its base's files and its own, by path. An
 * own file at a base file's path overrides it.
 */
export function themeFileRows(base: ThemeBase | undefined, own: readonly ThemeOwnFile[]): ThemeFileListRow[] {
  const rows = new Map<string, ThemeFileListRow>();
  for (const f of base?.files ?? []) {
    rows.set(f.path, { path: f.path, origin: 'base', isText: f.isText, sizeBytes: f.sizeBytes });
  }
  for (const f of own) {
    rows.set(f.path, {
      path: f.path,
      origin: rows.has(f.path) ? 'override' : 'own',
      isText: TEXT_EXT.test(f.path),
      sizeBytes: f.sizeBytes,
    });
  }
  return [...rows.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** A theme-file name for an uploaded file: lower case, '-' for anything a
 *  theme path can't hold. */
export function themePathForUpload(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^[-.]+/, '');
}

/** The logo / favicon path for an uploaded image, keeping its extension. */
export function brandPath(kind: 'logo' | 'favicon', fileName: string): string | null {
  const ext = /\.([a-z0-9]+)$/.exec(fileName.toLowerCase())?.[1] ?? '';
  const ok = kind === 'logo' ? ['svg', 'png', 'webp', 'jpg', 'jpeg', 'gif'] : ['svg', 'png', 'ico'];
  return ok.includes(ext) ? `${kind}.${ext}` : null;
}

const ORIGIN_LABEL: Record<ThemeFileOrigin, string> = {
  base: 'Built in',
  own: 'Yours',
  override: 'Yours, replaces the built-in one',
};

function sizeLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / 104857.6) / 10} MB`;
}

/** base64 of bytes, in chunks (String.fromCharCode has an argument cap). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** The file open in the viewer / editor. */
interface OpenFile {
  path: string;
  /** A built-in file: read-only. */
  readOnly: boolean;
  content: ThemeFileContent | null;
  /** The editor's text (text files). */
  draft: string;
  error: string;
  busy: boolean;
}

export class ThemeFiles extends Control<ThemeFilesConfig> {
  private bases: ThemeBase[] = [];
  private basesLoaded = false;
  private theme: ThemeRow | null = null;
  private open: OpenFile | null = null;
  /** The panel-level message (an upload or delete that failed). */
  private error = '';
  private busy = false;
  private lastThemeId = '';

  private get selectedPath(): string[] {
    return `${this.config.parentScope}.selectedId`.split('.');
  }
  private get itemsPath(): string[] {
    return `${this.config.parentScope}.items`.split('.');
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'theme-files';
    el.dataset.control = 'ThemeFiles';
    return el;
  }

  protected render(): void {
    this.effect(() => {
      const sel = this.ctx.tree.at(this.selectedPath).get<string | null>() ?? null;
      const items = (this.ctx.tree.at(this.itemsPath).get<MasterDetailItem[]>() ?? []) as MasterDetailItem[];
      const item = sel === null ? undefined : items.find((it) => it.id === sel);
      this.theme = item === undefined ? null : (item.raw as unknown as ThemeRow);
      const id = this.theme === null ? '' : this.theme.id.toString();
      if (id !== this.lastThemeId) {
        this.lastThemeId = id;
        this.open = null;
        this.error = '';
      }
      this.paint();
    }, 'themeFiles.render');
    this.loadBases();
  }

  private loadBases(): void {
    this.ctx.api.callByName(
      THEME_SPEC.bases,
      {},
      (out) => {
        if (!this.isAlive()) return;
        this.bases = (out as ThemeBasesOutput).rows ?? [];
        this.basesLoaded = true;
        this.paint();
      },
      { alive: () => this.isAlive() },
    );
  }

  private base(): ThemeBase | undefined {
    return this.theme === null ? undefined : this.bases.find((b) => b.key === this.theme?.base);
  }

  /* ------------------------------- painting ------------------------------- */

  private paint(): void {
    const theme = this.theme;
    const heading = document.createElement('h3');
    heading.className = 'theme-files__heading muted';
    heading.textContent = 'FILES';
    if (theme === null || theme.id === 0n) {
      const empty = document.createElement('p');
      empty.className = 'muted theme-files__empty';
      empty.textContent = 'Save the theme to add files to it.';
      this.el.replaceChildren(heading, ...(theme === null ? [] : [empty]));
      return;
    }
    const base = this.base();
    const intro = document.createElement('p');
    intro.className = 'theme-files__intro muted';
    intro.dataset.themeFilesIntro = '';
    intro.textContent = base
      ? `Starts from ${base.name}: ${base.description} Built-in files are read-only; customize one to make it yours.`
      : this.basesLoaded
        ? `Its base theme "${theme.base}" isn't built in; the site uses Side menu.`
        : 'Loading…';

    const parts: HTMLElement[] = [heading, intro, this.renderBrand(theme), this.renderList(base, theme)];
    parts.push(this.renderAdd(theme));
    if (this.error !== '') {
      const err = document.createElement('p');
      err.className = 'theme-files__error';
      err.dataset.themeFilesError = '';
      err.textContent = this.error;
      parts.push(err);
    }
    if (this.open !== null) parts.push(this.renderOpen(this.open));
    this.el.replaceChildren(...parts);
  }

  /** Logo and Favicon: the current file (if any) with Upload / Remove. */
  private renderBrand(theme: ThemeRow): HTMLElement {
    const box = document.createElement('div');
    box.className = 'theme-files__brand';
    for (const kind of ['logo', 'favicon'] as const) {
      const row = document.createElement('div');
      row.className = 'theme-files__brand-row';
      row.dataset.themeBrand = kind;
      const label = document.createElement('span');
      label.className = 'theme-files__brand-label';
      label.textContent = kind === 'logo' ? 'Logo' : 'Favicon';
      const current = theme.files.filter((f) => f.path.startsWith(`${kind}.`));
      const name = document.createElement('span');
      name.className = 'muted';
      name.textContent = current.length > 0 ? current.map((f) => f.path).join(', ') : 'None';
      const upload = this.fileButton(kind === 'logo' ? 'Upload logo…' : 'Upload favicon…', kind === 'logo' ? 'image/*' : 'image/png,image/svg+xml,image/x-icon,.ico', (file) => {
        const p = brandPath(kind, file.name);
        if (p === null) {
          this.setError(kind === 'logo' ? 'A logo is an .svg, .png, .webp, .jpg or .gif file.' : 'A favicon is an .svg, .png or .ico file.');
          return;
        }
        this.uploadFile(file, p, current.map((f) => f.path).filter((x) => x !== p));
      });
      upload.dataset.themeBrandUpload = kind;
      row.append(label, name, upload);
      if (current.length > 0) {
        const remove = this.button('Remove', () => this.deleteFiles(current.map((f) => f.path)));
        remove.dataset.themeBrandRemove = kind;
        row.append(remove);
      }
      box.append(row);
    }
    return box;
  }

  private renderList(base: ThemeBase | undefined, theme: ThemeRow): HTMLElement {
    const list = document.createElement('ul');
    list.className = 'theme-files__list';
    list.dataset.themeFiles = '';
    for (const r of themeFileRows(base, theme.files)) {
      const li = document.createElement('li');
      li.className = `theme-files__row theme-files__row--${r.origin}`;
      li.dataset.themeFile = r.path;
      li.dataset.origin = r.origin;
      if (this.open?.path === r.path) li.classList.add('is-open');
      const name = document.createElement('code');
      name.className = 'theme-files__path';
      name.textContent = r.path;
      const origin = document.createElement('span');
      origin.className = 'theme-files__origin muted';
      origin.textContent = `${ORIGIN_LABEL[r.origin]} · ${sizeLabel(r.sizeBytes)}`;
      const actions = document.createElement('span');
      actions.className = 'theme-files__actions';
      if (r.origin === 'base') {
        actions.append(this.button('View', () => this.openFile(r.path, true), 'view'));
        if (r.isText) actions.append(this.button('Customize', () => this.customize(r.path), 'customize'));
      } else {
        actions.append(this.button(r.isText ? 'Edit' : 'View', () => this.openFile(r.path, false), r.isText ? 'edit' : 'view'));
        actions.append(
          this.button(r.origin === 'override' ? 'Revert' : 'Delete', () => this.deleteFiles([r.path]), r.origin === 'override' ? 'revert' : 'delete'),
        );
      }
      li.append(name, origin, actions);
      list.append(li);
    }
    return list;
  }

  /** New text file + Upload file. */
  private renderAdd(_theme: ThemeRow): HTMLElement {
    const row = document.createElement('div');
    row.className = 'theme-files__add';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'record-form__input theme-files__new-path';
    input.placeholder = 'custom.css';
    input.setAttribute('aria-label', 'New file name');
    input.dataset.themeNewPath = '';
    const create = this.button('New file', () => {
      const p = input.value.trim();
      if (p === '') return;
      this.saveText(p, '', true);
    }, 'new');
    const upload = this.fileButton('Upload file…', '', (file) => this.uploadFile(file, themePathForUpload(file.name), []));
    upload.dataset.themeUpload = '';
    row.append(input, create, upload);
    return row;
  }

  private renderOpen(o: OpenFile): HTMLElement {
    const box = document.createElement('div');
    box.className = 'theme-files__open';
    box.dataset.themeOpen = o.path;
    const head = document.createElement('div');
    head.className = 'theme-files__open-head';
    const title = document.createElement('code');
    title.textContent = o.path;
    head.append(title);
    if (o.readOnly) {
      const ro = document.createElement('span');
      ro.className = 'theme-files__badge muted';
      ro.textContent = 'Built in · read-only';
      head.append(ro);
    }
    box.append(head);

    const c = o.content;
    if (c === null) {
      const loading = document.createElement('p');
      loading.className = 'muted';
      loading.textContent = 'Loading…';
      box.append(loading);
    } else if (c.isText) {
      const area = document.createElement('textarea');
      area.className = 'theme-files__editor';
      area.dataset.themeEditor = '';
      area.spellcheck = false;
      area.readOnly = o.readOnly;
      area.value = o.draft;
      area.rows = Math.min(28, Math.max(8, o.draft.split('\n').length + 1));
      this.listen(area, 'input', () => {
        o.draft = area.value;
      });
      box.append(area);
    } else if (c.mimeType.startsWith('image/')) {
      const img = document.createElement('img');
      img.className = 'theme-files__image';
      img.alt = o.path;
      img.src = `data:${c.mimeType};base64,${c.contentBase64}`;
      box.append(img);
    } else {
      const bin = document.createElement('p');
      bin.className = 'muted';
      bin.textContent = `${c.mimeType}, ${sizeLabel(c.sizeBytes)}. Upload a file with the same name to replace it.`;
      box.append(bin);
    }

    if (o.error !== '') {
      const err = document.createElement('p');
      err.className = 'theme-files__error';
      err.dataset.themeEditorError = '';
      err.textContent = o.error;
      box.append(err);
    }
    const actions = document.createElement('div');
    actions.className = 'theme-files__open-actions';
    if (o.readOnly && c?.isText === true) {
      actions.append(this.button('Customize', () => this.customize(o.path), 'open-customize'));
    }
    if (!o.readOnly && c?.isText === true) {
      const save = this.button('Save', () => this.saveText(o.path, o.draft, false), 'save');
      save.classList.add('btn-primary');
      save.disabled = o.busy;
      actions.append(save);
    }
    actions.append(
      this.button('Close', () => {
        this.open = null;
        this.paint();
      }, 'close'),
    );
    box.append(actions);
    return box;
  }

  private button(label: string, onClick: () => void, key?: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn--xs';
    b.textContent = label;
    b.disabled = this.busy;
    if (key !== undefined) b.dataset.themeAction = key;
    this.listen(b, 'click', onClick);
    return b;
  }

  /** A button that opens the browser's file picker and hands back the file. */
  private fileButton(label: string, accept: string, onFile: (f: File) => void): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'btn btn--xs theme-files__file';
    const input = document.createElement('input');
    input.type = 'file';
    input.className = 'theme-files__file-input';
    if (accept !== '') input.accept = accept;
    input.disabled = this.busy;
    this.listen(input, 'change', () => {
      const f = input.files?.[0];
      input.value = '';
      if (f !== undefined) onFile(f);
    });
    wrap.append(document.createTextNode(label), input);
    return wrap;
  }

  /* -------------------------------- actions ------------------------------- */

  private themeId(): bigint {
    return this.theme?.id ?? 0n;
  }

  private setError(msg: string): void {
    this.error = msg;
    this.paint();
  }

  private openFile(path: string, readOnly: boolean): void {
    const theme = this.theme;
    if (theme === null) return;
    this.open = { path, readOnly, content: null, draft: '', error: '', busy: false };
    this.paint();
    const done = (out: unknown): void => {
      if (!this.isAlive() || this.open?.path !== path) return;
      const c = out as ThemeFileContent;
      this.open.content = c;
      this.open.draft = c.text;
      this.paint();
    };
    const onErr = (f: ApiFault): void => {
      if (this.open?.path !== path) return;
      this.open.error = message(f);
      this.paint();
    };
    if (readOnly) {
      this.ctx.api.callByName(THEME_SPEC.baseFile, { key: theme.base, path }, done, { alive: () => this.isAlive(), onErr });
    } else {
      this.ctx.api.callByName(THEME_SPEC.fileGet, { themeId: theme.id, path }, done, { alive: () => this.isAlive(), onErr });
    }
  }

  /** Copy a built-in file into the theme and open the copy for editing. */
  private customize(path: string): void {
    const theme = this.theme;
    if (theme === null) return;
    this.busy = true;
    this.paint();
    this.ctx.api.callByName(
      THEME_SPEC.baseFile,
      { key: theme.base, path },
      (out) => {
        if (!this.isAlive()) return;
        this.busy = false;
        this.saveText(path, (out as ThemeFileContent).text, true);
      },
      {
        alive: () => this.isAlive(),
        onErr: (f) => {
          this.busy = false;
          this.setError(message(f));
        },
      },
    );
  }

  /** Save a text file; `reopen` opens it in the editor afterwards. */
  private saveText(path: string, text: string, reopen: boolean): void {
    const id = this.themeId();
    if (id === 0n) return;
    if (this.open?.path === path) {
      this.open.busy = true;
      this.open.error = '';
    }
    this.error = '';
    this.paint();
    this.ctx.api.callByName(
      THEME_SPEC.filePut,
      { themeId: id, path, text },
      () => {
        if (!this.isAlive()) return;
        if (reopen || this.open?.path !== path) {
          this.open = { path, readOnly: false, content: { path, mimeType: '', sizeBytes: text.length, isText: true, text, contentBase64: '' }, draft: text, error: '', busy: false };
        } else {
          this.open.busy = false;
          this.open.readOnly = false;
        }
        this.reloadList();
      },
      {
        alive: () => this.isAlive(),
        onErr: (f) => {
          if (this.open?.path === path) {
            this.open.busy = false;
            this.open.error = message(f);
          } else {
            this.error = message(f);
          }
          this.paint();
        },
      },
    );
  }

  /** Upload a picked file as `path`, then delete `replaces` (the previous
   *  logo.svg when a logo.png arrives). */
  private uploadFile(file: File, path: string, replaces: readonly string[]): void {
    const id = this.themeId();
    if (id === 0n || path === '') return;
    this.busy = true;
    this.error = '';
    this.paint();
    const reader = new FileReader();
    reader.onload = (): void => {
      if (!this.isAlive()) return;
      const bytes = new Uint8Array(reader.result as ArrayBuffer);
      this.ctx.api.callByName(
        THEME_SPEC.filePut,
        { themeId: id, path, contentBase64: bytesToBase64(bytes) },
        () => {
          if (!this.isAlive()) return;
          this.busy = false;
          if (replaces.length > 0) this.deleteFiles(replaces);
          else this.reloadList();
        },
        {
          alive: () => this.isAlive(),
          onErr: (f) => {
            this.busy = false;
            this.setError(message(f));
          },
        },
      );
    };
    reader.onerror = (): void => {
      this.busy = false;
      this.setError(`Couldn't read ${file.name}.`);
    };
    reader.readAsArrayBuffer(file);
  }

  private deleteFiles(paths: readonly string[]): void {
    const id = this.themeId();
    if (id === 0n || paths.length === 0) return;
    this.busy = true;
    this.error = '';
    this.paint();
    let left = paths.length;
    for (const path of paths) {
      this.ctx.api.callByName(
        THEME_SPEC.fileDelete,
        { themeId: id, path },
        () => {
          if (!this.isAlive()) return;
          if (this.open?.path === path) this.open = null;
          if (--left === 0) {
            this.busy = false;
            this.reloadList();
          }
        },
        {
          alive: () => this.isAlive(),
          onErr: (f) => {
            this.busy = false;
            this.setError(message(f));
          },
        },
      );
    }
  }

  /** Re-issue theme.list into the master's items (server truth). */
  private reloadList(): void {
    this.ctx.api.callByName(
      THEME_SPEC.list,
      {},
      (out) => {
        if (!this.isAlive()) return;
        const rows = ((out ?? {}) as { rows?: ThemeRow[] }).rows ?? [];
        const items: MasterDetailItem[] = rows.map((r) => ({ id: r.id.toString(), raw: r as unknown as Record<string, unknown> }));
        this.ctx.tree.at(this.itemsPath).set(items);
      },
      { alive: () => this.isAlive() },
    );
  }
}

/** A fault as a sentence, without the server's "theme.file_put: " prefix. */
function message(f: ApiFault): string {
  return faultText(f).replace(/^theme\.[a-z_]+: /, '');
}

export function registerThemeFiles(): void {
  Control.register('ThemeFiles', ThemeFiles);
}
