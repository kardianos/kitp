# Hotkeys — hierarchical scope map

This feeds a **declarative hierarchical-hotkey system**. Scopes nest:
`global → screen → region → control`. A key event resolves against the
deepest active scope first, then layers outward to its ancestors. The
existing client already does the tier part (overlay > active > global, with
`g _` chords as a reactive source); this design extends it to the full
region/control nesting so a control can claim a key without the screen
knowing.

## Resolution model

```
overlay   (transient: Dialog, Help, QuickEntry, open Popover/menu)   ← wins, absorbs input
  │  (only the topmost overlay's bindings + global Esc are live)
  ▼
control   (focused control: open Picker, inline-edit Field, TransitionBar)
  ▼
region    (focused region within the screen: filter bar, column body, table)
  ▼
screen    (the active screen scope: kanban / inbox / grid / task_detail / …)
  ▼
global    (always on)
```

Rules the dispatcher enforces:
- **Deepest-first.** A binding at a deeper scope shadows the same key at a
  shallower one. (e.g. while a `Picker` is open, ArrowDown moves its
  option highlight — not the `Collection` selection.)
- **Chords** are space-separated (`g p`, `e t`); a 1.2s buffer collects the
  second key. A chord prefix at any scope opens a buffer.
- **Inputs**: while focus is in a text input, single-key bindings are
  suppressed; only `Esc` and `Mod+Enter` fire (these are `fireInInputs` by
  default).
- **Aliases** share one row in help (`j, ↓` / `Shift+J, Shift+↓`).
- **Help overlay** (`?` / `Ctrl+/`) lists exactly the live bindings for the
  current scope chain.
- **Esc precedence**: close topmost overlay → cancel inline edit → leave
  screen (back). First applicable wins.

`Mod` = ⌘ on macOS, Ctrl elsewhere.

---

## GLOBAL scope (always active)

| Key | Action |
|---|---|
| `Ctrl+/`, `?` | Show keyboard shortcuts (Help overlay) |
| `Esc` | Close help / dismiss topmost overlay |
| `g p` | Go to Projects |
| `g a` | Go to Activity |
| `g i` | Go to Inbox *(data-driven per-project screen chord)* |
| `g g` | Go to Grid *(data-driven)* |
| `g k` | Go to Kanban *(data-driven)* |
| `g <hotkey>` | Go to any screen whose `screen` card defines that hotkey |

The `g <hotkey>` set is **derived from the active project's `screen`
cards** — a newly-seeded screen gets a working chord on the next visit, no
code change. (Source: AppShell registers `screenChords` as a reactive
source.)

### OVERLAY scope (layers above everything when an overlay is open)
| Key | Action |
|---|---|
| `Esc` | Close the overlay (Dialog / Help / QuickEntry / open menu) |
| `Enter` | Confirm primary action (Dialog default button) |
| `Mod+Enter` | Confirm-and-close (QuickEntry: add and close; multiline commit) |
| `Tab` / `Shift+Tab` | Move focus within the overlay (focus trap) |

QuickEntry overlay adds: `Enter` = add another (stay open), `Mod+Enter` =
add and close, `Esc` = cancel.

---

## Screen: KANBAN (scope `kanban`)

Screen-level (board navigation + card move):
| Key | Action |
|---|---|
| `j`, `↓` | Move selection down (within column) |
| `k`, `↑` | Move selection up (within column) |
| `l`, `→` | Next column |
| `h`, `←` | Previous column |
| `Shift+J`, `Shift+↓` | Move card down within column |
| `Shift+K`, `Shift+↑` | Move card up within column |
| `Shift+L`, `Shift+→` | Move card to next column |
| `Shift+H`, `Shift+←` | Move card to previous column |
| `Alt+J` | Next swim lane |
| `Alt+K` | Previous swim lane |
| `Enter` | Open selected card → `/task/:id` |
| `n` | Quick-create in the focused cell |
| `/` | Focus search |

Region — **filter bar** (`kanban.filter`):
| Key | Action |
|---|---|
| `↓` (from search input) | Move focus into first card of column 0 |
| `Esc` | Clear search focus |

Control — **open axis `Picker`** (`kanban.picker`): `↑`/`↓` highlight,
`Enter` select, `Esc` close. (Shadows board `j`/`k` while open.)

Control — **card drag** (`kanban.card.drag`, while dragging): `Esc` cancel
drag.

---

## Screen: INBOX / LIST (scope `inbox`)

| Key | Action |
|---|---|
| `j`, `↓` | Next task |
| `k`, `↑` | Previous task |
| `Shift+J` | Move selected task down (personal reorder) |
| `Shift+K` | Move selected task up |
| `Enter` | Open selected task |
| `n` | New task |
| `/` | Focus search |
| `Esc` | Clear search / blur |

Region — **filter bar** (`inbox.filter`): `↓` from search drops into the
list; `Esc` blurs.

Comms variant (slug=`comms`) adds, on the focused row's comm `TransitionBar`
(control `comms.row.transitions`): `c` fire first close transition.

---

## Screen: GRID / TABLE (scope `grid`)

| Key | Action |
|---|---|
| `j`, `↓` | Next row |
| `k`, `↑` | Previous row |
| `Space` | Toggle row checkbox (multi-select) |
| `Enter` | Open selected task |
| `n` | New task |
| `/` | Focus search |
| `x` | Clear selection |

Region — **column header** (`grid.header`): `Enter`/`Space` on a focused
header toggles that column's sort.

Region — **bulk-action bar** (`grid.bulk`, visible when ≥1 checked):
`m` Move…, `Delete` Purge…, `Esc` clear selection.

---

## Screen: TASK DETAIL (scope `task_detail`)

Screen-level:
| Key | Action |
|---|---|
| `e t` | Edit title |
| `e d` | Edit description |
| `e c` | Focus comment composer |
| `e p` | Set parent (open parent picker) |
| `e a` | Add existing child (open child picker) |
| `e s` | New sub-task |
| `t` | Toggle tag picker |
| `c` | Close task (fire first close transition) |
| `j`, `]` | Next task in source list |
| `k`, `[` | Previous task in source list |
| `Esc`, `q` | Back to previous screen |

Region — **attribute panel** (`task_detail.attributes`): `↑`/`↓` move
between attribute rows; `Enter` opens the focused row's `Picker`.

Control — **inline edit** (`task_detail.edit`, while a title/desc/comment
editor is focused): `Esc` cancel; `Enter` commit (title); `Mod+Enter`
commit (description/comment); bare `Enter` = newline (multiline).

Control — **TransitionBar dropdown** (`task_detail.transitions`): `↑`/`↓`
highlight option, `Enter` fire, `Esc` close.

---

## Screen: PROJECTS (scope `projects`)

| Key | Action |
|---|---|
| `j` | Next project |
| `k` | Previous project |
| `Enter` | Open selected project |
| `n` | New project (open Dialog) |
| `/` | Focus search |

New-project Dialog (overlay): `Enter` add another · `Mod+Enter` add and
close · `Esc` cancel.

---

## Screen: ACTIVITY (scope `activity`)

| Key | Action |
|---|---|
| `j`, `↓` | Next activity row |
| `k`, `↑` | Previous activity row |
| `Enter` | Open the referenced task |
| `/` | Focus filter |

---

## Screen: ADMIN family (scopes `admin_users`, `admin_attributes`, … one per screen)

All admin screens share a region structure (list pane + editor pane), so
they share a region binding set; only the screen scope token differs.

Screen-level (any admin screen):
| Key | Action |
|---|---|
| `/` | Focus list-pane search |
| `n` | New <thing> (open create Dialog) |

Region — **list pane** (`admin.list`):
| Key | Action |
|---|---|
| `j`, `↓` | Next item |
| `k`, `↑` | Previous item |
| `Enter` | Load item into editor pane |

Region — **editor pane** (`admin.editor`):
| Key | Action |
|---|---|
| `Mod+S`, `Mod+Enter` | Save |
| `Esc` | Discard unsaved changes (with confirm if dirty) |

Control — any `Field`/`Picker`/`DatePicker` inside the editor inherits the
inline-edit + open-picker control bindings (Esc / Enter / arrows) from R2 /
R5.

---

## Screen: IMPORT WIZARD (overlay over Admin · Projects)

Overlay scope `import_wizard`:
| Key | Action |
|---|---|
| `Mod+→`, `Alt+→` | Next step |
| `Mod+←`, `Alt+←` | Back step |
| `Mod+Enter` | Commit (final step) |
| `Esc` | Cancel wizard (confirm if mid-flight) |

---

## Screen: LOGIN (scope `login`, standalone — no global nav chords)

| Key | Action |
|---|---|
| `Enter` | Submit (from any field) |
| `Tab` / `Shift+Tab` | Move between fields |

---

## New scope tokens to add (beyond the current `ShortcutScope` union)

The current client has screen-level scopes only. This design adds the
nested region/control tiers. Suggested token additions (string-keyed so the
dispatcher can resolve a chain like `["kanban", "kanban.filter"]`):

```
region/control scopes (children of a screen scope):
  kanban.filter, kanban.picker, kanban.card.drag
  inbox.filter, comms.row.transitions
  grid.header, grid.bulk
  task_detail.attributes, task_detail.edit, task_detail.transitions
  admin.list, admin.editor            (shared by every admin_* screen)
  import_wizard                       (overlay)
```

The dispatcher resolves a key by walking the active chain deepest→shallowest
and stopping at the first scope that binds it; unbound keys fall through to
`global`.
