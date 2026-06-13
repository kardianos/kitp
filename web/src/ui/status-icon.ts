// Status (phase) icons — the Linear-style colorful state glyphs. Hand-drawn
// (not Lucide): the SHAPE encodes progress (dashed ring → progress pie →
// filled ✓/✕ disc) so state reads at a glance even without color, and within
// a phase the active pie sweep / terminal mark distinguish sibling statuses.
// Geometry uses currentColor; the tint comes from the `.status-icon[data-phase]`
// rules in styles.css reading the --phase-* tokens, so all status surfaces
// share one palette.

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The glyph descriptor. `phase` picks the base shape; the optional fields
 * vary the glyph WITHIN a phase so sibling statuses read distinctly (Linear-
 * style), without disturbing the coarse 3-value `phase` that the filter/flow
 * logic depends on:
 *   - `fill` (active only, 0..1): how far the progress pie is swept — the
 *     status's position among the active statuses (first → empty ring, last →
 *     near-full). Defaults to a half pie when omitted (legacy callers).
 *   - `terminalKind` (terminal only): 'done' draws the ✓ disc, 'cancelled'
 *     the ✕ disc. Defaults to 'done'.
 */
export interface StatusGlyph {
  phase: string;
  fill?: number;
  terminalKind?: 'done' | 'cancelled';
}

/** A status descriptor or a bare phase string (legacy call sites). */
export type StatusGlyphLike = string | StatusGlyph;

const RING =
  '<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6" />';

/** Progress pie swept clockwise from 12 o'clock, inside the ring. 0 → empty
 *  ring (fill = exact fraction of a turn). Active fill tops out at 0.75 (see
 *  statusGlyphs), so the pie never closes — it stays visibly distinct from the
 *  filled terminal disc. */
function activeMarkup(fill: number): string {
  const f = Math.max(0, Math.min(1, fill));
  if (f <= 0.001) return RING; // not started — empty ring
  const angle = Math.min(f, 0.999) * 360;
  const r = 3.4;
  const rad = (angle * Math.PI) / 180;
  const ex = (7 + r * Math.sin(rad)).toFixed(3);
  const ey = (7 - r * Math.cos(rad)).toFixed(3);
  const large = angle > 180 ? 1 : 0;
  const wedge = `<path d="M7 7 L7 ${7 - r} A ${r} ${r} 0 ${large} 1 ${ex} ${ey} Z" fill="currentColor" />`;
  return RING + wedge;
}

/** Inner SVG markup for a glyph, drawn on a 14×14 grid. */
function glyphMarkup(g: StatusGlyph): string {
  switch (g.phase) {
    // Dashed open ring — queued, nothing started (Linear's "backlog").
    case 'triage':
      return '<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.6 2.1" stroke-linecap="round" />';
    // Ring + progress pie — in flight; the sweep encodes position within active.
    case 'active':
      return activeMarkup(g.fill ?? 0.5);
    case 'terminal':
      // The mark is punched out in the surface color so it stays visible on any
      // phase tint. ✕ disc = cancelled, ✓ disc = done.
      return g.terminalKind === 'cancelled'
        ? '<circle cx="7" cy="7" r="6" fill="currentColor" />' +
            '<path d="M4.8 4.8 L9.2 9.2 M9.2 4.8 L4.8 9.2" fill="none" stroke="var(--color-surface, #fff)" stroke-width="1.6" stroke-linecap="round" />'
        : '<circle cx="7" cy="7" r="6" fill="currentColor" />' +
            '<path d="M4.4 7.3 L6.2 9.1 L9.6 5.3" fill="none" stroke="var(--color-surface, #fff)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />';
    // Dotted ring — phase unknown (no status resolved yet).
    default:
      return '<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="0.1 2.6" stroke-linecap="round" />';
  }
}

/** Per-status icon colour. Backlog/todo stay neutral (monochrome); the active
 *  pie ramps yellow → green as it fills (in-flight → almost done); done is
 *  blue; cancelled is neutral. Returns a CSS colour for `currentColor`. */
function glyphColor(g: StatusGlyph): string {
  switch (g.phase) {
    case 'triage':
      return 'var(--phase-triage)';
    case 'terminal':
      return g.terminalKind === 'cancelled' ? 'var(--phase-triage)' : 'var(--phase-terminal)';
    case 'active': {
      const f = g.fill ?? 0.5;
      if (f <= 0.001) return 'var(--color-muted)'; // todo — neutral
      const t = Math.max(0, Math.min(1, (f - 0.5) / 0.25)); // 0 → yellow, 1 → green
      return `color-mix(in oklch, var(--color-success) ${Math.round(t * 100)}%, var(--phase-active))`;
    }
    default:
      return 'var(--color-muted)';
  }
}

/**
 * Given the workflow's status rows, compute the per-status glyph variants
 * (active pie fill + terminal done/cancelled). `phase` stays the coarse 3-value
 * classification; this only enriches the VISUAL so sibling statuses differ.
 * Active fill ramps by `sortOrder` position (first active = empty, last =
 * near-full); a terminal status is 'cancelled' if its label looks like one,
 * else 'done'. Returns a map keyed by id-string; merge into each surface's
 * status info and pass the result to {@link statusIcon}.
 */
const CANCELLED_RE = /cancel|reject|won.?t|abandon|drop|wontfix|invalid/i;
export function statusGlyphs(
  items: ReadonlyArray<{
    idStr: string;
    phase: string;
    sortOrder: number;
    label: string;
    /** Workflow grouping (status's parent). The active ramp is computed WITHIN
     *  a group so a status fills the same fraction whether the caller's status
     *  set is one workflow (kanban axis) or many (the grid's global list). */
    groupKey?: string;
  }>,
  /** When set (non-empty), only these status ids count toward the active ramp —
   *  the project's task-flow statuses. Keeps the grid / task-detail / etc. (which
   *  load ALL of a project's status cards, including ones from other flows) in
   *  step with the flow-scoped kanban. Active statuses outside the set get no
   *  fill (they're not part of the visible workflow and carry no tasks). */
  flowIds?: ReadonlySet<string> | null,
): Map<string, { fill?: number; terminalKind?: 'done' | 'cancelled' }> {
  const out = new Map<string, { fill?: number; terminalKind?: 'done' | 'cancelled' }>();
  const scoped = flowIds != null && flowIds.size > 0;
  const groups = new Map<string, typeof items[number][]>();
  for (const s of items) {
    if (s.phase !== 'active') continue;
    if (scoped && !flowIds.has(s.idStr)) continue;
    const g = groups.get(s.groupKey ?? '');
    if (g) g.push(s);
    else groups.set(s.groupKey ?? '', [s]);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.sortOrder - b.sortOrder);
    const n = group.length;
    group.forEach((s, i) => {
      // First active reads as "todo" (empty ring, neutral); the rest are
      // in-flight and ramp the pie 50% → 75% (75% caps below the terminal
      // disc's 100%, so "almost done" never looks done). The colour ramps
      // yellow → green over the same range (see glyphColor).
      let fill: number;
      if (n === 1) fill = 0.5;
      else if (i === 0) fill = 0;
      else if (n === 2) fill = 0.5;
      else fill = 0.5 + 0.25 * ((i - 1) / (n - 2));
      out.set(s.idStr, { fill });
    });
  }
  for (const s of items) {
    if (s.phase === 'terminal') {
      out.set(s.idStr, { terminalKind: CANCELLED_RE.test(s.label) ? 'cancelled' : 'done' });
    }
  }
  return out;
}

/**
 * The per-status display info every surface keeps (label + phase, plus the
 * glyph variant once {@link applyStatusGlyphs} has run). It is a superset of
 * {@link StatusGlyph}, so an info object can be passed straight to
 * {@link statusIcon}.
 */
export interface StatusInfo extends StatusGlyph {
  label: string;
  /** The status value-card's `sort_order` — sequences the active ramp. */
  sortOrder?: number;
  /** The status's parent (workflow) — groups the ramp. */
  groupKey?: string;
}

/**
 * Enrich a surface's `id → {label, phase}` status map with the glyph variants
 * (active pie fill + terminal done/cancelled) computed from the loaded status
 * rows. Call once after the map is built; then pass each info to
 * {@link statusIcon}. `rows` carry `phase` + an optional `sort_order` attribute
 * (drives the active ramp); the labels come from the map.
 */
export function applyStatusGlyphs(
  map: Map<string, StatusInfo>,
  flowIds?: ReadonlySet<string> | null,
): void {
  const items = [...map.entries()]
    .filter(([, v]) => v.phase !== undefined && v.phase !== '')
    .map(([idStr, v]) => ({
      idStr,
      phase: v.phase,
      sortOrder: v.sortOrder ?? 0,
      label: v.label,
      groupKey: v.groupKey ?? '',
    }));
  // Reset prior variants so a status dropped from the flow scope loses its fill.
  for (const v of map.values()) {
    delete v.fill;
    delete v.terminalKind;
  }
  for (const [id, variant] of statusGlyphs(items, flowIds)) {
    const entry = map.get(id);
    if (entry) Object.assign(entry, variant);
  }
}

/**
 * A small phase-shaped, phase-tinted icon. Decorative (aria-hidden) — the
 * host badge/row carries the status text. Accepts a {@link StatusGlyph} or a
 * bare phase string (legacy call sites get the default half-pie / ✓ shapes).
 */
export function statusIcon(glyph: StatusGlyphLike, size = 14): HTMLElement {
  const g: StatusGlyph = typeof glyph === 'string' ? { phase: glyph } : glyph;
  const span = document.createElement('span');
  span.className = 'status-icon';
  span.dataset.phase = g.phase;
  // Per-status colour (overrides the per-phase .status-icon[data-phase] rule):
  // todo neutral, active yellow→green by fill, done blue, cancelled neutral.
  span.style.color = glyphColor(g);
  span.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 14 14');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.classList.add('icon', 'icon--status');
  svg.innerHTML = glyphMarkup(g);
  span.append(svg);
  return span;
}

/**
 * The shared status badge: phase icon + label. `className` keeps the call
 * site's existing BEM class (each surface styles its own chip); the label
 * lives in a text node so the badge's textContent still equals the label.
 */
export function statusBadge(info: StatusInfo, className: string): HTMLElement {
  const badge = document.createElement('span');
  badge.className = className;
  badge.dataset.phase = info.phase;
  badge.append(statusIcon(info), document.createTextNode(info.label));
  return badge;
}
