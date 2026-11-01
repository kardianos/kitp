/**
 * The page detail (/page/:id): the shared TaskDetail configured by the `page`
 * detail profile. Proves the profile — not a branch in the control — decides:
 * the noun, which sections mount (no comms / links / approvals / tags /
 * related; a PUBLISHED ON section instead), that the status attr is
 * publish_status (hidden from the panel; the header badge reads it), that a
 * page's sort_order is editable, and that a nested page publishes its PROJECT
 * (not its parent page) into scope.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom, flushMicrotasks } from './ui-dom-setup.mjs';

let M;

before(async () => {
  installUiDom();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerCombobox();
  M.registerDatePicker();
  M.registerRefPicker();
  M.registerFieldEditor();
  M.registerCardRefValue();
  M.registerAttributeRow();
  M.registerTaskAttributePanel();
  M.registerTaskDetail();
  M.registerTaskComments();
  M.registerPagePublications();
});

beforeEach(() => {
  document.body.replaceChildren();
});

const PROJECT_ID = 31n;

function pageTransport({ withPage = true } = {}) {
  const sent = [];
  const pages = [
    { id: '70', card_type_id: '20', card_type_name: 'page', parent_card_id: String(PROJECT_ID), phase: 'triage', attributes: { title: 'Home', publish_status: '61', sort_order: 0 } },
    { id: '71', card_type_id: '20', card_type_name: 'page', parent_card_id: '70', phase: 'triage', attributes: { title: 'Getting started', description: '## Write', slug: 'getting-started', publish_status: '61', sort_order: 10 } },
  ];
  const defRow = (name, valueType, target, ordering) => ({
    id: `def-${name}`,
    name,
    value_type: valueType,
    is_built_in: true,
    ...(target ? { target_card_type_name: target } : {}),
    bound_to: [{ card_type_id: '20', card_type_name: 'page', ordering }],
  });
  const DEFS = [
    defRow('title', 'text', null, 0),
    defRow('publish_status', 'card_ref', 'status', 1),
    defRow('slug', 'text', null, 2),
    defRow('sort_order', 'number', null, 3),
    defRow('description', 'text', null, 4),
  ];
  function respond(sr) {
    sent.push(sr);
    const key = `${sr.endpoint}.${sr.action}`;
    const data = sr.data ?? {};
    switch (key) {
      case 'card.select_with_attributes':
        if (data.card_type_name === 'page') return { rows: withPage ? pages : [] };
        if (data.card_type_name === 'status') {
          return { rows: [{ id: '61', card_type_id: '6', card_type_name: 'status', parent_card_id: String(PROJECT_ID), phase: 'active', attributes: { title: 'Published', sort_order: 30 } }] };
        }
        return { rows: [] };
      case 'attribute_def.select':
        return { rows: DEFS };
      case 'card.search':
        return { rows: [] };
      case 'activity.select':
      case 'attachment.list':
      case 'flow_step.list_for_card':
        return { rows: [] };
      case 'page.publications':
        return { rows: [{ portal_id: '120', portal_title: 'Docs (PROD)', host: 'docs.example.com', public: true, published_at: '2026-06-01T10:00:00Z', published_by: 'Ada', current: true, path: 'getting-started/index.html' }] };
      case 'attribute.update':
        return { ok: true, activity_id: '999' };
      default:
        return null;
    }
  }
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => {
        const out = respond(sr);
        return out === null
          ? { id: sr.id, ok: false, error: { code: 'unknown', message: `mock has no ${sr.endpoint}.${sr.action}` } }
          : { id: sr.id, ok: true, data: out };
      });
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
  return { transport, sent, of: (k) => sent.filter((s) => `${s.endpoint}.${s.action}` === k) };
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api);
  M.registerGridCardRefAttrs();
  M.registerAdminSpecs(api);
  M.registerCardSearchSpec(api);
  M.registerCommentSpecs(api);
  M.registerProjectSpecs(api); // + bundle / portal specs (page.publications)
  return { dispatcher, api };
}

async function settle(dispatcher) {
  for (let i = 0; i < 3; i++) await dispatcher.flushNow();
  M.flushSync?.();
  await flushMicrotasks();
  M.flushSync?.();
}

function mountPage(api, id = '71') {
  const tree = new M.TreeNode({}, []);
  const td = M.Control.New('TaskDetail', { type: 'TaskDetail', taskId: id, cardTypeName: 'page' }, { api, tree });
  td.mount(document.createElement('div'));
  document.body.appendChild(td.el);
  return { td, tree };
}

const slot = (td, name) => td.el.querySelector(`[data-slot="${name}"]`);

test('page detail: page profile mounts PUBLISHED ON and hides task-only sections', async () => {
  const t = pageTransport();
  const { dispatcher, api } = bootApi(t.transport);
  const { td } = mountPage(api);
  await settle(dispatcher);

  assert.equal(td.el.querySelector('[data-task-title]').textContent, 'Getting started');
  for (const name of ['comms', 'links', 'approvals', 'tags', 'related']) {
    assert.equal(slot(td, name).style.display, 'none', `${name} hidden on a page`);
  }
  for (const name of ['comments', 'attachments', 'publications']) {
    assert.notEqual(slot(td, name).style.display, 'none', `${name} shown on a page`);
  }
  const pubs = td.el.querySelector('[data-control="PagePublications"]');
  assert.ok(pubs, 'PUBLISHED ON control mounted');
  assert.match(pubs.textContent, /Docs \(PROD\)/);
  // No task-only reads went out.
  for (const k of ['comm.list_for_task', 'link.list', 'approval.list']) {
    assert.equal(t.of(k).length, 0, `no ${k} for a page`);
  }
  assert.equal(t.of('page.publications')[0].data.page_id, '71');
});

test('page detail: header badge reads publish_status; panel hides it but edits slug + order', async () => {
  const t = pageTransport();
  const { dispatcher, api } = bootApi(t.transport);
  const { td } = mountPage(api);
  await settle(dispatcher);

  const badge = td.el.querySelector('[data-task-status-badge]');
  assert.ok(badge, 'status badge present');
  assert.equal(badge.textContent, 'Published', 'badge reads the page’s publish_status');
  const panel = td.el.querySelector('[data-task-detail-panel]');
  const names = [...panel.querySelectorAll('[data-attr-row]')].map((el) => el.dataset.attrRow);
  assert.ok(!names.includes('publish_status'), 'publish_status moves through the TransitionBar, not the panel');
  assert.ok(names.includes('slug'), 'slug is editable');
  assert.ok(names.includes('sort_order'), 'a page’s order is editable');
});

test('page detail: a nested page publishes its project (not its parent page) into scope', async () => {
  const t = pageTransport();
  const { dispatcher, api } = bootApi(t.transport);
  const { tree } = mountPage(api, '71');
  await settle(dispatcher);
  assert.equal(tree.at(['scope', 'projectId']).peek(), PROJECT_ID);
});

test('page detail: a missing page says "Page not found" (no comm redirect)', async () => {
  const t = pageTransport({ withPage: false });
  const { dispatcher, api } = bootApi(t.transport);
  const { td } = mountPage(api, '99');
  await settle(dispatcher);
  const nf = td.el.querySelector('[data-task-detail-not-found]');
  assert.notEqual(nf.style.display, 'none');
  assert.match(nf.textContent, /Page not found/);
  const commReads = t.of('card.select_with_attributes').filter((s) => s.data.card_type_name === 'comm');
  assert.equal(commReads.length, 0, 'no comm-card redirect probe for pages');
});
