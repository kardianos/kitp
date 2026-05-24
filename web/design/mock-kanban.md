# Mock — Kanban board (`layout: kanban`)

Route: `/project/:id/screen/:slug` where the screen card's `layout` is
`kanban`. The board reads its axes from the active filter card:
`column_attr` (default `status`) and `group_by_attr` (lane axis, default
none).

## Overall layout & regions

```
┌───────────────────────────────────────────────────────────────────────────┐
│ [Project ▾]   Kanban / <project>                                      [?]   │  ← AppShell topbar (region: shell)
├──────────┬────────────────────────────────────────────────────────────────┤
│ PROJECT  │  Kanban  Columns by:[ Status ▾ ]  Swim lanes by:[ (none) ▾ ]    │  ← board header (region: board.header)
│ [picker] │                                                  25 tasks  ◌     │     trailing: count + spinner-while-loading
│          ├────────────────────────────────────────────────────────────────┤
│ Projects │ QUICK FILTERS [Todo][Doing][Review][Done]                       │  ← ScreenFilterBar (region: board.filter)
│ Inbox    │ [+ Add filter] [Advanced] [Saved filters ▾]                     │
│ Grid     ├────────────────────────────────────────────────────────────────┤
│ Kanban   │ ┌─ Todo  8  + ─┐ ┌─ Doing 6 + ─┐ ┌─ Review 5 + ┐ ┌─ Done 6 + ┐ │  ← columns (region: board.columns)
│ Activity │ │ ▣ card        │ │ ▣ card       │ │ ▣ card      │ │ ▣ card    │ │
│          │ │ ▣ card        │ │ ▣ card       │ │ ▣ card      │ │ ▣ card    │ │
│ ADMIN    │ │ ▣ card        │ │ ▣ card       │ │ ▣ card      │ │           │ │
│ Users    │ │ …             │ │ …            │ │ …           │ │           │ │
│ Attrs…   │ └───────────────┘ └──────────────┘ └─────────────┘ └───────────┘ │  → horizontal scroll if columns overflow
│          │                                                                  │
│ • Dev    │                                                                  │
└──────────┴────────────────────────────────────────────────────────────────┘
```

Columns are derived from the `column_attr`'s option list (so an empty
project still shows every known column), plus any extra keys seen on tasks,
plus a trailing `(unset)` bucket. Same for lanes when `group_by_attr` is set.

## A single column (region: board.column)

```
┌─ Todo                              8   + ┐   ← header: label · count · quick-add (+)
├──────────────────────────────────────────┤
│ ░░░░░░░░░░ drop zone (top, slot 0) ░░░░░░ │
│ ┌────────────────────────────────────┐   │
│ │ ⋮⋮  Wire pickers (dense#1)         │   │   ← Card (selected: 2px accent ring)
│ │     #18 · alice  priority/high     │   │       grip | title | meta(#id·assignee·tags)
│ └────────────────────────────────────┘   │
│ ░░░░░░░ drop zone (after #18) ░░░░░░░░░░░ │
│ ┌────────────────────────────────────┐   │
│ │ ⋮⋮  API rate limits                │   │
│ │     #19 · alice  priority/high      │   │
│ │     area/backend                    │   │
│ └────────────────────────────────────┘   │
│ ░░░░░░░ drop zone (after #19) ░░░░░░░░░░░ │
└──────────────────────────────────────────┘
```

Card anatomy (built from the `Card` common control):
- **Drag grip** `⋮⋮` (DragHandle) — left edge, `cursor: grab`.
- **Title** — truncated, `--text-sm`, `--weight-medium`.
- **Meta row** — `#<id>` (mono, muted) · assignee · tag pills, `--text-xs`.
- Selected/focused card: `box-shadow: inset 0 0 0 2px var(--color-accent)`.

## 2-D mode (swim lanes active)

```
┌ Assignee: alice ─────────────────────────────────────────────┐  ← sticky lane header
│ ┌─ Todo ──┐ ┌─ Doing ─┐ ┌─ Review ┐ ┌─ Done ─┐               │
│ │ cards…  │ │ cards…  │ │ cards…  │ │ cards… │   (cap ~28rem, │
│ └─────────┘ └─────────┘ └─────────┘ └────────┘    scrolls)    │
├ Assignee: bob ───────────────────────────────────────────────┤
│ ┌─ Todo ──┐ ┌─ Doing ─┐ ┌─ Review ┐ ┌─ Done ─┐               │
│ │ cards…  │ │ cards…  │ │ cards…  │ │ cards… │               │
│ └─────────┘ └─────────┘ └─────────┘ └────────┘               │
└───────────────────────────────────────────────────────────────┘
```

In 1-D mode each column is `flex: 1` and scrolls independently (fills the
viewport). In 2-D mode the outer area scrolls and each cell caps height
(~28rem) so a tall column doesn't shove the next lane off-screen.

## THE drag-between-columns interaction (step-by-step)

```
   GRAB (pointerdown on ⋮⋮)        IN FLIGHT                     DROP
 ┌─ Doing ─────────┐          ┌─ Doing ──┐ ┌─ Review ─┐    ┌─ Review ──────┐
 │ ┌────────────┐  │          │          │ │░░░░░░░░░░│    │ ┌───────────┐ │
 │ │⋮⋮ #26 card │  │  ───►    │  (gap    │ │ ▓ #26 ▓  │ ►  │ │ #34 card  │ │
 │ └────────────┘  │          │  where   │ │░ drop ░░░│    │ ├───────────┤ │
 │ ┌────────────┐  │          │  #26 was)│ │ ┌──────┐ │    │ │ #26 card  │ │ ← lands here
 │ │⋮⋮ #27 card │  │          │ ┌──────┐ │ │ │ #35  │ │    │ ├───────────┤ │
 │ └────────────┘  │          │ │ #27  │ │ │ └──────┘ │    │ │ #35 card  │ │
 └─────────────────┘          └──────────┘ └──────────┘    └───────────────┘
                                            ▲ active drop
                                            zone highlights
                                            (accent-soft fill)
```

Mechanics the framework must implement:
1. **Drag preview** follows the cursor (label = card title), `--shadow-drag`.
2. Each gap between cards (and the column top + empty body) is a **drop
   zone** with `--space-6` padding so targets are easy to hit. The hovered
   zone fills with `--color-accent-soft` and shows a 2px accent insertion
   line.
3. On drop the framework computes a new `sort_order` halfway between the
   neighbours and issues **ONE batch** combining: `sort_order` rewrite +
   `column_attr` update + (if lanes) `group_by_attr` update.
4. **Optimistic:** the card moves immediately (FLIP animation,
   `--duration-flip`); on error it snaps back and a `Toast` shows
   `Move failed: <reason>`. If a refresh landed mid-flight, re-refresh
   instead of restoring the stale snapshot.
5. Keyboard equivalent: Shift+`h`/`l` moves the focused card across
   columns, Shift+`j`/`k` within the column — same code path, same batch.

## Quick-add per column (the `+` button)

Clicking a column header `+` opens the **QuickEntryOverlay** prefilled so
the new card lands in exactly that (column, lane) cell:

```
            ┌──────────────────────────────────────────┐
            │ New task            → Todo                │  ← prefill chip shows target cell
            │ ┌──────────────────────────────────────┐ │
            │ │ Title…                                │ │  ← autofocus
            │ └──────────────────────────────────────┘ │
            │ Assignee [ ▾ ]   Tags [ ▾ ]               │
            │ Enter = add another · Ctrl+Enter = add &  │
            │ close · Esc = cancel                      │
            └──────────────────────────────────────────┘
```

`n` opens the same overlay prefilled from the *focused* cell.

## States

**Loading (cold, no cached tasks)** — full-area centered Spinner:
```
│                          ◌  (lg spinner)                          │
```

**Loading (refresh, tasks already shown)** — board stays, small Spinner in
the header trailing slot next to the task count; columns are not blanked.

**Empty (no tasks match filter)** — columns still render (from schema
options) but each body shows the shared empty placeholder; if a filter is
active the placeholder offers "Clear filter":
```
┌─ Todo            0   + ┐
│                        │
│      No tasks          │
│   [ Clear filter ]     │
│                        │
└────────────────────────┘
```

**Error (batch failed)** — inline alert spanning the board area, with Retry:
```
┌───────────────────────────────────────────────────────────────┐
│ ⚠ Failed to load kanban: <reason>            [ Retry ]          │  ← danger-soft bg, danger border
└───────────────────────────────────────────────────────────────┘
```

**Selected/focused card** — accent ring (see card anatomy). Exactly one
card is "focused" for keyboard nav; focus follows click and arrow keys.

**Per-cell drop-target (drag hover)** — accent-soft fill + insertion line.

## Common controls used (proves de-dup — see controls-and-rules.md)
`AppShell`, `Toolbar` (board header), `Picker` ×2 (Columns by / Swim lanes
by), `ScreenFilterBar` (= `Toolbar` + `Chip` row + `Picker` presets),
`Column` ×N, `Card` ×N, `DragHandle` + `DropZone`, `Chip` (tags/quick-
filters), `Spinner`, `EmptyState`, `Alert`, `QuickEntryOverlay`
(= `Popover` + `Form`), `Toast`.
