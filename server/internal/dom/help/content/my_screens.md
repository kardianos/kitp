# My screens

Screens and views that are yours alone. Nobody else sees them — not your teammates, not an admin.

## Personal screens

A personal screen lists **tasks** or **threads** across **every project you can see**, as a **list** or a **grid**. It sits in the left navigation under **Mine**, in your order.

- **+ New screen** (under Mine, or here) makes one and opens its settings.
- **Screen settings** (⚙ on the screen, or **Settings** here): its **Name**, **Layout** (list or grid — not a board, whose columns are one project's statuses), what it **Lists**, and its **Projects**: *every project I can see* (the default), *only these*, or *all but these* — handy to leave out a project a screen makes no sense for. New projects join automatically under *every project* and *all but these*.
- On the screen, the filter bar works as everywhere: phase toggles (Active is on), search, **Advanced**, sort and group. Save what you set up as a view (**View → Save current as new view…**) and make one the screen's default (**Set as default**), so the screen opens that way — e.g. *On my watch list: any of my lists*, Active.
- ↑ / ↓ here moves a screen in Mine; **Delete screen** removes it and its views (the tasks it listed are untouched).

There's no **+ New** on a personal screen: it has no project to put a task in.

## Your views on project screens

On any project's screen, **View → Save as my view…** keeps the current filter as a view only you see, marked 🔒 in the View list. **Make my default** opens that screen with your view for you, leaving everyone else's default alone. They're listed here under *Your views on project screens*, with **Rename** and **Delete**.

## For agents and the API

`my_screen.list` / `.set` / `.delete` manage personal screens (`predicate` is the base filter: `{attr: "project", op: "in" | "not in", values: [ids]}` limits the projects). A view is a `filter` card: `card.insert {card_type_name: "filter", parent_card_id: <screen>, private: true}` on a project screen; under your own screen every view is private anyway. An agent's screens and views are its owner's.
