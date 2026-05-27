/**
 * URL router tests — the History-API router that replaced the AppShell's
 * `shell.view` signal. Covers:
 *
 *   - matchRoute: each route pattern → { name, params }, unknown → notfound.
 *   - slug→layout seam (#29): screenLayoutForSlug maps known slugs, unknown →
 *     'unknown' (→ ScreenHost NotFound).
 *   - navigate(): pushes history + lands the route leaf + (via the shell)
 *     swaps the outlet.
 *   - popstate (back/forward): re-parses the URL and re-lands the route.
 *   - deep-link parse on initial load: installRouter lands the live-URL route.
 *   - requireAdmin guard SEAM: admits today (no client admin signal).
 *
 * The router writes a single tree leaf the AppShell outlet effect derives
 * from; tests assert on both the leaf and the live outlet (the rendered body
 * control) so the one-way route→outlet path is exercised end-to-end.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;
let FakeElement;
let setPath;

before(async () => {
  ({ FakeElement, setPath } = installDomShim());
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
  // The controls the shell mounts (Control.register throws on dup, so once).
  M.registerScreenFilterBar();
  M.registerScreenHost();
  M.registerKanbanControls();
  M.registerTagChip();
  M.registerGrid();
  M.registerGridCardRefAttrs();
  M.registerAppShell();
  M.registerHelpOverlay();
  M.registerProjectList();
  M.registerMasterDetail();
  // TaskDetail (#33) is now a real control for the `/task/:id` route, plus the
  // editors it composes (RefPicker → Combobox; DatePicker) + the card.search spec.
  M.registerCombobox();
  M.registerDatePicker();
  M.registerRefPicker();
  M.registerTaskDetail();
});

beforeEach(() => {
  // Fresh URL + detached router binding per test (the app installs once).
  setPath('/');
  M._resetRouterForTest();
});

function bootApi() {
  const dispatcher = new M.Dispatcher({ transport: M.mockTransport() });
  const api = new M.Api(dispatcher);
  M.registerKanbanSpecs(api);
  M.registerProjectSpecs(api);
  M.registerAdminSpecs(api);
  M.registerCardSearchSpec(api); // TaskDetail's RefPicker label resolution
  return { dispatcher, api };
}

/* -------------------------------------------------------------------------- */
/* matchRoute: the route table.                                                */
/* -------------------------------------------------------------------------- */

test('matchRoute: / and /projects → projects', () => {
  assert.equal(M.matchRoute('/').name, 'projects');
  assert.equal(M.matchRoute('/projects').name, 'projects');
});

test('matchRoute: /activity → activity; activityUrl builds it', () => {
  assert.equal(M.matchRoute('/activity').name, 'activity');
  assert.equal(M.activityUrl(), '/activity');
});

test('matchRoute: /project/:id → project with the id param', () => {
  const m = M.matchRoute('/project/42');
  assert.equal(m.name, 'project');
  assert.equal(m.params.id, '42');
});

test('matchRoute: /project/:id/screen/:slug → screen with id + slug', () => {
  const m = M.matchRoute('/project/42/screen/grid');
  assert.equal(m.name, 'screen');
  assert.equal(m.params.id, '42');
  assert.equal(m.params.slug, 'grid');
});

test('matchRoute: /admin/:key → admin with the key', () => {
  const m = M.matchRoute('/admin/users');
  assert.equal(m.name, 'admin');
  assert.equal(m.params.key, 'users');
});

test('matchRoute: /task/:id → task with the id', () => {
  const m = M.matchRoute('/task/7');
  assert.equal(m.name, 'task');
  assert.equal(m.params.id, '7');
});

test('matchRoute: unknown path → notfound', () => {
  assert.equal(M.matchRoute('/nope/here').name, 'notfound');
  assert.equal(M.matchRoute('/project').name, 'notfound'); // wrong segment count
});

test('helpTopicForRoute: each route maps to its embedded-help topic key', () => {
  // The task + project routes used to fall through to null, so the task detail
  // showed keybindings with no authored prose even though `task_detail` exists.
  assert.equal(M.helpTopicForRoute(M.matchRoute('/task/7')), 'task_detail', 'task → task_detail prose');
  assert.equal(M.helpTopicForRoute(M.matchRoute('/admin/users')), 'admin.users');
  assert.equal(M.helpTopicForRoute(M.matchRoute('/project/9/screen/grid')), 'layout.grid');
  assert.equal(M.helpTopicForRoute(M.matchRoute('/project/9/screen/kanban')), 'layout.kanban');
  assert.equal(M.helpTopicForRoute(M.matchRoute('/project/9')), 'layout.kanban', 'project board default');
  // No authored topic for the all-projects landing / not-found.
  assert.equal(M.helpTopicForRoute(M.matchRoute('/projects')), null);
  assert.equal(M.helpTopicForRoute(M.matchRoute('/nope')), null);
});

test('matchRoute: trailing slash + query string are normalised away', () => {
  assert.equal(M.matchRoute('/projects/').name, 'projects');
  const m = M.matchRoute('/project/42?foo=bar');
  assert.equal(m.name, 'project');
  assert.equal(m.params.id, '42');
});

/* -------------------------------------------------------------------------- */
/* slug → layout seam (#29).                                                   */
/* -------------------------------------------------------------------------- */

test('screenLayoutForSlug: known slugs map; unknown → unknown (NotFound)', () => {
  assert.equal(M.screenLayoutForSlug('kanban'), 'kanban');
  assert.equal(M.screenLayoutForSlug('grid'), 'grid');
  assert.equal(M.screenLayoutForSlug('inbox'), 'list');
  assert.equal(M.screenLayoutForSlug('project'), 'project');
  assert.equal(M.screenLayoutForSlug('hologram'), 'unknown');
});

/* -------------------------------------------------------------------------- */
/* navigate(): history + route leaf.                                           */
/* -------------------------------------------------------------------------- */

test('navigate pushes history and lands the route leaf', () => {
  const tree = new M.TreeNode({}, []);
  M.installRouter(tree); // lands the initial '/' route

  M.navigate('/admin/workflows');
  assert.equal(location.pathname, '/admin/workflows', 'history url updated');
  const route = tree.at(['router', 'route']).peek();
  assert.equal(route.name, 'admin');
  assert.equal(route.params.key, 'workflows');

  // pushState added an entry → back() returns to the previous route.
  M.navigate('/project/9/screen/grid');
  assert.equal(tree.at(['router', 'route']).peek().name, 'screen');
});

test('navigate { replace } does not add a back entry', () => {
  const tree = new M.TreeNode({}, []);
  setPath('/projects');
  M.installRouter(tree);

  M.navigate('/admin/users', { replace: true });
  assert.equal(location.pathname, '/admin/users');
  // back() from a replaced entry lands on the install-time entry, not /projects
  // (there was only one entry, replaced in place) → still /admin/users.
  history.back();
  assert.equal(location.pathname, '/admin/users', 'replace left a single entry');
});

/* -------------------------------------------------------------------------- */
/* popstate (back/forward) re-lands the route.                                 */
/* -------------------------------------------------------------------------- */

test('popstate (back) re-parses the URL and re-lands the route leaf', () => {
  const tree = new M.TreeNode({}, []);
  M.installRouter(tree);

  M.navigate('/admin/users');
  M.navigate('/task/7');
  assert.equal(tree.at(['router', 'route']).peek().name, 'task');

  history.back(); // → /admin/users (fires popstate)
  let route = tree.at(['router', 'route']).peek();
  assert.equal(route.name, 'admin', 'back re-landed the admin route');
  assert.equal(route.params.key, 'users');

  history.forward(); // → /task/7
  route = tree.at(['router', 'route']).peek();
  assert.equal(route.name, 'task');
  assert.equal(route.params.id, '7');
});

/* -------------------------------------------------------------------------- */
/* deep-link parse on initial load.                                            */
/* -------------------------------------------------------------------------- */

test('installRouter lands the deep-link route from the live URL', () => {
  setPath('/admin/workflows');
  const tree = new M.TreeNode({}, []);
  M.installRouter(tree);
  const route = tree.at(['router', 'route']).peek();
  assert.equal(route.name, 'admin', 'cold deep-link parsed on install');
  assert.equal(route.params.key, 'workflows');
});

/* -------------------------------------------------------------------------- */
/* requireAdmin guard: gates /admin/* on the landed auth.user identity.        */
/* -------------------------------------------------------------------------- */

function landAuth(tree, { userId = 5n, isAdmin = false, roles } = {}) {
  tree.at([...M.AUTH_USER_PATH]).set({
    userId,
    displayName: isAdmin ? 'Admin' : 'Worker',
    roles: roles ?? (isAdmin ? ['admin'] : ['worker']),
    isAdmin,
    isAgent: false,
    parentUserId: null,
  });
}

test('routeGuard: requireAdmin admits with no tree bound (early/test) and for non-admin routes', () => {
  // No tree bound (beforeEach reset routerTree) → admit. requireAuth routes are
  // a pass-through regardless (the SSO bounce handles unauthenticated access).
  assert.deepEqual(M.routeGuard(M.matchRoute('/admin/users')), { ok: true });
  assert.deepEqual(M.routeGuard(M.matchRoute('/projects')), { ok: true });
  assert.deepEqual(M.routeGuard(M.matchRoute('/project/42/screen/grid')), { ok: true });
  assert.deepEqual(M.routeGuard(M.matchRoute('/nope')), { ok: true });
});

test('routeGuard: requireAdmin admits an admin, redirects a non-admin to /projects', () => {
  const tree = new M.TreeNode({}, []);
  M.installRouter(tree); // binds routerTree so the guard can peek auth.user

  // Unresolved identity (probe not landed) → admit (cold deep-link grace).
  assert.deepEqual(M.routeGuard(M.matchRoute('/admin/users')), { ok: true });

  // Non-admin → redirect to /projects.
  landAuth(tree, { isAdmin: false });
  assert.deepEqual(M.routeGuard(M.matchRoute('/admin/users')), {
    ok: false,
    redirectTo: '/projects',
  });

  // Admin → admit.
  landAuth(tree, { isAdmin: true });
  assert.deepEqual(M.routeGuard(M.matchRoute('/admin/users')), { ok: true });
  // requireAuth routes are unaffected by admin status.
  assert.deepEqual(M.routeGuard(M.matchRoute('/projects')), { ok: true });
});

test('routeGuard: a manager reaches manager-permitted admin keys, not the rest', () => {
  const tree = new M.TreeNode({}, []);
  M.installRouter(tree, { managerAdminKeys: ['enums'] });

  // A manager (not admin) is admitted to the permitted key…
  landAuth(tree, { isAdmin: false, roles: ['manager'] });
  assert.deepEqual(M.routeGuard(M.matchRoute('/admin/enums')), { ok: true }, 'manager → Manage values');
  // …but redirected from an admin-only key.
  assert.deepEqual(M.routeGuard(M.matchRoute('/admin/roles')), {
    ok: false,
    redirectTo: '/projects',
  }, 'manager → roles is admin-only');

  // A plain worker is redirected even from the permitted key.
  landAuth(tree, { isAdmin: false, roles: ['worker'] });
  assert.deepEqual(M.routeGuard(M.matchRoute('/admin/enums')), {
    ok: false,
    redirectTo: '/projects',
  }, 'worker → no admin access');

  // An admin still reaches everything.
  landAuth(tree, { isAdmin: true });
  assert.deepEqual(M.routeGuard(M.matchRoute('/admin/enums')), { ok: true });
  assert.deepEqual(M.routeGuard(M.matchRoute('/admin/roles')), { ok: true });
});

test('navigate to /admin/* redirects a non-admin away (lands /projects in the leaf)', () => {
  const tree = new M.TreeNode({}, []);
  setPath('/projects');
  M.installRouter(tree);
  landAuth(tree, { isAdmin: false });

  M.navigate('/admin/users');
  // The guard rejected → the leaf + the URL landed on /projects, not /admin.
  assert.equal(tree.at(['router', 'route']).peek().name, 'projects', 'non-admin redirected to projects');
  assert.equal(location.pathname, '/projects', 'history rewritten to the redirect target');
});

test('navigate to /admin/* admits an admin (lands the admin route)', () => {
  const tree = new M.TreeNode({}, []);
  setPath('/projects');
  M.installRouter(tree);
  landAuth(tree, { isAdmin: true });

  M.navigate('/admin/users');
  const route = tree.at(['router', 'route']).peek();
  assert.equal(route.name, 'admin', 'admin admitted to the admin route');
  assert.equal(route.params.key, 'users');
  assert.equal(location.pathname, '/admin/users');
});

/* -------------------------------------------------------------------------- */
/* End-to-end: navigate swaps the AppShell outlet (route → outlet, one-way).   */
/* -------------------------------------------------------------------------- */

function mountShell(opts = {}) {
  const { api } = bootApi();
  const tree = new M.TreeNode({}, []);
  tree.at(['scope', 'projectId']).set(null);
  if (opts.auth !== undefined) landAuth(tree, opts.auth);
  const scope = {
    get projectId() {
      return tree.at(['scope', 'projectId']).peek() ?? null;
    },
  };
  const ctx = { api, tree, scope };
  M.installRouter(tree); // lands the current URL route BEFORE mount

  const shell = M.Control.New(
    'AppShell',
    {
      type: 'AppShell',
      boardConfig: { type: 'ScreenHost', screen: { slug: 'kanban', layout: 'kanban' } },
      adminConfigFor: (key) => (key === 'users' ? M.adminScreenConfig('users') : null),
      ...(opts.adminLinks !== undefined ? { adminLinks: opts.adminLinks } : {}),
    },
    ctx,
  );
  shell.mount(new FakeElement('div'));
  return { shell, tree };
}

test('rail ADMIN section: a manager sees only manager-permitted links; an admin sees all', () => {
  setPath('/projects');
  const adminLinks = [
    { label: 'Values', key: 'enums', minRole: 'manager' },
    { label: 'Users…', key: 'users' },
  ];
  const { shell, tree } = mountShell({ adminLinks });
  const shown = (key) =>
    shell.el.querySelector(`[data-admin-key="${key}"]`).style.display !== 'none';
  const sectionShown = () => shell.el.querySelector('[data-admin-toggle]').style.display !== 'none';

  // A manager: the Values link + the section show; admin-only links stay hidden.
  landAuth(tree, { isAdmin: false, roles: ['manager'] });
  M.flushSync?.();
  assert.equal(shown('enums'), true, 'manager sees Manage values');
  assert.equal(shown('users'), false, 'manager does not see admin-only Users');
  assert.equal(sectionShown(), true, 'ADMIN heading shows when any link is visible');

  // A plain worker: nothing shows.
  landAuth(tree, { isAdmin: false, roles: ['worker'] });
  M.flushSync?.();
  assert.equal(shown('enums'), false, 'worker sees no admin links');
  assert.equal(sectionShown(), false, 'ADMIN heading hidden when no link is visible');

  // An admin: everything shows.
  landAuth(tree, { isAdmin: true });
  M.flushSync?.();
  assert.equal(shown('enums'), true);
  assert.equal(shown('users'), true, 'admin sees every link');
  assert.equal(sectionShown(), true);
});

test('rail ADMIN: Workspace + Project sub-sections render with their own links', () => {
  setPath('/projects');
  const adminLinks = [
    { label: 'People', key: 'people', section: 'workspace' },
    { label: 'Roles', key: 'roles', section: 'workspace' },
    { label: 'Screens', key: 'screens', section: 'project' },
    { label: 'Values', key: 'enums', section: 'project', minRole: 'manager' },
  ];
  const { shell, tree } = mountShell({ adminLinks });
  landAuth(tree, { isAdmin: true });
  M.flushSync?.();

  // Two distinct section headings.
  assert.ok(shell.el.querySelector('[data-admin-toggle="workspace"]'), 'Workspace heading');
  assert.ok(shell.el.querySelector('[data-admin-toggle="project"]'), 'Project heading');

  // Each link lives under its section's list.
  const wsList = shell.el.querySelector('[data-admin-list="workspace"]');
  const prList = shell.el.querySelector('[data-admin-list="project"]');
  assert.ok(wsList.querySelector('[data-admin-key="people"]') && wsList.querySelector('[data-admin-key="roles"]'), 'workspace links');
  assert.ok(prList.querySelector('[data-admin-key="screens"]') && prList.querySelector('[data-admin-key="enums"]'), 'project links');
  assert.equal(wsList.querySelector('[data-admin-key="screens"]'), null, 'project link not in workspace list');
});

test('rail ADMIN: a manager sees the Project section but not Workspace', () => {
  setPath('/projects');
  const adminLinks = [
    { label: 'People', key: 'people', section: 'workspace' },          // admin-only
    { label: 'Screens', key: 'screens', section: 'project' },          // admin-only
    { label: 'Values', key: 'enums', section: 'project', minRole: 'manager' },
  ];
  const { shell, tree } = mountShell({ adminLinks });
  landAuth(tree, { isAdmin: false, roles: ['manager'] });
  M.flushSync?.();

  const shown = (key) => shell.el.querySelector(`[data-admin-key="${key}"]`).style.display !== 'none';
  const sectionShown = (k) => shell.el.querySelector(`[data-admin-toggle="${k}"]`).style.display !== 'none';

  assert.equal(sectionShown('workspace'), false, 'no manager-visible workspace links → Workspace hidden');
  assert.equal(sectionShown('project'), true, 'Values visible → Project shown');
  assert.equal(shown('enums'), true, 'manager sees Values');
  assert.equal(shown('screens'), false, 'admin-only project link hidden from manager');
  assert.equal(shown('people'), false, 'admin-only workspace link hidden from manager');
});

test('navigate swaps the outlet: /projects → ProjectList, /project/:id → ScreenHost', () => {
  setPath('/projects');
  const { shell, tree } = mountShell();

  // Landing: ProjectList present, no ScreenHost.
  assert.equal(shell.el.findByControl('ProjectList').length, 1, 'lands on ProjectList');
  assert.equal(shell.el.findByControl('ScreenHost').length, 0, 'no board yet');

  // Navigate to a project → outlet swaps to the board (ScreenHost) and the
  // route effect mirrors the id into scope.projectId.
  M.navigate('/project/42');
  M.flushSync?.();
  assert.equal(shell.el.findByControl('ProjectList').length, 0, 'ProjectList torn down');
  assert.equal(shell.el.findByControl('ScreenHost').length, 1, 'board (ScreenHost) mounted');
  assert.equal(tree.at(['scope', 'projectId']).peek(), 42n, 'scope mirrored from the route :id');

  // Back to the projects list.
  M.navigate('/projects');
  M.flushSync?.();
  assert.equal(shell.el.findByControl('ProjectList').length, 1, 'ProjectList re-mounted');
  assert.equal(shell.el.findByControl('ScreenHost').length, 0, 'board torn down');
});

test('/project/:id/screen/grid → ScreenHost dispatches the grid layout', () => {
  setPath('/project/42/screen/grid');
  const { shell, tree } = mountShell();

  // The deep-link landed a screen route → ScreenHost with the grid layout.
  const hosts = shell.el.findByControl('ScreenHost');
  assert.equal(hosts.length, 1, 'screen route mounted a ScreenHost');
  assert.equal(tree.at(['scope', 'projectId']).peek(), 42n, 'scope from the :id');
  // The body host carries the resolved layout (grid → Grid control).
  const body = shell.el.querySelector('.screen-host__body');
  assert.equal(body.dataset.layout, 'grid', 'slug→layout: grid');
  assert.equal(body.findByControl('Grid').length, 1, 'grid layout → Grid control');
});

test('/project/:id/screen/<unknown> → ScreenHost renders NotFound (graceful)', () => {
  setPath('/project/42/screen/hologram');
  const { shell } = mountShell();
  const body = shell.el.querySelector('.screen-host__body');
  assert.equal(body.dataset.layout, 'unknown', 'unknown slug → unknown layout');
  assert.equal(body.findByControl('NotFound').length, 1, 'unknown layout → NotFound');
});

test('/admin/:key → MasterDetail via adminConfigFor; unknown key → NotFound', () => {
  setPath('/admin/users');
  const { shell } = mountShell();
  assert.equal(shell.el.findByControl('MasterDetail').length, 1, 'admin route → MasterDetail');

  // Unknown admin key → resolver returns null → the shell spawns an
  // UnknownAdmin:* type which degrades to the NotFound placeholder.
  M.navigate('/admin/does-not-exist');
  M.flushSync?.();
  assert.equal(shell.el.findByControl('MasterDetail').length, 0, 'old admin torn down');
  assert.equal(shell.el.findByControl('NotFound').length, 1, 'unknown admin key → NotFound');
});

test('/task/:id → TaskDetail (no longer a NotFound placeholder, #33)', () => {
  setPath('/task/7');
  const { shell } = mountShell();
  // TaskDetail is now a real registered control for the task route.
  assert.equal(shell.el.findByControl('TaskDetail').length, 1, 'task route renders TaskDetail');
});

test('unknown route → a NotFound/404 outlet', () => {
  setPath('/totally/unknown');
  const { shell } = mountShell();
  assert.equal(shell.el.findByControl('NotFound').length, 1, 'unknown path → NotFound outlet');
});

test('back/forward swaps the outlet (popstate → route leaf → outlet)', () => {
  setPath('/projects');
  const { shell } = mountShell();

  M.navigate('/project/42');
  M.flushSync?.();
  assert.equal(shell.el.findByControl('ScreenHost').length, 1);

  history.back(); // → /projects
  M.flushSync?.();
  assert.equal(shell.el.findByControl('ProjectList').length, 1, 'back returned to ProjectList');

  history.forward(); // → /project/42
  M.flushSync?.();
  assert.equal(shell.el.findByControl('ScreenHost').length, 1, 'forward returned to the board');
});

/* -------------------------------------------------------------------------- */
/* ADMIN rail section: role-gated on auth.user (hidden for a non-admin).        */
/* -------------------------------------------------------------------------- */

function adminRailVisible(shell) {
  const els = shell.el.querySelectorAll('[data-admin-section]');
  assert.ok(els.length > 0, 'ADMIN section elements present in the rail DOM');
  // The effect toggles style.display; visible means none are display:none.
  return els.every((el) => el.style.display !== 'none');
}

test('ADMIN rail section is hidden for a non-admin', () => {
  setPath('/projects');
  const { shell } = mountShell({ auth: { isAdmin: false } });
  M.flushSync?.();
  assert.equal(adminRailVisible(shell), false, 'non-admin: ADMIN section hidden');
});

test('ADMIN rail section is shown for an admin', () => {
  setPath('/projects');
  const { shell } = mountShell({ auth: { isAdmin: true } });
  M.flushSync?.();
  assert.equal(adminRailVisible(shell), true, 'admin: ADMIN section shown');
});

test('ADMIN rail section is hidden before the identity resolves', () => {
  setPath('/projects');
  const { shell } = mountShell(); // no auth landed → unresolved
  M.flushSync?.();
  assert.equal(adminRailVisible(shell), false, 'unresolved identity: ADMIN section hidden');
});

test('ADMIN rail section appears once the identity lands as admin (reactive)', () => {
  setPath('/projects');
  const { shell, tree } = mountShell(); // unresolved at mount
  M.flushSync?.();
  assert.equal(adminRailVisible(shell), false, 'hidden before the probe lands');

  landAuth(tree, { isAdmin: true }); // the boot /auth/me probe resolves
  M.flushSync?.();
  assert.equal(adminRailVisible(shell), true, 'ADMIN section revealed reactively');
});

test('ADMIN disclosure (#4): collapsed by default, the heading toggles it open', () => {
  setPath('/projects');
  const { shell } = mountShell({ auth: { isAdmin: true } });
  M.flushSync?.();
  const list = shell.el.querySelectorAll('[data-admin-list]')[0];
  const toggle = shell.el.querySelectorAll('[data-admin-toggle]')[0];
  assert.ok(list && toggle, 'admin disclosure list + toggle render');
  // Default collapsed.
  assert.ok(list.classList.contains('shell__admin-list--collapsed'), 'collapsed by default');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  // Click the heading → expands.
  toggle.dispatchEvent({ type: 'click', target: toggle });
  assert.ok(!list.classList.contains('shell__admin-list--collapsed'), 'expanded after click');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  // Click again → collapses.
  toggle.dispatchEvent({ type: 'click', target: toggle });
  assert.ok(list.classList.contains('shell__admin-list--collapsed'), 'collapsed again');
});

/* -------------------------------------------------------------------------- */
/* DEFAULT PROJECT screen-nav: reactive on the route + scope.projectId.         */
/* -------------------------------------------------------------------------- */

/** The per-project rail nav (Inbox/Grid/Kanban/Project) is visible iff none of
 *  its `[data-slug]` links are display:none. */
function scopeNavVisible(shell) {
  const links = shell.el.querySelectorAll('[data-slug]');
  assert.ok(links.length > 0, 'scope nav links present in the rail');
  return links.every((el) => el.style.display !== 'none');
}

test('Task detail: project screen-nav reveals when the task publishes its project scope', () => {
  setPath('/task/5');
  const { shell, tree } = mountShell();
  M.flushSync?.();
  // Cold deep-link to a task with no prior project in scope → per-project nav hidden.
  assert.equal(scopeNavVisible(shell), false, 'hidden with no project in scope');

  // The TaskDetail publishes the task's parent project on load → nav reveals.
  tree.at(['scope', 'projectId']).set(42n);
  M.flushSync?.();
  assert.equal(scopeNavVisible(shell), true, 'project screens visible on the task detail once scoped');
});

test('Per-project screen-nav stays visible on /projects when a project is active (#9)', () => {
  setPath('/projects');
  const { shell, tree } = mountShell();
  // A project is always active (set here to stand in for the landed default);
  // the rail keeps the project screen-nav even on the all-projects landing.
  tree.at(['scope', 'projectId']).set(9n);
  M.flushSync?.();
  assert.equal(scopeNavVisible(shell), true, 'active project keeps the screen-nav visible on /projects');
});

test('Per-project screen-nav shows on a project screen route', () => {
  setPath('/project/9/screen/grid');
  const { shell } = mountShell();
  M.flushSync?.();
  assert.equal(scopeNavVisible(shell), true, 'screen route with a project in scope shows the nav');
});

/* -------------------------------------------------------------------------- */
/* Hotkey active scope follows the route body (onBodyMount) — so a screen's     */
/* scoped chords (TaskDetail `e t`, …) go live on navigation, not just clicks.  */
/* -------------------------------------------------------------------------- */

test('onBodyMount reports the route body control (TaskDetail on /task)', () => {
  setPath('/projects');
  const { shell } = mountShell();
  M.flushSync?.();
  let activeBody = null;
  shell.onBodyMount = (c) => {
    activeBody = c;
  };
  M.navigate('/task/7');
  M.flushSync?.();
  assert.ok(activeBody, 'onBodyMount fired on navigation');
  assert.equal(activeBody.type, 'TaskDetail', 'the active body is the TaskDetail (its `e _` chords go live)');
});

/* -------------------------------------------------------------------------- */
/* Header brand = the operator-set WORKSPACE TITLE (never the old 'kitp').      */
/* -------------------------------------------------------------------------- */

test('AppShell brand: defaults to "Workspace" (never "kitp") with no title configured', () => {
  setPath('/projects');
  const { shell } = mountShell();
  const brand = shell.el.querySelector('[data-brand]');
  assert.ok(brand, 'the brand element is present');
  assert.equal(brand.textContent, 'Workspace');
});

test('AppShell brand: reflects config.workspaceTitle reactively', () => {
  setPath('/projects');
  const { shell, tree } = mountShell();
  tree.at([...M.WORKSPACE_TITLE_PATH]).set('Acme HQ');
  M.flushSync?.();
  assert.equal(shell.el.querySelector('[data-brand]').textContent, 'Acme HQ');
});
