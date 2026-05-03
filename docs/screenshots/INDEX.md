# Screenshot Index

Phase-by-phase screenshot index. Phases 0-5 are server-only; client UI
lands in phase 12+. Phase 22 ships the consolidated end-to-end (e2e)
sequence captured by `e2e/bin/e2e.dart` against a fresh DB.

| Phase | File                            | Description                                                                                                |
| ----- | ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 12    | `12/shell.png`                  | Empty Flutter web shell — top nav (Projects, Inbox), left rail placeholder, Projects placeholder body.      |
| 13    | `13/list-empty.png`             | ProjectsScreen: empty state — "No projects yet — create one" with the New project FAB.                      |
| 13    | `13/create-dialog.png`          | ProjectsScreen: New-project dialog open with a sample title typed in.                                       |
| 13    | `13/list-with-projects.png`     | ProjectsScreen: list populated with the seeded Default Project plus three created projects.                 |
| 14    | `14/project-empty.png`          | ProjectDetailScreen: empty state for the Default Project (no tasks yet).                                    |
| 14    | `14/project-with-tasks.png`     | ProjectDetailScreen: list of four tasks rendered with status + assignee chips.                              |
| 14    | `14/new-task.png`               | ProjectDetailScreen: New-task dialog with title + status dropdown + assignee dropdown.                      |
| 15    | `15/task-detail.png`            | TaskDetailScreen: side-panel + description + activity layout. Activity rows resolve ids to names ("alice", "M1", "Frontend"). |
| 15    | `15/edit-attribute.png`         | TaskDetailScreen: status edited from `todo` to `review` via the side-panel dropdown; the activity stream picks up the change. |
| 15    | `15/task-with-comments.png`     | TaskDetailScreen: tall-window shot showing the description, the resolved activity stream, two posted comments, and the comment composer at the bottom. |
| 16    | `16/inbox-empty.png`            | InboxScreen: empty state — "Your inbox is clear." (every alice task soft-deleted for the shot).             |
| 16    | `16/inbox-populated.png`        | InboxScreen: alice's six open tasks in the server's default order (`personal_sort_order ASC NULLS LAST, created_at DESC`) — no personal sort applied yet, every row shows the muted leading indicator. |
| 16    | `16/inbox-reordered.png`        | InboxScreen: same data after a personal reorder — one task pulled to the top via `user_card_sort.set`. The promoted row carries the bright leading indicator (rows the user has personally ordered). |
| 17    | `17/grid-default.png`           | GridScreen: dense table over the 25 dense-seed tasks; ID/Title/Status/Assignee/Priority/Milestone/Component/Tags/Created columns. |
| 17    | `17/grid-sorted.png`            | GridScreen: same data, sorted ascending by Status (header arrow visible). Server reissues the order via one batch. |
| 17    | `17/grid-filtered.png`          | GridScreen: status filter chips toggled to show only `doing`+`review` (11 rows visible).                    |
| 18    | `18/kanban-single-lane.png`     | KanbanScreen: default view — columns by status, no swim lanes. Each card shows priority + assignee + tags. |
| 18    | `18/kanban-with-lanes.png`      | KanbanScreen: 2D board with columns by status and swim lanes by assignee.                                   |
| 18    | `18/kanban-drag.png`            | KanbanScreen: post-drag state — "Activity feed pagination" moved from `doing` to `review`. Move issued via one `attribute.update` batch. |
| 18    | `18/kanban-default.png`         | KanbanScreen: refreshed default view — cards now sort by `attributes.sort_order ASC` so the order is stable across reloads. |
| 18    | `18/kanban-reorder.png`         | KanbanScreen: post-reorder state — "API rate limits" moved from the top of `todo` to the top of `review` via a single batch updating `status` + `sort_order`. |
| 22    | `e2e/e2e-01-shell.png`          | E2E A. App shell loaded against the seeded `Default Project`.                                              |
| 22    | `e2e/e2e-02-projects-with-new.png` | E2E B. Projects list with the newly-created `E2E Demo Project` in addition to the seeded one.           |
| 22    | `e2e/e2e-03-project-detail-with-task.png` | E2E C. `E2E Demo Project` detail screen showing the `Wire up CI` task with status:doing chip.    |
| 22    | `e2e/e2e-04-task-detail-edited.png` | E2E D. Task detail after status→review, tag apply (priority/high + area/backend), and a posted comment. |
| 22    | `e2e/e2e-05-inbox.png`          | E2E E. Inbox viewed as alice (id=2) — 7 open tasks across the dense seed plus the new `Wire up CI`.        |
| 22    | `e2e/e2e-06-grid-default.png`   | E2E F.1. Grid view of `Default Project` (25 tasks, default order, all 4 status filters active).            |
| 22    | `e2e/e2e-07-grid-sorted.png`    | E2E F.2. Grid sorted ascending by Status (header arrow visible; rows reorder).                             |
| 22    | `e2e/e2e-08-grid-filtered.png`  | E2E F.3. Grid status-filtered to `doing`+`review` only (11 rows).                                          |
| 22    | `e2e/e2e-09-kanban-default.png` | E2E G.1. Kanban default — columns by status, no swim lanes.                                                |
| 22    | `e2e/e2e-10-kanban-after-column-drag.png` | E2E G.2. Post-drag column move — task `18` (Wire pickers) moved from `todo` to `doing`. (Visual diff is subtle without lanes.) |
| 22    | `e2e/e2e-11-kanban-after-lane-drag.png`   | E2E H. Swim lanes by Assignee. Post-drag lane move — task `26` reassigned from alice to bob with status→review. |
