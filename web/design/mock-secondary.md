# Mock — Secondary screens (labeled box layouts)

Lighter mocks. Each is composed from the same common-control set (see
`controls-and-rules.md`); the notes call out which controls + config.

---

## Login (standalone, no shell)

Centered card on a plain page (no rail). Current dev-mode build:

```
┌───────────────────────────────────────────────┐
│                                                 │
│        ┌─────────────────────────────────┐      │
│        │           Sign in to kitp        │      │  ← H1
│        │  OIDC is not configured. Set     │      │  ← muted note (dev / unconfigured)
│        │  KITP_OIDC_* env vars and rebuild.│     │
│        │     [  Continue as System User  ]│      │  ← primary Button (dev affordance)
│        └─────────────────────────────────┘      │
│                                                 │
└───────────────────────────────────────────────┘
```
- In **dev / unconfigured** mode (the harness runs `AUTH_MODE=off`): a single
  primary **"Continue as System User"** button, plus the muted note above.
- In **OIDC mode** the button reads **"Sign in with OIDC"** and redirects to
  the IdP (there is no email/password form in the current client — that part
  of the earlier mock was aspirational).
Controls: `Button` (single) + muted note. (No `Field`/`FormErrors`/SSO-split
in the live build.)

---

## Projects (switcher + manager)

```
┌──────────┬────────────────────────────────────────────────────────────────┐
│ kitp  ‹  │ [All projects ▾]  / Projects                      ☾  ▥  ?        │  ← shell topbar (scope = All projects)
│ Projects │                                                                  │
│ Activity │ Projects                                          [ + New project]│  ← H1 + primary action
│··········│ [ Search projects… (press / to focus) ]                          │  ← search Field (/ focuses)
│ ADMIN    │ ┌──────────────────────────────────────────────────────────┐  ✎ │
│          │ │ Default Project                                          │     │  ← row (Card); ✎ inline rename
│ ⊙ System▾│ │ OPEN TASKS: —                                            │     │     subtitle "OPEN TASKS: <n|—>"
│          │ ├──────────────────────────────────────────────────────────┤  ✎ │
│          │ │ Mobile App                                               │     │
│          │ │ OPEN TASKS: —                                            │     │
│          │ └──────────────────────────────────────────────────────────┘     │
└──────────┴────────────────────────────────────────────────────────────────┘
```
- Breadcrumb scope is **All projects** here (vs a single project inside the
  project-scoped screens). No left "DEFAULT PROJECT" section when scope =
  all projects; only Projects / Activity / ADMIN show.
- Each row: project name + an "OPEN TASKS: <n>" subtitle (em-dash when the
  count isn't loaded) + a trailing **✎** edit IconButton.

New-project Dialog (observed): title **"New project"**, a **Title** `Field`
(autofocus), a **Description (optional)** textarea `Field`, a **"+ More
details"** disclosure link (expands to extra fields incl. project type),
a footer hint **"Press Enter to add another · Ctrl+Enter to add and close ·
Esc to cancel"**, and two footer buttons **[ Add & Another ]** /
**[ Add & Close ]** (primary). Controls: `Collection` + `Card` rows +
`Field`(search) + `Dialog` + `Form` + `Field`×2 + disclosure +
`Picker`(type, under More details). Selection: `j`/`k` + Enter; `n` opens
the dialog.

---

## Project detail (`layout: project`, slug `project`)

NOT a two-pane properties+tasks split anymore. It is the same
ScreenFilterBar on top, then an H1 project name + a "No description." (or the
description) subtitle, an **[ Edit properties ]** button + **[ + New task ]**
primary button at the right, then a vertical **Collection of task cards**
(the `TaskRow` rendered as a bordered card, not a dense row).

```
┌──────────┬────────────────────────────────────────────────────────────────┐
│ kitp  ‹  │ [Default Project ▾] / Project detail              ☾  ▥  ?        │  ← shell topbar
│ rail     │ ⤓ View:[Default Project d…▾] NAMED[(none)▾] GROUP[(no grp)▾] ⋮    │  ← ScreenFilterBar (same as inbox/grid)
│ DEFAULT  │   [Status▾][Assignee▾][Originator▾][Milestone▾][Component▾][Tags▾]│
│ PROJECT  │   [+ Add filter][Advanced][Clear]                                │
│          ├────────────────────────────────────────────────────────────────┤
│ Project  │ Default Project                   [ Edit properties ] [+ New task]│  ← H1 + actions
│  detail  │ No description.                                                   │  ← muted subtitle
│          │ ┌──────────────────────────────────────────────────────────────┐│
│          │ │ #54  Wire pickers (dense#1)                                   ││  ← task card (selected: accent ring)
│          │ │ Ⓐ alice  [milestone: M1] [component: Frontend] [priority/high]││     avatar · assignee · attr chips
│          │ └──────────────────────────────────────────────────────────────┘│
│          │ ┌──────────────────────────────────────────────────────────────┐│
│          │ │ #55  API rate limits                                          ││
│          │ │ Ⓐ alice  [milestone: M1] [component: Backend] [priority/high]…││
│          │ └──────────────────────────────────────────────────────────────┘│
│          │ …                                                                │
└──────────┴────────────────────────────────────────────────────────────────┘
```
- Attribute chips: assignee = colored circular **Avatar** + name; the rest
  render as label-prefixed `Chip`s (`milestone: M1`, `component: Frontend`,
  `priority/high`, `area/backend`, `team/growth`, …).
- "Edit properties" opens the project property editor; "+ New task" opens
  `QuickEntryOverlay` prefilled to this project.
Controls: `ScreenFilterBar`, `Button` ×2 (Edit properties / + New task),
`Collection` + `Card`→`TaskRow`, `Avatar`, `Chip`, `QuickEntryOverlay`.

---

## Activity

Global screen (breadcrumb scope = "All projects / Activity"). The filter is
a **labeled-combobox row**, not a predicate-tree editor: KIND / ACTOR /
FROM / TO. Each activity row links its referenced card (`Card #N`) and
shows the change text + a right-aligned relative time.

```
┌──────────┬────────────────────────────────────────────────────────────────┐
│ kitp  ‹  │ [All projects ▾]  / Activity                      ☾  ▥  ?        │  ← shell topbar
│          │ KIND [ All kinds ▾ ]  ACTOR [ Anyone ▾ ]  FROM [ Any time 📅 ]    │  ← filter row (Pickers + DatePickers)
│          │                                            TO [ Any time 📅 ]     │
│          ├────────────────────────────────────────────────────────────────┤
│          │ Card #129                                              5 min ago │  ← card ref (accent link)
│          │ System changed predicate from ∅ to {…json…}                      │     change text (multiline)
│          │ Card #129                                              5 min ago │
│          │ System changed title from ∅ to Heads                             │
│          │ Card #129                                              5 min ago │
│          │ System created the card.                                         │  ← "created the card" is an accent link
│          │ …                                                                │
└──────────┴────────────────────────────────────────────────────────────────┘
```
Controls: filter row = `Picker` (KIND, ACTOR) + `DatePicker` ×2 (FROM/TO);
`Collection` + `ActivityRow` (each = `TaskRefLink` + change text + relative
time). Selection: `j`/`k` + Enter opens the referenced card.

---

## Import wizard (modal flow off Admin · Projects)

```
┌─────────────────────────────────────────────────────────────┐
│ Import project                                   Step 2 of 4 │
│ ●───●───○───○   Upload · Map · Preview · Commit              │  ← step indicator
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Map columns:                                            │ │
│ │   CSV "summary"  →  [ title       ▾ ]                   │ │  ← Picker per source column
│ │   CSV "owner"    →  [ assignee    ▾ ]                   │ │
│ │   CSV "state"    →  [ status      ▾ ]                   │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                   [ Back ]      [ Next ]     │
└─────────────────────────────────────────────────────────────┘
```
Controls: `Dialog` (large), step indicator (a small bespoke element), file
`DropZone` (step 1), `Picker` ×N (step 2 mapping), `Collection`/table
(step 3 preview), `SubmitButton` (step 4, heavy-timeout handler).

---

## Admin family — ONE shape, many card types

Every admin screen is **List pane (left) + Detail/Editor pane (right)**.
They differ only in which card type they list and which schema-driven
fields the editor `Form` renders.

```
┌──────────┬────────────────────────────────────────────────────────────────┐
│ shell    │ Admin · <Thing>                                    [+ New <thing>]│
│          │ ┌ LIST PANE ─────────┐ ┌ DETAIL / EDITOR PANE ─────────────────┐ │
│          │ │ [ Search… (/) ]     │ │ <selected item title>  [type] [built-in]│
│          │ │ ─────────────────── │ │ Name        [ …… ]                     │ │  ← Form of schema-driven Fields
│          │ │ item a        chip  │ │ Value type  [ …… ]                     │ │
│          │ │ item b        chip  │ │ … per-screen fields …                  │ │
│          │ │ ▸ item c (sel)      │ │                              [ Save ]  │ │
│          │ └────────────────────┘ └────────────────────────────────────────┘ │
└──────────┴────────────────────────────────────────────────────────────────┘
```

### Per-screen specifics
- **Users** — list of accounts; editor = display name, active toggle, role-
  grant rows (role `Picker` + scope `Picker`). "Add person" Dialog.
- **Contacts** — email-only persons; editor = name + email Fields.
- **Projects** — project CRUD; editor = title/description/type; "Import…"
  launches the wizard.
- **Attributes** — list of `attribute_def`; editor = Name, Value type, enum
  Options table, **+ a "Bound to" matrix** (one row per card type with
  Bound `Checkbox` / Order `Field` / Required `Checkbox`):
  ```
  ┌ Bound to ────────────────────────────────────┐
  │ CARD TYPE   BOUND   ORDER   REQUIRED          │
  │ project     [ ]      0       [ ]              │
  │ task        [✓]      1       [ ]              │
  │ milestone   [ ]      0       [ ]              │
  └───────────────────────────────────────────────┘
  ```
- **Screens** — list of `screen` cards; editor = layout `Picker`, slug,
  hotkey, default-filter `Picker`, column/lane axis `Picker`s, sort order.
- **Named filters** — list of reusable presets; editor = title +
  `FilterTreeEditor` predicate.
- **Workflows** — list of `workflow_def`; editor = the flow_step state-graph
  editor (states + transitions with from/to phase + required role).
- **Agents** — list of the caller's agents; editor = name + parent-user.
- **Comm channels** — list of channels; editor = protocol, IMAP/SMTP host/
  port/credentials, status badge, test-connection button.
- **Comm log** — read-only `Collection` (no editor pane; row → detail
  popover).
- **Activity sinks** — list of sinks; editor = endpoint URL + predicate +
  enabled toggle.

Controls (shared across all admin screens): `AppShell`, two-pane layout,
`CardListPane` (= search `Field` + `Collection`), `Form` of schema-driven
`Field`/`Picker`/`Checkbox`/`DatePicker`, `Chip` (type/built-in badges),
`Dialog` (add/confirm), `Toast`. Selection in the list pane: `j`/`k` +
Enter; `/` focuses search; `n` opens "New".
