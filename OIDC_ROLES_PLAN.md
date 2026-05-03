# kitp — OIDC Auth + Roles Plan

This document is the implementation brief for two related additions on top
of v1: real OIDC authentication (replacing the dev System User) and a
proper role-based authorization model with admin UI for assignment. Both
land together because role enforcement is meaningless without identity.

Read alongside `REQUIREMENTS.md` (the original auth/role requirements
F-AUTH-* / F-ROLE-* / N-SEC-*) and `IMPLEMENTATION_PLAN.md` (Phase 20 was
the OIDC placeholder).

## 1. Goals

- **OIDC client** in the Flutter web app: Authorization Code Flow + PKCE,
  no client secret, tokens in memory only. OP is configurable.
- **OIDC server-side**: validate access tokens via JWKS, map `sub` to a
  user_account row (auto-provision on first login).
- **Dev-mode is unchanged**: `AUTH_MODE=off` still uses the System User.
  Production refuses to start without OIDC.
- **Roles** replace the dev "everyone is allowed" rule:
  - `viewer` — read-only.
  - `worker` — can act on tasks (status, comments, tags, sort_order).
  - `manager` — can also create/edit projects, milestones, components,
    and tags within a scope.
  - `admin` — can do anything, including assigning roles.
- **Per-project scope**: a user can hold a role globally OR only on a
  specific project (`scope_card_id`). The schema already supports this.
- **Role assignment paths**:
  1. **OIDC claims** — at login, a configurable claim (e.g. `groups`,
     default `kitp_role`) is mapped onto roles via a small mapping table.
  2. **In-app admin UI** — admins assign roles directly through a
     `/admin/users` screen.

## 2. Non-Goals (this delta)

- No OIDC dynamic client registration; the client_id is configured.
- No SAML, no enterprise SSO beyond OIDC.
- No fine-grained per-attribute permissions in v1.5; roles still operate
  at `(card_type, process)` granularity.
- No per-card-instance ACL (e.g. "alice can edit task #42 only"); scope
  is project-level.

## 3. Domain Recap

The existing schema already has the bones:

```
role(id, name)
role_grant(role_id, card_type_id, process_id)
user_role(user_id, role_id, scope_card_id?)   -- scope_card_id is optional
user_account(id, oidc_sub?, display_name, email?)
```

`role_grant` says "this role can run this process on this card_type".
`user_role` says "this user holds this role (optionally only within this
project subtree)".

## 4. Roles (v1 set)

Built-in roles are seeded by migration. Their grants are the whole point
of this delta.

### viewer
- No write grants.
- Reads are not currently gated by role (kept that way: the visibility
  story for v1 is "if you can reach the URL you can read it"). When this
  changes we add `select`-style processes and gate them too.

### worker
- `card.update` on `task`
- `attribute.update` on `task`
- `comment.post` on `task`
- `tag.apply` on `task`
- `tag.remove` on `task`
- `user_card_sort.set` on `task` (their personal inbox order)
- `card.move` on `task` only when both old and new parents are within
  the worker's scope (validator extension).

### manager
- Every worker grant.
- `card.insert` / `card.update` / `card.delete` on `project`,
  `milestone`, `component`, `tag`.
- `tag.apply` / `tag.remove` setup on those non-task cards.
- `card.move` for any card type within scope.

### admin
- Every manager grant.
- `user_role.set` / `user_role.revoke` (admin-only handlers, see §6).
- `role_mapping.set` / `role_mapping.delete` (managing the OIDC claim →
  role table).
- Bypasses scope: an admin grant always carries `scope_card_id IS NULL`
  (global) and never accepts a scoped form.

The `system` role stays — System User keeps every grant for dev mode.

## 5. Scoping

A `user_role` row's `scope_card_id` rules:
- `scope_card_id IS NULL` → global grant.
- `scope_card_id` set to a `project` card id → grant applies when the
  card the action targets is `project = <that id>` or a descendant.

The dispatcher's authz check resolves the **target project** for each
sub-request:
- For `card.insert` under parent X, target project = the project
  containing X (walk parent chain to the project root).
- For `attribute.update {card_id}`, target project = the project of
  `card_id`.
- For root-level `project` operations the target project is the project
  itself (only managers/admins reach this code path).

A grant matches if any of these is true:
- Grant is global (`scope_card_id IS NULL`), OR
- Grant's `scope_card_id == target_project_id`.

Scope walks are cached per request (so a 100-row attribute_update batch
issues one project lookup, not 100). Use a single SQL `SELECT id,
parent_card_id FROM card WHERE id = ANY($1)` over all referenced ids.

## 6. New Server Handlers

All handlers follow the existing array-in writer pattern.

### `user_role.set`
- Input: `[{user_id, role_name, scope_project_id?}]`.
- Authz: caller must hold `admin`.
- Effect: upsert a `user_role` row; emits an `activity` row of kind
  `role_grant` against the user_account "card" (we don't have one — see
  §11 deviations) — for v1 just log it via slog.

### `user_role.revoke`
- Input: `[{user_id, role_name, scope_project_id?}]`.
- Authz: admin.

### `user.list_with_roles`
- Input: `{}`.
- Output: `[{id, display_name, email?, oidc_sub?, roles:[{role_name, scope_project_id?, scope_project_title?}]}]`.
- Authz: any authenticated caller may list — keeps the team view useful.
  Admins use it as the basis of the assignment screen.

### `role.list`
- Input: `{}`.
- Output: `[{id, name, doc, grants:[{card_type, process}]}]`.
- Authz: open (everyone needs to know what roles exist for the picker).

### `role_mapping.list` / `role_mapping.set` / `role_mapping.delete`
- A new table `role_mapping(claim_value text PRIMARY KEY, role_id int REFERENCES role)`.
- At login, server reads the configured claim from the validated token,
  splits multi-value claims into individual values, looks up each in
  `role_mapping`, and (re)applies the resulting role grants.
- Admins manage the mapping rows via these handlers.

### Discoverability
Every new handler registers with a `Doc` so the MCP surface picks it up
unchanged.

## 7. OIDC: Server Side

### Configuration
Env vars:
- `OIDC_ISSUER` — e.g. `https://login.example.com/`.
- `OIDC_AUDIENCE` — expected `aud` claim (default = client id).
- `OIDC_ROLE_CLAIM` — claim to read for role mapping; default `groups`.
- `OIDC_DEFAULT_ROLE` — role granted when no claim mapping matches; default `worker`.
- (Optional) `OIDC_REQUIRED_CLAIMS` — comma-separated `key=value` pairs that must all be present.

`AUTH_MODE=oidc` activates this code path. The existing production guard
(`ENV=production && AUTH_MODE=off → refuse start`) stays.

### JWKS
- `internal/auth/oidc.go`: discovery via `<issuer>/.well-known/openid-configuration`,
  JWKS fetch + cache (10 min TTL, refresh on key id miss).
- Verify `iss`, `aud`, `exp`, `nbf`, signature.
- Use `github.com/golang-jwt/jwt/v5` (single dependency; widely used).

### User provisioning
On first valid token for a `sub`:
- Insert a `user_account` row with that `sub`, `display_name` from `name`
  claim (fallback `preferred_username`, then `email`, then `sub`).
- Apply role mapping: for every claim value in the token, look up
  `role_mapping`; insert any missing `user_role` row. If no mapping
  matches, grant `OIDC_DEFAULT_ROLE`.
- Cache `(sub → user_account.id, role set)` in-memory for 5 minutes; the
  whole record is reloaded if the token's claims hash changes.

### Authorization in the dispatcher
The dispatcher already has `Authz` and `ProcessName`/`CardTypeID` hooks.
The new behavior:
- Resolve the caller's effective grants: `(card_type, process, scope_project_id?)` triples.
- For each sub-request, compute the target project id (§5).
- Allow if any of the caller's grants matches `(card_type, process)` AND
  scope rule.
- On deny, fail the offending sub-request with `code=unauthorized` and
  `aborted` for the rest (existing batch failure semantics).

## 8. OIDC: Client Side

### Configuration
Build-time `--dart-define`:
- `KITP_OIDC_ISSUER`
- `KITP_OIDC_CLIENT_ID`
- `KITP_OIDC_REDIRECT_URI` — defaults to the app's own origin + `/auth/callback`.
- `KITP_OIDC_SCOPES` — default `openid profile email`.

If `KITP_OIDC_ISSUER` is empty at runtime, the client behaves exactly as
today: no login UI, dispatcher hits `/api/v1/batch` without auth headers.
This keeps `make web-build` (no OIDC) and `make web-build-oidc` cleanly
separated.

### Flow
- `lib/auth/oidc_client.dart` — PKCE: generate code_verifier (256-bit
  random base64url) and S256 code_challenge. Store verifier in
  `sessionStorage` (so a same-tab redirect can recover it).
- Login redirect: `window.location.assign(authorize_url)`.
- Callback at `/auth/callback?code=...&state=...`:
  1. Validate `state`.
  2. POST to token endpoint with code + verifier.
  3. Store `id_token`, `access_token`, `refresh_token`, expiry, parsed
     claims **in memory only** (a Provider/InheritedWidget).
  4. Schedule a refresh ~30s before expiry; on rotation failure go back
     to login.
- Dispatcher attaches `Authorization: Bearer <access_token>` to every
  batch POST. On 401, force a refresh; on second 401, log the user out
  and redirect to login.

### UI
- `LoginScreen`: "Sign in with <issuer-host>" button. After successful
  callback, navigate to `/projects`.
- `Logout` link in the top nav (when signed in). Logs out client-side
  only (no end-session call to the OP in v1).
- Show signed-in user's name in the top nav.

## 9. Admin UI

New route `/admin/users` (gated: only visible if caller has `admin`).

- Top: a search field over user_account.display_name / email.
- Table columns: ID, Name, Email, OIDC sub (truncated), Current roles
  (chips, one per role+scope tuple).
- Per-row "Manage" affordance opens a side panel with:
  - Add role → role picker + scope picker (project search).
  - Remove existing role-scope tuple.
- Each gesture (add or remove) issues ONE batch with `user_role.set` or
  `user_role.revoke` and refreshes via `user.list_with_roles`.

Optional second tab `/admin/role-mapping`:
- Table of `(claim_value → role_name)` rows.
- Add/edit/delete rows via `role_mapping.*` handlers.

The Projects nav button should NOT show the admin link unless the
caller's roles include `admin`.

## 10. Migrations

`db/migrations/00NN_oidc_roles.sql` (next available number — current
ordering ends at the migration the wishlist agent added; check before
naming):

1. Add `email text` and ensure `oidc_sub text UNIQUE` exist on
   `user_account` (the column already exists; double-check).
2. Seed roles: `viewer`, `worker`, `manager`, `admin` (with `doc`
   strings).
3. Seed `role_grant` rows mapping each role to its allowed
   `(card_type, process)` pairs per §4.
4. Create `role_mapping(claim_value text PRIMARY KEY, role_id int NOT NULL REFERENCES role)`.
5. Optional dev seed: a `role_mapping` row mapping the dev OP's "admin"
   group to `admin`, "manager" to `manager`, etc., to make local dex
   testing painless.

Tests: bump expected counts in `internal/store/migrate_test.go`.

## 11. Test Plan

### Server (Go)
- `internal/auth/oidc_test.go`:
  - JWKS fetch from a tiny test http server; verify-good token; reject
    bad iss / wrong aud / expired / future / bad sig / no kid match.
  - Auto-provisioning: first-call creates user_account + user_role rows;
    second call with the same sub re-uses them (no duplicates).
  - Role-claim mapping: token with `groups=["kitp.admin", "kitp.worker"]`
    leads to two `user_role` rows for that user.
- `internal/dom/userrole/userrole_test.go`:
  - admin can grant + revoke; non-admin gets `unauthorized`.
- `internal/api/authz_test.go`:
  - viewer cannot run any write — every write returns `unauthorized`.
  - worker can update tasks but not insert projects.
  - manager-scoped-to-project-1 can update tasks under project-1 but not
    project-2.
  - admin (global) can do everything.
  - Batch with mixed allowed + denied sub-requests aborts the whole tx.

### Client (Flutter widget tests)
- `client/test/oidc_client_test.dart`: PKCE generates valid verifier +
  S256 challenge; token storage; refresh on 401.
- `client/test/admin_users_screen_test.dart`: list users, add a role
  (single batch), remove a role (single batch), gated visibility.
- Negative test: a non-admin loading `/admin/users` is redirected to
  `/projects`.

### E2E (Chrome)
Add a second journey to `e2e/bin/e2e.dart` (or a new `e2e_oidc.dart`):
- Boot a local OIDC OP (`dexidp/dex` in docker-compose, configured with
  static users alice/bob/admin and groups). Auto-start as part of `make e2e-oidc`.
- Open the app, click "Sign in", complete the dex flow (dex's headless
  HTML form), land back on the app.
- As `admin`: open `/admin/users`, grant `bob` the `manager` role
  scoped to "Default Project", screenshot.
- Sign out; sign in as `bob`. Confirm `bob` can edit project attributes
  on Default Project but not on a second project (create a second
  project as admin first to make this verifiable).
- Sign out; sign in as `alice` (worker). Confirm alice can update tasks
  but the New Project FAB is hidden.
- Capture: `e2e-oidc-01-login.png`, `e2e-oidc-02-admin-users.png`,
  `e2e-oidc-03-grant.png`, `e2e-oidc-04-bob-project.png`,
  `e2e-oidc-05-alice-no-fab.png`.

### Screenshots (regular)
- `docs/screenshots/20/login.png`
- `docs/screenshots/20/admin-users-list.png`
- `docs/screenshots/20/admin-grant-role.png`
- `docs/screenshots/20/role-mapping.png`
- `docs/screenshots/20/signed-in-nav.png`

## 12. Phasing (sequential)

Even though this is one task, the implementing agent should proceed in
this order so each step lands green:

1. **Migration + role seed + role helpers** (Go-only). Tests: every
   existing role behaves correctly; System User keeps every grant.
2. **Authz pass at the dispatcher**: implement scope resolution + grant
   matching. Tests: §11 server matrix.
3. **Admin handlers**: `user.list_with_roles`, `role.list`,
   `user_role.set`, `user_role.revoke`. Tests.
4. **OIDC server middleware**: token validation, JWKS, provisioning.
   Tests against a local httptest JWKS.
5. **Role mapping table + handlers**: `role_mapping.set`, `.delete`,
   `.list`. Tests.
6. **Client OIDC**: PKCE flow, callback route, token state, dispatcher
   header injection. Tests.
7. **Admin UI**: `/admin/users` + `/admin/role-mapping`. Tests + plain
   screenshots.
8. **dex compose service** + E2E run.
9. **Traceability + README**: tick F-AUTH-* / N-SEC-* on the matrix and
   document the dev/prod auth switch in README.

## 13. Configuration & Production Hardening

- `make run` keeps `AUTH_MODE=off` for dev.
- New target `make run-oidc` boots dex (compose) and kitpd with
  `AUTH_MODE=oidc OIDC_ISSUER=http://localhost:5556/dex` etc., and
  webbuilds with the matching `--dart-define`s.
- `make e2e` stays auth-off (existing journey).
- `make e2e-oidc` is the new authenticated journey.
- Production refusal stays: `ENV=production && AUTH_MODE=off` exits
  non-zero. Add a sibling: `ENV=production && AUTH_MODE=oidc &&
  OIDC_ISSUER=""` exits non-zero with a clear message.

## 14. Risks & Open Questions

- **Token in memory vs sessionStorage.** Spec says memory only. Reality:
  a page refresh kills the session. Fine for v1; users re-login. If
  this is too noisy in dev, we can opt into sessionStorage behind a
  `--dart-define=KITP_OIDC_PERSIST=session` switch.
- **End-session URL.** Some OPs expose `end_session_endpoint`;
  if available we redirect there on logout. Optional in v1.
- **Refresh token rotation failure recovery.** On rotation failure mid-
  session, we currently log the user out and force re-login. Shouldn't
  silently retry forever.
- **Scoped grants vs nested cards.** Scope walks resolve the project a
  card belongs to. Cards parented under non-project cards (sub-tasks)
  walk through `parent_card_id` to the project root. Cycle protection:
  cap walk depth at 16.
- **Large role sets.** Token claims can be many. Default scopes ask for
  `openid profile email`; the role claim is added explicitly. Document
  the OP-side configuration in the README.

## 15. Acceptance

The OIDC + roles delta is done when:
- All §11 tests are green.
- `make e2e-oidc` walks the full role-aware journey end-to-end against
  dex and produces the screenshots above.
- Production refusal works for all forbidden config combinations.
- README documents the auth switch and the role layout.
- The traceability matrix moves F-AUTH-1/2/3/5 and N-SEC-1/2 from
  "deferred" to "covered".
