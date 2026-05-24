/**
 * Shared, lazy-loaded cache of project cards.
 *
 * Both the title-bar `<ProjectTitlePicker>` and the AppShell breadcrumb
 * resolver need the project list (one to render the dropdown, the
 * other to turn `/project/7` into "Default Project" instead of
 * "Project #7"). Without a shared cache each call site would issue its
 * own card.select_with_attributes; this module collapses them into
 * one fetch per session and keeps the rune-backed reactive list in
 * sync via `projectScope.projectsVersion`.
 */

import type { Dispatcher } from '../dispatch/dispatcher';
import { cardSelectWithAttributes } from '../reg/handlers';
import type {
  CardSelectWithAttributesInput,
  CardSelectWithAttributesOutput,
  CardWithAttrs,
  ID,
} from '../reg/types';
import { TEMPLATE_EXCLUSION_LEAF } from '../screens/projects_helpers';
import { projectScope } from './project_scope.svelte';

class ProjectsStore {
  projects = $state<CardWithAttrs[]>([]);
  loaded = $state(false);
  /** True while a fetch is in flight; consumers can hide skeletons / placeholders. */
  loading = $state(false);
  private inFlight: Promise<void> | null = null;
  private lastVersion = -1;

  /**
   * Fetch the project list. Idempotent — concurrent callers share the
   * pending promise. A bump to `projectScope.projectsVersion` between
   * calls triggers a re-fetch.
   */
  async load(dispatcher: Pick<Dispatcher, 'request'>): Promise<void> {
    const wantVersion = projectScope.projectsVersion;
    if (this.lastVersion === wantVersion && this.loaded) return;
    if (this.inFlight !== null) return this.inFlight;
    this.loading = true;
    this.inFlight = (async () => {
      try {
        // User-facing project caches (ProjectTitlePicker, NavSidebar
        // breadcrumb) ship the same `is_template != true` exclusion as
        // ProjectsScreen — Gate 12 of FLOW_AND_SCREEN_KERNEL. The
        // exclusion drops when `projectScope.showTemplates` is true so
        // admins can pick a template from the title-bar picker; the
        // toggle is gated to /admin/* routes by the picker UI. See
        // `screens/projects_helpers.ts` for the canonical predicate.
        const data: CardSelectWithAttributesInput = {
          cardTypeName: 'project',
          limit: 200,
        };
        if (!projectScope.showTemplates) {
          data.where = [TEMPLATE_EXCLUSION_LEAF];
        }
        const out = await dispatcher.request<
          CardSelectWithAttributesInput,
          CardSelectWithAttributesOutput
        >({
          endpoint: cardSelectWithAttributes.endpoint,
          action: cardSelectWithAttributes.action,
          data,
        });
        this.projects = out.rows;
        // NOTE: we deliberately do NOT touch `projectScope` here. The old
        // code called `projectScope.setProject(null)` to evict a persisted
        // scope that no longer resolved — but that turned a *data load* into
        // a write of `projectScope.projectId`, which the AppShell chord
        // effect tracked, relaying a load into an unrelated effect's dep set
        // (the FE-C2 cascade). Stale-scope eviction is now a derived signal
        // (`scopeResolves`) the title-picker resets explicitly. See
        // `frontend-design-review.md` "one-way data flow for loads".
        this.lastVersion = wantVersion;
        this.loaded = true;
      } catch {
        this.projects = [];
        this.loaded = true;
      } finally {
        this.loading = false;
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /** O(n) lookup of a project's title by id. Returns null when unknown. */
  titleFor(id: ID): string | null {
    for (const p of this.projects) {
      if (p.id === id) {
        const t = p.attributes['title'];
        return typeof t === 'string' && t.length > 0 ? t : null;
      }
    }
    return null;
  }

  /**
   * True when the given scope id is present in the loaded project list.
   * `null` (All projects) always resolves. While the list is still
   * loading we report `true` (don't evict a scope we can't yet confirm
   * is stale — that would clear a valid deep-link scope on cold start).
   *
   * This replaces the old in-`load` `setProject(null)` side effect: the
   * title picker reads this as a derived signal and resets a stale scope
   * itself, keeping `load` a pure one-way data flow. Reads `projects` /
   * `loaded` so callers take a reactive dependency.
   */
  scopeResolves(id: ID | null): boolean {
    if (id === null) return true;
    if (!this.loaded) return true;
    return this.projects.some((p) => p.id === id);
  }
}

export const projectsStore = new ProjectsStore();

/**
 * Convenience for components that just want "load on mount, re-load
 * when an input changes". Wrap the call in an effect.
 *
 * FE-M2: track the *actual* inputs `load()` reads — `projectsVersion`
 * AND `showTemplates` — rather than relying on the convention that
 * every `showTemplates` flip also bumps the version. With the inputs
 * tracked directly there's no `untrack` to maintain and no loop: `load`
 * reads only `projectsVersion` / `showTemplates` / `loaded` before its
 * first await, and the `loaded`/`projects` it later writes are not part
 * of the trigger set in a way that re-fires the load (it early-returns
 * once `lastVersion` matches). The old `setProject(null)` side effect —
 * the one that relayed a load into the chord effect — is gone (see
 * `load`), so the dependency is now honest end-to-end.
 */
export function watchProjects(
  dispatcher: Pick<Dispatcher, 'request'>,
): () => void {
  return () => {
    void projectScope.projectsVersion;
    void projectScope.showTemplates;
    void projectsStore.load(dispatcher);
  };
}
