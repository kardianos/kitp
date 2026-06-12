// Priority indicator — Linear-style signal bars instead of a colored pill.
// A `priority/<leaf>` tag renders as 1–3 filled bars (low → high); unknown
// leaves return null so the caller falls back to the regular tag chip. The
// bars draw in currentColor (muted by default, danger for urgent — see the
// .priority-ind rules in styles.css), so priority reads by SHAPE, not by a
// loud color block.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Filled-bar count per recognised priority leaf (of 3). */
const LEVELS: Record<string, number> = {
  low: 1,
  med: 2,
  medium: 2,
  high: 3,
  urgent: 3,
};

/** The three bars: x position, top y, height — on a 14×14 grid. */
const BARS: ReadonlyArray<{ x: number; y: number; h: number }> = [
  { x: 1.5, y: 8, h: 4.5 },
  { x: 5.75, y: 5.5, h: 7 },
  { x: 10, y: 3, h: 9.5 },
];

/** True when a tag path is a priority tag (the `priority/` prefix). */
export function isPriorityPath(path: string): boolean {
  return path.startsWith('priority/');
}

/**
 * An empty box the exact footprint of the bars, so surfaces that lead with
 * the priority indicator (kanban card meta) keep the slot reserved on
 * cards WITHOUT a priority — sibling chips line up across cards.
 */
export function priorityPlaceholder(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'priority-ind priority-ind--none';
  span.setAttribute('aria-hidden', 'true');
  return span;
}

/**
 * Build the signal-bars indicator for a priority leaf ('low' | 'med' |
 * 'medium' | 'high' | 'urgent', case-insensitive). Returns null for an
 * unrecognised leaf — callers keep their regular chip in that case.
 */
export function priorityIcon(leaf: string, size = 14): HTMLElement | null {
  const key = leaf.toLowerCase();
  const filled = LEVELS[key];
  if (filled === undefined) return null;

  const span = document.createElement('span');
  span.className = 'priority-ind';
  span.dataset.priority = key;
  span.title = `Priority: ${leaf}`;
  span.setAttribute('aria-label', `Priority: ${leaf}`);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 14 14');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon', 'icon--priority');
  svg.innerHTML = BARS.map(
    (b, i) =>
      `<rect x="${b.x}" y="${b.y}" width="2.5" height="${b.h}" rx="1" ` +
      `fill="currentColor"${i < filled ? '' : ' opacity="0.3"'} />`,
  ).join('');
  span.append(svg);
  return span;
}
