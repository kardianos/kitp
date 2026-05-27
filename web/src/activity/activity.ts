/**
 * Activity — the standalone `/activity` screen (#1). A reverse-chronological
 * feed of every activity row in the ACTIVE PROJECT (the project or any
 * descendant card), reusing the same row phrasing + data-driven card_ref label
 * resolution as the task-detail feed.
 *
 * Scope: project-only. The `project_id` filter is applied server-side
 * (activity_select_batch), AND-joined with the existing per-row visibility
 * clause, so a caller only ever sees activity they're entitled to. The control
 * reads `scope.projectId` (always set — there is always an active project) and
 * reloads when it changes.
 *
 * Zero-promise: every load is `api.callByName(spec, input, onOk, { alive })`.
 * Rows link to their card's `/task/:id` detail.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { navigate, taskUrl } from '../shell/router.js';
import { ADMIN_SPEC, type UserListOutput, type AttributeDefListOutput } from '../admin/specs.js';
import { schemaForCardType, type AttrSchema } from '../filter/attribute-schema.js';
import {
  ACTIVITY_SELECT_SPEC,
  ACTIVITY_LIMIT,
  type ActivityRow,
  type ActivitySelectOutput,
} from '../task-detail/comment-specs.js';
import {
  formatActivityText,
  formatRelativeTime,
  sortActivityDesc,
  type IdMap,
} from '../task-detail/activity-text.js';
import { attrNameToTargetType, loadActivityLabels } from '../task-detail/activity-labels.js';

export interface ActivityConfig extends BaseControlConfig {
  type: 'Activity';
  /** Dotted tree path holding the active project id. Default 'scope.projectId'. */
  projectScopePath?: string;
  /** card_type whose attribute schema resolves card_ref labels. Default 'task'. */
  cardTypeName?: string;
  /** Optional row cap. Default ACTIVITY_LIMIT. */
  limit?: number;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    Activity: ActivityConfig;
  }
}

export class Activity extends Control<ActivityConfig> {
  private readonly scopePath: string[];
  private readonly cardTypeName: string;
  private readonly limit: number;

  private rows: ActivityRow[] = [];
  private userNames: IdMap = {};
  private cardTitles: IdMap = {};
  private tagPaths: IdMap = {};
  private nameToType: Map<string, string> = new Map();
  private loading = false;
  /** The project id the current `rows` were loaded for (guards redundant loads). */
  private loadedFor: bigint | null = null;

  private listEl!: HTMLElement;

  constructor(...args: ConstructorParameters<typeof Control<ActivityConfig>>) {
    super(...args);
    this.scopePath = (this.config.projectScopePath ?? 'scope.projectId').split('.');
    this.cardTypeName = this.config.cardTypeName ?? 'task';
    this.limit = typeof this.config.limit === 'number' && this.config.limit > 0 ? this.config.limit : ACTIVITY_LIMIT;
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('section');
    el.className = 'activity-screen';
    el.dataset.control = 'Activity';
    return el;
  }

  protected render(): void {
    const head = document.createElement('header');
    head.className = 'activity-screen__head';
    const title = document.createElement('h1');
    title.className = 'activity-screen__title';
    title.textContent = 'Activity';
    head.append(title);

    const list = document.createElement('div');
    list.className = 'activity-screen__list';
    list.dataset.activityBody = '';
    this.listEl = list;

    this.el.append(head, list);

    this.loadUsers();
    this.loadSchema();
    // Reactive on the project scope: (re)load when the active project resolves
    // or changes. A one-way read → load (no signal write), cascade-safe.
    this.effect(() => {
      const pid = this.ctx.tree.at([...this.scopePath]).get<bigint | null>() ?? null;
      this.loadActivity(pid);
    }, 'activity.scope');
  }

  private loadActivity(pid: bigint | null): void {
    if (pid === null) {
      this.rows = [];
      this.loadedFor = null;
      this.paint();
      return;
    }
    if (pid === this.loadedFor && !this.loading) {
      // Already loaded for this project; nothing to do.
      return;
    }
    this.loadedFor = pid;
    this.loading = true;
    this.paint();
    this.ctx.api.callByName(
      ACTIVITY_SELECT_SPEC,
      { projectId: pid, limit: this.limit },
      (out) => {
        if (!this.isAlive()) return;
        this.loading = false;
        this.rows = sortActivityDesc((out as ActivitySelectOutput).rows ?? []);
        this.paint();
        this.resolveLabels();
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          if (!this.isAlive()) return;
          this.loading = false;
          this.paint();
        },
      },
    );
  }

  private loadUsers(): void {
    this.ctx.api.callByName(
      ADMIN_SPEC.userSelect,
      {},
      (out) => {
        if (!this.isAlive()) return;
        const map: IdMap = {};
        for (const u of (out as UserListOutput).rows ?? []) map[String(u.id)] = u.display_name;
        this.userNames = map;
        this.paint();
      },
      { alive: () => this.isAlive() },
    );
  }

  private loadSchema(): void {
    this.ctx.api.callByName(
      ADMIN_SPEC.attributeDefSelect,
      {},
      (out) => {
        if (!this.isAlive()) return;
        const defs = (out as AttributeDefListOutput).rows ?? [];
        const full: AttrSchema[] = schemaForCardType(defs, this.cardTypeName);
        this.nameToType = attrNameToTargetType(full);
        this.resolveLabels();
      },
      { alive: () => this.isAlive() },
    );
  }

  private resolveLabels(): void {
    if (this.nameToType.size === 0 || this.rows.length === 0) return;
    loadActivityLabels(
      this.ctx.api,
      this.rows,
      this.nameToType,
      (maps) => {
        if (!this.isAlive()) return;
        this.cardTitles = maps.cardTitles;
        this.tagPaths = maps.tagPaths;
        this.paint();
      },
      { alive: () => this.isAlive() },
    );
  }

  private paint(): void {
    const list = this.listEl;
    list.replaceChildren();
    if (this.loading && this.rows.length === 0) {
      const m = document.createElement('p');
      m.className = 'activity-screen__empty muted';
      m.textContent = 'Loading activity…';
      list.append(m);
      return;
    }
    if (this.rows.length === 0) {
      const m = document.createElement('p');
      m.className = 'activity-screen__empty muted';
      m.textContent = 'No activity in this project yet.';
      list.append(m);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const row of this.rows) frag.append(this.renderRow(row));
    list.append(frag);
  }

  private renderRow(row: ActivityRow): HTMLElement {
    // A row is a button so the whole line navigates to the card's detail.
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'activity-screen__row';
    el.dataset.activityRow = row.id.toString();
    el.dataset.activityKind = row.kind;
    el.dataset.activityCard = row.cardId.toString();

    const text = document.createElement('span');
    text.className = 'activity-screen__text';
    text.dataset.activityText = '';
    text.textContent = formatActivityText(row, this.userNames, this.cardTitles, this.tagPaths);

    const time = document.createElement('span');
    time.className = 'activity-screen__time muted';
    time.textContent = formatRelativeTime(row.createdAt);

    el.append(text, time);
    this.listen(el, 'click', () => navigate(taskUrl(row.cardId)));
    return el;
  }
}

export function registerActivity(): void {
  Control.register('Activity', Activity);
}
