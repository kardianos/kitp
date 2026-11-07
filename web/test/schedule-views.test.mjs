// The Calendar and Timeline controls (docs/TIMELINE_AND_CALENDAR.md) against
// a fake batch server: what they read (dated / undated, T7), what they draw,
// and what a drag writes — in order, in one batch, with the optimistic patch
// and the re-read when the server refuses (T4, T8).
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
  M.registerScreenFilterBar();
  M.registerScreenHost();
  M.registerKanbanControls();
  M.registerCalendar();
  M.registerTimeline();
});

const PROJECT = 72n;

/**
 * A fake server: tasks with dates, value-cards, and attribute.update applied
 * in batch order — one refused sub-request fails the whole batch ('aborted'
 * for the rest), like the real transaction. `refuse(sub)` returns a message
 * to refuse a write with.
 */
function fakeServer({ refuse = () => null } = {}) {
  const tasks = new Map();
  const add = (id, title, attrs) => tasks.set(String(id), { title, status: 900, ...attrs });
  add(1, 'Span', { start_date: '2026-11-10', due_date: '2026-11-13', milestone_ref: 501 });
  add(2, 'Due only', { due_date: '2026-11-18', milestone_ref: 502 });
  add(3, 'Start only', { start_date: '2026-11-16' });
  add(4, 'Long', { start_date: '2026-10-19', due_date: '2027-01-15', milestone_ref: 502 });
  add(5, 'Undated A', {});
  add(6, 'Undated B', {});
  for (let i = 0; i < 4; i++) add(10 + i, `Busy ${i}`, { due_date: '2026-11-11' });
  const batches = [];
  const row = (id, type, attrs, extra = {}) => ({
    id: String(id), card_type_id: '1', card_type_name: type, parent_card_id: String(PROJECT), attributes: attrs, ...extra,
  });
  const dated = (a) => typeof a.start_date === 'string' || typeof a.due_date === 'string';
  const respondOne = (sr) => {
    const key = `${sr.endpoint}.${sr.action}`;
    const d = sr.data ?? {};
    if (key === 'card.select_with_attributes') {
      switch (d.card_type_name) {
        case 'task': {
          const wantDated = !JSON.stringify(d.tree ?? {}).includes('not exists');
          const rows = [...tasks.entries()]
            .filter(([, a]) => dated(a) === wantDated)
            .map(([id, a]) => row(id, 'task', a));
          return { ok: true, data: { rows: d.limit !== undefined ? rows.slice(0, d.limit) : rows } };
        }
        case 'status':
          return { ok: true, data: { rows: [row(900, 'status', { title: 'Doing', sort_order: 1 }, { phase: 'active' })] } };
        case 'person':
          return { ok: true, data: { rows: [row(800, 'person', { title: 'alice' })] } };
        case 'milestone':
          return { ok: true, data: { rows: [
            row(501, 'milestone', { title: 'M1', sort_order: 2, due_date: '2026-11-20' }),
            row(502, 'milestone', { title: 'M2', sort_order: 1, due_date: '2026-12-11' }),
          ] } };
        default:
          return { ok: true, data: { rows: [] } };
      }
    }
    if (key === 'attribute.update') {
      const msg = refuse(d);
      if (msg !== null) return { ok: false, error: { code: 'validation', message: msg } };
      return { ok: true, data: { ok: true, activity_id: '1' } };
    }
    return { ok: true, data: {} };
  };
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      batches.push(req.subrequests);
      const results = req.subrequests.map((sr) => ({ sr, r: respondOne(sr) }));
      const failed = results.some(({ r }) => !r.ok);
      // Apply the writes only when the whole batch went through.
      if (!failed) {
        for (const { sr } of results) {
          if (`${sr.endpoint}.${sr.action}` !== 'attribute.update') continue;
          const t = tasks.get(String(sr.data.card_id));
          if (t === undefined) continue;
          if (sr.data.value === null) delete t[sr.data.attribute_name];
          else t[sr.data.attribute_name] = sr.data.value;
        }
      }
      const subresponses = results.map(({ sr, r }) =>
        failed && r.ok ? { id: sr.id, ok: false, error: { code: 'aborted', message: 'batch aborted' } } : { id: sr.id, ...r },
      );
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
  const writes = () => batches.map((b) => b.filter((s) => s.endpoint === 'attribute' && s.action === 'update')).filter((b) => b.length > 0);
  return { tasks, transport, writes };
}

function boot(server) {
  const dispatcher = new M.Dispatcher({ transport: server.transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api);
  M.registerGridCardRefAttrs();
  const faults = [];
  dispatcher.onFault('sub_error', (f) => faults.push(f));
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(PROJECT);
  const scope = { get projectId() { return tree.at(['scope', 'projectId']).peek() ?? null; } };
  return { dispatcher, ctx: { api, tree, scope }, tree, faults };
}

async function settle(dispatcher) {
  for (let i = 0; i < 4; i++) {
    await dispatcher.flushNow();
    M.flushSync?.();
  }
}

function mount(type, ctx) {
  const view = M.Control.New(type, { type }, ctx);
  view.mount(new FakeElement('div'));
  return view;
}

const datesOf = (tree, prefix, id) => {
  const r = (tree.at([prefix, 'tasks']).peek() ?? []).find((t) => t.id === BigInt(id));
  return r === undefined ? null : [r.attributes.start_date ?? null, r.attributes.due_date ?? null];
};

beforeEach(() => setPath('/project/72/screen/calendar?month=2026-11'));

test('the screen host maps the date layouts, and the calendar hides GROUP', () => {
  assert.equal(M.layoutToControlType('calendar'), 'Calendar');
  assert.equal(M.layoutToControlType('timeline'), 'Timeline');
  assert.equal(M.layoutShowsGroup('calendar'), false);
  assert.equal(M.layoutShowsGroup('timeline'), true);
  for (const [layout, control, displayHidden] of [['calendar', 'Calendar', true], ['timeline', 'Timeline', false]]) {
    const { ctx } = boot(fakeServer());
    const host = M.Control.New('ScreenHost', { type: 'ScreenHost', screen: { slug: layout, layout }, resolveScreen: false }, ctx);
    host.mount(new FakeElement('div'));
    const body = host.el.querySelector('.screen-host__body');
    assert.equal(body.findByControl(control).length, 1, `${layout} → ${control}`);
    const display = host.el.querySelector('.filterbar__display-wrap');
    assert.equal(display.style.display === 'none', displayHidden, `${layout}: GROUP hidden = ${displayHidden}`);
  }
});

test('calendar: reads dated and undated tasks and draws the month', async () => {
  const server = fakeServer();
  const { dispatcher, ctx, tree } = boot(server);
  const cal = mount('Calendar', ctx);
  await settle(dispatcher);

  const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const ids = (tree.at(['calendar', 'tasks']).peek() ?? []).map((t) => t.id).sort(byId);
  assert.deepEqual(ids, [1n, 2n, 3n, 4n, 10n, 11n, 12n, 13n], 'dated read');
  assert.deepEqual((tree.at(['calendar', 'unscheduled']).peek() ?? []).map((t) => t.id).sort(byId), [5n, 6n], 'undated read');

  assert.equal(cal.el.querySelector('[data-cal-title]').textContent, 'November 2026');
  const weeks = cal.el.querySelectorAll('.cal-week');
  assert.equal(weeks.length, 6);
  assert.equal(weeks[0].dataset.calWeek, '2026-11-01');
  // The span sits in the week of Nov 8 from Tuesday for four days.
  const span = cal.el.querySelectorAll('[data-cal-item]').find((e) => e.dataset.cardId === '1');
  assert.equal(span.style.gridColumn, '3 / span 4');
  assert.ok(span.classList.contains('cal-item--span'));
  const start = cal.el.querySelectorAll('[data-cal-item]').find((e) => e.dataset.cardId === '3');
  assert.ok(start.classList.contains('cal-item--open'), 'a start with no due date is open-ended');
  // Five tasks on Wed Nov 11 (the long one + four due that day): three lanes show.
  const more = cal.el.querySelectorAll('[data-cal-more]').find((e) => e.dataset.calMore === '2026-11-11');
  assert.equal(more?.textContent, '+3 more');
  // M1 (Nov 20) shows by its day's number; M2 (Dec 11) is in the grid's last week.
  const nov20 = cal.el.querySelectorAll('[data-day]').find((d) => d.dataset.day === '2026-11-20');
  assert.equal(nov20.querySelector('[data-cal-milestone]')?.textContent, '◆ M1');
  // The tray lists the undated two.
  assert.equal(cal.el.querySelector('[data-tray-count]').textContent, '2');
});

test('calendar: a move later writes the due date first, in one batch, patched at once', async () => {
  const server = fakeServer();
  const { dispatcher, ctx, tree } = boot(server);
  const cal = mount('Calendar', ctx);
  await settle(dispatcher);
  const row = tree.at(['calendar', 'tasks']).peek().find((t) => t.id === 1n);

  cal.reschedule(row, { kind: 'move', days: 3 });
  assert.deepEqual(datesOf(tree, 'calendar', 1), ['2026-11-13', '2026-11-16'], 'optimistic before the server answers');
  await settle(dispatcher);
  const writes = server.writes();
  assert.equal(writes.length, 1, 'one batch');
  assert.deepEqual(writes[0].map((s) => [s.data.attribute_name, s.data.value]), [
    ['due_date', '2026-11-16'],
    ['start_date', '2026-11-13'],
  ]);
  assert.deepEqual([server.tasks.get('1').start_date, server.tasks.get('1').due_date], ['2026-11-13', '2026-11-16']);
});

test('calendar: a refused move rolls back and re-reads the server’s dates', async () => {
  const server = fakeServer({
    refuse: (d) => (d.attribute_name === 'start_date' ? 'the start date 2026-11-13 is after the due date 2026-11-12' : null),
  });
  const { dispatcher, ctx, tree, faults } = boot(server);
  const cal = mount('Calendar', ctx);
  await settle(dispatcher);
  const row = tree.at(['calendar', 'tasks']).peek().find((t) => t.id === 1n);
  cal.reschedule(row, { kind: 'move', days: 3 });
  await settle(dispatcher);
  assert.deepEqual(datesOf(tree, 'calendar', 1), ['2026-11-10', '2026-11-13'], 'back to what the server has');
  assert.deepEqual([server.tasks.get('1').start_date, server.tasks.get('1').due_date], ['2026-11-10', '2026-11-13']);
  assert.ok(faults.some((f) => /after the due date/.test(f.message)), 'the refusal reached the fault funnel');
});

test('calendar: a tray drop gives the task that due date and leaves the tray', async () => {
  const server = fakeServer();
  const { dispatcher, ctx, tree } = boot(server);
  const cal = mount('Calendar', ctx);
  await settle(dispatcher);
  const row = tree.at(['calendar', 'unscheduled']).peek().find((t) => t.id === 5n);
  cal.reschedule(row, { kind: 'drop', day: '2026-11-20' }, true);
  assert.deepEqual(datesOf(tree, 'calendar', 5), [null, '2026-11-20'], 'drawn at once');
  assert.equal(cal.el.querySelector('[data-tray-count]').textContent, '1', 'gone from the tray at once');
  await settle(dispatcher);
  assert.equal(server.tasks.get('5').due_date, '2026-11-20');
  assert.deepEqual((tree.at(['calendar', 'unscheduled']).peek() ?? []).map((t) => t.id), [6n], 'the tray re-read');
});

test('calendar: the month rides in the URL and steps with prev / next', async () => {
  const { dispatcher, ctx } = boot(fakeServer());
  const cal = mount('Calendar', ctx);
  await settle(dispatcher);
  cal.el.querySelector('[data-cal-next]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  assert.equal(cal.el.querySelector('[data-cal-title]').textContent, 'December 2026');
  assert.equal(M.readQueryParam('month'), '2026-12');
  cal.el.querySelector('[data-cal-week]').dispatchEvent({ type: 'click' });
  M.flushSync?.();
  assert.equal(M.readQueryParam('view'), 'week');
  assert.equal(cal.el.querySelectorAll('.cal-week').length, 1);
});

test('timeline: bands by milestone in date order, a band folds, Alt+→ moves a task', async () => {
  setPath('/project/72/screen/timeline?zoom=week');
  const server = fakeServer();
  const { dispatcher, ctx, tree } = boot(server);
  tree.at(['screen', 'groupAxis']).set({ attr: 'milestone_ref', lookup: 'milestones' });
  const tl = mount('Timeline', ctx);
  await settle(dispatcher);

  const shape = () => tl.items.peek().map((i) => (i.kind === 'band' ? `[${i.band.label}:${i.count}]` : i.id));
  assert.deepEqual(shape(), ['[M1:1]', '1', '[M2:2]', '4', '2', '[(unset):5]', '10', '11', '12', '13', '3'],
    'M1 (Nov 20) before M2 (Dec 11) though M2 sorts first; (unset) last; tasks by start');
  const m1 = tl.items.peek()[0];
  assert.equal(m1.band.date, '2026-11-20', 'the band carries the milestone date for its ◆');

  // Rows recycle through the virtual list; each task row says which card it is.
  const drawn = tl.el.querySelectorAll('[data-tl-row]').filter((r) => r.style.display !== 'none' && r.dataset.cardId);
  assert.ok(drawn.length > 0);

  tl.toggleBand('502');
  assert.deepEqual(shape(), ['[M1:1]', '1', '[M2:2]', '[(unset):5]', '10', '11', '12', '13', '3'], 'M2 folded');

  tl.moveCursor(1); // the M1 band
  tl.moveCursor(1); // task 1
  tl.nudge(1);
  await settle(dispatcher);
  assert.deepEqual(server.writes().at(-1).map((s) => [s.data.attribute_name, s.data.value]), [
    ['due_date', '2026-11-14'],
    ['start_date', '2026-11-11'],
  ]);
  assert.equal(M.TIMELINE_ROW_HEIGHT, 32);
});

test('timeline: a resize changes one date and never inverts the pair', async () => {
  setPath('/project/72/screen/timeline');
  const server = fakeServer();
  const { dispatcher, ctx, tree } = boot(server);
  const tl = mount('Timeline', ctx);
  await settle(dispatcher);
  const row = tree.at(['timeline', 'tasks']).peek().find((t) => t.id === 1n);
  tl.reschedule(row, { kind: 'resizeEnd', day: '2026-11-05' });
  await settle(dispatcher);
  assert.deepEqual(server.writes().at(-1).map((s) => [s.data.attribute_name, s.data.value]), [['due_date', '2026-11-10']]);
  assert.deepEqual(datesOf(tree, 'timeline', 1), ['2026-11-10', '2026-11-10']);
});
