/**
 * AttributeRow — the unified attribute panel row driven by a single
 * `LoadState<unknown>` thunk (ARCHITECTURE.md §13).
 *
 * The tests pin the lifecycle contract: every visible surface — summary,
 * Unassign disabled, busy class, inline error — derives from ONE state
 * read.  No more divergence between sub-states; no flicker as the value
 * swings during an in-flight commit.
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
});

beforeEach(() => {
  document.body.replaceChildren();
});

function mountRow(attr, opts) {
  const tree = new M.TreeNode({}, []);
  const api = { callByName: () => {} };
  const ctx = { api, tree };
  const cfg = { type: 'AttributeRow', attr, ...opts };
  const row = M.Control.New('AttributeRow', cfg, ctx);
  const host = document.createElement('div');
  document.body.appendChild(host);
  row.mount(host);
  return row;
}

/* -------------------------------------------------------------------------- */

test('AttributeRow.computeSummary: card_ref / card_ref[] / bool / scalar', () => {
  const { computeSummary } = M;
  assert.equal(computeSummary({ valueType: 'card_ref' }, 7n, (id) => `name${id}`), 'name7');
  assert.equal(
    computeSummary({ valueType: 'card_ref' }, '7', (id) => `name${id}`),
    'name7',
    'digit-string ref coerced via asAttrId',
  );
  assert.equal(computeSummary({ valueType: 'card_ref' }, null), '—');
  assert.equal(
    computeSummary({ valueType: 'card_ref[]' }, [1n, 2n], (id) => `t${id}`),
    't1, t2',
  );
  assert.equal(computeSummary({ valueType: 'card_ref[]' }, []), '—');
  assert.equal(computeSummary({ valueType: 'bool' }, true), 'Yes');
  assert.equal(computeSummary({ valueType: 'bool' }, false), 'No');
  assert.equal(computeSummary({ valueType: 'text' }, 'hello'), 'hello');
  assert.equal(computeSummary({ valueType: 'number' }, 42), '42');
  assert.equal(computeSummary({ valueType: 'text' }, ''), '—');
});

test('AttributeRow.hasMeaningfulValue: empty array / null / "" all yield false', () => {
  const { hasMeaningfulValue } = M;
  assert.equal(hasMeaningfulValue('a'), true);
  assert.equal(hasMeaningfulValue(0), true);
  assert.equal(hasMeaningfulValue(false), true);
  assert.equal(hasMeaningfulValue(null), false);
  assert.equal(hasMeaningfulValue(undefined), false);
  assert.equal(hasMeaningfulValue(''), false);
  assert.equal(hasMeaningfulValue([]), false);
  assert.equal(hasMeaningfulValue([1n]), true);
});

test('AttributeRow: summary follows a signal-backed state REACTIVELY', async () => {
  const { signal, loaded, flushSync } = M;
  const state = signal(loaded('first draft'));
  const row = mountRow(
    { name: 'title', label: 'Title', valueType: 'text' },
    { state: () => state.get(), onCommit: () => {} },
  );
  await flushMicrotasks();
  const valueEl = row.el.querySelector('[data-attr-value]');
  assert.equal(valueEl.textContent, 'first draft', 'initial summary');

  state.set(loaded('second draft'));
  flushSync();
  assert.equal(valueEl.textContent, 'second draft', 'reactive repaint without parent rebuild');
});

test('AttributeRow: Unassign locks during Pending (no flicker mid-commit)', async () => {
  const { signal, Unset, loaded, pendingValue, flushSync } = M;
  // The full lifecycle: Unset → Pending → Value → Pending → ...
  // Unassign must stay disabled through Pending (regression: previously it
  // briefly flickered enabled because the renderer read value() === null).
  const state = signal(Unset);
  const row = mountRow(
    { name: 'milestone_ref', label: 'Milestone', valueType: 'card_ref', targetCardType: 'milestone' },
    { state: () => state.get(), onCommit: () => {} },
  );
  await flushMicrotasks();
  const unassign = row.el.querySelector('[data-attr-unassign]');
  assert.equal(unassign.disabled, true, 'disabled in Unset');

  state.set(loaded(42n));
  flushSync();
  assert.equal(unassign.disabled, false, 'enabled when value resolves');

  // Begin an in-flight commit — Pending(value).  The button is BUSY until the
  // commit resolves, NOT enabled-then-disabled-then-enabled as the raw value
  // swings.  This is the regression the LoadState refactor exists to fix.
  state.set(pendingValue(43n));
  flushSync();
  assert.equal(unassign.disabled, true, 'disabled mid-commit (Pending state)');
  assert.equal(
    row.el.getAttribute('data-attr-state'),
    'pending',
    'data-attr-state mirrors the lifecycle for styling',
  );
  assert.equal(
    row.el.classList.contains('task-detail__row--pending'),
    true,
    'busy class set on the row',
  );

  state.set(loaded(43n));
  flushSync();
  assert.equal(unassign.disabled, false, 'enabled when the commit lands');
  assert.equal(row.el.getAttribute('data-attr-state'), 'value');
});

test('AttributeRow: Error state shows the inline message + reverts the row', async () => {
  const { signal, loaded, errored, flushSync } = M;
  const state = signal(loaded('prior'));
  const row = mountRow(
    { name: 'title', label: 'Title', valueType: 'text' },
    { state: () => state.get(), onCommit: () => {} },
  );
  await flushMicrotasks();
  const errEl = row.el.querySelector('[data-attr-error]');
  assert.equal(errEl.style.display, 'none', 'error hidden in Value state');

  state.set(errored('Failed to save.', 'prior'));
  flushSync();
  assert.equal(errEl.textContent, 'Failed to save.', 'message rendered from state.message');
  assert.notEqual(errEl.style.display, 'none', 'error visible in Error state');
  assert.equal(
    row.el.getAttribute('data-attr-state'),
    'error',
    'data-attr-state mirrors the Error lifecycle',
  );

  // The summary shows the REVERTED value (the carried `prior`).
  const valueEl = row.el.querySelector('[data-attr-value]');
  assert.equal(valueEl.textContent, 'prior', 'summary reverts to the carried fallback');

  // Recovering to Value clears the error display.
  state.set(loaded('prior'));
  flushSync();
  assert.equal(errEl.style.display, 'none', 'error hidden again after recovery');
});

test('AttributeRow: Mixed renders "[mixed]" placeholder + enables Unassign (flatten gesture)', async () => {
  const { signal, Mixed, loaded, flushSync } = M;
  // The selection-disagreement state (batch edit only — single-card panels
  // never produce it).  AttributeRow has ONE consistent rendering for it.
  const state = signal(Mixed);
  const row = mountRow(
    { name: 'milestone_ref', label: 'Milestone', valueType: 'card_ref', targetCardType: 'milestone' },
    { state: () => state.get(), onCommit: () => {} },
  );
  await flushMicrotasks();
  const valueEl = row.el.querySelector('[data-attr-value]');
  assert.equal(valueEl.textContent, '[mixed]', 'placeholder for heterogeneous selection');
  assert.equal(row.el.getAttribute('data-attr-state'), 'mixed');
  assert.equal(
    row.el.classList.contains('task-detail__row--mixed'),
    true,
    'mixed CSS hook on the row',
  );
  const unassign = row.el.querySelector('[data-attr-unassign]');
  assert.equal(
    unassign.disabled,
    false,
    'Unassign IS enabled in Mixed — user is choosing to flatten to empty',
  );

  // Recovering to a homogeneous Value clears the mixed class.
  state.set(loaded(99n));
  flushSync();
  assert.equal(valueEl.textContent, '#99', 'rendered the homogeneous id (no labelFor)');
  assert.equal(
    row.el.classList.contains('task-detail__row--mixed'),
    false,
    'mixed hook off again',
  );
});

test('AttributeRow: bool valueType skips Unassign (checkbox covers both states)', async () => {
  const { loaded } = M;
  const row = mountRow(
    { name: 'is_active', label: 'Active', valueType: 'bool' },
    { state: () => loaded(false), onCommit: () => {} },
  );
  await flushMicrotasks();
  assert.equal(row.el.querySelector('[data-attr-unassign]'), null);
});

test('AttributeRow: Unassign click fires onCommit(null)', async () => {
  const { loaded } = M;
  const commits = [];
  const row = mountRow(
    { name: 'assignee', label: 'Assignee', valueType: 'card_ref', targetCardType: 'person' },
    { state: () => loaded(1n), onCommit: (v) => commits.push(v) },
  );
  await flushMicrotasks();
  const unassign = row.el.querySelector('[data-attr-unassign]');
  unassign.click();
  assert.deepEqual(commits, [null]);
});

test('AttributeRow: FieldEditor mounts LAZILY on first expand, persists across re-expand', async () => {
  const { loaded } = M;
  const row = mountRow(
    { name: 'title', label: 'Title', valueType: 'text' },
    { state: () => loaded('hi'), onCommit: () => {} },
  );
  await flushMicrotasks();
  assert.equal(row.el.querySelector('[data-control="FieldEditor"]'), null);

  row.el.setAttribute('open', '');
  row.el.open = true;
  row.el.dispatchEvent(new globalThis.window.Event('toggle', { bubbles: true }));
  await flushMicrotasks();
  assert.ok(row.el.querySelector('[data-control="FieldEditor"]'), 'FieldEditor spawned on expand');

  row.el.removeAttribute('open');
  row.el.open = false;
  row.el.dispatchEvent(new globalThis.window.Event('toggle', { bubbles: true }));
  row.el.setAttribute('open', '');
  row.el.open = true;
  row.el.dispatchEvent(new globalThis.window.Event('toggle', { bubbles: true }));
  await flushMicrotasks();
  assert.equal(
    row.el.querySelectorAll('[data-control="FieldEditor"]').length,
    1,
    'one FieldEditor after collapse + re-expand',
  );
});
