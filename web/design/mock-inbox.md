# Mock — Inbox / List (`layout: list`) and Grid / Table (`layout: grid`)

Both are flat task lists over the same task batch. They share the
FilterBar, the row TransitionBar, the selection model, and `n` quick-
create. Inbox adds personal drag-reorder; Grid adds sortable columns + bulk
selection. The `list` layout is also reused for Comms (slug=`comms`) by
swapping the row renderer.

---

## Shared ScreenFilterBar (inbox + grid + kanban)

Both screens (and kanban) render the same rich `ScreenFilterBar`. It is far
bigger than a quick-filter chip strip — it carries the saved view, named
filter, grouping, search, and the per-attribute filter Pickers:

```
                                                        [ New task ]   ← action sits ABOVE the bar (top-right of body)
 ⤓  View:[ Default Inbox ▾ ]  NAMED [ (none) ▾ ]  GROUP [ (no grouping) ▾ ] ⋮   [🔍 Search tasks…]   in:[ Title ▾ ]
 [Status▾] [Assignee▾] [Originator▾] [Milestone▾] [Component▾] [Tags▾]
 [+ Add filter] [Advanced] [Clear]                          24 rows / N open tasks   ☐ Show closed status
```
- **⤓ export** IconButton · **View** Picker (saved screen view, e.g. "Default
  Inbox" / "Default Grid" / "Default Kanban") · **NAMED** filter Picker ·
  **GROUP** Picker (group-by) · **⋮ kebab** · **Search tasks…** Field · **in:
  [Title ▾]** scope Picker (which field the search matches).
- Second row: one **filter Picker per attribute** (Status, Assignee,
  Originator, Milestone, Component, Tags), then **+ Add filter** /
  **Advanced** / **Clear**. The row count / open-task count and a
  **Show closed status** Checkbox sit at the right.
- The old "QUICK FILTERS [Todo][Doing][Review][Done][Mine]" chip strip and a
  separate "Saved filters ▾" are GONE — superseded by the View/NAMED/per-attr
  model above.

## Inbox — overall layout & regions

```
┌──────────┬────────────────────────────────────────────────────────────────┐
│ kitp  ‹  │ [Default Project ▾] / Inbox                       ☾  ▥  ?        │  ← shell topbar
│ rail     ├────────────────────────────────────────────────────────────────┤
│ Projects │                                                    [ New task ]  │  ← action button (top-right of body)
│ Activity │ ⤓ View:[Default Inbox▾] NAMED[(none)▾] GROUP[(no grouping)▾] ⋮    │  ← ScreenFilterBar (see above)
│ DEFAULT  │   [🔍 Search tasks…]                                  in:[Title▾]│
│ PROJECT  │ [Status▾][Assignee▾][Originator▾][Milestone▾][Component▾][Tags▾]  │
│ Inbox gi │ [+ Add filter][Advanced][Clear]      N open tasks ☐ Show closed  │
│ Grid  gg ├────────────────────────────────────────────────────────────────┤
│ Kanban gk│ ⋮⋮ #18 Wire pickers (dense#1)                                    │  ← row (selected: accent ring + bg-surface)
│ Project  │     [Todo] ◐alice  milestone:M1  component:Frontend priority/high│
│  detail  │ ⋮⋮ #19 API rate limits                                           │
│          │     [Todo] ◐alice  milestone:M1  component:Backend priority/high │
│ ADMIN    │ ⋮⋮ #25 Theme tokens                                              │
│          │     [Todo] ◐alice  milestone:M2  component:Frontend priority/high│
│ ⊙ System▾│ …                                                                │
└──────────┴────────────────────────────────────────────────────────────────┘
```

The inbox is **personal**: it shows only tasks assigned to the signed-in
user. In the demo the signed-in account is the **System** user, who owns no
tasks, so the inbox renders its empty state (see States) even though the
project has 24 tasks. The "[Mine] / [All open]" segmented toggle described
below is part of the design intent but is NOT a distinct control in the
current build — scope comes from the View + per-attribute filters.

### Row anatomy (the `TaskRow` use of `Card`)
```
┌─────────────────────────────────────────────────────────────────────┐
│ ⋮⋮  #18  Wire pickers (dense#1)                       [⟳ Status ▾]    │  ← grip · id · title · row TransitionBar (hover)
│      [Todo]  ◐ alice   milestone:M1  component:Frontend  priority/high│  ← status pill · assignee · attribute chips
└─────────────────────────────────────────────────────────────────────┘
```
- `⋮⋮` DragHandle for personal reorder.
- Status pill is tone-coded by phase (triage muted / active accent /
  terminal success).
- Attribute chips render whatever ref/enum attrs the schema marks for the
  row summary.
- On hover/focus the compact `TransitionBar` appears at the right.

### THE drag-reorder interaction
```
   GRAB                      IN FLIGHT                    DROP
 ⋮⋮ #18  ───────►   ░░ drop line ░░          ►   ⋮⋮ #19   (now first)
 ⋮⋮ #19             ▓ #18 (lifted) ▓              ⋮⋮ #18   ← reordered
 ⋮⋮ #25             ⋮⋮ #25                        ⋮⋮ #25
```
- Drag a row to a new slot → ONE `user_card_sort.set` with the computed
  order. Optimistic: row moves immediately (FLIP); snap-back + toast on
  error.
- Keyboard: Shift+`j` / Shift+`k` reorder the selected row (same path).
- Rows the user has personally ordered carry a brighter leading indicator
  vs. server-default order (muted indicator).

### Mine / All-open scope (design intent)
Scope to "mine" is achieved via the personal inbox view + the Assignee
filter Picker; there is no separate segmented Mine/All control in the
current build. (The earlier mock's `[Mine][All open]` segmented toggle is
retained here only as design intent.)

---

## Grid / Table — overall layout & regions

There is no separate "Grid — N rows" header band; the breadcrumb
(`/ Grid`) is the only title, the **+ New issue** action floats at the
top-right of the body (just above the filter chips), and the row count
("24 rows") lives in the ScreenFilterBar. Observed columns in the demo
screen: **ID · Title · Assignee · Priority · Milestone · Component · Tags ·
Due Date · Created · Last activity** (horizontally scrollable).

```
┌──────────┬──────────────────────────────────────────────────────────────────┐
│ kitp  ‹  │ [Default Project ▾] / Grid                       ☾  ▥  ?          │  ← shell topbar
│ rail     ├──────────────────────────────────────────────────────────────────┤
│          │ ⤓ View:[Default Grid▾] NAMED[(none)▾] GROUP[(no grouping)▾] ⋮      │  ← ScreenFilterBar row 1
│          │   [🔍 Search tasks…]                                    in:[Title▾]│
│          │ [Status▾][Assignee▾][Originator▾][Milestone▾][Component▾][Tags▾]    │  ← row 2 (per-attr Pickers)
│          │ [+ Add filter][Advanced][Clear]      24 rows   [ + New issue ]      │
│          ├──┬─────┬──────────────┬──────────┬─────────┬───────────┬──────────┤
│          │☐ │ ID  │ Title        │ Assignee▽│ Priority│ Milestone▽│ Compon.▽ … │  ← header row (sortable ▽, sticky)
│          ├──┼─────┼──────────────┼──────────┼─────────┼───────────┼──────────┤
│          │☐ │ #54 │ Wire pickers │ alice    │ [high]  │ M1        │ Frontend  │
│          │☑ │ #55 │ API rate lim │ alice    │ [high]  │ M1        │ Backend   │  ← row selected (Space toggles ☑)
│          │☐ │ #56 │ Empty state… │ bob      │ [med]   │ M1        │ Frontend  │
│          │ …                                                                  │
└──────────┴──────────────────────────────────────────────────────────────────┘
```

- **Sortable headers** — a `▽` glyph marks sortable columns (ID and Title
  are not sortable in the demo; Assignee / Milestone / Component carry the
  ▽). Click to sort; server reissues the order via one batch. Arrow flips
  ▽/△; only one active sort column.
- **Priority** renders as a tone pill (`[high]` / `[med]` / `[low]`); empty
  attrs show an em-dash `—`.
- **Column config** comes from the screen card (which columns, order) — the
  table renders attribute columns declaratively.
- **Per-column filter** — the per-attribute filtering is driven by the
  ScreenFilterBar Pickers (row 2), not an in-header dropdown.
- **Row select** — `j`/`k` moves the active row (accent ring). The leading
  **Checkbox** column (with a header select-all box) toggles multi-selection.
- **Bulk action bar** appears when ≥1 row is checked:
```
┌─────────────────────────────────────────────────────────────────────┐
│ 3 selected   [ Move… ]  [ Purge… ]                       [ Clear ]    │  ← BulkActionBar (sticky bottom)
└─────────────────────────────────────────────────────────────────────┘
```
  "Move…" → BulkMoveDialog (pick target project/parent). "Purge…" →
  BulkPurgeDialog (type-to-confirm). Both issue a batch over the selected
  ids.
- **Export menu** in the header (CSV / JSON of the current filtered set).

---

## States (both Inbox and Grid)

**Loading (cold)** — centered Spinner (full body).

**Loading (refresh)** — list/table stays visible, small Spinner in header
trailing slot; no blanking.

**Empty (no rows)** — observed inbox copy is a centered two-line EmptyState
(no action button when nothing is assigned):
```
│                                                          │
│                  Your inbox is clear.                    │  ← title (bold)
│           Nothing assigned to you right now.             │  ← description (muted)
│                                                          │
```
Grid / filtered-empty variant: "No tasks match this filter" + a
[ Clear filter ] action when a filter is active.

**Error** — inline danger-soft alert spanning the body with [Retry].

**Selected row** — accent ring + `--color-surface` background.
**Checked rows (grid)** — checkbox ☑ + subtle accent-soft row tint.
**Drag in flight (inbox)** — lifted row + accent insertion line at the drop
slot.

## Common controls used
`AppShell`, `Button` (New task / + New issue), `ScreenFilterBar` (two
`Toolbar` rows: View/NAMED/GROUP/search/scope + export `IconButton` & kebab,
then a per-attribute filter-`Picker` row with + Add filter / Advanced /
Clear + the `Show closed status` `Checkbox`), `Collection` (the list/table
body), `Card`→`TaskRow` (inbox) or table-row (grid), `DragHandle` +
`DropZone` (inbox reorder), `Chip` (status pill + priority/attribute chips),
compact `TransitionBar`/status-`Picker` (per row), `Checkbox` (grid select +
select-all header), `Toolbar`→`BulkActionBar`, `ConfirmDialog`/`Dialog`
(bulk move/purge), `Spinner`, `EmptyState`, `Alert`, `QuickEntryOverlay`,
`Toast`.
