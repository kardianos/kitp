/**
 * Watch lists (docs/WATCH_LISTS.md):
 *   - WatchBar: the corner bookmarks — one button per list (its symbol, the
 *     name to slide out), lit when the card is on it; a click toggles it
 *     through watch.set and puts the button back if the write fails; ⋯ goes
 *     to Watch lists;
 *   - WatchLists: the screen — lists on the left (pick one, + New list),
 *     the picked one's form (Save, Delete asks once) and its items in order;
 *     ↑ / ↓ and a drag move an item (watch.move with a sort_order between
 *     its new neighbours), Remove takes it off;
 *   - helpers: sortOrderForSlot, watchItemHref, watchListOptions,
 *     listFromSearch; the filter's watch_list field and its option source;
 *     the route and its help topic.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom, flushMicrotasks } from './ui-dom-setup.mjs';

let M;
let calls;
let lists;
let items;
let failSet;

function reset() {
  calls = [];
  failSet = false;
  lists = [
    { id: '10', title: 'Stars', symbol: '★', description: '', count: 2, has_card: true },
    { id: '11', title: 'Waiting', symbol: '⏳', description: 'Chase', count: 0, has_card: false },
  ];
  items = [
    { card_id: '101', card_type: 'task', title: 'One', task_id: '0', project_id: '7', project_title: 'Launch', status: 'Todo', phase: 'active', sort_order: -3, added_at: '2026-11-03T10:00:00Z' },
    { card_id: '102', card_type: 'comm', title: 'Re: invoice', task_id: '101', project_id: '7', project_title: 'Launch', status: 'Open', phase: 'active', sort_order: -2, added_at: '2026-11-03T09:00:00Z' },
    { card_id: '103', card_type: 'comm', title: 'Lone thread', task_id: '0', project_id: '7', project_title: 'Launch', status: '', phase: '', sort_order: -1, added_at: '2026-11-03T08:00:00Z' },
  ];
}

before(async () => {
  installUiDom();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerWatchBar();
  M.registerWatchLists();
});

beforeEach(() => {
  document.body.replaceChildren();
  reset();
});

function respond(sr) {
  const k = `${sr.endpoint}.${sr.action}`;
  const data = sr.data ?? {};
  calls.push({ k, data });
  if (k === 'watch_list.list') return { id: sr.id, ok: true, data: { lists } };
  if (k === 'watch.items') return { id: sr.id, ok: true, data: { items } };
  if (k === 'watch.set') {
    if (failSet) return { id: sr.id, ok: false, error: { code: 'card_not_found', message: 'no' } };
    return { id: sr.id, ok: true, data: { on: data.on } };
  }
  if (k === 'watch.move') return { id: sr.id, ok: true, data: { sort_order: data.sort_order } };
  if (k === 'watch_list.set') return { id: sr.id, ok: true, data: { id: data.id ?? '12' } };
  if (k === 'watch_list.delete') return { id: sr.id, ok: true, data: { id: data.id } };
  return { id: sr.id, ok: false, error: { code: 'unknown', message: k } };
}

function bootApi() {
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      return { status: 200, text: JSON.stringify({ subresponses: req.subrequests.map(respond) }) };
    },
  };
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerWatchSpecs(api);
  return { dispatcher, api };
}

async function settle(dispatcher) {
  for (let i = 0; i < 6; i++) await dispatcher.flushNow();
  await flushMicrotasks();
  for (let i = 0; i < 4; i++) await dispatcher.flushNow();
  await flushMicrotasks();
}

function mount(api, type, extra = {}) {
  const tree = new M.TreeNode({}, []);
  const c = M.Control.New(type, { type, ...extra }, { api, tree });
  c.mount(document.createElement('div'));
  document.body.appendChild(c.el);
  return c;
}

/* -------------------------------- WatchBar -------------------------------- */

test('WatchBar: a button per list, lit when the card is on it, with the name to slide out', async () => {
  const { dispatcher, api } = bootApi();
  const c = mount(api, 'WatchBar', { cardId: '101' });
  await settle(dispatcher);
  assert.deepEqual(calls.find((x) => x.k === 'watch_list.list').data, { card_id: '101' });
  const stars = c.el.querySelector('[data-watch-list="10"]');
  const waiting = c.el.querySelector('[data-watch-list="11"]');
  assert.equal(stars.querySelector('.watch-bar__symbol').textContent, '★');
  assert.equal(stars.querySelector('.watch-bar__name').textContent, 'Stars');
  assert.equal(stars.getAttribute('aria-pressed'), 'true');
  assert.equal(waiting.getAttribute('aria-pressed'), 'false');
  const manage = c.el.querySelector('[data-watch-manage]');
  assert.equal(manage.getAttribute('href'), M.WATCH_LISTS_PATH);
});

test('WatchBar: a click puts the card on a list (or takes it off); a failed write puts the button back', async () => {
  const { dispatcher, api } = bootApi();
  const c = mount(api, 'WatchBar', { cardId: '101' });
  await settle(dispatcher);
  const waiting = c.el.querySelector('[data-watch-list="11"]');
  waiting.click();
  assert.equal(waiting.getAttribute('aria-pressed'), 'true', 'lit at once');
  await settle(dispatcher);
  assert.deepEqual(calls.find((x) => x.k === 'watch.set').data, { watch_list_id: '11', card_id: '101', on: true });

  const stars = c.el.querySelector('[data-watch-list="10"]');
  failSet = true;
  stars.click();
  assert.equal(stars.getAttribute('aria-pressed'), 'false');
  await settle(dispatcher);
  assert.equal(stars.getAttribute('aria-pressed'), 'true', 'back on after the failure');
});

test('WatchBar: an account with no lists shows nothing', async () => {
  lists = [];
  const { dispatcher, api } = bootApi();
  const c = mount(api, 'WatchBar', { cardId: '101' });
  await settle(dispatcher);
  assert.equal(c.el.children.length, 0);
});

/* ------------------------------- WatchLists ------------------------------- */

test('WatchLists: the lists, the picked one and its items in order, each opening its card', async () => {
  const { dispatcher, api } = bootApi();
  const c = mount(api, 'WatchLists');
  await settle(dispatcher);
  const picks = [...c.el.querySelectorAll('[data-watch-list-pick]')];
  assert.deepEqual(picks.map((p) => p.dataset.watchListPick), ['10', '11']);
  assert.equal(picks[0].getAttribute('aria-current'), 'true', 'the first list is picked');
  assert.deepEqual(calls.find((x) => x.k === 'watch.items').data, { watch_list_id: '10' });
  const rows = [...c.el.querySelectorAll('[data-watch-item]')];
  assert.deepEqual(rows.map((r) => r.dataset.watchItem), ['101', '102', '103']);
  const hrefs = rows.map((r) => r.querySelector('.watch-lists__item-title').getAttribute('href'));
  assert.deepEqual(hrefs, ['/task/101', '/task/101', '/thread/103'], 'a thread opens on its task, or its own page');
  assert.equal(c.el.querySelector('[data-watch-symbol]').value, '★');
  assert.equal(c.el.querySelector('[data-watch-title]').value, 'Stars');
});

test('WatchLists: ↓ moves an item one place with a sort_order between its new neighbours', async () => {
  const { dispatcher, api } = bootApi();
  const c = mount(api, 'WatchLists');
  await settle(dispatcher);
  c.el.querySelector('[data-watch-item="101"] [data-watch-step="down"]').click();
  assert.deepEqual([...c.el.querySelectorAll('[data-watch-item]')].map((r) => r.dataset.watchItem), ['102', '101', '103']);
  await settle(dispatcher);
  const move = calls.find((x) => x.k === 'watch.move');
  assert.deepEqual(move.data, { watch_list_id: '10', card_id: '101', sort_order: -1.5 });
  // The last one can't go further down.
  const before = calls.length;
  c.el.querySelector('[data-watch-item="103"] [data-watch-step="down"]').click();
  await settle(dispatcher);
  assert.equal(calls.filter((x) => x.k === 'watch.move').length, 1, 'no second move');
  assert.ok(calls.length >= before);
});

test('WatchLists: a drag drops an item where the pointer is', async () => {
  const { dispatcher, api } = bootApi();
  const c = mount(api, 'WatchLists');
  await settle(dispatcher);
  const rowsEl = c.el.querySelector('[data-watch-items]');
  const rows = [...rowsEl.querySelectorAll('[data-watch-item]')];
  // Lay the rows out 30px apart (jsdom has no layout).
  rows.forEach((r, i) => {
    r.getBoundingClientRect = () => ({ top: i * 30, bottom: i * 30 + 30, height: 30, left: 0, right: 100, width: 100 });
  });
  rowsEl.getBoundingClientRect = () => ({ top: 0, bottom: 90, height: 90, left: 0, right: 100, width: 100 });
  const handle = c.el.querySelector('[data-watch-drag="103"]');
  const ev = (type, y) => {
    const e = new globalThis.window.Event(type, { bubbles: true, cancelable: true });
    e.clientY = y;
    e.dataTransfer = { setData() {}, effectAllowed: '' };
    return e;
  };
  handle.dispatchEvent(ev('dragstart', 75));
  rowsEl.dispatchEvent(ev('dragover', 5));
  rowsEl.dispatchEvent(ev('drop', 5));
  assert.deepEqual([...c.el.querySelectorAll('[data-watch-item]')].map((r) => r.dataset.watchItem), ['103', '101', '102']);
  await settle(dispatcher);
  assert.deepEqual(calls.find((x) => x.k === 'watch.move').data, { watch_list_id: '10', card_id: '103', sort_order: -4 });
});

test('WatchLists: Remove takes an item off; Save writes the form; Delete asks once', async () => {
  const { dispatcher, api } = bootApi();
  const c = mount(api, 'WatchLists');
  await settle(dispatcher);
  c.el.querySelector('[data-watch-remove="102"]').click();
  assert.equal(c.el.querySelector('[data-watch-item="102"]'), null);
  await settle(dispatcher);
  assert.deepEqual(calls.find((x) => x.k === 'watch.set').data, { watch_list_id: '10', card_id: '102', on: false });

  c.el.querySelector('[data-watch-title]').value = 'Starred';
  c.el.querySelector('[data-watch-symbol]').value = '⭐';
  c.el.querySelector('[data-watch-description]').value = 'Mine';
  c.el.querySelector('[data-watch-save]').click();
  await settle(dispatcher);
  assert.deepEqual(calls.find((x) => x.k === 'watch_list.set').data, { id: '10', title: 'Starred', symbol: '⭐', description: 'Mine' });

  c.el.querySelector('[data-watch-delete]').click();
  assert.equal(calls.filter((x) => x.k === 'watch_list.delete').length, 0, 'asks first');
  c.el.querySelector('[data-watch-delete-confirm]').click();
  await settle(dispatcher);
  assert.deepEqual(calls.find((x) => x.k === 'watch_list.delete').data, { id: '10' });
});

test('WatchLists: the symbol picker — a pick fills the box and is marked; Save writes it; a typed symbol still works', async () => {
  const { dispatcher, api } = bootApi();
  const c = mount(api, 'WatchLists');
  await settle(dispatcher);
  const allPicks = () => [...c.el.querySelectorAll('[data-watch-symbol-pick]')];
  const picks = allPicks();
  assert.ok(picks.length >= 36, `offers at least 36 symbols (got ${picks.length})`);
  assert.equal(new Set(picks.map((b) => b.dataset.watchSymbolPick)).size, picks.length, 'no symbol twice');
  for (const b of picks) assert.notEqual(b.getAttribute('aria-label'), '', 'each pick is named');
  const pressed = () => allPicks().filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.watchSymbolPick);
  assert.deepEqual(pressed(), ['★'], "the list's own symbol is marked");

  c.el.querySelector('[data-watch-symbol-pick="🚀"]').click();
  assert.equal(c.el.querySelector('[data-watch-symbol]').value, '🚀');
  assert.deepEqual(pressed(), ['🚀']);
  c.el.querySelector('[data-watch-save]').click();
  await settle(dispatcher);
  assert.equal(calls.find((x) => x.k === 'watch_list.set').data.symbol, '🚀');

  // Save reloads the lists and paints the form again: the box is a new one.
  const box = c.el.querySelector('[data-watch-symbol]');
  box.value = '🦄';
  box.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }));
  assert.deepEqual(pressed(), [], 'a custom symbol marks no pick');
  c.el.querySelector('[data-watch-save]').click();
  await settle(dispatcher);
  assert.equal(calls.filter((x) => x.k === 'watch_list.set').at(-1).data.symbol, '🦄');
});

test('WatchLists: an empty name is refused on the page', async () => {
  const { dispatcher, api } = bootApi();
  const c = mount(api, 'WatchLists');
  await settle(dispatcher);
  c.el.querySelector('[data-watch-title]').value = ' ';
  c.el.querySelector('[data-watch-save]').click();
  await settle(dispatcher);
  assert.equal(calls.filter((x) => x.k === 'watch_list.set').length, 0);
  assert.match(c.el.querySelector('.watch-lists__error').textContent, /symbol and a name/);
});

test('WatchLists: + New list makes one and picks it', async () => {
  const { dispatcher, api } = bootApi();
  const c = mount(api, 'WatchLists');
  await settle(dispatcher);
  lists = [...lists, { id: '12', title: 'List 3', symbol: '🔖', description: '', count: 0, has_card: false }];
  c.el.querySelector('[data-watch-list-add]').click();
  await settle(dispatcher);
  assert.deepEqual(calls.find((x) => x.k === 'watch_list.set').data, { title: 'List 3', symbol: '🔖' });
  assert.equal(c.el.querySelector('[data-watch-list-pick="12"]').getAttribute('aria-current'), 'true');
});

/* -------------------------------- helpers -------------------------------- */

const SLOTS = [
  { others: [], slot: 0, want: 0 },
  { others: [1, 2], slot: 0, want: 0 },
  { others: [1, 2], slot: 2, want: 3 },
  { others: [1, 2], slot: 1, want: 1.5 },
];
for (const c of SLOTS) {
  test(`sortOrderForSlot(${JSON.stringify(c.others)}, ${c.slot}) = ${c.want}`, () => {
    assert.equal(M.sortOrderForSlot(c.others, c.slot), c.want);
  });
}

test('watchItemHref, watchListOptions, listFromSearch', () => {
  assert.equal(M.watchItemHref({ cardId: '5', cardType: 'task', taskId: '0' }), '/task/5');
  assert.equal(M.watchItemHref({ cardId: '6', cardType: 'comm', taskId: '5' }), '/task/5');
  assert.equal(M.watchItemHref({ cardId: '6', cardType: 'comm', taskId: '0' }), '/thread/6');
  assert.deepEqual(M.watchListOptions({ lists: [{ id: '10', title: 'Stars', symbol: '★' }] }), [{ value: '10', label: '★ Stars' }]);
  assert.equal(M.listFromSearch('?list=12'), '12');
  assert.equal(M.listFromSearch('?list=x'), '');
});

test('the filter offers "On my watch list" on tasks and threads, its options from watch_list.list', () => {
  for (const type of ['task', 'comm']) {
    const f = M.DERIVED_FILTER_FIELDS[type].find((x) => x.name === 'watch_list');
    assert.ok(f, type);
    assert.equal(f.targetCardType, 'watch_list');
    assert.equal(f.meLabel, 'Any of my lists');
    assert.deepEqual(f.ops, ['in', 'notIn']);
    assert.deepEqual(M.derivedOptionTargets(type), ['watch_list', 'project']);
  }
  assert.equal(M.DERIVED_OPTION_SOURCES.watch_list.spec, 'watch_list.list');
});

test('the /watch-lists route and its help topic', () => {
  const r = M.matchRoute('/watch-lists');
  assert.equal(r.name, 'watch_lists');
  assert.equal(M.helpTopicForRoute(r), 'watch_lists');
});
