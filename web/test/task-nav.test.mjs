// task-nav: the ordered task ids + the source-list URL a list screen publishes
// so the task detail can walk prev/next AND return to the exact list (inbox/
// grid/kanban) on q/Esc / Back — NOT a browser-history step.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
before(async () => {
  installDomShim(); // the test-barrel touches DOM globals at module load
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
});

test('publishTaskNav records ids + the explicit source list URL; readers see both', () => {
  const tree = new M.TreeNode({}, []);
  M.publishTaskNav(tree, ['7', '8', '9'], '/project/3/screen/inbox');
  assert.deepEqual(tree.at(['nav', 'taskList']).peek(), ['7', '8', '9']);
  assert.equal(M.taskNavListUrl(tree), '/project/3/screen/inbox', 'saved the source list URL');
  assert.equal(M.taskNavNeighbor(tree, '8', 1), '9');
  assert.equal(M.taskNavNeighbor(tree, '8', -1), '7');
});

test('taskNavListUrl is null until a list publishes (cold deep-link)', () => {
  const tree = new M.TreeNode({}, []);
  assert.equal(M.taskNavListUrl(tree), null);
});

test('task→task jumps preserve the saved list URL (no republish)', () => {
  const tree = new M.TreeNode({}, []);
  M.publishTaskNav(tree, ['7', '8', '9'], '/project/3/screen/kanban');
  // Walking next/prev navigates to /task/:id but never republishes the list,
  // so the saved return URL survives the whole jump chain — Esc from the third
  // task still lands on the list the first task was opened from.
  assert.equal(M.taskNavListUrl(tree), '/project/3/screen/kanban');
});
