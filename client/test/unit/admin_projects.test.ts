/**
 * Unit coverage for the AdminProjectsScreen helpers + the project.stamp
 * handler codec.
 *
 * The vitest runner is node-only — the .svelte component itself is
 * exercised by a compile-smoke import (matches the pattern in
 * `admin_users.test.ts`). Logic lives in pure helpers so each branch
 * gets a direct unit test.
 *
 * Coverage targets (Gate 12 of FLOW_AND_SCREEN_KERNEL):
 *   1. `isTemplate` — boolean truth + missing-attribute default + string
 *      fallback.
 *   2. `projectTitle` — title attribute precedence; `#<id>` fallback.
 *   3. `applyProjectFilters` — the `showTemplates` toggle, the substring
 *      search, the two AND'd together.
 *   4. `validateStampName` — empty / whitespace rejection; trim semantics.
 *   5. `projectStamp` codec — encode + decode (incl. optional warnings).
 *   6. Compile-smoke import of the .svelte component.
 */

import { describe, expect, it } from 'vitest';

import { projectStamp } from '../../src/reg/handlers.js';
import type { CardWithAttrs } from '../../src/reg/types.js';
import {
  applyProjectFilters,
  errMsg,
  isTemplate,
  projectTitle,
  validateStampName,
} from '../../src/screens/admin/admin_projects_helpers.js';

/* -------------------------------------------------------------------------- */
/* Fixture builders                                                           */
/* -------------------------------------------------------------------------- */

function project(
  id: bigint,
  attributes: Record<string, unknown> = {},
): CardWithAttrs {
  return {
    id,
    card_type_id: 1n,
    card_type_name: 'project',
    phase: 'active',
    attributes,
  };
}

const TEMPLATE = project(1n, { title: 'Standard Project Template', is_template: true });
const REGULAR = project(2n, { title: 'Default Project' });
const REGULAR_EXPLICIT_FALSE = project(3n, { title: 'Other', is_template: false });
const ARRAY_OF_THREE: CardWithAttrs[] = [TEMPLATE, REGULAR, REGULAR_EXPLICIT_FALSE];

/* -------------------------------------------------------------------------- */
/* isTemplate                                                                 */
/* -------------------------------------------------------------------------- */

describe('isTemplate', () => {
  it.each<{
    label: string;
    card: CardWithAttrs;
    want: boolean;
  }>([
    { label: 'true → true', card: project(1n, { is_template: true }), want: true },
    { label: 'false → false', card: project(1n, { is_template: false }), want: false },
    { label: 'missing → false', card: project(1n, {}), want: false },
    { label: 'null → false', card: project(1n, { is_template: null }), want: false },
    { label: 'string "true" → true', card: project(1n, { is_template: 'true' }), want: true },
    { label: 'string "TRUE" → true', card: project(1n, { is_template: 'TRUE' }), want: true },
    { label: 'string "false" → false', card: project(1n, { is_template: 'false' }), want: false },
    { label: 'number 1 → false', card: project(1n, { is_template: 1 }), want: false },
  ])('$label', ({ card, want }) => {
    expect(isTemplate(card)).toBe(want);
  });
});

/* -------------------------------------------------------------------------- */
/* projectTitle                                                               */
/* -------------------------------------------------------------------------- */

describe('projectTitle', () => {
  it.each<{
    label: string;
    card: CardWithAttrs;
    want: string;
  }>([
    { label: 'title present', card: project(1n, { title: 'Acme' }), want: 'Acme' },
    { label: 'empty title → fallback', card: project(7n, { title: '' }), want: '#7' },
    { label: 'missing title → fallback', card: project(9n, {}), want: '#9' },
    { label: 'non-string title → fallback', card: project(11n, { title: 42 }), want: '#11' },
  ])('$label', ({ card, want }) => {
    expect(projectTitle(card)).toBe(want);
  });
});

/* -------------------------------------------------------------------------- */
/* applyProjectFilters                                                        */
/* -------------------------------------------------------------------------- */

describe('applyProjectFilters', () => {
  it('returns every project when search is empty and showTemplates=true', () => {
    const out = applyProjectFilters(ARRAY_OF_THREE, '', true);
    expect(out.map((p) => p.id)).toEqual([1n, 2n, 3n]);
  });

  it('hides template rows when showTemplates=false (default user-view)', () => {
    const out = applyProjectFilters(ARRAY_OF_THREE, '', false);
    expect(out.map((p) => p.id)).toEqual([2n, 3n]);
  });

  it('substring-matches title case-insensitively', () => {
    expect(applyProjectFilters(ARRAY_OF_THREE, 'default', true).map((p) => p.id)).toEqual([2n]);
    expect(applyProjectFilters(ARRAY_OF_THREE, 'DEFAULT', true).map((p) => p.id)).toEqual([2n]);
    expect(applyProjectFilters(ARRAY_OF_THREE, 't', true).map((p) => p.id)).toEqual([1n, 2n, 3n]);
  });

  it('combines showTemplates and search via AND', () => {
    // "standard" hits the template — only visible when showTemplates is on.
    expect(applyProjectFilters(ARRAY_OF_THREE, 'standard', false).map((p) => p.id)).toEqual([]);
    expect(applyProjectFilters(ARRAY_OF_THREE, 'standard', true).map((p) => p.id)).toEqual([1n]);
  });

  it('whitespace-only search behaves like empty search', () => {
    expect(applyProjectFilters(ARRAY_OF_THREE, '   ', true).map((p) => p.id)).toEqual([1n, 2n, 3n]);
  });

  it('does not mutate the input list', () => {
    const before = ARRAY_OF_THREE.map((p) => p.id);
    applyProjectFilters(ARRAY_OF_THREE, 't', false);
    expect(ARRAY_OF_THREE.map((p) => p.id)).toEqual(before);
  });

  it('treats projects without an is_template attribute as non-template', () => {
    const bare = project(99n, { title: 'Bare' });
    // showTemplates=false should keep the bare row even though it has no
    // attribute_value row for is_template at all — matches the server's
    // `is_template != true` NOT-EXISTS semantics.
    expect(applyProjectFilters([bare], '', false).map((p) => p.id)).toEqual([99n]);
  });
});

/* -------------------------------------------------------------------------- */
/* validateStampName                                                          */
/* -------------------------------------------------------------------------- */

describe('validateStampName', () => {
  it('accepts a plain name and trims surrounding whitespace', () => {
    expect(validateStampName('  Acme Co  ')).toEqual({ ok: true, name: 'Acme Co' });
  });

  it('rejects an empty string', () => {
    const out = validateStampName('');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/required/i);
  });

  it('rejects whitespace-only input', () => {
    const out = validateStampName('   \t\n');
    expect(out.ok).toBe(false);
  });

  it('preserves internal whitespace in the trimmed name', () => {
    expect(validateStampName('a b c')).toEqual({ ok: true, name: 'a b c' });
  });
});

/* -------------------------------------------------------------------------- */
/* errMsg                                                                     */
/* -------------------------------------------------------------------------- */

describe('errMsg', () => {
  it('extracts .message from an Error', () => {
    expect(errMsg(new Error('boom'))).toBe('boom');
  });

  it('falls back to String() for non-Error values', () => {
    expect(errMsg('hi')).toBe('hi');
    expect(errMsg({ x: 1 })).toBe('[object Object]');
    expect(errMsg(42)).toBe('42');
  });
});

/* -------------------------------------------------------------------------- */
/* project.stamp codec                                                        */
/* -------------------------------------------------------------------------- */

describe('project.stamp codec', () => {
  it('encodes the templateProjectId and name into snake_case', () => {
    const encoded = projectStamp.encode({
      templateProjectId: 42n,
      name: 'New Project',
    }) as Record<string, unknown>;
    expect(encoded).toEqual({
      template_project_id: 42n,
      name: 'New Project',
    });
  });

  it('decodes a server response into the typed output', () => {
    const out = projectStamp.decode({ new_project_id: 99n });
    expect(out).toEqual({ new_project_id: 99n });
    expect(out.warnings).toBeUndefined();
  });

  it('decodes warnings when present', () => {
    const out = projectStamp.decode({
      new_project_id: 7n,
      warnings: ['template_empty: nothing copied'],
    });
    expect(out.new_project_id).toBe(7n);
    expect(out.warnings).toEqual(['template_empty: nothing copied']);
  });

  it('omits warnings when the server emits an empty list', () => {
    const out = projectStamp.decode({ new_project_id: 7n, warnings: [] });
    expect(out.warnings).toBeUndefined();
  });

  it('exposes the registered endpoint / action pair', () => {
    expect(projectStamp.endpoint).toBe('project');
    expect(projectStamp.action).toBe('stamp');
  });
});

/* -------------------------------------------------------------------------- */
/* Component compile-smoke                                                    */
/* -------------------------------------------------------------------------- */

describe('AdminProjectsScreen imports', () => {
  it('the .svelte component module loads without throwing', async () => {
    const m = await import('../../src/screens/admin/AdminProjectsScreen.svelte');
    expect(m.default).toBeDefined();
  });
});
