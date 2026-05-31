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
`POST /api/v1/batch`, not to every POST under `/api/`.

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
Alice still gets her own replay.

**Originally:** B1 (CRITICAL) + B8, resolved 2026-05-21.

---

## DI-2 — Admin bootstrap is a single atomic statement, never check-then-insert

**Rule.** Granting the first admin (init-mode, and the OIDC first-sign-in
path) is one `INSERT … SELECT … WHERE NOT EXISTS … ON CONFLICT DO NOTHING`
statement, evaluated under a single MVCC snapshot — no separate
"does an admin exist yet?" read followed by an insert.

**Why.** A check-then-insert on the bare pool lets two concurrent
first-time sign-ins both observe "no admin yet" and both self-elevate:
silent, permanent privilege escalation. Postgres serializes the inserts
on the unique constraint so at most one wins.

**Enforced in.** `auth/oidc/oidc.go` (`grantAdminIfInitMode`), matching the
tx+recheck shape already in `auth/init_admin.go` (`BootstrapInitAdmin`).

**Tested by.** OIDC package suite (`auth/oidc/oidc_test.go`).

**Originally:** B2 (HIGH), resolved 2026-05-21.

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

**Tested by.** `TestRequireAttachmentAccess` in
`dom/attachment/internal_test.go` — stranger → 403, system → ok, bogus id
→ 404.

**Originally:** B3 (HIGH), resolved 2026-05-21.

---

## DI-4 — OIDC email fallback requires `email_verified`

**Rule.** When an OIDC `sub` doesn't match an existing `user_account`, the
"attach this sub to a pre-created row with the same email" fallback fires
only when the token's `email_verified` claim is true — unless
`KITP_OIDC_TRUST_UNVERIFIED_EMAIL=1` (`Config.TrustUnverifiedEmail`) is
explicitly set. Default is fail-closed; an unverified email falls through
to a fresh-insert path and gets its own account.

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
predicate is true when the caller — or, for an agent, their
`parent_user_id` — holds a `user_role` that is globally scoped
(`scope_card_id IS NULL`) or scoped to the project the card chains up to.
A stranger with no `user_role` row sees nothing (strict default). For
`card.search` the predicate goes *before* LIMIT.

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

## DI-8 — Session cookie `SameSite=Strict` is intentional; revisit only for redirect-read flows

**Rule.** The `kitp_session` cookie is `SameSite=Strict`. This is correct
*because the OIDC callback only ever creates a fresh cookie and never
reads a pre-existing one*. If a future feature needs to READ the session
inside an OP-initiated top-level callback (e.g. "link a second provider"
on an already-signed-in user), Strict will silently drop the cookie —
switch that endpoint's read to `Lax` (or relax the default) at that
point.

**Why.** Strict blocks cookies on top-level cross-site navigations; the
OIDC dance is exactly such a navigation. It happens to be safe today only
because of the create-not-read property — a foot-gun worth documenting so
a future change doesn't get a silent auth failure.

**Enforced in.** A comment block above `Set` in
`auth/session/cookie.go` (this was a docs-only fix — no behavioral
change).

**Originally:** B11 (LOW), resolved 2026-05-21 (docs-only).

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
