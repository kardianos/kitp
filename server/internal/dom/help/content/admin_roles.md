# Roles

This screen is a read-only **overview** of the built-in roles and the
`(card type, action)` grants each one carries. Grants are seed-managed, so they
can't be edited here. To control who gets which role at sign-in, use the
**OIDC Claims** screen (it maps an OIDC group/claim value to a role).

A user can hold more than one role; their effective permissions are the union.
Roles are scoped either globally or to a single project (a project-scoped
`manager` only manages that project).

## What each role can do in the app

| Role | In the UI they can… |
| --- | --- |
| **viewer** | Read cards they have visibility to. No writing. |
| **commenter** | Everything a viewer can, plus **post comments** on tasks. |
| **worker** | Everything a commenter can, plus **create and edit tasks**, set a task's status / assignee / milestone / component / tags (assigning *existing* values), reorder their lists, send and reply to comms, and add people/contacts. A worker can create projects, screens, and saved filters. A worker **cannot** curate the value lists themselves (see Values below). |
| **manager** | Everything a worker can, plus **edit the Values screen** — create, rename, and delete the allowed milestones, components, and tags for the project. Managers are the per-project curators of the option lists workers pick from. |
| **admin** | Everything, plus the full **workspace configuration**: People, Projects, Roles, OIDC Claims, Attributes, Agents, Workflows, and the comm/activity integrations. Admins can also manage statuses and any card type. |

## worker vs. manager (the key difference)

Workers and managers do the same day-to-day task work. The one difference is
**who curates the option lists**:

- A **worker** can put a task *into* the "Done" milestone or tag it `area/api`
  — they assign values that already exist.
- A **manager** can **add, rename, or remove** the milestones / components /
  tags those values come from, on the **Values** screen. Workers don't see
  that screen, and the server rejects value-card edits from a worker.

## Grants (read-only)

Each role lists its grants as `(card type · action)` badges. These come from
the declarative seed; changing them is a server/schema change, not a UI action.
