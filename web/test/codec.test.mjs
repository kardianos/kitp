/**
 * Generic wire codec (core/codec.ts) — the single camelCase↔snake_case
 * normalization boundary. Proves the mechanical translation that lets the
 * comm-channel specs drop their hand-written encode/decode (T1 of the
 * declarative-data-layer pilot).
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
before(async () => {
  installDomShim(); // test-barrel pulls in controls that touch `document` at eval
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
});

test('decodeWire: snake→camel keys, values pass through, recurses arrays + nesting', () => {
  const got = M.decodeWire({
    imap_host: 'h',
    imap_port: 993,
    has_imap_password: true,
    intake_status_id: '108',
    rows: [{ from_address: 'a@b' }],
  });
  assert.deepEqual(got, {
    imapHost: 'h',
    imapPort: 993, // number stays a number
    hasImapPassword: true,
    intakeStatusId: '108', // id string stays a string
    rows: [{ fromAddress: 'a@b' }],
  });
});

test('encodeWire: camel→snake keys, bigint→string, drops undefined-valued keys', () => {
  const got = M.encodeWire({ imapHost: 'h', imapPort: undefined, id: 7n });
  assert.deepEqual(got, { imap_host: 'h', id: '7' });
  assert.equal('imap_port' in got, false, 'undefined-valued key omitted');
});

test('encodeWire only rewrites keys, never string values (predicate trees survive)', () => {
  const got = M.encodeWire({ tree: { attr: 'comm_status', op: 'has_phase', values: ['active'] } });
  assert.deepEqual(got, { tree: { attr: 'comm_status', op: 'has_phase', values: ['active'] } });
});

test('round-trip: encodeWire(decodeWire(row)) restores every comm_channel key losslessly', () => {
  const wireRow = {
    id: '134',
    name: 'FS',
    channel_type: 'email',
    imap_host: 'mail.x',
    imap_port: 993,
    imap_username: 'in@x',
    smtp_host: 'smtp.x',
    smtp_port: 587,
    smtp_username: 'out@x',
    from_address: 'f@x',
    intake_status_id: '108',
    channel_status: 'enabled',
    has_imap_password: true,
    has_smtp_password: false,
  };
  assert.deepEqual(M.encodeWire(M.decodeWire(wireRow)), wireRow);
});
