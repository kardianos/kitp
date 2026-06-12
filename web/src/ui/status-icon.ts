// Status (phase) icons — the Linear-style colorful state glyphs. One shape
// per workflow phase, hand-drawn (not Lucide): the SHAPE encodes progress
// (dashed → half-filled → filled+check) so state reads at a glance even
// without color. Geometry uses currentColor; the tint comes from the
// `.status-icon[data-phase]` rules in styles.css reading the --phase-*
// tokens, so all status surfaces share one palette.

import type { Phase } from '../filter/predicate.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Inner markup per phase, drawn on a 14×14 grid. '' = unknown/unset. */
const PHASE_MARKUP: Record<Phase | '', string> = {
  // Dashed open ring — queued, nothing started (Linear's "todo/backlog").
  triage:
    '<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.6 2.1" stroke-linecap="round" />',
  // Ring + right-half pie — in flight.
  active:
    '<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6" />' +
    '<path d="M7 3.6 A3.4 3.4 0 0 1 7 10.4 Z" fill="currentColor" />',
  // Filled disc + check — done. The check is punched out in the surface
  // color so it stays visible on any phase tint.
  terminal:
    '<circle cx="7" cy="7" r="6" fill="currentColor" />' +
    '<path d="M4.4 7.3 L6.2 9.1 L9.6 5.3" fill="none" stroke="var(--color-surface, #fff)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />',
  // Dotted ring — phase unknown (no status resolved yet).
  '':
    '<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="0.1 2.6" stroke-linecap="round" />',
};

/**
 * A small phase-shaped, phase-tinted icon. Decorative (aria-hidden) — the
 * host badge/row carries the status text. Accepts any string (call sites
 * carry phase as a plain string); unknown values draw the dotted ring.
 */
export function statusIcon(phase: string, size = 14): HTMLElement {
  const span = document.createElement('span');
  span.className = 'status-icon';
  span.dataset.phase = phase;
  span.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 14 14');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.classList.add('icon', 'icon--status');
  svg.innerHTML = (PHASE_MARKUP as Record<string, string>)[phase] ?? PHASE_MARKUP[''];
  span.append(svg);
  return span;
}

/**
 * The shared status badge: phase icon + label. `className` keeps the call
 * site's existing BEM class (each surface styles its own chip); the label
 * lives in a text node so the badge's textContent still equals the label.
 */
export function statusBadge(
  info: { label: string; phase: string },
  className: string,
): HTMLElement {
  const badge = document.createElement('span');
  badge.className = className;
  badge.dataset.phase = info.phase;
  badge.append(statusIcon(info.phase), document.createTextNode(info.label));
  return badge;
}
