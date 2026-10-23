// MenuFilter — the inline "contains" search over a long dropdown list. Pins
// the matching rule (shared with Combobox), the length threshold, section
// headings, the "No matches" note and the keyboard path (↓ into the rows, ↑
// back out, Enter picks the first match, typing on a row returns to the
// field). Also pins the Popover default that lets every panel scroll.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installUiDom, buildUiBundle, keydown } from './ui-dom-setup.mjs';

let MenuFilter, labelMatches, MENU_FILTER_MIN_ITEMS, Popover;

before(async () => {
  installUiDom();
  const outdir = await buildUiBundle();
  ({ MenuFilter, labelMatches, MENU_FILTER_MIN_ITEMS, Popover } = await import(`${outdir}/ui.js`));
});

beforeEach(() => {
  document.body.replaceChildren();
});

/** A menu: optional section headings, one button row per label. */
function menu(sections) {
  const list = document.createElement('ul');
  const picked = [];
  for (const [heading, labels] of sections) {
    if (heading !== null) {
      const h = document.createElement('li');
      h.dataset.menuSection = '';
      h.textContent = heading;
      list.append(h);
    }
    for (const label of labels) {
      const li = document.createElement('li');
      li.dataset.menuItem = label;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = `✓ ${label} 12`; // glyphs + counts must not match
      btn.addEventListener('click', () => picked.push(label));
      li.append(btn);
      list.append(li);
    }
  }
  const filter = new MenuFilter(list);
  const panel = document.createElement('div');
  panel.append(filter.el, list);
  document.body.append(panel);
  filter.apply();
  return { list, filter, picked };
}

const shown = (list) =>
  [...list.querySelectorAll('[data-menu-item]')].filter((li) => li.style.display !== 'none').map((li) => li.dataset.menuItem);

const TAGS = ['area/billing/ui', 'area/billing/backend', 'area/sync/ui', 'area/sync/data', 'platform/ios', 'platform/android', 'severity/one', 'severity/two'];

test('labelMatches: case-insensitive, every term must appear', () => {
  assert.equal(labelMatches('area/billing/ui', ''), true);
  assert.equal(labelMatches('area/billing/ui', '  '), true);
  assert.equal(labelMatches('area/billing/ui', 'BILL'), true);
  assert.equal(labelMatches('area/billing/ui', 'area ui'), true, 'terms in any position');
  assert.equal(labelMatches('area/billing/ui', 'ui area'), true, 'and any order');
  assert.equal(labelMatches('area/billing/ui', 'area ios'), false, 'every term must match');
});

test('the field shows only for a long list', () => {
  const short = menu([[null, TAGS.slice(0, MENU_FILTER_MIN_ITEMS - 1)]]);
  assert.equal(short.filter.el.style.display, 'none', 'a short list has no field');
  const long = menu([[null, TAGS.slice(0, MENU_FILTER_MIN_ITEMS)]]);
  assert.equal(long.filter.el.style.display, '', 'a long list gets the field');
});

test('a query hides non-matching rows, matching the label not the row text', () => {
  const { list, filter } = menu([[null, TAGS]]);
  filter.setQuery('sync');
  assert.deepEqual(shown(list), ['area/sync/ui', 'area/sync/data']);
  filter.setQuery('12');
  assert.deepEqual(shown(list), [], 'the count in the row text is not matched');
  assert.equal(filter.el.querySelector('.kf-menu-filter__empty').style.display, '', '"No matches" shows');
  filter.reset();
  filter.apply();
  assert.equal(shown(list).length, TAGS.length, 'reset clears the query');
  assert.equal(filter.el.querySelector('.kf-menu-filter__empty').style.display, 'none');
});

test('a section heading hides while none of its rows match', () => {
  const { list, filter } = menu([
    ['Attributes', ['Assignee', 'Status', 'Tags', 'Milestone']],
    ['Presets', ['Overdue', 'Due soon', 'Mine', 'Heads']],
  ]);
  const headings = () => [...list.querySelectorAll('[data-menu-section]')].map((h) => h.style.display !== 'none');
  filter.setQuery('due');
  assert.deepEqual(shown(list), ['Overdue', 'Due soon']);
  assert.deepEqual(headings(), [false, true]);
  filter.setQuery('');
  assert.deepEqual(headings(), [true, true]);
});

test('apply() after a re-render keeps the query applied', () => {
  const { list, filter } = menu([[null, TAGS]]);
  filter.setQuery('platform');
  // The owner repaints its rows (e.g. after a pick) and calls apply().
  for (const li of [...list.children]) li.style.display = '';
  filter.apply();
  assert.deepEqual(shown(list), ['platform/ios', 'platform/android']);
});

test('keys: ↓ into the rows, ↑ back to the field, Enter picks the first match', () => {
  const { list, filter, picked } = menu([[null, TAGS]]);
  const input = filter.el.querySelector('input');
  assert.equal(filter.focus(), true);
  assert.equal(document.activeElement, input);
  filter.setQuery('platform');

  keydown(input, 'ArrowDown');
  assert.equal(document.activeElement.parentElement.dataset.menuItem, 'platform/ios');
  keydown(document.activeElement, 'ArrowDown');
  assert.equal(document.activeElement.parentElement.dataset.menuItem, 'platform/android', 'skips hidden rows');
  keydown(document.activeElement, 'ArrowUp');
  keydown(document.activeElement, 'ArrowUp');
  assert.equal(document.activeElement, input, '↑ off the first row returns to the field');

  keydown(input, 'Enter');
  assert.deepEqual(picked, ['platform/ios']);
  assert.equal(document.activeElement, input, 'focus stays in the field');
});

test('typing on a row moves focus to the field', () => {
  const { list, filter } = menu([[null, TAGS]]);
  list.querySelector('button').focus();
  keydown(document.activeElement, 'x');
  assert.equal(document.activeElement, filter.el.querySelector('input'));
});

test('Enter with an empty query picks nothing', () => {
  const { filter, picked } = menu([[null, TAGS]]);
  keydown(filter.el.querySelector('input'), 'Enter');
  assert.deepEqual(picked, []);
});

test('Popover panels scroll by default; clampHeight:false opts out', () => {
  const anchor = document.createElement('button');
  document.body.append(anchor);
  const a = new Popover(anchor);
  const b = new Popover(anchor, { clampHeight: false });
  assert.ok(a.element.classList.contains('kf-popover--scroll'));
  assert.ok(!b.element.classList.contains('kf-popover--scroll'));
  a.destroy();
  b.destroy();
});
