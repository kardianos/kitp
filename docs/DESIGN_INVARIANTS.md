# kitp — Design Invariants

Companion to [`REQUIREMENTS.md`](../REQUIREMENTS.md) §4.6 (Security) and
§4.2 (Server Execution). Where REQUIREMENTS.md says what v1 must *do*,
this file records security/robustness/correctness rules the code must
keep *upholding* — each discovered and fixed during the 2026-05
security & robustness audit, then distilled here to the durable
invariant.

Each entry states the rule, why it exists, where it's enforced, and the
regression test that pins it. Source comments and `CLAUDE.md` cite these
by id (e.g. `DI-6`). The `Originally:` line preserves the audit issue id
for anyone tracing git history; the issue tracker those ids came from has
since been removed.

If you change code that an invariant names, the invariant is the
contract — keep honoring it, or update this file in the same change with
a reason.

---

## DI-1 — Idempotency cache partitions by authenticated user, batch-only

**Rule.** The `Idempotency-Key` replay cache keys on the *resolved*
authenticated user and is consulted only after auth has stamped the
request context — never on a System-User fallback. It applies solely to
`POST /api/v1/batch`, not to every POST under `/api/`. One request per
(user, key) runs at a time: the request claims the key
(`idempotency_claim`) before running and drops the claim when done, and a
retry that arrives meanwhile gets 409 `idempotency_in_progress` rather
than running the mutation a second time.

**Why.** If the cache sits outside the auth resolver it keys every
request as the System User (id 1). Alice's stored response then replays
to Bob when he reuses the same key+body — a cross-user response
disclosure.

**Enforced in.** `(*IdempotencyStore).WrapAuthed` takes the resolved
`*auth.UserCtx` directly; wired via `srv.MountBatch(rt, idem.WrapAuthed)`
in `cmd/kitpd/main.go`. The legacy outer `Middleware` is retained only
for older test fixtures.

**Tested by.** `TestIdempotency_WrapAuthed_PartitionsByUser` in
`internal/obs/idempotency_test.go` — Bob must not see Alice's cached body;
Alice still gets her own replay. `TestIdempotency_ConcurrentRetriesRunOnce`
(`internal/obs/idempotency_claim_test.go`) — a retry during the first run
is refused, a retry after it replays, the mutation runs once.

**Originally:** B1 (CRITICAL) + B8, resolved 2026-05-21. The one-run
claim: review B11, 2026-11-02.

---

## DI-2 — Admin bootstrap happens once, in one statement

**Rule.** The workspace gets its first admin automatically (the OIDC
first-sign-in path) at most once. "Once" is the `admin_bootstrap` row, not
"nobody holds admin right now": the row is written the first time an admin
is granted (init-admin bootstrap, the first sign-in) or seen (any sign-in
that finds an admin, migration 0029 on existing installs) and never
removed. The grant is one statement — insert the row `ON CONFLICT DO
NOTHING`, grant admin only if that insert happened — so concurrent first
sign-ins serialize on the row's primary key and at most one wins. A
sign-in that just lost an IdP-granted admin role only records the row.
`KITP_INIT_ADMIN_EMAIL` (an operator action at startup) still restores an
admin when there is none.

**Why.** A check-then-insert lets two concurrent first-time sign-ins both
observe "no admin yet" and both self-elevate: two users' `user_role` rows
never conflict, so the old `INSERT … WHERE NOT EXISTS` let both through.
And a rule of "no admin right now" re-arms: when the only admin's IdP group
is removed, the next sign-in (even theirs, in the same transaction) became
admin again. Review 2026-11-03 #13.

**Enforced in.** `auth/oidc/oidc.go` (`grantAdminIfInitMode`) and
`auth/init_admin.go` (`BootstrapInitAdmin` records the row).

**Tested by.** `TestBootstrapAdminOnce` (`auth/oidc/oidc_test.go`).

**Originally:** B2 (HIGH), resolved 2026-05-21; reworked 2026-11-03.

---

## DI-3 — Attachment byte routes enforce per-row project authz

**Rule.** `GET /api/v1/attachment/{id}/download|view|thumb` resolve the
attachment's project and verify the caller's scoped grant *before any
byte is written*. Unresolvable id → `api.NotFound` (don't leak
existence); resolvable but ungranted → `api.ErrForbidden`.

**Why.** Attachment ids are sequential bigints. A valid session alone let
any user — including a worker scoped to a different project — enumerate
and pull every blob in the CAS store across all projects.

**Enforced in.** `requireAttachmentAccess(ctx, pool, userID, attachmentID)`
in `dom/attachment/http.go`, called from each of the three handlers; one
SQL round-trip using the same grant join as `projectexport.isAuthorized`
(`card.update` on the project card_type).

The same rule decides every other way to a file's bytes by id
(`file_readable_by`): `attachment.create` (attaching a file to your card
makes it yours to download) and the CSV import's reads. Seeing a card is not
enough — a viewer may not copy its files (review 2026-11-03 round 2 #10).
Stored bytes are named in `file.create` only by an account that sent them or
may read a file holding them (`cas_held_by`, `cas_blob_holder`), and
`cas.missing_chunks` reports other bytes as missing, so knowing a hash isn't
having the file (round 2 #21).

**Tested by.** `TestRequireAttachmentAccess` in
`dom/attachment/internal_test.go` — stranger → 403, system → ok, bogus id
→ 404. `TestViewerCantCopyFiles`, `TestBytesAreNotClaimedByHash`,
`TestCasMissingChunksHidesOthersBytes`.

**Originally:** B3 (HIGH), resolved 2026-05-21.

---

## DI-4 — OIDC email fallback requires `email_verified`

**Rule.** When an OIDC `sub` doesn't match an existing `user_account`, the
"attach this sub to a pre-created row with the same email" fallback fires
only when the token's `email_verified` claim is true — unless
`KITP_OIDC_TRUST_UNVERIFIED_EMAIL=1` (`Config.TrustUnverifiedEmail`) is
explicitly set. Default is fail-closed; an unverified email falls through
to a fresh-insert path and gets its own account. The attach matches only
the login's own `user_account.email`, which only admins set (person.create
tier=user, person.grant_account, the init-admin bootstrap) — never a person
card's `email` attribute, which any worker can edit — and never the System
user or an agent (review 2026-11-03 #1). `person.grant_account` takes the
email from the admin's request and never copies the card's. Reusing an
existing login-less person for a new sign-in matches the card's email only
when kitp itself wrote it (System, or no activity row: seed, bundles) or a
workspace admin did; a worker's edit leaves the sign-in its own person
(round 2 #5). A login an admin took away (`user.revoke_login`) keeps its
sub and email and is marked `login_revoked_at`: a sign-in by that sub, or
with a verified email equal to it, is refused (`ErrLoginRevoked`), instead
of starting over with the default role and the old person card, until
`person.grant_account` / `person.create` tier=user lift it for that email
(`login_unrevoke`; round 3 #3). `OIDC_DEFAULT_ROLE` set empty or `none`
grants nothing (round 3 #4).

**Why.** This is the published bootstrap attack for email-matching OIDC
apps: an OP that lets users assert an arbitrary unverified email lets an
attacker who knows the bootstrap admin's address pre-empt them. Combined
with DI-2 the attacker becomes admin.

**Enforced in.** `auth/oidc/oidc.go` (`provisionUser`), env-var documented
in `cmd/kitpd/main.go`'s header block.

**Tested by.** OIDC package suite.

**Originally:** B4 (HIGH), resolved 2026-05-21.

---

## DI-5 — Scoped write handlers must declare an anchor or opt out (register-time panic)

**Rule.** A `reg.Handler` whose `AllowedRoles` include `worker` or
`manager` MUST set `CardTypeID` + `ProcessName`, OR set
`GlobalScope: true` with a comment explaining why no project anchor
exists. `reg.Register` panics at startup otherwise. `admin`,
`$public`, `$authenticated`, and `system` are exempt by design (admin is
granted every `(card_type, process)` globally).

**Why.** Without a `(CardTypeID, ProcessName)` anchor, `authorizeLeaf`
short-circuits and the actor's `user_role.scope_card_id` is never
compared to the target project — a worker scoped to project A could call
e.g. `comm.set_recipients` on a comm in project B. Failing at register
time catches the whole class before it ships.

**Enforced in.** `internal/reg/reg.go` (`Register`); opt-out field
`Handler.GlobalScope`. Anchored handlers include `comm.set_recipients`,
`reply.post`, `tag.apply`/`tag.remove`, `attachment.create`/`delete`,
the `project.import.*` set; `GlobalScope` handlers include `file.create`,
`cas.missing_chunks`, `person.upsert_by_email`, `project.stamp`.

**Tested by.** `proc_test.go` and `role_gate_test.go` (fixtures carry
`GlobalScope: true` so the register-time guard is exercised, not tripped).

**Originally:** B6 (MEDIUM), resolved 2026-05-21 (Option A — fail at
register time).

---

## DI-6 — Card-derived reads AND-join the visibility predicate

**Rule.** Every handler that returns card-derived rows (cards, activity,
comments, comms, attachments) AND-joins
`schema.VisibilityClause(cardIDExpr, userSlot)` into its WHERE. The
predicate is true when the caller — or, for a personal agent, their
`parent_user_id` (a workspace agent, owned by System, uses its own rows:
review 2026-11-03 round 3 #2) — holds a `user_role` that is globally scoped
(`scope_card_id IS NULL`) or scoped to the project the card chains up to.
A stranger with no `user_role` row sees nothing (strict default). For
`card.search` the predicate goes *before* LIMIT. A card in an **area that
is switched off** (`card_in_off_area`, docs/AREAS.md) is invisible to
everyone, global roles included: the predicate ANDs `NOT
card_in_off_area(card)`, in `VisibilityClause`, `card_visible_to` and
every inline copy. (Added with areas: an area may hold data that must
disappear entirely, such as health information.)

**Why.** The handlers were `$authenticated` with no per-row check, so any
authenticated user could read any card, its activity, inlined comments,
and comm threads by id alone — a confidentiality regression given the
project-scoped grant model. No new process/grant rows are needed:
`user_role.scope_card_id` *is* the access predicate.

**Enforced in.** `internal/schema/visibility.go` (`VisibilityClause`),
joined into `card.select`, `card.select_with_attributes`, `card.search`,
`activity.select`, `comm.list_for_task`. Agents inherit their parent's
visibility; the System User's `(system, scope=NULL)` seed row keeps
`AUTH_MODE=off` unaffected.

**Tested by.** `internal/dom/card/visibility_test.go` — worker sees only
their project, admin sees all, stranger sees none, search filters
pre-LIMIT; agent fall-through pinned by the `TestRoutedToMe_*` suite.

**Originally:** B7 (MEDIUM), resolved 2026-05-21.

---

## DI-7 — Email lookups compare `lower(email)`

**Rule.** Account lookups by email (init-mode bootstrap and the OIDC
fallback) use `WHERE lower(email) = $1`, with the input already
lower/NFC-normalized via `textnorm.Email`.

**Why.** Application-layer normalization alone trusts every insert site.
A row inserted unnormalized through another path (import, manual SQL, an
old migration) would miss an `email = $1` match and the bootstrap would
fail-open by inserting a duplicate admin candidate. SQL-side `lower(...)`
covers historic rows; these lookups are once-per-boot / once-per-sign-in,
not hot-path, so no functional index is needed.

**Enforced in.** `auth/init_admin.go` and `auth/oidc/oidc.go`.

**Originally:** B10 (LOW), resolved 2026-05-21.

---

## DI-8 — Session cookie is `SameSite=Lax` (required by the OIDC return navigation)

**Rule.** The `kitp_session` cookie is `SameSite=Lax`. It MUST NOT be
`Strict`: the OIDC callback sets the cookie and then 302s the browser to
the post-login landing path, and that landing request is still part of a
top-level navigation chain *initiated by the identity provider* (a
cross-site origin). Strict withholds the cookie on such a request, so the
SPA gate reads no session and redirects back to the SSO start endpoint;
the IdP re-authenticates via its own session and the user is stuck in a
silent redirect **loop**.

**Why the create-not-read framing was wrong.** The original rationale —
"Strict is safe because the callback only CREATES a cookie, never reads a
pre-existing one" — accounted for the `/callback` request but not the
*next hop*. After `/callback` sets the cookie and redirects to `/`, the
SPA document gate (`spaAuthed`) READS the cookie on that `/` request,
which is still IdP-initiated and cross-site under Strict. Hence the loop
(intermittent in the field: a manual reload / address-bar navigation is
same-site and DOES carry a Strict cookie, so users sometimes escaped it).

**CSRF posture.** Lax still withholds the cookie on cross-site subresource
loads and cross-site POSTs, so the mutating `POST /api/v1/batch` surface
keeps its cross-site-POST CSRF protection. Same-origin requests (the SPA
calling its own API) carry the cookie regardless of SameSite, so nothing
in-app changes. The only thing Lax newly permits — the cookie on a
top-level cross-site GET — is exactly the post-login return, and KITP has
no state-changing GET endpoints.

**Enforced in.** `http.SameSiteLaxMode` in `Set` / `Clear` in
`auth/session/cookie.go`.

**Originally:** B11 (LOW), 2026-05-21 (docs-only, chose Strict);
**corrected 2026-06-01** to Lax after an Entra sign-in redirect loop —
the Strict choice was a latent bug, not a safe default.

---

## DI-9 — Unknown handler-error codes map to HTTP 500, never 400

**Rule.** `regHandlerErrorStatus` maps the known `*reg.HandlerError`
codes to their statuses and defaults *unknown* codes (including
`internal`) to 500 — not 400.

**Why.** A future direct HTTP route that bubbles a bare
`&reg.HandlerError{Code:"internal", Message: dbErr.Error()}` would
otherwise render as `400` + raw SQL, breaking the redaction discipline
the router enforces for `api.Internal`. A safe default keeps an
unrecognized code from leaking as a client error with a raw message.

**Enforced in.** `internal/api/router.go` (`regHandlerErrorStatus`) —
explicit `case "internal": 500` plus a 500 default arm.

**Originally:** B12 (LOW), resolved 2026-05-21.

---

## DI-10 — Three-layer query timeout model; pgx owns ctx cancellation

**Rule.** Query timeouts are set top-down in three layers:

1. **Pool-wide** (`buildPgxPool`): `statement_timeout=600s` (hard cap),
   `lock_timeout=5s`, `idle_in_transaction_session_timeout=60s`.
2. **Per-handler** (`reg.Handler.Timeout`): default 6s
   (`api.DefaultHandlerTimeout`); the dispatcher wraps the handler call in
   `context.WithTimeout`. Heavy handlers override (the `project.import.*`
   set and `project.stamp` use 60s). `0` means default.
3. **Per-job** (`job.Job.Timeout`): default `min(Interval, 600s)`,
   applied per scheduler tick.

Passing the derived `ctx` to pgx is the *entire* cancellation
mechanism — no application-level cancel connection is built.

**Why.** A pathological filter or a recursive CTE on a large graph can
pin a backend connection well past the HTTP client's disappearance. The
handler-level timeout enforces the SLO; the pool-level cap is the last
line of defense; the job-level timeout covers background workers.

pgx v5 sends the Postgres wire-protocol `CancelRequest` on a side TCP
connection (using the backend PID + secret from the startup handshake)
when a ctx passed to `Query`/`Exec`/`QueryRow` is cancelled — the server
aborts with SQLSTATE `57014`. Demonstrated: `internal/store/cancel_test.go`
fires `pg_sleep(10)` under a 100ms deadline and returns in <1s. Under
extreme load the side-channel `connect()` can lag, so the deadline is a
soft floor and the 600s pool cap is the absolute bound. If the driver is
ever swapped (e.g. lib/pq), revisit — its ctx-cancellation behavior
differs.

**Enforced in.** `buildPgxPool` in `cmd/kitpd/main.go`;
`reg.Handler.Timeout` + the dispatcher; `job.Job.Timeout`.

**Tested by.** `internal/store/cancel_test.go`
(`TestQueryRespectsContextCancellation`,
`TestQueryRespectsParentCancellation`).

**Originally:** S1 (MEDIUM) + the pgx-cancellation report, resolved
2026-05-22.
