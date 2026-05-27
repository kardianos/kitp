/**
 * AttachmentsSection (#36) — list / upload / download / delete / thumbnails +
 * gallery, on a REAL DOM (jsdom). The control composes the upload service + the
 * blob fetcher; both are INJECTED with mocks so jsdom issues no real network.
 *
 * Coverage:
 *   - `attachment.list` loads + renders rows (newest-first) with size + a delete
 *     button; an image row requests its thumbnail via the injected fetcher;
 *   - the delete button fires `attachment.delete { id }` + drops the row
 *     optimistically;
 *   - a picked File runs the full upload pipeline (mock chunk sink) and the new
 *     attachment row appears;
 *   - clicking an image row opens the gallery overlay (fetches the inline view),
 *     ←/→ pages, Esc closes (object URLs created + revoked).
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom, flushMicrotasks } from './ui-dom-setup.mjs';

let M;

const CARD_ID = 54n;

/** Stub URL.createObjectURL / revokeObjectURL (jsdom has neither). */
let objUrlSeq = 0;
const revoked = [];
function installObjectUrlStub() {
  objUrlSeq = 0;
  revoked.length = 0;
  globalThis.URL.createObjectURL = () => `blob:mock/${++objUrlSeq}`;
  globalThis.URL.revokeObjectURL = (u) => revoked.push(u);
}

before(async () => {
  installUiDom();
  installObjectUrlStub();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerAttachmentsSection();
});

beforeEach(() => {
  document.body.replaceChildren();
  installObjectUrlStub();
});

function sha256Hex(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function attachmentWire(id, filename, mime, size, kind, thumb = '0') {
  return {
    id: String(id),
    card_id: String(CARD_ID),
    file_id: String(1000 + Number(id)),
    filename,
    mime_type: mime,
    size_bytes: size,
    created_at: '2026-05-24T12:00:00.000Z',
    thumb_file_id: thumb,
    kind,
  };
}

/** Transport serving attachment.list/.delete + the upload pipeline endpoints. */
function attachmentsHarness(opts = {}) {
  const deletes = [];
  const store = (opts.rows ?? []).slice();
  const seeded = new Set();

  function respond(sr) {
    const k = `${sr.endpoint}.${sr.action}`;
    const data = sr.data ?? {};
    if (k === 'attachment.list') {
      return { id: sr.id, ok: true, data: { rows: store.slice() } };
    }
    if (k === 'attachment.delete') {
      deletes.push(data);
      const idx = store.findIndex((r) => r.id === String(data.id));
      if (idx >= 0) store.splice(idx, 1);
      return { id: sr.id, ok: true, data: { ok: true } };
    }
    if (k === 'cas.missing_chunks') {
      const missing = (data.addresses ?? []).filter((a) => !seeded.has(a));
      return { id: sr.id, ok: true, data: { missing } };
    }
    if (k === 'file.create') {
      return {
        id: sr.id,
        ok: true,
        data: { id: '7001', filename: data.filename, mime_type: data.mime_type, size_bytes: 12 },
      };
    }
    if (k === 'attachment.create') {
      const row = attachmentWire(77, 'new.png', 'image/png', 12, 'image', '0');
      store.unshift(row);
      return { id: sr.id, ok: true, data: row };
    }
    return { id: sr.id, ok: false, error: { code: 'unknown', message: `mock has no ${k}` } };
  }

  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      return { status: 200, text: JSON.stringify({ subresponses: req.subrequests.map(respond) }) };
    },
  };
  const postChunk = (blob, onDone) => {
    void (async () => {
      const buf = new Uint8Array(await blob.arrayBuffer());
      const address = sha256Hex(buf);
      seeded.add(address);
      onDone({ address, sizeBytes: buf.length });
    })();
  };
  // Records the URLs the control fetched blobs for (thumb / view / download).
  const fetched = [];
  const fetchBlob = (url, onDone) => {
    fetched.push(url);
    onDone(new globalThis.Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
  };
  return { transport, postChunk, fetchBlob, deletes, fetched, store };
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerAttachmentSpecs(api);
  return { dispatcher, api };
}

async function settle(dispatcher) {
  for (let i = 0; i < 6; i++) await dispatcher.flushNow();
  await flushMicrotasks();
  for (let i = 0; i < 4; i++) await dispatcher.flushNow();
  await flushMicrotasks();
}

function mount(api, h, previewHost) {
  const tree = new M.TreeNode({}, []);
  const ctx = { api, tree };
  const cfg = {
    type: 'AttachmentsSection',
    cardId: String(CARD_ID),
    postChunk: h.postChunk,
    fetchBlob: h.fetchBlob,
    chunkBytes: 4,
    ...(previewHost ? { previewHost } : {}),
  };
  const c = M.Control.New('AttachmentsSection', cfg, ctx);
  c.mount(document.createElement('div'));
  document.body.appendChild(c.el);
  return c;
}

/* -------------------------------------------------------------------------- */

test('AttachmentsSection: attachment.list renders rows + an image requests its thumbnail', async () => {
  const h = attachmentsHarness({
    rows: [
      attachmentWire(2, 'spec.pdf', 'application/pdf', 2048, 'pdf'),
      attachmentWire(1, 'photo.png', 'image/png', 4096, 'image', '500'),
    ],
  });
  const { dispatcher, api } = bootApi(h.transport);
  const c = mount(api, h);
  await settle(dispatcher);

  const rows = [...c.el.querySelectorAll('[data-attachment-row]')];
  assert.equal(rows.length, 2, 'two attachment rows');
  assert.equal(rows[0].dataset.attachmentRow, '2', 'newest-first preserved from server order');
  // The image row (thumb_file_id != 0) fetched its thumbnail.
  assert.ok(
    h.fetched.some((u) => u.includes('/attachment/1/thumb')),
    'image thumbnail fetched',
  );
  // Count badge shows the row count.
  assert.equal(c.el.querySelector('[data-attachments-count]').textContent, '(2)');
});

test('AttachmentsSection: paints a main-column preview strip of image + PDF tiles', async () => {
  const h = attachmentsHarness({
    rows: [
      attachmentWire(2, 'spec.pdf', 'application/pdf', 2048, 'pdf'),
      attachmentWire(1, 'photo.png', 'image/png', 4096, 'image', '500'),
      attachmentWire(3, 'notes.txt', 'text/plain', 100, 'other'),
    ],
  });
  const { dispatcher, api } = bootApi(h.transport);
  const previewHost = document.createElement('section');
  document.body.appendChild(previewHost);
  mount(api, h, previewHost);
  await settle(dispatcher);

  // Only image + PDF are previewable (the .txt row stays in the list only).
  const tiles = [...previewHost.querySelectorAll('[data-attachment-tile]')];
  assert.equal(tiles.length, 2, 'image + PDF tiles only');
  assert.deepEqual(
    tiles.map((t) => t.dataset.attachmentTile),
    ['2', '1'],
    'tiles in list order (pdf then image)',
  );
  assert.notEqual(previewHost.style.display, 'none', 'strip visible when previewable');

  // The image tile fetched its thumbnail (coalesced with the list row → one URL).
  assert.ok(
    h.fetched.some((u) => u.includes('/attachment/1/thumb')),
    'image tile thumbnail fetched',
  );
  assert.equal(
    h.fetched.filter((u) => u.includes('/attachment/1/thumb')).length,
    1,
    'thumb fetch coalesced across strip tile + list row (single fetch)',
  );
  // The PDF tile shows the PDF glyph (no server thumb for PDFs).
  const pdfGlyph = previewHost.querySelector('[data-attachment-tile="2"] .attachments-strip__glyph');
  assert.ok(pdfGlyph && pdfGlyph.textContent.includes('PDF'), 'PDF tile shows the PDF glyph');
});

test('AttachmentsSection: the preview strip hides when nothing is previewable', async () => {
  const h = attachmentsHarness({
    rows: [attachmentWire(3, 'notes.txt', 'text/plain', 100, 'other')],
  });
  const { dispatcher, api } = bootApi(h.transport);
  const previewHost = document.createElement('section');
  mount(api, h, previewHost);
  await settle(dispatcher);

  assert.equal(previewHost.querySelectorAll('[data-attachment-tile]').length, 0, 'no tiles');
  assert.equal(previewHost.style.display, 'none', 'strip hidden');
});

test('AttachmentsSection: clicking a preview tile opens the gallery', async () => {
  const h = attachmentsHarness({
    rows: [attachmentWire(1, 'photo.png', 'image/png', 4096, 'image', '500')],
  });
  const { dispatcher, api } = bootApi(h.transport);
  const previewHost = document.createElement('section');
  document.body.appendChild(previewHost);
  mount(api, h, previewHost);
  await settle(dispatcher);

  const tile = previewHost.querySelector('[data-attachment-tile="1"]');
  tile.click();
  await settle(dispatcher);
  assert.ok(document.querySelector('[data-attachments-gallery]'), 'gallery overlay opened from the tile');
});

test('AttachmentsSection: delete fires attachment.delete and drops the row optimistically', async () => {
  const h = attachmentsHarness({
    rows: [attachmentWire(1, 'photo.png', 'image/png', 4096, 'image', '500')],
  });
  const { dispatcher, api } = bootApi(h.transport);
  const c = mount(api, h);
  await settle(dispatcher);

  const del = c.el.querySelector('[data-attachment-delete="1"]');
  assert.ok(del, 'delete button present');
  del.click();
  // Optimistic: row gone immediately (before the round-trip).
  assert.equal(c.el.querySelectorAll('[data-attachment-row]').length, 0, 'row removed optimistically');
  await settle(dispatcher);

  assert.equal(h.deletes.length, 1, 'attachment.delete fired');
  assert.equal(h.deletes[0].id.toString(), '1', 'deleted the right id');
});

test('AttachmentsSection: a picked File uploads + the new attachment appears', async () => {
  const h = attachmentsHarness({ rows: [] });
  const { dispatcher, api } = bootApi(h.transport);
  const c = mount(api, h);
  await settle(dispatcher);

  // Drive handleFiles via the hidden file input's change (simulate a pick).
  const file = new globalThis.File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'new.png', {
    type: 'image/png',
  });
  const input = c.el.querySelector('[data-attachments-input]');
  // jsdom: define files on the input then dispatch change.
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }));
  await settle(dispatcher);

  const rows = [...c.el.querySelectorAll('[data-attachment-row]')];
  assert.ok(rows.length >= 1, 'the uploaded attachment row appears');
  assert.ok(
    [...c.el.querySelectorAll('[data-attachment-name]')].some((n) => n.textContent === 'new.png'),
    'new.png is listed',
  );
});

test('AttachmentsSection: clicking an image opens the gallery; ←/→ page; Esc closes', async () => {
  const h = attachmentsHarness({
    rows: [
      attachmentWire(2, 'b.png', 'image/png', 10, 'image', '600'),
      attachmentWire(1, 'a.png', 'image/png', 10, 'image', '500'),
    ],
  });
  const { dispatcher, api } = bootApi(h.transport);
  const c = mount(api, h);
  await settle(dispatcher);

  const thumb = c.el.querySelector('[data-attachment-thumb="2"]');
  assert.ok(thumb, 'image thumb is a viewable button');
  thumb.click();
  await flushMicrotasks();

  const gallery = document.querySelector('[data-attachments-gallery]');
  assert.ok(gallery, 'gallery overlay opened');
  // Fetched the inline /view bytes for attachment 2.
  assert.ok(h.fetched.some((u) => u.includes('/attachment/2/view')), 'view fetched');
  let caption = gallery.querySelector('[data-gallery-caption]').textContent;
  assert.match(caption, /b\.png \(1\/2\)/, 'caption shows current + count');

  // → pages to the next viewable (a.png).
  gallery.dispatchEvent(
    new globalThis.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
  );
  await flushMicrotasks();
  caption = document.querySelector('[data-gallery-caption]').textContent;
  assert.match(caption, /a\.png \(2\/2\)/, 'paged to the next image');

  // Esc closes the gallery + revokes its object URL.
  const revokedBefore = revoked.length;
  document.querySelector('[data-attachments-gallery]').dispatchEvent(
    new globalThis.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  await flushMicrotasks();
  assert.equal(document.querySelector('[data-attachments-gallery]'), null, 'gallery closed');
  assert.ok(revoked.length > revokedBefore, 'a view object URL was revoked on close');
});
