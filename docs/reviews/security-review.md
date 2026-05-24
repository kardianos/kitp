# kitp Security Review

**Scope:** Full defensive security review of the kitp codebase (Go backend in `server/`,
PL/pgSQL handlers in `db/schema/functions/*.sql`, Svelte 5 SPA in `client/`).
**Posture:** Authorized review at owner request. Attacker mindset; every finding cites
`file:line` with an exploit scenario and remediation.
**Date:** 2026-05-24

---

## Executive Summary

kitp is, on the whole, a **carefully built and security-conscious** codebase. The areas
that are usually the worst offenders here are unusually strong:

- **SQL injection:** The single dynamic-SQL surface (`card_select_with_attributes_batch`
  + `card_compile_predicate`) routes **every user-controlled value through a JSONB
  `$1` params bag** bound via `EXECUTE … USING`, and validates every identifier that
  *could* be interpolated (attribute names, order fields) against `^[A-Za-z0-9_]+$`.
  I traced every interpolation path and found **no injectable path**. The
  `internal/named` builder's scanner is also correct. Verdict: **no SQL injection.**
- **AuthN:** BFF model is textbook — opaque 256-bit session/token ids, server-side
  state, PKCE S256, opaque OIDC state with DELETE-on-read + expiry, RSA-only JWT
  signature verification with `none`/HS rejection, issuer+audience+exp validation,
  HttpOnly+Secure+SameSite=Strict cookies, production refusal of `AUTH_MODE=off`.
- **XSS:** Exactly one `{@html}` sink in the whole SPA, fed by a hardened
  marked+DOMPurify pipeline (explicit allowlists, `javascript:`/`data:` blocked,
  `noopener`). Strict CSP (`default-src 'none'`, no `unsafe-inline`).
- **Authz:** Per-row read visibility and per-row write scope checks are consistently
  applied; `user_role.set` correctly enforces admin-or-parent-of-agent in an `Authz`
  hook despite a permissive `AllowedRoles`.

The findings below are real but mostly **Medium/Low** — defense-in-depth gaps and a
genuine DoS class rather than a direct compromise. The most serious is a
**denial-of-service via uncapped recursive CTEs combined with a missing cycle guard in
`card.move`**, which is High because it's remotely triggerable by any user with a
`card.move` grant and ties up DB connections for the full 600s statement timeout.

| # | Risk | Finding | One-line |
|---|------|---------|----------|
| 1 | **High** | Uncapped recursive CTEs + no cycle guard on `card.move` | Create a parent cycle, then any read spins to the 600s timeout — pool exhaustion DoS |
| 2 | **Medium** | Raw Postgres error messages leak to the wire | `mapPGError` / handler errors ship `pgErr.Message` + `err.Error()` in `ErrorEnvelope.Message`, violating the CLAUDE.md ban |
| 3 | **Medium** | First-OIDC-sign-in self-elevates to admin (init mode) | When `KITP_INIT_ADMIN_EMAIL` is unset, the first user to complete OIDC becomes global admin |
| 4 | **Medium** | Admin-controlled SSRF via SMTP/IMAP/MS Graph host | Channel/sink config dials arbitrary attacker-chosen hosts/ports from the server |
| 5 | **Low** | `auth.Middleware` `X-Dev-User-Id` impersonation is latent footgun | Dead code today, but trivially full-impersonation if ever re-wired |
| 6 | **Low** | Idempotency lookup fails **open** on DB error | A transient error makes a replay attempt re-execute the mutation |
| 7 | **Low** | `authzAdmin` fails **open** when pool is nil | Test-only today; a refactor that drops the pool silently disables the admin gate |
| 8 | **Low** | Dev default comm-secret key | Unset `KITP_COMM_SECRET_KEY` encrypts real credentials under a published key |
| 9 | **Info** | No `Access-Control-Allow-Credentials`, SameSite=Strict | CSRF posture is good; documented for completeness |
| 10 | **Info** | OIDC `email_verified` fallback correctly gated | Confirmed defended; documented as a near-miss |

---

## SQL Injection Analysis (dedicated section)

**Verdict: No SQL injection found.** The dynamic-SQL surface is small and disciplined.

### The only `EXECUTE` of a built string
`db/schema/functions/card_select_with_attributes_batch.sql:349`:
```sql
EXECUTE _final_sql INTO _result_rows USING _params, actor_id;
```
`_final_sql` is assembled from string fragments, but **every user value is referenced
positionally** as `($1->>N)` / `($1->N)::jsonb`, where `$1` is the JSONB `_params`
accumulator bound via `USING`. `$2` is the trusted `actor_id`. No user value is ever
concatenated as a literal.

### Every interpolation path examined

1. **Predicate values** (`card_compile_predicate.sql`): eq/ne/in/not-in/exists/
   contains/within_days/has_phase/parent_status_phase/snippet/before_today. Each appends
   the value to `params` and emits `($1->>idx)` / `($1->idx)::jsonb`. The index `idx` is
   an integer computed from `jsonb_array_length(params)` — **integer, not user text**.
   ✔ safe.
2. **Attribute names** (`attr`): validated `_attr !~ '^[A-Za-z0-9_]+$' → RAISE`
   (`card_compile_predicate.sql:143`) AND additionally passed as a *bound value*
   (`ad.name = ($1->>idx)`), never interpolated as an identifier. Belt and suspenders.
   ✔ safe.
3. **`contains` ILIKE needle** (`:307-321`): wrapped as `'%' || _needle || '%'` and
   appended to `params`, referenced as `($1->>idx)`. ✔ safe.
4. **`within_days` N** (`:267-293`): parsed to `int`, range-checked `[0,3650]`, appended
   to params and cast `::int`. ✔ safe.
5. **`has_phase` / `parent_status_phase` phase strings** (`:324-399`): validated against
   the literal set `('triage','active','terminal')` before being appended as bound
   values. ✔ safe.
6. **`snippet` id** (`:401-455`): parsed to `bigint`, cycle-checked, fetched from the DB;
   the *fetched predicate JSON* is recursively compiled (same bound-value discipline).
   ✔ safe.
7. **`card_type_name` filter** (`card_select_with_attributes_batch.sql:134-139`): appended
   to params, referenced `ct.name = ($1->>idx)`. ✔ safe (bound, not interpolated).
8. **`parent_card_id`** (`:128-133`): appended to params, `($1->>idx)::bigint`. ✔ safe.
9. **ORDER BY field** (`:182-279`): only three literal field names accepted; the
   `attributes.<name>` branch validates `_order_attr !~ '^[A-Za-z0-9_]+$' → RAISE`
   (`:206`) AND binds the name as `($1->>idx)`. The alias `ord_%s` uses `_i` (a loop
   integer). Direction is coerced to the literal set `('ASC','DESC')` (`:189-191`).
   `attribute_def` ids interpolated into joins (`_sort_order_def_id::text`,
   `_title_def_id::text`) are **server-resolved bigints**, not user input. ✔ safe.
10. **LIMIT / OFFSET** (`:291-304`): parsed to `int`, appended to params,
    `($1->>idx)::int`. ✔ safe.
11. **`runSQLFunc` function name** (`internal/api/sqlfunc.go:76`): `quoteIdent(h.SQLFunc)`
    — `SQLFunc` is a compile-time constant from `reg.Register`, never user input. ✔ safe.
12. **`internal/named` scanner** (`named.go`): correctly skips `'literals'`,
    `"idents"`, `--`/`/* */` comments and the `::` cast operator before recognizing
    `:name` slots; unbound names error at compile time. No way to smuggle a `:name` from
    a *value* (values aren't part of the SQL template). ✔ safe.

### Go-built SQL
The only Go file building SQL with `fmt`/concat outside `named`/`VisibilityClause` is
`internal/schema/hcsv/seed.go` (schema seeding, not request-time, not user input). Every
request-time query uses parameterized `$N` or the `named` builder. ✔ safe.

---

## Auth / Authz Model Assessment

**AuthN — strong.**
- Session/token ids are 32 random bytes (`crypto/rand`) base64url-encoded — 256 bits of
  entropy (`session/manager.go:245`, `token/token.go:240`). Looked up by **indexed PK
  equality**, so the lack of constant-time comparison is not exploitable (no
  string-prefix timing oracle on an indexed lookup).
- Session gates: revoked / absolute-cap / idle-TTL all enforced
  (`session/manager.go:174-187`). Logout revokes server-side AND clears the cookie.
- OIDC: PKCE S256 (`bff.go:124,326`), opaque 24-byte state DELETE-on-read with
  `expires_at > now()` (`bff.go:167-179`), RSA-only key function rejecting `none`/HS
  (`oidc.go:231`), issuer+audience+exp validation (`oidc.go:241-251`). The OP-supplied
  redirect is **never used** — callback hardcodes `http.Redirect(w, r, "/", …)`
  (`bff.go:219`), so no open redirect.
- Cookie flags: HttpOnly + SameSite=Strict + Secure (unless explicit dev opt-out)
  (`session/cookie.go:39-49`).
- `AUTH_MODE=off` refuses to start when `ENV=production` (`main.go:229`, `auth.go:70`).

**Authz — consistently applied, with the gaps noted below.**
- Per-row READ visibility (`schema.VisibilityClause` + the inlined CTE in each read
  function) walks `parent_card_id` to the enclosing project and checks the caller's (or
  agent-parent's) scoped/global role. Agents correctly inherit parent scope.
- Per-row WRITE scope (`api/authz.go`) resolves the target project by walking parents
  (capped at `scopeWalkDepth=16`) and matches `(card_type, process, scope)`.
- The role gate (`role_gate.go`) requires login + a matching role before the scope pass.
- `user_role.set/revoke` and `agent.*`/`user_token.*` declare `RoleAuthenticated` but
  enforce the real gate in an `Authz` hook (`userrole.go:169-216`) — admin-or-parent-of-
  agent, with `rejectAgentActor` blocking agent self-bootstrap. **Correctly defended.**

**Fail-open paths to be aware of** (findings 6, 7 below): the authz hook fails open on a
nil pool, and idempotency fails open on a DB error.

---

## Findings (risk-ranked)

### 1. High — DoS via uncapped recursive CTEs + missing cycle guard on `card.move`

**Class:** Denial of Service (resource exhaustion).

**Where:**
- Missing cycle guard: `db/schema/functions/card_move_batch.sql:97-98` (UPDATE sets
  `parent_card_id` with no descendant check). Same for
  `db/schema/functions/task_move_batch.sql`.
- Uncapped recursive arms (no `WHERE depth < 16`):
  - `db/schema/functions/card_search_batch.sql:143-149`
  - `db/schema/functions/card_select_batch.sql:69-75`
  - `db/schema/functions/activity_select_batch.sql:89-95`
  - `db/schema/functions/comm_list_for_task_batch.sql:185+`
  - `server/internal/schema/visibility.go:40-46` (the shared Go `VisibilityClause` —
    used by every Go-side read that exposes card rows)
- For contrast, `card_select_with_attributes_batch.sql:116` **does** carry
  `WHERE up.depth < 16`, proving the rule exists and was simply not applied uniformly.
  Tracked in `issues/sql/09-low-recursive-cte-no-cap.md` (under-rated as Low there).

**Exploit scenario:** `card_move` validates only parent *card-type* compatibility — it
never checks that the new parent isn't a descendant of the moved card. For any card_type
with `allow_self_parent=true` (self-nesting types exist in the model), a user holding a
`card.move` grant can:
1. `card.move {card_id: A, new_parent_card_id: B}`
2. `card.move {card_id: B, new_parent_card_id: A}`

This creates a `parent_card_id` cycle A→B→A. Every subsequent read that walks parents
through one of the uncapped CTEs (search, list, activity feed, comm list, and the shared
`VisibilityClause`) now recurses without bound. Postgres only stops it at the pool-wide
`statement_timeout=600000` (10 minutes, `main.go:192`). An attacker can fire a handful of
cheap reads to pin every pool connection for 10 minutes each — full API outage.

Even **without** the move bug, any uncapped `WITH RECURSIVE … UNION ALL` over a
self-referential table is a latent footgun the moment a cycle appears by any means
(buggy import, restore, future handler).

**Impact:** Remote, low-privilege (a single `card.move` grant), full-service DoS.

**Remediation (both layers):**
1. Add `WHERE depth < 16` (matching `scopeWalkDepth`) to **every** recursive arm above,
   including the Go `VisibilityClause` builder — make this the single rule per CLAUDE.md.
   Use `UNION` (dedup) or a `CYCLE` clause as additional defense.
2. In `card_move_batch` / `task_move_batch`, reject a move whose `new_parent_card_id` is
   the card itself or a descendant of it (a bounded `WITH RECURSIVE … WHERE depth < 16`
   descendant check, or an ancestor check on the new parent).

---

### 2. Medium — Raw Postgres error messages leak to the wire

**Class:** Information disclosure (violates the CLAUDE.md "never put `err.Error()` on the
wire" rule).

**Where:**
- `server/internal/api/sqlfunc.go:168-180` — `mapPGError` puts `pgErr.Message` directly
  into `reg.HandlerError.Message` for SQLSTATE `P0001`, `23505`, `23503`, `40P01`,
  `57014`.
- `server/internal/api/api.go:437` (`flush`), `:599-633` (`runAuthzPass`),
  `role_gate.go:72-76` — these copy `err.Error()` / `he.Message` into
  `ErrorEnvelope.Message`, which is serialized to the client verbatim.
- `server/internal/api/authz.go:224,233,241,260` — `validation`/`internal` HandlerErrors
  built with `err.Error()`.

**Exploit scenario:** A constraint violation (23505) or a `RAISE EXCEPTION` (P0001) inside
a PL/pgSQL handler returns the raw Postgres message — which routinely contains table
names, column names, constraint names, and sometimes row values (`Key (email)=(…) already
exists`). A user can probe these to map the schema and enumerate values (e.g. confirm an
email is already registered). Unlike the redacted 500 path
(`router.go:251-253` → `"internal error"`), the batch `ErrorEnvelope` path has no
redaction.

**Impact:** Schema/constraint disclosure and value enumeration to any authenticated user.
Not a direct compromise, but it meaningfully aids an attacker and breaks the project's own
stated invariant.

**Remediation:** In `mapPGError` and the dispatcher's abort paths, map known SQLSTATEs to
**stable, generic** codes/messages (e.g. `conflict` → "a conflicting record already
exists") and log the raw `pgErr.Message`/`err` server-side only. Reserve
`P0001`/`RAISE` text for messages the handler *intentionally* authored as user-facing
(those handlers already return structured `{idx, ok, code, message}` rows with curated
text — the leak is specifically the *pgx-layer* errors that escape the function body).

---

### 3. Medium — First OIDC sign-in self-elevates to global admin (init mode)

**Class:** Privilege escalation / insecure default.

**Where:** `server/internal/auth/oidc/oidc.go:644` → `grantAdminIfInitMode`
(`oidc.go:665-683`), invoked inside `provisionUser` for **every** first-sight sub.

**Exploit scenario:** When `KITP_INIT_ADMIN_EMAIL` is not set at startup, the bootstrap
admin is never pre-created. `grantAdminIfInitMode` grants global `admin` to a user iff no
non-System user currently holds `admin`. The race itself is correctly closed (single
`INSERT … WHERE NOT EXISTS`, one MVCC snapshot — `issues/backend/02-high-init-admin-race-
oidc.md`). The residual risk is the **policy**: on a fresh install with a self-service /
public OP (or any OP an attacker can obtain an account on), **the first person to reach
`/api/v1/auth/oidc/callback` becomes global admin** — not necessarily the operator.

**Impact:** Full admin takeover of a freshly deployed instance if an attacker wins the
race to first sign-in. Window is "install → intended admin's first login".

**Remediation:** Require an explicit bootstrap signal in production: refuse to auto-grant
admin unless `KITP_INIT_ADMIN_EMAIL` (or an equivalent allowlist) is set, and only grant
to a sub whose verified email matches it. Document that leaving init-mode open on a
public OP is unsafe. At minimum, log a loud warning at startup when init-mode is armed.

---

### 4. Medium — Admin-controlled SSRF via SMTP / IMAP / MS Graph host

**Class:** Server-Side Request Forgery (authenticated, admin-only).

**Where:**
- SMTP: `server/internal/dom/comm/smtp.go:633-639` — `sendSMTP` dials
  `net.JoinHostPort(host, port)` for any admin-configured `smtp_host`/`smtp_port`.
- IMAP: `server/internal/dom/comm/imap.go` (same pattern for `imap_host`).
- MS Graph sink: `server/internal/dom/activitysink/pumper.go` (HTTP to MS Graph using
  admin-configured tenant/host).
- Config write path: `comm_channel_set_batch.sql` / `activity_sink_set_batch.sql` store
  these as plain card attributes with no host allowlist.

**Exploit scenario:** An admin (or anyone who has reached admin via finding 3) sets a
channel's `smtp_host`/`imap_host` to an internal address (`169.254.169.254`,
`localhost:6379`, an internal admin panel, etc.). The server's backend worker connects
from inside the trust boundary. STARTTLS/auth banners and connection success/failure are
observable via `comm_log` and `delivery_status`, giving a blind-to-semi-blind SSRF
oracle.

**Impact:** Internal network reconnaissance / pivoting from the server's vantage point.
Mitigated by being admin-gated, but admin is a configuration role, not necessarily a
network-trusted one (and finding 3 can grant it).

**Remediation:** Optional egress allowlist (env-configured permitted mail/Graph hosts or
CIDR denylist for RFC1918 + link-local + loopback) enforced at channel/sink *set* time
and again before dial. At minimum, document the SSRF surface so operators run kitpd with
constrained egress.

---

### 5. Low — `auth.Middleware` `X-Dev-User-Id` impersonation header (latent)

**Class:** Authentication bypass (latent / not currently wired).

**Where:** `server/internal/auth/auth.go:177-190`. The middleware honors
`X-Dev-User-Id: <n>` and runs the batch as that arbitrary user id.

**Status:** **Not exploitable today** — confirmed `auth.Middleware` is not referenced in
`server/cmd/kitpd/main.go`; the production path uses `newSessionResolver` /
`newBearerResolver` via the typed `apiRouter`. The header has no production reader.

**Exploit scenario (if regressed):** Any future re-introduction of `auth.Middleware` into
the chain would let an unauthenticated client impersonate **any** user (including
admin=some-id) with a single header. The in-code "env != production" guard described in
the doc comment is **not actually implemented** in the function body — it trusts the
header unconditionally whenever the middleware is installed.

**Remediation:** Either delete `auth.Middleware` (dead code) or gate the impersonation
branch on an explicit `ENV != "production"` check inside the function so a future re-wire
can't ship the bypass to prod.

---

### 6. Low — Idempotency lookup fails open on DB error

**Class:** Replay / double-execution under failure.

**Where:** `server/internal/obs/idempotency.go:111-114` (and the legacy `:188-191`):
on a `lookup` DB error the code sets `found = false` ("fail-open") and proceeds to
**re-run the mutation**.

**Exploit scenario:** A client retries a non-idempotent batch (e.g. "create payment-like
record") with the same `Idempotency-Key`. If the lookup query errors transiently
(timeout, connection blip), the cache is bypassed and the side-effectful handler runs
again — defeating the exactly-once guarantee the header promises.

**Impact:** Duplicate side effects under partial failure. Low because it requires a DB
error to coincide with a retry, but it inverts the safety property the feature exists to
provide.

**Remediation:** Fail **closed** on lookup error for non-idempotent writes — return a
500/503 and let the client retry, rather than silently re-executing. (Replaying a cached
response on store-error is fine; bypassing the cache on lookup-error is the risky half.)

---

### 7. Low — `authzAdmin` and `authzSet` fail open when pool is nil

**Class:** Authorization bypass (test-only today; refactor hazard).

**Where:** `server/internal/dom/userrole/userrole.go:137-139` (`authzAdmin`: nil pool →
`return nil`), `:176-177` (`authzSet`), `:201-203` (`authzRevoke`), `:115-117`
(`authzList`). Comment: "tests that bypass Register may not bind a pool; fail open".

**Status:** Not exploitable in production (`Register` always binds the real pool).

**Exploit scenario (if regressed):** Any refactor that constructs these handlers without
`Register` binding `authzPool`, or that nils the package-global, **silently disables the
admin gate** on the most sensitive handlers in the system (role grants). The use of an
untyped package-global `authzPool any` makes this easy to get wrong.

**Remediation:** Fail closed (deny) when the pool is nil in production; inject a test
double in tests rather than relying on a fail-open branch. Strongly type `authzPool` as
`*store.Pool`.

---

### 8. Low — Dev default comm-secret encryption key

**Class:** Weak secret-at-rest.

**Where:** `server/internal/store/store.go:91-102` — unset `KITP_COMM_SECRET_KEY` falls
back to the literal `"dev-do-not-ship-this-key-in-prod"` (logged once as a warning).

**Exploit scenario:** An operator who deploys without setting the env var stores real
IMAP/SMTP/MS-Graph credentials (`comm_secret`, `activity_sink_secret`) encrypted under a
**published constant**. Anyone with a DB dump (backup leak, replica access) can decrypt
all channel credentials with the key from this source file.

**Impact:** Credential disclosure given DB access. Low because it requires both the
misconfiguration and DB access; the one-shot warning helps.

**Remediation:** In `ENV=production`, **refuse to start** when `KITP_COMM_SECRET_KEY` is
unset (mirror the `AUTH_MODE=off` production refusal), rather than falling back to the
published default.

---

### 9. Informational — CORS / CSRF posture

`server/internal/api/cors.go:65-71` sets `Access-Control-Allow-Origin: *` but **no**
`Access-Control-Allow-Credentials`, and the session cookie is `SameSite=Strict`
(`session/cookie.go:45`). The combination means cross-origin JS cannot read responses
*with* the cookie, and the browser won't attach the cookie to cross-site requests — so
the wildcard CORS does not create a CSRF or credential-theft hole. CORS defaults off in
production (`cors.go:46`). **No action required**; documented because a wildcard CORS plus
a credentialed cookie *would* be a hole, so any future addition of
`Allow-Credentials: true` must be rejected.

---

### 10. Informational — OIDC `email_verified` fallback (confirmed defended)

`oidc.go:475-507` gates the "attach this OIDC sub to a pre-created-by-email account"
fallback on `email_verified == true` unless `KITP_OIDC_TRUST_UNVERIFIED_EMAIL=1`, and only
matches rows with `oidc_sub IS NULL`. This correctly blocks the documented
bootstrap-by-email takeover (`issues/backend/04-high-oidc-email-fallback-unverified.md`).
**No action required.** Note the interaction with finding 3: the email-fallback path is
defended, but the *init-mode auto-admin* path (finding 3) is a separate escalation that
does not depend on email at all.

---

## What was checked and found clean

- **SQL injection** across `card_compile_predicate`, `card_select_with_attributes_batch`,
  `card_search_batch`, `internal/named`, and all Go request-time queries (see dedicated
  section). No injectable path.
- **XSS:** single `{@html}` sink → hardened marked+DOMPurify (`client/src/util/
  markdown.ts`); strict CSP (`api/csp.go`); filename header-injection blocked
  (`attachment/http.go:267`, `comm/smtp.go:536`).
- **Attachment IDOR:** `requireAttachmentAccess` (`attachment/http.go:207-262`) enforces
  scoped `card.update` and fails closed (404) on broken chains. No id-enumeration leak.
- **Session fixation:** sessions are freshly minted at login with a new random id; no
  client-supplied id is honored.
- **Token/secret exposure:** bearer values never returned by `token.List`
  (`token/token.go:166-199`); comm secrets live in separate tables, not in
  `attribute_value`, so they don't surface through card reads.
- **Open redirect:** OIDC callback hardcodes redirect to `/` (`bff.go:219`).
- **Agent privilege:** `LoadUserRoles` intersects agent grants with the live parent set
  (`auth.go:115-159`), so a stale agent grant can't outlive the parent's role.
