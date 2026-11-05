/**
 * Mail intake + calendar feeds (docs/MAIL_INTAKE_AND_CALENDARS.md): the
 * URL / address / filter helpers, the Comm log's address-bar filters, and
 * the four views — Comm Channels' RECEIVING MAIL panel, the Comm log, the
 * Mail intake page and Account → Calendars — driven through a mock
 * transport.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
let FakeElement;

before(async () => {
  ({ FakeElement } = installDomShim());
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  M.registerCommRoutes();
  M.registerCommLogView();
  M.registerMailIntake();
  M.registerAccountCalendars();
});

/* --------------------------------- helpers -------------------------------- */

test('inboundURL / inboundAddress / calendarURL', () => {
  assert.equal(M.inboundURL('https://kitp.example/', 'ab12', 'raw'), 'https://kitp.example/api/v1/comm/inbound/ab12');
  assert.equal(M.inboundURL('https://kitp.example', 'ab12', 'mailgun'), 'https://kitp.example/api/v1/comm/inbound/ab12/mime');
  assert.equal(M.inboundAddress('ab12', 'in.example.com'), 'ab12@in.example.com');
  assert.equal(M.calendarURL('https://kitp.example', 'cd34'), 'https://kitp.example/api/v1/calendar/cd34.ics');
  assert.equal(M.webcalURL('https://kitp.example/x.ics'), 'webcal://kitp.example/x.ics');
});

test('draftToPolicy keeps SMTP-only filters off POST routes and round-trips', () => {
  const draft = {
    sources: '40.92.0.0/15\n 104.47.0.0/17 ,',
    requireTls: true,
    senderHosts: '.outbound.protection.outlook.com',
    envelopeFrom: 'example.com',
    headerFrom: 'boss@example.net',
    dkimMode: 'require',
    dkimDomains: 'example.com',
    dkimOnFail: 'file',
  };
  const smtp = M.draftToPolicy(draft, 'inbound_smtp');
  assert.deepEqual(smtp, {
    sources: ['40.92.0.0/15', '104.47.0.0/17'],
    headerFrom: ['boss@example.net'],
    requireTls: true,
    senderHosts: ['.outbound.protection.outlook.com'],
    envelopeFrom: ['example.com'],
    dkim: { mode: 'require', domains: ['example.com'], onFail: 'file' },
  });
  const post = M.draftToPolicy(draft, 'inbound_post');
  assert.equal(post.requireTls, undefined);
  assert.equal(post.senderHosts, undefined);
  assert.equal(post.envelopeFrom, undefined);
  assert.deepEqual(M.draftToPolicy(M.policyToDraft(smtp), 'inbound_smtp'), smtp);
  assert.equal(M.policySummary({}), 'No filters');
  assert.match(M.policySummary(smtp), /TLS required/);
});

test('Comm log filters live in the address and survive a round trip', () => {
  const f = M.parseCommLogFilter('?channel=42&route=7&kind=inbound_refused&window=7d&junk=1');
  assert.deepEqual(f, { channel: '42', route: '7', kind: 'inbound_refused', window: '7d' });
  assert.equal(M.commLogHref(f), '/admin/comm_log?channel=42&route=7&kind=inbound_refused&window=7d');
  assert.deepEqual(M.parseCommLogFilter('?channel=4x2&kind=DROP TABLE'), {});
  assert.equal(M.commLogHref({}), '/admin/comm_log');
  const since = M.windowSince('1h', Date.parse('2026-11-03T12:00:00Z'));
  assert.equal(since, '2026-11-03T11:00:00Z');
});

test('commLogSummary reads a row as a sentence', () => {
  assert.equal(
    M.commLogSummary({ kind: 'received', detail: { from: 'ada@example.com', subject: 'Help', outcome: 'task' } }),
    'from ada@example.com “Help” → a new task and thread',
  );
  assert.equal(
    M.commLogSummary({ kind: 'inbound_refused', detail: { check: 'sources', reason: '1.2.3.4 is not an allowed source', source: '1.2.3.4' } }),
    'sources: 1.2.3.4 is not an allowed source (from 1.2.3.4)',
  );
  assert.equal(
    M.commLogSummary({ kind: 'attachments_dropped', detail: { from: 'ada@example.com', subject: 'Photos', count: 2, files: ['a.jpg', 'b.jpg'] } }),
    'from ada@example.com “Photos” — 2 left off (a.jpg, b.jpg)',
  );
  assert.equal(
    M.commLogSummary({ kind: 'relay_queued', detail: { from: 'ada@example.com', subject: 'Re: X', to: 'bob@example.com' } }),
    'from ada@example.com “Re: X” → a copy to bob@example.com',
  );
  assert.equal(
    M.commLogSummary({ kind: 'relay_skipped', detail: { from: 'ada@example.com', subject: 'Out of office', reason: 'auto_submitted' } }),
    'from ada@example.com “Out of office” — not sent on: an automatic message (Auto-Submitted)',
  );
  assert.equal(
    M.commLogSummary({ kind: 'relay_skipped', detail: { from: 'ada@example.com', subject: 'Re: X', reason: 'loop' } }),
    'from ada@example.com “Re: X” — not sent on: it is kitp’s own copy coming back (X-Loop)',
  );
  assert.equal(
    M.commLogSummary({ kind: 'send_retry', detail: { recipient: 'bob@example.com', attempt: 2, error: 'timeout', retry_in: '5m0s' } }),
    'to bob@example.com — try 2 failed (timeout); next in 5m0s',
  );
  assert.equal(
    M.commLogSummary({ kind: 'send_ok', detail: { recipient: 'ada@example.com, bob@example.com', refused: [{ recipient: 'bob@example.com', smtp_code: 550 }] } }),
    'to ada@example.com, bob@example.com — except bob@example.com, whom the server refused',
  );
  assert.equal(M.commLogSummary({ kind: 'send_ok', detail: { recipient: 'ada@example.com' } }), 'to ada@example.com');
  assert.equal(
    M.commLogSummary({ kind: 'send_bounce', detail: { recipient: 'bob@example.com', error: 'no such user', others_sent: true } }),
    'to bob@example.com — no such user (sent to the others)',
  );
  assert.equal(
    M.commLogSummary({ kind: 'file_retry', detail: { from: 'ada@example.com', subject: 'Help', error: 'a database error (23505)' } }),
    'from ada@example.com “Help” — a database error (23505); tried again after the rest of the mail on each poll',
  );
});

test('the Comm log lists the relay and attachment kinds', () => {
  const kinds = M.COMM_LOG_KINDS.map(([k]) => k);
  for (const k of ['attachments_dropped', 'relay_queued', 'relay_skipped', 'send_retry', 'file_retry']) assert.ok(kinds.includes(k), k);
});

test('calendar filter presets', () => {
  assert.equal(M.filterPreset(''), 'all');
  assert.equal(M.filterPreset(M.CALENDAR_FILTERS[1].json), 'mine');
  assert.equal(M.filterPreset('{"connective":"or","children":[]}'), 'custom');
});

test('normalizeStatus fills every field', () => {
  const s = M.normalizeStatus({});
  assert.equal(s.smtp.enabled, false);
  assert.deepEqual(s.recentRefusals, []);
  assert.equal(s.trustedDefault, true);
});

/* ---------------------------------- views --------------------------------- */

function transport(handlers) {
  const sent = [];
  return {
    sent,
    async send(body) {
      const req = JSON.parse(body);
      const subresponses = req.subrequests.map((sr) => {
        const key = `${sr.endpoint}.${sr.action}`;
        sent.push({ key, data: sr.data ?? {} });
        const h = handlers[key];
        if (h === undefined) return { id: sr.id, ok: false, error: { code: 'unknown_handler', message: `mock has no ${key}` } };
        const out = h(sr.data ?? {});
        if (out && out.__error) return { id: sr.id, ok: false, error: out.__error };
        return { id: sr.id, ok: true, data: out };
      });
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
}

function boot(t) {
  const dispatcher = new M.Dispatcher({ transport: t });
  const api = new M.Api(dispatcher);
  M.registerAdminSpecs(api);
  M.registerMailinSpecs(api);
  return { dispatcher, api };
}

async function settle(dispatcher) {
  for (let i = 0; i < 4; i++) await dispatcher.flushNow();
  M.flushSync?.();
}

function mount(api, type, cfg, tree = new M.TreeNode({}, [])) {
  const ctrl = M.Control.New(type, { type, ...cfg }, { api, tree, scope: {} });
  ctrl.mount(new FakeElement('div'));
  return { ctrl, tree };
}

const STATUS = {
  smtp: { enabled: true, addr: ':2525', domain: 'in.example.com', hostname: 'in.example.com', max_bytes: 41943040, allow: [] },
  tls: { configured: true, subject: 'in.example.com', not_after: '2027-01-01T00:00:00Z', error: '' },
  trusted_proxies: ['10.0.0.0/8'],
  trusted_default: true,
  limits: { per_source_per_minute: 120 },
  throttled: ['203.0.113.9'],
  recent_refusals: [{ at: '2026-11-03T10:00:00Z', transport: 'smtp', source: '203.0.113.9', reason: 'spoke before the greeting' }],
};

const ROUTE = {
  id: '7',
  channel_id: '80',
  purpose: 'inbound_post',
  provider: 'mailgun',
  comment: 'Mailgun route',
  hint: 'ab12cd',
  policy: { sources: ['198.51.100.0/24'] },
  has_signing_key: true,
  created_at: '2026-11-01T00:00:00Z',
  last_used_at: '2026-11-03T09:00:00Z',
  last_client: '198.51.100.7',
  last_error: 'sources: 203.0.113.1 is not an allowed source',
  last_error_at: '2026-11-03T08:00:00Z',
};

test('CommRoutes lists the account’s routes, makes one and shows its secret once', async () => {
  let routes = [ROUTE];
  const t = transport({
    'mail_intake.status': () => STATUS,
    'comm_route.list': () => ({ routes }),
    'comm_route.create': (d) => {
      routes = [{ ...ROUTE, id: '8', purpose: d.purpose, provider: '', comment: d.comment, hint: 'ffff00', last_used_at: '', last_error: '' }, ...routes];
      return { id: '8', token: 'f'.repeat(40), hint: 'ffffff', purpose: d.purpose, provider: '' };
    },
    'comm_route.delete': (d) => {
      routes = routes.filter((r) => r.id !== d.id);
      return { id: d.id };
    },
  });
  const { dispatcher, api } = boot(t);
  const tree = new M.TreeNode({}, []);
  tree.at(['admin', 'comm_channels', 'items']).set([{ id: '80', raw: { id: '80', name: 'Support' } }]);
  tree.at(['admin', 'comm_channels', 'selectedId']).set('80');
  const { ctrl } = mount(api, 'CommRoutes', { parentScope: 'admin.comm_channels' }, tree);
  await settle(dispatcher);

  const row = ctrl.el.querySelector('[data-route="7"]');
  assert.ok(row, 'the route row renders');
  assert.match(row.textContent, /POST · Mailgun/);
  assert.match(row.textContent, /…ab12cd/);
  assert.match(row.textContent, /from 198\.51\.100\.0\/24/);
  assert.ok(row.querySelector('[data-route-error]'), 'the last refusal shows');
  assert.ok(ctrl.el.querySelector('[data-routes-help]'), 'a Detailed steps link');
  assert.ok(ctrl.el.querySelector('[data-route-log="7"]'), 'a View log link');

  ctrl.el.querySelector('[data-add-smtp]').dispatchEvent({ type: 'click' });
  assert.match(ctrl.el.querySelector('[data-route-form="new"]').textContent, /Redirect to/, 'SMTP steps on the form');
  const comment = ctrl.el.querySelector('[data-field="comment"]');
  comment.value = 'Exchange forward';
  comment.dispatchEvent({ type: 'input' });
  ctrl.el.querySelector('[data-route-save]').dispatchEvent({ type: 'click' });
  await settle(dispatcher);
  const create = t.sent.find((s) => s.key === 'comm_route.create');
  assert.equal(create.data.purpose, 'inbound_smtp');
  assert.equal(create.data.channel_id, '80');
  assert.equal(create.data.comment, 'Exchange forward');
  const minted = ctrl.el.querySelector('[data-minted-value]');
  assert.equal(minted.value, `${'f'.repeat(40)}@in.example.com`, 'the new address, shown once');
});

test('CommLogView sends its filters and renders readable rows', async () => {
  const t = transport({
    'comm_channel.list': () => ({ rows: [{ id: '80', name: 'Support' }] }),
    'comm_route.list': () => ({ routes: [ROUTE] }),
    'comm_log.list': () => ({
      rows: [
        { id: '1', channel_id: '80', channel_name: 'Support', route_id: '7', kind: 'received', at: '2026-11-03T10:00:00Z', detail: { from: 'ada@example.com', subject: 'Hi', outcome: 'thread', card_id: 99, transport: 'post' } },
      ],
    }),
  });
  const { dispatcher, api } = boot(t);
  globalThis.location = { search: '?channel=80&route=7&kind=received', pathname: '/admin/comm_log', origin: 'https://kitp.example' };
  try {
    const tree = new M.TreeNode({}, []);
    tree.at(['scope', 'projectId']).set('31');
    const { ctrl } = mount(api, 'CommLogView', {}, tree);
    await settle(dispatcher);
    const list = t.sent.find((s) => s.key === 'comm_log.list');
    assert.equal(list.data.channel_id, '80');
    assert.equal(list.data.route_id, '7');
    assert.equal(list.data.kind, 'received');
    assert.match(list.data.since, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'since is RFC 3339');
    const row = ctrl.el.querySelector('[data-log-kind="received"]');
    assert.match(row.textContent, /a new thread/);
    assert.ok(row.querySelector('[data-log-card="99"]'), 'a link to the thread');
  } finally {
    delete globalThis.location;
  }
});

test('MailIntake shows the listener, certificate, throttled sources and refusals', async () => {
  const t = transport({ 'mail_intake.status': () => STATUS });
  const { dispatcher, api } = boot(t);
  const { ctrl } = mount(api, 'MailIntake', {});
  await settle(dispatcher);
  assert.match(ctrl.el.querySelector('[data-mi-smtp]').textContent, /in\.example\.com/);
  assert.match(ctrl.el.querySelector('[data-mi-tls]').textContent, /Expires/);
  assert.match(ctrl.el.querySelector('[data-mi-refusals]').textContent, /spoke before the greeting/);
  assert.match(ctrl.el.textContent, /203\.0\.113\.9/);
});

test('AccountCalendars lists calendars, makes a URL and explains how to add it', async () => {
  let urls = [];
  const t = transport({
    'calendar.list': () => ({
      calendars: [{ id: '5', title: 'My due dates', predicate: M.CALENDAR_FILTERS[1].json, past_days: 30, future_days: 365, urls }],
    }),
    'calendar_url.create': (d) => {
      urls = [{ id: '11', comment: d.comment, hint: 'abcdef', created_at: '', last_used_at: '', last_client: '', last_error: '', last_error_at: '' }];
      return { id: '11', token: 'a'.repeat(40), hint: 'aaaaaa' };
    },
  });
  const { dispatcher, api } = boot(t);
  globalThis.location = { origin: 'https://kitp.example', search: '', pathname: '/account' };
  try {
    const { ctrl } = mount(api, 'AccountCalendars', {});
    await settle(dispatcher);
    const cal = ctrl.el.querySelector('[data-calendar="5"]');
    assert.match(cal.textContent, /Assigned to me/);
    assert.match(cal.textContent, /30 days ago to 365 days ahead/);
    const comment = cal.querySelector('[data-field="url-comment"]') ?? cal.querySelector('[data-field="urlComment"]');
    comment.value = 'iPhone';
    comment.dispatchEvent({ type: 'input' });
    cal.querySelector('[data-calendar-mint="5"]').dispatchEvent({ type: 'click' });
    await settle(dispatcher);
    assert.equal(t.sent.find((s) => s.key === 'calendar_url.create').data.comment, 'iPhone');
    const minted = ctrl.el.querySelector('[data-minted-value]');
    assert.equal(minted.value, `https://kitp.example/api/v1/calendar/${'a'.repeat(40)}.ics`);
    assert.match(ctrl.el.querySelector('[data-minted]').textContent, /Google Calendar/);
  } finally {
    delete globalThis.location;
  }
});
