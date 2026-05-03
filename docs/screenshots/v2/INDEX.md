# v2 batch — visual proof

Captured by `client/tool/screenshot_v2.dart` against a freshly seeded
local dev stack (`make db-reset && make run`). Each task has at least
one shot of the feature itself; navigation is implicit from the top-nav
bar visible in every screen.

| File | Proves |
| ---- | ------ |
| `t1-projects-list-with-fab.png` | Projects list + bottom-right FAB to open the create dialog. |
| `t1-new-project-dialog.png` | T1: enlarged "New project" modal with **Title + Description** fields; no assignee picker (defaults to unassigned). |
| `t1-new-task-dialog.png` | T1: same modal shape inside a project ("New task"). |
| `t2-grid-filter-bar.png` | T2: pillboxes show **value only** (no `label:` prefix). FilterBar with `Status in (todo, doing, review, done)` chip + `+ Filter` + `Advanced` toggle. F1 grid bug fixed (rows render). |
| `t3-inbox-drag-handles.png` | T3: explicit drag-handle icon on every inbox row. F4: FilterBar mounted above the list. |
| `t4-kanban-drag-handles-fullheight.png` | T4: drag handle in each card's title row. F4: FilterBar in the toolbar. F6: columns now stretch the full viewport height. |
| `t5-shell-with-admin-dropdown.png` | F2: the **Admin** entry is visible in the top nav even in dev mode (was hidden before). Click it to reach Users & Roles or Attributes & Values. |
| `t5-admin-attributes-list.png` | T5: admin screen at `/admin/attributes`. Master list of every `attribute_def` (built-in + custom). |
| `t5-admin-attributes-tags-detail.png` | T5 + F3: detail pane for `milestone_ref` shows bound card-types (`task`), the bind picker, the **Value cards (milestone)** section with M1/M2 and an **+ New milestone** affordance, plus per-value Active toggle and delete. |
| `t6-task-detail-activity-collapsed.png` | T6: task detail with **Activity (9)** as a collapsed `ExpansionTile` (chevron visible) above the comment composer. |
| `t6-global-activity-view.png` | T6: new `/activity` route showing cross-card activity (linked card titles, attribute changes rendered as `∅ → value`, comment bodies inline). The "Activity" nav entry is highlighted. |

## How to regenerate

```
# In one terminal:
make db-reset
make run
# In another:
/home/d/bin/chromedriver --port=9515 &
cd client && /home/d/bin/dart run tool/screenshot_v2.dart \
    --api http://127.0.0.1:18080 \
    --web http://127.0.0.1:18080 \
    --out ../docs/screenshots/v2
```
