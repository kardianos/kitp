# Agents

An **agent** is a user account that belongs to another user. Agents are how the API surface gets a stable, revocable identity to make calls from automation — a kitp CLI, a Slack bot, a scheduled importer — without leaking your own credentials.

Every agent has:

- A **display name** that shows up wherever activity rows surface (so an automated comment is clearly attributable).
- A **parent user** — the human who owns the agent and is responsible for what it does. You can only see / manage your own agents on this page.
- Zero or more **API tokens**. The token bytes are shown **once** at mint time; revoking is one click but rotation requires a new token.
- Zero or more **role grants** (granted via `/admin/users`, not here).

## Layout

| Pane    | Role                                                                  |
| ------- | --------------------------------------------------------------------- |
| **Left**  | Master list of your agents. "+ New agent" creates an empty agent under your own user. |
| **Right** | Per-agent detail: rename, mint a token, list / revoke existing tokens, delete the agent. |

## Creating an agent

Click **+ New agent**, give it a display name, and confirm. The new agent appears in the list immediately. It has no roles and no tokens until you grant them.

## Minting a token

In the right pane, click **+ New token**, give it a short label (the token will surface under this label in audit logs). The next screen shows the raw token bytes **once**:

> Copy it now. Once you dismiss this dialog, kitp never shows the bytes again — only a hash is stored.

Treat tokens like passwords. Rotate them by minting a new token and revoking the old one rather than reusing one across systems.

## Revoking a token

Click **Revoke** on a token row. The token is invalidated immediately; any in-flight request authenticated with it will fail on next call. A revoked token does not delete the agent — only the credential.

## Granting roles to an agent

Agents inherit nothing from their parent by default — a fresh agent has no roles. Use **Admin · Users**, find the agent in the user list (agents and humans share the same list), and assign roles there with the usual scope picker.

The **parent-grants-subset** rule is enforced server-side: an agent can never hold a role its parent user does not hold at the same scope. If you try to grant a role you yourself don't hold, the assignment is refused.

## Deleting an agent

Deleting an agent removes the user row plus every token. It does **not** delete activity rows the agent produced — those keep pointing at the (now soft-deleted) user, so the audit trail is preserved.

## Related admin pages

- **Users** — assign roles to your agents the same way you'd assign them to a human.
