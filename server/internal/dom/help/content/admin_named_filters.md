# Named filters

A **named filter** is a reusable predicate that lives at the project level. Build one here, then drop it into any screen's active filter from the **Named** multi-select (next to the View picker) — or reference it as a leaf inside the Advanced filter editor on any screen.

Think of a named filter as a one-click constraint you compose with the rest of the filter, not a replacement for it. Checking it in the **Named** dropdown ANDs the named filter into whatever predicate the screen is already running.

## Named filters vs. views

| | Named filter (this page)                       | View / preset (Screens admin)                              |
| - | ---------------------------------------------- | ---------------------------------------------------------- |
| Scope | Per project                                    | Per screen                                                 |
| Carries | Predicate only                                 | Predicate + sort + group-by + column attribute + tag-prefix columns |
| How to apply | Check it in **Named** (ANDs into the active filter) | Pick it in the **View** dropdown (replaces the active filter) |
| Composes with other constraints | Yes — multiple checked snippets AND together  | No — one view is active at a time                          |
| Lives in the URL | No                                             | Indirectly via the screen slug                              |

Use a **named filter** when you want a reusable constraint chunk (e.g. "Heads", "Stale > 30 days", "Assigned to me + open"). Use a **view** when you want a complete saved presentation of a screen — predicate, grouping, sort, and column choice in one go.

## Creating a named filter

1. Pick the project at the top of the page (title-bar picker).
2. Click **+ New named filter**.
3. Give it a short, scannable name. The name appears verbatim as a chip on every screen — favour `Heads` over `Open tasks with no parent or terminal parent`.
4. Click **Edit predicate** to open the Advanced filter editor and build the predicate tree (AND / OR / NOT groups, leaves, snippet references — see below).
5. Save.

## Predicate authoring

The same Advanced filter editor used on every screen is used here. A few patterns worth knowing:

- **Heads of an in-progress chain**: open tasks that either have no parent or whose parent is in a terminal state.
  ```
  (Status is open) AND
    ( (Parent Task is not set)
      OR
      (Parent Task parent's status is [Terminal]) )
  ```
- **Compose snippet inside a snippet**: the **Named filter** entry at the top of the attribute combobox lets a snippet reference another snippet by name. Cycles (A → B → A) are detected at query time and surface as an error, so you can't accidentally make the server loop.

The text under each row on this page (the muted line below the name) is a plain-English rendering of the saved predicate — useful for double-checking a snippet does what you think it does.

## Using a named filter on a screen

Two surfaces, same primitive:

- **Named dropdown** (top of every screen's filter bar, next to **View**). Check one or more snippets to AND them into the active predicate. Uncheck to remove. Combines cleanly with the screen's other constraints (status pills, milestone chips, etc.).
- **Advanced editor** → attribute combobox → **Named filter**. Drop a snippet reference at any depth — wrap it in NOT, place it inside an OR, compose with other leaves.

The chip strip on the FilterBar renders each active snippet leaf by its name (`Heads ×`), not by the wire shape. Click the `×` to remove the snippet from the active predicate (equivalent to unchecking it in the **Named** dropdown).

## Editing and deleting

| Action       | What it does                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------- |
| **Edit**     | Opens the title + predicate dialog. Changes propagate to every screen that references the snippet. |
| **Delete**   | Removes the snippet. Filters that referenced it compile to `FALSE` from then on — i.e. they hide every row — so the failure is visible rather than silent. The active filter on the current screen strips the dangling leaf automatically when the deletion lands. |

Renames are safe: snippets are referenced by id, not by name, so changing the name doesn't break anything.

## Wire shape

A named filter is a `predicate_snippet` card parented to the project. It carries two attributes:

| Attribute   | Purpose                                                |
| ----------- | ------------------------------------------------------ |
| `title`     | Display name. Shown in every reference.                |
| `predicate` | JSON-encoded predicate tree (the same shape views use). |

Snippet leaves in any predicate tree carry one wire op:

```
{ "attr": "_snippet", "op": "snippet", "values": ["<snippet card id>"] }
```

The server compiler expands the leaf by fetching the referenced snippet's predicate at query time, with cycle detection and graceful handling of missing references.
