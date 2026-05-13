/**
 * Coverage for the route table introduced in Gate 9
 * (FLOW_AND_SCREEN_KERNEL): the single `/project/:id/screen/:slug` shape
 * supersedes the old per-layout routes. The interesting cases:
 *
 *   - `matchRoute('/inbox')` returns null (the alias is gone).
 *   - `/project/:id` matches the redirect entry; `matchRoute` returns it
 *     so the Router can interpolate and bounce to the screen URL.
 *   - `/project/:id/screen/:slug` captures both params.
 *   - `interpolatePath` substitutes `:name` segments from the params
 *     record (the bridge that lets a redirect `redirectTo` carry
 *     `:name` placeholders).
 *   - `screenUrl` rebuilds the canonical URL so callers (NavSidebar,
 *     chord registrations, e2e tests) share one source of truth.
 */

import { describe, expect, it } from 'vitest';

import {
  interpolatePath,
  matchRoute,
  screenUrl,
} from '../../src/routing/routes.js';

describe('matchRoute (Gate 9 routes)', () => {
  it('returns null for the removed /inbox path', () => {
    expect(matchRoute('/inbox')).toBeNull();
  });

  it('returns null for the removed /grid path', () => {
    expect(matchRoute('/grid')).toBeNull();
  });

  it('returns null for the removed /kanban path', () => {
    expect(matchRoute('/kanban')).toBeNull();
  });

  it('still matches /projects (top-level, not a screen)', () => {
    const m = matchRoute('/projects');
    expect(m).not.toBeNull();
    expect(m?.route.path).toBe('/projects');
    expect(m?.params).toEqual({});
  });

  it('matches /project/:id as a redirect entry', () => {
    const m = matchRoute('/project/42');
    expect(m).not.toBeNull();
    expect(m?.route.path).toBe('/project/:id');
    expect(m?.route.redirectTo).toBe('/project/:id/screen/project');
    expect(m?.params).toEqual({ id: '42' });
  });

  it('matches /project/:id/screen/:slug and captures both params', () => {
    const m = matchRoute('/project/42/screen/inbox');
    expect(m).not.toBeNull();
    expect(m?.route.path).toBe('/project/:id/screen/:slug');
    expect(m?.params).toEqual({ id: '42', slug: 'inbox' });
  });

  it('captures slug=project for the project-detail screen URL', () => {
    const m = matchRoute('/project/7/screen/project');
    expect(m?.params).toEqual({ id: '7', slug: 'project' });
  });

  it('captures unknown slugs (resolution is the screen-card lookup, not the router)', () => {
    const m = matchRoute('/project/7/screen/nope');
    expect(m?.params).toEqual({ id: '7', slug: 'nope' });
  });
});

describe('interpolatePath', () => {
  it('substitutes :name segments from the params record', () => {
    expect(
      interpolatePath('/project/:id/screen/project', { id: '42' }),
    ).toBe('/project/42/screen/project');
  });

  it('leaves unknown :name segments verbatim (loud over silent)', () => {
    expect(
      interpolatePath('/project/:id/screen/:slug', { id: '7' }),
    ).toBe('/project/7/screen/:slug');
  });

  it('url-encodes substituted values', () => {
    expect(
      interpolatePath('/project/:id', { id: 'a b' }),
    ).toBe('/project/a%20b');
  });

  it('returns the template unchanged when there are no :name segments', () => {
    expect(interpolatePath('/projects', { ignored: 'x' })).toBe('/projects');
  });
});

describe('screenUrl', () => {
  it('builds /project/<id>/screen/<slug> from a bigint id', () => {
    expect(screenUrl(42n, 'inbox')).toBe('/project/42/screen/inbox');
  });

  it('accepts a string id (admin / e2e callers)', () => {
    expect(screenUrl('7', 'kanban')).toBe('/project/7/screen/kanban');
  });
});
