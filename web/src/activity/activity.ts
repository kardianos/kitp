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
import { attrNameToTargetType, loadActivityLabels, type ActivityLabelMaps } from '../task-detail/activity-labels.js';

/** Default look-back window for the feed: the last 7 days. */
export const ACTIVITY_DEFAULT_LOOKBACK_DAYS = 7;
/** Row cap for the Export CSV fetch (the server caps activity.select at 999). */
const ACTIVITY_EXPORT_LIMIT = 999;

/** ISO `YYYY-MM-DD` for a Date in local time. */
function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** ISO date `n` days before `now` (local). Exported for the screen's default. */
export function isoDaysAgo(n: number, now: Date = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  return isoDate(d);
}

/** CSV-escape one cell (quote when it contains a comma, quote, or newline). */
function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Build a CSV (header + one row per activity) from already-loaded rows + the
 * resolved label maps. Columns mirror what the feed shows: when it happened,
 * the kind, the card id it's on, who did it, the changed attribute, and the
 * human-readable detail (with card_ref values resolved to titles). Pure +
 * exported so it's unit-testable without a DOM / download.
 */
export function activityRowsToCsv(
  rows: readonly ActivityRow[],
  userNames: IdMap,
  maps: ActivityLabelMaps,
): string {
  const header = ['timestamp', 'kind', 'card_id', 'actor', 'attribute', 'detail'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const actor = userNames[String(r.actorId)] ?? `#${r.actorId.toString()}`;
    const detail = formatActivityText(r, userNames, maps.cardTitles, maps.tagPaths);
    lines.push(
      [r.createdAt, r.kind, r.cardId.toString(), actor, r.attributeName ?? '', detail]
        .map((c) => csvCell(String(c)))
        .join(','),
    );
  }
  return lines.join('\n');
}

/**
 * Save `text` as a download named `filename`. Feature-detected: a no-op
 * (returns false) where Blob / URL.createObjectURL are unavailable (the test
 * dom-shim) so the export path is safe to call there; production browsers save
 * the file. Side-effect-only — no promise crosses a control boundary.
 */
function downloadTextFile(filename: string, text: string, doc: Document = document): boolean {
  const g = globalThis as unknown as {
    Blob?: typeof Blob;
    URL?: { createObjectURL?: (b: Blob) => string; revokeObjectURL?: (u: string) => void };
  };
  if (typeof g.Blob !== 'function' || typeof g.URL?.createObjectURL !== 'function') return false;
  const blob = new g.Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = g.URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  doc.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a tick to grab the bytes before revoking.
  setTimeout(() => g.URL?.revokeObjectURL?.(url), 0);
  return true;
}

/** One cluster of adjacent activity rows that share an owning card ("thing"). */
export interface ActivityGroup {
  /** The card the cluster links to (server-resolved nav card / owning task). */
  navId: bigint;
  /** Headline title of navId (server-provided; '' when unknown). */
  title: string;
  /** Member rows, newest-first (same order as the feed). */
  rows: ActivityRow[];
}

/** Max gap between adjacent rows kept in one group (12h) — events on the same
 *  card further apart than this stay separate, so a group reads as "one go". */
const GROUP_GAP_MS = 12 * 60 * 60 * 1000;

/** Group adjacent rows (already newest-first) that share an owning card and sit
 *  within GROUP_GAP_MS of each other. Pure — exported for unit tests. */
export function groupActivity(rows: readonly ActivityRow[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  let tailTime = 0;
  for (const row of rows) {
    const navId = row.navCardId ?? row.cardId;
    const t = Date.parse(row.createdAt);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.navId === navId && Math.abs(tailTime - t) <= GROUP_GAP_MS) {
      last.rows.push(row);
    } else {
      groups.push({ navId, title: row.navTitle ?? '', rows: [row] });
    }
    if (!Number.isNaN(t)) tailTime = t;
  }
  return groups;
}

const KIND_CATEGORY: Record<string, string> = {
  comment: 'comment',
  attr_update: 'update',
  card_create: 'created',
  tag_apply: 'tag',
  tag_remove: 'tag',
};
function kindCategory(kind: string): string {
  return KIND_CATEGORY[kind] ?? 'other';
}
function kindLabel(cat: string, n: number): string {
  switch (cat) {
    case 'comment':
      return n === 1 ? 'comment' : 'comments';
    case 'update':
      return n === 1 ? 'update' : 'updates';
    case 'tag':
      return n === 1 ? 'tag change' : 'tag changes';
    case 'created':
      return 'created';
    default:
      return n === 1 ? 'event' : 'events';
  }
}
const CATEGORY_ORDER = ['created', 'comment', 'update', 'tag', 'other'];

/** A group's sub-line: the full action text for a lone row, else a compact
 *  count by category ("3 updates · 1 comment"). Exported for unit tests. */
export function summarizeGroup(
  rows: readonly ActivityRow[],
  userNames: IdMap,
  cardTitles: IdMap,
  tagPaths: IdMap,
): string {
  if (rows.length === 1) return formatActivityText(rows[0], userNames, cardTitles, tagPaths);
  const counts = new Map<string, number>();
  for (const r of rows) {
    const c = kindCategory(r.kind);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const cat of CATEGORY_ORDER) {
    const n = counts.get(cat);
    if (n !== undefined && n > 0) parts.push(`${n} ${kindLabel(cat, n)}`);
  }
  return parts.join(' · ');
}

export interface ActivityConfig extends BaseControlConfig {
  type: 'Activity';
  /** Dotted tree path holding the active project id. Default 'scope.projectId'. */
  projectScopePath?: string;
  /** card_type whose attribute schema resolves card_ref labels. Default 'task'. */
  cardTypeName?: string;
  /** Optional row cap. Default ACTIVITY_LIMIT. */
  limit?: number;
  /** Initial look-back window in days (default 7). 0 / negative → no lower bound. */
  lookbackDays?: number;
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
  /** Active date window (ISO `YYYY-MM-DD`); '' means unbounded on that side. */
  private fromDate: string;
  private toDate = '';
  /** Key (`pid|from|to`) the current `rows` were loaded for — guards redundant loads. */
  private loadedKey: string | null = null;

  private listEl!: HTMLElement;

  constructor(...args: ConstructorParameters<typeof Control<ActivityConfig>>) {
    super(...args);
    this.scopePath = (this.config.projectScopePath ?? 'scope.projectId').split('.');
    this.cardTypeName = this.config.cardTypeName ?? 'task';
    this.limit = typeof this.config.limit === 'number' && this.config.limit > 0 ? this.config.limit : ACTIVITY_LIMIT;
    const look = typeof this.config.lookbackDays === 'number' ? this.config.lookbackDays : ACTIVITY_DEFAULT_LOOKBACK_DAYS;
    this.fromDate = look > 0 ? isoDaysAgo(look) : '';
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

    // Filter bar: a [From, To] date range (defaulting to the last 7 days) and
    // an Export CSV button. Native date inputs keep this light (no calendar
    // popover) and reload the feed on change.
    const bar = document.createElement('div');
    bar.className = 'activity-screen__filter';
    bar.dataset.activityFilter = '';
    bar.append(
      this.dateField('From', 'from', this.fromDate, (v) => {
        this.fromDate = v;
        this.reload();
      }),
      this.dateField('To', 'to', this.toDate, (v) => {
        this.toDate = v;
        this.reload();
      }),
    );
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'btn activity-screen__export';
    exportBtn.dataset.activityExport = '';
    exportBtn.textContent = 'Export CSV';
    this.listen(exportBtn, 'click', () => this.exportCsv());
    bar.append(exportBtn);
    head.append(bar);

    const list = document.createElement('div');
    list.className = 'activity-screen__list';
    list.dataset.activityBody = '';
    this.listEl = list;

    this.el.append(head, list);

    this.loadUsers();
    this.loadSchema();
    // Reactive on the project scope: (re)load when the active project resolves
    // or changes. A one-way read → load (no signal write), cascade-safe. Date
    // changes call reload() directly (the window is part of the load key).
    this.effect(() => {
      this.ctx.tree.at([...this.scopePath]).get<bigint | null>(); // subscribe
      this.reload();
    }, 'activity.scope');
  }

  /** A labelled native date input for the filter bar. */
  private dateField(label: string, role: string, value: string, onChange: (v: string) => void): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'activity-screen__date';
    const span = document.createElement('span');
    span.className = 'activity-screen__date-label muted';
    span.textContent = label;
    const input = document.createElement('input');
    input.type = 'date';
    input.className = 'activity-screen__date-input';
    input.dataset.activityDate = role;
    input.value = value;
    input.setAttribute('aria-label', `${label} date`);
    this.listen(input, 'change', () => onChange(input.value));
    wrap.append(span, input);
    return wrap;
  }

  /** Read the active project + reload the feed for the current date window. */
  private reload(): void {
    const pid = this.ctx.tree.at([...this.scopePath]).peek<bigint | null>() ?? null;
    this.loadActivity(pid);
  }

  private loadActivity(pid: bigint | null): void {
    if (pid === null) {
      this.rows = [];
      this.loadedKey = null;
      this.paint();
      return;
    }
    const key = `${pid.toString()}|${this.fromDate}|${this.toDate}`;
    if (key === this.loadedKey && !this.loading) {
      // Already loaded for this project + window; nothing to do.
      return;
    }
    this.loadedKey = key;
    this.loading = true;
    this.paint();
    this.ctx.api.callByName(
      ACTIVITY_SELECT_SPEC,
      this.queryInput(pid, this.limit),
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

  /** The activity.select input for the active project + current date window. */
  private queryInput(pid: bigint, limit: number): Record<string, unknown> {
    const input: Record<string, unknown> = { projectId: pid, limit };
    if (this.fromDate !== '') input['fromDate'] = this.fromDate;
    if (this.toDate !== '') input['toDate'] = this.toDate;
    return input;
  }

  /**
   * Export the current project's activity for the active date window as a CSV
   * download. Fetches a high-limit page (independent of the on-screen cap) so
   * the export isn't truncated to the visible rows, resolves card_ref labels
   * for that set, then builds + saves the file.
   */
  private exportCsv(): void {
    const pid = this.ctx.tree.at([...this.scopePath]).peek<bigint | null>() ?? null;
    if (pid === null) return;
    this.ctx.api.callByName(
      ACTIVITY_SELECT_SPEC,
      this.queryInput(pid, ACTIVITY_EXPORT_LIMIT),
      (out) => {
        if (!this.isAlive()) return;
        const rows = sortActivityDesc((out as ActivitySelectOutput).rows ?? []);
        // Resolve labels for THIS set (may exceed the displayed rows), then save.
        loadActivityLabels(
          this.ctx.api,
          rows,
          this.nameToType,
          (maps) => {
            if (!this.isAlive()) return;
            const csv = activityRowsToCsv(rows, this.userNames, maps);
            downloadTextFile(`activity-${pid.toString()}.csv`, csv);
          },
          { alive: () => this.isAlive() },
        );
      },
      { alive: () => this.isAlive() },
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
    for (const g of groupActivity(this.rows)) frag.append(this.renderGroup(g));
    list.append(frag);
  }

  /**
   * Render one grouped "thing": a clickable card headed by the owning card's
   * title, with a one-line summary (the full action for a lone row, else a
   * count by category). The whole card navigates to the owning card.
   */
  private renderGroup(g: ActivityGroup): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'activity-screen__group';
    el.dataset.activityGroup = g.navId.toString();
    el.dataset.activityCount = String(g.rows.length);

    const head = document.createElement('div');
    head.className = 'activity-screen__group-head';
    const title = document.createElement('span');
    title.className = 'activity-screen__group-title';
    title.dataset.activityTitle = '';
    title.textContent =
      g.title !== '' ? g.title : (this.cardTitles[g.navId.toString()] ?? `#${g.navId.toString()}`);
    const time = document.createElement('span');
    time.className = 'activity-screen__group-time muted';
    time.textContent = formatRelativeTime(g.rows[0].createdAt);
    head.append(title, time);

    const summary = document.createElement('span');
    summary.className = 'activity-screen__group-summary muted';
    summary.dataset.activitySummary = '';
    summary.textContent = summarizeGroup(g.rows, this.userNames, this.cardTitles, this.tagPaths);

    el.append(head, summary);
    // Open the OWNING card (server-resolved nav card / task) — comm & reply
    // activity lives on cards with no task route, so never link the raw card.
    this.listen(el, 'click', () => navigate(taskUrl(g.navId)));
    return el;
  }
}

export function registerActivity(): void {
  Control.register('Activity', Activity);
}
