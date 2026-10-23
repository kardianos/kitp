/**
 * Activity — the standalone `/activity` screen (#1). The active project's
 * activity (the project or any descendant card), newest first, as a feed of
 * days → groups of consecutive changes to one card → rolled-up change lines
 * (see activity-model.ts).
 *
 * The rows arrive from activity.select already joined up — who did it (an
 * agent named with its owner), the card's type + title, the owning task, and
 * titles for every card a value names — so the feed renders names, never ids,
 * without further lookups.
 *
 * Filters (all server-side, so the row cap never hides a match): a date window
 * (presets + From / To), People, Changes (kind groups), Items (card types) and a
 * text search. The window's facets (counts per person / kind / card type) feed
 * the dropdowns; they're reloaded when the project or the window changes, not
 * when a filter does. "Load older" pages back with the id cursor; Export CSV
 * downloads the filtered window.
 *
 * Scope: project-only. The `project_id` filter is applied server-side,
 * AND-joined with the per-row visibility clause, so a caller only ever sees
 * activity they're entitled to. Reloads when `scope.projectId` changes.
 *
 * Zero-promise: every load is `api.callByName(spec, input, onOk, { alive })`.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import { navigate, plainClick, taskUrl } from '../shell/router.js';
import {
  ACTIVITY_SELECT_SPEC,
  type ActivityFacets,
  type ActivityRow,
  type ActivitySelectInput,
  type ActivitySelectOutput,
} from '../task-detail/comment-specs.js';
import { formatActivityText, resolveActor, sortActivityDesc, type IdMap } from '../task-detail/activity-text.js';
import type { ActivityLabelMaps } from '../task-detail/activity-labels.js';
import { formatLocalDateTime } from '../util/datetime.js';
import { fitBelowAnchor } from '../ui/popover.js';
import { MenuFilter } from '../ui/menu-filter.js';
import {
  KIND_GROUPS,
  buildFeed,
  cardTypeLabel,
  kindsForGroups,
  type FeedGroup,
  type FeedLine,
} from './activity-model.js';

/** Default look-back window for the feed: the last 7 days. */
export const ACTIVITY_DEFAULT_LOOKBACK_DAYS = 7;
/** Row cap for the Export CSV fetch (the server caps activity.select at 999). */
const ACTIVITY_EXPORT_LIMIT = 999;
/** Rows per page on screen. */
const ACTIVITY_PAGE = 200;
/** Search-box debounce. */
const SEARCH_DEBOUNCE_MS = 250;

/** The date-window presets: days back from today ('' = no lower bound). */
const RANGE_PRESETS: ReadonlyArray<{ value: string; label: string; days: number | null }> = [
  { value: '1', label: 'Today', days: 0 },
  { value: '7', label: 'Last 7 days', days: 7 },
  { value: '30', label: 'Last 30 days', days: 30 },
  { value: '90', label: 'Last 90 days', days: 90 },
  { value: 'all', label: 'All time', days: null },
  { value: 'custom', label: 'Custom', days: null },
];

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
 * Build a CSV (header + one row per activity). Columns: when it happened, the
 * kind, the card it's on (id, type, title), the card it belongs to (id, title),
 * who did it, the changed attribute, and the human-readable detail. Names and
 * titles come from the rows (server-joined); the maps are a fallback for rows
 * without them. Pure + exported so it's unit-testable without a DOM / download.
 */
export function activityRowsToCsv(
  rows: readonly ActivityRow[],
  userNames: IdMap = {},
  maps: ActivityLabelMaps = { cardTitles: {}, tagPaths: {} },
): string {
  const header = ['timestamp', 'kind', 'card_id', 'card_type', 'card_title', 'item_id', 'item_title', 'actor', 'attribute', 'detail'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const nav = r.navCardId ?? r.cardId;
    lines.push(
      [
        r.createdAt,
        r.kind,
        r.cardId.toString(),
        r.cardType ?? '',
        r.cardTitle ?? '',
        nav.toString(),
        r.navTitle ?? '',
        resolveActor(r, userNames),
        r.attributeName ?? '',
        formatActivityText(r, userNames, maps.cardTitles, maps.tagPaths),
      ]
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

/** Up to two initials for an avatar ("claude (for Daniel)" → "C"). */
export function initials(name: string): string {
  const words = name.replace(/\s*\(for .*\)$/, '').split(/\s+/).filter((w) => w !== '');
  return words
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');
}

/** A stable hue (0–359) for a name, so a person keeps their avatar colour. */
function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

/** `HH:MM` (local) of an ISO timestamp. */
function clockTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** One checkable option of a filter dropdown. */
interface MenuOption {
  value: string;
  label: string;
  count: number;
}

/** A filter dropdown: its root, and how to repaint it. */
interface FilterMenu {
  el: HTMLElement;
  paint(options: readonly MenuOption[]): void;
}

export interface ActivityConfig extends BaseControlConfig {
  type: 'Activity';
  /** Dotted tree path holding the active project id. Default 'scope.projectId'. */
  projectScopePath?: string;
  /** Rows per page. Default 200. */
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
  private readonly limit: number;
  private readonly defaultRange: string;

  private rows: ActivityRow[] = [];
  private facets: ActivityFacets | null = null;
  /** `pid|from|to` the facets were loaded for. */
  private facetsKey = '';
  private loading = false;
  private hasMore = false;
  /** Bumped per load so a stale response is dropped. */
  private loadSeq = 0;

  /** Date window (ISO `YYYY-MM-DD`; '' = unbounded on that side) + its preset. */
  private range: string;
  private fromDate: string;
  private toDate = '';
  private readonly actorIds = new Set<string>();
  private readonly kindGroups = new Set<string>();
  private readonly cardTypes = new Set<string>();
  private query = '';
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Each filter dropdown's option search, keyed by its wrapper. */
  private readonly menuFilters = new Map<HTMLElement, MenuFilter>();

  private statsEl!: HTMLElement;
  private rangeEl!: HTMLSelectElement;
  private fromEl!: HTMLInputElement;
  private toEl!: HTMLInputElement;
  private searchEl!: HTMLInputElement;
  private clearEl!: HTMLButtonElement;
  private peopleMenu!: FilterMenu;
  private kindMenu!: FilterMenu;
  private typeMenu!: FilterMenu;
  private listEl!: HTMLElement;

  constructor(...args: ConstructorParameters<typeof Control<ActivityConfig>>) {
    super(...args);
    this.scopePath = (this.config.projectScopePath ?? 'scope.projectId').split('.');
    const limit = this.config.limit;
    this.limit = typeof limit === 'number' && limit > 0 ? limit : ACTIVITY_PAGE;
    const look = typeof this.config.lookbackDays === 'number' ? this.config.lookbackDays : ACTIVITY_DEFAULT_LOOKBACK_DAYS;
    this.fromDate = look > 0 ? isoDaysAgo(look) : '';
    const preset = RANGE_PRESETS.find((p) => p.days === look && p.value !== 'custom');
    this.range = look > 0 ? (preset?.value ?? 'custom') : 'all';
    this.defaultRange = this.range;
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
    const heading = document.createElement('div');
    heading.className = 'activity-screen__heading';
    const title = document.createElement('h1');
    title.className = 'activity-screen__title';
    title.textContent = 'Activity';
    const stats = document.createElement('span');
    stats.className = 'activity-screen__stats muted';
    stats.dataset.activityStats = '';
    this.statsEl = stats;
    heading.append(title, stats);
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'btn activity-screen__export';
    exportBtn.dataset.activityExport = '';
    exportBtn.textContent = 'Export CSV';
    this.listen(exportBtn, 'click', () => this.exportCsv());
    head.append(heading, exportBtn);

    const list = document.createElement('div');
    list.className = 'activity-screen__list';
    list.dataset.activityBody = '';
    this.listEl = list;

    this.el.append(head, this.renderFilters(), list);

    // Close an open dropdown on an outside pointerdown.
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      this.listen(document, 'pointerdown', (e) => {
        for (const m of this.el.querySelectorAll('[data-activity-menu]')) {
          const panel = m.querySelector('.activity-menu__panel') as HTMLElement | null;
          if (panel !== null && panel.style.display !== 'none' && !m.contains(e.target as Node)) {
            this.setMenuOpen(m as HTMLElement, false);
          }
        }
      });
    }
    this.onDestroy(() => {
      if (this.searchTimer !== null) clearTimeout(this.searchTimer);
    });

    // Reactive on the project scope: (re)load when the active project resolves
    // or changes. A one-way read → load (no signal write), cascade-safe.
    // Filter changes call reload() directly.
    this.effect(() => {
      this.ctx.tree.at([...this.scopePath]).get<bigint | null>(); // subscribe
      this.reload();
    }, 'activity.scope');
  }

  /* --------------------------------------------------------------- filters */

  private renderFilters(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'activity-screen__filter';
    bar.dataset.activityFilter = '';

    const range = document.createElement('select');
    range.className = 'activity-screen__range';
    range.dataset.activityRange = '';
    range.setAttribute('aria-label', 'Date range');
    for (const p of RANGE_PRESETS) {
      const o = document.createElement('option');
      o.value = p.value;
      o.textContent = p.label;
      range.append(o);
    }
    range.value = this.range;
    this.rangeEl = range;
    this.listen(range, 'change', () => this.applyRange(range.value));

    const from = this.dateInput('From', 'from', this.fromDate, (v) => {
      this.fromDate = v;
      this.setRange('custom');
      this.reload();
    });
    const to = this.dateInput('To', 'to', this.toDate, (v) => {
      this.toDate = v;
      this.setRange('custom');
      this.reload();
    });
    this.fromEl = from;
    this.toEl = to;
    const dates = document.createElement('span');
    dates.className = 'activity-screen__dates';
    const dash = document.createElement('span');
    dash.className = 'muted';
    dash.textContent = '–';
    dates.append(from, dash, to);

    this.peopleMenu = this.filterMenu('people', 'People', this.actorIds);
    this.kindMenu = this.filterMenu('kinds', 'Changes', this.kindGroups);
    this.typeMenu = this.filterMenu('types', 'Items', this.cardTypes);

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'activity-screen__search';
    search.dataset.activitySearch = '';
    search.placeholder = 'Search titles, #id, comments…';
    search.setAttribute('aria-label', 'Search activity');
    this.searchEl = search;
    this.listen(search, 'input', () => {
      if (this.searchTimer !== null) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.searchTimer = null;
        this.query = search.value.trim();
        this.reload();
      }, SEARCH_DEBOUNCE_MS);
    });

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'btn activity-screen__clear';
    clear.dataset.activityClear = '';
    clear.textContent = 'Clear';
    this.clearEl = clear;
    this.listen(clear, 'click', () => this.clearFilters());

    bar.append(range, dates, this.peopleMenu.el, this.kindMenu.el, this.typeMenu.el, search, clear);
    this.paintClear();
    return bar;
  }

  private dateInput(label: string, role: string, value: string, onChange: (v: string) => void): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'date';
    input.className = 'activity-screen__date-input';
    input.dataset.activityDate = role;
    input.value = value;
    input.setAttribute('aria-label', `${label} date`);
    this.listen(input, 'change', () => onChange(input.value));
    return input;
  }

  private setRange(value: string): void {
    this.range = value;
    this.rangeEl.value = value;
  }

  /** Apply a range preset: fill From / To and reload ('custom' keeps them). */
  private applyRange(value: string, reload = true): void {
    this.setRange(value);
    const preset = RANGE_PRESETS.find((p) => p.value === value);
    if (preset !== undefined && value !== 'custom') {
      this.fromDate = preset.days === null ? '' : isoDaysAgo(preset.days);
      this.toDate = '';
      this.fromEl.value = this.fromDate;
      this.toEl.value = this.toDate;
      if (reload) this.reload();
    }
  }

  /**
   * A dropdown of checkboxes over [selected]. Ticking one updates the set and
   * reloads. The trigger reads the label, plus the pick when there's one
   * ("People: Daniel") or the count ("People · 2").
   */
  private filterMenu(key: string, label: string, selected: Set<string>): FilterMenu {
    const wrap = document.createElement('div');
    wrap.className = 'activity-menu';
    wrap.dataset.activityMenu = key;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'btn activity-menu__trigger';
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.textContent = label;
    const panel = document.createElement('div');
    panel.className = 'activity-menu__panel';
    panel.style.display = 'none';
    wrap.append(trigger, panel);
    // A long list (people over a busy range) gets a search field; it heads the
    // panel and the rows repaint beneath it.
    const filter = new MenuFilter(panel, { placeholder: `Filter ${label.toLowerCase()}…` });
    this.menuFilters.set(wrap, filter);
    this.onDestroy(() => filter.destroy());
    this.listen(trigger, 'click', () => this.setMenuOpen(wrap, panel.style.display === 'none'));

    let labels = new Map<string, string>();
    const paintTrigger = (): void => {
      trigger.classList.toggle('activity-menu__trigger--active', selected.size > 0);
      if (selected.size === 0) trigger.textContent = label;
      else if (selected.size === 1) {
        const v = [...selected][0] ?? '';
        trigger.textContent = `${label}: ${labels.get(v) ?? v}`;
      } else trigger.textContent = `${label} · ${selected.size}`;
    };
    const paint = (options: readonly MenuOption[]): void => {
      labels = new Map(options.map((o) => [o.value, o.label]));
      panel.replaceChildren(filter.el);
      if (options.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'activity-menu__empty muted';
        empty.textContent = 'Nothing in this range';
        panel.append(empty);
      }
      for (const o of options) {
        const row = document.createElement('label');
        row.className = 'activity-menu__option';
        row.dataset.menuItem = o.label;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.activityOption = o.value;
        cb.checked = selected.has(o.value);
        this.listen(cb, 'change', () => {
          if (cb.checked) selected.add(o.value);
          else selected.delete(o.value);
          paintTrigger();
          this.paintClear();
          this.reload();
        });
        const text = document.createElement('span');
        text.className = 'activity-menu__label';
        text.textContent = o.label;
        const count = document.createElement('span');
        count.className = 'activity-menu__count muted';
        count.textContent = String(o.count);
        row.append(cb, text, count);
        panel.append(row);
      }
      filter.apply();
      paintTrigger();
    };
    paint([]);
    return { el: wrap, paint };
  }

  private setMenuOpen(wrap: HTMLElement, open: boolean): void {
    const panel = wrap.querySelector('.activity-menu__panel') as HTMLElement | null;
    const trigger = wrap.querySelector('.activity-menu__trigger');
    if (panel === null) return;
    if (open) {
      // One open at a time.
      for (const m of this.el.querySelectorAll('[data-activity-menu]')) {
        if (m !== wrap) this.setMenuOpen(m as HTMLElement, false);
      }
    }
    const filter = this.menuFilters.get(wrap);
    if (open) {
      filter?.reset();
      filter?.apply();
      if (trigger !== null) fitBelowAnchor(panel, trigger as HTMLElement);
    }
    panel.style.display = open ? '' : 'none';
    trigger?.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) filter?.focus();
  }

  /** Repaint the dropdowns from the facets (plus any picked value they lack). */
  private paintMenus(): void {
    const f = this.facets;
    const keep = (opts: MenuOption[], selected: Set<string>, labelOf: (v: string) => string): MenuOption[] => {
      for (const v of selected) {
        if (!opts.some((o) => o.value === v)) opts.push({ value: v, label: labelOf(v), count: 0 });
      }
      return opts;
    };
    this.peopleMenu.paint(
      keep(
        (f?.actors ?? []).map((a) => ({ value: a.id.toString(), label: a.name, count: a.count })),
        this.actorIds,
        (v) => `user#${v}`,
      ),
    );
    const kindCounts = new Map((f?.kinds ?? []).map((k) => [k.kind, k.count]));
    this.kindMenu.paint(
      KIND_GROUPS.map((g) => ({
        value: g.key,
        label: g.label,
        count: g.kinds.reduce((n, k) => n + (kindCounts.get(k) ?? 0), 0),
      })).filter((o) => o.count > 0 || this.kindGroups.has(o.value)),
    );
    this.typeMenu.paint(
      keep(
        (f?.cardTypes ?? []).map((c) => ({ value: c.cardType, label: cardTypeLabel(c.cardType), count: c.count })),
        this.cardTypes,
        cardTypeLabel,
      ),
    );
  }

  private filtered(): boolean {
    return this.actorIds.size > 0 || this.kindGroups.size > 0 || this.cardTypes.size > 0 || this.query !== '';
  }

  private paintClear(): void {
    if (this.clearEl === undefined) return;
    this.clearEl.disabled = !this.filtered() && this.range === this.defaultRange;
  }

  /** Reset every filter and the window to the default. */
  private clearFilters(): void {
    this.actorIds.clear();
    this.kindGroups.clear();
    this.cardTypes.clear();
    this.query = '';
    this.searchEl.value = '';
    this.applyRange(this.defaultRange, false);
    this.paintMenus();
    this.reload();
  }

  /* ------------------------------------------------------------------ data */

  /** The activity.select input for the active project, window and filters. */
  private queryInput(pid: bigint, limit: number): ActivitySelectInput {
    const input: ActivitySelectInput = { projectId: pid, limit };
    if (this.fromDate !== '') input.fromDate = this.fromDate;
    if (this.toDate !== '') input.toDate = this.toDate;
    if (this.actorIds.size > 0) input.actorIds = [...this.actorIds].map((id) => BigInt(id));
    if (this.kindGroups.size > 0) input.kinds = kindsForGroups(this.kindGroups);
    if (this.cardTypes.size > 0) input.cardTypes = [...this.cardTypes];
    if (this.query !== '') input.q = this.query;
    return input;
  }

  /** Reload the first page for the current project, window and filters. */
  private reload(): void {
    this.paintClear();
    this.load(false);
  }

  private load(append: boolean): void {
    const pid = this.ctx.tree.at([...this.scopePath]).peek<bigint | null>() ?? null;
    const seq = ++this.loadSeq;
    if (pid === null) {
      this.rows = [];
      this.facets = null;
      this.facetsKey = '';
      this.loading = false;
      this.hasMore = false;
      this.paint();
      return;
    }
    const input = this.queryInput(pid, this.limit);
    const last = this.rows[this.rows.length - 1];
    if (append && last !== undefined) input.beforeActivityId = last.id;
    const windowKey = `${pid.toString()}|${this.fromDate}|${this.toDate}`;
    if (!append && windowKey !== this.facetsKey) input.facets = true;
    this.loading = true;
    this.paintStatus();
    this.ctx.api.callByName(
      ACTIVITY_SELECT_SPEC,
      input,
      (out) => {
        if (!this.isAlive() || seq !== this.loadSeq) return;
        const o = out as ActivitySelectOutput;
        const page = sortActivityDesc(o.rows ?? []);
        this.rows = append ? [...this.rows, ...page] : page;
        this.hasMore = page.length >= this.limit;
        if (o.facets !== undefined) {
          this.facets = o.facets;
          this.facetsKey = windowKey;
          this.paintMenus();
        }
        this.loading = false;
        this.paint();
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          if (!this.isAlive() || seq !== this.loadSeq) return;
          this.loading = false;
          this.paint();
        },
      },
    );
  }

  /**
   * Export the project's activity for the current window and filters as a CSV
   * download. Fetches a high-limit page (independent of the on-screen page) so
   * the export isn't truncated to the visible rows.
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
        downloadTextFile(`activity-${pid.toString()}.csv`, activityRowsToCsv(rows));
      },
      { alive: () => this.isAlive() },
    );
  }

  /* --------------------------------------------------------------- painting */

  private paintStatus(): void {
    const f = this.facets;
    if (f === null) {
      this.statsEl.textContent = this.loading ? 'Loading…' : '';
      return;
    }
    const people = f.actors.length;
    const inRange = `${f.total} ${f.total === 1 ? 'event' : 'events'} · ${people} ${people === 1 ? 'person' : 'people'}`;
    if (!this.filtered()) {
      this.statsEl.textContent = inRange;
      return;
    }
    const shown = `${this.rows.length}${this.hasMore ? '+' : ''} matching`;
    this.statsEl.textContent = `${shown} of ${inRange}`;
  }

  private paint(): void {
    this.paintStatus();
    const list = this.listEl;
    list.replaceChildren();
    if (this.rows.length === 0) {
      const m = document.createElement('p');
      m.className = 'activity-screen__empty muted';
      const pid = this.ctx.tree.at([...this.scopePath]).peek<bigint | null>() ?? null;
      m.textContent = this.loading
        ? 'Loading activity…'
        : pid === null
          ? 'Pick a project to see its activity.'
          : this.filtered()
            ? 'No activity matches these filters.'
            : 'No activity in this range.';
      list.append(m);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const day of buildFeed(this.rows)) {
      const section = document.createElement('section');
      section.className = 'activity-day';
      section.dataset.activityDay = day.key;
      const h = document.createElement('h2');
      h.className = 'activity-day__label';
      h.textContent = day.label;
      const n = document.createElement('span');
      n.className = 'activity-day__count muted';
      n.textContent = `${day.count} ${day.count === 1 ? 'event' : 'events'}`;
      h.append(n);
      section.append(h);
      for (const g of day.groups) section.append(this.renderGroup(g));
      frag.append(section);
    }
    list.append(frag);
    if (this.hasMore) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'btn activity-screen__more';
      more.dataset.activityMore = '';
      more.textContent = this.loading ? 'Loading…' : 'Load older activity';
      more.disabled = this.loading;
      this.listen(more, 'click', () => this.load(true));
      list.append(more);
    }
  }

  /**
   * One group: the card it opens (a link for a task — Ctrl/Cmd-click opens a
   * new tab), when it happened, who acted, and its rolled-up lines.
   */
  private renderGroup(g: FeedGroup): HTMLElement {
    const el = document.createElement('article');
    el.className = 'activity-group';
    el.dataset.activityGroup = g.navId.toString();
    el.dataset.activityCount = String(g.rows.length);

    const head = document.createElement('header');
    head.className = 'activity-group__head';
    const isTask = g.navType === 'task' || g.navType === '';
    const titleEl = isTask ? document.createElement('a') : document.createElement('span');
    titleEl.className = 'activity-group__link';
    if (isTask) {
      const href = taskUrl(g.navId);
      (titleEl as HTMLAnchorElement).href = href;
      this.listen(titleEl, 'click', plainClick(() => navigate(href)));
    } else {
      const type = document.createElement('span');
      type.className = 'activity-group__type';
      type.textContent = cardTypeLabel(g.navType);
      titleEl.append(type);
    }
    const id = document.createElement('span');
    id.className = 'activity-group__id muted';
    id.textContent = `#${g.navId.toString()}`;
    const title = document.createElement('span');
    title.className = 'activity-group__title';
    title.dataset.activityTitle = '';
    title.textContent = g.title !== '' ? g.title : '(untitled)';
    titleEl.append(id, title);

    const time = document.createElement('time');
    time.className = 'activity-group__time muted';
    const a = clockTime(g.first);
    const b = clockTime(g.last);
    time.textContent = a === b ? b : `${a} – ${b}`;
    time.title = g.first === g.last ? formatLocalDateTime(g.last) : `${formatLocalDateTime(g.first)} – ${formatLocalDateTime(g.last)}`;
    head.append(titleEl, time);

    const actors = document.createElement('div');
    actors.className = 'activity-group__actors';
    for (const name of g.actors) actors.append(this.actorChip(name));

    const lines = document.createElement('ul');
    lines.className = 'activity-group__lines';
    for (const line of g.lines) lines.append(this.renderLine(line, g.actors.length > 1));

    el.append(head, actors, lines);
    return el;
  }

  private actorChip(name: string): HTMLElement {
    const chip = document.createElement('span');
    chip.className = 'activity-actor';
    chip.dataset.activityActor = name;
    const avatar = document.createElement('span');
    avatar.className = 'activity-actor__avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.setAttribute('style', `--avatar-hue: ${hueOf(name)}`);
    avatar.textContent = initials(name);
    const label = document.createElement('span');
    label.className = 'activity-actor__name';
    const owner = /^(.*) \((for .*)\)$/.exec(name);
    if (owner !== null) {
      const forEl = document.createElement('span');
      forEl.className = 'activity-actor__owner muted';
      forEl.textContent = owner[2] ?? '';
      label.append(document.createTextNode(`${owner[1] ?? name} `), forEl);
    } else {
      label.textContent = name;
    }
    chip.append(avatar, label);
    return chip;
  }

  /** One rolled-up change. [showWho] when the group has several actors. */
  private renderLine(line: FeedLine, showWho: boolean): HTMLElement {
    const li = document.createElement('li');
    li.className = `activity-line activity-line--${line.verb}`;
    li.dataset.activityLine = line.verb;
    const main = document.createElement('div');
    main.className = 'activity-line__main';
    const span = (cls: string, text: string): HTMLElement => {
      const s = document.createElement('span');
      s.className = cls;
      s.textContent = text;
      return s;
    };
    if (line.subject !== '') main.append(span('activity-line__subject', line.subject));
    main.append(span('activity-line__label', line.label));

    if (line.verb === 'attr') {
      const change = document.createElement('span');
      change.className = 'activity-line__change';
      if (line.edited === true) {
        change.append(span('activity-line__edited muted', 'edited'));
      } else if (line.old === '—') {
        change.append(span('muted', 'set to '), span('activity-line__new', line.new ?? '—'));
      } else if (line.new === '—') {
        change.append(span('muted', 'cleared '), span('activity-line__old', line.old ?? '—'));
      } else {
        change.append(
          span('activity-line__old', line.old ?? '—'),
          span('activity-line__arrow muted', ' → '),
          span('activity-line__new', line.new ?? '—'),
        );
      }
      main.append(change);
    }
    if (line.verb === 'tags') {
      const tags = document.createElement('span');
      tags.className = 'activity-line__tags';
      for (const t of line.added ?? []) tags.append(span('activity-tag activity-tag--added', `+ ${t}`));
      for (const t of line.removed ?? []) tags.append(span('activity-tag activity-tag--removed', `− ${t}`));
      main.append(tags);
    }
    if (line.count > 1) {
      main.append(span('activity-line__count muted', line.verb === 'attr' ? `${line.count} changes` : `×${line.count}`));
    }
    if (showWho) main.append(span('activity-line__who muted', line.actors.join(', ')));
    li.append(main);

    if (line.details.length > 0) {
      const details = document.createElement('div');
      details.className = 'activity-line__details';
      for (const d of line.details) {
        const item = document.createElement('span');
        item.className = 'activity-line__detail';
        item.append(span('muted', `${d.label} `), document.createTextNode(d.value));
        details.append(item);
      }
      li.append(details);
    }
    if (line.body !== undefined && line.body !== '') {
      const body = document.createElement('p');
      body.className = 'activity-line__body';
      body.textContent = line.body;
      li.append(body);
    }
    return li;
  }
}

export function registerActivity(): void {
  Control.register('Activity', Activity);
}
