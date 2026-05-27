// activity-labels: data-driven resolution of card_ref ids in activity rows to
// titles ("milestone from bob to sally", not "#234 to #456"). Pure mapping +
// the per-type card.search fan-out (#2, shared with the Activity page #1).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
before(async () => {
  installDomShim();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
});

const SCHEMA = [
  { name: 'milestone_ref', label: 'Milestone', valueType: 'card_ref', targetCardType: 'milestone' },
  { name: 'status', label: 'Status', valueType: 'card_ref', targetCardType: 'status' },
  { name: 'tags', label: 'Tags', valueType: 'card_ref[]', targetCardType: 'tag' },
  { name: 'title', label: 'Title', valueType: 'text' },
];

const row = (o) => ({ id: 1n, cardId: 9n, actorId: 5n, createdAt: '', ...o });

test('attrNameToTargetType maps only card_ref attrs to their target card_type', () => {
  const m = M.attrNameToTargetType(SCHEMA);
  assert.equal(m.get('milestone_ref'), 'milestone');
  assert.equal(m.get('status'), 'status');
  assert.equal(m.get('tags'), 'tag');
  assert.equal(m.has('title'), false, 'text attrs are not ref types');
});

test('collectRefIdsByType groups attr_update + tag rows by target card_type', () => {
  const m = M.attrNameToTargetType(SCHEMA);
  const rows = [
    row({ id: 1n, kind: 'attr_update', attributeName: 'milestone_ref', valueOld: 234n, valueNew: 456n }),
    row({ id: 2n, kind: 'tag_apply', valueOld: [], valueNew: [12n, 13n] }),
    row({ id: 3n, kind: 'attr_update', attributeName: 'title', valueOld: 'a', valueNew: 'b' }),
  ];
  const byType = M.collectRefIdsByType(rows, m);
  assert.deepEqual([...byType.get('milestone')].sort(), ['234', '456']);
  assert.deepEqual([...byType.get('tag')].sort(), ['12', '13']);
  assert.equal(byType.has('title'), false, 'text attr ids are not collected');
});

test('loadActivityLabels fans out card.search per type → cardTitles + tagPaths', () => {
  const m = M.attrNameToTargetType(SCHEMA);
  const rows = [
    row({ id: 1n, kind: 'attr_update', attributeName: 'milestone_ref', valueOld: 234n, valueNew: 456n }),
    row({ id: 2n, kind: 'tag_apply', valueOld: [], valueNew: [12n] }),
  ];
  const titlesByType = {
    milestone: { 234: 'Q1', 456: 'Q2' },
    tag: { 12: 'urgent' },
  };
  // A fake api whose callByName synchronously answers card.search per type.
  const seen = [];
  const fakeApi = {
    callByName(_spec, input, onOk) {
      seen.push(input.cardTypeName);
      const out = Object.entries(titlesByType[input.cardTypeName] ?? {}).map(([id, title]) => ({ id: BigInt(id), title }));
      onOk({ rows: out });
      return '';
    },
  };
  let maps = null;
  M.loadActivityLabels(fakeApi, rows, m, (out) => { maps = out; });
  assert.deepEqual(seen.sort(), ['milestone', 'tag'], 'one card.search per referenced type');
  assert.equal(maps.cardTitles['234'], 'Q1');
  assert.equal(maps.cardTitles['456'], 'Q2');
  assert.equal(maps.tagPaths['12'], 'urgent', 'tag titles land in tagPaths, not cardTitles');
  assert.equal(maps.cardTitles['12'], undefined);
});

test('loadActivityLabels with no ref rows resolves to empty maps immediately', () => {
  const m = M.attrNameToTargetType(SCHEMA);
  let maps = null;
  M.loadActivityLabels({ callByName() { throw new Error('should not be called'); } },
    [row({ id: 1n, kind: 'comment', commentBody: 'hi' })], m, (out) => { maps = out; });
  assert.deepEqual(maps, { cardTitles: {}, tagPaths: {} });
});
