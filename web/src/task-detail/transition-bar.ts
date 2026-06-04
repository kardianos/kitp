/**
 * TransitionBar (#34) — the status changer for the Task detail.
 *
 * Mounts into the TaskDetail's `[data-slot="transitions"]` region (the main
 * column, under the title). It is the canonical "move a task through its
 * workflow" action that replaces the plain status card_ref editor in the
 * attribute side panel.
 *
 * Data: loads `flow_step.list_for_card { cardId }` — one row per flow_step the
 * card may currently fire on a flow-bound attribute (typically `status`). Each
 * row carries `from`/`to` (id + label + phase), a button `label`, the optional
 * `requiresRoleName`, a `sortOrder`, and a per-actor `allowed` bit (system
 * bypass + project-or-global scope, computed server-side). The bar re-loads its
 * available steps whenever the task's status changes (after its own fire, OR
 * when the TaskDetail's panel commits status — via {@link reload}).
 *
 * Render: each transition's `standalone` bit (authored on the flow_step row,
 * identical for task AND comm status) decides its presentation — `true` → its
 * own button, `false` → folded into one overflow "Status ▾" dropdown. The
 * (from.phase → to.phase) bucket only drives the button's TONE and the
 * dropdown's grouping (see transition-buckets.ts), NOT whether it's a button
 * vs a menu item. Buttons + menu items are emitted in canonical bucket order so
 * the bar stays phase-grouped regardless of which steps are standalone.
 *
 * Fire (optimistic): clicking a transition fires `attribute.update` setting the
 * status attr to the step's `toCardId` — the local status patches + the bar
 * re-loads its available steps immediately; a fault rolls the status back.
 *
 * Role-gating: a step whose `allowed` bit is false renders DISABLED with a
 * "Needs <role>" hint (the server still enforces).
 *
 * Rejection banner (V13): if the `attribute.update` returns a `flow_disallowed`
 * / `flow_role_required` sub-error, its `detail: { from, attempted_to,
 * available[] }` is routed to THIS bar (not just the top toast) and rendered as
 * a banner whose `available[]` entries are live retry buttons.
 *
 * Cascade-safe, declarative, ZERO-PROMISE: every load/fire routes through
 * `api.callByName(..., onOk, { alive, onErr })`; no `.then`/`await` here.
 *
 * Reference (NOT imported): client/src/ui/widgets/TransitionBar.svelte.
 */

import { Control, type BaseControlConfig } from '../core/control.js';
import type { ApiFault } from '../core/dispatch.js';
import { Popover } from '../ui/popover.js';
import { SPEC, type AttributeUpdateOutput } from '../kanban/specs.js';
import {
  FLOW_STEP_LIST_FOR_CARD_SPEC,
  type FlowStepListForCardOutput,
} from './specs.js';
import {
  asTransitionPhase,
  bucketOf,
  groupByBucket,
  hasAnyTransition,
  ALL_BUCKETS,
  BUCKET_TONE,
  type BucketMap,
  type BucketTone,
  type TransitionBucket,
  type TransitionPhase,
  type TransitionRow,
} from './transition-buckets.js';

/**
 * Dropdown sub-heading per bucket — the phase-derived grouping shown when more
 * than one bucket folds into the overflow menu ("phase still drives grouping").
 */
const MENU_GROUP: Record<TransitionBucket, string> = {
  progress_triage: 'Triage',
  accept: 'Accept',
  reject: 'Reject',
  defer: 'Defer',
  progress: 'Progress',
  close: 'Close',
  retriage: 'Re-triage',
  reopen: 'Reopen',
  recategorize: 'Recategorize',
};

/* -------------------------------------------------------------------------- */
/* Config + declaration-merged registry type.                                 */
/* -------------------------------------------------------------------------- */

export interface TransitionBarConfig extends BaseControlConfig {
  type: 'TransitionBar';
  /** The focal card whose transitions are listed (string → bigint). */
  cardId: string;
  /**
   * The status attribute the flow is bound to; the fire sets this attr to the
   * step's `to` card id. The wire row also carries it (`attributeDefName`), so
   * this is the fallback when no steps have loaded yet. Default 'status'.
   */
  statusAttr?: string;
  /**
   * Called after a SUCCESSFUL transition fire so the parent (TaskDetail) can
   * refresh its own view (the panel's status summary). Receives the new status
   * card id. Not declarative — a plain callback handed in at spawn.
   */
  onChanged?: (toCardId: bigint, attributeName: string) => void;
}

declare module '../core/control.js' {
  interface ControlConfigMap {
    TransitionBar: TransitionBarConfig;
  }
}

/* -------------------------------------------------------------------------- */
/* V13 rejection envelope (the attribute.update fault `detail`).               */
/* -------------------------------------------------------------------------- */

interface FlowEndpoint {
  id: string;
  label: string;
  phase: TransitionPhase;
}

/** One row of the V13 `available[]` rejection payload. */
interface FlowAvailableTo {
  stepId: string;
  to: FlowEndpoint;
  label: string;
  yourRoleAllows: boolean;
  requiresRole: string | null;
}

interface FlowRejectionDetail {
  from: FlowEndpoint;
  attemptedTo: FlowEndpoint;
  available: FlowAvailableTo[];
}

/* -------------------------------------------------------------------------- */
/* Control.                                                                    */
/* -------------------------------------------------------------------------- */

export class TransitionBar extends Control<TransitionBarConfig> {
  private readonly cardId: bigint | null;
  private readonly statusAttr: string;
  private readonly onChanged?: (toCardId: bigint, attributeName: string) => void;

  /** The loaded available transitions, bucketed. */
  private buckets: BucketMap = groupByBucket([]);
  /** True between a load fire and its response (suppresses re-fires). */
  private loading = false;
  /** True while a transition fire is in flight (disables all buttons). */
  private busy = false;
  /** Active V13 rejection banner, or null. */
  private banner: FlowRejectionDetail | null = null;

  /* DOM regions held so loads / fires can repaint without a full re-render. */
  private barEl!: HTMLElement;
  private bannerHost!: HTMLElement;

  /** Open dropdown popover, disposed on close / rebuild / destroy. */
  private openMenu: Popover | null = null;

  constructor(...args: ConstructorParameters<typeof Control<TransitionBarConfig>>) {
    super(...args);
    this.cardId = parseId(this.config.cardId);
    this.statusAttr = this.config.statusAttr ?? 'status';
    this.onChanged = this.config.onChanged;
  }

  protected override createRoot(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'transition-bar';
    el.dataset.control = 'TransitionBar';
    return el;
  }

  protected render(): void {
    const bar = document.createElement('div');
    bar.className = 'transition-bar__row';
    bar.dataset.region = 'detail.transitions';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Change status');
    this.barEl = bar;

    const bannerHost = document.createElement('div');
    bannerHost.className = 'transition-bar__banner-host';
    bannerHost.dataset.transitionBannerHost = '';
    this.bannerHost = bannerHost;

    this.el.append(bar, bannerHost);

    this.loadTransitions();
    this.paint();
  }

  /* -------------------------------- loads ------------------------------- */

  /**
   * Load (or reload) the card's available transitions. Public so the TaskDetail
   * can refresh the bar when its panel commits a status change. Zero-promise.
   */
  reload(): void {
    this.loadTransitions();
  }

  private loadTransitions(): void {
    if (this.cardId === null) {
      this.buckets = groupByBucket([]);
      this.paint();
      return;
    }
    this.loading = true;
    this.paint();
    this.ctx.api.callByName(
      FLOW_STEP_LIST_FOR_CARD_SPEC,
      { cardId: this.cardId },
      (out) => {
        const rows = (out as FlowStepListForCardOutput).rows ?? [];
        this.buckets = groupByBucket(rows);
        this.loading = false;
        this.paint();
      },
      {
        alive: () => this.isAlive(),
        onErr: () => {
          // The central funnel already toasted; just clear the loading state so
          // the bar shows its (possibly empty) last-known steps.
          if (!this.isAlive()) return;
          this.loading = false;
          this.paint();
        },
      },
    );
  }

  /* ----------------------------- fire + state --------------------------- */

  /**
   * Fire one transition: `attribute.update { cardId, statusAttr, toCardId }`,
   * OPTIMISTICALLY. The bar re-loads its available steps on success (the new
   * `from` is the step's `to`), and notifies the parent so its panel summary
   * tracks. A `flow_disallowed`/`flow_role_required` fault pins the V13 banner
   * onto THIS bar; any other fault funnels to the top toast.
   */
  private fire(t: TransitionRow): void {
    if (this.cardId === null || this.busy || this.loading) return;
    if (!t.allowed) {
      // Defensive — the button is already disabled; ignore stray fires.
      return;
    }
    const attr = t.attributeDefName.length > 0 ? t.attributeDefName : this.statusAttr;
    this.busy = true;
    this.banner = null;
    this.closeMenu();
    this.paint();

    this.ctx.api.callByName(
      SPEC.attributeUpdate,
      { cardId: this.cardId, attributeName: attr, value: t.toCardId },
      (_out) => {
        void (_out as AttributeUpdateOutput);
        if (!this.isAlive()) return;
        this.busy = false;
        // Tell the parent so its panel's status summary reflects the move.
        this.onChanged?.(t.toCardId, attr);
        // Re-load the available steps from the new state (optimistic reload).
        this.loadTransitions();
      },
      {
        alive: () => this.isAlive(),
        onErr: (fault) => {
          if (!this.isAlive()) return;
          this.busy = false;
          const detail = parseRejectionDetail(faultDetail(fault));
          if (detail !== null) {
            // Route the V13 envelope to THIS bar (self), not just the top toast.
            this.banner = detail;
          }
          // Optimistic reload was not applied (we reload only on success), so
          // there is nothing to roll back beyond clearing busy + repainting.
          this.paint();
        },
      },
    );
  }

  /** Fire the transition matching a banner `available[]` entry (live retry). */
  private fireFromBanner(a: FlowAvailableTo): void {
    const t = this.transitionFromAvailable(a);
    if (t === null) {
      // The step is not in our current set; a reload likely changed the state.
      this.reload();
      return;
    }
    this.fire(t);
  }

  /** Map a V13 `available[]` entry back to a loaded TransitionRow. */
  private transitionFromAvailable(a: FlowAvailableTo): TransitionRow | null {
    const all = this.allRows();
    for (const t of all) if (t.id.toString() === a.stepId) return t;
    for (const t of all) if (t.toCardId.toString() === a.to.id) return t;
    return null;
  }

  private allRows(): TransitionRow[] {
    return [
      ...this.buckets.progress_triage,
      ...this.buckets.accept,
      ...this.buckets.reject,
      ...this.buckets.defer,
      ...this.buckets.progress,
      ...this.buckets.close,
      ...this.buckets.retriage,
      ...this.buckets.reopen,
      ...this.buckets.recategorize,
    ];
  }

  /* -------------------------------- paint ------------------------------- */

  /** Rebuild the bar's buttons + the banner wholesale (disposes any open menu). */
  private paint(): void {
    this.closeMenu();
    this.paintBar();
    this.paintBanner();
  }

  private paintBar(): void {
    this.barEl.replaceChildren();
    const m = this.buckets;

    if (this.loading && !hasAnyTransition(m)) {
      const wait = document.createElement('span');
      wait.className = 'transition-bar__loading muted';
      wait.dataset.transitionLoading = '';
      wait.textContent = 'Loading actions…';
      this.barEl.append(wait);
      return;
    }

    if (!hasAnyTransition(m)) {
      const empty = document.createElement('span');
      empty.className = 'transition-bar__empty muted';
      empty.dataset.transitionEmpty = '';
      empty.textContent = 'No status changes available.';
      this.barEl.append(empty);
      return;
    }

    // Bit-driven: every transition renders as a standalone button
    // (standalone=true) or folds into ONE overflow "Status ▾" dropdown
    // (standalone=false). Iterate buckets in canonical order so buttons + menu
    // items stay phase-grouped; the bucket supplies the button TONE only.
    const menuItems: DropItem[] = [];
    const menuBuckets = new Set<TransitionBucket>();
    for (const bucket of ALL_BUCKETS) {
      for (const t of m[bucket]) {
        if (t.standalone) {
          this.barEl.append(this.standaloneButton(t, bucket));
        } else {
          menuItems.push({ transition: t });
          menuBuckets.add(bucket);
        }
      }
    }
    if (menuItems.length > 0) {
      // Group the dropdown by bucket only when more than one phase-bucket folds
      // in ("phase still drives grouping"); a single-bucket menu needs no header.
      if (menuBuckets.size > 1) {
        for (const it of menuItems) it.group = MENU_GROUP[bucketOf(it.transition)];
      }
      this.barEl.append(this.overflowDropdown(menuItems));
    }
  }

  /** A standalone transition button, toned by its phase bucket. */
  private standaloneButton(t: TransitionRow, bucket: TransitionBucket): HTMLElement {
    const btn = this.makeButton(t, BUCKET_TONE[bucket], bucket);
    btn.dataset.testid = `transition-${bucket}`;
    return btn;
  }

  /**
   * The single overflow dropdown that holds every non-standalone transition,
   * grouped by phase bucket. Neutral-toned (it spans buckets); the items carry
   * their own bucket via {@link DropItem}.
   */
  private overflowDropdown(items: DropItem[]): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'transition-bar__split transition-bar__split--neutral';
    wrap.dataset.testid = 'transition-menu-trigger';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'transition-bar__split-primary transition-bar__split-toggle';
    toggle.dataset.testid = 'transition-menu-toggle';
    toggle.dataset.bucket = 'menu';
    toggle.setAttribute('aria-haspopup', 'menu');
    toggle.setAttribute('aria-label', 'Change status');
    toggle.disabled = this.busy || this.loading;
    const lbl = document.createElement('span');
    lbl.textContent = 'Status';
    toggle.append(lbl, chevron());
    this.listen(toggle, 'click', (e) => {
      e.stopPropagation();
      this.toggleMenu(toggle, items, 'menu');
    });
    wrap.append(toggle);
    return wrap;
  }

  /** Build one transition button. */
  private makeButton(
    t: TransitionRow,
    tone: BucketTone,
    bucket: string,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `transition-bar__btn transition-bar__btn--${tone}`;
    btn.dataset.bucket = bucket;
    btn.dataset.stepId = t.id.toString();
    btn.disabled = this.busy || this.loading || !t.allowed;
    btn.title = t.allowed ? this.labelOf(t) : this.roleHint(t);

    const text = document.createElement('span');
    text.textContent = this.labelOf(t);
    btn.append(text);

    if (!t.allowed && t.requiresRoleName.length > 0) {
      const hint = document.createElement('span');
      hint.className = 'transition-bar__role-hint';
      hint.dataset.roleHint = '';
      hint.textContent = `Needs ${t.requiresRoleName}`;
      btn.append(hint);
    }

    this.listen(btn, 'click', () => this.fire(t));
    return btn;
  }

  /* ------------------------------- dropdowns ---------------------------- */

  private toggleMenu(anchor: HTMLElement, items: DropItem[], bucket: string): void {
    if (this.openMenu !== null) {
      this.closeMenu();
      return;
    }
    const menu = new Popover(anchor, { placement: 'bottom-end', width: '14rem' });
    const panel = menu.element;
    panel.classList.add('transition-bar__menu');
    panel.setAttribute('role', 'menu');
    panel.dataset.testid = `transition-${bucket}-menu`;

    let lastGroup: string | undefined;
    for (const item of items) {
      if (item.group !== undefined && item.group !== lastGroup) {
        const head = document.createElement('div');
        head.className = 'transition-bar__menu-group';
        head.dataset.testid = `transition-${bucket}-group`;
        head.textContent = item.group;
        panel.append(head);
      }
      lastGroup = item.group;

      const t = item.transition;
      const mi = document.createElement('button');
      mi.type = 'button';
      mi.className = 'transition-bar__menu-item';
      mi.setAttribute('role', 'menuitem');
      mi.dataset.testid = `transition-${bucket}-item`;
      mi.dataset.stepId = t.id.toString();
      mi.dataset.bucket = bucketOf(t);
      mi.disabled = this.busy || this.loading || !t.allowed;

      const text = document.createElement('span');
      text.textContent = this.labelOf(t);
      mi.append(text);
      if (!t.allowed && t.requiresRoleName.length > 0) {
        const hint = document.createElement('span');
        hint.className = 'transition-bar__role-hint';
        hint.dataset.roleHint = '';
        hint.textContent = `Needs ${t.requiresRoleName}`;
        mi.append(hint);
      }
      this.listen(mi, 'click', (e) => {
        e.stopPropagation();
        this.closeMenu();
        this.fire(t);
      });
      panel.append(mi);
    }

    this.openMenu = menu;
    menu.open();
  }

  private closeMenu(): void {
    if (this.openMenu === null) return;
    this.openMenu.destroy();
    this.openMenu = null;
  }

  /* -------------------------------- banner ------------------------------ */

  private paintBanner(): void {
    this.bannerHost.replaceChildren();
    const b = this.banner;
    if (b === null) return;

    const box = document.createElement('div');
    box.className = 'transition-bar__banner';
    box.dataset.testid = 'transition-banner';
    box.setAttribute('role', 'alert');

    const head = document.createElement('div');
    head.className = 'transition-bar__banner-head';
    const msg = document.createElement('p');
    msg.className = 'transition-bar__banner-msg';
    const fromStrong = document.createElement('strong');
    fromStrong.textContent = b.from.label.length > 0 ? b.from.label : `#${b.from.id}`;
    const toStrong = document.createElement('strong');
    toStrong.textContent =
      b.attemptedTo.label.length > 0 ? b.attemptedTo.label : `#${b.attemptedTo.id}`;
    msg.append(fromStrong, document.createTextNode(' → '), toStrong, document.createTextNode(" isn't a valid move."));

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'transition-bar__banner-dismiss';
    dismiss.dataset.testid = 'transition-banner-dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.title = 'Dismiss';
    dismiss.textContent = '×';
    this.listen(dismiss, 'click', () => {
      this.banner = null;
      this.paintBanner();
    });

    head.append(msg, dismiss);
    box.append(head);

    if (b.available.length > 0) {
      const actions = document.createElement('div');
      actions.className = 'transition-bar__banner-actions';
      const lead = document.createElement('span');
      lead.className = 'transition-bar__banner-lead muted';
      lead.textContent = 'You can:';
      actions.append(lead);

      for (const a of b.available) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'transition-bar__banner-action';
        btn.dataset.testid = 'transition-banner-action';
        btn.dataset.stepId = a.stepId;
        btn.disabled = this.busy || !a.yourRoleAllows;
        btn.title = a.yourRoleAllows
          ? a.label
          : a.requiresRole !== null
            ? `Needs ${a.requiresRole}`
            : '';
        const text = document.createElement('span');
        text.textContent = a.label.length > 0 ? a.label : a.to.label;
        btn.append(text);
        if (!a.yourRoleAllows && a.requiresRole !== null) {
          const hint = document.createElement('span');
          hint.className = 'transition-bar__role-hint';
          hint.dataset.roleHint = '';
          hint.textContent = `Needs ${a.requiresRole}`;
          btn.append(hint);
        }
        this.listen(btn, 'click', () => this.fireFromBanner(a));
        actions.append(btn);
      }
      box.append(actions);
    }

    this.bannerHost.append(box);
  }

  /* -------------------------------- helpers ----------------------------- */

  private labelOf(t: TransitionRow): string {
    return t.label.length > 0 ? t.label : t.toLabel;
  }

  private roleHint(t: TransitionRow): string {
    return t.requiresRoleName.length > 0 ? `Needs ${t.requiresRoleName}` : '';
  }
}

/** One dropdown entry: a transition + optional group heading above it. */
interface DropItem {
  transition: TransitionRow;
  group?: string;
}

/* -------------------------------------------------------------------------- */
/* Helpers.                                                                     */
/* -------------------------------------------------------------------------- */

/** Parse a config id string to a positive bigint, or null when malformed. */
function parseId(raw: string | undefined): bigint | null {
  if (raw === undefined || raw === '') return null;
  if (!/^\d+$/.test(raw)) return null;
  try {
    const n = BigInt(raw);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

/** A small chevron SVG for the dropdown toggles. */
function chevron(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('class', 'transition-bar__chevron');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M2 4 L6 8 L10 4');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('fill', 'none');
  svg.append(path);
  return svg;
}

/** Pull the `detail` payload off a sub_error fault (undefined for others). */
function faultDetail(fault: ApiFault): unknown {
  return fault.kind === 'sub_error' ? fault.detail : undefined;
}

/**
 * Parse a fault `detail` payload as the V13 rejection envelope. Returns null if
 * the shape doesn't match — non-flow rejections come through the same code path
 * and we must not mask them (they stay on the top toast).
 */
function parseRejectionDetail(raw: unknown): FlowRejectionDetail | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const from = parseEndpoint(o['from']);
  const attemptedTo = parseEndpoint(o['attempted_to']);
  if (from === null || attemptedTo === null) return null;
  return { from, attemptedTo, available: parseAvailableArray(o['available']) };
}

function parseEndpoint(raw: unknown): FlowEndpoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = asIdString(o['id']);
  if (id === '') return null;
  return {
    id,
    label: typeof o['label'] === 'string' ? o['label'] : '',
    phase: asTransitionPhase(o['phase']),
  };
}

function parseAvailableArray(raw: unknown): FlowAvailableTo[] {
  if (!Array.isArray(raw)) return [];
  const out: FlowAvailableTo[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const to = parseEndpoint(o['to']);
    if (to === null) continue;
    out.push({
      stepId: asIdString(o['step_id']),
      to,
      label: typeof o['label'] === 'string' ? o['label'] : to.label,
      yourRoleAllows: o['your_role_allows'] === true,
      requiresRole:
        typeof o['requires_role'] === 'string' && o['requires_role'].length > 0
          ? o['requires_role']
          : null,
    });
  }
  return out;
}

/** Coerce a wire id (bigint after revival, or number/string) to its string. */
function asIdString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  return '';
}

export function registerTransitionBar(): void {
  Control.register('TransitionBar', TransitionBar);
}
