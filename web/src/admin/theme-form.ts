/**
 * Themes screen config for the generic RecordForm — a theme (what a portal's
 * site looks like) expressed as DATA: a field table and row→draft /
 * draft→input mappers. The theme's files (templates, CSS, logo, favicon) are
 * the ThemeFiles panel below the form.
 *
 * A theme has a name, a built-in base theme it starts from, a navigation
 * mode (the base's own, or full / current section / collapsible), an accent
 * colour and a footer (markdown). Themes are global, like portals.
 */

import type { RecordFormScreenConfig } from './record-form.js';
import { THEME_SPEC } from '../bundles/specs.js';

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'bigint') return v.toString();
  return String(v);
}

function idOrEmpty(v: unknown): string {
  const s = str(v);
  return /^\d+$/.test(s) && s !== '0' ? s : '';
}

/** Navigation modes, as the form offers them. */
export const THEME_NAV_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: "The base theme's" },
  { value: 'full', label: 'Whole tree, every branch open' },
  { value: 'section', label: 'Top level, opened along the current page' },
  { value: 'collapsible', label: 'Whole tree, closed except along the current page' },
];

const ACCENT = /^#[0-9a-fA-F]{6}$/;

/** A decoded theme.list row → the form draft. */
export function themeRowToDraft(row: Record<string, unknown>): Record<string, unknown> {
  const portals = Array.isArray(row['portals']) ? (row['portals'] as unknown[]).map(str) : [];
  return {
    id: idOrEmpty(row['id']),
    title: str(row['title']),
    base: str(row['base']),
    nav: str(row['nav']),
    accent: str(row['accent']),
    footer: str(row['footer']),
    portals: portals.length > 0 ? portals.join(', ') : 'No portal uses it yet. Pick it in Admin → Portals.',
  };
}

/** The form draft → theme.set input (every field, so the server holds
 *  exactly what the form shows). */
export function themeDraftToInput(draft: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {
    title: str(draft['title']).trim(),
    base: str(draft['base']),
    nav: str(draft['nav']),
    accent: str(draft['accent']).trim().toLowerCase(),
    footer: str(draft['footer']).trim(),
  };
  const id = idOrEmpty(draft['id']);
  if (id !== '') input['id'] = BigInt(id);
  return input;
}

export function validateThemeDraft(draft: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  if (str(draft['title']).trim() === '') out['title'] = 'A theme needs a name.';
  if (str(draft['base']) === '') out['base'] = 'Choose a theme to start from.';
  const accent = str(draft['accent']).trim();
  if (accent !== '' && !ACCENT.test(accent)) out['accent'] = 'Use a colour like #2f6bdb.';
  return out;
}

export const THEME_FORM: RecordFormScreenConfig = {
  title: 'Theme',
  projectScoped: false,
  saveSpec: THEME_SPEC.set,
  listSpec: THEME_SPEC.list,
  listInput: {},
  newButtonLabel: '+ New theme',
  saveButtonLabel: 'Save theme',
  rowToDraft: themeRowToDraft,
  draftToInput: (draft) => themeDraftToInput(draft),
  emptyDraft: () => ({ id: '', title: '', base: 'sidebar', nav: '', accent: '', footer: '' }),
  validate: validateThemeDraft,
  faultMessages: {
    bad_base: "That isn't one of the built-in themes.",
    bad_accent: 'Use a colour like #2f6bdb.',
  },
  fields: [
    { name: 'title', label: 'Name', kind: 'text', placeholder: 'e.g. Docs' },
    {
      name: 'base',
      label: 'Starts from',
      kind: 'selectFromQuery',
      hint: 'A built-in theme. Its files are listed below; customize any of them.',
      optionsFrom: { spec: THEME_SPEC.bases, input: {}, valueField: 'key', labelField: 'name' },
    },
    { name: 'nav', label: 'Navigation', kind: 'select', options: THEME_NAV_OPTIONS },
    {
      name: 'accent',
      label: 'Accent colour',
      kind: 'text',
      placeholder: '#2f6bdb',
      hint: "Links and highlights. Blank keeps the theme's own.",
    },
    {
      name: 'footer',
      label: 'Footer',
      kind: 'textarea',
      placeholder: '© 2026 Example Ltd · [Contact](https://example.com/contact)',
      hint: 'Markdown, shown at the foot of every page.',
    },
    { name: 'portals', label: 'Used by', kind: 'readonly' },
  ],
};
