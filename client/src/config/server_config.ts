/**
 * Cached fetch for server-driven config (config.get on the dispatcher).
 *
 * The values rarely change at runtime, so we issue exactly one request
 * per page-load and hand every caller the same promise. Components that
 * need a value awaitload before rendering an action button etc. await
 * `serverConfig()`; passive components that have a sensible default while
 * the request is in flight can pass that default and re-render once the
 * promise resolves.
 */

import type { Dispatcher } from '../dispatch/dispatcher';
import { configGet } from '../reg/handlers';
import type {
  ConfigGetInput,
  ConfigGetOutput,
  ServerConfig,
} from '../reg/types';

let pending: Promise<ServerConfig> | null = null;

/**
 * Returns the live server config, fetching it once per session. Subsequent
 * calls share the cached promise — the request is never made twice.
 */
export function serverConfig(dispatcher: Dispatcher): Promise<ServerConfig> {
  if (pending !== null) return pending;
  pending = dispatcher
    .request<ConfigGetInput, ConfigGetOutput>({
      endpoint: configGet.endpoint,
      action: configGet.action,
      data: {},
    })
    .then((r) => r.config)
    .catch((err) => {
      // Don't poison the cache on a transient error — clear it so a
      // future caller can retry.
      pending = null;
      throw err;
    });
  return pending;
}

/** Test-only: drop the cached promise so a fresh fetch happens on next call. */
export function _resetServerConfigCacheForTests(): void {
  pending = null;
}
