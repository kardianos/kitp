# Mock — Kanban board (`layout: kanban`)

Route: `/project/:id/screen/:slug` where the screen card's `layout` is
`kanban`. The board reads its axes from the active filter card:
`column_attr` and `group_by_attr` (lane axis, default none). In the current
demo the screen's default `column_attr` is **`milestone`**, not `status`
— the "Columns by" Picker re-keys the board live to any groupable
attribute (Status, Milestone, Component, Assignee…). Status is just one of
the options. See REFRESH-NOTES.md.

## Overall layout & regions

```
┌──────────┬───────────────────────────────────────────────────────────────────────┐
│ kitp  ‹  │ [Default Project ▾]  / Kanban                          ☾  ▥  ?          │  ← AppShell topbar (region: shell.topbar)
├──────────┼───────────────────────────────────────────────────────────────────────┤
│ Projects │  Columns by:[ Milestone ▾ ]      Swim lanes by:[ (none) ▾ ]            │  ← board axes header (region: board.axes)
│ Activity │                                                                         │
│··········│  ⤓  View:[ Default Kanban ▾ ]  NAMED [ (none) ▾ ]  GROUP [(no group)▾] ⋮│  ← ScreenFilterBar row 1 (region: board.filter)
│ DEFAULT  │     [🔍 Search tasks…]                                        in:[Title▾]│     export · saved view · named filter · group · kebab · search · scope
│ PROJECT  │  [Status▾][Assignee▾][Originator▾][Milestone▾][Component▾][Tags▾]        │  ← ScreenFilterBar row 2: per-attr filter Pickers
│ Inbox  gi│   [+ Add filter] [Advanced] [Clear]              ☐ Show closed status   │     + add/advanced/clear · closed-status toggle · "24 tasks" count
│ Grid   gg├───────────────────────────────────────────────────────────────────────┤
│ Kanban gk│ ┌─ M1  7  + ──┐ ┌─ M2  8  + ─┐ ┌─ M3  4  + ─┐ ┌─ (unset)  5  + ─┐       │  ← columns (region: board.columns)
│ Project  │ │ ▣ card       │ │ ▣ card     │ │ ▣ card     │ │ ▣ card           │       │
│  detail  │ │ ▣ card       │ │ ▣ card     │ │ ▣ card     │ │ ▣ card           │       │
│          │ │ ▣ card       │ │ ▣ card     │ │ ▣ card     │ │ …                │       │
│ ADMIN    │ │ …            │ │ …          │ │            │ │                  │       │
│ Users…   │ └──────────────┘ └────────────┘ └────────────┘ └──────────────────┘      │  → horizontal scroll if columns overflow
│          │                                                                         │
│ ⊙ System▾│                                                                         │  ← user chip (bottom of rail)
└──────────┴───────────────────────────────────────────────────────────────────────┘
```

### Shell topbar (region: shell.topbar)
- Left: brand **kitp** + a rail **collapse chevron** `‹`.
- Center: a **project-scope Picker** (`[Default Project ▾]` / `[All projects ▾]`)
  + a breadcrumb crumb for the current screen (`/ Kanban`).
- Right cluster: **theme toggle** `☾`/`☀` (writes `data-theme` on `<html>`),
  a **right-rail/panel toggle** `▥`, and the **help** `?` (opens the
  keyboard-shortcut overlay).

### Left rail (region: shell.rail)
Top: global links **Projects** (`g p`), **Activity** (`g a`) with the chord
hint shown right-aligned and muted. Then a **DEFAULT PROJECT** section (the
in-scope project's screens: **Inbox** `g i`, **Grid** `g g`, **Kanban**
`g k`, **Project detail**). Then an **ADMIN** section. The rail foot is a
**user chip** (avatar + name + a `▾` account menu). Collapses to icon-width
via the topbar chevron.

Columns are derived from the `column_attr`'s value cards (so an empty
project still shows every known column), plus any extra keys seen on tasks,
plus a trailing **`(unset)`** bucket. The column header label is
`labelFor(column_attr, columnKey)` and the DOM key (`data-column`) is the
underlying **value-card id** (e.g. a milestone card id) — NOT a literal enum
string like `todo`. With `column_attr = status` the labels read New idea /
Todo / Doing / Review / Done; the keys are still the status value-card ids.
Lanes work the same way when `group_by_attr` is set.

## A single column (region: board.column)

```
┌─ M1                                7   + ┐   ← header: label · count · quick-add (+)
├──────────────────────────────────────────┤
│ ░░░░░░░░░░ drop zone (top, slot 0) ░░░░░░ │
│ ┌────────────────────────────────────┐   │
│ │ ⋮⋮  Wire pickers (dense#1)         │   │   ← Card (selected: 2px accent ring)
│ │     #54 · alice  priority/high     │   │       grip(⋮⋮ vertical) | title | meta
│ └────────────────────────────────────┘   │
│ ░░░░░░░ drop zone (after #54) ░░░░░░░░░░░ │
│ ┌────────────────────────────────────┐   │
│ │ ⋮⋮  API rate limits                │   │
│ │     #55 · alice  priority/high      │   │
│ │     area/backend                    │   │
│ └────────────────────────────────────┘   │
│ ░░░░░░░ drop zone (after #55) ░░░░░░░░░░░ │
└──────────────────────────────────────────┘
```

Card anatomy (built from the `Card` common control), as currently rendered:
- **Drag grip** `⋮⋮` (DragHandle) — left edge, vertical dot pair, muted,
  `cursor: grab`.
- **Title** — truncated, `--text-sm`, `--weight-medium`.
- **Meta row** — `#<id>` (muted) · `· assignee` · tag/attr chips
  (`priority/high`, `area/backend`, `team/growth` …), `--text-xs`, wraps to
  a second line when long.
- Selected/focused card: `box-shadow: inset 0 0 0 2px var(--color-accent)`
  (observed on the first todo card as a 2px accent ring).
- Card surface uses `bg-surface` inside a `border-border` column shell.

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

**Loading (refresh, tasks already shown)** — board stays, small Spinner near
the filter-bar task count (`24 tasks ◌`); columns are not blanked. The count
lives in the ScreenFilterBar (row 2), not a separate header trailing slot.

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
`AppShell` (topbar + rail + user chip), `Toolbar` (board axes header),
`Picker` ×2 (Columns by / Swim lanes by) + the project-scope Picker,
`ScreenFilterBar` (= two `Toolbar` rows: a saved-view/named-filter/group/
search/scope row with an export `IconButton` + kebab, and a per-attribute
`Picker` filter-chip row with `+ Add filter` / `Advanced` / `Clear` and the
`Show closed status` `Checkbox`), `Column` ×N, `Card` ×N, `DragHandle` +
`DropZone`, `Chip` (tags/attr summary), `IconButton` (theme toggle / rail
collapse / panel toggle / help / export), `Spinner`, `EmptyState`, `Alert`,
`QuickEntryOverlay` (= `Popover` + `Form`), `Toast`.
