/**
 * Personal screen specs (docs/PERSONAL_SCREENS.md):
 *
 *   my_screen.list {}  → { screens: [{ id, title, layout, listCardType,
 *                          predicate, sortOrder, defaultFilter, viewCount }] }
 *   my_screen.set {id?, title?, layout?, listCardType?, predicate?,
 *                  sortOrder?, defaultFilter?} → { id }
 *   my_screen.delete {id} → { id }
 *
 * Generic codec (camelCase ↔ snake_case); ids are strings. The helpers turn
 * a screen's project scope — every project, only these, all but these — to
 * and from its base filter (a `project` leaf).
 */

import type { Api } from '../core/api.js';
import { decodeWire, encodeWire } from '../core/codec.js';

export const MY_SCREEN_SPEC = {
  list: 'my_screen.list',
  set: 'my_screen.set',
  delete: 'my_screen.delete',
} as const;

export interface MyScreen {
  id: string;
  title: string;
  /** 'list' or 'grid'. */
  layout: string;
  /** 'task' or 'comm' (threads). */
  listCardType: string;
  /** The base filter JSON ('' = everything you can see). */
  predicate: string;
  sortOrder: number;
  /** Its default view ('0' = none). */
  defaultFilter: string;
  viewCount: number;
}

export interface MyScreenSetInput {
  id?: string;
  title?: string;
  layout?: string;
  listCardType?: string;
  predicate?: string;
  sortOrder?: number;
  defaultFilter?: string;
}

/** Where a personal screen opens. */
export function myScreenUrl(id: string): string {
  return `/my/${id}`;
}

/** The page that manages them. */
export const MY_SCREENS_PATH = '/my-screens';

/** Which projects a personal screen covers. */
export interface ProjectScope {
  mode: 'all' | 'only' | 'except';
  projects: string[];
}

/** A base filter's project scope: a lone `project` leaf (in → only, not in
 *  → except), else every project. */
export function scopeFromPredicate(predicate: string): ProjectScope {
  if (predicate.trim() === '') return { mode: 'all', projects: [] };
  try {
    let node = JSON.parse(predicate) as { attr?: string; op?: string; values?: unknown[]; connective?: string; children?: unknown[] };
    if (node.connective === 'and' && Array.isArray(node.children) && node.children.length === 1) {
      node = node.children[0] as typeof node;
    }
    if (node.attr === 'project' && Array.isArray(node.values)) {
      const projects = node.values.map((v) => String(v));
      if (projects.length === 0) return { mode: 'all', projects: [] };
      return { mode: node.op === 'not in' ? 'except' : 'only', projects };
    }
  } catch {
    /* unreadable: treat as every project */
  }
  return { mode: 'all', projects: [] };
}

/** The base filter for a project scope ('' = every project). */
export function predicateFromScope(scope: ProjectScope): string {
  if (scope.mode === 'all' || scope.projects.length === 0) return '';
  return JSON.stringify({ attr: 'project', op: scope.mode === 'except' ? 'not in' : 'in', values: scope.projects });
}

/** "All projects", "Launch, Ops", "All but Ops" — for lists of screens. */
export function scopeSummary(scope: ProjectScope, names: ReadonlyMap<string, string>): string {
  if (scope.mode === 'all') return 'All projects';
  const list = scope.projects.map((id) => names.get(id) ?? `#${id}`).join(', ');
  return scope.mode === 'except' ? `All but ${list}` : list;
}

function idStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return v.toString();
  return '';
}

function normIds<T>(v: T): T {
  if (Array.isArray(v)) return v.map(normIds) as unknown as T;
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      o[k] = k === 'id' || k.endsWith('Id') || k === 'defaultFilter' ? idStr(x) : normIds(x);
    }
    return o as T;
  }
  return v;
}

export function registerMyScreenSpecs(api: Api): void {
  const define = <I, O>(endpoint: string, action: string): void => {
    if (api.registry.has({ endpoint, action })) return;
    api.define<I, O>({
      endpoint,
      action,
      encode: (i) => encodeWire(i),
      decode: (raw) => normIds(decodeWire(raw)) as O,
    });
  };
  define<Record<string, never>, { screens: MyScreen[] }>('my_screen', 'list');
  define<MyScreenSetInput, { id: string }>('my_screen', 'set');
  define<{ id: string }, { id: string }>('my_screen', 'delete');
}
