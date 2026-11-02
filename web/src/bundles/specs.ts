/**
 * Feature bundles + portals — the API specs behind the new-project presets,
 * the project properties FEATURES section, the Portals admin screen and the
 * page detail's PUBLISHED ON section.
 *
 * Wire shapes (snake_case; ids ship as JSON strings and revive to bigint):
 *
 *   - bundle.list       in : { project_id? }
 *       out: { features: [{ key, title, doc, sort, enabled, conflict }],
 *              presets:  [{ key, title, doc, sort, features: [key…] }] }
 *   - bundle.apply      in : { project_id, keys: [key…] }
 *       out: { results: [{ key, status, copied, existing, message }] }
 *   - project.compose   in : { name, description?, preset?, features? }
 *       out: { new_project_id, features: [key…] }
 *   - portal.set        in : { id?, title?, host?, root_page_id?, public?,
 *                              theme_id?, internal? }
 *       out: { id, created, changed }
 *   - portal.list       in : {}
 *       out: { rows: [{ id, title, host, public, internal, theme_id,
 *                       theme_title, root_page_id, root_title, root_label,
 *                       root_project_id, statuses, page_count, built_at,
 *                       active_build_id, warnings, dirty, last_error }] }
 *   - portal.rebuild    in : { id }  out: { queued }
 *   - portal.root_pages in : {}
 *       out: { rows: [{ id, label, project_id }] }   label 'Project › Home'
 *   - page.publications in : { page_id }
 *       out: { rows: [{ portal_id, portal_title, host, public, published_at,
 *                       published_by, current, path }] }
 *
 *   - theme.bases       in : {}
 *       out: { rows: [{ key, name, description, nav, paginate, order,
 *                       files: [{ path, mime_type, size_bytes, is_text }] }] }
 *   - theme.base_file   in : { key, path }   out: ThemeFileContent
 *   - theme.list        in : {}
 *       out: { rows: [{ id, title, base, nav, accent, footer,
 *                       files: [{ path, mime_type, size_bytes, updated_at }],
 *                       portals: [title…] }] }
 *   - theme.set         in : { id?, title?, base?, nav?, accent?, footer? }
 *       out: { id, created, changed }
 *   - theme.file_get    in : { theme_id, path }   out: ThemeFileContent
 *   - theme.file_put    in : { theme_id, path, text? | content_base64? }
 *       out: { theme_id, path, size_bytes, changed }
 *   - theme.file_delete in : { theme_id, path }   out: { deleted }
 *     ThemeFileContent = { path, mime_type, size_bytes, is_text, text?,
 *                          content_base64? }
 *
 * The signed-in preview of a portal is a plain GET on the app:
 * `/api/v1/portal/<id>/preview/<page path>` (see previewUrl); a portal shown
 * in kitp is framed from `/api/v1/portal/<id>/site/<page path>` (siteUrl).
 */

import type { Api } from '../core/api.js';

export const BUNDLE_SPEC = {
  list: 'bundle.list',
  apply: 'bundle.apply',
  compose: 'project.compose',
} as const;

export const PORTAL_SPEC = {
  set: 'portal.set',
  list: 'portal.list',
  rebuild: 'portal.rebuild',
  rootPages: 'portal.root_pages',
  publications: 'page.publications',
} as const;

/** Move a card under another parent (a page under another page or the
 *  project): { card_id, new_parent_card_id } → { ok, activity_id }. */
export const CARD_MOVE_SPEC = 'card.move';

export const THEME_SPEC = {
  bases: 'theme.bases',
  baseFile: 'theme.base_file',
  list: 'theme.list',
  set: 'theme.set',
  fileGet: 'theme.file_get',
  filePut: 'theme.file_put',
  fileDelete: 'theme.file_delete',
} as const;

/* ------------------------------- web model -------------------------------- */

export interface BundleFeature {
  key: string;
  title: string;
  doc: string;
  sort: number;
  /** The project has this feature (some of its cards came from it). */
  enabled: boolean;
  /** Why the project can't take it; '' when it can. */
  conflict: string;
}

export interface BundlePreset {
  key: string;
  title: string;
  doc: string;
  sort: number;
  features: string[];
}

export interface BundleListInput {
  projectId?: bigint;
}
export interface BundleListOutput {
  features: BundleFeature[];
  presets: BundlePreset[];
}

export interface BundleApplyInput {
  projectId: bigint;
  keys: string[];
}
export interface BundleApplyResult {
  key: string;
  status: string;
  copied: number;
  existing: number;
  message: string;
}
export interface BundleApplyOutput {
  results: BundleApplyResult[];
}

export interface ProjectComposeInput {
  name: string;
  description?: string;
  preset?: string;
  features?: string[];
}
export interface ProjectComposeOutput {
  newProjectId: bigint;
  features: string[];
}

export interface PortalRow {
  id: bigint;
  title: string;
  host: string;
  public: boolean;
  /** Show in kitp: listed in the sidebar, shown in the content area. */
  internal: boolean;
  /** The theme card; 0n = the built-in Side menu theme. */
  themeId: bigint;
  themeTitle: string;
  rootPageId: bigint;
  rootTitle: string;
  /** The root page with its project, 'Project › Home'; '' when unset. */
  rootLabel: string;
  rootProjectId: bigint;
  /** Statuses that publish to the portal, as 'Project › Status'. */
  statuses: string[];
  pageCount: number;
  builtAt: string;
  activeBuildId: bigint;
  warnings: string[];
  /** A rebuild is pending. */
  dirty: boolean;
  lastError: string;
}

export interface PortalListOutput {
  rows: PortalRow[];
}

/** A page a portal may use as its root (pages of live, non-template
 *  projects only — never a feature bundle's hidden starter pages). */
export interface PortalRootPage {
  id: bigint;
  /** 'Project › Home › Guide'. */
  label: string;
  projectId: bigint;
}

export interface PortalRootPagesOutput {
  rows: PortalRootPage[];
}

export interface PortalSetInput {
  id?: bigint;
  title?: string;
  host?: string;
  rootPageId?: bigint;
  public?: boolean;
  /** 0n = the built-in Side menu theme. */
  themeId?: bigint;
  internal?: boolean;
}
export interface PortalSetOutput {
  id: bigint;
  created: boolean;
  changed: boolean;
}

export interface PortalRebuildInput {
  id: bigint;
}
export interface PortalRebuildOutput {
  queued: boolean;
}

export interface PagePublication {
  portalId: bigint;
  portalTitle: string;
  host: string;
  public: boolean;
  publishedAt: string;
  publishedBy: string;
  /** The snapshot matches the page as it is now. */
  current: boolean;
  /** File path in the portal's active build ('guide/index.html'); '' until built. */
  path: string;
}
export interface PagePublicationsInput {
  pageId: bigint;
}
export interface PagePublicationsOutput {
  rows: PagePublication[];
}

/** A file of a built-in theme (read-only). */
export interface ThemeBaseFile {
  path: string;
  mimeType: string;
  sizeBytes: number;
  isText: boolean;
}
/** A built-in theme a theme card starts from. */
export interface ThemeBase {
  key: string;
  name: string;
  description: string;
  nav: string;
  paginate: number;
  order: string;
  files: ThemeBaseFile[];
}
export interface ThemeBasesOutput {
  rows: ThemeBase[];
}
/** A file a theme card adds to or overrides in its base. */
export interface ThemeOwnFile {
  path: string;
  mimeType: string;
  sizeBytes: number;
  updatedAt: string;
}
export interface ThemeRow {
  id: bigint;
  title: string;
  base: string;
  /** The base theme's display name ('Newspaper'). */
  baseName: string;
  /** 'Newspaper · used by Docs, Docs QA' — the Themes list's subtitle. */
  summary: string;
  nav: string;
  accent: string;
  footer: string;
  files: ThemeOwnFile[];
  /** Titles of the portals using the theme. */
  portals: string[];
}
export interface ThemeListOutput {
  rows: ThemeRow[];
}
export interface ThemeSetInput {
  id?: bigint;
  title?: string;
  base?: string;
  nav?: string;
  accent?: string;
  footer?: string;
}
/** A theme file's content: `text` for a text file, else `contentBase64`. */
export interface ThemeFileContent {
  path: string;
  mimeType: string;
  sizeBytes: number;
  isText: boolean;
  text: string;
  contentBase64: string;
}
export interface ThemeBaseFileInput {
  key: string;
  path: string;
}
export interface ThemeFileRef {
  themeId: bigint;
  path: string;
}
export interface ThemeFilePutInput {
  themeId: bigint;
  path: string;
  text?: string;
  contentBase64?: string;
}
export interface ThemeFilePutOutput {
  themeId: bigint;
  path: string;
  sizeBytes: number;
  changed: boolean;
}

/* -------------------------------- helpers --------------------------------- */

/**
 * The signed-in preview URL of a portal page. `path` is the build's file path
 * ('guide/index.html' → 'guide/', 'index.html' → '').
 */
export function previewUrl(portalId: bigint, path = ''): string {
  const page = path.replace(/(^|\/)index\.html$/, '$1');
  return `/api/v1/portal/${portalId.toString()}/preview/${page}`;
}

/** The in-kitp ("Show in kitp") URL of a portal page, framed by the site
 *  view. `path` is a page path below the site root ('guide/'). */
export function siteUrl(portalId: bigint, path = ''): string {
  return `/api/v1/portal/${portalId.toString()}/site/${path}`;
}

/* ------------------------------ decode helpers ---------------------------- */

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
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
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return 0;
}
function asStrings(v: unknown): string[] {
  return asArray(v).map(asStr);
}

export function decodeFeature(j: Record<string, unknown>): BundleFeature {
  return {
    key: asStr(j['key']),
    title: asStr(j['title']),
    doc: asStr(j['doc']),
    sort: asNum(j['sort']),
    enabled: j['enabled'] === true,
    conflict: asStr(j['conflict']),
  };
}

export function decodePreset(j: Record<string, unknown>): BundlePreset {
  return {
    key: asStr(j['key']),
    title: asStr(j['title']),
    doc: asStr(j['doc']),
    sort: asNum(j['sort']),
    features: asStrings(j['features']),
  };
}

export function decodePortalRow(j: Record<string, unknown>): PortalRow {
  return {
    id: asId(j['id']),
    title: asStr(j['title']),
    host: asStr(j['host']),
    public: j['public'] === true,
    internal: j['internal'] === true,
    themeId: asId(j['theme_id']),
    themeTitle: asStr(j['theme_title']),
    rootPageId: asId(j['root_page_id']),
    rootTitle: asStr(j['root_title']),
    rootLabel: asStr(j['root_label']),
    rootProjectId: asId(j['root_project_id']),
    statuses: asStrings(j['statuses']),
    pageCount: asNum(j['page_count']),
    builtAt: asStr(j['built_at']),
    activeBuildId: asId(j['active_build_id']),
    warnings: asStrings(j['warnings']),
    dirty: j['dirty'] === true,
    lastError: asStr(j['last_error']),
  };
}

export function decodeThemeBase(j: Record<string, unknown>): ThemeBase {
  return {
    key: asStr(j['key']),
    name: asStr(j['name']),
    description: asStr(j['description']),
    nav: asStr(j['nav']),
    paginate: asNum(j['paginate']),
    order: asStr(j['order']),
    files: asArray(j['files']).map((r) => {
      const f = asObj(r);
      return { path: asStr(f['path']), mimeType: asStr(f['mime_type']), sizeBytes: asNum(f['size_bytes']), isText: f['is_text'] === true };
    }),
  };
}

export function decodeThemeRow(j: Record<string, unknown>): ThemeRow {
  const baseName = asStr(j['base_name']) || asStr(j['base']);
  const portals = asStrings(j['portals']);
  return {
    id: asId(j['id']),
    title: asStr(j['title']),
    base: asStr(j['base']),
    baseName,
    summary: portals.length > 0 ? `${baseName} · used by ${portals.join(', ')}` : `${baseName} · not used yet`,
    nav: asStr(j['nav']),
    accent: asStr(j['accent']),
    footer: asStr(j['footer']),
    files: asArray(j['files']).map((r) => {
      const f = asObj(r);
      return { path: asStr(f['path']), mimeType: asStr(f['mime_type']), sizeBytes: asNum(f['size_bytes']), updatedAt: asStr(f['updated_at']) };
    }),
    portals,
  };
}

export function decodeThemeFileContent(j: Record<string, unknown>): ThemeFileContent {
  return {
    path: asStr(j['path']),
    mimeType: asStr(j['mime_type']),
    sizeBytes: asNum(j['size_bytes']),
    isText: j['is_text'] === true,
    text: asStr(j['text']),
    contentBase64: asStr(j['content_base64']),
  };
}

export function decodePublication(j: Record<string, unknown>): PagePublication {
  return {
    portalId: asId(j['portal_id']),
    portalTitle: asStr(j['portal_title']),
    host: asStr(j['host']),
    public: j['public'] === true,
    publishedAt: asStr(j['published_at']),
    publishedBy: asStr(j['published_by']),
    current: j['current'] === true,
    path: asStr(j['path']),
  };
}

/* ------------------------------- registration ----------------------------- */

/**
 * Register the bundle + portal specs. Call once at boot, BEFORE any control
 * that uses them mounts. Idempotent-by-presence (each define is guarded, since
 * `api.define` throws on a duplicate key).
 */
export function registerBundleSpecs(api: Api): void {
  const define = <I, O>(endpoint: string, action: string, encode: (i: I) => unknown, decode: (raw: unknown) => O): void => {
    if (api.registry.has({ endpoint, action })) return;
    api.define<I, O>({ endpoint, action, encode, decode });
  };

  define<BundleListInput, BundleListOutput>(
    'bundle',
    'list',
    (i) => (i.projectId !== undefined && i.projectId > 0n ? { project_id: i.projectId } : {}),
    (raw) => {
      const o = asObj(raw);
      return {
        features: asArray(o['features']).map((r) => decodeFeature(asObj(r))),
        presets: asArray(o['presets']).map((r) => decodePreset(asObj(r))),
      };
    },
  );
  define<BundleApplyInput, BundleApplyOutput>(
    'bundle',
    'apply',
    (i) => ({ project_id: i.projectId, keys: i.keys }),
    (raw) => ({
      results: asArray(asObj(raw)['results']).map((r) => {
        const j = asObj(r);
        return {
          key: asStr(j['key']),
          status: asStr(j['status']),
          copied: asNum(j['copied']),
          existing: asNum(j['existing']),
          message: asStr(j['message']),
        };
      }),
    }),
  );
  define<ProjectComposeInput, ProjectComposeOutput>(
    'project',
    'compose',
    (i) => {
      const m: Record<string, unknown> = { name: i.name };
      if (i.description !== undefined && i.description !== '') m['description'] = i.description;
      if (i.preset !== undefined && i.preset !== '') m['preset'] = i.preset;
      if (i.features !== undefined && i.features.length > 0) m['features'] = i.features;
      return m;
    },
    (raw) => {
      const o = asObj(raw);
      return { newProjectId: asId(o['new_project_id']), features: asStrings(o['features']) };
    },
  );
  define<PortalSetInput, PortalSetOutput>(
    'portal',
    'set',
    (i) => {
      const m: Record<string, unknown> = {};
      if (i.id !== undefined && i.id > 0n) m['id'] = i.id;
      if (i.title !== undefined) m['title'] = i.title;
      if (i.host !== undefined) m['host'] = i.host;
      if (i.rootPageId !== undefined) m['root_page_id'] = i.rootPageId;
      if (i.public !== undefined) m['public'] = i.public;
      if (i.themeId !== undefined) m['theme_id'] = i.themeId;
      if (i.internal !== undefined) m['internal'] = i.internal;
      return m;
    },
    (raw) => {
      const o = asObj(raw);
      return { id: asId(o['id']), created: o['created'] === true, changed: o['changed'] === true };
    },
  );
  define<Record<string, never>, PortalListOutput>(
    'portal',
    'list',
    () => ({}),
    (raw) => ({ rows: asArray(asObj(raw)['rows']).map((r) => decodePortalRow(asObj(r))) }),
  );
  define<PortalRebuildInput, PortalRebuildOutput>(
    'portal',
    'rebuild',
    (i) => ({ id: i.id }),
    (raw) => ({ queued: asObj(raw)['queued'] === true }),
  );
  define<Record<string, never>, PortalRootPagesOutput>(
    'portal',
    'root_pages',
    () => ({}),
    (raw) => ({
      rows: asArray(asObj(raw)['rows']).map((r) => {
        const j = asObj(r);
        return { id: asId(j['id']), label: asStr(j['label']), projectId: asId(j['project_id']) };
      }),
    }),
  );
  define<PagePublicationsInput, PagePublicationsOutput>(
    'page',
    'publications',
    (i) => ({ page_id: i.pageId }),
    (raw) => ({ rows: asArray(asObj(raw)['rows']).map((r) => decodePublication(asObj(r))) }),
  );

  define<{ cardId: bigint; newParentCardId: bigint }, { ok: boolean }>(
    'card',
    'move',
    (i) => ({ card_id: i.cardId, new_parent_card_id: i.newParentCardId }),
    (raw) => ({ ok: asObj(raw)['ok'] === true }),
  );

  const fileContent = (raw: unknown): ThemeFileContent => decodeThemeFileContent(asObj(raw));
  define<Record<string, never>, ThemeBasesOutput>(
    'theme',
    'bases',
    () => ({}),
    (raw) => ({ rows: asArray(asObj(raw)['rows']).map((r) => decodeThemeBase(asObj(r))) }),
  );
  define<ThemeBaseFileInput, ThemeFileContent>('theme', 'base_file', (i) => ({ key: i.key, path: i.path }), fileContent);
  define<Record<string, never>, ThemeListOutput>(
    'theme',
    'list',
    () => ({}),
    (raw) => ({ rows: asArray(asObj(raw)['rows']).map((r) => decodeThemeRow(asObj(r))) }),
  );
  define<ThemeSetInput, PortalSetOutput>(
    'theme',
    'set',
    (i) => {
      const m: Record<string, unknown> = {};
      if (i.id !== undefined && i.id > 0n) m['id'] = i.id;
      for (const k of ['title', 'base', 'nav', 'accent', 'footer'] as const) {
        if (i[k] !== undefined) m[k] = i[k];
      }
      return m;
    },
    (raw) => {
      const o = asObj(raw);
      return { id: asId(o['id']), created: o['created'] === true, changed: o['changed'] === true };
    },
  );
  define<ThemeFileRef, ThemeFileContent>('theme', 'file_get', (i) => ({ theme_id: i.themeId, path: i.path }), fileContent);
  define<ThemeFilePutInput, ThemeFilePutOutput>(
    'theme',
    'file_put',
    (i) => {
      const m: Record<string, unknown> = { theme_id: i.themeId, path: i.path };
      if (i.text !== undefined) m['text'] = i.text;
      if (i.contentBase64 !== undefined) m['content_base64'] = i.contentBase64;
      return m;
    },
    (raw) => {
      const o = asObj(raw);
      return { themeId: asId(o['theme_id']), path: asStr(o['path']), sizeBytes: asNum(o['size_bytes']), changed: o['changed'] === true };
    },
  );
  define<ThemeFileRef, { deleted: boolean }>(
    'theme',
    'file_delete',
    (i) => ({ theme_id: i.themeId, path: i.path }),
    (raw) => ({ deleted: asObj(raw)['deleted'] === true }),
  );
}
