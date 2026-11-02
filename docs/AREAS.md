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
| **Starting point** | One way to seed an area: Tasks from *Simple* or *Software*, Content from *Docs site* or *Blog*. Today's feature bundle files become starting points. |
| **Shortcut** | A named set of areas and starting points for the new-project dialog (Issue tracker, Customer care, Content site). Today's presets. |

In code, the bundle files, `card_origin` and `bundle_apply` keep their
names: a bundle is a starting point's file. The catalog gains the area
each bundle belongs to.

## What belongs to an area

An area is defined by the kind of item it holds, so membership is mostly
derived rather than tagged by hand:

| Area | Scope | Item types | Workflow | Screens | Other |
| ---- | ----- | ---------- | -------- | ------- | ----- |
| Tasks | project | task, link | `status` | Inbox, Grid, Kanban … | snippets, views |
| Conversations | project | comm, comm_channel | `comm_status` | Incoming, Comms | mail accounts; needs Tasks |
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
- **Dependencies** are part of the area's definition: Conversations and
  Approvals live on tasks. Turning one on turns Tasks on; turning Tasks
  off is refused while a dependent area is on.

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
and agents hide the area's data together. When no area is off anywhere,
the function answers false without walking the card's parents.

What else "off" does:

| Surface | When the area is off |
| ------- | -------------------- |
| Screens | Gone from the sidebar; a saved address answers "not found", not "hidden". |
| Item references | A reference from another area (a task linking a page) shows "Hidden item" with no title: the title can be the sensitive part. |
| Detail sections | Hidden (no email threads on a task while Conversations is off). |
| Search, activity, notifications | Nothing from the area: no results, no feed rows, no emails, no sink pushes. |
| Exports | The area's items are left out (project export filters its tasks and activity). |
| Attachments | An attachment of a hidden card answers "not found". |
| Automation | Paused: a mail account of a project with Conversations off gets no worker, so no intake (messages stay in the mailbox) and no outbound mail; activity sinks skip the area's activity. |
| Portals | Content off: the project's pages come off every site at the next build; the publication snapshots are kept, so turning Content back on restores the sites without republishing. Sites off: nothing is built, served (public, preview, in kitp), listed or changed; the portals stay dirty and build when Sites is back on. |
| Writes | Refused (`area_off`): the dispatcher's authorization pass checks `area_write_blocked` for every gated write — the card type, the target card and the project — once any area is off. |

Turning an area **on** again restores everything as it was: data,
configuration, publications. It never re-copies the starting point.

**Who can switch.** Turning an area off is a manager or admin action on
the project. Turning one on exposes what it holds, so it is admin-only by
default (configurable later). Both write an activity row on the project:
who, when, which area. The Areas settings show an area's state and, to
admins only, how many items it hides.

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
[x] Tasks           start from (Simple ▾)
[ ] Conversations   needs Tasks · email threads on tasks
[x] Content         start from (Docs site ▾) · pages published to portals
[ ] Approvals       needs Tasks

Shortcuts:  Issue tracker · Customer care · Content site
```

A shortcut only ticks boxes and picks starting points.

**Project settings → Areas.** The same list with on / off switches, the
starting point each area came from, and "Content v3 has new items: add
them" when a starting point has grown (a merge that never changes what the
project edited). Changing an area's starting point later is that same
merge ("add what's missing from Software"); replacing it is not offered.

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

## Migration from feature bundles

- Every existing project gets an area row per area it has data or
  configuration for (from `card_origin`, and from the item types it
  holds), all **on**. Nothing changes for anyone until someone turns an
  area off.
- Configuration copied from a bundle gets its `area` from the bundle;
  configuration a project made itself is inferred as above, and whatever
  can't be inferred goes to General.
- The Features section and the dialog's "Also add" become the Areas
  section and list.

## As built

| Piece | Where |
| ----- | ----- |
| Catalog | `db/schema/bundles/areas.hcsv` → `area` table (`store.applyAreas`) |
| Switches | `project_area (project_id, area_key, state)`, `workspace_area (area_key, state)`; no row = on |
| State | `area_state(project, key)`: the row, else `on` if the project holds the area's items or used one of its starting points, else `unused` |
| Rule | `card_in_off_area`, `area_write_blocked`, `workspace_area_off` |
| Handlers | `area.list {project_id?}` (no project: the whole catalog, workspace areas with their state), `area.set {project_id?, key, on, start?}`; `project.compose` takes `areas_off` |
| UI | project properties → AREAS; Admin → Areas (Sites); the sidebar groups screens by area; the new-project dialog's "Choose areas…" |

Turning an area on turns on the areas it needs and adds a starting point
to any that never had one (the one picked, else the area's default).
Turning one off is refused while an area that needs it is on
(`area_needed`). Each switch writes an `area_set` activity row on the
project and rebuilds the portals holding its pages.

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
