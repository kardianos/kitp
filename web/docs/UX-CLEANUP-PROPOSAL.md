# Proposal: admin/UX cleanup batch

Status: PROPOSED (2026-05-27). Tasks tracked as #12–#22.

This batch is mostly frontend. The theme is **reuse**: several requests are the
same shared concern surfacing in different screens. Build/fix those once.

---

## A. Repeated elements — build/fix once, reuse everywhere

### A1. The shared drag-and-drop (`web/src/ui/drag-placeholder.ts`) — #22, #12, #14

A shared DnD kit already exists: **`DropPlaceholder`** (insertion bar),
**`computeDropTarget(viewport, clientY, draggedId, selector)`** (slot math),
**`FlipAnimator`** (settle animation). **Kanban uses it correctly and works.**

| Surface | Today | Plan |
|---|---|---|
| Kanban | shared kit, listeners on the **container** ✓ | reference impl |
| Inbox | shared kit, listeners on **each row** → the bug | fix #22 |
| Manage Values (#12) | ▲/▼ buttons, rewrite `sort_order` 10/20/30 ladder | adopt the kit |
| Workflow (#14) | **no reorder UI** (only a sort_order field) | adopt the kit |
| Grid columns | ▲/▓ buttons (popover) | leave as-is |

**#22 is the keystone — fix first.** The placeholder already has
`pointer-events:none` (styles.css:1016), so the overlay is NOT eating the drop.
The real issue: Inbox attaches `dragover`/`drop` to **pooled row nodes**, not the
scroll container. HTML5 `drop` only fires where a `dragover` called
`preventDefault`, so releasing in a gap (or over the moving placeholder region)
lands on the container, which has **no handler** → nothing commits. **Fix:** move
Inbox's `dragover`+`drop` onto `listBody` and resolve the slot via
`computeDropTarget` (mirror Kanban). Then #12 and #14 reuse the same wiring.

Keep the per-surface **persistence** seam: Inbox→`user_card_sort.set`,
Manage Values→`attribute.update(sort_order)`, Workflow→`flow_step.set(sort_order)`.
The kit handles interaction; the commit callback handles persistence.

### A2. A reusable Modal + an inline "pencil" editor — #16, #15 (helps #13, #18, #19)

No reusable **Modal** control exists today. `Popover` is anchored (wrong for a
centered transition editor); `qe-dialog` (project-list) is a one-off of CSS +
hand-wired Esc/backdrop. Extract a small **`Modal` control** (backdrop +
focus-trap + Esc + scroll-lock) once — serves #16 and is the natural home for
#13's add-attribute form and #18's create form. Separately, there's no single
**pencil → edit-in-place** control (MasterDetail fields are always editable;
`qe-dialog` is create/edit only). For #15, standardize one `EditableField`
(read text + pencil → input → commit on blur/Enter) and reuse it.

### A3. Declarative MasterDetail config — #17, #18, #20, parts of #13/#19

These are config edits in `web/src/admin/screens.ts` (row subtitle, create
fields, detail fields, nested editors) — cheap, low-risk. Do as one pass.

### A4. id→name resolution — #20

Showing an owner's name is the general "resolve user id → name" need. The app
already joins names server-side (`flow.list` → `scope_project_title`;
`user.list_with_roles` → role/project names). Prefer that over a client prefetch.

---

## B. Per-task notes

- **#12 Manage Values DnD** — `enum-manager.ts`: swap ▲/▼ for the shared kit;
  keep the `sort_order` ladder rewrite as the commit. Blocked by #22. FE only.
- **#14 Workflow reorder** — `nested-editor.ts` (`flowSteps`) has no reorder
  affordance today. Add shared DnD within each from-Status group; commit via
  `flow_step.set(sort_order)`. Blocked by #22. FE only.
- **#15 Workflow title/desc edit** — reuse the A2 `EditableField` (pencil). FE only.
- **#16 Edit Transition → modal** — today the form renders inline at the bottom
  (`buildStepForm`, driven by a `draft` tree leaf). Wrap that same form in the A2
  `Modal`, opened on Edit/Add; `flow_step.set` + reload unchanged. FE only.
- **#17 Named Filters JSON** — caused by
  `NAMED_FILTERS_SCREEN.list.row.subtitle: 'attributes.predicate'`. Drop it. Add
  a collapsible "raw predicate" under the Save-View/PredicateFilter editor. FE only.
- **#18 New Screen broken + workflow** — create action sends only `title`; a
  screen needs `layout`, `slug`, and `flow_ref`. NOTE: screens ALREADY have a
  workflow attached — the seed sets `flow_ref` on every screen card; the admin
  just doesn't surface/set it. So a title-only screen is born broken. Fix: add
  `layout` (required), a `flow_ref` (status-flow) picker, and slug auto-gen to the
  create form; expose `flow_ref` in the detail. Likely FE-only (confirm slug
  default server-side).
- **#13 Custom attributes** — `attribute_def` carries `is_built_in`, and
  `attribute_def.insert` already exists. Filter the list to `is_built_in != true`
  (or collapse built-ins read-only), retitle "Custom attributes", frame the
  create form as "Add scalar / Add picker" (scalar = pick value_type; picker =
  card_ref + target type + bind-to edges via the existing `edgeMatrix`). FE only.
- **#19 People → assign roles** — all plumbing exists: `user.list_with_roles`
  loads each user's roles; `user_role.set`/`revoke` + `role.list` are wired;
  PeopleManager rows carry `accountId`. Reuse the role-assign UI from
  `USERS_SCREEN`, shown inline for user-rows only. FE only.
- **#20 Agents owner name** — `user.select` returns `parent_user_id` but not the
  owner's name. Cleanest = backend join in `user_select_batch.sql` (parallel to
  `flow.list`'s `scope_project_title`). Backend + small FE.
- **#21 Nav user menu** — chip already renders `auth.user.displayName`. Logout
  endpoint exists (`POST /api/v1/auth/logout`) → ship a Logout button now. No
  `/account` route exists → ship the expanding menu + Logout; scope Account as a
  minimal read-only profile or defer.

---

## C. Suggested sequencing

1. **#22** (fix DnD) — unblocks #12 + #14; standalone correctness win.
2. **#12, #14** (reuse DnD).
3. **A2: extract `Modal` + `EditableField`**, then **#16, #15**.
4. **Admin config pass: #17, #18, #13** (+ #19 role UI).
5. **#20** (backend join) and **#21** (menu + logout; Account TBD).

**Backend touched:** only **#20** clearly needs it (owner-name join); **#18** may
need a slug-default check. Everything else is frontend; the handlers
(`attribute_def.insert`, `user_role.set/revoke`, `flow_step.set`, logout) exist.

## Open decisions

- **#21 Account**: ship a minimal read-only profile page, or defer Account and
  ship just Logout now?
- **#13 built-ins**: hide entirely, or keep in a collapsed read-only section?

---

# Addendum — second batch (#23, #24)

## #23. Consolidate project creation; remove the Admin → Projects screen

The projects landing/overview now has the full create (title + description +
template source + is_template, #6) and a show-templates filter (#7), so the
Admin → Projects screen (`PROJECTS_SCREEN`, workspace section) is redundant.
Before removing it, port its two remaining capabilities to the overview:
- **edit `is_template`** on an existing project (the landing ✎ edits only
  title/description today),
- **delete / soft-delete** a project.
Then remove `'projects'` from `AdminView` / `ADMIN_SCREENS` / `ADMIN_SECTION`
(`screens.ts`) and its `main.ts` label (mirror the OIDC-claims add in reverse).
FE only.

## #24. Per-screen default create status from base phase (+ sub-tasks)

**Problem.** A new task created from a screen lands in **triage** ("New idea"),
even when the screen is about active work. Today the web omits `status`, so
`card_insert_batch.sql` fills the project flow's `default_create_status_id`
(= triage). The screen's intent is ignored.

**What already exists (just unwired):**
- `web/src/quick-entry/default-status.ts` — a resolver with `firstByPhase`
  (first status of a phase by `sort_order`) and `resolveDefaultCreateStatus`.
- Screen cards carry a `default_create_status` card_ref (seed sets Inbox→Todo,
  Ideas→New idea, Comms→Open).
- `screen.phaseToggles` (landed by ScreenHost, #11) encodes each screen's
  `default_on` phase(s) — the **base phase**.
- `QuickEntry` already loads the project's status cards (`quickEntryStatuses`).
- The gap: `main.ts` never seeds QuickEntry's screen/flow context, so the
  resolver has no input → status omitted → server triage fallback.

**Key insight:** deriving "first status of the screen's base phase" *reproduces*
the hand-set overrides (Inbox active→Todo, Ideas triage→New idea, Comms
active→Open). So the base-phase rule generalizes the per-screen override — we can
derive instead of hand-setting each screen.

**Proposed resolution chain (client-side, in `QuickEntry`):**
1. **Caller prefill** pins a status (e.g. Kanban column `+` → that column's
   status). Highest priority — unchanged.
2. **Screen explicit `default_create_status`** (if the screen card sets one).
3. **Derived from base phase:** the **create phase** = `active` if it's
   `default_on`, else `triage` if `default_on`, else (terminal-only screens like
   Archive) skip → fall to #4. Then status = `firstByPhase(statuses, createPhase)`
   (min `sort_order`). Never create into a terminal status.
4. **No screen context** (sub-tasks from task-detail, MCP/API): omit `status` →
   server fills the project flow default (current behavior, unchanged).

**Wiring (minimal, reuses existing leaves):** ScreenHost lands
`screen.defaultCreateStatus` (add `readDefaultCreateStatus` to `screen-resolve`)
alongside the already-landed `screen.phaseToggles`; `QuickEntry` reads both +
its loaded statuses and runs the chain, sending the resolved `status` to
`card.insert`. The server flow-default stays as the no-screen fallback (MCP/API).

**Sub-tasks.** Created via `related-tasks-panel.openNewSubtask()` → `quickCreateOpen`
with a `parent_task` prefill, from the task-detail screen (which has **no base
phase**). Options:
- **(B, recommended)** default sub-tasks to the **first `active` status** — adding
  a sub-task implies active work, so it shouldn't dump into triage either.
- (C) inherit the **parent task's phase** (sub-task of an active task → active).
- (A) leave as-is → server flow default (triage). Rejected: same annoyance.
Either B or C requires `related-tasks-panel` (or QuickEntry, when the
`parent_task` prefill is present) to resolve + send the status, since there's no
screen base phase to read. Recommend **B** for predictability; **C** if the team
prefers sub-tasks to mirror their parent.

**Edge cases:** no status cards yet → omit (server/edge handles); terminal-only
screen (Archive) → never default to terminal, fall to flow default; the explicit
override (#2) lets any screen opt out of the derived phase.

**Open decision:** sub-task default — **first-active (B)** vs **inherit-parent
(C)**? And: once base-phase derivation lands, do we **keep** the explicit
per-screen `default_create_status` overrides (belt-and-suspenders) or **remove**
them as redundant?
