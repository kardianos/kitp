# Areas

Status: built (steps 1–3 below); the Pages tree, more starting points and
Remove are still to do. Follows the feature bundles of
[BUNDLES_AND_PORTALS.md](BUNDLES_AND_PORTALS.md).

Decisions (2026-11-02):

- **Off hides completely**, for everyone, admins included: an area may
  hold sensitive data (health information, legal or personnel matters).
- **"Areas"** is the user-facing word; "Features" is gone from the UI.
- **Turning an area on is admin-only**; a manager or admin can turn one
  off.
- **General stays as is**: configuration no area claims can't be hidden.
- **Sites is its own area**, workspace-wide and separate from Content:
  Content is a project's pages; Sites is portals, themes, public hosts and
  sites shown in kitp.

## Why

A project is configured once, from a template or from feature bundles,
and the copy is the project's own from then on. That is right for the
**contents** of the configuration: a workflow you renamed stays renamed.
But people also want to switch whole **sections** of a project on and off
("this project doesn't do email any more", "hide the content side"), and
the new-project dialog shouldn't need a hard-coded "Also add" list to
offer them.

So a project's configuration is split into **areas**. An area is a kind
of work the project holds, with everything configured for it. Each area
has a switch at the project's top level, and its configuration is seeded
from a **starting point** (a template for that one area) the first time
it is turned on.

- A starting point is a seed: copied once, then the project's own.
- A switch is ongoing: on or off, any time.

## Words

| Word | Meaning |
| ---- | ------- |
| **Area** (user-facing) | A switchable section of a project: Tasks, Conversations, Content, Approvals. Replaces "Features" in the UI. |
| **Starting point** | One way to seed an area: a feature bundle file (`db/schema/bundles/`). Today: Tasks from *Task tracking* or *Help desk*, Conversations from *Conversations*, Content from *Publishing*. |
| **Shortcut** | A named set of areas and starting points for the new-project dialog (Issue tracker, Help desk, Shared inbox, Content management). Today's presets. |

In code, the bundle files, `card_origin` and `bundle_apply` keep their
names: a bundle is a starting point's file. The catalog gains the area
each bundle belongs to.

## What belongs to an area

An area is defined by the kind of item it holds, so membership is mostly
derived rather than tagged by hand:

| Area | Scope | Item types | Workflow | Screens | Other |
| ---- | ----- | ---------- | -------- | ------- | ----- |
| Tasks | project | task, link | `status` | Inbox, Grid, Kanban … | snippets, views |
| Conversations | project | comm, comm_channel | `comm_status` | Incoming, Comms | mail accounts; threads can stand on their own ([CONVERSATIONS.md](CONVERSATIONS.md)) |
| Approvals | project | approval | — | the Approvals column and views | needs Tasks |
| Content | project | page | `publish_status` | Pages | the project's pages on portals |
| Sites | workspace | portal, theme | — | Admin → Portals, Themes; SITES | public hosts, sites in kitp |

- **Data** belongs by item type: a comm is Conversations, a page is
  Content. That is cheap to check in SQL (item type → area).
- **Configuration** — workflows, statuses, screens, views — carries an
  `area` value, stamped when it is copied from a starting point (the
  bundle knows its area) and inferred when it is created: a screen takes
  the area of the workflow it names, a status the area of its workflow, a
  view the area of its screen. Anything that can't be inferred (a saved
  snippet, an activity sink) asks for an area when it is created, or
  belongs to **General**, which can't be turned off.
- **Dependencies** are part of the area's definition: Approvals live on
  tasks. Turning it on turns Tasks on; turning Tasks off is refused while
  a dependent area is on. (Conversations needed Tasks until threads could
  stand on their own; see [CONVERSATIONS.md](CONVERSATIONS.md).)

Areas are code-owned like bundles: `db/schema/bundles/areas.hcsv` lists
each area's key, title, scope, description, item types, dependencies and
starting points, and the bundle tier writes it into the `area` table at
every boot. The loader checks that an item type belongs to one area, that
dependencies stay within a scope, and that each starting point is a
feature bundle that starts one area only.

**As built**, configuration is hidden from the sidebar rather than from
every read: `area.list` reports which of a project's screens belong to
each area (by the item type their workflow drives), and the sidebar drops
the screens of an area that is off. The server hides the area's **data**
(its items and everything under them). A screen's or status's name is
configuration, not data; if one ever needs hiding, the next step is an
`area` value on configuration cards, as above.

## Off means hidden completely

An area that is off is **gone** for everyone, admins included, because it
may hold sensitive data (health information, legal matters, personnel
cases). Hiding it in the UI is not enough; the server enforces it.

**The visibility rule.** DI-6's predicate gains one condition:
`card_in_off_area(card)` — true when the card, or a card above it (a comm
on a task, the page an attachment belongs to), has an item type of an
area that is off in the project it chains up to, or of a workspace area
that is off. `card_visible_to`, `schema.VisibilityClause` and every
inline DI-6 read (card select / search / select_with_attributes,
activity select / poll, links, comms for a task, the unread-comms count)
AND NOT it, so card reads, search, activity, comments, comms, MCP tools
and agents hide the area's data together. A message (reply_body, which
has no parent card) is hidden with its thread. When no area is off
anywhere, the check costs nothing per row (it is answered once per query).
The same holds where cards leave a project another way: the export names
no card that is off (a thread's subject, say), a thread's approval request
is left out while Approvals is off, and stamping a template copies none of
its cards in an area it has off — in the new project, where the area is
on, the copy would show (review 2026-11-06 #9, L4, L6).

What else "off" does:

| Surface | When the area is off |
| ------- | -------------------- |
| Screens | Gone from the sidebar; a saved address answers "not found", not "hidden". |
| Item references | A reference from another area (a task linking a page) shows no title, only the id: the title can be the sensitive part. (A "Hidden item" label is still to do.) |
| Detail sections | Hidden (no email threads on a task while Conversations is off). |
| Search, activity, notifications | Nothing from the area: no results, no feed rows, no emails, no sink pushes. Activity of one area recorded on another's card counts too: an approval vote (on the task) is hidden with Approvals (`activity_hidden`). |
| Exports | The area's items are left out (project export filters its tasks and activity). |
| Attachments | An attachment of a hidden card answers "not found". |
| Automation | Paused: a mail account of a project with Conversations off gets no worker, so no intake (messages stay in the mailbox) and no outbound mail; replies queued on a thread in an area that is off wait until it's back on. With Tasks off, a task-mode account files new mail as threads on their own instead of hidden tasks. Activity sinks skip the area's activity. |
| Portals | Content off: the project's pages stop being served at once (serving re-checks each page) and leave the build at the next one; the publication snapshots are kept, so turning Content back on restores the sites without republishing. Sites off: nothing is built, served (public, preview, in kitp), listed or changed; the portals stay dirty and build when Sites is back on. |
| Writes | Refused (`area_off`): the dispatcher's authorization pass checks `area_write_blocked` for every gated write — the card type, the target card and the project — once any area is off, plus the area a handler names for itself (the approval handlers gate on the task but write Approvals). A move into an area that is off is refused too. |

Turning an area **on** again restores everything as it was: data,
configuration, publications. It never re-copies the starting point.

**Who can switch.** Turning an area off is a manager or admin action on
the project. Turning one on exposes what it holds, so it is admin-only
(bundle.apply, which can set an area up, is admin-only too). A project's
switch writes an activity row on the project: who, when, which area. The
workspace's Sites has no card to carry one; its switch row records who
and when. The Areas settings show each area's state, its last switch
("Switched off 2026-11-02 by Dana") and, to admins only, how many items
it hides.

## Removing an area

Off is the normal way out and is always reversible. **Remove** is a
separate, deliberate action: it deletes only the area's items that
nothing else uses, and lists what is in the way first ("12 tasks are in
its statuses; 3 views use its screens"). An area with data in it can't be
removed, only turned off.

## Screens

**New project.** The dialog lists every area from the catalog; nothing in
it is hard-coded:

```
Name  [ Acme docs                ]

Areas
[x] Tasks           start from (Task tracking ▾)
[ ] Conversations   email threads, on tasks or on their own
[x] Content         start from (Publishing ▾) · pages published to portals
[ ] Approvals       needs Tasks

Shortcuts:  Issue tracker · Help desk · Shared inbox · Content management
```

A shortcut only ticks boxes and picks starting points.

**Project settings → Areas.** The same list with on / off switches, the
starting point each area came from, and "Content v3 has new items: add
them" when a starting point has grown (a merge that never changes what the
project edited). Changing an area's starting point later is that same
merge ("add what's missing from Help desk"); replacing it is not offered.
A re-apply only adds: a status, screen or flow step the project removed
stays removed.

**Sidebar.** Screens are grouped under their area's heading — TASKS
(Inbox, Grid, Kanban), CONVERSATIONS (Incoming), CONTENT (Pages) — instead
of every screen under TASKS.

## Content: pages as a tree

The Content area's Pages screen lists pages **as their tree**, not a flat
list with a parent label:

- each page under its parent, indented, in site order, with its children
  collapsible;
- pages are **movable** there: drag a page onto another to nest it, drag
  between siblings to reorder, or use **Move to…** (keyboard and touch);
  a move takes the page's whole subtree with it and never lands a page
  under its own children;
- the same parent / child relationship is what the page detail's PLACE
  IN SITE shows (trail, Under, child pages with ↑ / ↓): the Pages screen
  and the detail edit one tree.

Moves and reorders are edits like any other: they reach a site when the
page is published again.

## Upgrading an existing install

No area rows are written: an upgraded install has no `project_area` or
`workspace_area` rows, so nothing is off and nothing is hidden. Each
area's state is worked out from what the project already has
(`area_present`): a starting point it used, the area's items, or its own
status flow for them. The last covers projects copied from a template or
created before areas, which have their statuses and screens without a
starting point, and sometimes without items yet.

What a project from before areas shows (checked by upgrading a database
made by master, with its demo data):

| Area | Shows |
| ---- | ----- |
| Tasks | On (its task flow and screens came from its template) |
| Conversations | On (its comm flow and Comms screen came from its template) |
| Approvals | On once it holds an approval, else Not set up |
| Content | Not set up (pages are new); Set up adds the publish flow, the Pages screen and a starter page |
| Sites (workspace) | On |

The sidebar groups the project's existing screens under their areas.
Switching an area on never adds a starting point to an area the project
already has, so an old project can switch Tasks off and on again, and set
up Approvals (which switches Tasks on first), without a second status
flow.

## As built

| Piece | Where |
| ----- | ----- |
| Catalog | `db/schema/bundles/areas.hcsv` → `area` table (`store.applyAreas`) |
| Switches | `project_area (project_id, area_key, state)`, `workspace_area (area_key, state)`; no row = on |
| State | `area_state(project, key)`: the row, else `on` if the project already has the area (`area_present`: it used one of its starting points, holds its items, or has its own status flow for them), else `unused` |
| Rule | `card_in_off_area`, `area_write_blocked`, `workspace_area_off` |
| Handlers | `area.list {project_id?}` (no project: the whole catalog, workspace areas with their state), `area.set {project_id?, key, on, start?}`; `project.compose` takes `areas_off` |
| UI | the sidebar's PROJECT → Areas, for the active project (managers and admins; also in Edit properties → AREAS where a project has an overview screen); WORKSPACE → Areas (Sites); the sidebar groups screens by area; the new-project dialog's "Choose areas…" |

Turning an area on turns on the areas it needs and adds a starting point
to any the project doesn't have yet (the one picked, else the area's
default).
Turning one off is refused while an area that needs it is on
(`area_needed`). Each project switch writes an `area_set` activity row on
the project and rebuilds the portals holding its pages; area.list reports
every area's last switch (state, when, who), the workspace's Sites
included.

## Order of work

1. **Area state and enforcement** — done. (The switches are rows in
   `project_area` / `workspace_area`, not cards: the visibility rule reads
   them on every row, so they are a small keyed table; the audit trail is
   the `area_set` activity row.)
2. **Sidebar and detail by area** — done: screens grouped by area, detail
   sections hidden with their area. References to a hidden item still
   show its id; "Hidden item" is to do.
3. **New-project dialog from the catalog** — done: areas with starting
   points, presets as shortcuts; "Also add" is gone.
4. **Pages as a tree** with moving and reordering (independent of 1–3;
   can come first).
5. **More starting points** per area, and the "add what's new" merge.
6. **Remove**, behind the in-use check.

## Open questions

None open: see Decisions at the top.
