// Activity screen (#1): the active-project activity feed. Loads project-scoped
// activity.select, resolves actor + card_ref labels, renders newest-first, and
// each row opens its card's /task/:id detail.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
let FakeElement;
let setPath;

before(async () => {
  ({ FakeElement, setPath } = installDomShim());
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerActivity();
});

beforeEach(() => {
  setPath('/activity');
  M._resetRouterForTest();
});

const PROJECT = 31n;

/** A transport serving project-scoped activity + label lookups. */
function activityTransport() {
  function respond(sr) {
    const k = `${sr.endpoint}.${sr.action}`;
    const data = sr.data ?? {};
    if (k === 'activity.select') {
      // Echo the project filter so the test can assert it was sent.
      lastActivityInput = data;
      return {
        id: sr.id,
        ok: true,
        data: {
          rows: [
            {
              id: '200', card_id: '9', kind: 'attr_update', attribute_name: 'milestone_ref',
              value_old: '234', value_new: '456', actor_id: '5', created_at: '2026-05-24T12:00:00.000Z',
            },
            {
              id: '201', card_id: '9', kind: 'comment', comment_body: 'hi',
              actor_id: '5', created_at: '2026-05-24T12:01:00.000Z',
            },
          ],
        },
      };
    }
    if (k === 'user.select') {
      return { id: sr.id, ok: true, data: { rows: [{ id: '5', display_name: 'Bob' }] } };
    }
    if (k === 'attribute_def.select') {
      return {
        id: sr.id, ok: true,
        data: { rows: [
          { id: 'def-m', name: 'milestone_ref', value_type: 'card_ref', is_built_in: true,
            target_card_type_name: 'milestone', bound_to: [{ card_type_id: '5', card_type_name: 'task', ordering: 0 }] },
        ] },
      };
    }
    if (k === 'card.search') {
      const rows = [];
      if (data.card_type_name === 'milestone') {
        rows.push({ id: '234', title: 'Q1' }, { id: '456', title: 'Q2' });
      }
      return { id: sr.id, ok: true, data: { rows } };
    }
    return { id: sr.id, ok: false, error: { code: 'unknown', message: `mock has no ${k}` } };
  }
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      return { status: 200, text: JSON.stringify({ subresponses: req.subrequests.map(respond) }) };
    },
  };
  return transport;
}

let lastActivityInput = null;

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerAdminSpecs(api); // user.select + attribute_def.select
  M.registerCommentSpecs(api); // activity.select
  M.registerCardSearchSpec(api); // card.search (label resolution)
  return { dispatcher, api };
}

async function settle(dispatcher) {
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  await dispatcher.flushNow();
  M.flushSync?.();
}

function mountActivity(api) {
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(PROJECT);
  M.installRouter(tree); // so row clicks land a route
  const ctrl = M.Control.New('Activity', { type: 'Activity' }, { api, tree });
  ctrl.mount(new FakeElement('div'));
  return { ctrl, tree };
}

test('Activity: loads project-scoped rows, resolves labels, renders newest-first', async () => {
  lastActivityInput = null;
  const { dispatcher, api } = bootApi(activityTransport());
  const { ctrl } = mountActivity(api);
  await settle(dispatcher);

  // The query was scoped to the active project.
  assert.equal(lastActivityInput.project_id, String(PROJECT), 'activity.select sent project_id');

  const rows = ctrl.el.querySelectorAll('[data-activity-row]');
  assert.equal(rows.length, 2, 'both rows render');
  // Newest-first by timestamp: the comment (12:01) before the attr_update (12:00).
  assert.equal(rows[0].dataset.activityRow, '201');
  assert.equal(rows[1].dataset.activityRow, '200');

  // The card_ref attr_update resolves milestone ids to titles (not #234/#456).
  const attrText = rows[1].querySelector('[data-activity-text]');
  assert.equal(attrText.textContent, 'Bob changed milestone from Q1 to Q2');
});

test('Activity: clicking a row opens the card detail (/task/:cardId)', async () => {
  const { dispatcher, api } = bootApi(activityTransport());
  const { ctrl, tree } = mountActivity(api);
  await settle(dispatcher);

  ctrl.el.querySelector('[data-activity-row="200"]').dispatchEvent({ type: 'click' });
  const route = tree.at([...M.ROUTER_PATH]).peek();
  assert.equal(route.name, 'task');
  assert.equal(route.params.id, '9', 'navigated to the row card');
});

test('Activity: no active project → empty state, no query', async () => {
  lastActivityInput = null;
  const { dispatcher, api } = bootApi(activityTransport());
  const tree = new M.TreeNode({}, []); // scope.projectId unset
  M.installRouter(tree);
  const ctrl = M.Control.New('Activity', { type: 'Activity' }, { api, tree });
  ctrl.mount(new FakeElement('div'));
  await settle(dispatcher);

  assert.equal(lastActivityInput, null, 'no activity query without a project');
  assert.ok(ctrl.el.querySelector('[data-activity-body]').textContent.length > 0, 'shows an empty/placeholder line');
});
