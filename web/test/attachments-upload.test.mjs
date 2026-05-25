/**
 * Attachment upload pipeline (#36) — the SHA-256-chunk → cas.missing_chunks
 * preflight → raw chunk POST → file.create + attachment.create service.
 *
 * Runs WITHOUT a DOM: the upload service is a pure callback API over the batch
 * dispatcher (mock transport) + an injected chunk-POST sink (an in-memory
 * sha256 store). Node 20 provides `crypto.subtle.digest` + `File`/`Blob`
 * globally, which is all the pipeline touches.
 *
 * Coverage:
 *   - the file is sliced + SHA-256-hashed per chunk;
 *   - `cas.missing_chunks` is preflighted with the deduped address set;
 *   - ONLY the missing chunks are POSTed (an already-stored chunk ships zero
 *     bytes); the posted addresses match the client-side hashes;
 *   - then `file.create` (with the full chunk list) + `attachment.create` fire,
 *     in that order, and the committed attachment row reaches `onDone`;
 *   - progress is surfaced through the callback (hashing → uploading → saving),
 *     and the final loaded count equals the file size.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom } from './ui-dom-setup.mjs';

let M;

before(async () => {
  // The app barrel pulls in the markdown sink (DOMPurify), which registers a
  // sanitize hook at module eval and needs a real DOM — install jsdom even
  // though the upload service itself is DOM-free (File/Blob/crypto.subtle are
  // Node 20 globals).
  installUiDom();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
});

const CARD_ID = 54n;

/** sha256 hex of bytes — the reference the server (mock) computes. */
function sha256Hex(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/**
 * A batch transport + a chunk sink modelling a CAS store. The store is seeded
 * with `seededAddresses` so the preflight reports the rest as missing. Records
 * every file.create / attachment.create input + every chunk POST.
 */
function uploadHarness(opts = {}) {
  const seeded = new Set(opts.seededAddresses ?? []);
  const posted = []; // { address, bytes }
  const fileCreates = [];
  const attachmentCreates = [];
  const missingChunksCalls = [];

  function respond(sr) {
    const k = `${sr.endpoint}.${sr.action}`;
    const data = sr.data ?? {};
    if (k === 'cas.missing_chunks') {
      missingChunksCalls.push(data);
      const missing = (data.addresses ?? []).filter((a) => !seeded.has(a));
      return { id: sr.id, ok: true, data: { missing } };
    }
    if (k === 'file.create') {
      fileCreates.push(data);
      return {
        id: sr.id,
        ok: true,
        data: {
          id: '7001',
          filename: data.filename,
          mime_type: data.mime_type,
          size_bytes: (data.chunks ?? []).reduce((a, c) => a + Number(c.size_bytes), 0),
        },
      };
    }
    if (k === 'attachment.create') {
      attachmentCreates.push(data);
      return {
        id: sr.id,
        ok: true,
        data: {
          id: '9001',
          card_id: data.card_id,
          file_id: data.file_id,
          filename: 'report.png',
          mime_type: 'image/png',
          size_bytes: 12,
          thumb_file_id: '0',
          kind: 'image',
        },
      };
    }
    return { id: sr.id, ok: false, error: { code: 'unknown', message: `mock has no ${k}` } };
  }

  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => respond(sr));
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };

  // The injected chunk-POST sink: hash the bytes, store the address, ack it
  // (mirrors POST /api/v1/cas/chunk → { address, size_bytes }).
  const postChunk = (blob, onDone, onError) => {
    void (async () => {
      try {
        const buf = new Uint8Array(await blob.arrayBuffer());
        const address = sha256Hex(buf);
        seeded.add(address);
        posted.push({ address, bytes: buf.length });
        onDone({ address, sizeBytes: buf.length });
      } catch (e) {
        onError(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  };

  return { transport, postChunk, posted, fileCreates, attachmentCreates, missingChunksCalls };
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport, schedule: (cb) => cb() });
  const api = new M.Api(dispatcher);
  M.registerAttachmentSpecs(api);
  return { dispatcher, api };
}

/** Run the callback-surface upload to completion, resolving onDone/onError. */
function runUpload(api, file, cfg) {
  return new Promise((resolve, reject) => {
    const progress = [];
    M.uploadFile(api, CARD_ID, file, {
      ...cfg,
      onProgress: (p) => progress.push(p),
      onDone: (row) => resolve({ row, progress }),
      onError: (e) => reject(e),
    });
  });
}

/* -------------------------------------------------------------------------- */

test('upload: hashes, preflights, POSTs only missing chunks, then file+attachment create', async () => {
  // 3 chunks of 4 bytes each (chunkBytes=4) over a 12-byte file.
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const file = new File([bytes], 'report.png', { type: 'image/png' });

  // Pre-seed the SECOND chunk's address so the preflight reports it present.
  const chunk1Addr = sha256Hex(bytes.slice(4, 8));
  const h = uploadHarness({ seededAddresses: [chunk1Addr] });
  const { api } = bootApi(h.transport);

  const { row, progress } = await runUpload(api, file, { chunkBytes: 4, postChunk: h.postChunk });

  // Preflight got the deduped address set (3 distinct chunks here).
  assert.equal(h.missingChunksCalls.length, 1, 'one cas.missing_chunks preflight');
  assert.equal(h.missingChunksCalls[0].addresses.length, 3, 'all 3 chunk addresses preflighted');

  // Only the 2 MISSING chunks were POSTed (the seeded one shipped zero bytes).
  assert.equal(h.posted.length, 2, 'only missing chunks uploaded');
  assert.ok(!h.posted.some((p) => p.address === chunk1Addr), 'seeded chunk was NOT re-uploaded');

  // file.create carried the full 3-chunk list with client hashes + sizes.
  assert.equal(h.fileCreates.length, 1, 'one file.create');
  const fc = h.fileCreates[0];
  assert.equal(fc.filename, 'report.png');
  assert.equal(fc.mime_type, 'image/png');
  assert.equal(fc.chunks.length, 3, 'file.create has all 3 chunks');
  assert.deepEqual(
    fc.chunks.map((c) => c.address),
    [sha256Hex(bytes.slice(0, 4)), chunk1Addr, sha256Hex(bytes.slice(8, 12))],
    'chunk addresses match client SHA-256 in order',
  );

  // attachment.create bound the file to the card and returned the row.
  assert.equal(h.attachmentCreates.length, 1, 'one attachment.create');
  assert.equal(h.attachmentCreates[0].card_id.toString(), CARD_ID.toString());
  assert.equal(h.attachmentCreates[0].file_id.toString(), '7001', 'bound the created file id');
  assert.equal(row.id, 9001n, 'onDone got the committed attachment row (id revived to bigint)');
  assert.equal(row.kind, 'image');

  // Progress surfaced the phases + the final loaded == total.
  const phases = progress.map((p) => p.phase);
  assert.ok(phases.includes('hashing'), 'reported hashing');
  assert.ok(phases.includes('uploading'), 'reported uploading');
  assert.ok(phases.includes('saving'), 'reported saving');
  const last = progress[progress.length - 1];
  assert.equal(last.total, bytes.length);
  assert.equal(last.loaded, bytes.length, 'final progress is fully loaded');
});

test('upload: a fully-cached file uploads ZERO bytes (re-upload dedup)', async () => {
  const bytes = new Uint8Array([42, 42, 42, 42, 99, 99]);
  const file = new File([bytes], 'dup.bin', { type: 'application/octet-stream' });
  // Seed BOTH chunk addresses (chunkBytes=4 → [42,42,42,42] + [99,99]).
  const a0 = sha256Hex(bytes.slice(0, 4));
  const a1 = sha256Hex(bytes.slice(4, 6));
  const h = uploadHarness({ seededAddresses: [a0, a1] });
  const { api } = bootApi(h.transport);

  const { row } = await runUpload(api, file, { chunkBytes: 4, postChunk: h.postChunk });

  assert.equal(h.posted.length, 0, 'no chunk bytes posted — all already stored');
  assert.equal(h.fileCreates.length, 1, 'file.create still fires');
  assert.equal(h.attachmentCreates.length, 1, 'attachment.create still fires');
  assert.equal(row.id, 9001n);
});

test('upload: a sub_error on file.create surfaces through onError (no attachment.create)', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const file = new File([bytes], 'x.png', { type: 'image/png' });
  const h = uploadHarness();
  // Override file.create to reject.
  const baseTransport = h.transport;
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      if (req.subrequests.some((sr) => `${sr.endpoint}.${sr.action}` === 'file.create')) {
        const subresponses = req.subrequests.map((sr) => ({
          id: sr.id,
          ok: false,
          error: { code: 'validation', message: 'bad chunk' },
        }));
        return { status: 200, text: JSON.stringify({ subresponses }) };
      }
      return baseTransport.send(body);
    },
  };
  const { api } = bootApi(transport);

  let errored = null;
  await new Promise((resolve) => {
    M.uploadFile(api, CARD_ID, file, {
      chunkBytes: 4,
      postChunk: h.postChunk,
      onDone: () => resolve(),
      onError: (e) => {
        errored = e;
        resolve();
      },
    });
  });

  assert.ok(errored instanceof Error, 'onError fired with an Error');
  assert.match(errored.message, /file\.create/, 'error names the failing step');
  assert.equal(h.attachmentCreates.length, 0, 'attachment.create did NOT fire after file.create failed');
});
