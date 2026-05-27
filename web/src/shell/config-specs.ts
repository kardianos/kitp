/**
 * config.get API spec + boot loader — server-driven configuration the client
 * needs up front.
 *
 *   config.get  in: {}  out: { config: { workspace_title, attachment_max_bytes,
 *                                        chunk_max_bytes } }
 *
 * Today the web client reads the WORKSPACE TITLE (the operator-set name shown
 * in the header brand + the browser tab title); the attachment caps are decoded
 * too so a future uploader can read them from the same call. `loadServerConfig`
 * is a boot service (callback form, like loadAuthUser) that lands the title at
 * `config.workspaceTitle` and sets document.title — NO promise crosses a control
 * boundary.
 */

import type { Api } from '../core/api.js';
import type { TreeNode } from '../core/tree.js';

export const CONFIG_GET_SPEC = 'config.get';

/** Where the resolved workspace title lives in the data tree (AppShell reads it). */
export const WORKSPACE_TITLE_PATH = ['config', 'workspaceTitle'] as const;

/** The neutral fallback shown when no workspace title is configured. Never 'kitp'. */
export const DEFAULT_WORKSPACE_TITLE = 'Workspace';

export interface ServerConfig {
  workspaceTitle: string;
  attachmentMaxBytes: number;
  chunkMaxBytes: number;
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function asNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function decodeConfig(raw: unknown): ServerConfig {
  const c = asObj(asObj(raw)['config']);
  return {
    workspaceTitle: asStr(c['workspace_title']),
    attachmentMaxBytes: asNum(c['attachment_max_bytes']),
    chunkMaxBytes: asNum(c['chunk_max_bytes']),
  };
}

/** Register the config.get spec. Idempotent-by-presence. */
export function registerConfigSpecs(api: Api): void {
  if (!api.registry.has({ endpoint: 'config', action: 'get' })) {
    api.define<Record<string, never>, ServerConfig>({
      endpoint: 'config',
      action: 'get',
      encode: () => ({}),
      decode: decodeConfig,
    });
  }
}

/**
 * Boot service: fetch config.get, land the workspace title at
 * `config.workspaceTitle`, and set the browser tab title. Falls back to the
 * neutral {@link DEFAULT_WORKSPACE_TITLE} when the server returns an empty
 * value, so neither the header nor the tab ever shows the old 'kitp' brand. A
 * fault funnels through the centralized registry (the header simply keeps the
 * default); this never throws.
 */
export function loadServerConfig(api: Api, tree: TreeNode): void {
  api.callByName(
    CONFIG_GET_SPEC,
    {},
    (out) => {
      const cfg = out as ServerConfig;
      const title = cfg.workspaceTitle.trim() !== '' ? cfg.workspaceTitle.trim() : DEFAULT_WORKSPACE_TITLE;
      tree.at([...WORKSPACE_TITLE_PATH]).set(title);
      if (typeof document !== 'undefined') document.title = title;
    },
    { alive: () => true },
  );
}
