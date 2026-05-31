/**
 * CommsList — the `comms` screen body. Proves it lists comm cards (project-
 * scoped), renders a phase-toned comm_status badge + parent-task chip per row,
 * and filters by comm_status phase INDEPENDENTLY (driven by screen.predicate,
 * which the attr-aware phase toggle composes as a comm_status has_phase leaf).
 *
 * The transport mocks card.select_with_attributes: it returns the status /
 * task lookups, and for comm cards it honours a comm_status has_phase leaf
 * (where[] or tree) so the active/terminal filters return different rows —
 * exactly what the Comms screen's phase toggle drives.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom, flushMicrotasks } from './ui-dom-setup.mjs';

let M;

const PROJECT = 31n;

// Status value-cards (shared pool); comm flow uses Open/In progress/Resolved.
const STATUSES = [
  { id: '54', phase: 'active', title: 'Open' },
  { id: '55', phase: 'active', title: 'In progress' },
  { id: '56', phase: 'terminal', title: 'Resolved' },
];
const STATUS_PHASE = Object.fromEntries(STATUSES.map((s) => [s.id, s.phase]));

// Two comms on task 59: one Open (active), one Resolved (terminal).
const COMMS = [
  { id: '145', parent_card_id: '59', comm_status: '54', title: 'Inquiry A' },
  { id: '200', parent_card_id: '59', comm_status: '56', title: 'Inquiry B' },
];

before(async () => {
  installUiDom();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerKanbanSpecs; // ensure module evaluated
  M.registerCommsList();
});

beforeEach(() => {
  document.body.replaceChildren();
});

/** Collect comm_status has_phase values from a where[] / tree predicate. */
function phaseValues(data) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.children)) node.children.forEach(visit);
    if (node.attr === 'comm_status' && node.op === 'has_phase' && Array.isArray(node.values)) {
      out.push(...node.values);
    }
  };
  (data.where ?? []).forEach(visit);
  if (data.tree) visit(data.tree);
  return out;
}

function harness() {
  function respond(sr) {
    const data = sr.data ?? {};
    if (`${sr.endpoint}.${sr.action}` !== 'card.select_with_attributes') {
      return { id: sr.id, ok: false, error: { code: 'unknown', message: sr.action } };
    }
    const ct = data.card_type_name;
    if (ct === 'status') {
      return {
        id: sr.id,
        ok: true,
        data: { rows: STATUSES.map((s) => ({ id: s.id, phase: s.phase, attributes: { title: s.title } })) },
      };
    }
    if (ct === 'task') {
      return { id: sr.id, ok: true, data: { rows: [{ id: '59', attributes: { title: 'Wire pickers' } }] } };
    }
    if (ct === 'comm') {
      const phases = phaseValues(data);
      const rows = COMMS.filter((c) => phases.length === 0 || phases.includes(STATUS_PHASE[c.comm_status])).map(
        (c) => ({
          id: c.id,
          card_type_name: 'comm',
          parent_card_id: c.parent_card_id,
          attributes: { title: c.title, comm_status: Number(c.comm_status) },
        }),
      );
      return { id: sr.id, ok: true, data: { rows } };
    }
    return { id: sr.id, ok: true, data: { rows: [] } };
  }
  return {
    transport: {
      async send(body) {
        const req = JSON.parse(body);
        return { status: 200, text: JSON.stringify({ subresponses: req.subrequests.map(respond) }) };
      },
    },
  };
}

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api); // defines card.select_with_attributes (+ attribute.update)
  return { dispatcher, api };
}

async function settle(dispatcher) {
  for (let i = 0; i < 6; i++) await dispatcher.flushNow();
  await flushMicrotasks();
  for (let i = 0; i < 4; i++) await dispatcher.flushNow();
  await flushMicrotasks();
}

function mount(api, phase) {
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(PROJECT);
  tree.at(['screen', 'predicate']).set(M.withTopLevelPhases(null, [phase], 'comm_status'));
  tree.at(['screen', 'search']).set('');
  tree.at(['screen', 'searchFields']).set(['title']);
  const ctx = { api, tree };
  const c = M.Control.New('CommsList', { type: 'CommsList' }, ctx);
  c.mount(document.createElement('div'));
  document.body.appendChild(c.el);
  return { c, tree };
}

test('CommsList: ACTIVE filter shows the open comm with a phase-toned badge', async () => {
  const h = harness();
  const { dispatcher, api } = bootApi(h.transport);
  const { c } = mount(api, 'active');
  await settle(dispatcher);

  const rows = [...c.el.querySelectorAll('[data-comm-row]')];
  assert.equal(rows.length, 1, 'one active comm row');
  assert.equal(rows[0].dataset.commRow, '145');
  const badge = rows[0].querySelector('[data-comm-status-badge]');
  assert.ok(badge, 'badge present');
  assert.equal(badge.dataset.phase, 'active');
  assert.equal(badge.textContent, 'Open');
  assert.match(c.el.querySelector('.comms-list__task').textContent, /#59/);
});

test('CommsList: TERMINAL filter shows the resolved comm (independent of task status)', async () => {
  const h = harness();
  const { dispatcher, api } = bootApi(h.transport);
  const { c } = mount(api, 'terminal');
  await settle(dispatcher);

  const rows = [...c.el.querySelectorAll('[data-comm-row]')];
  assert.equal(rows.length, 1, 'one terminal comm row');
  assert.equal(rows[0].dataset.commRow, '200');
  const badge = rows[0].querySelector('[data-comm-status-badge]');
  assert.equal(badge.dataset.phase, 'terminal');
  assert.equal(badge.textContent, 'Resolved');
});

test('CommsList: switching the comm_status phase filter re-queries (active → terminal)', async () => {
  const h = harness();
  const { dispatcher, api } = bootApi(h.transport);
  const { c, tree } = mount(api, 'active');
  await settle(dispatcher);
  assert.equal(c.el.querySelector('[data-comm-row]').dataset.commRow, '145');

  // Flip the phase filter to terminal — the same lever the attr-aware phase
  // toggle pulls — and the list re-queries to the resolved comm.
  tree.at(['screen', 'predicate']).set(M.withTopLevelPhases(null, ['terminal'], 'comm_status'));
  await settle(dispatcher);
  const rows = [...c.el.querySelectorAll('[data-comm-row]')];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dataset.commRow, '200');
});
