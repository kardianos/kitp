# B7 — Reads across project boundaries: `activity.select`, `card.select*`, `card.search`, `comm.list_for_task`

- **Severity:** MEDIUM
- **Status:** ✅ RESOLVED 2026-05-21
- **Agent:** backend

## Resolution

New helper `schema.VisibilityClause(cardIDExpr, userArg)` returns an
EXISTS-shaped SQL fragment. AND-joined into the WHERE of every
read that emits card-derived rows. The predicate evaluates true
when the caller (or, when the caller is an agent, their
`parent_user_id`) holds a `user_role` row that is either
globally scoped (`scope_card_id IS NULL`) or scoped to the
project the card chains up to via `parent_card_id`.

No new process row, no new `role_grant` rows — the existing
`user_role.scope_card_id` IS the access predicate.

**Sites wired:**

- `card.select` (card.go) — direct `$N` injection.
- `card.select_with_attributes` (select_attrs.go) — injected via
  the existing `addArg` closure.
- `card.search` (search.go) — pre-LIMIT predicate so a worker
  can't see other projects' matches even if their query matches.
- `activity.select` (activity.go) — predicate on `a.card_id`,
  closes the cross-card mode the audit specifically flagged.
- `comm.list_for_task` (comm.go) — predicate on `c.id` (comm),
  which walks comm→task→project naturally.

**Test coverage:** `internal/dom/card/visibility_test.go` pins:

- worker scoped to project A sees A's tasks but not B's;
- admin (`scope_card_id IS NULL`) sees both;
- stranger (no user_role row) sees nothing — strict default;
- `card.search` filters pre-LIMIT.

**Agent fall-through:** Agents (`is_agent=true`,
`parent_user_id` set) inherit their parent's visibility — matches
the rest of the codebase (`usercardagent`, `session/http.go`).
Pinned by the existing `TestRoutedToMe_*` suite that exercises
agent reads against their parent's projects.

**System User:** seed.hcsv gives user 1 a `(role=system, scope=NULL)`
row, so dev-mode (AUTH_MODE=off) is unaffected.

## What

All registered with `AllowedRoles: [$authenticated]` and no
per-row scope check. Any authenticated user can read any card, its
activity, its comments inlined in activity, and its comm threads,
by id alone.

`activity.select` even supports a "cross-card mode" that returns
activity across every card the user technically has visibility into
— which here is "all of them".
- **Location:**
  - `server/internal/dom/activity/activity.go:48-58`
  - `server/internal/dom/card/card.go:111-125`
  - `server/internal/dom/card/search.go`
  - `server/internal/dom/comm/comm.go:263-271`

## What

All registered with `AllowedRoles: [$authenticated]` and no
per-row scope check. Any authenticated user can read any card, its
activity, its comments inlined in activity, and its comm threads,
by id alone.

`activity.select` even supports a "cross-card mode" that returns
activity across every card the user technically has visibility into
— which here is "all of them".

## Why it matters

If the deployment intent is "every authenticated user can read
everything," this is by design; if there's a notion of
project-private data (as suggested by scoped grants), this is a
confidentiality regression. The shape of `user_role.scope_card_id`
says the latter.

## Suggested fix

Decide whether the v1 read model is global-read or
project-scoped-read.

If scoped, add a `card.read` process + `CardTypeID` extractors to
the four read handlers and let `runAuthzPass` enforce it. This
pairs naturally with the option-A fix from B6 — once
`CardTypeID + ProcessName` is required for non-`$authenticated`
handlers, you'd promote these four to that tier.

## Decision needed

Before doing implementation: confirm the intended read model.
Adding the gate makes existing API consumers fail for cards they
were previously allowed to read.
