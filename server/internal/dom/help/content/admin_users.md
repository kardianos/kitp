# Users

Manage the people (and their agents) that can sign in to this kitp instance, plus the roles each user holds.

The roles model is **scoped grants**: a role assignment may be global (`scope_project_id` is null, so the role applies everywhere) or scoped to a single project (the role only applies inside that project). The `parent-grants-subset` rule means a user can only grant roles they themselves hold at the chosen scope.

## Master / detail layout

| Pane         | Role                                                                     |
| ------------ | ------------------------------------------------------------------------ |
| **Left**     | Searchable list of every user (display name + email). Filter by role to narrow. |
| **Right**    | Selected user header, table of role assignments with per-row **Revoke**, an inline **+ Assign role** form, and a **CSV export** button. |

## Assigning a role

Open a user and use the **+ Assign role** form:

1. Pick a role from the dropdown (roles authored elsewhere — they appear here only after the role itself has been registered).
2. Pick a **scope** — either *Global* or a specific project.
3. Click **Assign**. The grant is checked server-side against the parent-grants-subset rule; an admin granting roles they don't hold globally will see a refusal toast.

A user can hold the same role twice if the scopes differ — e.g. `viewer` globally plus `editor` on one project.

## Revoking

Click **Revoke** on any role row to remove that single grant. The user's other assignments are untouched.

## CSV export

The **CSV export** button on the user detail header downloads a flat dump of every role assignment in the system — one row per `(user, role, scope)` triple. Useful for compliance review and for diff-ing role state across environments.

## Agents

Agents are users with `is_agent=true` and a `parent_user_id` pointing at a human owner. They're authored on **Admin · Agents**, not here, but their role grants flow through this same screen: an agent appears in the user list just like any other user, and you can grant scoped roles to it the same way.

The parent-grants-subset rule is enforced on agent targets too — an agent can never hold a role its parent user does not hold at the same scope.

## Related admin pages

- **Agents** — your own agents and their tokens.
- **Projects** — the scope picker on the **+ Assign role** form lists every project visible here.
