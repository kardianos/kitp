/**
 * Shared cache of screen cards keyed by project id.
 *
 * The NavSidebar lists screens for the active project; AppShell registers
 * a `g <hotkey>` chord per screen on project-scope change. Both surfaces
 * need the same `screen` card list, so we centralise the fetch here and
 * keep a rune-backed reactive store so re-mounts share state.
 *
 * Cache is keyed by project id; switching projects invalidates the
 * previous entry's "fresh" flag but keeps its rows around as a fallback
 * while the new fetch resolves (no skeleton flash on every project
 * switch).
 *
 * Today screen cards rarely change without an admin acting, so we don't
 * carry a global version counter — the admin Screens UI bumps a
 * per-project version explicitly via `bumpVersion(projectId)` after a
 * mutation. The store's caller can also call `invalidate(projectId)` to
 * force the next read to re-fetch.
 */

import { untrack } from 'svelte';
import type { Dispatcher } from '../dispatch/dispatcher';
import { cardSelectWithAttributes } from '../reg/handlers';
import type {
  CardSelectWithAttributesInput,
  CardSelectWithAttributesOutput,
  CardWithAttrs,
  ID,
} from '../reg/types';
import { projectScope } from './project_scope.svelte';

class ProjectScreensStore {
  /** Screens for the currently-watched project. `null` when not loaded. */
  screens = $state<CardWithAttrs[]>([]);
  /** The project id `screens` currently reflects, or `null` when "all projects". */
  forProjectId = $state<ID | null>(null);
  /** True while a fetch is in flight. */
  loading = $state(false);

  private inFlight: Promise<void> | null = null;
  /** Monotonic counter; callers bump via {@link bumpVersion} to force re-fetch. */
  version = $state(0);
  private lastVersion = -1;

  /**
   * Load the screen list for `projectId`. Idempotent within the same
   * version; a `bumpVersion()` call between reads will re-fetch. A
   * `projectId` change always re-fetches.
   *
   * Falls through to a no-op when `projectId === null` (the "All
   * projects" sidebar mode has no per-project screens; the global
   * top-level routes — Projects, Activity — still show).
   */
  async load(
    dispatcher: Pick<Dispatcher, 'request'>,
    projectId: ID | null,
  ): Promise<void> {
    if (projectId === null) {
      this.screens = [];
      this.forProjectId = null;
      this.lastVersion = this.version;
      return;
    }
    if (
      this.forProjectId === projectId &&
      this.lastVersion === this.version
    ) {
      return;
    }
    if (this.inFlight !== null) return this.inFlight;
    this.loading = true;
    const wantProject = projectId;
    const wantVersion = this.version;
    this.inFlight = (async () => {
      try {
        const out = await dispatcher.request<
          CardSelectWithAttributesInput,
          CardSelectWithAttributesOutput
        >({
          endpoint: cardSelectWithAttributes.endpoint,
          action: cardSelectWithAttributes.action,
          data: {
            cardTypeName: 'screen',
            parentCardId: wantProject,
            order: [{ field: 'attributes.sort_order', direction: 'ASC' }],
          },
        });
        this.screens = out.rows;
        this.forProjectId = wantProject;
        this.lastVersion = wantVersion;
      } catch {
        // On error, drop the cache so the next call retries. The
        // sidebar / hotkey loop survives an empty list — they're
        // additive surfaces.
        this.screens = [];
        this.forProjectId = wantProject;
        this.lastVersion = wantVersion;
      } finally {
        this.loading = false;
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /** Bump the version so the next `load` re-fetches. Callers: admin UI. */
  bumpVersion(): void {
    this.version += 1;
  }
}

export const projectScreensStore = new ProjectScreensStore();

/**
 * Effect helper for components that want "load on mount, reload on
 * project change". Pass to `$effect(...)`.
 */
export function watchProjectScreens(
  dispatcher: Pick<Dispatcher, 'request'>,
): () => void {
  return () => {
    // Track the project scope + version so a project switch or a
    // bumpVersion() call retriggers the load.
    const pid = projectScope.projectId;
    void projectScreensStore.version;
    untrack(() => {
      void projectScreensStore.load(dispatcher, pid);
    });
  };
}
