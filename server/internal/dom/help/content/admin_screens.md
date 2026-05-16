# Screens

A **screen** is one view inside a project. Each screen has a layout (list, grid, kanban, or pair), a slug that appears in its URL, and an optional keyboard hotkey. Tasks themselves are never owned by a screen; the screen just decides how to surface them.

This page is also where **filters** are edited — the right pane lists every filter card parented to the selected screen. The filter section below covers that side of the workflow.

## What lives on a screen

| Attribute        | Purpose                                                                |
| ---------------- | ---------------------------------------------------------------------- |
| `title`          | Display name shown in the sidebar and breadcrumbs.                     |
| `slug`           | URL path segment (`/project/:id/screen/<slug>`).                       |
| `layout`         | Renderer: `list`, `grid`, `kanban`, or `pair`.                         |
| `hotkey`         | Single-key shortcut to jump to the screen.                             |
| `flow_ref`       | Optional flow that supplies the status transitions on this screen.     |
| `default_filter` | Which child filter card loads on first visit.                          |

## Creating a screen

1. Pick the project at the top of the page (the title-bar project picker).
2. In the **center** pane, type a title into the "+ Add screen" combobox and confirm.
3. Set the layout from the dropdown — this decides which renderer mounts when the screen is opened.
4. Optional: give the screen a slug, a one-character hotkey, and bind a flow if the layout shows transitions.

## Sort order

Screens render in the sidebar by `sort_order` then `id`. Drag a screen row to reorder; the change saves the moment you drop.

## Deleting a screen

The trash icon on a screen row removes it and every filter card parented to it. Tasks are never deleted by this operation — only the view definition.

# Filters

A **filter** is a saved view under a screen. The right pane of this admin lists every filter card parented to the selected screen; one of them is the screen's **default filter** and loads automatically when the screen is opened.

## Anatomy of a filter

| Attribute     | Purpose                                                               |
| ------------- | --------------------------------------------------------------------- |
| `title`       | Label that appears in the filter chip bar on the screen.              |
| `predicate`   | The condition tree (AND / OR / NOT of leaves). See below.             |
| `column_attr` | Kanban only: which attribute drives column placement.                 |
| `lane_attr`   | Kanban only: which attribute drives swim-lane rows.                   |
| `sort_order`  | Position in the filter chip bar.                                      |

## Writing a predicate

Predicates are trees, not text. The editor presents each leaf as `<attribute> <operator> <value>` and lets you compose them with **AND**, **OR**, **NOT**. The supported operators are:

| Operator       | Meaning                                              |
| -------------- | ---------------------------------------------------- |
| `=`            | Attribute equals one value.                          |
| `!=`           | Attribute does not equal a value.                    |
| `in`           | Attribute is in a list of values.                    |
| `not in`       | Attribute is not in a list of values.                |
| `exists`       | Attribute is set (any value).                        |
| `not exists`   | Attribute is empty.                                  |
| `contains`     | Text attribute contains the substring.               |
| `not terminal` | Card's phase is not `terminal` (still open).         |
| `has_phase`    | Card's phase is one of `triage`, `active`, `terminal`. |

A bare leaf (e.g. `status = doing`) is valid; you do not need to wrap a single condition in a group.

## Making a filter the default

In the right pane, the "Default filter:" combobox writes `default_filter` on the screen card. Clearing it leaves the screen with no default, and the first filter in `sort_order` is used instead.

Each task screen has its own help button that describes its current default filter in plain English — open any task view and click the help icon next to the keyboard-shortcut "?" to see the live description.

## Related admin pages

- **Flows** (in the sidebar under *Admin*) — author the transition graph a screen can bind to via its `flow_ref` attribute.
