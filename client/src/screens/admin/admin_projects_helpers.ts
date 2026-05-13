/**
 * Pure helpers for `AdminProjectsScreen`. Extracted as a TypeScript
 * module so they can be unit-tested without a Svelte component-mount
 * runtime (vitest is node-only here).
 *
 *   - `isTemplate`              read the `is_template` attribute as a
 *                                boolean, defaulting to false when absent.
 *   - `projectTitle`            human-readable project title (falls back
 *                                to `#<id>` when the title attribute is
 *                                missing).
 *   - `applyProjectFilters`     substring search by title + the optional
 *                                "show templates" toggle.
 *   - `validateStampName`       trims + rejects empty stamp names; mirrors
 *                                the server's required-field guard.
 *
 * Filtering convention (Gate 12 / V27): when `showTemplates` is false the
 * admin list hides template projects too — admins start with the same
 * view a normal user sees and opt in via the toggle. When true, every
 * project (template or not) is returned.
 */

import type { CardWithAttrs } from '../../reg/types.js';

/**
 * Read `is_template` as a boolean. Cards that never had the attribute
 * written carry no attribute_value row and surface as `undefined`; treat
 * those as `false` so the badge / row state defaults to "regular
 * project". Strings ("true" / "false") are tolerated for resilience
 * against future seed-side stringification, but the canonical value is a
 * JSON boolean.
 */
export function isTemplate(card: CardWithAttrs): boolean {
  const v = card.attributes['is_template'];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  return false;
}

/** Title attribute or `#<id>` when missing. Mirrors `screen_preset.readTitle`. */
export function projectTitle(card: CardWithAttrs): string {
  const v = card.attributes['title'];
  return typeof v === 'string' && v.length > 0 ? v : `#${card.id}`;
}

/**
 * Substring filter on project title (case-insensitive) plus the
 * `showTemplates` toggle. Whitespace-only `search` matches every row.
 * When `showTemplates` is false, rows where `is_template` is truthy are
 * excluded — mirrors the user-list semantics so admins start with the
 * same view.
 *
 * Returns a fresh array; never mutates `projects`.
 */
export function applyProjectFilters(
  projects: readonly CardWithAttrs[],
  search: string,
  showTemplates: boolean,
): CardWithAttrs[] {
  const needle = search.trim().toLowerCase();
  const out: CardWithAttrs[] = [];
  for (const p of projects) {
    if (!showTemplates && isTemplate(p)) continue;
    if (needle.length > 0) {
      const t = projectTitle(p).toLowerCase();
      if (!t.includes(needle)) continue;
    }
    out.push(p);
  }
  return out;
}

/**
 * Trim + validate a name typed into the "Stamp new project" dialog.
 * Empty / whitespace-only is rejected so the wire payload always carries
 * a non-empty `name` (the server's own guard would also reject, but the
 * UI fails the keystroke before sending bytes).
 */
export function validateStampName(
  raw: string,
):
  | { ok: true; name: string }
  | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, error: 'Name is required.' };
  }
  return { ok: true, name: trimmed };
}

/** Coerce a thrown value to a string for toast messages. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
