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
  // Register the controls the shell mounts (Control.register throws on dup).
  M.registerScreenFilterBar();
  M.registerScreenHost();
  M.registerKanbanControls();
  M.registerAppShell();
  M.registerHelpOverlay();
  M.registerProjectList();
});

function bootApi(transport) {
  const dispatcher = new M.Dispatcher({ transport });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api);
  M.registerProjectSpecs(api);
  return { dispatcher, api };
}

/** Dispatch a keydown on the shim document (the overlay-tier listener). */
function docKeydown(key) {
  document.dispatchEvent({ type: 'keydown', key });
}

/**
 * Mount an AppShell whose `helpSnapshot` is wired to a REAL HotkeyController
 * rooted at the shell — so the overlay renders from the same resolved binding
 * set the live keydown path would, exactly as in boot (main.ts).
 */
function mountShell() {
  const { api } = bootApi(M.mockTransport());
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(31n);
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  let shell = null;
  const bus = { emit: (type, detail) => shell?.intent(type, detail) };
  const ctx = { api, tree, bus, scope };

  // Forward-ref the controller the snapshot closure reads (boot order parity).
  let hotkeys = null;
  const cfg = {
    type: 'AppShell',
    view: 'projects',
    boardConfig: { type: 'ScreenHost', screen: { slug: 'kanban', layout: 'kanban' } },
    // The shell's own global-tier chords, including `?`/`Mod+/` → toggleHelp.
    hotkeys: M.shellHotkeys((intent) => bus.emit(intent)),
    helpSnapshot: () => hotkeys?.snapshot() ?? new Map(),
  };
  shell = M.Control.New('AppShell', cfg, ctx);
  shell.mount(new FakeElement('div'));

  const rootSig = M.signal(shell, 'root');
  const activeSig = M.signal(shell, 'active');
  hotkeys = new M.HotkeyController({ root: rootSig, active: activeSig });
  return { shell, hotkeys };
}

function overlayEl(shell) {
  return shell.el.findByControl('HelpOverlay')[0] ?? null;
}
function isVisible(el) {
  return el && el.style.display !== 'none';
}
function rowTexts(overlay) {
  return overlay.querySelectorAll('[data-help-row]').map((r) => r.textContent);
}

/* -------------------------------------------------------------------------- */
/* toggleHelp was a DEAD intent; it now mounts + shows the overlay.            */
/* -------------------------------------------------------------------------- */

test('the shell mounts a hidden HelpOverlay (toggleHelp is no longer dead)', () => {
  const { shell } = mountShell();
  const overlay = overlayEl(shell);
  assert.ok(overlay, 'a HelpOverlay control is mounted in the shell');
  assert.equal(isVisible(overlay), false, 'starts hidden until toggleHelp fires');
});

test('clicking the topbar ? button opens (then closes) the help overlay', () => {
  const { shell } = mountShell();
  const overlay = overlayEl(shell);
  assert.equal(isVisible(overlay), false, 'hidden at rest');

  const btn = shell.el.querySelector('[data-help-toggle]');
  assert.ok(btn, 'the topbar ? button is present');
  btn.dispatchEvent({ type: 'click', target: btn });
  assert.equal(isVisible(overlay), true, 'click opened the help overlay');
  // Toggling again (second click) closes it.
  btn.dispatchEvent({ type: 'click', target: btn });
  assert.equal(isVisible(overlay), false, 'second click closed it');
});

test('firing toggleHelp shows the overlay; it lists the live global bindings', () => {
  const { shell } = mountShell();
  const overlay = overlayEl(shell);

  shell.intent('toggleHelp');
  assert.equal(isVisible(overlay), true, 'toggleHelp opens the overlay');

  // The global tier is present and labelled.
  const globalGroup = overlay.querySelectorAll('[data-help-scope]').find(
    (g) => g.dataset.helpScope === 'global',
  );
  assert.ok(globalGroup, 'a "global" scope group is rendered');

  // The global chords from shellHotkeys appear as labelled rows.
  const text = overlay.textContent;
  assert.match(text, /Go to Projects/, 'lists the g p binding label');
  assert.match(text, /Go to Kanban/, 'lists the g k binding label');
  assert.match(text, /Keyboard shortcuts/, 'lists the help binding label');

  // The `?` / Ctrl+/ aliases collapse onto ONE row for the help binding.
  const helpRow = overlay
    .querySelectorAll('[data-help-row]')
    .find((r) => /Keyboard shortcuts/.test(r.textContent));
  assert.ok(helpRow, 'a single row carries the help binding');
  // The keys cell is the row's <kbd>; its text shows both aliases comma-joined.
  const keys = helpRow.querySelector('KBD');
  assert.match(keys.textContent, /\?/, 'the ? alias shows on the help row');
  assert.match(keys.textContent, /,/, 'aliases are comma-joined on one row');

  // Chords render in their `then`-joined display form (e.g. "g then p").
  assert.ok(
    rowTexts(overlay).some((t) => /g then p/.test(t)),
    'chord bindings render via formatBinding (then-joined)',
  );
});

/* -------------------------------------------------------------------------- */
/* Esc and `?` close the overlay (overlay-tier keydown).                       */
/* -------------------------------------------------------------------------- */

test('Esc closes the open overlay', () => {
  const { shell } = mountShell();
  const overlay = overlayEl(shell);
  shell.intent('toggleHelp');
  assert.equal(isVisible(overlay), true);

  docKeydown('Escape');
  assert.equal(isVisible(overlay), false, 'Esc closes the overlay');
});

test('`?` closes the open overlay', () => {
  const { shell } = mountShell();
  const overlay = overlayEl(shell);
  shell.intent('toggleHelp');
  assert.equal(isVisible(overlay), true);

  docKeydown('?');
  assert.equal(isVisible(overlay), false, '? closes the overlay');
});

test('toggleHelp toggles closed when already open', () => {
  const { shell } = mountShell();
  const overlay = overlayEl(shell);
  shell.intent('toggleHelp');
  assert.equal(isVisible(overlay), true, 'first toggle opens');
  shell.intent('toggleHelp');
  assert.equal(isVisible(overlay), false, 'second toggle closes');
});

test('the topbar `?` button raises toggleHelp and opens the overlay', () => {
  const { shell } = mountShell();
  const overlay = overlayEl(shell);
  const helpBtn = shell.el.querySelector('[data-help-toggle]');
  assert.ok(helpBtn, 'the topbar help button is present');
  helpBtn.dispatchEvent({ type: 'click', target: helpBtn });
  assert.equal(isVisible(overlay), true, 'clicking ? opens the overlay');
});

test('the ⓘ button opens "About this screen"; the ? button opens "Keyboard shortcuts"', () => {
  const { shell } = mountShell();
  const overlay = overlayEl(shell);
  const title = () => overlay.querySelector('[data-help-title]').textContent;

  // The ⓘ instructions button raises its OWN intent → the instructions view.
  const infoBtn = shell.el.querySelector('[data-instructions-toggle]');
  assert.ok(infoBtn, 'the topbar instructions button is present');
  infoBtn.dispatchEvent({ type: 'click', target: infoBtn });
  assert.equal(isVisible(overlay), true, 'ⓘ opens the overlay');
  assert.equal(title(), 'About this screen', 'ⓘ opens the instructions view');
  shell.intent('toggleInstructions'); // same mode again → close
  assert.equal(isVisible(overlay), false);

  // The ? button → the shortcuts-only view (a separate intent).
  const helpBtn = shell.el.querySelector('[data-help-toggle]');
  helpBtn.dispatchEvent({ type: 'click', target: helpBtn });
  assert.equal(isVisible(overlay), true, '? opens the overlay');
  assert.equal(title(), 'Keyboard shortcuts', '? opens the shortcuts view');
});

test('? (shortcuts mode) keeps the instructions content + separator hidden', () => {
  const { shell } = mountShell();
  const overlay = overlayEl(shell);
  shell.intent('toggleHelp'); // shortcuts mode
  const sep = overlay.querySelector('[data-help-sep]');
  const content = overlay.querySelector('[data-help-content]');
  assert.ok(sep && content, 'the content region + <hr> separator elements exist');
  assert.equal(content.style.display, 'none', 'no instructions content in shortcuts mode');
  assert.equal(sep.style.display, 'none', 'separator hidden in shortcuts mode');
  // The machine-generated shortcut rows are still present.
  assert.ok(overlay.querySelectorAll('[data-help-row]').length > 0, 'shortcut rows render');
});

test('switching ? → ⓘ while open flips the view in place (stays open)', () => {
  const { shell } = mountShell();
  const overlay = overlayEl(shell);
  const title = () => overlay.querySelector('[data-help-title]').textContent;
  shell.intent('toggleHelp');
  assert.equal(title(), 'Keyboard shortcuts');
  shell.intent('toggleInstructions'); // other mode while open → switch, stay open
  assert.equal(isVisible(overlay), true, 'still open after switching modes');
  assert.equal(title(), 'About this screen', 'switched to the instructions view');
});

/* -------------------------------------------------------------------------- */
/* groupSnapshot: pure grouping + alias collapse + scope ordering.             */
/* -------------------------------------------------------------------------- */

test('groupSnapshot collapses aliases, groups by scope, orders global first', () => {
  const run = () => {};
  // A synthetic snapshot shaped like HotkeyController.snapshot():
  //   token -> { run, fireInInputs, depth, label, scope }
  const snap = new Map([
    ['?', { run, fireInInputs: true, depth: 0, label: 'Keyboard shortcuts', scope: 'global' }],
    ['Mod+/', { run, fireInInputs: true, depth: 0, label: 'Keyboard shortcuts', scope: 'global' }],
    ['g p', { run: () => {}, fireInInputs: false, depth: 0, label: 'Go to Projects', scope: 'global' }],
    ['j', { run: () => {}, fireInInputs: false, depth: 2, label: 'Next card', scope: 'Kanban' }],
  ]);

  const groups = M.groupSnapshot(snap);
  assert.deepEqual(
    groups.map(([s]) => s),
    ['global', 'Kanban'],
    'global (shallowest) leads; deeper scope follows',
  );

  const [, globalRows] = groups[0];
  const helpRow = globalRows.find((r) => r.label === 'Keyboard shortcuts');
  assert.ok(helpRow, 'the help row is present');
  // Same scope + label + handler → one row with both aliases joined.
  assert.match(helpRow.bindings, /\?/);
  assert.match(helpRow.bindings, /,/);
  assert.equal(
    globalRows.length,
    2,
    'two distinct global rows (help aliases collapsed; g p separate)',
  );
});
