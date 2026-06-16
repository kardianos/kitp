// Shared SVG icon set — the ONLY place icon geometry lives. Replaces the
// old scattered unicode glyphs (✉ ☾ ✎ ⋯ …) with Lucide stroke icons so
// every icon inherits currentColor and scales with its container.
//
// Path data is vendored from lucide-static (ISC) — see web/vendor/lucide/
// for the license, version, and the how-to-add-an-icon recipe. The markup
// strings below are static trusted literals (never user input), so
// assigning them via innerHTML is safe, and works under jsdom in tests.

export type IconName =
  | 'mail'
  | 'moon'
  | 'sun'
  | 'info'
  | 'circle-help'
  | 'pencil'
  | 'ellipsis'
  | 'x'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'chevron-up'
  | 'arrow-up'
  | 'arrow-down'
  | 'grip-vertical'
  | 'calendar'
  | 'search'
  | 'check'
  | 'plus'
  | 'refresh-cw'
  | 'circle-user';

const ICON_MARKUP: Record<IconName, string> = {
  mail: '<path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" /><rect x="2" y="4" width="20" height="16" rx="2" />',
  moon: '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />',
  sun: '<circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />',
  info: '<circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />',
  'circle-help':
    '<circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" />',
  pencil:
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" />',
  ellipsis:
    '<circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" />',
  x: '<path d="M18 6 6 18" /><path d="m6 6 12 12" />',
  'chevron-left': '<path d="m15 18-6-6 6-6" />',
  'chevron-right': '<path d="m9 18 6-6-6-6" />',
  'chevron-down': '<path d="m6 9 6 6 6-6" />',
  'chevron-up': '<path d="m18 15-6-6-6 6" />',
  'arrow-up': '<path d="m5 12 7-7 7 7" /><path d="M12 19V5" />',
  'arrow-down': '<path d="M12 5v14" /><path d="m19 12-7 7-7-7" />',
  'grip-vertical':
    '<circle cx="9" cy="12" r="1" /><circle cx="9" cy="5" r="1" /><circle cx="9" cy="19" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="15" cy="5" r="1" /><circle cx="15" cy="19" r="1" />',
  calendar:
    '<path d="M8 2v4" /><path d="M16 2v4" /><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M3 10h18" />',
  search: '<path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" />',
  check: '<path d="M20 6 9 17l-5-5" />',
  plus: '<path d="M5 12h14" /><path d="M12 5v14" />',
  'refresh-cw':
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />',
  'circle-user':
    '<circle cx="12" cy="12" r="10" /><circle cx="12" cy="10" r="3" /><path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662" />',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Build an inline SVG icon. Stroke inherits currentColor, so icons tint
 * with the surrounding text (hover/active states included) for free.
 * Decorative by default (aria-hidden) — the host control carries the
 * accessible name via title/aria-label, exactly as the glyphs did.
 */
export function icon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon', `icon--${name}`);
  svg.innerHTML = ICON_MARKUP[name];
  return svg;
}

/** Replace an element's content with an icon (the glyph-swap helper). */
export function setIcon(host: Element, name: IconName, size = 16): void {
  host.textContent = '';
  host.append(icon(name, size));
}
