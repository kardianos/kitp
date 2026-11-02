/**
 * Framework-agnostic Project-list helpers — lifted from the Svelte client's
 * `client/src/screens/projects_helpers.ts` and re-expressed against the `web/`
 * card model (bigint ids, attributes record). NOTHING here imports from
 * `client/` or touches the DOM / signals — pure functions exercised directly
 * by `node --test`.
 *
 * Surface (parity with the Svelte helpers, trimmed to what v1 needs):
 *   - {@link projectTitle}   read a project card's display title.
 *   - {@link searchByTitle}  the client-side substring search over the loaded
 *     `card.select_with_attributes` project rows. The Svelte screen also
 *     applied a FilterBar predicate, but project cards carry no task-shaped
 *     attributes, so the projects screen drops into search-only mode (the
 *     Svelte component passes `null` as the predicate) — we keep just that.
 *   - {@link clampIndex}     clamp a keyboard-driven selection index into the
 *     visible range (parity with the Svelte `move`).
 */

import type { CardWithAttrs } from '../kanban/kanban-helpers.js';
import type { CardWherePredicate } from '../filter/predicate.js';

/**
 * A single `card.select_with_attributes` `where` predicate leaf. The canonical
 * definition now lives in `../filter/predicate.ts` (the structured
 * PredicateFilter model) — this module re-exports it so the historical import
 * path (`projects/project-helpers.js`) used by `kanban/specs.ts`, the Grid, and
 * the admin import keeps working unchanged.
 *
 * The server compiles each leaf via `card_compile_predicate.sql`; `op:'!='`
 * becomes a `NOT EXISTS` sub-query so a card that has never had the attribute
 * written (no `attribute_value` row) still passes the filter.
 */
export type { CardWherePredicate };

/**
 * The predicate leaf every USER-FACING project list ships to hide template
 * projects, mirroring the Svelte `TEMPLATE_EXCLUSION_LEAF`
 * (client/src/screens/projects_helpers.ts). `card.select_with_attributes` is
 * kept schema-uniform server-side, so the exclusion is client-side by
 * convention — admin surfaces opt back in by omitting it.
 *
 * Edge case: a project that has never had `is_template` written carries no
 * `attribute_value` row; the server's `!=` compiles to `NOT EXISTS`, so unset
 * rows pass the filter and still appear. That is correct — do NOT also filter
 * them out client-side.
 */
export const TEMPLATE_EXCLUSION_LEAF: CardWherePredicate = {
  attr: 'is_template',
  op: '!=',
  value: true,
};

/**
 * The inverse leaf: select ONLY template projects (`is_template = true`). Used
 * by the ProjectList's supplementary "show templates" query — `op:'='` compiles
 * to `EXISTS (… av.value = true)`, so only projects with the flag set match
 * (unset projects, which have no attribute_value row, are excluded).
 */
export const TEMPLATE_INCLUSION_LEAF: CardWherePredicate = {
  attr: 'is_template',
  op: '=',
  value: true,
};

/**
 * Excludes a feature bundle's hidden SOURCE project from template lists. A
 * bundle source is flagged is_template (so it never shows as a project) and
 * bundle_key; it is applied through presets / features, never copied as a
 * template, so the "Start from" templates leave it out.
 */
export const BUNDLE_SOURCE_EXCLUSION_LEAF: CardWherePredicate = {
  attr: 'bundle_key',
  op: 'not exists',
};

/** "Start from" option values for presets carry this prefix (templates are
 *  bare project ids). */
export const PRESET_CHOICE_PREFIX = 'preset:';

/** The "Start from" value that opens the new-project dialog's area list. */
export const AREAS_CHOICE = 'areas:';

/** The part of an area the new-project dialog reads. */
export interface DialogArea {
  key: string;
  title: string;
  doc?: string;
  sort: number;
  dependsOn: readonly string[];
  starts: ReadonlyArray<{ key: string; title: string }>;
}

/**
 * Tick (on) or untick an area in the dialog, keeping dependencies whole:
 * ticking one also ticks what it needs; unticking one also unticks what
 * needs it. Returns the new ticked set.
 */
export function toggleArea(ticked: ReadonlySet<string>, areas: readonly DialogArea[], key: string, on: boolean): Set<string> {
  const out = new Set(ticked);
  const visit = (k: string): void => {
    if (on ? out.has(k) : !out.has(k)) return;
    if (on) out.add(k);
    else out.delete(k);
    if (on) {
      for (const d of areas.find((a) => a.key === k)?.dependsOn ?? []) visit(d);
    } else {
      for (const a of areas) if (a.dependsOn.includes(k)) visit(a.key);
    }
  };
  visit(key);
  return out;
}

/** The areas a preset (a list of feature bundles) amounts to: every area one
 *  of its features starts, and what they need. */
export function areasOfPreset(features: readonly string[], areas: readonly DialogArea[]): Set<string> {
  let out = new Set<string>();
  for (const a of areas) {
    if (a.starts.some((s) => features.includes(s.key))) out = toggleArea(out, areas, a.key, true);
  }
  return out;
}

/**
 * The project.compose input for the ticked areas: `features` are their
 * starting points (the picked one, else the default) in area order, so an
 * area comes after what it needs; `areasOff` are the areas left unticked.
 */
export function composeFromAreas(
  ticked: ReadonlySet<string>,
  areas: readonly DialogArea[],
  picks: Readonly<Record<string, string>> = {},
): { features: string[]; areasOff: string[] } {
  const ordered = [...areas].sort((a, b) => a.sort - b.sort);
  const features: string[] = [];
  const areasOff: string[] = [];
  for (const a of ordered) {
    if (!ticked.has(a.key)) {
      areasOff.push(a.key);
      continue;
    }
    const start = picks[a.key] ?? a.starts[0]?.key;
    if (start !== undefined && !features.includes(start)) features.push(start);
  }
  return { features, areasOff };
}

/** The preset key a "Start from" value names, or null for a template / the
 *  default. */
export function composeChoice(value: string): string | null {
  if (!value.startsWith(PRESET_CHOICE_PREFIX)) return null;
  const key = value.slice(PRESET_CHOICE_PREFIX.length);
  return key.length > 0 ? key : null;
}

/** Read a project card's `title` attribute (the real handler nests it under
 *  `attributes.title`), falling back to a `#id` when absent. */
export function projectTitle(p: CardWithAttrs): string {
  const t = p.attributes['title'];
  if (typeof t === 'string' && t.length > 0) return t;
  return `#${p.id.toString()}`;
}

/** Read a project card's optional `description` (trimmed, empty → undefined). */
export function projectDescription(p: CardWithAttrs): string | undefined {
  const v = p.attributes['description'];
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Case-insensitive substring search over `attributes.title`. An empty / blank
 * needle returns the full list (a copy). Matches the Svelte `searchAndFilter`
 * in search-only mode.
 */
export function searchByTitle(
  projects: readonly CardWithAttrs[],
  search: string,
): CardWithAttrs[] {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) return [...projects];
  return projects.filter((p) => projectTitle(p).toLowerCase().includes(needle));
}

/** Clamp `current + delta` into `[0, max(len-1, 0)]`; 0 when the list is empty. */
export function clampIndex(visibleLen: number, current: number, delta: number): number {
  if (visibleLen <= 0) return 0;
  const next = current + delta;
  if (next < 0) return 0;
  if (next > visibleLen - 1) return visibleLen - 1;
  return next;
}
