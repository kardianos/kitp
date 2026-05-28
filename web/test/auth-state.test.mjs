/**
 * Auth-state service — the boot /api/v1/auth/me probe that lands `auth.user`.
 *
 * Covers:
 *   - a 200 + authenticated body lands the decoded identity at `auth.user`
 *     (ids revived to bigint, roles/flags carried);
 *   - a 200 with authenticated:false → onUnauthorized fires (the SSO bounce),
 *     and the leaf stays at the unresolved default;
 *   - a 401/403 → onUnauthorized fires (the SSO bounce coincides with the
 *     batch-funnel 401 path);
 *   - the reactive helpers (authIsAdmin / authCurrentUserId) read the leaf.
 *
 * The probe is injected as a synchronous stub so no promise/fetch is needed.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestBundles } from './build-for-test.mjs';
import { installDomShim } from './dom-shim.mjs';

let M;

before(async () => {
  // The app bundle imports the markdown sink (DOMPurify) which touches
  // window/document at import; install the light shim before importing it.
  installDomShim();
  const outdir = await buildTestBundles();
  M = await import(`${outdir}/app.js`);
});

/** A synchronous MeProbe stub delivering a canned (status, body). */
function stubProbe(status, body) {
  return {
    probe(onResult, _onError) {
      onResult(status, body);
    },
  };
}

function newTree() {
  return new M.TreeNode({}, []);
}

test('loadAuthUser: 200 + authenticated lands the decoded identity at auth.user', () => {
  const tree = newTree();
  M.loadAuthUser(tree, {
    probe: stubProbe(200, {
      authenticated: true,
      user_id: '42',
      display_name: 'Ada Admin',
      roles: ['admin', 'manager'],
      is_admin: true,
      is_agent: false,
    }),
  });

  const u = tree.at([...M.AUTH_USER_PATH]).peek();
  assert.equal(u.userId, 42n, 'user_id revived to bigint');
  assert.equal(u.displayName, 'Ada Admin');
  assert.deepEqual(u.roles, ['admin', 'manager']);
  assert.equal(u.isAdmin, true);
  assert.equal(u.isAgent, false);
  assert.equal(u.parentUserId, null);

  // Helpers read the same leaf.
  assert.equal(M.authPeekIsAdmin(tree), true);
  assert.equal(M.authPeekCurrentUserId(tree), 42n);
});

test('loadAuthUser: an agent carries parent_user_id + is_agent', () => {
  const tree = newTree();
  M.loadAuthUser(tree, {
    probe: stubProbe(200, {
      authenticated: true,
      user_id: '90',
      display_name: 'Scout',
      roles: ['worker'],
      is_agent: true,
      parent_user_id: '42',
    }),
  });
  const u = tree.at([...M.AUTH_USER_PATH]).peek();
  assert.equal(u.userId, 90n);
  assert.equal(u.isAgent, true);
  assert.equal(u.parentUserId, 42n);
  assert.equal(u.isAdmin, false);
});

test('loadAuthUser: a 200 authenticated:false fires onUnauthorized (SSO bounce); leaf stays unresolved', () => {
  const tree = newTree();
  let bounced = 0;
  M.loadAuthUser(tree, {
    probe: stubProbe(200, { authenticated: false }),
    onUnauthorized: () => {
      bounced++;
    },
  });
  assert.equal(bounced, 1, 'onUnauthorized fired for an unauthenticated probe');
  const u = tree.at([...M.AUTH_USER_PATH]).peek();
  assert.equal(u.userId, null, 'leaf left at the unresolved default');
  assert.equal(u.isAdmin, false);
});

test('loadAuthUser: a 401 fires onUnauthorized (coincides with the batch 401 bounce)', () => {
  const tree = newTree();
  let bounced = 0;
  M.loadAuthUser(tree, {
    probe: stubProbe(401, null),
    onUnauthorized: () => {
      bounced++;
    },
  });
  assert.equal(bounced, 1, '401 → onUnauthorized');
  assert.equal(tree.at([...M.AUTH_USER_PATH]).peek().userId, null);
});

test('loadAuthUser: a network error leaves auth.user unresolved (no bounce here)', () => {
  const tree = newTree();
  let bounced = 0;
  const errProbe = {
    probe(_onResult, onError) {
      onError('boom');
    },
  };
  M.loadAuthUser(tree, { probe: errProbe, onUnauthorized: () => bounced++ });
  assert.equal(bounced, 0, 'network error does not bounce (the batch funnel does)');
  assert.equal(tree.at([...M.AUTH_USER_PATH]).peek().userId, null);
});

test('authUserFromWire: tolerates a missing / partial body', () => {
  const empty = M.authUserFromWire({});
  assert.equal(empty.userId, null);
  assert.deepEqual(empty.roles, []);
  assert.equal(empty.isAdmin, false);
  assert.equal(empty.personCardId, null, 'no person link → null');
  const partial = M.authUserFromWire({ user_id: '7', is_admin: true });
  assert.equal(partial.userId, 7n);
  assert.equal(partial.isAdmin, true);
});

test('authUserFromWire: person_card_id revives to a bigint distinct from user_id', () => {
  const tree = newTree();
  M.loadAuthUser(tree, {
    probe: stubProbe(200, {
      authenticated: true,
      user_id: '42',
      display_name: 'Ada',
      person_card_id: '108', // distinct id space from user_id
    }),
  });
  const u = tree.at([...M.AUTH_USER_PATH]).peek();
  assert.equal(u.personCardId, 108n, 'person card id revived to bigint');
  assert.equal(u.userId, 42n, 'user id stays separate');
  // The helpers read the same leaf.
  assert.equal(M.authPeekCurrentPersonId(tree), 108n);
  assert.equal(M.authPeekCurrentUserId(tree), 42n);
});
