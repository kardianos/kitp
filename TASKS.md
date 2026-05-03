# kitp — Next Task Batch

Six concrete UX/data tasks against the existing client + server. Each task
below is self-contained: requirements only. The matching implementation
breakdown lives in `TASKS_PLAN.md`.

The tasks are numbered T1..T6 and tracked as internal items so none get
dropped.

---

## T1 — New-issue creation modal

**Required behaviour**

- **Default to unassigned.** When the dialog opens, the assignee field is
  empty (no current-user pre-fill). Submitting without setting an assignee
  creates the card with no `assignee` attribute.
- **Larger modal.** Today the dialog is a 360px-wide `AlertDialog`. Replace
  with a wider, taller surface (≥ 560×360, capped at 80% viewport) so a
  description can be drafted comfortably.
- **Description field.** Add a multi-line description input directly under
  the title. Empty description is allowed; non-empty saves an additional
  `attribute.update` for `description` in the same batch as the create.

**Out of scope**: full attribute panel inside the dialog. Just title +
description here; everything else is set on the detail screen.

**Affected surfaces**

- `client/lib/ui/screens/projects_screen.dart` — `_NewProjectDialog`
- `client/lib/ui/screens/project_detail_screen.dart` — subtask create dialog

---

## T2 — Pillbox display + general filter UI

**Part A — drop the label prefix**

- Today `AttributeChip` renders `"<label>: <value>"` (e.g. `Component: API`).
  Show only the value (`API`). The label is implicit from the column the
  chip lives in.
- Use chip colour / icon to disambiguate type when context is ambiguous.

**Part B — generalised filter system**

- All four list views (Projects, Inbox, Grid, Kanban) get a shared filter
  bar with two modes:
  1. **Quick filter**: a row of chip-style predicates the user can stack
     (`status: doing`, `assignee: alice`, `tag: priority/p1`). Each chip is
     an equality or membership predicate; order does not matter (joined
     with AND).
  2. **Advanced filter**: a visual editor for an arbitrary boolean tree
     of predicates: `AND`, `OR`, `NOT` group nodes; leaf nodes are
     `<attr> <op> <value(s)>`. Operators include `=`, `!=`, `in`, `not in`,
     `exists`, `not exists`. Tree is round-trippable to a textual form
     (`milestone in (M1, M2) AND status != done`) for sharing/URL state.
- Filterable surfaces: any attribute reachable on the card type, plus
  edge predicates (parent project, has-tag).
- Server: extend `card.select_with_attributes` `where` to accept a
  predicate tree (today it accepts only a flat AND of attribute predicates).

**Out of scope (for now)**: saved filter sets, server-side persisted views.

**Affected surfaces**

- `client/lib/ui/widgets/attribute_chip.dart` — drop prefix
- `client/lib/ui/filter/*` (new) — predicate AST + bar + tree editor
- `client/lib/ui/screens/grid_screen.dart` — first integration site
- `server/internal/dom/card/*` — predicate tree in WHERE compilation

---

## T3 — Inbox visible drag handle

**Required behaviour**

- Each inbox row shows an explicit drag handle (Material
  `Icons.drag_indicator`) on the leading edge.
- Grabbing the handle starts a drag immediately (no long-press needed).
- Dropping above/below any row reorders within the personal inbox order.
  This wiring already exists end-to-end via `user_card_sort.set`; we are
  only making the gesture discoverable.

**Affected surfaces**

- `client/lib/ui/screens/inbox_screen.dart`

---

## T4 — Kanban visible drag handle on cards

**Required behaviour**

- Each kanban card shows an explicit drag handle in the card header.
- Grabbing the handle starts a drag immediately.
- Drop targets remain unchanged: dropping into a different column updates
  the column-defining attribute (`status` / `assignee` / `milestone_ref` /
  `component_ref`); dropping into a different swim lane updates the lane
  attribute; dropping at a different vertical slot updates `sort_order`.
  This logic already exists; we are only making the gesture discoverable.

**Affected surfaces**

- `client/lib/ui/screens/kanban_screen.dart`

---

## T5 — Attribute admin screen

**Required behaviour**

- New screen at `/admin/attributes` (admin-only, behind the existing
  `auth.isAdmin` gate).
- Lists every `attribute_def`, the `edge`s that bind it to card types, and
  — for ref-style attributes whose values are themselves cards (milestone,
  component, tag) — the population of value cards.
- For each value card, the admin can:
  - **Deactivate**: hides it from future pickers, keeps it on existing
    cards. Implemented via a new `is_active` attribute on the value card
    (default true). Pickers filter `is_active = true`; renderers (chips,
    grid cells) ignore the flag and always render the value.
  - **Reactivate**: clears the flag.
  - **Delete**: hard-removes the value card. Disallowed if any open card
    still references it; the screen surfaces a count and the admin must
    bulk-clear references first.
- Adding new attributes (new `attribute_def`/`edge` rows) is in scope:
  the admin can name an attribute, pick a value type, and bind it to one
  or more card types.

**Affected surfaces**

- `client/lib/ui/screens/admin_attributes_screen.dart` (new)
- `client/lib/app.dart` — add `/admin/attributes` route
- `db/migrations/0011_attribute_admin.sql` (new) — `is_active` attribute
- `server/internal/dom/attributedef/` (new) — `attribute_def.{select,insert}`
  and `edge.{select,insert,delete}`
- Value-side: existing `card.update` is enough for `is_active` flips
- Pickers in `attribute_side_panel.dart` and the new T1 modal must filter
  `is_active = true` when offering choices

---

## T6 — Keyboard shortcuts + activity views

**Part A — Ctrl+Enter shortcuts**

- In the new-issue dialog: Ctrl+Enter on title or description triggers
  the dialog's primary action (Create). Plain Enter in title still
  submits (today's behaviour); plain Enter in description inserts a
  newline (multi-line field).
- In task detail: Ctrl+Enter on title saves and blurs; Ctrl+Enter on
  description saves and blurs; Ctrl+Enter on comment composer posts.

**Part B — collapsible activity log on task detail**

- The "Activity" section becomes an `ExpansionTile` (or equivalent),
  **collapsed by default**. The header shows the activity count
  (`Activity (12)`).
- Expansion state is per-screen-instance; not persisted.

**Part C — global activity view**

- New screen at `/activity` showing the activity stream for every card
  the user can see (server applies the existing role/visibility filter).
- Each row: actor, kind, target card (link to `/task/:id`), what changed
  (old → new), timestamp.
- Server: `activity.select` already pages by cursor; extend to accept a
  null `cardId` (cross-card scan). The existing role-gating on read paths
  applies.
- Top-nav adds an "Activity" entry between Kanban and any admin links.

**Affected surfaces**

- `client/lib/ui/screens/task_detail_screen.dart` — activity collapse +
  Ctrl+Enter on title/description/comment
- `client/lib/ui/screens/projects_screen.dart` /
  `client/lib/ui/screens/project_detail_screen.dart` — Ctrl+Enter in the
  T1 modal (handed off from T1 author; T6 may need to re-edit after T1
  lands)
- `client/lib/ui/screens/activity_screen.dart` (new)
- `client/lib/app.dart` — `/activity` route + nav entry in `AppShell`
- `server/internal/dom/activity/activity.go` — null-cardId mode
