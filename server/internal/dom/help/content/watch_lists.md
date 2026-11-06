# Watch lists

Your own bookmark lists of tasks and threads. Every account starts with **Stars** (★); add as many lists as you like — *Waiting on others* ⏳, *This week* 📅, *Read later* 📖. Only you see your lists — not your teammates, not an admin — and nothing about a task changes when you put it on one.

## Putting things on a list

Each task and thread shows your lists' symbols in the top corner of its page, beside its number. Point at a symbol to see the list's name; click it to put the task on that list (the symbol lights up) and click again to take it off. The **⋯** after them opens this screen.

New items go to the top of the list.

## Spotting them on a screen

On a grid, a list and a board, a task or thread on one of your lists has those lists' symbols in front of its title — ★ for Stars, 🔥 for a list whose symbol is 🔥 — so it stands out as you scroll. Point at them to see the lists' names. They are yours: a teammate looking at the same screen sees their own.

## This screen

- **Your lists** (left), oldest first, with how many items each holds. Pick one to see it; **+ New list** adds one (rename it straight away).
- **The list** (right): its **Symbol** (pick one of the emoji under the box, or type any emoji or character, up to 16 — it is what you click on a task), **Name** and **Description**; **Save** keeps them, **Delete list** asks once, then removes the list (what was on it isn't touched). Deleting Stars is fine — it doesn't come back.
- **What is on it**, in your order: drag a row by its handle (⋮⋮), or use ↑ / ↓, to move it; **Remove** takes it off. Each row opens its task or thread and shows its project and status. Something you can no longer see (its project was closed to you, or its area switched off) isn't listed.

The page address keeps the list you picked (`/watch-lists?list=<id>`), so you can bookmark it.

## Filtering on a list

Any screen's filter (**Advanced**) has **On my watch list**: *Any of my lists*, or one or more of your lists, with *is in* or *is not in*. Combine it with the screen's phase toggles — *Active* is the usual one — to work through what you're watching that's still open. Saved on a shared screen, *Any of my lists* means each viewer's own lists.

The same filter works in a calendar feed (Account → Calendars) and a notification subscription, so *Stars, due this month* or *mail me about what I'm watching* are one filter away.

## For agents and the API

`watch_list.list` / `.set` / `.delete` manage your lists, `watch.set` puts a card on one, `watch.items` reads one in order, `watch.move` sets an item's place (`sort_order`, between its neighbours). The card filter leaf is `{attr: "watch_list", op: "in", values: ["@me"]}`; `card.select_with_attributes` with `with_watch: true` adds each row's `watch` — your lists it is on, `[{id, symbol, title}]`. An agent uses its owner's lists.
