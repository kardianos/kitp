/**
 * Unit coverage for the project-export client helper. We exercise the
 * fetch path, Authorization header, and Content-Disposition parsing
 * via a stub fetch — no jsdom required.
 */

import { describe, expect, it, vi } from 'vitest';

import { AuthState } from '../../src/auth/auth_state.svelte';
import {
  downloadProjectExportCsv,
  downloadProjectExportZip,
  parseAttachmentFilename,
} from '../../src/screens/admin/project_export.js';

/* -------------------------------------------------------------------------- */
/* parseAttachmentFilename                                                    */
/* -------------------------------------------------------------------------- */

describe('parseAttachmentFilename', () => {
  it('reads the filename out of a quoted header', () => {
    expect(parseAttachmentFilename('attachment; filename="project-demo-7.csv"'))
      .toBe('project-demo-7.csv');
  });

  it('returns null for a missing header', () => {
    expect(parseAttachmentFilename(null)).toBeNull();
    expect(parseAttachmentFilename('')).toBeNull();
  });

  it('falls back to the unquoted form', () => {
    expect(parseAttachmentFilename('attachment; filename=foo.csv'))
      .toBe('foo.csv');
  });

  it('returns null when no filename token is present', () => {
    expect(parseAttachmentFilename('attachment')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* downloadProjectExportCsv                                                   */
/* -------------------------------------------------------------------------- */

// JSDOM is not configured in this suite — the helper touches `document` and
// `URL.createObjectURL`, so the tests below stub the two browser globals
// the helper needs. We snapshot/restore around each case to keep the
// vitest harness clean for other tests in the file.
function withBrowserGlobals(): { clicks: string[]; restore: () => void } {
  const clicks: string[] = [];
  const origDocument = (globalThis as any).document;
  const origURL = (globalThis as any).URL;

  const anchor: any = {
    href: '',
    download: '',
    rel: '',
    click() { clicks.push(`${this.href}|${this.download}`); },
    remove() {},
  };
  const fakeDocument = {
    createElement: vi.fn(() => anchor),
    body: { appendChild: vi.fn() },
  };
  const fakeURL = {
    createObjectURL: vi.fn(() => 'blob:fake-url'),
    revokeObjectURL: vi.fn(),
  };
  (globalThis as any).document = fakeDocument;
  (globalThis as any).URL = fakeURL;
  return {
    clicks,
    restore() {
      (globalThis as any).document = origDocument;
      (globalThis as any).URL = origURL;
    },
  };
}

describe('downloadProjectExportCsv', () => {
  it('issues a same-origin GET and triggers a download (BFF cookie carries auth)', async () => {
    const auth = new AuthState();
    auth.setFromMe({ user_id: '2', display_name: 'Alice' });

    const fetchImpl = vi.fn(async () => new Response('id,title\n1,T\n', {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="project-demo-7.csv"',
      },
    }));
    const env = withBrowserGlobals();
    try {
      await downloadProjectExportCsv({
        projectId: 7n,
        includeDeleted: false,
        authState: auth,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
    } finally {
      env.restore();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain('/api/v1/project/7/export.csv');
    expect(call[1].credentials).toBe('same-origin');
    expect(call[1].headers).toBeUndefined();
    expect(env.clicks).toHaveLength(1);
    expect(env.clicks[0]).toContain('project-demo-7.csv');
  });

  it('appends include_deleted=1 when the toggle is on', async () => {
    const fetchImpl = vi.fn(async () => new Response('id\n', {
      status: 200,
      headers: { 'Content-Type': 'text/csv' },
    }));
    const env = withBrowserGlobals();
    try {
      await downloadProjectExportCsv({
        projectId: 12n,
        includeDeleted: true,
        authState: null,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
    } finally {
      env.restore();
    }
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain('include_deleted=1');
    // Cookie-only: no Authorization header is emitted regardless of
    // whether the caller had an AuthState handy.
    expect(call[1].headers).toBeUndefined();
    expect(call[1].credentials).toBe('same-origin');
  });

  it('throws on non-2xx responses', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"not authorized"}', {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(
      downloadProjectExportCsv({
        projectId: 1n,
        includeDeleted: false,
        authState: null,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/export failed/);
  });
});

/* -------------------------------------------------------------------------- */
/* downloadProjectExportZip                                                   */
/* -------------------------------------------------------------------------- */

describe('downloadProjectExportZip', () => {
  it('sends the full-zip URL with the three toggle params and triggers a download', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([0x50, 0x4b]), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="project-demo-9.zip"',
      },
    }));
    const env = withBrowserGlobals();
    try {
      await downloadProjectExportZip({
        projectId: 9n,
        includeDeleted: true,
        includeAttachments: true,
        includeActivity: true,
        authState: null,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
    } finally {
      env.restore();
    }
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain('/api/v1/project/9/export.zip');
    expect(call[0]).toContain('include_deleted=1');
    expect(call[0]).toContain('include_attachments=1');
    expect(call[0]).toContain('include_activity=1');
    expect(env.clicks).toHaveLength(1);
    expect(env.clicks[0]).toContain('project-demo-9.zip');
  });

  it('omits flags that are false', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([]), {
      status: 200,
      headers: { 'Content-Type': 'application/zip' },
    }));
    const env = withBrowserGlobals();
    try {
      await downloadProjectExportZip({
        projectId: 1n,
        includeDeleted: false,
        includeAttachments: false,
        includeActivity: false,
        authState: null,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
    } finally {
      env.restore();
    }
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).not.toContain('include_deleted');
    expect(call[0]).not.toContain('include_attachments');
    expect(call[0]).not.toContain('include_activity');
  });
});
