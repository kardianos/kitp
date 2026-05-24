# Fix Plan — verification contract for the review findings

Date: 2026-05-24
Source reports: `backend-design-review.md`, `security-review.md`, `frontend-design-review.md`

This file is written **before** any fix touches disk. It is the contract we
verify against afterward: every item lists where the problem is, what "fixed"
means (Definition of Done), and how to verify it. Each fix agent must report
per-item status (`DONE` / `PARTIAL` / `DEFERRED` / `SKIPPED`) against these IDs
and must **not commit** — the diff stays staged for human review against this
list.

Convention reminders that apply to every fix (from `CLAUDE.md`):
- Named params via `internal/named` whenever a query/inputs/surrounding code is
  touched. Schema changes go in the **declarative** `db/schema/*.hcsv`
  (migrations dir is gone).
- `errors.Is`/`errors.As`, never raw `err.Error()` on the wire.
- Recursive card-tree walks carry `WHERE depth < 16`.

---

## Scope decisions (read first)

- **EXCLUDED — SEC-3 (first-OIDC-sign-in self-elevates to admin):** owner says
  "fine for now as is." Do **not** change `grantAdminIfInitMode`. (Listed only
  so verification doesn't flag its absence.)
- **NO-ACTION — SEC-9, SEC-10:** informational / confirmed-clean. No change.
- **DEFERRED — FE-H4 (carve up 2000-line screens):** the Svelte client is being
  superseded by the new `client-next/` frontend (gradual migration). Do the
  cascade/correctness fixes that protect the *currently-shipping* client, but do
  **not** undertake the large component-extraction refactor on code we are
  migrating away from. Note it as deferred.
- **DEFERRED (design) — BE-H2 full relocation:** moving the predicate compiler
  back to Go-with-`named` or to fixed parameterized plans is a deliberate
  redesign, not a bugfix. This pass does the **safe increment** (kill the
  hand-counted offset class + add a diff test); full relocation is a follow-up.

---

# Part A — Backend + Security (Go / SQL) — `agent A`

### A1 — Recursive-CTE DoS: depth caps + `card.move` cycle guard  `[Critical]`
Sources: BE-C1, SEC-1.
- **Where (missing `WHERE depth < 16`):**
  `card_select_batch.sql:69`, `card_search_batch.sql:143`,
  `activity_select_batch.sql:89`, `comm_list_for_task_batch.sql:185`,
  `tag_apply_batch.sql:164,178`, `attribute_update_batch.sql:225,267,358`,
  `comm_create_batch.sql:184,205`, `card_insert_batch.sql:282,372`,
  `task_move_batch.sql:305` (uncapped though `UNION`-dedup'd), and the Go helper
  `server/internal/schema/visibility.go:38` (no depth column at all).
- **Where (no cycle guard):** `card_move_batch.sql:79-98`; same gap in
  `task_move_batch.sql`.
- **Definition of Done:**
  1. Every recursive arm above carries `WHERE depth < 16` (and a `depth`
     column where absent, incl. `schema.VisibilityClause`).
  2. `card_move_batch` and `task_move_batch` reject a move whose
     `new_parent_card_id` equals the card or is a descendant of it (bounded
     descendant/ancestor walk), with a stable code (`cycle` / `edge_violation`).
  3. **Strategic:** add one shared capped walk so the rule stops being
     hand-applied — a SQL helper (e.g. `card_ancestors(start bigint)` with the
     cap baked in) used by the call sites above where practical, and a CI grep
     (`scripts/`) that fails when a function matches `RECURSIVE` + `parent_card_id`
     without `depth < 16`.
- **Verify:** grep shows `depth < 16` on all listed arms; a test that creates
  A→B then attempts B→A (or self-parent) is rejected with the new code; the CI
  grep script exists and passes; `visibility.go` emits the depth cap.

### A2 — Scoped authz silently fails closed for non-`card_id` handlers  `[High]`
Source: BE-H3.
- **Where:** `server/internal/api/authz_input.go:19-52` (`cardIDFromInput` only
  matches `card_id`/`target_card_id`); consumed at `authz.go:209-213,254`.
  Affected gated handlers: `comm/recipients.go:33` (`comm_id`),
  `comm/comm.go:49,87` (`project_id`/`id`), `comment/comment.go:67`
  (`activity_id`).
- **Definition of Done:** scope resolution is explicit per handler — add an
  optional `ScopeCardID func(in any) int64` (or equivalent) to `reg.Handler`
  and have the affected gated handlers return the card their `CardTypeID`
  resolver already locates; OR broaden `cardIDFromInput` to the real field set.
  Either way add a **startup assertion** that every gated handler exposes a
  resolvable card id (panic if not) so `reg.Register`'s guarantee is actually
  checked, not implied.
- **Verify:** a project-scoped (non-global) manager can invoke
  `comm.set_recipients` / `comm_channel.set` / `comment.edit` on a card in their
  project; startup panics if a gated handler can't resolve a card id (add a test
  proving the assertion fires).

### A3 — Idempotency caches failed batches as success  `[High]`
Source: BE-H4.
- **Where:** `server/internal/obs/idempotency.go:148-152` caches any 200 body;
  `api.go:192,298` always returns 200; abort paths `api.go:642-661`.
- **Definition of Done:** only cache when the batch actually succeeded — teach
  the idempotency layer to inspect the envelope and skip caching when any
  sub-response carries an error/`aborted` code (preferred; keeps the "200 with
  per-leaf errors" wire contract), or set non-200 on full abort.
- **Verify:** a batch where a sub-request errors (or the whole batch aborts) is
  **not** cached; a retry with the same Idempotency-Key re-executes. Add a test.

### A4 — Idempotency fails *open* on lookup DB error  `[Low/sec]`
Source: SEC-6.
- **Where:** `idempotency.go:111-114` (and legacy `:188-191`) set `found=false`
  on lookup error → re-runs the mutation.
- **Definition of Done:** fail **closed** on lookup error for non-idempotent
  writes (return 500/503; let the client retry). Replaying a cached response on
  *store* error stays fine — only the lookup-error bypass changes.
- **Verify:** injected lookup error returns 5xx, does not execute the handler.

### A5 — Raw Postgres / wrapped error text leaks to the wire  `[Medium]`
Sources: BE-M1, BE-M2, SEC-2.
- **Where:** `sqlfunc.go:167-180` (`mapPGError` ships `pgErr.Message` for
  `P0001/23505/23503/40P01/57014`); dispatcher copies `err.Error()`/`he.Message`
  into `ErrorEnvelope.Message` at `api.go:437,599-633`, `role_gate.go:72-76`,
  `authz.go:224,233,241,260`; bare `err.(*reg.HandlerError)` assertions at
  `api.go:428,621,674,685`, `role_gate.go:69`.
- **Definition of Done:**
  1. `mapPGError` maps each SQLSTATE → a **stable client code + generic
     message**; raw `pgErr.Message`/`Detail` logged server-side only.
     `P0001`/`RAISE` author-controlled text may surface only as an explicit
     opt-in, not the default.
  2. All five assertion sites use `errors.As`; wrapped 500-class errors map to a
     generic `internal` code + redacted "internal error" message (match the
     router's `*HTTPError` redaction).
- **Verify:** trigger a unique-violation and a wrapped scan error; the client
  envelope contains a generic code/message with **no** table/column/constraint
  names or wrapped chain; server log retains the detail.

### A6 — `authzAdmin`/`authzSet`/`authzRevoke`/`authzList` fail *open* on nil pool  `[Low/sec]`
Source: SEC-7.
- **Where:** `server/internal/dom/userrole/userrole.go:115-117,137-139,176-177,201-203`.
- **Definition of Done:** deny (fail closed) when the pool is nil in production;
  strongly type the global as `*store.Pool` instead of `any`; tests inject a
  double rather than relying on a fail-open branch.
- **Verify:** nil-pool path denies; type is concrete; existing userrole tests
  still pass with an injected pool.

### A7 — Dev default comm-secret key in production  `[Low/sec]`
Source: SEC-8.
- **Where:** `server/internal/store/store.go:91-102` (falls back to
  `"dev-do-not-ship-this-key-in-prod"`).
- **Definition of Done:** when `ENV=production`, **refuse to start** if
  `KITP_COMM_SECRET_KEY` is unset (mirror the `AUTH_MODE=off` prod refusal). Dev
  fallback + one-shot warning stays for non-prod.
- **Verify:** prod startup without the env var exits non-zero with a clear
  message; dev still boots with the warning.

### A8 — `X-Dev-User-Id` impersonation header (latent)  `[Low/sec]`
Source: SEC-5.
- **Where:** `server/internal/auth/auth.go:177-190` (honors header
  unconditionally; not currently wired into prod router).
- **Definition of Done:** delete `auth.Middleware` if dead, OR gate the
  impersonation branch on an explicit `ENV != "production"` check inside the
  function body so a future re-wire cannot ship the bypass.
- **Verify:** no path honors `X-Dev-User-Id` when `ENV=production`.

### A9 — Admin-controlled SSRF via SMTP/IMAP/MS-Graph host  `[Medium/sec]`
Source: SEC-4.
- **Where:** `comm/smtp.go:633-639`, `comm/imap.go` (dial), `activitysink/pumper.go`;
  config write `comm_channel_set_batch.sql` / `activity_sink_set_batch.sql`
  store hosts with no allowlist.
- **Definition of Done:** add a guard for the dial targets — denylist
  RFC1918 + link-local (169.254/16) + loopback by default, overridable by an
  env-configured allowlist; enforce at channel/sink **set** time and again
  **before dial**. If a full allowlist is out of scope, at minimum the
  dial-time RFC1918/loopback denylist + a documented operator note.
- **Verify:** setting `smtp_host`/`imap_host` to `127.0.0.1`/`169.254.169.254`/
  an RFC1918 address is rejected (or refused at dial) unless allowlisted; a test
  covers the denylist.

### A10 — Single source of truth for "card → enclosing project"  `[Medium]`
Source: BE-M3 (and ties to A1's shared helper).
- **Where:** Go `authz.go:77-93` (`resolveTargetProject` + `expandCardLookup`)
  vs in-SQL walks in `card_insert_batch.sql:282-405`,
  `attribute_update_batch.sql:225-364`, `comm_create_batch.sql:184-211`.
- **Definition of Done:** both the authz pass and the write functions resolve
  the enclosing project through **one** capped helper (reuse A1's
  `card_ancestors`); remove the divergent cap behavior.
- **Verify:** one helper is the only capped ancestor walk; the duplicated
  inline walks call it.

### A11 — `card.move` does not re-validate cross-project refs  `[Medium]`
Source: BE-M5.
- **Where:** `card_move_batch.sql:97-104` (updates parent, logs activity, no ref
  check) vs `card_insert_batch.sql:277-405` / `task_move_batch.sql` which do
  enforce the cross-project ref invariant.
- **Definition of Done:** re-run the cross-project card_ref validation in
  `card_move_batch` (reuse the M3/A10 helper), OR document+enforce that
  `card.move` is restricted to card types carrying no project-scoped refs.
- **Verify:** moving a card whose refs would cross projects is rejected (or
  proven impossible by type restriction); test added.

### A12 — `expandCardLookup` is O(depth) sequential round-trips  `[Medium/perf]`
Source: BE-M4.
- **Where:** `server/internal/api/authz.go:124-158` (one query per BFS level).
- **Definition of Done:** do the full ancestor closure in one capped recursive
  CTE returning `(id, parent, type)` (reuse A1's helper).
- **Verify:** one DB round-trip for the ancestor expansion (assert query count);
  authz outcomes unchanged.

### A13 — BE-H2 safe increment: kill hand-counted offset class  `[High → scoped]`
Source: BE-H2 (full relocation DEFERRED — see scope decisions).
- **Where:** `card_compile_predicate.sql` (hand-counted `(_ph_count - …)`
  offsets throughout) + `card_select_with_attributes_batch.sql`.
- **Definition of Done:** replace hand-counted placeholder arithmetic with a
  small in-function helper that appends a value to the params bag and **returns
  its index**, so no leaf computes an offset by hand (the off-by-one class is
  the target). Add a **property/diff test** that runs the same random predicate
  trees through the Go compiler and the SQL compiler and asserts identical
  results. Do **not** rewrite the compiler's location this pass.
- **Verify:** no `(_ph_count - N)` style arithmetic remains in leaves; diff test
  exists and passes on a set of random trees.

### A14 — EAV value-side index  `[High]`
Source: BE-H1.
- **Where:** `db/schema/schema.hcsv:180-191` (`attribute_value` has only PK
  `(card_id, attribute_def_id)` + trgm GIN on `value::text`).
- **Definition of Done (declarative schema):** add `(attribute_def_id, value)`
  and `(attribute_def_id, card_id)` btree indexes; add a partial expression
  index on `((value)::text::bigint)` where `jsonb_typeof(value)='number'` for
  the card_ref phase joins. Add a short note (EXPLAIN before/after on a seeded
  sample) confirming a value-first filter now seeks rather than scans.
- **Verify:** indexes present in `schema.hcsv`; `EXPLAIN` on a `status = X`
  filter uses an index path on a sample with a few thousand cards.

### A15 — Small backend hygiene  `[Low]`
- **A15a (BE-L2):** `server/internal/named/named.go:32-36` — error when the
  scanner encounters a `$tag$` dollar-quote (tripwire), rather than silently
  rewriting `:name` inside it. *Verify:* a template with `$$...$$` errors at
  compile.
- **A15b (BE-L4):** `card_select_with_attributes_batch.sql:289` — build the
  WHERE as `WHERE TRUE AND …` (or guard the empty case) so a future conditional
  visibility clause can't emit a bare `WHERE`. *Verify:* code reads defensively.
- **A15c (BE-L3):** `authz.go:272-282` `processExists` — load the (tiny,
  immutable) `process` table once at startup / cache on the pool instead of a
  point query per gated leaf. *Verify:* no per-leaf `SELECT … FROM process`.
- **A15d (BE-L1):** fold the duplicated `16` cap into the single shared helper
  from A1 (don't parameterize the value per CLAUDE.md; just stop restating it).
- **A15e (BE-L5):** `dom/comm/smtp.go:699-704` — leave the `client.Quit()` drop
  but make it an explicit `errors.Is`-style ignore with the existing comment, to
  satisfy the CLAUDE.md error rule. Cosmetic; lowest priority.

---

# Part B — Frontend reactivity (current Svelte client) — `agent B`

Goal: protect the **currently-shipping** `client/` from the live cascade and
the silent-correctness bugs. Do **not** do the large component-carving refactor
(FE-H4) — that client is being superseded.

### B1 — Remove the live AppShell ↔ project-scope cascade  `[Critical]`
Source: FE-C2 (the known-unfixed white-screen, `git show a347f38`).
- **Where:** `shell/AppShell.svelte:115-141`, `keys/registry.svelte.ts:59-82`,
  `shell/projects_store.svelte.ts:70-73`.
- **Definition of Done:** (1) chord registration becomes a pure `$derived`
  screen→chord list the dispatcher reads, not an `$effect` that imperatively
  register/unregisters on every change; (2) `projectsStore.load` no longer
  writes `projectScope.projectId` as a side effect — "stale scope" is surfaced
  as a derived/validated value the caller resets explicitly, outside the load.
- **Verify:** switching projects / cold deep-link no longer risks
  `effect_update_depth_exceeded`; no effect both reads `projectScope.projectId`
  and (transitively) writes it; e2e project-switch journey passes.

### B2 — Replace effect-into-bindable mirroring with `$derived`  `[Critical]`
Source: FE-C1.
- **Where:** `filter/ScreenFilterBar.svelte:155-157,167-169,193-270`;
  similar copies flagged in Kanban (`:171`).
- **Definition of Done:** effects whose only job is copying `$state`/`$derived`
  into a `$bindable` become plain `$derived` the parent reads directly. The
  78-line loader effect (`:193`) is split: a `$derived` key (`projectId +
  screenSlug`) drives a narrowly-scoped loader that writes only into a store the
  view derives from — never back into its own tracked deps.
- **Verify:** the cited `untrack` sites in ScreenFilterBar are gone or reduced to
  obvious snapshot reads; `grep -rlF untrack client/src` count drops materially
  from the current 14 files; filter bar still loads/selects correctly.

### B3 — Fine-grained store writes (no whole-collection reassign)  `[High]`
Source: FE-H2.
- **Where:** `screens/filter_state.svelte.ts:80,112` (`cache.byKey = {...}`);
  check `schema/store.svelte.ts:94`.
- **Definition of Done:** mutate the `$state` proxy in place
  (`cache.byKey[key] = v`, `presetByKey[key] = v`) so a per-key write
  invalidates one reader, matching the fix already applied to the registry
  (`cc1cfd1`).
- **Verify:** no `= {...spread}` container reassignment in the filter cache;
  per-key writes don't re-run unrelated readers.

### B4 — Stop transport-layer id-type guessing corrupting comparisons  `[High]`
Source: FE-H3.
- **Where:** `dispatch/dispatcher.ts:61-97,111-151` (runtime
  `CARD_REF_ATTR_KEYS` bigint revival); equality sites like
  `ScreenFilterBar.svelte:165` and every picker `valueForKey`/option match.
- **Definition of Done:** make id comparison robust to a number/bigint mix —
  normalize to a canonical string form (`String(x)`) at the comparison points,
  OR have the server tag value types on the wire so the client never guesses.
  The chosen approach must not depend on schema-preload boot ordering.
- **Verify:** a card_ref value rendered before the schema preload lands (or a
  card_ref attr added after boot) still matches its picker option; add a unit
  test for the number-vs-bigint equality case.

### B5 — DnD store: honest reactivity contract  `[High]`
Source: FE-H1.
- **Where:** `dnd/use_dnd.svelte.ts:88-115` (doc claims `$effect` subscription
  over plain non-`$state` fields).
- **Definition of Done:** either make `active`/`zones` `$state`-backed (keep the
  imperative callbacks as the fast path) or delete the false comment and
  document that the store is callback-only.
- **Verify:** the documented contract matches reality; no consumer relies on a
  dead reactive read.

### B6 — Cheap correctness fixes  `[Medium/Low]`
- **B6a (FE-M2):** `shell/projects_store.svelte.ts:106-117` — the loader effect
  tracks `projectsVersion` only but `load()` reads `showTemplates`/`projectId`;
  track the actual inputs (or fold into a `$derived` key) so staleness isn't
  convention-enforced. *Verify:* changing `showTemplates` without a manual
  version bump still refreshes.
- **B6b (FE-M5):** `screens/KanbanLayout.svelte:544-568` — optimistic rollback
  restores a captured array and can clobber a concurrent refresh; roll back by
  re-issuing a refresh or guard on a generation counter. *Verify:* a refresh
  landing mid-drop doesn't get overwritten by a failed-drop rollback.
- **B6c (FE-M3):** `routing/router.svelte.ts:53-55` — memoize `match` via
  `$derived(matchRoute(this.path))`. *Verify:* `match` doesn't recompute per read.
- **B6d (FE-L2):** `ui/Combobox.svelte:222-232` — return a cleanup that clears
  the debounce `setTimeout` on unmount. *Verify:* timer cleared on destroy.
- **B6e (FE-L4):** `screens/GridLayout.svelte:264` — remove the hardcoded `2n`
  "me" fallback id (renders another user's "mine" view); fail safe instead.
  *Verify:* unparseable sub does not silently impersonate user id 2.

### Deferred (not this pass)
- **FE-H4** component carving (TaskDetail 2025 LOC etc.) — superseded by
  `client-next/`.
- **FE-M1** route every popup through `Popover` (9 hand-rolled floating-ui
  copies) — worthwhile but a broad sweep; defer unless quick.
- **FE-M4, L1, L3** — minor; address only if trivial while in the file.

---

## Reporting protocol for both agents
For each ID above, report one of `DONE` / `PARTIAL` (what's left) / `DEFERRED`
(why) / `SKIPPED` (why). Run `go build ./...` + `go test ./...` (backend) and
`pnpm check` + `pnpm test` (frontend) before reporting; include results. **Do
not commit.**
