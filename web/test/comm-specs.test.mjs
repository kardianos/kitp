// Wire-contract tests for the comm-thread specs (#19): encode → snake_case the
// Go handlers accept; decode ← the CommRow/ReplyRow shapes they return.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installUiDom } from './ui-dom-setup.mjs';

let M;
before(async () => {
  installUiDom(); // the test-barrel touches DOM globals at module load
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
});

/** A tiny transport that records the last batch body + returns canned data. */
function harness(responder) {
  const sent = { subs: [] };
  const transport = {
    async send(body) {
      const req = JSON.parse(body);
      sent.subs.push(...req.subrequests);
      const subresponses = req.subrequests.map((sr) => responder(sr));
      return { status: 200, text: JSON.stringify({ subresponses }) };
    },
  };
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerCommThreadSpecs(api);
  return { api, dispatcher, sent };
}

test('comm.list_for_task encodes task_id + decodes comms with replies', async () => {
  const { api, dispatcher, sent } = harness((sr) => ({
    id: sr.id,
    ok: true,
    data: {
      rows: [
        {
          id: '700',
          title: 'Re: question',
          thread_id: 'abc123',
          channel_id: '5',
          comm_status: '40',
          recipients: ['10', '11'],
          replies: [
            {
              id: '800',
              to: 'a@x.com',
              from: 'b@y.com',
              subject: 'abc123 Wire pickers',
              body_text: 'hello',
              delivery_status: 'received',
              created_at: '2026-05-25T10:00:00Z',
            },
          ],
        },
      ],
    },
  }));

  let out;
  api.callByName('comm.list_for_task', { taskId: 54n }, (o) => {
    out = o;
  });
  await dispatcher.flushNow();

  // Encoded snake_case task_id.
  assert.equal(sent.subs[0].data.task_id, '54');
  // Decoded shape.
  assert.equal(out.rows.length, 1);
  const c = out.rows[0];
  assert.equal(c.id, 700n);
  assert.equal(c.threadId, 'abc123');
  assert.equal(c.channelId, 5n);
  assert.deepEqual(c.recipients, [10n, 11n]);
  assert.equal(c.replies.length, 1);
  assert.equal(c.replies[0].id, 800n);
  assert.equal(c.replies[0].bodyText, 'hello');
  assert.equal(c.replies[0].deliveryStatus, 'received');
});

test('comm.create / set_recipients / reply.post encode the snake_case payloads', async () => {
  const { api, dispatcher, sent } = harness((sr) => {
    if (sr.action === 'create') return { id: sr.id, ok: true, data: { comm_id: '900', thread_id: 'zzz' } };
    if (sr.action === 'set_recipients') return { id: sr.id, ok: true, data: { count: 2 } };
    return { id: sr.id, ok: true, data: { reply_id: '950' } }; // reply.post
  });

  let created;
  api.callByName(
    'comm.create',
    { taskId: 54n, channelId: 5n, subject: 'Hi', recipientPersonIds: [10n, 11n] },
    (o) => {
      created = o;
    },
  );
  await dispatcher.flushNow();
  const createSub = sent.subs.find((s) => s.action === 'create');
  assert.deepEqual(createSub.data, {
    task_id: '54',
    channel_id: '5',
    subject: 'Hi',
    recipient_person_ids: ['10', '11'],
  });
  assert.equal(created.commId, 900n);
  assert.equal(created.threadId, 'zzz');

  api.callByName('comm.set_recipients', { commId: 900n, recipientPersonIds: [10n] }, () => {});
  api.callByName('reply.post', { commId: 900n, body: 'thanks' }, () => {});
  await dispatcher.flushNow();
  const recipSub = sent.subs.find((s) => s.action === 'set_recipients');
  assert.deepEqual(recipSub.data, { comm_id: '900', recipient_person_ids: ['10'] });
  const replySub = sent.subs.find((s) => s.action === 'post');
  assert.deepEqual(replySub.data, { comm_id: '900', body: 'thanks' });
});
