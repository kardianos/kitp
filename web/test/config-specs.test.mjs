// config.get spec + loadServerConfig boot loader (workspace title).
// Wire contract: decode the snake_case Snapshot the Go handler returns; the
// loader lands the title at `config.workspaceTitle` + sets document.title and
// falls back to the neutral 'Workspace' (never 'kitp') when unset.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom } from './ui-dom-setup.mjs';

let M;
before(async () => {
  installUiDom(); // a real document (for document.title) + DOM globals the barrel touches
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
});

/** A tiny transport that answers every subrequest via `responder`. */
function harness(responder) {
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => responder(sr));
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerConfigSpecs(api);
  return { api, dispatcher };
}

test('config.get decodes workspace_title + the byte caps (snake_case → camel)', async () => {
  const { api, dispatcher } = harness((sr) => ({
    id: sr.id,
    ok: true,
    data: { config: { workspace_title: 'Acme HQ', attachment_max_bytes: 1024, chunk_max_bytes: 256 } },
  }));
  let out;
  api.callByName(M.CONFIG_GET_SPEC, {}, (o) => {
    out = o;
  });
  await dispatcher.flushNow();
  assert.equal(out.workspaceTitle, 'Acme HQ');
  assert.equal(out.attachmentMaxBytes, 1024);
  assert.equal(out.chunkMaxBytes, 256);
});

test('loadServerConfig lands config.workspaceTitle + sets document.title', async () => {
  const { api, dispatcher } = harness((sr) => ({
    id: sr.id,
    ok: true,
    data: { config: { workspace_title: 'Acme HQ' } },
  }));
  const tree = new M.TreeNode({}, []);
  M.loadServerConfig(api, tree);
  await dispatcher.flushNow();
  assert.equal(tree.at([...M.WORKSPACE_TITLE_PATH]).peek(), 'Acme HQ');
  assert.equal(document.title, 'Acme HQ');
});

test('loadServerConfig lands comms_bell_url at config.commsBellUrl (workspace-configurable bell)', async () => {
  const { api, dispatcher } = harness((sr) => ({
    id: sr.id,
    ok: true,
    data: { config: { comms_bell_url: '/screen/triage', workspace_title: 'Acme HQ' } },
  }));
  const tree = new M.TreeNode({}, []);
  M.loadServerConfig(api, tree);
  await dispatcher.flushNow();
  assert.equal(tree.at([...M.COMMS_BELL_URL_PATH]).peek(), '/screen/triage');
});

test('loadServerConfig lands an empty comms_bell_url so the AppShell falls back to its default', async () => {
  const { api, dispatcher } = harness((sr) => ({
    id: sr.id,
    ok: true,
    data: { config: { workspace_title: 'Acme HQ' } }, // comms_bell_url absent
  }));
  const tree = new M.TreeNode({}, []);
  M.loadServerConfig(api, tree);
  await dispatcher.flushNow();
  assert.equal(tree.at([...M.COMMS_BELL_URL_PATH]).peek(), '');
});

test('loadServerConfig falls back to "Workspace" when unset (never "kitp")', async () => {
  const { api, dispatcher } = harness((sr) => ({
    id: sr.id,
    ok: true,
    data: { config: { workspace_title: '' } },
  }));
  const tree = new M.TreeNode({}, []);
  M.loadServerConfig(api, tree);
  await dispatcher.flushNow();
  assert.equal(M.DEFAULT_WORKSPACE_TITLE, 'Workspace');
  assert.equal(tree.at([...M.WORKSPACE_TITLE_PATH]).peek(), 'Workspace');
  assert.notEqual(document.title, 'kitp');
});
