# kitp — Next Task Batch — Implementation Plan

Companion to `TASKS.md`. Concrete steps per task, owned files, expected
test coverage, and dependency notes.

The repo is **not currently a git repository**, so worktree isolation
between agents is not available. To prevent file-write races, tasks are
split into two waves:

| Wave | Tasks                                | Rationale                          |
| ---- | ------------------------------------ | ---------------------------------- |
| 1    | T1, T3, T5                           | Disjoint files (modals / inbox / new admin screen). |
| 2    | T2, T4, T6                           | Each touches a different screen + new files; T2 ships filter widgets that T3/T4 wire later in a follow-up. |

Each wave runs its agents in parallel; the next wave starts only after
the previous wave finishes.

Pre-wave fix-up (done by the orchestrator before any agent spawns):
add `/admin/attributes` and `/activity` route stubs to
`client/lib/app.dart`, each rendering a placeholder. This way T5 and T6
agents only need to swap the placeholder for their real screen — they
never edit overlapping regions of `app.dart`.

---

## T1 — New-issue modal

**Files**

- `client/lib/ui/screens/projects_screen.dart` (`_NewProjectDialog`)
- `client/lib/ui/screens/project_detail_screen.dart` (subtask create dialog)

**Steps**

1. Replace `AlertDialog` with `Dialog` + a constrained `SizedBox` (560×min,
   capped at `MediaQuery.of(context).size * 0.8`).
2. Stack a title `TextField` and a multi-line description `TextField`
   (`minLines: 4, maxLines: 10`) inside a `Column`.
3. Submit handler:
   - Run two sub-requests via the dispatcher in one batch:
     `card.insert` + (only if description non-empty)
     `attribute.update(description)`. Use
     `Dispatcher.coalesce(...)` if available; otherwise fire both with
     `Future.wait` so the dispatcher's per-frame coalescing batches them.
   - On success: pop dialog with the new card id.
4. No assignee picker — leave the card unassigned. Existing
   `attribute.update` handlers on the detail screen handle assignment
   later.

**Tests**

- `client/test/widget/new_project_dialog_test.dart`: dialog renders
  title + description, submit triggers expected sub-requests.
- Add a screenshot under `docs/screenshots/v2-t1/` of the new dialog.

**Risk / coupling**

- Low. Self-contained dialog widgets.
- T6 will later add Ctrl+Enter shortcuts to these same dialogs; T6 must
  re-read the post-T1 file.

---

## T2 — Pillbox display + filter UI

**Files**

- `client/lib/ui/widgets/attribute_chip.dart` (label prefix removal)
- `client/lib/ui/filter/predicate.dart` (new) — AST + serialisation
- `client/lib/ui/filter/filter_bar.dart` (new) — quick-filter chip row
- `client/lib/ui/filter/filter_tree_editor.dart` (new) — advanced editor
- `client/lib/ui/screens/grid_screen.dart` — first integration site
- `client/lib/reg/handlers.dart` — extend `CardWherePredicate` /
  `CardWhereGroup` envelope
- `server/internal/dom/card/where.go` (or equivalent) — compile predicate
  tree to SQL `WHERE`

**Steps**

1. **Pillbox**: change the chip text to `value` only; if `value` is null,
   render `—` (today's `label: —`). Update existing call sites that
   relied on the prefix to add a sibling label `Text` themselves.
2. **AST**: define `Predicate` with two subtypes — `Leaf(attr, op, values)`
   and `Group(connective: AND|OR|NOT, children: [Predicate])`. JSON
   round-trip helpers.
3. **Quick bar**: `FilterBar` widget rendering each leaf predicate as a
   removable chip + a `+ filter` button that opens an inline picker
   (attr → op → value). Uses the AST under the hood, always wrapped in a
   single top-level AND group.
4. **Tree editor**: `FilterTreeEditor` renders the AST as a nested,
   indentable tree of group/leaf cards with toggles for AND/OR/NOT and
   per-leaf inline editors. Full of keyboard shortcuts (Tab to nest, etc.)
   is out of scope; focus on click-driven editing.
5. **Server**: change `CardWhereInput` to accept either the legacy flat
   list or a new `tree` field; the SQL builder walks the tree, generating
   parametrised SQL with grouped parens. Existing flat input remains for
   backward compatibility.
6. **Grid integration**: replace the bespoke status filter row with
   `FilterBar(predicate: _filter, onChange: ...)`; pass `_filter` into the
   `where` of the dispatcher request.

**Tests**

- `server/internal/dom/card/where_test.go`: AST → SQL fixture tests for
  every operator and a nested AND/OR/NOT case.
- `client/test/widget/filter_bar_test.dart` and
  `client/test/widget/filter_tree_editor_test.dart`.
- Screenshot of the advanced editor in `docs/screenshots/v2-t2/`.

**Risk / coupling**

- Medium. New shared widgets; T3/T4 will mount them in a follow-up.
- T2 owner must NOT touch `inbox_screen.dart` or `kanban_screen.dart`
  (T3/T4 territory in this wave).

---

## T3 — Inbox drag handle

**Files**

- `client/lib/ui/screens/inbox_screen.dart`

**Steps**

1. In `_DraggableInboxRow.build`, prepend an `Icon(Icons.drag_indicator)`
   inside a `MouseRegion(cursor: SystemMouseCursors.grab)`.
2. Wrap the icon in a `Draggable<_InboxDragPayload>` (not `LongPressDraggable`)
   so dragging the icon starts immediately. Keep the existing
   `LongPressDraggable` on the row body as a fallback for touch users.
3. Update the existing widget test to assert the handle exists and
   triggers the drop pipeline.

**Tests**

- Extend `client/test/widget/inbox_screen_test.dart` (or create one) to
  cover the handle gesture.

**Risk / coupling**

- Low. File is owned exclusively in this wave.

---

## T4 — Kanban drag handle

**Files**

- `client/lib/ui/screens/kanban_screen.dart`

**Steps**

1. In `_DraggableCard._buildCard`, add an `Icon(Icons.drag_indicator)` to
   the top-right of the card header (or leading edge of the title row).
2. Wrap the icon in a `Draggable<_DropPayload>` and keep the existing
   `LongPressDraggable` on the card body as touch fallback.
3. The drop pipeline (column / lane / sort_order updates) is unchanged —
   we are only making the gesture discoverable.

**Tests**

- Extend the kanban widget test (or add one) to cover the new handle
  starting a drag.

**Risk / coupling**

- Low. File is owned exclusively in this wave.

---

## T5 — Attribute admin

**Files**

- `db/migrations/0011_attribute_admin.sql` (new) — registers
  `is_active` `attribute_def` (boolean), edges binding it to milestone /
  component / tag.
- `server/internal/dom/attributedef/attributedef.go` (new) —
  `attribute_def.select`, `attribute_def.insert`, `edge.select`,
  `edge.insert`, `edge.delete`.
- Wire those into `server/cmd/kitpd/main.go` registry.
- `client/lib/reg/handlers.dart` — typed envelopes for the new endpoints.
- `client/lib/ui/screens/admin_attributes_screen.dart` (new) — replaces
  the placeholder added by the orchestrator.
- `client/lib/ui/widgets/attribute_side_panel.dart` — filter
  `is_active = true` from picker options (do NOT hide already-applied
  values).
- `client/lib/ui/screens/projects_screen.dart` and
  `client/lib/ui/screens/project_detail_screen.dart` — same filter rule
  in their pickers (read-only — do NOT alter the dialog UI; T1 owns it).

**Steps**

1. Migration: insert `attribute_def(name='is_active', value_type='bool')`
   and edges into `card_type=milestone|component|tag`.
2. Server endpoints: minimal CRUD for `attribute_def` and `edge`. Hard
   delete on values uses existing `card.update` to set
   `deleted_at = now()` (soft delete) — value rows are CARDs.
3. Admin screen layout: left column lists attributes; right column shows
   selected attribute's edges and (for ref-attrs) value cards with an
   "Active" toggle and a "Delete" action gated on usage count
   (`SELECT count(*) FROM attribute_value WHERE value::text LIKE ...`).
4. Picker filter: when populating a chooser, drop value cards whose
   `is_active` attribute is `false`.

**Tests**

- `server/internal/dom/attributedef/attributedef_test.go`: CRUD lifecycle.
- `client/test/widget/admin_attributes_screen_test.dart`: list + toggle
  active.
- Screenshot in `docs/screenshots/v2-t5/`.

**Risk / coupling**

- Medium. Touches several picker call sites in read-only mode (filter
  only). T5 owner must NOT alter modal layout or task-detail layout —
  those are T1/T6 territory.

---

## T6 — Shortcuts + collapsible activity + global activity view

**Files**

- `client/lib/ui/screens/task_detail_screen.dart` — activity
  `ExpansionTile` + Ctrl+Enter handlers on title/description/comment.
- `client/lib/ui/screens/projects_screen.dart` — Ctrl+Enter in T1 dialog
  (re-read after T1 lands).
- `client/lib/ui/screens/project_detail_screen.dart` — same.
- `client/lib/ui/screens/activity_screen.dart` (new) — replaces the
  placeholder added by the orchestrator.
- `client/lib/ui/widgets/app_shell.dart` (or wherever the nav lives) —
  add "Activity" tab.
- `server/internal/dom/activity/activity.go` — accept `cardId == 0/null`
  and skip the WHERE in that case (still applies the role visibility
  filter that already exists).
- `client/lib/reg/handlers.dart` — relax the `cardId` requirement on
  `ActivitySelectInput`.

**Steps**

1. **Shortcuts**: wrap each affected `TextField` in
   `Shortcuts(shortcuts: { LogicalKeySet(LogicalKeyboardKey.control,
   LogicalKeyboardKey.enter): _SubmitIntent() }, child: Actions(...))`.
   Reuse a small `_CtrlEnterSubmit` widget rather than duplicating the
   wiring.
2. **Activity collapse**: convert the existing `_buildActivitySection`
   into a `Theme(data: stripped, child: ExpansionTile(initiallyExpanded:
   false, title: 'Activity (${_activity.length})', children: [...]))`.
3. **Global activity**: new screen mirrors the existing per-card list
   but uses the relaxed `activity.select`. Each row links via
   `context.go('/task/${row.cardId}')`.
4. **Nav**: add a button to `AppShell` and a route in `app.dart` (already
   stubbed by orchestrator).

**Tests**

- Widget tests for each Ctrl+Enter shortcut.
- Widget test for the collapsible Activity section starting collapsed.
- `server/internal/dom/activity/activity_test.go` — null cardId returns
  rows from multiple cards.
- Screenshots of the global activity view + collapsed activity in
  `docs/screenshots/v2-t6/`.

**Risk / coupling**

- Medium. T6 touches files T1 also touched. T6 runs in wave 2 (after
  T1) so the file is stable when T6 reads it.

---

## Wave-by-wave dispatch

The orchestrator pre-stubs the two new routes in `app.dart` so T5 and T6
agents do not race on that file. Then:

**Wave 1 (parallel)**: T1, T3, T5
**Wave 2 (parallel, after wave 1)**: T2, T4, T6

After both waves complete, follow-up integration:

- Mount `FilterBar` (from T2) in `inbox_screen.dart` and
  `kanban_screen.dart`. Tracked as a separate cleanup item; not part of
  the six numbered tasks.
