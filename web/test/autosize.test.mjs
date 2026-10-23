// fitTextarea: auto-grow a textarea to its content, capped. While the text
// only grows (typing) it must not collapse-and-re-measure — that laid out the
// whole text twice per keystroke; at the cap it must not measure at all.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;

before(async () => {
  installDomShim();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
});

/** A textarea stand-in: content height follows the text (20px a line, a
 *  line per 10 chars), the box is whatever height was last set, and every
 *  measurement + height write is logged. */
function fakeTextarea() {
  const log = [];
  let height = 40;
  const ta = {
    value: '',
    style: {
      overflowY: '',
      get height() {
        return `${height}px`;
      },
      set height(v) {
        log.push(`height=${v}`);
        height = v === 'auto' ? 40 : parseInt(v, 10);
      },
    },
    get scrollHeight() {
      log.push('measure');
      return Math.max(height, Math.ceil(ta.value.length / 10) * 20);
    },
    get clientHeight() {
      return height;
    },
  };
  return { ta, log };
}

test('fitTextarea: grows without collapsing while typing, and stops measuring at the cap', () => {
  const { ta, log } = fakeTextarea();
  ta.value = 'x'.repeat(10);
  M.fitTextarea(ta, 100);
  assert.deepEqual(log.splice(0), ['height=auto', 'measure', 'height=40px', 'measure'], 'first fit: full measure');

  ta.value += 'x'; // still fits in the 40px box
  M.fitTextarea(ta, 100);
  assert.deepEqual(log.splice(0), ['measure'], 'fits: one read, no writes');

  ta.value = 'x'.repeat(45); // 5 lines = 100px
  M.fitTextarea(ta, 100);
  assert.deepEqual(log.splice(0), ['measure', 'height=100px'], 'grows in place — never back to auto');
  assert.equal(ta.style.overflowY, 'hidden');

  ta.value = 'x'.repeat(80); // past the cap
  M.fitTextarea(ta, 100);
  assert.deepEqual(log.splice(0), ['measure', 'height=100px']);
  assert.equal(ta.style.overflowY, 'auto', 'scrolls at the cap');

  ta.value += 'more';
  M.fitTextarea(ta, 100);
  assert.deepEqual(log.splice(0), [], 'at the cap, typing costs no layout');

  ta.value = 'x'.repeat(5); // deleted text: re-fit from scratch
  M.fitTextarea(ta, 100);
  assert.deepEqual(log.splice(0), ['height=auto', 'measure', 'height=40px', 'measure']);
  assert.equal(ta.style.overflowY, 'hidden');
});
