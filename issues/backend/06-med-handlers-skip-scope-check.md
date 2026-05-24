# B6 — Write handlers without `CardTypeID`/`ProcessName` get NO per-row scope check

- **Severity:** MEDIUM
- **Status:** ✅ RESOLVED 2026-05-21
- **Agent:** backend

## Resolution

**Kernel (Option A — fail at register time).** `reg.Register` now
panics when a handler lists `worker` or `manager` in
`AllowedRoles` but lacks `CardTypeID` + `ProcessName`. New opt-out
field `Handler.GlobalScope` marks handlers that legitimately
operate on rows with no project anchor (CAS chunks, persons
before attach, file rows before attach, top-level project
creation). The panic surfaces at process start so any future
worker/manager handler ships with scope wired or an explicit
opt-out.

The check exempts `admin` because the seed grants admin every
`(card_type, process)` tuple globally — admin is conventionally
unscoped. `$public`, `$authenticated`, and `system` tokens are
also exempt by design.

**Handler fixes.** Wired `CardTypeID` + `ProcessName=card.update`
on the eight audit-listed handlers:

- `comm.set_recipients` (recipients.go) — walks comm → parent task
  and uses the parent task's card_type (workers hold task-level
  grants, not comm-level).
- `reply.post` (comm.go) — same parent-task walk.
- `tag.apply`, `tag.remove` (tag.go) — `target_card_id` →
  card_type.
- `attachment.create` (attachment.go) — `card_id` → card_type.
- `attachment.delete` (attachment.go) — walks attachment → card →
  card_type.
- `attachment.list` was already `$authenticated`; left untouched.
- `file.create` (file.go) — `GlobalScope: true` (file rows are
  contentless until a downstream domain attaches them; that link
  IS scope-checked).

Also wired the four `project.import.*` handlers (manager-tier)
through a `cardTypeFromJobID` helper that walks import_job →
project, and marked `cas.missing_chunks`, `person.upsert_by_email`,
`project.stamp` as `GlobalScope: true` with explanatory comments.

Test fixtures in `proc_test.go` and `role_gate_test.go` updated
with `GlobalScope: true` so synthetic handlers exercising the
role-name gate alone don't trip the new register-time guard.

## What

These handlers register `AllowedRoles: [worker, manager, admin]`
but do NOT set `CardTypeID` or `ProcessName`. In
`api.authorizeLeaf` (`authz.go:233-235`) the guard
`if h.ProcessName == "" || h.CardTypeID == nil { return nil }`
short-circuits — the actor's `user_role.scope_card_id` is never
compared to the target project.

A worker whose only `user_role` is `(worker, scope=project A)` can
call `comm.set_recipients` on a comm in project B because
`LoadUserRoles` in `role_gate.go` strips scope and returns the
bare role name `"worker"` globally.

## Why it matters

The whole scope-aware authz machinery exists for exactly this
case; these handlers silently opt out.
- **Location:**
  - `server/internal/dom/comm/recipients.go:88-98` — `comm.set_recipients`
  - `server/internal/dom/comm/comm.go:272-280` — `reply.post`
  - `server/internal/dom/tag/tag.go` — `tag.apply`, `tag.remove`
  - `server/internal/dom/attachment/attachment.go` — `attachment.create`, `attachment.delete`, `attachment.list`
  - `server/internal/dom/file/file.go` — `file.create`

## What

These handlers register `AllowedRoles: [worker, manager, admin]`
but do NOT set `CardTypeID` or `ProcessName`. In
`api.authorizeLeaf` (`authz.go:233-235`) the guard
`if h.ProcessName == "" || h.CardTypeID == nil { return nil }`
short-circuits — the actor's `user_role.scope_card_id` is never
compared to the target project.

A worker whose only `user_role` is `(worker, scope=project A)` can
call `comm.set_recipients` on a comm in project B because
`LoadUserRoles` in `role_gate.go` strips scope and returns the
bare role name `"worker"` globally.

## Why it matters

The whole scope-aware authz machinery exists for exactly this
case; these handlers silently opt out.

## Suggested fix

Three options, ranked by reviewer effort vs. structural robustness:

**Option A (recommended — fail at register time).** Make
`reg.Register` panic when a handler's `AllowedRoles` includes a
non-`$authenticated` / non-`$public` role but `CardTypeID` is nil
or `ProcessName` is empty. Catches the entire class of bugs at
startup. Matches the project's "fail fast" disposition (cf. the
resolver-nil panic in `router.go`).

**Option B (light-touch — extend the extractor).** Extend
`cardIDFromInput` to recognize the natural alias names (`comm_id`,
`task_id`, `attachment_id`, `tag_card_id`, etc.) and resolve them
through a small mapping table or convention. Doesn't enforce
discipline going forward but covers existing handlers.

**Option C (hand-roll).** Add `Authz:` hook to each handler that
walks to the target's project and checks against a scoped grant.
Most code; least likely to drift.

Option A is the right architectural answer; B is the pragmatic
follow-up to retrofit existing handlers without per-handler edits.
