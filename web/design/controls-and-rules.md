# Controls & Rules — the de-duplication artifact

The owner wants **reuse, not just visual similarity**. So this document is
structured as: (1) a small set of **common controls** that compose every
screen, each with the config it accepts; (2) **common rules** the framework
enforces *once* for all screens (selection, inline-edit, validation,
placeholders, focus/keyboard, optimistic feedback); and (3) a
screen → controls map that proves every main screen reduces to "these
controls with this config".

If a behavior shows up on two screens, it belongs to a control or a rule
here — not duplicated in the screen. A screen is, ideally, just a data
binding + a layout choice over these controls.

---

## 1. Common controls

Controls are config-driven. Every control takes a `config` object (plain
data, often itself sourced from a backend card) and a data binding. None of
them know about a specific screen.

### `Field`
The universal labeled input. One control covers text / textarea / number /
password / email / search.
```
config: {
  kind: 'text'|'textarea'|'number'|'password'|'email'|'search',
  label?, caption?, placeholder?, required?, monospace?,
  commit: 'change'|'blur'|'enter',   // when the value is committed
  validate?: (value) => string|null  // returns error message or null
}
binding: { value, onCommit, error? }
```
Reused by: Login, Projects/New-project, Task-detail title/description/
comment editors, every Admin editor, FilterBar value inputs, Import wizard.

### `Picker` (Combobox / select)
Single or multi select with optional **async loader**. This is the most-
reused control in the app — every ref/enum attribute editor, the kanban
axes, project-type, role/scope, channel, tag picker.
```
config: {
  multiple?, searchable?, placeholder?, disabled?,
  options?: {value,label,selectedLabel?,disabled?}[],   // static options
  loadOptions?: (query) => Promise<Option[]>            // async mode
}
binding: { value, onChange }
```
Reused by: Kanban (Columns by / Swim lanes by), Task-detail attribute panel
(all ref/enum attrs), Inbox/Grid filters, Projects (type), Admin (layout,
role, scope, channel, default-filter, etc.), tag pickers, RecipientsPicker.

### `DatePicker`
Calendar popover bound to a `date` value. A specialization that *uses*
`Picker`'s popover positioning + `Field`'s text affordance.
```
config: { placeholder?, min?, max?, clearable? }
binding: { value, onChange }
```
Reused by: Task-detail (any `date` attr), filters (date predicates), Admin.

### `Checkbox`
Boolean toggle. Reused by: bool attrs, Grid row selection, Attributes
"Bound/Required" matrix, Login remember-me, Admin toggles.

### `Collection` (List)
Renders an ordered set of items with a `renderItem`, owning the **selection
model**, empty/loading/error placeholders, and optional drag-reorder. Every
list/table body is a `Collection`.
```
config: {
  itemKey: (item) => string,
  renderItem: (item, state) => view,   // state: {selected, focused, dragging}
  selection: 'none'|'single'|'multi',
  reorder?: { onReorder },             // enables DragHandle/DropZone wiring
  empty: EmptyState config,
  layout?: 'rows'|'table'|'columns'
}
binding: { items, loading, error, onRetry }
```
Reused by: Inbox, Grid (table mode), Activity, Projects, all Admin list
panes, Task-detail (activity / comments / related / comms sub-lists),
Kanban column body.

### `Card`
A bordered, optionally-selectable surface for one entity. The kanban card,
the inbox `TaskRow`, a comment, an admin list item are all `Card`s with
different `renderItem` content.
```
config: { selectable?, draggable?, tone?, shadow? }
```

### `Column`
A kanban lane column: header (label · count · `+`) + a `Collection` body in
`columns` layout + drop zones. Pure composition of `Collection` + `Toolbar`.

### `DragHandle` + `DropZone`
The drag primitives. `DragHandle` makes an element draggable with a preview
label; `DropZone` is a padded target that highlights on hover and reports a
slot index. Used by Kanban (between-columns) and Inbox (reorder). The
framework's drag rule (below) ties them to optimistic updates.

### `Toolbar`
A horizontal action/region bar: title slot, control slots, trailing slot
(counts, spinner). The board axes header, FilterBar rows, BulkActionBar, and
admin header are all `Toolbar`s.

### `AppShell`
The persistent frame around every signed-in screen. Three parts:
- **topbar** — brand `kitp` + rail-collapse chevron `‹` (left); a
  **project-scope `Picker`** (`[Default Project ▾]` / `[All projects ▾]`) +
  breadcrumb crumb (center); and a right cluster of `IconButton`s —
  **theme toggle** `☾`/`☀` (writes `data-theme` on `<html>`; R8),
  **panel/right-rail toggle** `▥`, and **help** `?` (opens the shortcut
  overlay).
- **rail** — global links (Projects `g p`, Activity `g a`) with right-aligned
  muted chord hints; a **scope section** ("DEFAULT PROJECT": Inbox `g i`,
  Grid `g g`, Kanban `g k`, Project detail) shown only when scoped to one
  project; an **ADMIN** section; and a foot **user chip** (`Avatar` + name +
  `▾` account menu). Collapses to icon-width.
- **outlet** — the active screen.

### `ScreenFilterBar`
The shared header for every task-list screen (Inbox, Grid, Kanban, Project
detail). It is a stack of two `Toolbar` rows over the same active-filter
card:
- Row 1: export `IconButton` `⤓` · **View** `Picker` (saved screen view) ·
  **NAMED** filter `Picker` · **GROUP** `Picker` (group-by) · `⋮` kebab ·
  **Search tasks…** search `Field` · **in: [Title ▾]** search-scope `Picker`.
- Row 2: one **filter `Picker` per attribute** (Status, Assignee, Originator,
  Milestone, Component, Tags) · **+ Add filter** · **Advanced** · **Clear** ·
  a row/open-task **count** · a **Show closed status** `Checkbox`.
It supersedes the old "quick-filter chip strip + Saved filters ▾" model.

### `Popover`
Floating panel anchored to a trigger (auto-position, flip, click-outside to
close, `--z-dropdown`/`--z-modal`). Underlies: `Picker` dropdown, kebab
menus, TransitionBar dropdowns, QuickEntryOverlay, help tooltips.

### `Dialog` / `SlideOver`
Modal surfaces over a scrim (`--z-modal`). `Dialog` = centered;
`SlideOver` = edge panel. `ConfirmDialog` is a `Dialog` preset with a
type-to-confirm option (purge flows). Reused by: New-project, Add-person,
Move-to-project, Bulk move/purge, Import wizard, Help.

### `Markdown`
Renders trusted markdown → safe HTML. Reused by: Task-detail description +
comment bodies, help topics.

### `TransitionBar`
Renders a card's available state transitions (9 buckets → accept / reject /
defer / close-split / progress-dropdown / reopen-split). Role-locked
transitions render disabled with a "Needs <role>" hint; an inline reject
banner offers the valid moves as live buttons.
```
config: { variant: 'row'|'detail' }
binding: { cardId, transitions, onChanged }
```
Reused by: Task-detail header (`detail`), Inbox/Grid/Comms rows (`row`).

> CURRENT BUILD: the live task-detail header surfaces the *simpler* form of
> this control — a pair of status `Picker` dropdowns: one labelled with the
> current status value (`[ Done ▾ ]`) and a `[ Status ▾ ]` transition
> dropdown. The full 9-bucket bar above is the design target; the control
> build should reconcile the two. See REFRESH-NOTES.md.

### `QuickEntryOverlay`
Rapid card creation. A `Popover` wrapping a small `Form` with one-shot
**prefill** (target column/lane/parent) and "add another / add and close /
cancel" semantics. Bound to `n` in every list/board scope.
```
config: { defaultCardType, prefill?, assigneeOptions?, candidateStatuses?,
          attributePalette?, tagOptions?, onCreated }
```
Reused by: Kanban, Inbox, Grid, Project detail, Task-detail (new subtask).

### `Toast`
Transient feedback stack at `--z-toast` (success / error / info, optional
Undo). The single channel for optimistic-update results and save outcomes.

### `Avatar`, `Chip`, `Spinner`, `EmptyState`, `Alert`, `IconButton`
Atoms. `Chip` = pill (status, tags, filter chips). `Alert` = inline
danger/warning/success block (with optional Retry). `EmptyState` = icon +
title + description + optional action. These are the leaf reuse units.

---

## 2. Common rules (framework-enforced once, for ALL screens)

These are NOT per-screen code. The framework implements each once; screens
opt in by using the controls above.

### R1 — Selection model
`Collection` owns selection. Exactly one **focused** item per collection
(keyboard cursor); `single` collections equate focus with selection,
`multi` collections add a checked set. Focus follows pointer click and arrow
keys. `j`/ArrowDown and `k`/ArrowUp move focus; Enter activates the focused
item (open detail); Space toggles checked in `multi`. Focus is clamped to
range on data refresh. Screens never track "selected index" themselves.

### R2 — Inline edit
Any `Field` with `commit: 'enter'|'blur'` follows one protocol: a read view
with a pencil affordance → click or the field's edit-chord swaps to the
input (autofocus + select) → Esc cancels (restores prior value) → the
commit key (Enter, or Mod+Enter for multiline) saves. On save-failure the
editor stays open with the draft intact and a `Toast` reports the error.
Ref/enum/bool/date commit eagerly; text/number debounce to blur/Enter so we
never fire one write per keystroke. Implemented once; title, description,
comments, every attribute, every admin field inherit it.

### R3 — Validation + error display
Validation runs at commit time via the `Field`/`Form` `validate` config.
The error renders inline beneath the control (`--color-danger`,
`--text-xs`); the control gets the invalid ring. `Form`-level errors render
in a `FormErrors` block above the submit. Server rejections map to the same
inline slots when the error names a field, else to a `Toast`. One rule —
no per-screen try/catch ladders (matches the user's "callback + centralized
error registry" preference: controls report through one fault channel).

### R4 — Placeholders: empty / loading / error
`Collection` (and any data-bound control) renders one of four states from
its `{items, loading, error}` binding, never ad-hoc per screen:
- **loading-cold** (no prior data): centered `Spinner`.
- **loading-refresh** (have data): keep data, show a small `Spinner` in the
  owning `Toolbar`'s trailing slot — never blank the content.
- **empty**: the configured `EmptyState` (with a "Clear filter" action when
  a filter is active).
- **error**: an `Alert` with the reason + a `[Retry]` that re-runs the
  binding's loader.

### R5 — Focus & keyboard behavior
A hierarchical scope stack (global → screen → region → control; see
`hotkeys.md`) resolves keys: overlay > active screen > global. Bindings are
data, registered/torn-down with the owning control's lifetime. `/` focuses
the nearest search `Field`; ArrowDown from a search field drops focus into
the collection below. `Esc` backs out (close overlay → cancel edit → leave
screen, in that precedence). Inputs suppress non-`Esc`/non-`Mod+Enter`
single-key shortcuts. The help overlay (`?` / `Ctrl+/`) lists the live
bindings for the current scope. One dispatcher; screens only declare
bindings.

### R6 — Optimistic-update feedback
Mutations that have an obvious local effect (drag-move, drag-reorder, tag
add/remove, attribute change, comment post) apply **optimistically**: the UI
updates immediately (FLIP animation where position changes,
`--duration-flip`), the request fires, and on success a quiet success
`Toast` confirms. On failure the framework rolls back to the captured
snapshot **unless** a refresh landed mid-flight (then it re-fetches to
converge on server truth) and surfaces an error `Toast`. Reorder/move
collapse their multi-field writes into ONE batch. One rule; every draggable
/ editable control inherits it.

### R7 — Batch coalescing (data rule, but UI-visible)
All `dispatcher.request` calls fired in one render tick coalesce into a
single `POST /api/v1/batch`. Screens load by firing every sub-request
synchronously on mount; the framework batches them. This is why each
screen's "initial data" is one round-trip. Controls that mutate fire on the
same tick to batch (e.g. drag-move's sort+column+lane updates).

### R8 — Theming
All visuals reference `tokens.css` custom properties. The theme toggle
writes `data-theme` on `<html>`; `prefers-color-scheme` applies when unset.
No control hard-codes a color. Reduced-motion zeroes the motion tokens.

---

## 3. Screen → controls map (the proof of de-dup)

Read as: "this screen = these common controls with this config." No screen
introduces a control or rule not listed in §1–2.

### Kanban = `AppShell` + `Toolbar`(board header) + `Picker`×2 (axes) + `ScreenFilterBar` + `Column`×N{ each = `Toolbar` + `Collection`(columns layout) + `Card`×N + `DropZone`×N } + `DragHandle` + `Chip`(tags) + `QuickEntryOverlay` + `Toast`
Rules: R1 (board focus is a 2-D selection over cells), R4, R5 (hjkl + shift-move), R6 (drag-move → 1 batch), R7, R8.

### Task detail = `AppShell` + `Toolbar`(header) + `IconButton`×N + `TransitionBar`(detail) + `Field`(title/desc/comment) + `Markdown` + `Picker`/`DatePicker`/`Checkbox`/`Field`(attribute panel, one per `attribute_def`) + `Collection`×4 (activity/comments/related/comms) + `Card`(comment) + `Avatar` + `Chip`(tags) + `DropZone`(attachments) + `Popover`(kebab/transition menus) + `ConfirmDialog`(purge) + `Dialog`(move) + `QuickEntryOverlay`(subtask) + `Toast`
Rules: R2 (title/desc/comment + every attr), R3, R4, R5 (`e _` chords, prev/next), R6 (attr/tag/comment optimistic), R7 (10-request initial batch), R8.

### Inbox / List = `AppShell` + `Button`(New task) + `ScreenFilterBar` + `Collection`(rows){ `Card`→`TaskRow` = `DragHandle` + `Chip`(status+attrs) + `TransitionBar`(row) } + `QuickEntryOverlay` + `Toast`
Rules: R1, R4, R5 (`j`/`k`, shift-reorder, `/`), R6 (reorder → 1 `user_card_sort.set`), R7, R8.
Note: inbox is personal (assignee = signed-in user); the System demo user owns nothing so it renders the EmptyState ("Your inbox is clear."). No separate Mine/All segmented control — scope is the View + Assignee filter.

### Grid / Table = `AppShell` + `Button`(+ New issue) + `ScreenFilterBar`(carries export ⤓) + `Collection`(table layout){ sortable header cells (▽) + leading `Checkbox` column + select-all header + `Chip`(priority/status) + `TransitionBar`(row) } + `Toolbar`→`BulkActionBar` + `Dialog`(bulk move/purge) + `QuickEntryOverlay` + `Toast`
Rules: R1 (multi-select), R3, R4, R5, R6, R7, R8.

### Projects = `AppShell` + H1 + `Button`(+ New project) + `Field`(search, `/` focuses) + `Collection`(rows){ `Card`(name + "OPEN TASKS: n") + `IconButton`(✎ rename) } + `Dialog`+`Form`(new project: `Field`×2 + "+ More details" disclosure + `Picker`(type); footer = Add & Another / Add & Close) + `Toast`
Rules: R1, R2 (inline rename), R3, R4, R5, R8.

### Activity = `AppShell` + filter row{ `Picker`(KIND, ACTOR) + `DatePicker`×2(FROM/TO) } + `Collection`(rows: `ActivityRow` = `TaskRefLink`(Card #N) + change text + relative time) + `Toast`
Rules: R1, R4, R5, R8.
Note: the filter is a flat labeled-combobox row in the current build, not a `FilterTreeEditor` predicate tree.

### Login = `Button`(single: "Continue as System User" in dev / "Sign in with OIDC" in OIDC mode) + muted note
Rules: R8. (No email/password `Form` in the live client.)

### Admin (every screen) = `AppShell` + `Toolbar`(header + New) + two-pane{ `CardListPane`(= `Field`search + `Collection`) | `Form`(schema-driven `Field`/`Picker`/`Checkbox`/`DatePicker`, plus per-screen extras like the Attributes "Bound to" matrix = `Collection`+`Checkbox`+`Field`) } + `Dialog`(add/confirm) + `Chip`(badges) + `Toast`
Rules: R1 (list-pane selection), R2, R3, R4, R5 (`/`, `n`), R8.

### Import wizard = `Dialog`(large) + step indicator + `DropZone`(upload) + `Picker`×N(map) + `Collection`(preview) + `SubmitButton`(commit) + `Toast`
Rules: R3, R4, R6/R7 (commit batch), R8.
