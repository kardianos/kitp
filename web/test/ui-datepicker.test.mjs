// DatePicker — trigger + Popover calendar. Pins: opening renders a 6×7 grid
// for the seeded month, clicking a day emits an ISO YYYY-MM-DD via onChange,
// keyboard nav moves the cursor + Enter picks, min/max disables out-of-range
// days, and Clear emits null.

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installUiDom, buildUiBundle, flushMicrotasks, keydown } from './ui-dom-setup.mjs';

let DatePicker;

before(async () => {
  installUiDom();
  const outdir = await buildUiBundle();
  ({ DatePicker } = await import(`${outdir}/ui.js`));
});

beforeEach(() => {
  document.body.replaceChildren();
});

const ctx = () => ({ api: {}, tree: {} });

function mountPicker(config) {
  const dp = new DatePicker('DatePicker', { type: 'DatePicker', ...config }, ctx());
  dp.mount(document.body);
  return dp;
}

function days() {
  return [...document.querySelectorAll('.kf-datepicker__day')];
}
function dayByNumber(n, opts = {}) {
  // Default to an in-month (non-outside) cell to avoid the leading/trailing
  // overflow days of an adjacent month with the same number.
  return days().find(
    (d) =>
      d.textContent === String(n) &&
      (opts.allowOutside || !d.classList.contains('kf-datepicker__day--outside')),
  );
}

test('open renders a 42-cell month grid seeded from the value', async () => {
  const dp = mountPicker({ value: '2026-05-15' });
  dp.openMenu();
  await flushMicrotasks();
  assert.equal(days().length, 42, '6 weeks x 7 days');
  // May 2026 -> the month label reads May 2026.
  const label = document.querySelector('.kf-datepicker__month').textContent;
  assert.match(label, /May 2026/);
  dp.destroy();
});

test('clicking a day emits an ISO YYYY-MM-DD and closes', async () => {
  let emitted;
  const dp = mountPicker({ value: '2026-05-15', onChange: (v) => (emitted = v) });
  dp.openMenu();
  await flushMicrotasks();

  dayByNumber(20).click();
  assert.equal(emitted, '2026-05-20', 'ISO date emitted for the clicked day');
  assert.equal(dp.getValue(), '2026-05-20');
  assert.equal(document.querySelectorAll('.kf-datepicker__day').length, 0, 'closed after pick');
  dp.destroy();
});

test('keyboard ArrowRight then Enter picks the next day', async () => {
  let emitted;
  const dp = mountPicker({ value: '2026-05-10', onChange: (v) => (emitted = v) });
  dp.openMenu();
  await flushMicrotasks();

  const grid = document.querySelector('.kf-datepicker__grid');
  keydown(grid, 'ArrowRight'); // cursor 10 -> 11
  keydown(grid, 'Enter');
  assert.equal(emitted, '2026-05-11', 'cursor moved one day right, Enter picked it');
  dp.destroy();
});

test('min/max clamp disables out-of-range days', async () => {
  const dp = mountPicker({ value: '2026-05-15', min: '2026-05-10', max: '2026-05-20' });
  dp.openMenu();
  await flushMicrotasks();

  const d5 = dayByNumber(5);
  const d15 = dayByNumber(15);
  const d25 = dayByNumber(25);
  assert.equal(d5.disabled, true, 'day before min disabled');
  assert.equal(d15.disabled, false, 'in-range day enabled');
  assert.equal(d25.disabled, true, 'day after max disabled');

  // Clicking a disabled day must not emit.
  let emitted = 'unset';
  dp.config.onChange = (v) => (emitted = v);
  d5.click();
  assert.equal(emitted, 'unset', 'disabled day click is a no-op');
  dp.destroy();
});

test('Clear emits null and Today picks the current date', async () => {
  let emitted = 'unset';
  const dp = mountPicker({ value: '2026-05-15', onChange: (v) => (emitted = v) });
  dp.openMenu();
  await flushMicrotasks();

  document.querySelector('[data-dp-clear]').click();
  assert.equal(emitted, null, 'Clear emits null');
  assert.equal(dp.getValue(), null);

  // Today: reopen and click Today; emits an ISO matching now (local).
  dp.openMenu();
  await flushMicrotasks();
  document.querySelector('[data-dp-today]').click();
  const now = new Date();
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  assert.equal(emitted, iso, 'Today emits the current local ISO date');
  dp.destroy();
});
