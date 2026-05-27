/**
 * ImportWizard — the CSV import flow (#41).
 *
 * Drives the wizard on a REAL DOM (jsdom) — it spawns Comboboxes (→ floating-ui)
 * for the column mapping + resolution selects. A recording batch transport + an
 * injected chunk sink stand in for the server so no real network is issued and
 * every shipped sub-request can be asserted.
 *
 * Coverage:
 *   - the four-step machine walks upload → set_mapping → preview → commit,
 *     firing the right specs with the right payloads (the CSV reaches the server
 *     by FILE ID: file.create runs first, then project.import.upload carries the
 *     project + file id);
 *   - the mapping step builds the mapping object (auto-mapping + user override);
 *     set_mapping ships it; the resolution config rides the preview call;
 *   - the preview step renders the would-create counts + the per-row error log;
 *   - commit fires project.import.commit and reports the created summary;
 *   - Back returns to the previous step; Cancel/Esc closes;
 *   - the AppShell wires `projectImport` → open() and `projectImportDone` →
 *     a bump of the import.refreshNonce leaf.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom, flushMicrotasks } from './ui-dom-setup.mjs';

let M;

const PROJECT_ID = 31n;
const JOB_ID = 700n;

before(async () => {
  installUiDom();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerImportWizard();
  M.registerCombobox();
  M.registerAppShell();
  M.registerScreenHost();
  M.registerScreenFilterBar();
  M.registerKanbanControls();
});

beforeEach(() => {
  document.body.replaceChildren();
  M._resetRouterForTest?.();
});

/** sha256 hex of bytes (the reference the mock chunk store computes). */
function sha256Hex(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/**
 * A batch transport that records every shipped sub-request + replies to the
 * specs the wizard touches: the CAS upload pipeline (cas.missing_chunks /
 * file.create) + the four project.import.* handlers.
 */
function importHarness(opts = {}) {
  const sent = [];
  const previewErrors = opts.previewErrors ?? [];
  const wouldCreate = opts.wouldCreate ?? {
    tasks: 4,
    persons: 1,
    milestones: 2,
    components: 0,
    tags: 3,
  };
  const created = opts.created ?? wouldCreate;

  function respond(sr) {
    sent.push(sr);
    const k = `${sr.endpoint}.${sr.action}`;
    const data = sr.data ?? {};
    switch (k) {
      case 'cas.missing_chunks': {
        const missing = (data.addresses ?? []).filter(() => true);
        return { id: sr.id, ok: true, data: { missing } };
      }
      case 'file.create':
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
      case 'project.import.upload':
        if (opts.failUpload) {
          return { id: sr.id, ok: false, error: { code: 'project_not_found', message: 'nope' } };
        }
        return {
          id: sr.id,
          ok: true,
          data: {
            job_id: String(JOB_ID),
            headers: opts.headers ?? ['Title', 'Assignee Email', 'Milestone', 'Tags'],
            preview_rows: opts.previewRows ?? [
              ['Write docs', 'a@x.com', 'M1', 'urgent'],
              ['Fix bug', 'b@x.com', 'M2', 'backend,urgent'],
            ],
            row_count: opts.rowCount ?? 4,
          },
        };
      case 'project.import.set_mapping':
        return { id: sr.id, ok: true, data: { ok: true, status: 'mapped' } };
      case 'project.import.preview':
        return {
          id: sr.id,
          ok: true,
          data: {
            would_create: wouldCreate,
            errors: previewErrors,
            skipped_rows: opts.skippedRows ?? 0,
            processed_rows: opts.processedRows ?? 4,
            status: 'previewed',
          },
        };
      case 'project.import.commit':
        return {
          id: sr.id,
          ok: true,
          data: {
            created,
            errors: [],
            status: 'completed',
            skipped_rows: opts.skippedRows ?? 0,
            processed_rows: opts.processedRows ?? 4,
          },
        };
      default:
        return { id: sr.id, ok: false, error: { code: 'unknown_handler', message: k } };
    }
  }

  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map(respond);
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
  return { transport, sent };
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerAttachmentSpecs(api); // file.create / cas.missing_chunks (CSV upload)
  M.registerImportSpecs(api); // project.import.*
  return { dispatcher, api };
}

/** Mount an ImportWizard against a fresh tree. */
function mountWizard(api, config = {}) {
  const tree = new M.TreeNode({}, []);
  const ctx = { api, tree };
  const wiz = M.Control.New('ImportWizard', { type: 'ImportWizard', ...config }, ctx);
  wiz.mount(document.body);
  return { wiz, tree };
}

async function settle(dispatcher) {
  // Drain the multi-hop async chain to quiescence. The upload path is a chain
  // of microtask→batch hops (async CAS sink `arrayBuffer().then` → file.create
  // batch → upload batch → onOk → setStep), so each turn must ALTERNATE a
  // microtask flush with a dispatcher batch flush — not 6 batches, one microtask
  // turn, then 6 batches (which only drains a single microtask interleave and so
  // is timing-fragile under host load). Bounded so a real hang can't loop forever;
  // flushNow short-circuits on an empty queue, so spare turns are ~free.
  for (let i = 0; i < 24; i++) {
    await flushMicrotasks();
    await dispatcher.flushNow();
    M.flushSync?.();
  }
}

function sentOf(sent, endpoint, action) {
  return sent.filter((sr) => sr.endpoint === endpoint && sr.action === action);
}

function click(el) {
  el.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}
function keydown(target, key, opts = {}) {
  target.dispatchEvent(
    new globalThis.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }),
  );
}

/** Inject an in-memory chunk POST sink so no real fetch fires. */
function injectChunkSink(wiz) {
  wiz._setPostChunkForTest((blob, onDone) => {
    void blob.arrayBuffer().then((buf) => {
      const u8 = new Uint8Array(buf);
      onDone({ address: sha256Hex(u8), sizeBytes: u8.length });
    });
  });
}

/** Open the wizard scoped to PROJECT_ID, queue a CSV file, run the upload. */
async function uploadCsvFile(wiz, dispatcher, csvText = 'Title\nx\n') {
  wiz.open({ projectId: PROJECT_ID });
  injectChunkSink(wiz);
  const file = new globalThis.File([csvText], 'tasks.csv', { type: 'text/csv' });
  wiz._setFileForTest(file);
  const next = wiz.el.querySelector('[data-iw-next]');
  click(next);
  await settle(dispatcher);
}

/* -------------------------------------------------------------------------- */
/* Auto-mapping (pure).                                                        */
/* -------------------------------------------------------------------------- */

test('autoMapping snake-cases headers and falls back to _ignore_', () => {
  const m = M.autoMapping(['Title', 'Assignee Email', 'Sort-Order', 'Custom Field', 'tags']);
  assert.equal(m['Title'], 'title');
  assert.equal(m['Assignee Email'], 'assignee_email');
  assert.equal(m['Sort-Order'], 'sort_order');
  assert.equal(m['Custom Field'], M.IGNORE_COLUMN, 'unknown column → ignore');
  assert.equal(m['tags'], 'tags');
});

/* -------------------------------------------------------------------------- */
/* Full walk: upload → set_mapping → preview → commit.                         */
/* -------------------------------------------------------------------------- */

test('walks upload → set_mapping → preview → commit firing the right specs/payloads', async () => {
  const { transport, sent } = importHarness();
  const { dispatcher, api } = bootApi(transport);
  const { wiz } = mountWizard(api);

  // ---- UPLOAD ----
  await uploadCsvFile(wiz, dispatcher, 'Title,Assignee Email,Milestone,Tags\nWrite docs,a@x.com,M1,urgent\n');

  // CSV reached the server by file id: file.create ran first.
  assert.equal(sentOf(sent, 'file', 'create').length, 1, 'one file.create (CSV → CAS file)');
  const uploads = sentOf(sent, 'project.import', 'upload');
  assert.equal(uploads.length, 1, 'one project.import.upload');
  assert.equal(uploads[0].data.project_id, String(PROJECT_ID), 'upload carries the project id');
  assert.equal(uploads[0].data.file_id, '7001', 'upload carries the materialised file id');
  assert.equal(wiz._stepForTest(), 'map', 'advanced to the MAP step');

  // The auto-mapping populated the mapping object from the returned headers.
  const mapping = wiz._mappingForTest();
  assert.equal(mapping['Title'], 'title');
  assert.equal(mapping['Assignee Email'], 'assignee_email');
  assert.equal(mapping['Milestone'], 'milestone');
  assert.equal(mapping['Tags'], 'tags');

  // ---- MAP: tweak resolution, then Run preview ----
  wiz._setResolutionForTest('persons', 'auto_create');
  wiz._setResolutionForTest('tags', 'auto_create');
  const runPreview = wiz.el.querySelector('[data-iw-next]');
  click(runPreview);
  await settle(dispatcher);

  const maps = sentOf(sent, 'project.import', 'set_mapping');
  assert.equal(maps.length, 1, 'one project.import.set_mapping');
  assert.equal(maps[0].data.job_id, String(JOB_ID), 'set_mapping carries the job id');
  assert.deepEqual(
    maps[0].data.mapping,
    { Title: 'title', 'Assignee Email': 'assignee_email', Milestone: 'milestone', Tags: 'tags' },
    'set_mapping ships the built mapping object',
  );

  // Preview auto-ran after set_mapping, with the resolution config.
  const previews = sentOf(sent, 'project.import', 'preview');
  assert.equal(previews.length, 1, 'one project.import.preview');
  assert.equal(previews[0].data.job_id, String(JOB_ID));
  assert.equal(previews[0].data.resolution.persons, 'auto_create', 'resolution rode the preview');
  assert.equal(previews[0].data.resolution.tags, 'auto_create');
  assert.equal(wiz._stepForTest(), 'preview', 'advanced to the PREVIEW step');

  // The preview rendered the would-create counts.
  const summary = wiz.el.querySelector('[data-iw-summary]');
  assert.ok(summary, 'a summary block rendered');
  assert.match(summary.textContent, /Would create tasks/);
  assert.match(summary.textContent, /4/, 'tasks count shown');

  // ---- COMMIT ----
  const commitBtn = wiz.el.querySelector('[data-iw-next]');
  assert.equal(commitBtn.disabled, false, 'commit enabled (no preview errors)');
  click(commitBtn);
  await settle(dispatcher);

  const commits = sentOf(sent, 'project.import', 'commit');
  assert.equal(commits.length, 1, 'one project.import.commit');
  assert.equal(commits[0].data.job_id, String(JOB_ID), 'commit carries the job id');
  assert.equal(wiz._stepForTest(), 'commit', 'on the COMMIT step');

  const success = wiz.el.querySelector('[data-iw-success]');
  assert.ok(success, 'a success banner rendered');
  assert.match(success.textContent, /created 4 tasks/);
  const createdSummary = wiz.el.querySelector('[data-iw-summary]');
  assert.match(createdSummary.textContent, /Created tasks/);
});

/* -------------------------------------------------------------------------- */
/* Mapping override flows into set_mapping.                                    */
/* -------------------------------------------------------------------------- */

test('a user mapping override ships in set_mapping', async () => {
  const { transport, sent } = importHarness({ headers: ['Title', 'Notes'] });
  const { dispatcher, api } = bootApi(transport);
  const { wiz } = mountWizard(api);
  await uploadCsvFile(wiz, dispatcher);
  // Precondition: the async upload chain fully settled onto the map step (guards
  // against a partially-drained state silently corrupting the assertions below).
  assert.equal(wiz._stepForTest(), 'map', 'upload settled onto the map step');

  // 'Notes' auto-mapped to ignore; the user maps it to description.
  assert.equal(wiz._mappingForTest()['Notes'], M.IGNORE_COLUMN);
  wiz._setMappingTargetForTest('Notes', 'description');

  click(wiz.el.querySelector('[data-iw-next]'));
  await settle(dispatcher);
  // set_mapping fully completed → the machine advanced to preview.
  assert.equal(wiz._stepForTest(), 'preview', 'set_mapping advanced to preview');

  const maps = sentOf(sent, 'project.import', 'set_mapping');
  assert.equal(maps.length, 1, 'exactly one set_mapping fired (no auto-mapping pre-fire)');
  assert.equal(maps[0].data.mapping['Notes'], 'description', 'override shipped');
});

/* -------------------------------------------------------------------------- */
/* Preview errors block commit + render in the error log.                      */
/* -------------------------------------------------------------------------- */

test('preview errors render in the log and disable commit', async () => {
  const previewErrors = [
    { row: 2, column: 'title', message: 'title is required' },
    { row: 5, column: 'milestone', message: 'unknown milestone "Zeta" (no resolution mode set)' },
  ];
  const { transport } = importHarness({ previewErrors, wouldCreate: { tasks: 1, persons: 0, milestones: 0, components: 0, tags: 0 } });
  const { dispatcher, api } = bootApi(transport);
  const { wiz } = mountWizard(api);
  await uploadCsvFile(wiz, dispatcher);

  // Map → preview.
  click(wiz.el.querySelector('[data-iw-next]'));
  await settle(dispatcher);

  const errors = wiz.el.querySelector('[data-iw-errors]');
  assert.ok(errors, 'an error log rendered');
  assert.match(errors.textContent, /2 errors/);
  assert.match(errors.textContent, /row 2 · title: title is required/);
  assert.match(errors.textContent, /row 5 · milestone: unknown milestone/);

  const commitBtn = wiz.el.querySelector('[data-iw-next]');
  assert.equal(commitBtn.disabled, true, 'commit disabled while preview has errors');
});

/* -------------------------------------------------------------------------- */
/* Upload failure surfaces inline (no advance).                                */
/* -------------------------------------------------------------------------- */

test('an upload failure surfaces inline and stays on the upload step', async () => {
  const { transport, sent } = importHarness({ failUpload: true });
  const { dispatcher, api } = bootApi(transport);
  const { wiz } = mountWizard(api);
  await uploadCsvFile(wiz, dispatcher);

  assert.equal(wiz._stepForTest(), 'upload', 'stayed on the upload step');
  const err = wiz.el.querySelector('[data-iw-error]');
  assert.equal(err.style.display, '', 'inline error shown');
  assert.match(err.textContent, /project_not_found/);
  assert.equal(sentOf(sent, 'project.import', 'set_mapping').length, 0, 'no set_mapping fired');
});

/* -------------------------------------------------------------------------- */
/* Back returns to the previous step; Cancel/Esc closes.                       */
/* -------------------------------------------------------------------------- */

test('Back returns from map to upload; Cancel closes', async () => {
  const { transport } = importHarness();
  const { dispatcher, api } = bootApi(transport);
  const { wiz } = mountWizard(api);
  await uploadCsvFile(wiz, dispatcher);
  assert.equal(wiz._stepForTest(), 'map');

  // Back → upload.
  click(wiz.el.querySelector('[data-iw-back]'));
  assert.equal(wiz._stepForTest(), 'upload', 'Back moved to the upload step');

  // On the first step Back doubles as Cancel → closes.
  assert.equal(wiz.el.querySelector('[data-iw-back]').textContent, 'Cancel');
  click(wiz.el.querySelector('[data-iw-back]'));
  assert.equal(wiz.el.style.display, 'none', 'Cancel closed the wizard');
});

test('Esc closes the wizard', () => {
  const { transport } = importHarness();
  const { api } = bootApi(transport);
  const { wiz } = mountWizard(api);
  wiz.open({ projectId: PROJECT_ID });
  assert.equal(wiz.el.style.display, '', 'open shows it');
  const panel = wiz.el.querySelector('[data-iw-panel]');
  keydown(panel, 'Escape');
  assert.equal(wiz.el.style.display, 'none', 'Esc closed it');
});

/* -------------------------------------------------------------------------- */
/* AppShell wiring: projectImport opens; projectImportDone bumps the nonce.     */
/* -------------------------------------------------------------------------- */

test('the AppShell wires projectImport → open() and projectImportDone → refresh nonce', () => {
  const { transport } = importHarness();
  const { api } = bootApi(transport);
  const tree = new M.TreeNode({}, []);
  const ctx = { api, tree };

  M.installRouter(tree);
  const shell = M.Control.New(
    'AppShell',
    {
      type: 'AppShell',
      boardConfig: { type: 'ScreenHost', screen: { slug: 'kanban', layout: 'kanban' } },
      importWizardConfig: { type: 'ImportWizard' },
    },
    ctx,
  );
  shell.mount(document.body);

  const wizards = shell.el.querySelectorAll('[data-control="ImportWizard"]');
  assert.equal(wizards.length, 1, 'the AppShell mounted ONE ImportWizard');
  assert.equal(wizards[0].style.display, 'none', 'wizard starts hidden');

  shell.intent('projectImport', { projectId: PROJECT_ID });
  assert.equal(wizards[0].style.display, '', 'projectImport opened the wizard');

  // projectImportDone bumps the shared refresh nonce.
  assert.equal(tree.at(['import', 'refreshNonce']).peek() ?? 0, 0, 'nonce starts unset');
  shell.intent('projectImportDone', { projectId: PROJECT_ID });
  assert.equal(tree.at(['import', 'refreshNonce']).peek(), 1, 'projectImportDone bumped the nonce');
});
