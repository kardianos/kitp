/**
 * Smoke coverage for the ScreenHost dispatch entry. Vitest runs
 * node-only so we exercise the component's module-load path
 * (compilation + every import resolves) rather than mounting it.
 *
 * The real-DOM coverage of the layout dispatch lands with the
 * e2e journey suite; here we just confirm the component compiles
 * cleanly after the gate-9 rename.
 */

import { describe, expect, it } from 'vitest';

describe('ScreenHost smoke import', () => {
  it('module loads', async () => {
    const m = await import('../../src/screens/ScreenHost.svelte');
    expect(m.default).toBeDefined();
  });
});

describe('layout body imports (post-rename)', () => {
  it.each<{ name: string; path: string }>([
    { name: 'InboxLayout', path: '../../src/screens/InboxLayout.svelte' },
    { name: 'GridLayout', path: '../../src/screens/GridLayout.svelte' },
    { name: 'KanbanLayout', path: '../../src/screens/KanbanLayout.svelte' },
    { name: 'ProjectLayout', path: '../../src/screens/ProjectLayout.svelte' },
  ])('$name loads', async ({ path }) => {
    const m = await import(path);
    expect(m.default).toBeDefined();
  });
});
