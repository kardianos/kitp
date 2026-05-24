# Projects

This page is the **admin** view of every project in the system, including templates that the regular `/projects` list hides from end users.

The regular Projects list adds an implicit `is_template != true` filter so end users only see real projects. This admin list omits that filter, so templates and regular projects are both visible side-by-side.

## Columns

| Column      | Purpose                                                                |
| ----------- | ---------------------------------------------------------------------- |
| Title       | Project name. Click to drill into the project's screens.               |
| Template    | A badge that lights up when the project's `is_template` attribute is truthy. |
| `is_template` | Toggle that flips the bit — any user with `attribute.update` rights on the project card_type can switch a project into / out of "template" mode. |
| Created     | Creation timestamp of the project card.                                |

## Template projects

A **template project** is a normal project with its `is_template` attribute set to `true`. Templates do not appear in the user-facing project picker, but they are eligible sources for **Clone from project** when creating a new project. Cloning copies the source project's screens, filters, attribute defs, value cards (statuses, milestones, components, tags), and admin scaffolding — but never its tasks or activity rows.

To turn a project into a template, flip the `is_template` toggle on its row. To demote a template back to a regular project, flip the toggle off. The toggle is non-destructive in both directions.

## Creating a project

Use the **+ New project** button at the top of the page. The dialog asks for:

- A title.
- An optional **Clone from** picker. Pick `(blank)` for an empty project, a template for a scaffolded one, or any existing project for a one-off copy.

The clone respects the parent-side admin scaffolding only — no task data crosses over.

## Deleting a project

Project deletion is destructive — it removes every card parented to the project (tasks, attribute values, comments, attachments). The confirmation dialog lists the row counts so you can sanity-check before confirming.

## Related admin pages

- **Screens** — author the views each project exposes.
- **Flows** — author the transition graphs that screens can bind to.
- **Attributes** — author the attribute defs that screens and filters reference.
