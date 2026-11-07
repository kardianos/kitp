// The pure pieces of the Calendar and Timeline layouts
// (docs/TIMELINE_AND_CALENDAR.md): date math, placement (T2), the drag →
// writes plan and its ordering (T3, T8), the shared filter trees and
// optimistic patches (T4, T7), the calendar's week lanes and the timeline's
// axis and bands. Tables, one row per case.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let D, P, R, SD, CL, TL;

before(async () => {
  installDomShim();
  const outdir = await buildTestBundles();
  const M = await import(`${outdir}/app.js`);
  D = M.scheduleDates;
  P = M.schedulePlacement;
  R = M.scheduleReschedule;
  SD = M.scheduleData;
  CL = M.calendarLayout;
  TL = M.timelineLayout;
});

test('dates: whole-day math in local time', () => {
  for (const [name, got, want] of [
    ['addDays forward across a month', () => D.addDays('2026-11-29', 3), '2026-12-02'],
    ['addDays back across a year', () => D.addDays('2026-01-02', -3), '2025-12-30'],
    ['addDays over a DST change', () => D.addDays('2026-11-01', 1), '2026-11-02'],
    ['daysBetween same day', () => D.daysBetween('2026-11-07', '2026-11-07'), 0],
    ['daysBetween later', () => D.daysBetween('2026-11-07', '2026-12-07'), 30],
    ['daysBetween earlier', () => D.daysBetween('2026-11-07', '2026-11-01'), -6],
    ['startOfWeek of a Saturday', () => D.startOfWeek('2026-11-07'), '2026-11-01'],
    ['startOfWeek of a Sunday', () => D.startOfWeek('2026-11-08'), '2026-11-08'],
    ['lastOfMonth February', () => D.lastOfMonth('2028-02'), '2028-02-29'],
    ['addMonths across a year', () => D.addMonths('2026-12', 1), '2027-01'],
    ['monthGridWeeks starts on the Sunday before the 1st', () => D.monthGridWeeks('2026-12')[0], '2026-11-29'],
    ['monthGridWeeks is six weeks', () => D.monthGridWeeks('2026-02').length, 6],
    ['parseIsoDate rejects a rollover', () => D.parseIsoDate('2026-02-30'), null],
    ['isoDateOf rejects a word', () => D.isoDateOf('today'), null],
    ['parseMonth', () => D.parseMonth('2026-13'), null],
    ['formatDay', () => D.formatDay('2026-11-18'), 'Wed Nov 18'],
    ['formatRange one day', () => D.formatRange('2026-11-18', '2026-11-18'), 'Nov 18'],
    ['formatRange another year', () => D.formatRange('2026-12-30', '2027-01-02', 2026), 'Dec 30 – Jan 2, 2027'],
    ['isWeekend Saturday', () => D.isWeekend('2026-11-07'), true],
    ['isWeekend Monday', () => D.isWeekend('2026-11-09'), false],
  ]) {
    assert.deepEqual(got(), want, name);
  }
});

test('placement: how a task draws (T2)', () => {
  for (const [name, attrs, want] of [
    ['start + due → a span', { start_date: '2026-11-10', due_date: '2026-11-13' },
      { kind: 'span', start: '2026-11-10', end: '2026-11-13', openEnded: false, inverted: false }],
    ['same day → a one-day span', { start_date: '2026-11-11', due_date: '2026-11-11' },
      { kind: 'span', start: '2026-11-11', end: '2026-11-11', openEnded: false, inverted: false }],
    ['due only → a point', { due_date: '2026-11-18' },
      { kind: 'point', start: '2026-11-18', end: '2026-11-18', openEnded: false, inverted: false }],
    ['start only → an open-ended point', { start_date: '2026-11-16' },
      { kind: 'point', start: '2026-11-16', end: '2026-11-16', openEnded: true, inverted: false }],
    ['neither → unscheduled', {}, { kind: 'unscheduled' }],
    ['cleared dates → unscheduled', { start_date: null, due_date: null }, { kind: 'unscheduled' }],
    ['not a real day → ignored', { due_date: '2026-02-30' }, { kind: 'unscheduled' }],
    ['an inverted pair draws over both days, flagged', { start_date: '2026-11-20', due_date: '2026-11-18' },
      { kind: 'span', start: '2026-11-18', end: '2026-11-20', openEnded: false, inverted: true }],
  ]) {
    assert.deepEqual(P.placementOf(P.datesOf(attrs)), want, name);
  }
  const span = P.placementOf({ start: '2026-11-10', due: '2026-11-13' });
  for (const [from, to, want] of [
    ['2026-11-01', '2026-11-09', false],
    ['2026-11-13', '2026-11-20', true],
    ['2026-11-11', '2026-11-12', true],
    ['2026-11-14', '2026-11-30', false],
  ]) {
    assert.equal(P.touches(span, from, to), want, `touches ${from}..${to}`);
  }
});

test('reschedule: a drag → ordered writes that never invert the pair (T3, T8)', () => {
  const both = { start: '2026-11-10', due: '2026-11-13' };
  for (const [name, cur, drag, want] of [
    ['move later writes the due date first', both, { kind: 'move', days: 3 }, {
      writes: [{ attr: 'due_date', value: '2026-11-16' }, { attr: 'start_date', value: '2026-11-13' }],
      next: { start: '2026-11-13', due: '2026-11-16' } }],
    ['move earlier writes the start first', both, { kind: 'move', days: -10 }, {
      writes: [{ attr: 'start_date', value: '2026-10-31' }, { attr: 'due_date', value: '2026-11-03' }],
      next: { start: '2026-10-31', due: '2026-11-03' } }],
    ['move by zero days changes nothing', both, { kind: 'move', days: 0 }, null],
    ['move a due-only point', { start: null, due: '2026-11-18' }, { kind: 'move', days: 2 }, {
      writes: [{ attr: 'due_date', value: '2026-11-20' }], next: { start: null, due: '2026-11-20' } }],
    ['move a start-only point', { start: '2026-11-16', due: null }, { kind: 'move', days: -1 }, {
      writes: [{ attr: 'start_date', value: '2026-11-15' }], next: { start: '2026-11-15', due: null } }],
    ['resize the start earlier', both, { kind: 'resizeStart', day: '2026-11-08' }, {
      writes: [{ attr: 'start_date', value: '2026-11-08' }], next: { start: '2026-11-08', due: '2026-11-13' } }],
    ['resize the start past the due date stops on it', both, { kind: 'resizeStart', day: '2026-11-20' }, {
      writes: [{ attr: 'start_date', value: '2026-11-13' }], next: { start: '2026-11-13', due: '2026-11-13' } }],
    ['resize the due date before the start stops on it', both, { kind: 'resizeEnd', day: '2026-11-01' }, {
      writes: [{ attr: 'due_date', value: '2026-11-10' }], next: { start: '2026-11-10', due: '2026-11-10' } }],
    ['resize to where it is changes nothing', both, { kind: 'resizeEnd', day: '2026-11-13' }, null],
    ['drop from the tray sets the due date', { start: null, due: null }, { kind: 'drop', day: '2026-11-18' }, {
      writes: [{ attr: 'due_date', value: '2026-11-18' }], next: { start: null, due: '2026-11-18' } }],
  ]) {
    assert.deepEqual(R.planReschedule(cur, drag), want, name);
  }
  // Every intermediate pair a plan passes through is valid (start ≤ due).
  for (const days of [-40, -3, -1, 1, 3, 40]) {
    const plan = R.planReschedule(both, { kind: 'move', days });
    let cur = { ...both };
    for (const w of plan.writes) {
      cur = { ...cur, [w.attr === 'start_date' ? 'start' : 'due']: w.value };
      assert.ok(cur.start <= cur.due, `move ${days}: ${cur.start} ≤ ${cur.due} after ${w.attr}`);
    }
  }
});

test('schedule data: filter trees AND the dated / undated clause (T5, T7)', () => {
  for (const [name, args, want] of [
    ['no filter', ['', ['title'], null, null], {
      dated: { connective: 'or', children: [{ attr: 'start_date', op: 'exists' }, { attr: 'due_date', op: 'exists' }] },
      undated: { connective: 'and', children: [{ attr: 'start_date', op: 'not exists' }, { attr: 'due_date', op: 'not exists' }] },
    }],
    ['a search rides inside the tree', ['pool', ['title'], null, null], {
      dated: { connective: 'and', children: [
        { attr: 'title', op: 'contains', values: ['pool'] },
        { connective: 'or', children: [{ attr: 'start_date', op: 'exists' }, { attr: 'due_date', op: 'exists' }] },
      ] },
      undated: { connective: 'and', children: [
        { attr: 'title', op: 'contains', values: ['pool'] },
        { connective: 'and', children: [{ attr: 'start_date', op: 'not exists' }, { attr: 'due_date', op: 'not exists' }] },
      ] },
    }],
  ]) {
    assert.deepEqual(SD.scheduleFilterTrees(...args), want, name);
  }
  // A personal screen's base filter is ANDed into both.
  const scope = { attr: 'project', op: 'in', values: ['7'] };
  const { dated, undated } = SD.scheduleFilterTrees('', ['title'], null, scope);
  for (const [name, tree, clause] of [['dated', dated, 'exists'], ['undated', undated, 'not exists']]) {
    const json = JSON.stringify(tree);
    assert.equal(tree.connective, 'and', name);
    assert.ok(json.includes(JSON.stringify(scope)), `${name} keeps the base filter`);
    assert.ok(json.includes(`"op":"${clause}"`), `${name} keeps its date clause`);
  }
});

test('schedule data: optimistic patches and the write order fired (T4)', () => {
  const row = (id, attrs) => ({ id, card_type_id: 1n, card_type_name: 'task', attributes: { title: `t${id}`, ...attrs } });
  const rows = [row(1n, { start_date: '2026-11-10', due_date: '2026-11-13' }), row(2n, { due_date: '2026-11-18' })];
  const next = { start: '2026-11-12', due: '2026-11-15' };
  const patched = SD.patchDates(rows, { cardId: 1n, next });
  assert.deepEqual([patched[0].attributes.start_date, patched[0].attributes.due_date], ['2026-11-12', '2026-11-15']);
  assert.equal(patched[1], rows[1], 'other rows untouched');
  const dropped = SD.patchDrop(rows, { row: row(3n, {}), next: { start: null, due: '2026-11-20' } });
  assert.deepEqual(dropped.map((r) => r.id), [1n, 2n, 3n]);
  assert.equal(dropped[2].attributes.due_date, '2026-11-20');

  const fired = [];
  const plan = R.planReschedule({ start: '2026-11-10', due: '2026-11-13' }, { kind: 'move', days: 2 });
  SD.fireReschedule((name, p) => fired.push([name, p.attr, p.value]), 1n, plan);
  assert.deepEqual(fired, [
    ['scheduleWrite', 'due_date', '2026-11-15'],
    ['scheduleWriteThen', 'start_date', '2026-11-12'],
  ], 'only the first write carries the optimistic patch');
  fired.length = 0;
  SD.fireReschedule((name, p) => fired.push([name, p.attr, p.row?.id]), 3n,
    R.planReschedule({ start: null, due: null }, { kind: 'drop', day: '2026-11-20' }), row(3n, {}));
  assert.deepEqual(fired, [['scheduleDrop', 'due_date', 3n]]);
});

test('calendar: a week lays its items into lanes, longest first', () => {
  const items = [
    { key: 'long', start: '2026-10-19', end: '2027-01-15' },
    { key: 'mid', start: '2026-11-10', end: '2026-11-13' },
    { key: 'a', start: '2026-11-09', end: '2026-11-09' },
    { key: 'b', start: '2026-11-11', end: '2026-11-11' },
    { key: 'c', start: '2026-11-11', end: '2026-11-11' },
    { key: 'next-week', start: '2026-11-16', end: '2026-11-17' },
    { key: 'over-sat', start: '2026-11-14', end: '2026-11-15' },
  ];
  const laid = CL.layoutWeek(items, '2026-11-08');
  const by = Object.fromEntries(laid.map((l) => [l.key, l]));
  for (const [key, want] of [
    ['long', { lane: 0, col: 0, span: 7, continuesBefore: true, continuesAfter: true }],
    ['mid', { lane: 1, col: 2, span: 4, continuesBefore: false, continuesAfter: false }],
    ['a', { lane: 1, col: 1, span: 1, continuesBefore: false, continuesAfter: false }],
    ['over-sat', { lane: 1, col: 6, span: 1, continuesBefore: false, continuesAfter: true }],
    ['b', { lane: 2, col: 3, span: 1, continuesBefore: false, continuesAfter: false }],
    ['c', { lane: 3, col: 3, span: 1, continuesBefore: false, continuesAfter: false }],
  ]) {
    const { lane, col, span, continuesBefore, continuesAfter } = by[key];
    assert.deepEqual({ lane, col, span, continuesBefore, continuesAfter }, want, key);
  }
  assert.equal(by['next-week'], undefined, 'outside the week');
  assert.deepEqual(CL.hiddenPerDay(laid, 3), [0, 0, 0, 1, 0, 0, 0], 'one hidden on Wednesday');
  assert.deepEqual(CL.keysOnDay(laid, 3), ['long', 'mid', 'b', 'c']);
});

test('timeline: axis, x positions and band order', () => {
  const r = TL.axisRange([{ start: '2026-10-19', end: '2027-01-15' }], '2026-11-07');
  assert.equal(D.weekdayOf(r.start), 0, 'the axis starts on a Sunday');
  assert.ok(r.start <= '2026-10-05', 'a margin before the earliest start');
  assert.ok(D.addDays(r.start, r.days - 1) >= '2027-02-15', 'a margin after the latest due date');
  assert.equal(TL.xOfDay('2026-11-01', '2026-11-08', 18), 126);
  assert.equal(TL.dayOfX('2026-11-01', 127, 18), '2026-11-08');

  const bands = [
    { key: '__unset__', label: '(unset)', sortOrder: Infinity },
    { key: 'm3', label: 'M3', sortOrder: 3 },
    { key: 'm2', label: 'M2', sortOrder: 2, date: '2026-12-11' },
    { key: 'm1', label: 'M1', sortOrder: 9, date: '2026-11-20' },
    { key: 'p', label: 'alice', sortOrder: Infinity },
  ];
  assert.deepEqual(bands.sort(TL.compareBands).map((b) => b.key), ['m1', 'm2', 'm3', 'p', '__unset__'],
    'dated first by date, then sort order, then label; unset last');

  const task = (id, start, end, band) => ({ row: { band }, id, title: `T${id}`, placement: { kind: 'span', start, end, openEnded: false, inverted: false } });
  const tasks = [task('1', '2026-11-12', '2026-11-14', 'm2'), task('2', '2026-11-02', '2026-11-04', 'm2'), task('3', '2026-11-05', '2026-11-05', '__unset__')];
  const info = (key) => ({ key, label: key, sortOrder: key === 'm2' ? 1 : Infinity });
  const items = TL.timelineItems(tasks, (t) => t.row.band, info, new Set());
  assert.deepEqual(items.map((i) => (i.kind === 'band' ? `[${i.band.key}:${i.count}]` : i.id)), ['[m2:2]', '2', '1', '[__unset__:1]', '3']);
  assert.deepEqual(items[0].extent, { start: '2026-11-02', end: '2026-11-14' });
  const folded = TL.timelineItems(tasks, (t) => t.row.band, info, new Set(['m2']));
  assert.deepEqual(folded.map((i) => (i.kind === 'band' ? `[${i.band.key}]` : i.id)), ['[m2]', '[__unset__]', '3']);
  assert.deepEqual(TL.timelineItems(tasks, null, info, new Set()).map((i) => i.id), ['2', '3', '1'], 'no GROUP: by start');
});
