// view-persistence (#27): save/load a per-(project, slug) view to localStorage.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
const store = new Map();
before(async () => {
  installDomShim();
  // A minimal localStorage stub on globalThis (the shim doesn't provide one).
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
});
beforeEach(() => store.clear());

const sp = ['screens', '31', 'grid'];

test('saveView / loadView round-trips predicate + group + lane + columnConfig', () => {
  assert.equal(M.loadView(sp), null, 'no saved view → null');
  M.saveView(sp, {
    predicate: { kind: 'leaf', attr: 'status', op: 'in', values: ['40', '41'] },
    group: 'status',
    laneGroup: 'milestone_ref',
    columnConfig: { hidden: ['tag:priority'], order: ['id', 'title', 'status'] },
  });
  const v = M.loadView(sp);
  assert.equal(v.group, 'status');
  assert.equal(v.laneGroup, 'milestone_ref');
  assert.deepEqual(v.predicate.values, ['40', '41']);
  assert.deepEqual(v.columnConfig.hidden, ['tag:priority']);
  // Keyed by project.slug under the kitp.view. prefix.
  assert.ok([...store.keys()][0].endsWith('31.grid'));
});

test('saveView stringifies bigint card_ref values (no throw)', () => {
  M.saveView(sp, { predicate: { kind: 'leaf', attr: 'assignee', op: 'eq', values: [10n] } });
  const v = M.loadView(sp);
  assert.deepEqual(v.predicate.values, ['10'], 'bigint → string id');
});

test('loadView tolerates a missing / malformed entry', () => {
  store.set('kitp.view.31.grid', '{not json');
  assert.equal(M.loadView(sp), null, 'malformed → null, no throw');
});

test('saveView/loadView round-trips the selected preset (activeFilterId) so the View picker re-selects it', () => {
  // A named preset selection persists as a stringified id.
  M.saveView(sp, { predicate: null, activeFilterId: '404' });
  assert.equal(M.loadView(sp).activeFilterId, '404', 'preset id round-trips');

  // An explicit "Default" / ad-hoc selection persists as null (distinct from absent).
  M.saveView(sp, { predicate: null, activeFilterId: null });
  const v = M.loadView(sp);
  assert.equal('activeFilterId' in v, true, 'the key is present');
  assert.equal(v.activeFilterId, null, 'explicit Default persists as null');

  // A legacy view with no selection leaves the key ABSENT, so the screen's
  // default_filter still applies + selects on resolve (ScreenFilterBar restore).
  M.saveView(sp, { predicate: null });
  assert.equal('activeFilterId' in M.loadView(sp), false, 'absent when never selected');
});
