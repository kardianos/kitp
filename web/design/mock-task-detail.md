# Mock — Task detail (`/task/:id`)

Two-column at ≥700px (main column + 320px right rail); collapses to one
column below that. Everything is driven by the attribute schema — the right
rail renders whatever `attribute_def`s are bound to the `task` card type.

## Overall layout & regions

```
┌──────────┬──────────────────────────────────────────────┬─────────────────┐
│ shell    │ MAIN COLUMN                                   │ RIGHT RAIL      │
│ rail     │                                               │ (320px)         │
│          │ ┌───────────────────────────────────────────┐│ ┌─────────────┐ │
│          │ │ ‹  Wire pickers (dense#1)  ✎               ││ │ ATTRIBUTES  │ │
│          │ │    #18         [TransitionBar] 1/25 ‹‹ ›› ⋮││ │ Assignee  alice│
│          │ ├───────────────────────────────────────────┤│ │ Component Frontend│
│          │ │ DESCRIPTION                            ✎  ││ │ Milestone M1  │ │
│          │ │ Replace ad-hoc pickers in the dense       ││ │ Status    Todo│ │
│          │ │ table with the shared component.          ││ │ Workflow  —   │ │
│          │ ├───────────────────────────────────────────┤│ ├─────────────┤ │
│          │ │ ATTACHMENTS (2)                            ││ │ ATTACHMENTS │ │
│          │ │ [thumb] [thumb]                            ││ │ kitp-….png 70B ✕│
│          │ ├───────────────────────────────────────────┤│ │ kitp-….txt 46B ✕│
│          │ │ ACTIVITY (11)                              ││ │ [drop / Choose…]│
│          │ │ just now — System attached kitp-….png     ││ ├─────────────┤ │
│          │ │ just now — System edited the description. ││ │ TAGS        │ │
│          │ │ …                                          ││ │ priority/high ✕│
│          │ ├───────────────────────────────────────────┤│ │ [+ Add tag] │ │
│          │ │ COMMS (read-only)                          ││ ├─────────────┤ │
│          │ │ …                                          ││ │ RELATED     │ │
│          │ ├───────────────────────────────────────────┤│ │ Parent: —   │ │
│          │ │ COMMENTS                                   ││ │ Children: 0 │ │
│          │ │ ┌ comment … ┐  ┌ comment … ┐              ││ │ [+ Subtask] │ │
│          │ │ [ composer …                ] [Post]      ││ └─────────────┘ │
│          │ └───────────────────────────────────────────┘│                 │
└──────────┴──────────────────────────────────────────────┴─────────────────┘
```

## Header region (region: detail.header)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ‹    Wire pickers (dense#1)  ✎      [Accept][Status ▾][Close ▾]  1/25 ‹‹ ›› ⋮│
│      #18                                ▲ TransitionBar          ▲ nav  ▲kebab│
└─────────────────────────────────────────────────────────────────────────┘
```
- `‹` back chevron (Esc / q).
- **Title** — click or `e t` swaps to an inline text input; Enter or blur
  commits one `attribute.update`; Esc cancels. `✎` pencil affordance.
- `#<id>` subtitle (mono, muted).
- **TransitionBar** (see dedicated section) — fires state changes.
- **Prev/next chevrons** `‹‹ ››` + `1/25` counter — walk the source list
  the user came from (seeded into the nav-list before navigation). Hidden
  on cold-load. `j`/`k` or `[`/`]`.
- **Kebab** `⋮` — "Move to project…", "Delete (purge)…".

## The TransitionBar (region: detail.header.transitions)

Renders available transitions bucketed by `(from_phase → to_phase)`. The
same component is reused (compact `variant="row"`) on list/grid rows.

```
9 buckets → renderers:
  accept (triage→active)      [ Accept ]                primary button per transition
  reject (triage→terminal)    [ Reject ]                danger-outline button
  defer  (active→triage)      [ Defer ]                 secondary button
  close  (active→terminal)    [ Close ▾ ]               split: primary + dropdown rest
  progress (active→active)    [ Status ▾ ]              dropdown of all "to" states
  reopen (terminal→active)    [ Reopen ▾ ]              split: primary + retriage/recat dropdown
  (+ retriage / recategorize / progress_triage fold into the dropdowns)

Role-locked transition →   [ Accept  ·Needs manager· ]   disabled + hint pill
```

Reject banner (server says the move is invalid) appears inline below the bar:
```
┌─────────────────────────────────────────────────────────────────┐
│ ⚠ Todo → Done isn't a valid move.                            ✕   │
│   You can:  [ Doing ]  [ Review ·Needs manager· ]                │  ← each is a live button
└─────────────────────────────────────────────────────────────────┘
```

## Attribute side panel (region: detail.rail.attributes)

```
┌ ATTRIBUTES ───────────────────────────┐
│ Assignee     [ alice            ▾ ]    │  ← Picker (card_ref:person, async search)
│ Component    [ Frontend         ▾ ]    │  ← Picker (card_ref, project-scoped)
│ Milestone    [ M1              ▾ ]     │
│ Status       [ Todo             ▾ ]    │  ← Picker (card_ref:status)
│ Priority     [ high             ▾ ]    │  ← Picker (enum)
│ Due date     [ 2026-06-01      📅 ]    │  ← DatePicker
│ Is blocked   [✓]                       │  ← Checkbox (bool)
│ Estimate     [ 5            ]          │  ← number Field (commits on blur)
│   ⚠ must be ≥ 0                        │  ← inline error under the field
└────────────────────────────────────────┘
```
- One row per `attribute_def` bound to `task` (skipping title / description /
  tags / sort_order / parent_* which have dedicated UI).
- **Ref / enum / bool / date** commit eagerly on change. **text / number**
  hold a draft and commit on blur or Enter (so we don't fire one update per
  keystroke).
- Per-row: pending spinner while in flight; inline error on failure
  (cleared on next success).

## Attachments (region: detail.rail.attachments + main preview strip)

```
RAIL:                                  MAIN (preview strip):
┌ ATTACHMENTS (2) ──────────────────┐  ┌ ATTACHMENTS (2) ─────────────┐
│ kitp-gallery-esc.png      70 B  ✕ │  │ [▣ thumb]  [▣ thumb]          │
│ kitp-e2e-attachment.txt   46 B  ✕ │  │   (click → lightbox)          │
│ ┌───────────────────────────────┐ │  └───────────────────────────────┘
│ │ Drag & drop, or [Choose files]│ │
│ └───────────────────────────────┘ │
└────────────────────────────────────┘
```
- Drop zone OR file picker. Upload shows per-file progress, then bumps an
  `attachmentsVersion` the preview strip listens to. Delete is `✕` with
  optimistic removal + toast on failure.

## Comments (region: detail.main.comments)

```
┌ COMMENTS ─────────────────────────────────────────────┐
│ ┌───────────────────────────────────────────────────┐ │
│ │ ◐ bob · 2h ago                              ✎ edit │ │  ← author avatar + relative time
│ │ Looks good, ship it.                               │ │     body rendered as Markdown
│ └───────────────────────────────────────────────────┘ │
│ ┌───────────────────────────────────────────────────┐ │
│ │ ◐ alice · 5h ago (edited)                          │ │
│ │ Will do.                                           │ │
│ └───────────────────────────────────────────────────┘ │
│ ┌───────────────────────────────────────────────────┐ │
│ │ Write a comment…                                   │ │  ← composer (e c focuses)
│ │                                          [ Post ]  │ │     Mod+Enter posts
│ └───────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```
- Newest-first. Each comment can be edited inline (`✎`) → textarea + Save /
  Cancel. Edit shows "(edited)". Post / edit each issue one batch + refresh.

## States

**Loading (cold)** — full-span centered Spinner.

**Empty sections** — Description empty: muted "No description — click ✎ to
add". Activity / Comments empty: muted single-line placeholder. Related:
"No parent · No children".

**Error (load failed)** — full-span EmptyState: "Failed to load task" +
reason + [Retry].

**Not found** — EmptyState: "Task not found" + [Back to projects].

**Editing title/description/comment** — the read view swaps to an input /
textarea with a focus ring; Esc cancels, commit-key saves; on save-failure
the editor stays open with the draft intact + a toast.

## Common controls used
`AppShell`, `IconButton` (back / pencil / nav / kebab), `TransitionBar`,
`Field` (title/description/comment editors = inline `Field` text/textarea),
`Markdown` (description + comment bodies), `Picker` ×N (every ref/enum
attr), `DatePicker`, `Checkbox`, `Collection` (activity / comments /
related / comms lists), `Card` (each comment), `Avatar`, `Chip` (tags),
`Popover` (kebab menu, transition dropdowns), `ConfirmDialog` (purge),
`SlideOver`/`Dialog` (move-to-project), `QuickEntryOverlay` (new subtask),
`Toast`. The attachments drop zone reuses `DropZone`.
