# Timeline and Calendar views

Status: built, 2026-11-07, branch `timeline-calendar`: `start_date`
(migration `0046_task_start_date`), the start-before-due rule (T8), the
Calendar and Timeline layouts with their shared pieces, and the extras of
step 4. Where the build differs from the plan below, the plan has been
updated (look for "Built:").

## Overview

Two more task layouts beside Kanban, Grid and List, for projects that plan
by dates. Both read the same tasks the screen's filter bar selects, and both
allow a little dragging to reschedule. Neither is a scheduling tool: no
dependencies, no automatic shifting, no drawing tasks on a canvas.

- **Calendar** (`layout: calendar`): a month grid, weeks in rows. A task
  with a due date sits on that day; one with a start and a due date is a bar
  across those days, wrapping at the week's end. Milestones with a date show
  as a marker on their day. Prev / next / Today, and a Week toggle (the same
  grid, one row tall, with room for more per day).
- **Timeline** (`layout: timeline`): a row per task, a bar from start to due
  on a horizontal day axis (Week / Month / Quarter zoom), a today line, and
  the screen's GROUP picker making bands (milestone, assignee, component,
  status). A milestone band's header carries its date as a diamond on the
  axis.
- **Both:** an **Unscheduled** tray (collapsed by default) lists the
  filtered tasks with neither date; dragging one onto a day gives it that
  due date. Clicking a task opens it, like every other layout.

The two layout values are already offered by the Screens admin
(`web/src/admin/screens.ts`) and fall through to "not found" today; this
fills them in.

## Decisions

| # | Decision |
|---|---|
| T1 | `start_date` is an optional `date` on task (edge ordering 8, just before `due_date`). ISO-only and checked by `value_type = 'date'` like `due_date` — no name-specific code. |
| T2 | How a task draws: start + due → a span; due only → a point (a dot on the timeline, a chip on the calendar); start only → a point at the start, marked "no due date"; neither → the Unscheduled tray. The server never stores a start after its due date (T8), so the views have no inverted pair to draw. |
| T3 | Dragging is whole days only, and only these: **move** a span or point (both dates shift by the same number of days, so the length is kept); on the timeline, **resize** by dragging either end (one date changes); from the tray, **drop** on a day (sets `due_date`). Nothing else is drawn or edited graphically. |
| T4 | A drag writes through `attribute.update` — one per changed date, in one batch — with an optimistic patch, and the view re-reads on fault (the kanban's pattern). No new write handler. |
| T5 | Both layouts use the shared filter bar: search, Advanced filter, phase toggles, saved views. The timeline uses GROUP as its bands; the calendar ignores GROUP, so the bar hides its picker there — a new per-layout flag beside `layoutSupportsLanes` (nothing hides GROUP by layout today). |
| T6 | Milestones get a date by binding the existing `due_date` attribute to the milestone card type (a new edge, ordering 6), not a new attribute: one meaning, one date picker, one filter op. Needs a seed row + migration `0047_milestone_due_date` + count tests. Built: ordering 1, right after the title (milestone's other edges sit at 4–5, so 6 put the date last); 165 edges. A milestone has no `start_date` edge, so the pair rule never applies to one. |
| T7 | Data: the view fetches the filtered tasks that have a start or a due date (tree `exists` on either) and windows them client-side, plus the tray's undated ones (a second query, capped at 200. Built: it fetches 201 and, past 200, says it shows the 200 most recently active and to narrow the filter — `card.select_with_attributes` returns no total). Built: `exists` / `not exists` now skip a value stored as JSON null (how `attribute.update` clears one), in both compilers — before, a cleared date still counted as set, so a task whose due date was removed showed under "Due date is set". No server date-range op in this change: production has 318 tasks, 34 with a date. If projects grow past a few thousand dated tasks, add absolute `on_or_after` / `on_or_before` date ops to both compilers (`card/where.go` and `card_compile_predicate`). |
| T8 | **Decided 2026-11-07: the server refuses, on every path, a write that leaves `start_date` after `due_date`** (the same day is fine). `attribute.update` and `card.insert` answer `validation` ("the start date … is after the due date …"); the `attribute_value_date_order` trigger refuses it under every other path (stamps, compose, imports, handlers to come). A drag orders its two writes so the pair is never inverted on the way through (moving later: due first; earlier: start first). Two writers of one card's dates take turns (a row lock), so they can't each pass against the other's old date. Accepted cost: a Grid bulk "set due date" that lands before one selected task's start fails that batch, naming the dates. |
| T9 | Personal screens (`my_screen.set`, today `list` \| `grid`) also take `calendar` and `timeline`: a "my schedule" across projects is the most useful calendar there is. The project-scoped GROUP bands work there the same way. Built: a calendar or timeline screen must list tasks (a thread has no dates); `my_screen.set` refuses the pair on the values the screen ends up with, and the settings form locks Lists to Tasks for those layouts. |
| T10 | No new screens are seeded into existing projects. An admin adds a Calendar or Timeline screen in the Screens admin (or a person makes a personal one). The `tracker` bundle gains a Timeline screen, so new projects from it have one; bundles re-apply on boot, so no migration. Built: slug `timeline`, hotkey `t` (`g t`), after Recently Closed, the bundle's status flow and the Grid's phase toggles (Active on). |

## Detail

### Server

- `0046_task_start_date` (done): `start_date` attribute_def + task edge;
  seed rows; `migrate_test.go` counts (111 attribute_defs, 164 edges) and
  `TestForwardMigration0046TaskStartDate`; `strict_dates_test.go` rows.
- `0047_milestone_due_date` (T6): edge (milestone, due_date, ordering 6) in
  the seed and the migration; counts +1 edge; a forward-migration test.
- T8 (done): `date_order_problem(start, due)` is the rule, `card_date(card,
  attr)` reads a stored date. `attribute_update_batch.sql` checks the pair
  the write leaves, holding the card FOR NO KEY UPDATE (not FOR SHARE) for a
  date write so a second writer waits and re-reads; `card_insert_batch.sql`
  checks the pair it is given. The `attribute_value_date_order` AFTER
  INSERT / UPDATE trigger (row-level, so judged at the end of its statement)
  takes the same lock and refuses any inverted pair, RAISE text naming the
  card and dates. Tests: `dom/attribute/date_order_test.go`.
- The CSV import (`project_import_preview_batch.sql` /
  `project_import_commit_batch.sql`) gains a `start_date` column (today it
  takes `due_date` only), with the pair checked per row in the preview so a
  bad row is listed before the commit (the trigger would refuse it there).
- Calendar feeds (`dom/calendar/feed.go`): a task with both dates becomes a
  multi-day all-day event (`DTSTART` = start, `DTEND` = due + 1). The
  window test becomes "overlaps the window" instead of "due in the window",
  so a long task running through it is listed.
- `my_screen_set_batch.sql`: accept `calendar` / `timeline` (T9);
  `docs/PERSONAL_SCREENS.md` P7.

### Web

Both layouts are registered in `LAYOUT_TO_CONTROL`
(`web/src/shell/screen-host.ts`), get their screen-filter config from the
same seams as the others (`layoutRequiresGroup` stays kanban-only;
`layoutSupportsLanes`-style helpers say whether GROUP shows), and follow the
declarative data layer (a static `tasks` query refired on the filter bar's
version leaf, static actions with optimistic patches; no promises).

Shared, in a new `web/src/schedule/`:

- `dates.ts` — local-midnight ISO date math (add days, days between,
  week / month bounds, Sunday-start like the DatePicker); pure,
  `node --test`.
- `placement.ts` — task → `{kind: span|point|unscheduled, start, end,
  inverted}` per T2, and windowing (does it touch [from, to]); pure,
  table-driven tests.
- `reschedule.ts` — a drag result (`move` Δdays / `resizeStart` /
  `resizeEnd` / `drop` day) → the ordered `attribute.update` writes and the
  optimistic patch (T3, T4, T8's ordering); pure, table-driven tests.
- `unscheduled-tray.ts` — the collapsible tray, draggable rows.
- `day-drag.ts` — pointer drag snapped to day cells or day columns, with a
  ghost and a date tooltip ("Tue Nov 18 → Thu Nov 20"); Esc cancels. Built:
  Pointer Events throughout (the timeline's resize needs them), not the
  Kanban's native drag-and-drop; a click that never became a drag still opens
  the task.
- Built: `schedule-data.ts` — the query and action tables both views spread
  into their `static queries` / `static actions` under their own tree prefix,
  the dated / undated filter trees, the optimistic patches, and the lookups
  (statuses, persons, milestones, components, tags). Only a drag's FIRST write
  carries the optimistic patch (of the whole new pair): two snapshots of one
  leaf can't roll back in order, so on any fault the view re-reads instead.
- Built: `schedule-view.ts` — the base class of both controls: the filter /
  scope watchers, result sinks, status glyphs, the tray, open-task with
  prev / next order, and drag → plan → intents.

Calendar (`web/src/calendar/`, ~800 lines with tests):

- Month grid of 6 week rows; each week lays out its spans into lanes
  (greedy, longest first), then points; "+N more" opens a day popover when a
  day overflows. Week mode is the same layout with one row and taller cells.
- Header: month title, prev / next / Today, Month | Week. The shown month
  rides in the URL query (`?month=2026-11`; a week is `?view=week&week=
  2026-11-08`) so it survives reloads and links. Built: `readQueryParam` /
  `writeQueryParams` in `shell/router.ts` (a `replaceState`, so stepping
  months doesn't fill the back button).
- Drag: move only (T3); drop on a day from the tray.
- Keyboard: arrows move the focused day, Enter opens its first task, `t`
  jumps to today. Built: PageUp / PageDown step a month (a week).

Timeline (`web/src/timeline/`, ~1,200 lines with tests):

- A left column (title, status icon, assignee avatar; the relation icon for
  subtasks) and the axis on the right, both in one `virtualList` of fixed-
  height rows so long projects scroll smoothly; the axis header and today
  line stay pinned.
- Zoom Week / Month / Quarter changes the day width (44 / 18 / 6 px); the
  zoom and the left edge ride in the URL query (`?zoom=month&at=2026-11-01`).
  Built: the axis covers every drawn task with a margin and a window around
  today, starting on a Sunday; it grows as tasks land without moving the
  view. Horizontal scroll by wheel + Shift, drag on the
  empty axis, or the header's ‹ › buttons.
- Bands from GROUP (T5), sorted by the axis's own order (milestones by their
  date, then title); an `(unset)` band last. Collapsible.
- Drag: move, resize either end, drop from the tray (T3).
- Keyboard: with a row focused, Alt + ← / → moves it a day (Shift: a week) —
  the same writes as a drag — so nothing needs a mouse. Built: ↑ / ↓ (j / k)
  move a row cursor, Enter opens the task or folds a band, `t` scrolls to
  today.

### Help and docs

- `server/internal/dom/help/content/layout_calendar.md` and
  `layout_timeline.md` (the `?` overlay keys on `layout.<layout>`), and a
  line in `task_detail.md` and `my_screens.md`.
- README's feature list; `docs/MAIL_INTAKE_AND_CALENDARS.md` §8 for the
  multi-day feed events.

## Build order

1. **Shared pieces** — `dates.ts`, `placement.ts`, `reschedule.ts` with
   their tests (the server pair check, T8, is done). (~2 days)
2. **Calendar** — month + week, filter bar, tray, move-drag, keyboard, help.
   It is the smaller view and proves the shared pieces. (~3 days)
3. **Timeline** — rows, axis, zoom, bands, move + resize, tray, keyboard,
   help. (~4–5 days)
4. **Around them** — milestone dates (T6), multi-day calendar feed events,
   the import's `start_date` column, personal screens (T9), the tracker
   bundle's Timeline screen (T10), demo data with dates in `demo.hcsv`. (~2–3
   days)

About two and a half weeks in all. Each step ships on its own: after step 2
a project can already use a Calendar screen.

## Not in this change

- Dependencies between tasks (`depends_on`, arrows, conflict warnings) and
  any automatic rescheduling.
- Creating a task by drawing on the axis (a "+" on a day opening the
  new-task form with the date filled in is a small follow-up, if wanted).
- Working days, holidays, time of day, or durations other than whole days.
- Server-side date-range ops (T7) until a project needs them.

## Tests

- Go: the migration tests and counts above; the pair check (T8) in
  `date_order_test.go` (done); the feed's multi-day event and overlap window in
  `calendar_test.go`; `my_screen.set` taking the two layouts.
- Web (`node --test`): `dates`, `placement`, `reschedule` as tables
  (`describe.each` / `it.each` style); the calendar's week lane layout; the
  timeline's band order and drag-to-writes; both layouts mount through
  `ScreenHost` from a screen card. Built: `test/schedule.test.mjs` (the pure
  pieces) and `test/schedule-views.test.mjs` (both controls against a fake
  batch server: the reads, the drawing, the write order in one batch, the
  rollback and re-read on a refusal, a tray drop, the URL month, bands and
  Alt+→).
- By hand against a local kitpd with demo data: drag in both views, the
  tray, a drag refused by the pair rule (its rollback), a personal Timeline across two projects, and the
  feed in a calendar app.
