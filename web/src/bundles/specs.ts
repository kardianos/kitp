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
 *   - portal.set        in : { id?, title?, host?, root_page_id?, public? }
 *       out: { id, created, changed }
 *   - portal.list       in : {}
 *       out: { rows: [{ id, title, host, public, root_page_id, root_title,
 *                       root_project_id, statuses, page_count, built_at,
 *                       active_build_id, warnings, dirty, last_error }] }
 *   - portal.rebuild    in : { id }  out: { queued }
 *   - page.publications in : { page_id }
 *       out: { rows: [{ portal_id, portal_title, host, public, published_at,
 *                       published_by, current, path }] }
 *
 * The signed-in preview of a portal is a plain GET on the app:
 * `/api/v1/portal/<id>/preview/<page path>` (see previewUrl).
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
  publications: 'page.publications',
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
  rootPageId: bigint;
  rootTitle: string;
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

export interface PortalSetInput {
  id?: bigint;
  title?: string;
  host?: string;
  rootPageId?: bigint;
  public?: boolean;
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

/* -------------------------------- helpers --------------------------------- */

/**
 * The signed-in preview URL of a portal page. `path` is the build's file path
 * ('guide/index.html' → 'guide/', 'index.html' → '').
 */
export function previewUrl(portalId: bigint, path = ''): string {
  const page = path.replace(/(^|\/)index\.html$/, '$1');
  return `/api/v1/portal/${portalId.toString()}/preview/${page}`;
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
    rootPageId: asId(j['root_page_id']),
    rootTitle: asStr(j['root_title']),
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
  define<PagePublicationsInput, PagePublicationsOutput>(
    'page',
    'publications',
    (i) => ({ page_id: i.pageId }),
    (raw) => ({ rows: asArray(asObj(raw)['rows']).map((r) => decodePublication(asObj(r))) }),
  );
}
