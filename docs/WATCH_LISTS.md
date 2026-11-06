# Watch lists

Status: built 2026-11-03 on branch `bundles-portals`. Help topic:
`server/internal/dom/help/content/watch_lists.md` (the `?` overlay on
`/watch-lists`).

## Overview

Each account's own bookmark lists of tasks and threads. Every account starts
with **Stars** (★). A list has a symbol, a name and a description, and its
items in the account's own order.

- **Bookmark:** the top corner of a task's or thread's page shows the
  viewer's lists' symbols; hovering slides a name out; a click puts the card
  on that list or takes it off (lit when on). **⋯** opens Watch lists.
- **Manage:** `/watch-lists` (rail user menu → Watch lists; also linked from
  the Account page): lists on the left (+ New list), the picked one's symbol,
  name and description (Save, Delete asks once), and what is on it — drag by
  the handle or ↑ / ↓ to reorder, Remove to take off, each row opening its
  task or thread.
- **Marks:** on the Grid, list rows and Kanban cards, a task or thread on
  one of the viewer's lists has those lists' symbols in front of its title
  (hover names them); each viewer sees their own.
- **Filter:** every task and thread filter has **On my watch list** — *Any of
  my lists* (`@me`) or particular lists, *in* / *not in* — usually with the
  screen's *Active* phase. Calendar feeds and notification subscriptions
  take it too (they compile the same filter).

## Decisions

| # | Decision |
| - | -------- |
| W1 | A list is a card (`watch_list`, global, like `calendar`), owned through `subscriber` = the account's person — the per-user-config-as-cards rule. An agent uses its owner's lists (`account_person`). |
| W2 | What is on a list is a table, `watch_entry (watch_list_id, card_id, sort_order, created_at)`, not a card_ref[] attribute: many-to-many, indexed both ways, cheap to reorder. Bookmarks are the account's, not the card's history: no activity rows (like `user_card_sort`). |
| W3 | Lists are each account's own: `watch_list_owned_by` has no admin exception (an admin cleans up through `card.*`). |
| W4 | Stars is made the first time an account lists its lists (`watch_list.list`), when no list — deleted ones count — ever belonged to its person; so deleting Stars sticks. An advisory lock keeps two first calls from making two. |
| W5 | Only tasks and threads (`comm`) go on a list, and only ones the caller can see, outside switched-off areas. `watch.items` skips (doesn't remove) entries the caller can no longer see. |
| W6 | Order is a fractional `sort_order` the client computes between the item's new neighbours (midpoint, or one past an end), as the inbox's `user_card_sort` does; a new item goes to the top (below the lowest). |
| W7 | Filter leaf `{attr: "watch_list", op: "in" \| "not in", values}`: values are list ids, or a person id meaning any of that person's lists — what `@me` resolves to — so a shared screen filtered on *Any of my lists* shows each viewer their own. Both compilers (`card_compile_predicate.sql`, `where.go` `compileWatchLeaf`) emit `watched_on(c.id, ARRAY[…], <viewer person>)`, which only counts lists private to the viewer (the person the tree is evaluated for: the caller, a calendar's or subscription's owner) — another person's id or list id names nothing (review 2026-11-03 #8). |
| W8 | The filter's option list and "Me" label are data (`attribute-schema.ts`): the field's `meLabel` ("Any of my lists"; person fields keep "Me"), and `DERIVED_OPTION_SOURCES` says its options come from `watch_list.list`, loaded by both the screen filter bar and the standalone filter loader. |
| W9 | Which detail pages show the bookmarks is the detail profile's `watch` flag (task, comm), not a branch in TaskDetail. |
| W10 | The marks ride on the rows: `card.select_with_attributes` takes `with_watch` and adds each row's `watch` (`watch_marks`: the caller's own live lists it is on, `[{id, symbol, title}]` by list id, omitted on none), as `with_approvals` adds `approvals`. The Grid, list and Kanban queries always ask; it isn't a screen column, since the marks are each viewer's own. |

## Detail

### Handlers (all `$authenticated`; the SQL checks the owner)

| Handler | In → out |
| ------- | -------- |
| `watch_list.list` | `{card_id?}` → `{lists: [{id, title, symbol, description, count, has_card}]}`; makes Stars on first use (so not `IsRead`) |
| `watch_list.set` | `{id?, title?, symbol?, description?}` → `{id}`; name 1–60, symbol 1–16 (default ★), description ≤ 1000; changed attributes only, with activity |
| `watch_list.delete` | `{id}` → `{id}`; soft-deletes the card (`card_delete` activity), drops its entries |
| `watch.set` | `{watch_list_id, card_id, on}` → `{on}`; refuses `not_found` (not your list), `card_not_found` (not visible), `validation` (not a task or thread) |
| `watch.items` | `{watch_list_id}` → `{items: [{card_id, card_type, title, task_id, project_id, project_title, status, phase, sort_order, added_at}]}`; `task_id` is a thread's task (where it opens) |
| `watch.move` | `{watch_list_id, card_id, sort_order}` → `{sort_order}`; `not_on_list` when it isn't |
| `card.select_with_attributes` `with_watch` | each row's `watch: [{id, symbol, title}]`, the caller's lists it is on (W10) |

### Schema

- `card_type` `watch_list`; `attribute_def` `symbol` (text); edges title
  (required), subscriber (required), symbol, description; admin `card.*`
  grant. Seed + migration `0026_watch_lists`. Stable counts 23 / 98 / 150.
- `watch_entry` table (DDL, every boot): PK `(watch_list_id, card_id)`,
  indexes `(card_id)` for the filter and `(watch_list_id, sort_order)` for
  the list.
- Functions: `account_person` (was `watch_owner`), `watch_list_owned_by`, `watched_on`, `watch_marks`,
  `watch_list_{list,set,delete}_batch`, `watch_{set,items,move}_batch`.

### Web

- `web/src/watch/specs.ts` — specs, `sortOrderForSlot`, `watchItemHref`,
  `watchListOptions`.
- `web/src/watch/watch-bar.ts` — WatchBar (the corner), mounted by TaskDetail
  when the profile's `watch` is set; the page's Refresh reloads it.
- `web/src/watch/watch-lists.ts` — WatchLists (the screen, `?list=<id>` in the
  address); drag reorder on the shared DnD kit (`DropPlaceholder`,
  `computeDropTarget`), ↑ / ↓ buttons for the keyboard.
- `web/src/watch/marks.ts` — `decodeWatchMarks` (the rows' `watch`) and
  `watchMarks` (the symbols, named on hover), used by the Grid's title cell,
  CardListBody's row (a slot before the subject) and Kanban's card title.
- Route `/watch-lists` (`watch_lists`, help topic `watch_lists`); rail user
  menu entry; Account page section.

## Also in this change

The task page's **Refresh** now re-reads the attachments (and the watch-list
bookmarks) along with links, threads and comments.

## Tests

`server/internal/dom/watch/watch_test.go` (Stars once, owner-only CRUD,
entries, order, refusals, the filter in both compilers, the rows' marks),
`store` 0026;
`web/test/watch-lists.test.mjs` (WatchBar, WatchLists, helpers, filter field,
route, marks), `grid` / `card-list` / `kanban-control` (the marks by a title), `predicate-filter.test.mjs` ("Any of my lists"), `task-detail.test.mjs`
(Refresh).
