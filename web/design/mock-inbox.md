# Mock — Inbox / List (`layout: list`) and Grid / Table (`layout: grid`)

Both are flat task lists over the same task batch. They share the
FilterBar, the row TransitionBar, the selection model, and `n` quick-
create. Inbox adds personal drag-reorder; Grid adds sortable columns + bulk
selection. The `list` layout is also reused for Comms (slug=`comms`) by
swapping the row renderer.

---

## Inbox — overall layout & regions

```
┌──────────┬────────────────────────────────────────────────────────────────┐
│ shell    │ Inbox — 6 open tasks   [Mine][All open]              [New task]  │  ← header (region: list.header)
│ rail     ├────────────────────────────────────────────────────────────────┤
│          │ QUICK FILTERS [Todo][Doing][Review][Done][Mine]                  │  ← ScreenFilterBar
│          │ [+ Add filter] [Advanced] [Saved filters ▾]                      │
│          ├────────────────────────────────────────────────────────────────┤
│          │ ⋮⋮ #18 Wire pickers (dense#1)                                    │  ← row (selected: accent ring + bg-surface)
│          │     [Todo] ◐alice  milestone:M1  component:Frontend priority/high│
│          │ ⋮⋮ #19 API rate limits                                           │
│          │     [Todo] ◐alice  milestone:M1  component:Backend priority/high │
│          │ ⋮⋮ #25 Theme tokens                                              │
│          │     [Todo] ◐alice  milestone:M2  component:Frontend priority/high│
│          │ ⋮⋮ #26 Activity feed pagination                                  │
│          │     [Doing]◐alice  milestone:M1  component:Backend  priority/high│
│          │ …                                                                │
└──────────┴────────────────────────────────────────────────────────────────┘
```

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

### Mine / All-open toggle
Segmented control in the header; flips the predicate's assignee clause and
refetches. The "Mine" quick-chip is the same toggle exposed in the chip row.

---

## Grid / Table — overall layout & regions

```
┌──────────┬────────────────────────────────────────────────────────────────┐
│ shell    │ Grid                                                  25 rows    │  ← header
│ rail     ├────────────────────────────────────────────────────────────────┤
│          │ QUICK FILTERS [Todo][Doing][Review][Done][Mine]                  │  ← ScreenFilterBar
│          │ [Status in (Todo,Doing,Review,Done) ✕] [+ Add filter] … [Clear]  │
│          ├──┬─────┬──────────────────┬────────┬──────────┬─────────┬───────┤
│          │☐ │ ID  │ Title            │ Status▽│ Assignee▽│ Priority│ Mile… │  ← header row (sortable ▽, sticky)
│          ├──┼─────┼──────────────────┼────────┼──────────┼─────────┼───────┤
│          │☐ │ #18 │ Wire pickers     │ Todo   │ alice    │ high    │ M1    │
│          │☑ │ #19 │ API rate limits  │ Todo   │ alice    │ high    │ M1    │  ← row selected (Space toggles ☑)
│          │☐ │ #20 │ Empty state copy │ Todo   │ bob      │ med     │ M1    │
│          │ …                                                                │
└──────────┴────────────────────────────────────────────────────────────────┘
```

- **Sortable headers** — click a `▽` to sort; server reissues the order via
  one batch. The arrow flips ▽/△; only one active sort column.
- **Column config** comes from the screen card (which columns, order) — the
  table renders attribute columns declaratively.
- **Row select** — `j`/`k` moves the active row (accent ring). **Space**
  toggles the checkbox into a multi-selection.
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

**Empty (no rows)**:
```
│                                                          │
│                  Your inbox is clear.                    │  ← EmptyState
│            ( or: No tasks match this filter )            │
│                    [ Clear filter ]                      │
│                                                          │
```

**Error** — inline danger-soft alert spanning the body with [Retry].

**Selected row** — accent ring + `--color-surface` background.
**Checked rows (grid)** — checkbox ☑ + subtle accent-soft row tint.
**Drag in flight (inbox)** — lifted row + accent insertion line at the drop
slot.

## Common controls used
`AppShell`, segmented toggle (Mine/All), `Button` (New task / Export),
`ScreenFilterBar` (`Toolbar` + `Chip` row + preset `Picker`), `Collection`
(the list/table body), `Card`→`TaskRow` (inbox) or table-row (grid),
`DragHandle` + `DropZone` (inbox reorder), `Chip` (status pill + attribute
chips), compact `TransitionBar` (per row), `Checkbox` (grid select),
`Toolbar`→`BulkActionBar`, `ConfirmDialog`/`Dialog` (bulk move/purge),
`Spinner`, `EmptyState`, `Alert`, `QuickEntryOverlay`, `Toast`.
