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
        const out = await dispatcher.request<
          CardSelectWithAttributesInput,
          CardSelectWithAttributesOutput
        >({
          endpoint: cardSelectWithAttributes.endpoint,
          action: cardSelectWithAttributes.action,
          data: { cardTypeName: 'project', limit: 200 },
        });
        this.projects = out.rows;
        // Drop a persisted scope that no longer resolves — same stale-id
        // guard the standalone fetch in ProjectTitlePicker used to do.
        const pid = projectScope.projectId;
        if (pid !== null && !out.rows.some((p) => p.id === pid)) {
          projectScope.setProject(null);
        }
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
}

export const projectsStore = new ProjectsStore();

/**
 * Convenience for components that just want "load on mount, re-load
 * when the version bumps". Wrap the call in an effect; this keeps the
 * untrack incantation in one place.
 */
export function watchProjects(
  dispatcher: Pick<Dispatcher, 'request'>,
): () => void {
  // The effect tracks projectsVersion so a notifyProjectsChanged()
  // bump from anywhere (rename, create, delete) triggers a re-fetch.
  return () => {
    void projectScope.projectsVersion;
    untrack(() => {
      void projectsStore.load(dispatcher);
    });
  };
}
