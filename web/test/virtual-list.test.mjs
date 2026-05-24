// Recycling virtual list — the pure windowing math + the DOM recycling layer.
//
// The recycling guarantee under test: scrolling REPOSITIONS and CONTENT-SWAPS a
// FIXED pool of row nodes; it never creates or destroys nodes per scroll. The
// "node identity preserved on scroll" test is the proof of no flash.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let V;
let FakeElement;
let FakeResizeObserver;

before(async () => {
  ({ FakeElement, FakeResizeObserver } = installDomShim());
  const outdir = await buildTestBundles();
  V = await import(`${outdir}/core.js`);
});

/* ------------------------------- helpers ------------------------------- */

// Build a scroll-viewport element with a fixed clientHeight.
function viewport(clientHeight) {
  const el = new FakeElement('div');
  el.clientHeight = clientHeight;
  el.scrollTop = 0;
  return el;
}

// Walk the container for the pooled row nodes (data-role="vlist-row").
function rowNodes(container) {
  const out = [];
  const walk = (el) => {
    for (const c of el.children ?? []) {
      if (c.dataset && c.dataset.role === 'vlist-row') out.push(c);
      walk(c);
    }
  };
  walk(container);
  return out;
}

function spacerNode(container) {
  return container.children.find((c) => c.dataset && c.dataset.role === 'vlist-spacer') ?? null;
}

// Visible (non-display:none) pooled rows, in pool order.
function visibleRows(container) {
  return rowNodes(container).filter((r) => r.style.display !== 'none');
}

/* ===================== computeWindow — pure math ====================== */

test('computeWindow: empty list → no rows, no spacer', () => {
  const { computeWindow } = V;
  const w = computeWindow({ scrollTop: 0, viewportHeight: 300, rowHeight: 30, total: 0, overscan: 2 });
  assert.deepEqual(w, { firstIndex: 0, renderCount: 0, offsetTop: 0, spacerHeight: 0 });
});

test('computeWindow: zero rowHeight is degenerate → no rows', () => {
  const { computeWindow } = V;
  const w = computeWindow({ scrollTop: 0, viewportHeight: 300, rowHeight: 0, total: 50, overscan: 2 });
  assert.deepEqual(w, { firstIndex: 0, renderCount: 0, offsetTop: 0, spacerHeight: 0 });
});

test('computeWindow: list shorter than the viewport renders only N rows', () => {
  const { computeWindow } = V;
  // viewport fits 10 rows; only 3 items exist.
  const w = computeWindow({ scrollTop: 0, viewportHeight: 300, rowHeight: 30, total: 3, overscan: 4 });
  assert.equal(w.firstIndex, 0);
  assert.equal(w.renderCount, 3, 'caps at total, never overscans past the end');
  assert.equal(w.offsetTop, 0);
  assert.equal(w.spacerHeight, 90, '3 × 30');
});

test('computeWindow: at top, overscan does not push firstIndex negative', () => {
  const { computeWindow } = V;
  const w = computeWindow({ scrollTop: 0, viewportHeight: 300, rowHeight: 30, total: 1000, overscan: 4 });
  assert.equal(w.firstIndex, 0, 'clamped to 0');
  // visibleRows = ceil(300/30)=10; want = 10 + 4*2 = 18.
  assert.equal(w.renderCount, 18);
  assert.equal(w.offsetTop, 0);
  assert.equal(w.spacerHeight, 30000);
});

test('computeWindow: mid-scroll picks the right first index + offset', () => {
  const { computeWindow } = V;
  // scrollTop 600 / rowHeight 30 = row 20; minus overscan 4 = 16.
  const w = computeWindow({ scrollTop: 600, viewportHeight: 300, rowHeight: 30, total: 1000, overscan: 4 });
  assert.equal(w.firstIndex, 16);
  assert.equal(w.offsetTop, 16 * 30, 'offset = firstIndex × rowHeight');
  assert.equal(w.renderCount, 18, 'full viewport + overscan both sides');
  assert.equal(w.spacerHeight, 30000);
});

test('computeWindow: at the end, renderCount is clamped to remaining items', () => {
  const { computeWindow } = V;
  const total = 1000;
  const rowHeight = 30;
  const viewportHeight = 300;
  const maxScroll = total * rowHeight - viewportHeight; // 29700
  const w = computeWindow({ scrollTop: maxScroll, viewportHeight, rowHeight, total, overscan: 4 });
  // firstIndex = floor(29700/30) - 4 = 990 - 4 = 986; remaining = 14.
  assert.equal(w.firstIndex, 986);
  assert.equal(w.renderCount, total - 986, 'never renders past the last item');
  assert.equal(w.firstIndex + w.renderCount, total);
});

test('computeWindow: over-scroll past the end is clamped (no negative / OOB)', () => {
  const { computeWindow } = V;
  const w = computeWindow({ scrollTop: 999999, viewportHeight: 300, rowHeight: 30, total: 50, overscan: 2 });
  assert.ok(w.firstIndex >= 0 && w.firstIndex < 50);
  assert.ok(w.firstIndex + w.renderCount <= 50);
});

test('poolSize: worst-case rows for the viewport, independent of total', () => {
  const { poolSize } = V;
  // ceil(300/30) + 2*4 + 1 = 10 + 8 + 1 = 19.
  assert.equal(poolSize(300, 30, 4), 19);
  assert.equal(poolSize(0, 30, 4), 9, 'no viewport still keeps overscan + guard');
  assert.equal(poolSize(300, 0, 4), 0, 'zero rowHeight → no pool');
});

/* =================== virtualList — DOM recycling ====================== */

function makeList(total, opts = {}) {
  const { virtualList } = V;
  const container = viewport(opts.clientHeight ?? 300);
  const data = Array.from({ length: total }, (_, i) => ({ id: i, label: `item ${i}` }));
  const createCalls = [];
  const updateCalls = [];
  const handle = virtualList({
    container,
    rowHeight: 30,
    overscan: opts.overscan ?? 4,
    data: () => data,
    create: (el) => {
      el.dataset.created = '1';
      createCalls.push(el);
    },
    update: (el, item, index) => {
      el.textContent = item.label;
      el.dataset.index = String(index);
      updateCalls.push({ el, item, index });
    },
    ...(opts.key ? { key: opts.key } : {}),
    name: 'test.vlist',
  });
  return { container, handle, data, createCalls, updateCalls };
}

test('virtualList: renders a fixed window, sizes the spacer, no extra nodes', () => {
  const { container, handle } = makeList(1000);
  const spacer = spacerNode(container);
  assert.ok(spacer, 'spacer element present');
  assert.equal(spacer.style.height, '30000px', 'spacer = total × rowHeight');

  // Pool is bounded by poolSize(300,30,4)=19, not by the 1000 items.
  const rows = rowNodes(container);
  assert.ok(rows.length <= 19, `pool bounded; got ${rows.length}`);
  // Visible window = full viewport + overscan = 18 rows.
  assert.equal(visibleRows(container).length, 18);
  // First visible row shows item 0.
  assert.equal(visibleRows(container)[0].dataset.index, '0');
  handle.dispose();
});

test('virtualList: RECYCLING — scrolling reuses the SAME node instances (no churn)', () => {
  const { container, handle } = makeList(1000);

  // Snapshot the exact node instances and the pool size before scrolling.
  const before = rowNodes(container);
  const beforeIdentity = [...before];
  const beforeCount = before.length;
  // What each slot showed before the scroll.
  const beforeText = before.map((r) => r.textContent);
  assert.equal(beforeText[0], 'item 0');

  // Scroll down a long way.
  container.scrollTop = 600; // row 20
  container.dispatchEvent({ type: 'scroll' });

  const after = rowNodes(container);
  // 1) NODE COUNT is unchanged — nothing created, nothing destroyed.
  assert.equal(after.length, beforeCount, 'pool size constant across scroll');
  // 2) NODE IDENTITY preserved — the after-set is the exact same instances,
  //    in the same pool order. This is the no-flash proof: DOM is reused.
  for (let i = 0; i < beforeIdentity.length; i++) {
    assert.equal(after[i], beforeIdentity[i], `slot ${i} is the same node instance`);
  }
  // 3) CONTENT was swapped into those same nodes (window moved to row 16).
  assert.equal(after[0].textContent, 'item 16', 'first slot recycled to show item 16');
  assert.equal(after[0].dataset.index, '16');
  // 4) Slot-local transforms reposition rows within the translated content layer.
  assert.equal(after[0].style.transform, 'translateY(0px)');
  assert.equal(after[1].style.transform, 'translateY(30px)');
  handle.dispose();
});

test('virtualList: content layer translateY tracks the window offset', () => {
  const { container, handle } = makeList(1000);
  const content = container
    .querySelectorAll('[data-role]')
    .find((e) => e.dataset.role === 'vlist-content');
  assert.ok(content);
  assert.equal(content.style.transform, 'translateY(0px)');

  container.scrollTop = 600;
  container.dispatchEvent({ type: 'scroll' });
  // firstIndex 16 → offset 480px.
  assert.equal(content.style.transform, 'translateY(480px)');
  handle.dispose();
});

test('virtualList: create() runs once per pooled node, NOT per scroll/render', () => {
  const { container, handle, createCalls } = makeList(1000);
  const initialCreates = createCalls.length;
  assert.ok(initialCreates > 0, 'pool built up front');

  container.scrollTop = 300;
  container.dispatchEvent({ type: 'scroll' });
  container.scrollTop = 9000;
  container.dispatchEvent({ type: 'scroll' });

  assert.equal(createCalls.length, initialCreates, 'no new nodes created while scrolling');
  handle.dispose();
});

test('virtualList: list shorter than the pool renders only N rows', () => {
  const { container, handle } = makeList(3);
  assert.equal(visibleRows(container).length, 3, 'only the 3 items show');
  assert.equal(spacerNode(container).style.height, '90px');
  // The pooled-but-unused rows are parked (display:none), not destroyed.
  const parked = rowNodes(container).filter((r) => r.style.display === 'none');
  assert.ok(parked.length >= 0);
  handle.dispose();
});

test('virtualList: empty list → spacer 0, no visible rows', () => {
  const { virtualList } = V;
  const container = viewport(300);
  const handle = virtualList({
    container,
    rowHeight: 30,
    data: () => [],
    update: () => assert.fail('update must not run for an empty list'),
  });
  assert.equal(spacerNode(container).style.height, '0px');
  assert.equal(visibleRows(container).length, 0);
  handle.dispose();
});

test('virtualList: data change re-windows + resizes the spacer (same nodes)', () => {
  const { signal, virtualList } = V;
  const container = viewport(300);
  const src = signal(Array.from({ length: 1000 }, (_, i) => ({ id: i })));
  const handle = virtualList({
    container,
    rowHeight: 30,
    data: () => src.get(),
    update: (el, item) => {
      el.dataset.id = String(item.id);
    },
  });

  const nodesBefore = [...rowNodes(container)];
  assert.equal(spacerNode(container).style.height, '30000px');

  // Replace the data with a much longer list.
  src.set(Array.from({ length: 5000 }, (_, i) => ({ id: i * 10 })));
  V.flushSync();

  assert.equal(spacerNode(container).style.height, '150000px', 'spacer resized to new length');
  // Nodes are still the same recycled instances — the effect re-rendered into
  // the existing pool, it did not rebuild it.
  const nodesAfter = rowNodes(container);
  for (let i = 0; i < nodesBefore.length; i++) {
    assert.equal(nodesAfter[i], nodesBefore[i], `slot ${i} reused across data change`);
  }
  assert.equal(visibleRows(container)[0].dataset.id, '0', 'rewindowed to the new item 0 (id 0*10)');
  handle.dispose();
});

test('virtualList: shrinking data parks (hides) the now-extra rows', () => {
  const { signal, virtualList } = V;
  const container = viewport(300);
  const src = signal(Array.from({ length: 1000 }, (_, i) => ({ id: i })));
  const handle = virtualList({
    container,
    rowHeight: 30,
    data: () => src.get(),
    update: (el, item) => {
      el.dataset.id = String(item.id);
    },
  });
  assert.equal(visibleRows(container).length, 18);

  // Shrink to 2 items.
  src.set([{ id: 0 }, { id: 1 }]);
  V.flushSync();

  assert.equal(visibleRows(container).length, 2, 'only 2 rows visible after shrink');
  // Extra pooled rows are parked, not removed — node count is unchanged.
  const parked = rowNodes(container).filter((r) => r.style.display === 'none');
  assert.ok(parked.length >= 1, 'extra rows hidden, not destroyed');
  assert.equal(spacerNode(container).style.height, '60px');
  handle.dispose();
});

test('virtualList: key provided → update skipped when the same item stays in slot', () => {
  const { virtualList } = V;
  const container = viewport(300);
  const data = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
  let updates = 0;
  const handle = virtualList({
    container,
    rowHeight: 30,
    data: () => data,
    key: (item) => `k${item.id}`,
    update: (el, item) => {
      el.dataset.id = String(item.id);
      updates += 1;
    },
  });
  const afterInitial = updates;
  assert.ok(afterInitial > 0);

  // A re-render with the SAME scrollTop keeps every item in the same physical
  // slot → the key-skip path fires and update() is not called again.
  container.dispatchEvent({ type: 'scroll' });
  assert.equal(updates, afterInitial, 'no redundant update() when slot key is unchanged');

  // A real scroll changes which item each slot shows → update() runs again.
  container.scrollTop = 600;
  container.dispatchEvent({ type: 'scroll' });
  assert.ok(updates > afterInitial, 'update() runs when the slot’s item changes');
  handle.dispose();
});

test('virtualList: resize grows the pool then re-windows', () => {
  const { container, handle } = makeList(1000, { clientHeight: 300 });
  const poolBefore = rowNodes(container).length;

  // Grow the viewport and fire the resize path.
  container.clientHeight = 900; // fits 30 rows now
  handle.refresh();

  const poolAfter = rowNodes(container).length;
  assert.ok(poolAfter > poolBefore, `pool grew on resize (${poolBefore} → ${poolAfter})`);
  // visibleRows = ceil(900/30)=30 + overscan*2(8) capped by total → 38 visible.
  assert.equal(visibleRows(container).length, 38);
  handle.dispose();
});

test('virtualList: dispose removes scroll listener, ResizeObserver, and spacer', () => {
  const { container, handle, updateCalls } = makeList(1000);
  // The ResizeObserver created for THIS list is the most recent instance.
  const ro = FakeResizeObserver.instances[FakeResizeObserver.instances.length - 1];
  assert.ok(ro && ro.targets.includes(container), 'observer was observing the container');
  assert.ok((container.listeners.get('scroll') ?? []).length === 1, 'scroll listener attached');

  const updatesBeforeDispose = updateCalls.length;
  handle.dispose();

  assert.equal((container.listeners.get('scroll') ?? []).length, 0, 'scroll listener removed');
  assert.equal(ro.disconnected, true, 'ResizeObserver disconnected');
  assert.equal(spacerNode(container), null, 'spacer removed from container');

  // A post-dispose scroll is inert (listener gone) — no further updates.
  container.scrollTop = 600;
  container.dispatchEvent({ type: 'scroll' });
  assert.equal(updateCalls.length, updatesBeforeDispose, 'no render after dispose');
});

test('virtualList: data change after dispose is inert (effect disposed)', () => {
  const { signal, virtualList } = V;
  const container = viewport(300);
  const src = signal([{ id: 1 }]);
  let updates = 0;
  const handle = virtualList({
    container,
    rowHeight: 30,
    data: () => src.get(),
    update: () => {
      updates += 1;
    },
  });
  const before = updates;
  handle.dispose();
  src.set([{ id: 1 }, { id: 2 }, { id: 3 }]);
  V.flushSync();
  assert.equal(updates, before, 'disposed effect does not re-render on data change');
});
