# kitp — Screen Inventory

Design input for the pure-TypeScript, framework-free, data-driven rewrite
of the kitp web frontend. This is parity-with-continuity: every screen
below exists in the current Svelte client (`client/src/screens/`). The new
build keeps the same routes, the same card-driven model, and the same
visual language (see `tokens.css`), but composes everything from the
common-control set in `controls-and-rules.md`.

## The data-driven model (read this first)

Nothing in kitp is hard-coded UI. Screens, filters, columns, and flows are
all **backend cards** the frontend fetches and renders:

- A `screen` card has a `layout` (`kanban` | `list` | `grid` | `project`),
  a `slug`, a `hotkey`, a `default_filter` ref, a sort order, and (for
  kanban) `column_attr` / `group_by_attr` axes.
- A `filter` card holds a predicate tree plus optional `column_attr` /
  `group_by_attr` / sort state. Filters are the saved presets a screen
  offers.
- `attribute_def` cards define every field (`status`, `assignee`,
  `milestone_ref`, custom attrs). Each carries a `value_type`
  (`enum` | `bool` | `text` | `number` | `date` | `card_ref` |
  `card_ref[]`) and a `bound_to` list of card types. The UI never assumes
  a fixed field set — it renders whatever the schema declares.
- A `workflow_def` card + its `flow_step` children define the state graph;
  the TransitionBar renders available transitions per card.
- Value lists (`status`, `milestone`, `component`, `tag`, `person`) are
  themselves cards, fetched and used as picker options.

Routing (from `client/src/routing/routes.ts`):

| Path | Screen | Shell | Guard |
|---|---|---|---|
| `/login` | Login | no | redirectIfSignedIn |
| `/projects` | Projects (switcher/list) | yes | requireAuth |
| `/activity` | Activity | yes | requireAuth |
| `/project/:id` | → redirect to `…/screen/project` | — | — |
| `/project/:id/screen/:slug` | ScreenHost → kanban/list/grid/project body | yes | requireAuth |
| `/task/:id` | Task detail | yes | requireAuth |
| `/admin/users` | Admin · Users | yes | requireAdmin |
| `/admin/contacts` | Admin · Contacts | yes | requireAdmin |
| `/admin/projects` | Admin · Projects | yes | requireAdmin |
| `/admin/attributes` | Admin · Attributes | yes | requireAdmin |
| `/admin/screens` | Admin · Screens | yes | requireAdmin |
| `/admin/named-filters` | Admin · Named Filters | yes | requireAdmin |
| `/admin/flows` | Admin · Workflows | yes | requireAdmin |
| `/admin/agents` | Admin · Agents | yes | requireAuth |
| `/admin/comm-log` | Admin · Comm Log | yes | requireAdmin |
| `/admin/comm-channels` | Admin · Comm Channels | yes | requireAdmin |
| `/admin/activity-sinks` | Admin · Activity Sinks | yes | requireAdmin |

`ScreenHost` is the key indirection: it resolves the `screen` card by
`(project_id, slug)` and dispatches to the body layout named in the card.
There is no `/kanban` route — kanban is just a screen card whose `layout`
is `kanban`.

---

## App shell (wraps every `shell: true` screen)

- **Purpose:** persistent chrome — project picker, left nav, breadcrumb
  header, help, theme toggle, user menu, toast region.
- **Regions:** left rail (project picker + screen nav links + Admin group),
  top bar (collapse toggle, breadcrumbs, help `?`), body outlet, fixed
  bottom-right toast stack, dev-mode badge.
- **Primary data:** the active project's `screen` cards (drive both the nav
  links and the `g <hotkey>` chords), the projects list (for the picker).
- **Key interactions:** project switch (re-scopes every body screen),
  collapse rail, open keyboard-help overlay, theme toggle, sign out.

---

## MAIN task-interaction screens (detailed mocks in this folder)

### 1. Kanban board (`layout: kanban`)
- **Purpose:** 1-D columns or 2-D (columns × swim-lanes) board over tasks,
  with drag-to-move and drag-to-reorder.
- **Primary data:** tasks (`card.select_with_attributes`, limit 500,
  ordered by `attributes.sort_order`), plus persons / milestones /
  components / tags / statuses for labels and picker options, plus the
  attribute schema. All fetched in ONE coalesced batch.
- **Config off the screen/filter card:** `column_attr` (primary axis; the
  current demo's "Default Kanban" screen defaults to **`milestone`**, not
  `status` — the "Columns by" Picker re-keys live), `group_by_attr` (lane
  axis, default none), predicate. Column `data-column` keys are the value-
  card ids of the grouping attribute (e.g. milestone card ids) + `(unset)`.
- **Key interactions:** pick "Columns by" / "Swim lanes by"; drag a card
  between columns/lanes (issues ONE batch combining `sort_order` + column
  attr + lane attr updates, optimistic with snap-back on error); per-column
  "+" quick-add prefilled to that cell; `n` quick-create; hjkl/arrow board
  navigation; Shift+hjkl to move the focused card; Enter to open.
- See `mock-kanban.md`.

### 2. Task detail (`/task/:id`)
- **Purpose:** full per-card lifecycle — title/description inline edit,
  attribute panel, tags, attachments, transition bar, activity stream,
  comments, related tasks, comms.
- **Primary data:** ONE batch of ~10 sub-requests (task + all-tasks +
  activity + milestones + components + tags + statuses + users + persons +
  transitions + comms + schema).
- **Key interactions:** inline edit title (`e t`) / description (`e d`);
  attribute side panel commits one `attribute.update` per field; tag
  apply/remove (`t`); attachment upload (drag-drop or browse) / delete;
  TransitionBar fire (`c` = first close); post/edit comment (Mod+Enter);
  prev/next through the source list (`j`/`k`, `[`/`]`); set parent (`e p`) /
  add child (`e a`) / new subtask (`e s`); move-to-project, purge.
- See `mock-task-detail.md`.

### 3. Inbox / List (`layout: list`)
- **Purpose:** flat, personally-orderable list of "open work assigned to
  me" (also reused for Comms and any other `list`-layout screen).
- **Primary data:** `inbox.select` (or comm list for the comms slug) +
  persons/milestones/components/tags + schema, ONE batch.
- **Key interactions:** the shared `ScreenFilterBar` (View / NAMED filter /
  GROUP / search + scope / per-attribute filter Pickers / + Add filter /
  Advanced / Clear / Show closed status) — NOT a quick-filter chip strip or
  a separate Mine/All toggle (scope = personal inbox view + Assignee
  filter); drag-reorder (one `user_card_sort.set`, optimistic); `j`/`k`
  select, Shift+`j`/`k` reorder, Enter open; `n` new task; row TransitionBar
  on hover. The System demo user has no assigned tasks → EmptyState.
- See `mock-inbox.md`.

### 4. Grid / Table (`layout: grid`) — covered in `mock-inbox.md` (table variant)
- **Purpose:** dense, sortable, column-configurable table over tasks.
- **Primary data:** same task batch as kanban/inbox.
- **Key interactions:** sortable column headers (server re-issues order);
  quick-filter chips + FilterBar; row select (`j`/`k`), Space to multi-
  select, bulk-action bar (move / purge); Enter open; `/` focus search;
  export menu.

---

## Secondary screens (light mocks in `mock-secondary.md`)

### 5. Projects (switcher + manager)
- **Purpose:** list/grid of projects with open-task counts; create / rename /
  archive; doubles as the project switcher target.
- **Data:** project cards + per-project open counts.
- **Interactions:** search, `j`/`k` select + Enter open, New-project dialog
  (Enter = add another, Mod+Enter = add and close), inline rename pencil.

### 6. Project detail (`layout: project`)
- **Purpose:** landing screen for a project — properties panel + task list +
  New-task.
- **Data:** project card + its tasks.
- **Interactions:** edit project properties, new task, open task.

### 7. Activity
- **Purpose:** global/admin activity stream with a predicate editor.
- **Data:** `activity.select` rows; resolves actor/card ids to names.
- **Interactions:** filter editor, `j`/`k` select, Enter → open the
  referenced task.

### 8. Login
- **Purpose:** standalone (no shell) sign-in. Password and/or OIDC.
- **Data:** none until submit.
- **Interactions:** submit form (validation + error display), OIDC redirect.

### 9. Import wizard (modal/flow off Admin · Projects)
- **Purpose:** multi-step project import (upload → map → preview → commit).
- **Data:** parsed import payload, mapping config.
- **Interactions:** step nav (Back/Next), column mapping pickers, preview
  table, commit (heavy timeout handler).

### Admin family (all master-detail: list pane left, edit pane right)
10. **Users** — accounts + role grants; add person dialog.
11. **Contacts** — email-only persons materialised from comms.
12. **Projects** — project CRUD + import wizard entry.
13. **Attributes** — attribute_def list + editor + "Bound to" card-type
    matrix (bound / order / required per card type).
14. **Screens** — screen cards: layout, slug, hotkey, default filter,
    column/lane axes, sort order.
15. **Named filters** — reusable filter presets (predicate editor).
16. **Workflows** — workflow_def list + flow_step state-graph editor.
17. **Agents** — the calling user's agent identities (sub-assignment).
18. **Comm channels** — IMAP/SMTP channel config + status.
19. **Comm log** — read-only delivery log.
20. **Activity sinks** — outbound activity webhook/sink config.

Every admin screen reuses the same **List pane + Detail pane + Form**
trio (see `controls-and-rules.md`); they differ only in which card type
they list and which `attribute_def`-driven fields the Form renders.
