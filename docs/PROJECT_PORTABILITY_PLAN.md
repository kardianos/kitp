# Project portability — design

Status: draft, not yet implemented. Authored 2026-05-10.

Covers four pieces of work that share a theme — making a kitp project a
self-contained, movable unit:

1. **Per-project reference scoping.** Constrain `tag` / `milestone` /
   `component` references on a task to value-cards from the *same*
   project as the task. Picker queries + dispatcher validation.
2. **Assignee-as-card.** Lift the assignee out of `user_account` and
   into a new `person` card type. A person card may optionally map to a
   `user_account`, so we can assign tasks to a project manager who has
   no login.
3. **Export.** Two flavours from the admin Projects screen: a simple
   CSV (one row per task, embedded fields) and a full ZIP (separate
   CSVs for tasks / comments / other cards, plus an `attachments/`
   subfolder).
4. **Import.** A wizard that takes a CSV, maps columns, resolves
   unknown values, dry-runs, then commits. Optional auto-create for
   unknown tags / components / milestones / persons.

Companion to `docs/PROJECT_SCOPED_SCHEMA_PLAN.md` (interpretation B —
project-typed edges + enum option sets). That work is independent and
deferred; this doc is interpretation A only, plus the import/export
machinery the user asked for in the same iteration.

## 1. Per-project reference scoping (interpretation A)

### What changes

- **Server validation.** `attribute.update` (and `card.insert` when the
  request batch includes attribute values on the new card) gains a
  reference-scope check. For each value of type `card_ref` or
  `card_ref[]` where the attribute_def is `milestone_ref`, `component_ref`,
  or `tags`, walk the value-card's parents up to its enclosing project
  and assert it matches the target card's enclosing project.
- **Picker queries.** Today the client fetches tags / milestones /
  components via a `card.list_by_type` filter. Add a `parent_project_id`
  filter on that handler so the dropdowns only show in-project options.
- **Inbox / kanban filters.** When the project scope is active, filter
  chips for `tag` / `milestone` / `component` already inherit the
  scope; just make sure the all-projects view (no scope) shows them
  grouped by project so the user sees the boundary visually.

### What does **not** change

- `assignee` (a `user_ref` today, a `card_ref` to a global `person` card
  after §2). Persons stay global.
- `description`, `status`, `sort_order`, `title`, `is_active`,
  `path`, `root_exclusive_at` — all primitive or non-card-ref values.
  No change.
- Comments. Comments attach to a card via an activity row; they don't
  carry a project of their own. No change.

### Cross-project moves

Out of scope. The runtime doesn't support reparenting a card across
projects, and we won't add it as part of this work. If a future
operation does enable it, the contract is: when a task is moved to a
new project, *clear* `milestone_ref` / `component_ref` / `tags` whose
value-cards don't live under the new project; emit an `attr_clear`
activity per cleared field for audit.

### Tests (per-project scoping)

- Table-driven Go unit test
  (`server/internal/dom/attribute/scope_test.go`):
  - Rows: `(task_project, ref_card_project, expected_outcome)` across
    same-project (accept), cross-project (reject), no-project
    (reject for tag/milestone/component, accept for assignee),
    null-value (accept), mixed batch (one valid, one invalid → whole
    batch rejected).
  - Subjects: `milestone_ref`, `component_ref`, `tags`, `assignee`.
- One e2e step in the combined Chrome journey — see §6.

## 2. Assignee-as-card

### Why

Today an assignee is a `user_ref` storing `user_account.id`. That
collapses two concepts: "who logs in" and "who is responsible for the
work." A project manager may be responsible without ever having a
kitp login; the team that's actually doing the work may turn over.

After: a **`person` card** is the assignable unit. A user_account may
*optionally* be linked to a person card (1:1, both sides nullable).
OIDC provisioning creates the user_account and a linked person card
on first login. Imports can create person cards from CSV strings without
ever touching the auth model.

### Schema

New card_type, new attribute_defs, new link table:

```sql
-- New card_type. Person cards are global (no parent project).
INSERT INTO card_type (name, parent_card_type_id, allow_self_parent, is_built_in)
VALUES ('person', NULL, false, true);

-- New attribute_def for the person's email. The title attribute
-- already exists and carries the display name.
INSERT INTO attribute_def (name, value_type, is_built_in)
VALUES ('email', 'text', true);

-- Edges: title (required) and email (allowed) on person.
INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
VALUES
    ((SELECT id FROM card_type WHERE name='person'),
     (SELECT id FROM attribute_def WHERE name='title'), true,  0),
    ((SELECT id FROM card_type WHERE name='person'),
     (SELECT id FROM attribute_def WHERE name='email'), false, 1);

-- Link table — optional 1:1.
CREATE TABLE user_account_person (
    user_account_id bigint PRIMARY KEY REFERENCES user_account(id) ON DELETE CASCADE,
    person_card_id  bigint NOT NULL UNIQUE REFERENCES card(id) ON DELETE CASCADE
);

-- Change the assignee attribute_def from user_ref → card_ref.
UPDATE attribute_def SET value_type='card_ref' WHERE name='assignee';
```

The `assignee` value semantics change: was `user_account.id`, now
`person_card.id`. Existing `attribute_value` rows must be rewritten
during the declarative rebuild — see "Migration" below.

The `email` column on `user_account` becomes redundant for assignee
lookups (the person card carries it). We keep it for OIDC bookkeeping
since that's where the OP-issued email lands; the picker reads the
person card's email attribute.

### Migration (one-shot, via declarative reset)

Because we have no forward-only migration chain, the shift happens at
declarative-rebuild time:

1. The 5 demo persons get explicit ids in the seed: person cards `1`
   through `5` correspond to alice / bob / carol / dave / eve. Each
   carries `title=<name>` and `email=<name>@example.invalid`.
2. The seed builds `user_account_person` rows linking user_accounts
   `2..6` (alice..eve) to person cards `1..5`. The System User
   (`user_account.id=1`) gets a person card `6` titled "System" with
   `email=NULL`, plus a link row. Assigning tasks to System is rare but
   the activity stream uses `actor_id=1` independently, so we don't
   conflate the two.
3. The demo section's 25 tasks set `assignee` to a *person card id*,
   not a user_account id.

The dev DB rebuilds cleanly; production deployments would need a
one-off rewrite script (`UPDATE attribute_value SET value = (linked
person_card_id) WHERE attribute_def_id = $assignee`). Out of scope here.

### Server changes

- `auth/oidc`: on first sight of a `sub`, create user_account → create
  person card → INSERT `user_account_person` link, all in one tx.
- `user.list` (the picker today) reads from `user_account`. Rename /
  re-aim at a new `person.list` that returns person cards joined to
  optional user_account. The existing picker UI consumes display_name +
  email; both come from the person card.
- `attribute.update` for `assignee`: value is now a person card id;
  validate the referenced card has `card_type='person'`.
- Authorization is unchanged — `role` / `role_grant` / `user_role` stay
  on `user_account`. Who is assigned a task is independent of who can
  act on it.

### Client changes

- The assignee picker switches from "users" to "persons." Display
  fields are unchanged; the underlying value type goes from `user_ref`
  to `card_ref`. Update `attribute_renderer.svelte` to render a person
  card by its title + email, and remove the user-specific path.

### Tests (assignee-as-card)

- Table-driven Go unit test
  (`server/internal/dom/person/person_test.go`):
  - Rows: `(input, expected)` over the matrix
    `{person_with_link, person_without_link, system_person} ×
     {assign_to_task, list_for_picker, link_existing,
      unlink, attempt_to_assign_to_non_person}`.
  - Verifies OIDC auto-provision creates both rows and the link in
    one tx.
- One e2e step in the combined Chrome journey: assign a task to a
  person who has no user_account; reload; verify the assignee renders.

## 3. Export

### Two modes

**Simple CSV** (one button: "Export CSV"). One row per task; columns:

```
id, title, status, assignee_email, assignee_name,
milestone, component, tags, description, sort_order,
created_at, deleted_at, comments
```

- `assignee_email` is the person card's email (may be empty);
  `assignee_name` is the person card title. Both included so the
  importer can match on either.
- `milestone` / `component`: title of the referenced card.
- `tags`: comma-separated `path` attributes (e.g. `priority/high,area/be`).
- `comments`: all comment_body texts joined with `\n---\n` so a CSV
  cell can hold the full thread. Skipped if the task has none.
- `deleted_at`: ISO-8601 or empty.

A UI checkbox **Include deleted tasks** controls whether soft-deleted
rows are emitted. Default off.

**Full ZIP** (button: "Export full"). A `project-<id>.zip` with:

```
project.csv                # one row, the project's own fields
tasks.csv                  # same columns as simple, sans `comments`
comments.csv               # task_id, author_email, body, created_at
milestones.csv             # id, title, is_active
components.csv             # id, title, is_active
tags.csv                   # id, title, path, root_exclusive_at, is_active
persons.csv                # id, title, email, has_login (bool)
activity.csv               # full activity stream (optional toggle)
attachments/
  <attachment_id>-<filename>
attachments.csv            # attachment_id, task_id, filename, sha256,
                           # size_bytes, mime_type, created_at,
                           # created_by_email, thumb_path
```

Two checkboxes on the export dialog:
- **Include attachments** (default off — adds bytes to the zip)
- **Include activity log** (default off — adds rows)

`comments` and the other CSVs are always included in the full export;
omitting them defeats the point.

### Server

- New handler `project.export.simple` returns `text/csv` with the
  flattened shape, streamed.
- New handler `project.export.full` returns `application/zip`, streamed
  via the existing chunked-response infrastructure used by CAS
  downloads. Attachments stream straight from CAS.

Both handlers require `card.update` grant on the project (in line with
"can edit, can export") or an admin role.

### Tests (export)

- Table-driven Go unit test (`server/internal/dom/projectexport/
  export_test.go`):
  - Rows: `(project_shape, options, expected_csv_or_zip_contents)`
    across empty project, populated project with no deleted, populated
    with deleted, populated with attachments, populated with comments
    but no attachments.
- E2E: see §6.

## 4. Import

### Flow

The wizard is five steps, all server-driven so a refresh resumes from
the last persisted state.

```
1. Pick project        — existing project; we don't create new from CSV.
   ↓
2. Upload CSV          — multipart POST → CAS. Server returns headers
                         + first 20 rows for preview.
   ↓
3. Column mapping      — auto-fill by snake_case header match; user
                         can override or "ignore" any column.
   ↓
4. Resolution          — for unknown values, pick per-category:
                         (a) Map to existing
                         (b) Auto-create as new
                         (c) Skip rows containing this value
                         (d) Leave field blank (only where the attr
                             allows null).
                         Categories: persons, milestones, components,
                         tags, statuses. Statuses can only (a) or (c)
                         — never auto-create new enum options here.
   ↓
5. Preview + commit    — dry-run returns a counts summary + line-level
                         error log. User clicks Import; commit runs in
                         a single tx.
```

### Schema (import_job table)

```sql
CREATE TABLE import_job (
    id            bigserial PRIMARY KEY,
    project_id    bigint NOT NULL REFERENCES card(id),
    file_id       bigint NOT NULL REFERENCES file(id),
    status        text   NOT NULL DEFAULT 'pending',
    -- pending → uploaded → mapped → previewed → running → completed | failed
    mapping       jsonb,
    resolution    jsonb,
    summary       jsonb,
    created_by    bigint NOT NULL REFERENCES user_account(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    completed_at  timestamptz
);
```

`mapping` and `resolution` are persisted so the wizard can resume.
`summary` is the post-commit (or post-failure) report — counts,
created ids, error log.

### Handlers

- `project.import.upload(project_id, file_id)` → creates job row
  status `uploaded`, returns `{job_id, headers, preview_rows}`.
- `project.import.set_mapping(job_id, mapping)` → status `mapped`.
- `project.import.preview(job_id, resolution)` → dry-run. Returns
  `{would_create: {tasks, persons, milestones, components, tags},
    errors: [{row, column, message}], status: previewed}`.
- `project.import.commit(job_id)` → runs the import in one tx.
  Status becomes `completed` on success or `failed` with the error
  log preserved.

### Resolution rules

- **Persons.** Match incoming `assignee_email` against existing person
  cards. If no match and auto-create is on, create a new person card
  with title=name, email=email, no user_account link. If auto-create
  is off and skip is off, the row's assignee is blank.
- **Milestones / components / tags.** Match by title (milestone/
  component) or by `path` (tag) under the target project. Auto-create
  is per-category. Tag root_exclusive_at is set from the path prefix
  if it matches an existing exclusive group; otherwise null.
- **Status.** Must map to one of the target attribute's enum options.
  No auto-create. The wizard fails the row with a clear message if a
  status maps to nothing.

### Atomicity

Every commit is one transaction. Errors during commit roll back the
whole import. The job row records the failure (`status='failed'`,
`summary.errors=…`) so the user can inspect what went wrong without
re-uploading.

### Audit

Every imported task emits the same activity rows the runtime would:
`card_create` + one `attr_update` per attribute, all with
`actor_id = the importing user's id`. The activity row carries
enough information to reconstruct what was imported.

Additionally, the import_job row itself is the cross-cutting audit
record: who, when, which file, mapping, summary.

### Tests (import)

- Table-driven Go unit test
  (`server/internal/dom/projectimport/import_test.go`):
  - Rows for the parser: header order variants, quoting, trailing
    commas, empty cells.
  - Rows for resolution: each category × {match_existing,
    auto_create, skip, leave_blank} × {known, unknown} value.
  - Rows for commit: clean rowset (commits), one bad row
    (whole tx rolls back), reused CAS file (works on re-preview).
- E2E: §6 below.

## 5. Audit & idempotency

- The existing idempotency middleware applies to the import commit:
  re-posting `project.import.commit` with the same `Idempotency-Key`
  replays the stored response.
- Imports never re-issue ids; a re-run is a hard error unless the user
  re-uploads.
- Export endpoints are GETs, no idempotency needed.

## 6. Combined e2e Chrome test

`client/test/e2e/journeys/portability.ts` walks the full surface:

1. Boot kitp with the seeded demo data.
2. Open the admin Projects screen. Click **Export full** on Default
   Project with comments + attachments enabled. Verify the ZIP
   downloads and contains `tasks.csv` with 25 rows.
3. Modify `tasks.csv` in memory: rename one task's title, change one
   row's assignee to a brand-new email (`new.person@example.invalid`).
4. Click **Import** on a new empty project, upload the modified CSV,
   accept default mapping, turn on auto-create for persons, run
   preview → commit.
5. Navigate into the new project. Verify:
   - 25 tasks present
   - The renamed task is shown with the new title
   - A person card "new.person" exists with `email=…`, no
     `user_account_person` link
   - The assignee picker on a fresh task in the new project lists the
     new person
6. Negative check: try to set a task's `milestone_ref` to a milestone
   from Default Project. Expect a 4xx with a clear error.

The e2e journey lives alongside the existing harness and runs as part
of `make e2e`.

## 7. Implementation phasing

Order matters because assignee-as-card touches the seed shape, the
OIDC flow, and the picker — everything else depends on it.

1. **Assignee-as-card** (schema + seed + OIDC + picker). Reset the dev
   DB. Sanity test.
2. **Per-project reference scoping** (validation + picker filter). Two
   small server endpoints + one client wiring change.
3. **Export simple CSV.** New handler, admin button.
4. **Export full ZIP.** Builds on simple; reuses CAS for attachment
   streaming.
5. **Import upload + preview.** No commit yet — verify the wizard
   end-to-end on a dry-run.
6. **Import commit + audit.** Wire idempotency, run the commit, and
   add the import_job summary screen.
7. **E2E journey.** Lands once 1–6 are in.

Each phase is its own PR-sized change; each ships with the
table-driven unit test described in §1–§4.

## 8. Open questions

- *Q1* — should `person` cards be archivable (`is_active`)? The other
  value-card types are. Default: yes, mirror the existing flag.
- *Q2* — full-export ZIP filename: `project-<id>.zip` (id) or
  `project-<slug>.zip` (slugified title)? The latter is friendlier;
  the former is unambiguous. I'd pick slug with id suffix:
  `project-default-6.zip`.
- *Q3* — when import auto-creates a person, what role does it get?
  Today there's no role until OIDC provisioning happens. Imported
  persons would have no user_account_person link and therefore no
  role; they show up as assignable but can't log in. Probably correct;
  worth confirming.
- *Q4* — should the full export include the activity stream by
  default? It can dwarf the rest of the data on a busy project.
  Default off, opt-in, as drafted.

## 9. Not in scope

- Per-project enum options. Covered by `PROJECT_SCOPED_SCHEMA_PLAN.md`.
- Bulk re-assign from old user_account-based assignee values in
  production-shaped DBs. Dev rebuilds via `make db-reset`; production
  is its own one-off.
- Cross-project task move. See §1.
- Long-running async imports for very large projects. Blocking only
  for now.
