// Real-browser (headless Chrome) LAYOUT test for the kanban card.
//
// The other web tests run against a DOM shim with NO layout engine, so they
// can't catch CSS overflow bugs. This drives real Chrome to render a kanban
// card with the production CSS and MANY tags, then measures the result via
// getBoundingClientRect / scrollHeight.
//
// Fix criteria (owner): the card TITLE must always be fully visible; tags may
// clip / truncate, but never the title, and the tags must never push content
// out of the card's fixed-height box (which would spill onto the neighbouring
// card and obscure ITS title).
//
// Harness: inline the production CSS (tokens.css + styles.css) into a temp
// HTML page that reproduces the card DOM (mirrors Kanban.buildCardShell /
// fillCard — grip + .card__title + .card__meta{#id, assignee, .card__tag*}),
// run `chrome --headless --dump-dom`, and parse a JSON result the page writes
// into a <pre>. Skips cleanly when no Chrome binary is present.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const WEB_DIR = fileURLToPath(new URL('../', import.meta.url));

async function chromeBin() {
  for (const bin of ['google-chrome', 'chromium', 'chromium-browser', 'chrome']) {
    try {
      const { stdout } = await execFileP('bash', ['-lc', `command -v ${bin}`]);
      const p = stdout.trim();
      if (p) return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Inline the production CSS: tokens.css then styles.css (with its @import of
 *  tokens stripped, since we inline it ourselves). */
async function productionCss() {
  const tokens = await readFile(join(WEB_DIR, 'design', 'tokens.css'), 'utf8');
  let styles = await readFile(join(WEB_DIR, 'styles.css'), 'utf8');
  styles = styles.replace(/@import\s+url\(["']\.\/design\/tokens\.css["']\);?/, '');
  return `${tokens}\n${styles}`;
}

const RESULT_ID = 'kanban-card-test-result';

/** Build the page: production CSS + the card DOM + a measurement script that
 *  writes a JSON result into a <pre>. tagCount tags are rendered into .card__meta. */
function buildPage(css, tagCount) {
  const tags = Array.from({ length: tagCount }, (_, i) =>
    `<span class="tag-chip card__tag" data-tag-chip=""><span class="tag-chip__label">label-${i}</span></span>`,
  ).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
<body>
<div class="kanban">
  <div class="col" style="width:260px">
    <div class="col__cards">
      <!-- The Kanban virtualList fixes each card to KANBAN_CARD_HEIGHT (64px) and
           absolutely positions it; mirror that here so overflow behaves as in app. -->
      <div class="card" id="card-under-test" style="position:relative;height:64px;width:240px;">
        <span class="card__grip muted" aria-hidden="true">⋮⋮</span>
        <div class="card__title" data-role="title">A fairly long task title that should ellipsize on one line</div>
        <div class="card__meta muted" data-role="meta">
          <span class="card__id">#201</span>
          <span class="card__assignee" data-role="assignee">Ada Lovelace</span>
          ${tags}
        </div>
      </div>
    </div>
  </div>
</div>
<pre id="${RESULT_ID}"></pre>
<script>
  var card = document.getElementById('card-under-test');
  var title = card.querySelector('[data-role="title"]');
  var c = card.getBoundingClientRect();
  var t = title.getBoundingClientRect();
  var res = {
    cardHeight: Math.round(c.height),
    scrollH: card.scrollHeight,
    clientH: card.clientHeight,
    // Content taller than the fixed box => tags wrapped and spilled out.
    overflows: card.scrollHeight > card.clientHeight + 1,
    // Title's box fully inside the card's visible box (not clipped/pushed out).
    titleInside:
      t.top >= c.top - 1 && t.bottom <= c.bottom + 1 &&
      t.left >= c.left - 1 && t.right <= c.right + 1,
    titleHeight: Math.round(t.height),
  };
  document.getElementById('${RESULT_ID}').textContent = JSON.stringify(res);
</script>
</body></html>`;
}

/** Render the page in headless Chrome and return the parsed measurement JSON. */
async function measure(bin, css, tagCount) {
  const dir = await mkdtemp(join(tmpdir(), 'kitp-card-layout-'));
  const htmlPath = join(dir, 'card.html');
  const profile = join(dir, 'profile');
  await writeFile(htmlPath, buildPage(css, tagCount));
  try {
    const { stdout } = await execFileP(
      bin,
      [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
        '--window-size=1200,900', `--user-data-dir=${profile}`,
        '--dump-dom', `file://${htmlPath}`,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const m = stdout.match(new RegExp(`<pre id="${RESULT_ID}">([\\s\\S]*?)</pre>`));
    if (!m) throw new Error(`no result marker in chrome --dump-dom output:\n${stdout.slice(0, 500)}`);
    return JSON.parse(m[1]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

let BIN = null;
let CSS = '';
before(async () => {
  BIN = await chromeBin();
  if (BIN) CSS = await productionCss();
});

test('kanban card: many tags never push the title out or overflow the card box', async (t) => {
  if (!BIN) {
    t.skip('no Chrome binary found (google-chrome / chromium)');
    return;
  }

  // A heavily-tagged card — far more tags than fit on one line in a column.
  const res = await measure(BIN, CSS, 16);

  assert.equal(
    res.overflows,
    false,
    `card overflowed its fixed 64px box (scrollH=${res.scrollH} > clientH=${res.clientH}): ` +
      `tags must clip/truncate on one line, not wrap and spill onto the next card`,
  );
  assert.equal(
    res.titleInside,
    true,
    'the card title must be fully visible within the card box, never clipped or pushed out by tags',
  );
  // Sanity: the title actually rendered (one line of real text), and the card
  // stayed at its fixed height.
  assert.ok(res.titleHeight > 0, 'title rendered');
  assert.ok(res.cardHeight <= 72, `card height stayed bounded (~64px), got ${res.cardHeight}`);
});

test('kanban card: a card with no tags also keeps the title visible (control)', async (t) => {
  if (!BIN) {
    t.skip('no Chrome binary found');
    return;
  }
  const res = await measure(BIN, CSS, 0);
  assert.equal(res.overflows, false, 'a tagless card must not overflow');
  assert.equal(res.titleInside, true, 'a tagless card title is visible');
});
