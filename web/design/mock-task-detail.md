# Mock — Task detail (`/task/:id`)

Two-column at ≥700px (main column + ~320px right rail); collapses to one
column below that. Everything is driven by the attribute schema — the right
rail renders whatever `attribute_def`s are bound to the `task` card type.

Route confirmed from the live build: `/task/<id>` (e.g. `/task/54`); the
topbar breadcrumb reads `[Default Project ▾] / Task / Task #54`.

## Overall layout & regions

Observed order (current build), top to bottom — note RELATED TASKS, COMMS
and COMMENTS now live in the **main column**, not the rail; the rail is
ATTRIBUTES → ATTACHMENTS → TAGS:

```
┌──────────┬──────────────────────────────────────────────┬─────────────────┐
│ shell    │ MAIN COLUMN                                   │ RIGHT RAIL      │
│ rail     │                                               │ (~320px)        │
│          │ ┌───────────────────────────────────────────┐│ ┌─────────────┐ │
│          │ │ ‹  Wire pickers (dense#1) ✎  [Done▾][Status▾]│ │ ATTRIBUTES  │ │
│          │ │   #54                    1/24 ‹‹ ››  ⋮      ││ │ Assignee  alice│
│          │ ├───────────────────────────────────────────┤│ │ Comms     —   │ │
│          │ │ DESCRIPTION                            ✎  ││ │ Component Frontend│
│          │ │ Replace ad-hoc pickers in the dense       ││ │ Due date  2026-05-20│
│          │ │ table with the shared component.          ││ │ Milestone M1  │ │
│          │ ├───────────────────────────────────────────┤│ │ Originator —  │ │
│          │ │ RELATED TASKS                              ││ │ Status    Todo│ │
│          │ │ PARENT    [+ Set parent]                   ││ ├─────────────┤ │
│          │ │ CHILDREN (0)  No related tasks yet.        ││ │ ATTACHMENTS │ │
│          │ │ [+ Add child] · [+ New sub-task]           ││ │ Drag a file here,│
│          │ ├───────────────────────────────────────────┤│ │ or click "Choose │
│          │ │ COMMS (0)        [+ Start comm][GO TO COMMS]│ │ files…" below.   │
│          │ │ No comms attached.                         ││ │ Up to 250.0 MB/file│
│          │ ├───────────────────────────────────────────┤│ │ [Choose files…]│
│          │ │ COMMENTS (0)   No comments yet.            ││ ├─────────────┤ │
│          │ ├───────────────────────────────────────────┤│ │ TAGS        │ │
│          │ │ ADD COMMENT                                ││ │ priority/high ✕│
│          │ │ [ Add a comment… (Markdown supported ·    ││ │ [+ Add tag] │ │
│          │ │   Mod+Enter to post) ]          [Comment] ││ └─────────────┘ │
│          │ ├───────────────────────────────────────────┤│                 │
│          │ │ ACTIVITY (10)                              ││                 │
│          │ │ System changed assignee ∅→alice · 3m ago  ││                 │
│          │ │ System changed component ∅→Frontend · 3m  ││                 │
│          │ │ System edited the description. · 3m ago   ││                 │
│          │ │ …                                          ││                 │
│          │ └───────────────────────────────────────────┘│                 │
└──────────┴──────────────────────────────────────────────┴─────────────────┘
```

## Header region (region: detail.header)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ‹    Wire pickers (dense#1)  ✎       [ Done ▾ ] [ Status ▾ ]   1/24 ‹‹ ›› ⋮│
│      #54                                ▲ status changer        ▲ nav  ▲kebab│
└─────────────────────────────────────────────────────────────────────────┘
```
- `‹` back chevron (Esc / q).
- **Title** — `✎` pencil (or `e`) swaps to an inline text input; Enter or
  blur commits one `attribute.update`; Esc cancels.
- `#<id>` subtitle (muted), directly under the title.
- **Status changer** — as rendered today this is a pair of `Picker`-style
  dropdowns: a primary one labelled with the *current* status value
  (`[ Done ▾ ]`) and a `[ Status ▾ ]` dropdown of available transitions.
  The full 9-bucket `TransitionBar` (below) remains the design intent; the
  live build currently surfaces the simpler dropdown pair. See REFRESH-NOTES.
- **Prev/next chevrons** `‹‹ ››` + `1/24` counter — walk the source list
  the user came from. `j`/`k` or `[`/`]`.
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

As rendered in the read view today, ATTRIBUTES is a compact **two-column
key/value table** (label column left, value right), one row per
`attribute_def` bound to `task`. Empty values show an em-dash `—`:

```
┌ ATTRIBUTES ───────────────────────────┐
│ ASSIGNEE        alice                  │  ← label uppercase/muted; value plain
│ COMMS           —                      │
│ COMPONENT       Frontend               │
│ DUE DATE        2026-05-20             │
│ MILESTONE       M1                     │
│ ORIGINATOR      —                      │
│ STATUS          Todo                   │
└────────────────────────────────────────┘
```
- Rows are sorted by attribute label; the demo `task` type binds
  Assignee, Comms, Component, Due date, Milestone, Originator, Status.
- The value cell becomes the editor on interaction — that is the
  `Picker` (ref/enum), `DatePicker` (date), `Checkbox` (bool) or text/number
  `Field` shown below. **Ref / enum / bool / date** commit eagerly on
  change; **text / number** hold a draft and commit on blur or Enter.
- Editing affordance (per row, on hover / focus):
  ```
  ASSIGNEE   [ alice            ▾ ]   ← Picker (card_ref:person, async search)
  STATUS     [ Todo             ▾ ]   ← Picker (card_ref:status)
  DUE DATE   [ 2026-05-20      📅 ]   ← DatePicker
  ```
- Per-row: pending spinner while in flight; inline error on failure
  (cleared on next success).
- NOTE: the rail does NOT carry a "Related" / "Workflow" block — Related
  Tasks moved into the main column (below). The rail is exactly
  ATTRIBUTES → ATTACHMENTS → TAGS.

## Related tasks (region: detail.main.related)

A main-column block (above Comms), not in the rail:
```
┌ RELATED TASKS ────────────────────────────────────────┐
│ PARENT      [ + Set parent ]                           │  ← link-style action
│ CHILDREN (0)   No related tasks yet.                   │
│ [ + Add child ]  ·  [ + New sub-task ]                 │  ← + New sub-task = QuickEntryOverlay prefilled parent
└────────────────────────────────────────────────────────┘
```

## Comms (region: detail.main.comms)

```
┌ COMMS (0)                    [ + Start comm ] [ GO TO COMMS ]┐
│ No comms attached.                                          │
└─────────────────────────────────────────────────────────────┘
```

## Attachments (region: detail.rail.attachments)

The ATTACHMENTS block lives in the rail. When empty it's a labelled
drop zone with the size limit + a "Choose files…" button:

```
RAIL (empty):                          RAIL (with files):
┌ ATTACHMENTS ──────────────────────┐  ┌ ATTACHMENTS (2) ──────────────────┐
│ Drag a file here, or click        │  │ kitp-gallery-esc.png      70 B  ✕ │
│ "Choose files…" below.            │  │ kitp-e2e-attachment.txt   46 B  ✕ │
│ Up to 250.0 MB per file.          │  │ ┌───────────────────────────────┐ │
│                                   │  │ │ Drag & drop, or [Choose files]│ │
│ Drag & drop, or  [ Choose files…] │  │ └───────────────────────────────┘ │
└────────────────────────────────────┘  └────────────────────────────────────┘
                                         MAIN preview strip (when files exist):
                                         ┌ [▣ thumb] [▣ thumb] (→ lightbox) ┐
```
- Drop zone OR file picker. Helper copy: "Drag a file here, or click
  'Choose files…' below. Up to 250.0 MB per file." Upload shows per-file
  progress, then bumps an `attachmentsVersion` a main preview strip listens
  to. Delete is `✕` with optimistic removal + toast on failure.

## Comments (region: detail.main.comments)

Two separate blocks: a read list **COMMENTS (n)** and the **ADD COMMENT**
composer beneath it.

```
┌ COMMENTS (2) ─────────────────────────────────────────┐
│ ┌───────────────────────────────────────────────────┐ │
│ │ ◐ bob · 2h ago                              ✎ edit │ │  ← author avatar + relative time
│ │ Looks good, ship it.                               │ │     body rendered as Markdown
│ └───────────────────────────────────────────────────┘ │
│ ┌───────────────────────────────────────────────────┐ │
│ │ ◐ alice · 5h ago (edited)                          │ │
│ │ Will do.                                           │ │
│ └───────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
┌ ADD COMMENT ──────────────────────────────────────────┐
│ [ Add a comment… (Markdown supported · Mod+Enter to   │  ← composer (c focuses)
│   post)                                              ] │     placeholder spells out Markdown + Mod+Enter
│                                            [ Comment ] │  ← submit button labelled "Comment"
└─────────────────────────────────────────────────────────┘
```
- Empty list reads "No comments yet." Each comment can be edited inline
  (`✎`) → textarea + Save / Cancel. Edit shows "(edited)". Post / edit each
  issue one batch + refresh. Composer placeholder is literally
  "Add a comment… (Markdown supported · Mod+Enter to post)"; the submit
  button is labelled **Comment** (not "Post").

## States

**Loading (cold)** — full-span centered Spinner.

**Empty sections** (observed copy) — Related: "No related tasks yet." under
CHILDREN, "+ Set parent" under PARENT. Comms: "No comms attached."
Comments: "No comments yet." Attachments (empty): the drop-zone helper copy
above. Description empty: muted placeholder + the ✎ affordance.

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
