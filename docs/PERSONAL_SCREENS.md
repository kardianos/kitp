# Personal screens, personal views, private cards

Status: designed 2026-11-03 on branch `bundles-portals`; being built. This
file is the source of truth: read it before touching the pieces below, tick
the checklist at the end as parts land, and change this file in the same
edit if the code has to differ.

## Overview

Until now every screen and every saved view belonged to a project and
everyone in it saw them; watch lists were readable by anyone who could list
`watch_list` cards. This adds:

| # | Piece | One line |
|---|-------|----------|
| 1 | **Private cards** | `card.private_to` (a person): such a card — and anything under it — is visible to and writable by that person's accounts only (their login and their agents). No admin exception. |
| 2 | **Private watch lists** | Watch lists become private cards (migration backfill). |
| 3 | **Personal screens** | Your own screens, across every project you can see by default: a list or grid of tasks or threads with a base filter, which may limit it to some projects (*only these* / *all but these*). Listed in the left navigation under **Mine**. |
| 4 | **Personal views** | "Save as my view" on any screen's View picker: a saved view only you see, on a shared project screen or your own screen; one can be **my default** on that screen. |
| 5 | **My screens page** | User menu → My screens: your screens (settings, order, delete) and your views on shared screens (rename, delete, open). |

## Decisions

| # | Decision |
| - | -------- |
| P1 | Privacy is a card column, `private_to bigint NULL REFERENCES card(id)` (a person card). Structural like `parent_card_id` / `deleted_at`, because the read predicate checks it on every row; one PK lookup, no attribute join. |
| P2 | A private card is visible only to its person's accounts: the login linked to the person (`user_account_person`) and that login's agents (an agent sees what its owner sees) — `account_person(actor)`. Nobody else, admins included. |
| P3 | Privacy is inherited: a card inserted under a private parent gets the parent's `private_to` (a view under a personal screen). Every private card carries its own `private_to`, so the check never walks the chain. |
| P4 | Reads: `schema.VisibilityClause` and `card_visible_to` answer "private → owner only; else the old rule". The SQL listing copies that can surface private card types — `card.select_with_attributes`, `card.select`, `card.search`, `activity.select`, `activity.poll` — AND `card_private_ok(card, actor)`. The other copies (comms, links, portals, subscriptions, actors, unseen count, user_sees_project) never list private card types, so they are unchanged. `attribute.update` refuses a reference to a private card from a card that isn't private to the same person (`private_ref`), so a shared screen can't default to someone's own view. |
| P5 | Writes: the dispatcher's authz pass (`checkPrivate`, before `authorizeLeaf`) looks at the target card and its ancestors: private to someone else → refused (`unauthorized`, whatever roles the actor holds); private to the actor → allowed without a role grant (a personal screen has no project to hold one on) — for the card-local writes only (`card.insert` / `delete` / `undelete` / `move` / `merge`, `attribute.update`; `ownedPrivateWrites`), and `card.merge` itself refuses losers in another project or of another privacy; `card.insert {private: true}` likewise (the SQL checks the parent is a screen the actor can see). `card.insert`, `card.delete` and `attribute.update` let every project role through the role gate (`reg.ProjectRoles`) so a viewer or commenter can keep views: they hold no create / update / delete grant, so the per-row pass still refuses them everything else. |
| P6 | Watch lists: `private_to` = their subscriber, set on create and backfilled by migration. `watch_list_owned_by` keeps checking the subscriber. |
| P7 | A personal screen is a `screen` card with no parent and `private_to` = you, made by `my_screen.set` (the `screen` type's parent is `project`, so `card.insert` can't make one). Attributes: `title`, `layout` (`list` \| `grid`; no kanban — its columns are one project's statuses), `list_card_type` (`task` \| `comm`), `predicate` (the base filter, screen-filter JSON), `sort_order` (Mine order), `toggle_groups` (the phase toggles, seeded Active on), `extra_columns`, `default_filter`. |
| P8 | Project scope is part of the base filter: a new derived filter field **Project** (`attr: project`, *in* / *not in* over project ids; both compilers: `card_enclosing_project(c.id)`). No project leaf = every project you can see. |
| P9 | A personal screen renders through the same ScreenHost, filter bar and bodies. Its rows and lookups run with no project: the host gives its children a context whose `scope` is `{projectId: null, allProjects: true}`, and the list/grid bindings skip only when both `projectId` and `allProjects` are unset (`skipWhenNull: ['projectId\|allProjects']`). No "+ New" (there's no project to put a card in). |
| P10 | A personal view is a `filter` card with `private_to` = you, under any screen: `card.insert {…, private: true}`. **My default** is a `my_default` bool on your private view; on a shared screen it wins over the screen's `default_filter` for you. On your own screen you set the screen's `default_filter` itself. |
| P11 | Routes: `/my/:id` (a personal screen; help topic `layout.<layout>`), `/my-screens` (the page). The rail's **Mine** section lists your screens (`my_screen.list`) and is hidden when you have none; you make one on **My screens** (user menu). |

## Detail

### Server

- `card.private_to` (schema.hcsv; preDDL `ALTER TABLE card ADD COLUMN IF
  NOT EXISTS private_to bigint`), index on it (partial, not null).
- `account_person(actor)` replaces `watch_owner` (same body); `card_private_ok(card, actor)`.
- `card_insert_batch`: inherit the parent's `private_to`; `private: true`
  sets it to `account_person(actor)` (refused for an account with no person).
- `my_screen.list` → `{screens: [{id, title, layout, list_card_type,
  predicate, sort_order, view_count}]}`; `my_screen.set {id?, title?,
  layout?, list_card_type?, predicate?, sort_order?}` → `{id}`;
  `my_screen.delete {id}` → soft-deletes it and its views.
- attribute_defs `list_card_type` (text), `my_default` (bool); edges
  `screen.list_card_type`, `filter.my_default`; migration
  `0028_personal_screens` (+ watch-list backfill).
- `card.select_with_attributes` output row: `private: true` on a private
  card (only its owner ever sees one).

### Web

- `Control.spawn(type, config, host, ctx?)` — a child with a derived context.
- `data.ts` `skipWhenNull` entries may be `a|b` (skip when all are null).
- `cardlist/core.ts`, `grid/grid.ts` bindings: `allProjects: { from:
  'scope.allProjects' }` beside every `projectId: { from: 'scope.projectId' }`.
- `filter/screen-resolve.ts` `loadPersonalScreen(api, id, …)` → the same
  `ScreenPresetSet` (cardType / phaseAttr from `list_card_type`).
- ScreenHost `personalScreenId` config: resolves through it, lands at
  `screens.mine.<id>`, spawns children with the all-projects context, and
  publishes the base filter as `screen.scopeTree` (every other screen
  resets it to null); the list and grid AND it into each query
  (`withScopeTree`).
- Rail **Mine** section; route `/my/:id` and `/my-screens`; user menu "My
  screens"; a personal screen's ⚙ settings (name, layout, list, projects —
  every / only these / all but these — and delete). Narrowing beyond the
  projects is a saved view on the screen, set as its default.
- Filter editor: a derived **Project** field (tasks and threads), options
  from the visible projects (`DERIVED_OPTION_SOURCES`).
- Help: `my_screens.md` (both routes), a note in `layout_{list,grid,kanban}.md`.
- View picker: "Save as my view", a 🔒 mark on yours, "Make my default".

## Build checklist

- [x] Private cards: column, account_person, card_private_ok, visibility (Go + SQL copies), authz, insert inheritance, private_ref, tests
- [x] Watch lists private (create + backfill), tests
- [x] Project filter leaf (both compilers), tests
- [x] my_screen.* handlers, attributes, migration 0028, tests
- [x] Personal views (private insert, my_default), tests
- [x] Web: spawn ctx, skip alternatives, bindings, loadPersonalScreen, ScreenHost mode, scopeTree, routes, rail Mine, settings, My screens page, View picker, Project filter field
- [ ] Help topics, docs; full Go + web suites; commit, push; review agent
