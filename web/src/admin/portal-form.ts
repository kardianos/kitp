/**
 * Portals screen config for the generic RecordForm — a portal (a published
 * site) expressed as DATA: a field table, row→draft / draft→input mappers and
 * two record actions (Rebuild, Preview).
 *
 * A portal has a title, a root page (its Home — the page tree below it is the
 * site), an optional host name for the public listener, a public flag (off =
 * preview only, e.g. QA), a theme (none = the built-in Side menu theme) and
 * "Show in kitp" (the site listed in kitp's sidebar, shown in the content
 * area). WHICH pages it shows is set on statuses
 * (publishes_to, in the Values screen); this form just lists them, plus the
 * active build's state (pages, built at, pending rebuild, warnings, last
 * error). Portals are global, so the form isn't bound to the active project.
 */

import type { RecordFormScreenConfig } from './record-form.js';
import { PORTAL_SPEC, THEME_SPEC, previewUrl } from '../bundles/specs.js';
import { formatLocalDateTime } from '../util/datetime.js';


function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'bigint') return v.toString();
  return String(v);
}

function idOrEmpty(v: unknown): string {
  const s = str(v);
  return /^\d+$/.test(s) && s !== '0' ? s : '';
}

/** The read-only build summary line for a portal row. */
export function portalBuildSummary(row: Record<string, unknown>): string {
  const built = str(row['builtAt']);
  const pages = Number(row['pageCount'] ?? 0);
  const parts: string[] = [];
  if (built === '') parts.push('Not built yet');
  else parts.push(`${pages} page${pages === 1 ? '' : 's'} · built ${formatLocalDateTime(built)}`);
  if (row['dirty'] === true) parts.push('rebuild pending');
  return parts.join(' · ');
}

/** A decoded portal.list row → the form draft. */
export function portalRowToDraft(row: Record<string, unknown>): Record<string, unknown> {
  const statuses = Array.isArray(row['statuses']) ? (row['statuses'] as unknown[]).map(str) : [];
  const warnings = Array.isArray(row['warnings']) ? (row['warnings'] as unknown[]).map(str) : [];
  return {
    id: idOrEmpty(row['id']),
    title: str(row['title']),
    host: str(row['host']),
    public: row['public'] === true,
    internal: row['internal'] === true,
    themeId: idOrEmpty(row['themeId']),
    rootPageId: idOrEmpty(row['rootPageId']),
    statuses:
      statuses.length > 0
        ? statuses.join(', ')
        : 'No status publishes here yet — set "Publishes to" on a status (Values).',
    build: portalBuildSummary(row),
    warnings: warnings.join(' · '),
    lastError: str(row['lastError']),
  };
}

/** The form draft → portal.set input. Every field is sent, so the server
 *  writes exactly what the form shows (root page '' clears it). */
export function portalDraftToInput(draft: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {
    title: str(draft['title']).trim(),
    host: str(draft['host']).trim().toLowerCase(),
    public: draft['public'] === true,
    internal: draft['internal'] === true,
    rootPageId: BigInt(idOrEmpty(draft['rootPageId']) || '0'),
    themeId: BigInt(idOrEmpty(draft['themeId']) || '0'),
  };
  const id = idOrEmpty(draft['id']);
  if (id !== '') input['id'] = BigInt(id);
  return input;
}

export const PORTAL_FORM: RecordFormScreenConfig = {
  title: 'Portal',
  projectScoped: false,
  saveSpec: PORTAL_SPEC.set,
  listSpec: PORTAL_SPEC.list,
  listInput: {},
  newButtonLabel: '+ New portal',
  saveButtonLabel: 'Save portal',
  rowToDraft: portalRowToDraft,
  draftToInput: (draft) => portalDraftToInput(draft),
  emptyDraft: () => ({ id: '', title: '', host: '', public: false, internal: false, rootPageId: '', themeId: '' }),
  validate: (draft): Record<string, string> =>
    str(draft['title']).trim() === '' ? { title: 'A portal needs a title.' } : {},
  faultMessages: {
    host_taken: 'Another portal already serves that host.',
    root_in_template: 'That page belongs to a template. Choose a page in a live project.',
    theme_not_found: 'That theme was deleted. Choose another.',
  },
  fields: [
    { name: 'title', label: 'Title', kind: 'text', placeholder: 'e.g. Docs (PROD)' },
    {
      name: 'rootPageId',
      label: 'Root page',
      kind: 'selectFromQuery',
      hint: 'The site is this page and every page under it.',
      // portal.root_pages labels each page with its project ('Docs › Home')
      // and leaves out template projects, whose pages never publish.
      optionsFrom: {
        spec: PORTAL_SPEC.rootPages,
        input: {},
        valueField: 'id',
        labelField: 'label',
        placeholderLabel: 'Choose a page…',
      },
    },
    {
      name: 'host',
      label: 'Public host',
      kind: 'text',
      placeholder: 'docs.example.com',
      hint: 'The host name the public listener serves this site on. Blank for none.',
    },
    {
      name: 'public',
      label: 'Serve publicly',
      kind: 'checkbox',
      hint: 'Off keeps the portal preview-only (signed-in users), e.g. for QA.',
    },
    {
      name: 'internal',
      label: 'Show in kitp',
      kind: 'checkbox',
      hint: "List the site in kitp's sidebar and show it inside kitp, to people who can see its root page.",
    },
    {
      name: 'themeId',
      label: 'Theme',
      kind: 'selectFromQuery',
      hint: 'How the site looks. Make and change themes in Admin → Themes.',
      optionsFrom: {
        spec: THEME_SPEC.list,
        input: {},
        valueField: 'id',
        labelField: 'title',
        placeholderLabel: 'Side menu (built in)',
      },
    },
    { name: 'statuses', label: 'Published by', kind: 'readonly' },
    { name: 'build', label: 'Build', kind: 'readonly' },
    { name: 'warnings', label: 'Warnings', kind: 'readonly', showWhen: { field: 'warnings', notIn: [''] } },
    { name: 'lastError', label: 'Last error', kind: 'readonly', showWhen: { field: 'lastError', notIn: [''] } },
  ],
  recordActions: [
    {
      label: 'Rebuild',
      spec: PORTAL_SPEC.rebuild,
      toInput: (draft) => ({ id: BigInt(idOrEmpty(draft['id']) || '0') }),
    },
    {
      label: 'Preview',
      href: (draft) => {
        const id = idOrEmpty(draft['id']);
        return id === '' ? null : previewUrl(BigInt(id));
      },
    },
  ],
};
