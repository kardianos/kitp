/**
 * TaskLinks — the task-detail LINKS section (code changes / issues / URLs) and
 * its link-specs presentation tables.
 *
 * Coverage:
 *   - the pure kind / state / icon / URL helpers (data tables);
 *   - link.list decode;
 *   - rows render a new-tab title link, a toned state badge, the source + host
 *     + adder + local time meta line;
 *   - the add form validates the URL client-side, fires link.set (with a
 *     guessed kind for a new code-change URL), reports "Already linked" on an
 *     idempotent repeat, and reloads;
 *   - remove is optimistic and fires link.delete.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom, flushMicrotasks } from './ui-dom-setup.mjs';

let M;

const TASK = 54n;
const CL = 'https://gerrit.example.com/c/kitp/+/42';

before(async () => {
  installUiDom();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerTaskLinks();
});

beforeEach(() => {
  document.body.replaceChildren();
});

/* -------------------------------------------------------------------------- */
/* Pure presentation helpers.                                                  */
/* -------------------------------------------------------------------------- */

const STATE_CASES = [
  { label: 'no state', state: '', want: null },
  { label: 'open', state: 'open', want: { label: 'Open', tone: 'progress' } },
  { label: 'reviewed', state: 'reviewed', want: { label: 'Reviewed', tone: 'progress' } },
  { label: 'approved', state: 'approved', want: { label: 'Approved', tone: 'success' } },
  { label: 'merged', state: 'merged', want: { label: 'Merged', tone: 'success' } },
  { label: 'abandoned', state: 'abandoned', want: { label: 'Abandoned', tone: 'muted' } },
  { label: 'unknown slug humanised', state: 'needs_rebase', want: { label: 'Needs rebase', tone: 'neutral' } },
];
for (const c of STATE_CASES) {
  test(`linkStateInfo: ${c.label}`, () => {
    const got = M.linkStateInfo(c.state);
    assert.deepEqual(got === null ? null : { label: got.label, tone: got.tone }, c.want);
  });
}

const KIND_CASES = [
  { label: 'plain', kind: '', want: { label: '', icon: 'link' } },
  { label: 'gerrit', kind: 'gerrit', want: { label: 'Gerrit', icon: 'git-pull-request' } },
  { label: 'github', kind: 'github', want: { label: 'GitHub', icon: 'git-pull-request' } },
  { label: 'unknown slug humanised', kind: 'bug-tracker', want: { label: 'Bug tracker', icon: 'link' } },
];
for (const c of KIND_CASES) {
  test(`linkKindInfo: ${c.label}`, () => {
    const got = M.linkKindInfo(c.kind);
    assert.deepEqual({ label: got.label, icon: got.icon }, c.want);
  });
}

const ICON_CASES = [
  { label: 'open CL', kind: 'gerrit', state: 'open', want: 'git-pull-request' },
  { label: 'merged CL', kind: 'gerrit', state: 'merged', want: 'git-merge' },
  { label: 'abandoned CL', kind: 'gerrit', state: 'abandoned', want: 'git-pull-request-closed' },
  { label: 'merged plain link keeps link icon', kind: '', state: 'merged', want: 'link' },
  { label: 'issue', kind: 'issue', state: 'open', want: 'link' },
];
for (const c of ICON_CASES) {
  test(`linkIcon: ${c.label}`, () => {
    assert.equal(M.linkIcon(c.kind, c.state), c.want);
  });
}

const URL_CASES = [
  { label: 'https', url: CL, linkable: true, display: 'gerrit.example.com/c/kitp/+/42', kind: 'gerrit' },
  { label: 'http trailing slash', url: 'http://x.test/page/', linkable: true, display: 'x.test/page', kind: '' },
  { label: 'github PR', url: 'https://github.com/o/r/pull/7', linkable: true, display: 'github.com/o/r/pull/7', kind: 'github' },
  { label: 'gitlab MR', url: 'https://gl.test/g/p/-/merge_requests/3', linkable: true, display: 'gl.test/g/p/-/merge_requests/3', kind: 'gitlab' },
  { label: 'javascript scheme', url: 'javascript:alert(1)', linkable: false, display: 'javascript:alert(1)', kind: '' },
  { label: 'relative', url: '/c/42', linkable: false, display: '/c/42', kind: '' },
  { label: 'inner space', url: 'https://x.test/a b', linkable: false, display: 'x.test/a b', kind: '' },
  { label: 'empty', url: '', linkable: false, display: '', kind: '' },
];
for (const c of URL_CASES) {
  test(`url helpers: ${c.label}`, () => {
    assert.deepEqual(
      { linkable: M.isLinkableUrl(c.url), display: M.displayUrl(c.url), kind: M.guessLinkKind(c.url) },
      { linkable: c.linkable, display: c.display, kind: c.kind },
    );
  });
}

test('decodeLinkRow: wire row → web model (ids revive to bigint)', () => {
  const row = M.decodeLinkRow({
    id: '901', task_id: '54', url: CL, title: 'fix x', kind: 'gerrit', state: 'merged',
    created_at: '2026-10-21T10:00:00.000Z', updated_at: '2026-10-21T12:00:00.000Z',
    created_by_id: '7', created_by: 'Gerrit',
  });
  assert.deepEqual(row, {
    id: 901n, taskId: 54n, url: CL, title: 'fix x', kind: 'gerrit', state: 'merged',
    createdAt: '2026-10-21T10:00:00.000Z', updatedAt: '2026-10-21T12:00:00.000Z',
    createdById: 7n, createdBy: 'Gerrit',
  });
});

/* -------------------------------------------------------------------------- */
/* The control against a mock transport.                                       */
/* -------------------------------------------------------------------------- */

function wireRow(id, url, extra = {}) {
  return {
    id: String(id), task_id: String(TASK), url, title: url, kind: '', state: '',
    created_at: '2026-10-21T10:00:00.000Z', updated_at: '2026-10-21T10:00:00.000Z',
    created_by_id: '1', created_by: 'System', ...extra,
  };
}

/** A link.* server: list serves `store`, set upserts by url, delete removes. */
function linksMockTransport(seed = []) {
  const store = [...seed];
  const sets = [];
  const deletes = [];
  let nextId = 1000;
  function respond(sr) {
    const k = `${sr.endpoint}.${sr.action}`;
    const data = sr.data ?? {};
    if (k === 'link.list') return { id: sr.id, ok: true, data: { rows: store } };
    if (k === 'link.set') {
      sets.push(data);
      const hit = store.find((r) => r.url === data.url);
      if (hit !== undefined) {
        const changed = data.title !== undefined && data.title !== hit.title;
        if (changed) hit.title = data.title;
        return { id: sr.id, ok: true, data: { link_id: hit.id, created: false, changed } };
      }
      const row = wireRow(nextId++, data.url, { title: data.title ?? data.url, kind: data.kind ?? '' });
      store.push(row);
      return { id: sr.id, ok: true, data: { link_id: row.id, created: true, changed: true } };
    }
    if (k === 'link.delete') {
      deletes.push(data);
      const i = store.findIndex((r) => r.id === String(data.id));
      if (i >= 0) store.splice(i, 1);
      return { id: sr.id, ok: true, data: { deleted: true } };
    }
    return { id: sr.id, ok: false, error: { code: 'unknown', message: k } };
  }
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      return { status: 200, text: JSON.stringify({ subresponses: req.subrequests.map(respond) }) };
    },
  };
  return { transport, store, sets, deletes };
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerLinkSpecs(api);
  return { dispatcher, api };
}

async function settle(dispatcher) {
  for (let i = 0; i < 4; i++) await dispatcher.flushNow();
  await flushMicrotasks();
  for (let i = 0; i < 2; i++) await dispatcher.flushNow();
  await flushMicrotasks();
}

function mount(api, onLocalWrite) {
  const tree = new M.TreeNode({}, []);
  const cfg = { type: 'TaskLinks', taskId: TASK.toString() };
  if (onLocalWrite) cfg.onLocalWrite = onLocalWrite;
  const c = M.Control.New('TaskLinks', cfg, { api, tree });
  c.mount(document.createElement('div'));
  document.body.appendChild(c.el);
  return c;
}

function key(target, k) {
  target.dispatchEvent(new globalThis.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}

test('TaskLinks: empty task shows "No links." once loaded', async () => {
  const { transport } = linksMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const c = mount(api);
  assert.equal(c.el.querySelector('[data-links-empty]').textContent, 'Loading…');
  await settle(dispatcher);
  assert.equal(c.el.querySelector('[data-links-empty]').textContent, 'No links.');
  assert.equal(c.el.querySelector('[data-links-heading]').textContent, 'LINKS');
});

test('TaskLinks: a CL row renders a new-tab title, a toned state badge and its meta', async () => {
  const { transport } = linksMockTransport([
    wireRow(901, CL, { title: 'server: fix x', kind: 'gerrit', state: 'merged', created_by: 'Gerrit' }),
  ]);
  const { dispatcher, api } = bootApi(transport);
  const c = mount(api);
  await settle(dispatcher);

  assert.equal(c.el.querySelector('[data-links-heading]').textContent, 'LINKS (1)');
  const row = c.el.querySelector('[data-link-row="901"]');
  assert.ok(row, 'row rendered');
  const a = row.querySelector('[data-link-title]');
  assert.equal(a.tagName, 'A');
  assert.equal(a.getAttribute('href'), CL);
  assert.equal(a.getAttribute('target'), '_blank');
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(a.textContent, 'server: fix x');
  const badge = row.querySelector('[data-link-state]');
  assert.equal(badge.textContent, 'Merged');
  assert.equal(badge.dataset.tone, 'success');
  const meta = row.querySelector('.task-links__meta').textContent;
  assert.match(meta, /^Gerrit · gerrit\.example\.com\/c\/kitp\/\+\/42 · added by Gerrit · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('TaskLinks: a stored non-http URL never becomes an href', async () => {
  const { transport } = linksMockTransport([wireRow(902, 'javascript:alert(1)')]);
  const { dispatcher, api } = bootApi(transport);
  const c = mount(api);
  await settle(dispatcher);
  const title = c.el.querySelector('[data-link-row="902"] [data-link-title]');
  assert.equal(title.tagName, 'SPAN');
  assert.equal(title.getAttribute('href'), null);
});

test('TaskLinks: the add form rejects a non-URL without a round-trip', async () => {
  const { transport, sets } = linksMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const c = mount(api);
  await settle(dispatcher);
  c.el.querySelector('[data-links-add]').click();
  const url = c.el.querySelector('[data-links-url]');
  url.value = 'not a url';
  c.el.querySelector('[data-links-submit]').click();
  await settle(dispatcher);
  assert.equal(sets.length, 0, 'no link.set fired');
  assert.match(c.el.querySelector('[data-links-error]').textContent, /http/);
});

test('TaskLinks: adding a CL fires link.set with a guessed kind, then lists it', async () => {
  const writes = [];
  const { transport, sets } = linksMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const c = mount(api, () => writes.push('w'));
  await settle(dispatcher);
  c.el.querySelector('[data-links-add]').click();
  c.el.querySelector('[data-links-url]').value = `  ${CL}  `;
  c.el.querySelector('[data-links-title]').value = 'Fix x';
  key(c.el.querySelector('[data-links-title]'), 'Enter');
  await settle(dispatcher);

  assert.equal(sets.length, 1);
  assert.deepEqual(sets[0], { task_id: String(TASK), url: CL, title: 'Fix x', kind: 'gerrit' });
  assert.equal(c.el.querySelector('[data-links-form]').children.length, 0, 'form closed');
  assert.equal(c.el.querySelectorAll('[data-link-row]').length, 1, 'new link listed');
  assert.equal(c.el.querySelector('[data-links-note]').textContent, '');
  assert.equal(writes.length, 1, 'onLocalWrite fired');
});

test('TaskLinks: re-adding a linked URL is reported, not duplicated', async () => {
  const { transport, sets } = linksMockTransport([wireRow(903, CL, { title: 'fix x', kind: 'gerrit' })]);
  const { dispatcher, api } = bootApi(transport);
  const c = mount(api);
  await settle(dispatcher);
  c.el.querySelector('[data-links-add]').click();
  c.el.querySelector('[data-links-url]').value = CL;
  c.el.querySelector('[data-links-submit]').click();
  await settle(dispatcher);

  assert.equal(sets.length, 1);
  assert.equal(sets[0].kind, undefined, 'an existing link keeps its source-set kind');
  assert.equal(c.el.querySelectorAll('[data-link-row]').length, 1, 'still one link');
  assert.equal(c.el.querySelector('[data-links-note]').textContent, 'Already linked.');
});

test('TaskLinks: Escape closes the add form', async () => {
  const { transport } = linksMockTransport();
  const { dispatcher, api } = bootApi(transport);
  const c = mount(api);
  await settle(dispatcher);
  c.el.querySelector('[data-links-add]').click();
  key(c.el.querySelector('[data-links-url]'), 'Escape');
  assert.equal(c.el.querySelector('[data-links-form]').children.length, 0);
});

test('TaskLinks: remove drops the row at once and fires link.delete', async () => {
  const { transport, deletes } = linksMockTransport([wireRow(904, CL), wireRow(905, `${CL}/2`)]);
  const { dispatcher, api } = bootApi(transport);
  const c = mount(api);
  await settle(dispatcher);
  c.el.querySelector('[data-link-row="904"] [data-link-remove]').click();
  assert.equal(c.el.querySelector('[data-link-row="904"]'), null, 'optimistic remove');
  await settle(dispatcher);
  assert.deepEqual(deletes, [{ id: '904' }]);
  assert.equal(c.el.querySelectorAll('[data-link-row]').length, 1);
});
