// RefPicker — the card_ref attribute editor over the shared Combobox. Pins:
//   - the `card.search` spec decodes a {rows:[{id,title}]} response with the
//     ids revived to bigint (full int64 precision);
//   - single RefPicker mounts a Combobox; its loadOptions fires `card.search`
//     through the api.callByName CALLBACK path (no promise crosses the surface)
//     and delivers mapped {value,label} options; selecting writes the bigint via
//     onChange; the trigger shows the host-provided currentLabel before open;
//   - multi RefPicker renders chips, adding/removing emits bigint[].

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installUiDom, buildUiBundle, flushMicrotasks } from './ui-dom-setup.mjs';

let RefPicker;
let registerCardSearchSpec;
let CARD_SEARCH_SPEC;
let Api;
let Dispatcher;

before(async () => {
  installUiDom();
  const outdir = await buildUiBundle();
  ({ RefPicker, registerCardSearchSpec, CARD_SEARCH_SPEC, Api, Dispatcher } = await import(
    `${outdir}/ui.js`
  ));
});

beforeEach(() => {
  document.body.replaceChildren();
});

/** A transport that records sent bodies and replays a canned reply. */
function recordingTransport(reply) {
  const sent = [];
  return {
    sent,
    async send(body) {
      sent.push(JSON.parse(body));
      return reply(JSON.parse(body));
    },
  };
}

/**
 * A stub api with the `callByName(specKey, data, onOk)` surface RefPicker uses.
 * It captures each call so a test can deliver via the captured onOk OUT OF BAND
 * — proving the loader is a callback dispatcher, not a promise.
 */
function stubApi() {
  const calls = [];
  return {
    calls,
    callByName(specKey, data, onOk /*, opts */) {
      calls.push({ specKey, data, onOk });
      return `req-${calls.length}`;
    },
  };
}

function mountRefPicker(config, api) {
  const ctx = { api, tree: { at: () => ({ peek: () => null }) } };
  const rp = new RefPicker('RefPicker', { type: 'RefPicker', ...config }, ctx);
  rp.mount(document.body);
  return rp;
}

function trigger(rp) {
  return rp.el.querySelector('[data-cb-trigger]');
}
function search() {
  return document.querySelector('.kf-combobox__search-input');
}
function options() {
  return [...document.querySelectorAll('[data-cb-option]')];
}

/* ----------------------------- card.search spec ---------------------------- */

test('card.search spec decodes {rows:[{id,title}]} with bigint ids', async () => {
  const big = '9007199254740993'; // > Number.MAX_SAFE_INTEGER
  const t = recordingTransport((req) => ({
    status: 200,
    text: JSON.stringify({
      subresponses: req.subrequests.map((s) => ({
        id: s.id,
        ok: true,
        data: { rows: [{ id: big, title: 'Milestone One' }, { id: '7', title: 'Beta' }] },
      })),
    }),
  }));
  const api = new Api(new Dispatcher({ transport: t }));
  registerCardSearchSpec(api);

  let out;
  api.callByName(CARD_SEARCH_SPEC, { cardTypeName: 'milestone', query: 'mile' }, (o) => (out = o));
  await api.dispatcher.flushNow();

  // Encoder emitted snake_case with only the set keys.
  const sub = t.sent[0].subrequests[0];
  assert.equal(sub.endpoint, 'card');
  assert.equal(sub.action, 'search');
  assert.deepEqual(sub.data, { card_type_name: 'milestone', query: 'mile' });

  assert.equal(out.rows.length, 2);
  assert.equal(typeof out.rows[0].id, 'bigint', 'id revived to bigint');
  assert.equal(out.rows[0].id, BigInt(big), 'full int64 precision preserved');
  assert.equal(out.rows[0].title, 'Milestone One');
  assert.equal(out.rows[1].id, 7n);
});

/* ------------------------------- single mode ------------------------------- */

test('single: loadOptions fires card.search and delivers mapped options', async () => {
  const api = stubApi();
  const rp = mountRefPicker({ cardType: 'milestone' }, api);

  rp.combo.openMenu();
  await flushMicrotasks();

  // Opening fired an empty-query card.search through callByName.
  assert.equal(api.calls.length, 1, 'one card.search issued on open');
  assert.equal(api.calls[0].specKey, CARD_SEARCH_SPEC);
  assert.deepEqual(api.calls[0].data, { cardTypeName: 'milestone' }, 'no query / no scope');
  // Loading row until we deliver — nothing crossed as a promise.
  assert.equal(options().length, 0, 'no options before deliver');

  // Deliver OUT OF BAND via the captured onOk (the callback dispatcher path).
  api.calls[0].onOk({ rows: [{ id: 11n, title: 'Alpha' }, { id: 22n, title: 'Beta' }] });

  const labels = options().map((li) => li.textContent);
  assert.deepEqual(labels, ['Alpha', 'Beta'], 'rows mapped to {value,label} options');
  rp.destroy();
});

test('single: selecting an option writes the bigint via onChange', async () => {
  const api = stubApi();
  let picked = 'unset';
  const rp = mountRefPicker({ cardType: 'milestone', onChange: (v) => (picked = v) }, api);

  rp.combo.openMenu();
  await flushMicrotasks();
  api.calls[0].onOk({ rows: [{ id: 11n, title: 'Alpha' }, { id: 22n, title: 'Beta' }] });

  options()[1].click(); // pick 'Beta'
  assert.equal(picked, 22n, 'onChange emitted the bigint id');
  assert.equal(typeof picked, 'bigint');
  assert.equal(rp.getValue(), 22n, 'control value updated');
  assert.equal(options().length, 0, 'menu closed after pick');
  rp.destroy();
});

test('single: trigger shows currentLabel before the menu opens', () => {
  const api = stubApi();
  const rp = mountRefPicker(
    { cardType: 'milestone', value: 99n, currentLabel: 'Sprint 99' },
    api,
  );
  const label = rp.el.querySelector('.kf-combobox__label');
  assert.equal(label.textContent, 'Sprint 99', 'host-provided label shown pre-open');
  // No search was issued just to render the trigger label.
  assert.equal(api.calls.length, 0, 'no card.search fired before open');
  rp.destroy();
});

test('single: trigger falls back to #<id> when no label is known', () => {
  const api = stubApi();
  const rp = mountRefPicker({ cardType: 'milestone', value: 42n }, api);
  const label = rp.el.querySelector('.kf-combobox__label');
  assert.equal(label.textContent, '#42', 'falls back to #<id>');
  rp.destroy();
});

test('single: parentScopePath threads parentCardId into the search', async () => {
  const api = stubApi();
  const ctx = {
    api,
    tree: { at: () => ({ peek: () => 500n }) },
  };
  const rp = new RefPicker(
    'RefPicker',
    { type: 'RefPicker', cardType: 'task', parentScopePath: 'scope.parentId' },
    ctx,
  );
  rp.mount(document.body);

  rp.combo.openMenu();
  await flushMicrotasks();
  assert.deepEqual(
    api.calls[0].data,
    { cardTypeName: 'task', parentCardId: 500n },
    'parent scope peeked + threaded as parentCardId',
  );
  rp.destroy();
});

/* -------------------------------- multi mode ------------------------------- */

test('multi: adding picks emits bigint[] and renders chips', async () => {
  const api = stubApi();
  const emitted = [];
  const rp = mountRefPicker(
    { cardType: 'tag', multi: true, onChangeMulti: (vs) => emitted.push(vs) },
    api,
  );

  // Starts empty (placeholder).
  assert.equal(rp.el.querySelectorAll('[data-rp-chip]').length, 0);

  rp.combo.openMenu();
  await flushMicrotasks();
  api.calls[0].onOk({ rows: [{ id: 1n, title: 'urgent' }, { id: 2n, title: 'backend' }] });
  options()[0].click(); // add 'urgent'

  assert.deepEqual(emitted.at(-1), [1n], 'first add emitted [1n]');
  let chips = [...rp.el.querySelectorAll('[data-rp-chip]')];
  assert.equal(chips.length, 1);
  assert.equal(chips[0].querySelector('.kf-refpicker__chip-label').textContent, 'urgent');

  // Add a second.
  rp.combo.openMenu();
  await flushMicrotasks();
  api.calls.at(-1).onOk({ rows: [{ id: 1n, title: 'urgent' }, { id: 2n, title: 'backend' }] });
  options()[1].click(); // add 'backend'

  assert.deepEqual(emitted.at(-1), [1n, 2n], 'second add emitted [1n, 2n]');
  assert.equal(rp.el.querySelectorAll('[data-rp-chip]').length, 2);
  assert.deepEqual(rp.getValues(), [1n, 2n]);
  rp.destroy();
});

test('multi: removing a chip emits the reduced bigint[]', async () => {
  const api = stubApi();
  const emitted = [];
  const rp = mountRefPicker(
    {
      cardType: 'tag',
      multi: true,
      values: [1n, 2n, 3n],
      currentLabels: { 1: 'urgent', 2: 'backend', 3: 'docs' },
      onChangeMulti: (vs) => emitted.push(vs),
    },
    api,
  );

  let chips = [...rp.el.querySelectorAll('[data-rp-chip]')];
  assert.equal(chips.length, 3, 'seeded chips rendered');
  assert.deepEqual(
    chips.map((c) => c.querySelector('.kf-refpicker__chip-label').textContent),
    ['urgent', 'backend', 'docs'],
    'currentLabels resolved chip labels',
  );

  // Remove the middle one (id 2).
  rp.el.querySelector('[data-rp-remove="2"]').click();
  assert.deepEqual(emitted.at(-1), [1n, 3n], 'remove emitted the reduced list');
  assert.deepEqual(rp.getValues(), [1n, 3n]);
  assert.equal(rp.el.querySelectorAll('[data-rp-chip]').length, 2);
  rp.destroy();
});

test('multi: duplicate add is a no-op (dedupe)', async () => {
  const api = stubApi();
  const emitted = [];
  const rp = mountRefPicker(
    {
      cardType: 'tag',
      multi: true,
      values: [1n],
      currentLabels: { 1: 'urgent' },
      onChangeMulti: (vs) => emitted.push(vs),
    },
    api,
  );

  rp.combo.openMenu();
  await flushMicrotasks();
  api.calls[0].onOk({ rows: [{ id: 1n, title: 'urgent' }] });
  options()[0].click(); // re-pick the already-selected 'urgent'

  assert.equal(emitted.length, 0, 'duplicate add did not emit');
  assert.deepEqual(rp.getValues(), [1n], 'values unchanged');
  rp.destroy();
});
