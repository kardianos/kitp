/**
 * util/datetime — the ISO-style LOCAL date + time used on comments, comm
 * messages and links. Pinned to a half-hour-offset zone (India, UTC+05:30, no
 * DST) so a test that passes proves the conversion to local time — not a UTC
 * passthrough — and that minutes carry correctly across midnight.
 */

process.env.TZ = 'Asia/Kolkata';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom } from './ui-dom-setup.mjs';

let M;
before(async () => {
  installUiDom();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
});

const CASES = [
  { label: 'UTC morning', iso: '2026-10-21T08:15:00.000Z', want: '2026-10-21 13:45' },
  { label: 'crosses local midnight', iso: '2026-10-21T19:00:00Z', want: '2026-10-22 00:30' },
  { label: 'new year rollover', iso: '2026-12-31T18:45:59Z', want: '2027-01-01 00:15' },
  { label: 'explicit offset input', iso: '2026-10-21T10:00:00-07:00', want: '2026-10-21 22:30' },
  { label: 'unparseable passes through', iso: 'not a date', want: 'not a date' },
  { label: 'empty passes through', iso: '', want: '' },
];
for (const c of CASES) {
  test(`formatLocalDateTime: ${c.label}`, () => {
    assert.equal(M.formatLocalDateTime(c.iso), c.want);
  });
}

test('formatUtcOffset: the local zone offset', () => {
  assert.equal(M.formatUtcOffset(new Date('2026-10-21T08:15:00Z')), 'UTC+05:30');
});

test('localTimeEl: <time> with the machine instant + a seconds/offset/relative tooltip', () => {
  const now = Date.parse('2026-10-21T10:15:09Z');
  const el = M.localTimeEl('2026-10-21T08:15:09.000Z', 'x', now);
  assert.equal(el.tagName, 'TIME');
  assert.equal(el.className, 'x');
  assert.equal(el.textContent, '2026-10-21 13:45');
  assert.equal(el.getAttribute('datetime'), '2026-10-21T08:15:09.000Z');
  assert.equal(el.title, '2026-10-21 13:45:09 UTC+05:30 · 2h ago');
});

test('localTimeEl: an unparseable stamp renders raw with no datetime', () => {
  const el = M.localTimeEl('soon', 'x');
  assert.equal(el.textContent, 'soon');
  assert.equal(el.getAttribute('datetime'), null);
});
