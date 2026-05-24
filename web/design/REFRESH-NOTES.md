# web/design refresh notes — 2026-05-24

The mocks/tokens in this directory were originally drawn from screenshots
dated ~May 8. The client has since evolved (markdown helper, dark mode,
filter/screen rework). This pass re-captured the **current** Svelte client
and reconciled the design artifacts against it. This file is the diff log so
the control-build pass knows what moved and why.

## How the screenshots were re-captured

The e2e harness (`client/test/e2e/run.ts --update-baselines`) writes baseline
PNGs to `docs/screenshots/svelte/<journey>/`. On a fresh `make db-reset` +
build it captured **boot** cleanly, but **kanban / task_detail / inbox /
grid / projects / attachments** journeys all timed out — NOT a render
failure: the journeys assert against **stale selectors** that the current UI
no longer emits (see "drift" below). The screens themselves render fine.

To get accurate fresh PNGs of the current UI I drove the same login +
per-project-screen navigation helpers and captured each target screen
directly. Fresh PNGs (dated 2026-05-24) now exist for:

- `boot/landing.png` (login), `boot/projects_list.png`, `boot/activity.png`
- `projects/list.png`, `projects/quick_entry_open.png`, `projects/project_layout.png`
- `kanban/board.png` (default = grouped by Milestone), `kanban/columns_by_status.png`
- `inbox/list.png` (empty state for the System user)
- `grid/default.png`, `grid/dark_mode.png`
- `task_detail/read.png`, `task_detail/title_editing.png`

Older May-8 PNGs from drag/interaction states remain alongside (the
interaction journeys couldn't replay against current selectors).

## Why the e2e journeys time out (relevant to the next pass)

The journeys in `client/test/e2e/journeys/` are out of date with the UI:

- **kanban.ts** waits for `[data-kanban-column][data-column="todo"]`. The
  board now defaults to **Columns by: Milestone**, and `data-column` is the
  grouping value's **card id** (e.g. `32`, `33`, `__unset__`), never a
  literal enum string like `todo`. Even with Columns-by = Status the keys
  are status value-card ids, not `todo`/`doing`.
- **inbox.ts** waits for `[data-testid="inbox-list"]`; the inbox renders an
  EmptyState for the System demo user (who owns no tasks) and the list
  testid is absent in that state.
- **grid.ts / projects.ts / task_detail.ts** render correctly but their
  later interaction steps (combobox filter, quick-entry focus, `e`-to-edit)
  drift from the current control wiring and time out.
- **attachments.ts** flakes on the upload roundtrip (environment).

These are journey-maintenance issues, not visual regressions — flagged here,
not fixed (out of scope: don't touch client/src or the harness behavior).

## Concrete drift fixed in the mocks

### App shell (NEW — was barely mocked)
- Topbar: brand `kitp` + rail-collapse `‹`; a **project-scope Picker**
  (`[Default Project ▾]` / `[All projects ▾]`) + breadcrumb; right cluster of
  **theme toggle ☾/☀**, **panel toggle ▥**, **help ?**.
- Rail: global links with right-aligned muted **chord hints** (`g p`, `g a`,
  `g i`, `g g`, `g k`), a **DEFAULT PROJECT** scope section (only when scoped
  to one project), an **ADMIN** section, and a bottom **user chip** (avatar +
  name + `▾`). Documented in `controls-and-rules.md` as `AppShell` + on every
  mock's frame.

### ScreenFilterBar (the biggest change)
The old "QUICK FILTERS [Todo][Doing][Review][Done][Mine] + Saved filters ▾"
strip is GONE. Inbox, Grid, Kanban and Project-detail now share a much richer
bar: export `⤓` · **View** Picker (saved screen view) · **NAMED** filter
Picker · **GROUP** Picker · `⋮` kebab · **Search tasks…** · **in: [Title ▾]**
scope; then a per-attribute filter-Picker row (Status / Assignee / Originator
/ Milestone / Component / Tags) · + Add filter · Advanced · Clear · row count
· **Show closed status** checkbox. New `ScreenFilterBar` entry added to
`controls-and-rules.md`; mock-kanban / mock-inbox updated.

### Kanban
- Default axis is **Milestone** (was documented `status`). Columns keyed by
  value-card id, trailing `(unset)`. Added a Columns-by=Status variant note.

### Task detail
- Layout reorder: main column is now header → **DESCRIPTION** → **RELATED
  TASKS** → **COMMS** → **COMMENTS** → **ADD COMMENT** → **ACTIVITY**. The
  right rail is exactly **ATTRIBUTES → ATTACHMENTS → TAGS** (Related/Workflow
  are no longer in the rail).
- ATTRIBUTES renders as a **read-only key/value table** in read mode (Assignee
  / Comms / Component / Due date / Milestone / Originator / Status), becoming
  the Picker/DatePicker/Field editor on interaction. Old mock showed inline
  pickers as the resting state.
- Header status changer: the live build shows a **two-dropdown Picker pair**
  (`[ Done ▾ ][ Status ▾ ]`), not the full 9-bucket `TransitionBar`. Both the
  mock and `controls-and-rules.md` now flag the 9-bucket bar as the target
  and the dropdown pair as current reality — RECONCILE in the build.
- Comment composer placeholder is "Add a comment… (Markdown supported ·
  Mod+Enter to post)"; submit button is labelled **Comment** (not "Post").
- Attachments empty state: drop zone + "Up to 250.0 MB per file" +
  "Choose files…".

### Inbox / Grid
- Inbox is personal (assignee = signed-in user); System demo user → EmptyState
  "Your inbox is clear. / Nothing assigned to you right now." (no action btn).
- Grid: no separate "Grid — N rows" header; **+ New issue** floats top-right of
  the body; columns observed = ID · Title · Assignee · Priority · Milestone ·
  Component · Tags · Due Date · Created · Last activity (horizontal scroll).
  Priority renders as a tone pill. Leading checkbox column + select-all header.
- No Mine/All segmented toggle — kept only as design intent.

### Projects
- Breadcrumb scope **All projects**; H1 "Projects" + **+ New project**; search
  Field "Search projects… (press / to focus)"; rows = name + "OPEN TASKS: —"
  subtitle + ✎ edit IconButton.
- New-project dialog: Title + Description (optional) + **"+ More details"**
  disclosure (project type lives under it) + footer **Add & Another /
  Add & Close** + hint "Press Enter to add another · Ctrl+Enter to add and
  close · Esc to cancel".

### Project detail (`layout: project`)
- No longer a PROPERTIES | TASKS two-pane. It is the shared ScreenFilterBar +
  H1 project name + "No description." + **[ Edit properties ]** & **[ + New
  task ]** + a vertical **Collection of bordered task cards** (avatar +
  assignee + label-prefixed attr chips).

### Activity
- Global screen. Filter is a **flat labeled-combobox row** (KIND / ACTOR /
  FROM / TO with `Picker` + `DatePicker`), NOT a predicate-tree editor. Rows:
  `Card #N` accent link + change text + right-aligned relative time.

### Login
- Dev/unconfigured mode: just "Sign in to kitp" + **Continue as System User**
  + a muted "OIDC is not configured…" note. OIDC mode: **Sign in with OIDC**.
  There is NO email/password form in the live client — the old Field×2 +
  FormErrors + SSO-split mock was aspirational and has been corrected.

## tokens.css
Re-verified against `client/src/app.css`: all `--color-*` hexes (light +
`[data-theme="dark"]`) still match byte-for-byte and the `data-theme`-on-html
theme strategy is correct. No color/strategy change needed. Layout constants
spot-checked against the 1280×800 captures (rail ≈ 220px, topbar ≈ 48px,
kanban column ≈ 256px, detail rail ≈ 320px). Added a dated re-verification
note to the file header.

## Files touched this pass
- `mock-kanban.md`, `mock-task-detail.md`, `mock-inbox.md`, `mock-secondary.md`
- `controls-and-rules.md` (added `AppShell` + `ScreenFilterBar`; corrected
  TransitionBar reality + the screen→controls map)
- `tokens.css` (re-verification note only)
- `screen-inventory.md` (corrected kanban default axis + inbox interactions)
- this `REFRESH-NOTES.md`

Not touched: `hotkeys.md` (chords match the rail hints observed: `g p/a/i/g/k`).
