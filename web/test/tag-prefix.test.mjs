import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
before(async () => {
  installDomShim(); // the app barrel transitively imports the markdown sink (needs a window)
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
});

test('tagLeaf: returns the last path segment', () => {
  assert.equal(M.tagLeaf('priority/high'), 'high');
  assert.equal(M.tagLeaf('high'), 'high');
  assert.equal(M.tagLeaf('a/b/c'), 'c');
  assert.equal(M.tagLeaf(''), '');
});

test('tagRootLabel: capitalises the root', () => {
  assert.equal(M.tagRootLabel('priority'), 'Priority');
  assert.equal(M.tagRootLabel('area'), 'Area');
  assert.equal(M.tagRootLabel(''), '');
});

test('option value round-trips a tag prefix; non-prefix values yield null', () => {
  const v = M.tagPrefixOptionValue('priority');
  assert.equal(v, 'tagpfx:priority');
  assert.equal(M.tagPrefixFromOptionValue(v), 'priority');
  assert.equal(M.tagPrefixFromOptionValue('status'), null, 'a plain attr name is not a prefix');
  assert.equal(M.tagPrefixFromOptionValue('tagpfx:'), null, 'empty root is not a prefix');
  assert.equal(M.tagPrefixFromOptionValue(null), null);
});

test('exclusiveRoots: distinct non-empty roots in first-seen order', () => {
  const rows = [
    { rootExclusiveAt: 'priority' },
    { rootExclusiveAt: '' }, // area/platform tags carry no exclusive root
    { rootExclusiveAt: 'priority' }, // dup
    { rootExclusiveAt: 'severity' },
    {}, // missing
  ];
  assert.deepEqual(M.exclusiveRoots(rows), ['priority', 'severity']);
});

test('tagIdUnderRoot: finds the card tag whose root matches; null when none', () => {
  // rootById: tag-id → its exclusive root. 108=priority/high, 110=area/be (no root), 109=priority/low.
  const rootById = new Map([
    ['108', 'priority'],
    ['109', 'priority'],
    ['110', ''],
  ]);
  // bigint ids (the revived wire form)
  assert.equal(M.tagIdUnderRoot([110n, 108n], rootById, 'priority'), '108', 'picks the priority tag');
  // digit-string ids (un-revived form) also resolve
  assert.equal(M.tagIdUnderRoot(['110', '109'], rootById, 'priority'), '109');
  // a card with no priority tag → null (lands in the unset column)
  assert.equal(M.tagIdUnderRoot([110n], rootById, 'priority'), null);
  // non-array / empty
  assert.equal(M.tagIdUnderRoot(undefined, rootById, 'priority'), null);
  assert.equal(M.tagIdUnderRoot([], rootById, 'priority'), null);
});
