# Mock — Secondary screens (labeled box layouts)

Lighter mocks. Each is composed from the same common-control set (see
`controls-and-rules.md`); the notes call out which controls + config.

---

## Login (standalone, no shell)

```
┌───────────────────────────────────────────────┐
│                                                 │
│                    k i t p                      │
│                                                 │
│        ┌─────────────────────────────────┐      │
│        │ Email     [ ………………………………… ]      │  ← Field (email)
│        │ Password  [ ………………………………… ]      │  ← Field (password)
│        │ ⚠ Invalid email or password.    │      │  ← FormErrors (on failure)
│        │            [   Sign in   ]      │      │  ← SubmitButton (busy spinner)
│        │ ───────────── or ─────────────  │      │
│        │       [ Continue with SSO ]     │      │  ← OIDC redirect button
│        └─────────────────────────────────┘      │
└───────────────────────────────────────────────┘
```
Controls: `Form` + `Field` ×2 + `FormErrors` + `SubmitButton` + `Button`
(OIDC). Validation + error display via the framework's validation rule.

---

## Projects (switcher + manager)

```
┌──────────┬────────────────────────────────────────────────────────────────┐
│ shell    │ Projects                                          [+ New project]│
│          │ [+ Add filter] [Advanced]   [ Search projects… ]                 │  ← Toolbar + search Field
│          │ ┌──────────────────────────────────────────────────────────┐  ✎ │
│          │ │ Default Project          OPEN TASKS: 25                   │     │  ← row (Card); ✎ inline rename
│          │ ├──────────────────────────────────────────────────────────┤  ✎ │
│          │ │ E2E Project A            OPEN TASKS: 3                     │     │
│          │ └──────────────────────────────────────────────────────────┘     │
└──────────┴────────────────────────────────────────────────────────────────┘
```
New-project Dialog: Title `Field`, Description textarea `Field`, Project-
type `Picker`. Footer hint: "Enter = add another · Ctrl+Enter = add and
close · Esc = cancel". Controls: `Collection` + `Card` rows + `Toolbar` +
`Field` + `Dialog` + `Form` + `Picker`. Selection: `j`/`k` + Enter.

---

## Project detail (`layout: project`)

```
┌──────────┬────────────────────────────────────────────────────────────────┐
│ shell    │ <Project name>                                      [+ New task] │
│          │ ┌ PROPERTIES ───────────────┐  ┌ TASKS ──────────────────────┐  │
│          │ │ Description  [ …… ✎ ]       │  │ #1 task …  [Todo] alice     │  │
│          │ │ Type         default       │  │ #2 task …  [Doing] bob      │  │
│          │ │ Created      2026-05-01    │  │ …                            │  │
│          │ └────────────────────────────┘  └──────────────────────────────┘  │
└──────────┴────────────────────────────────────────────────────────────────┘
```
Controls: `ProjectPropertiesPanel` (= `Field` rows), `Collection`+`TaskRow`,
`QuickEntryOverlay`.

---

## Activity

```
┌──────────┬────────────────────────────────────────────────────────────────┐
│ shell    │ Activity                                                         │
│          │ ┌ FILTER ──────────────────────────────────────────────────────┐│  ← ActivityFilterEditor (predicate)
│          │ │ kind in (comment, attribute_change)  actor = alice            ││
│          │ └──────────────────────────────────────────────────────────────┘│
│          │ 2h ago  alice changed Status todo→review on #18 →  (open)        │  ← rows; Enter opens referenced task
│          │ 3h ago  bob commented on #27                                     │
│          │ …                                                                │
└──────────┴────────────────────────────────────────────────────────────────┘
```
Controls: predicate editor (= `FilterTreeEditor`), `Collection`+`ActivityRow`,
`TaskRefLink`. Selection: `j`/`k` + Enter.

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
