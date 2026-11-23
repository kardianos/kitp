# MCP apps

Apps such as Claude can work in kitp over MCP. Each member connects the app
to **one of their own agents**, and the app then acts with that agent's
roles. This screen decides **which apps may ask**.

An app identifies itself with a **client ID**: the web address where it
publishes its details, such as
`https://claude.ai/oauth/claude-code-client-metadata` for Claude Code. kitp
works only with client IDs listed here as **Allowed**. Claude Code's is
allowed out of the box.

## Requests waiting for you

When a member tries to connect an app kitp doesn't trust yet, kitp tells
them so and offers an **Ask an administrator** button. Their request shows
up here first, as **Waiting for an admin**, with who asked, when, and where
the app asked to send them back.

Check that the client ID is the app your members mean to use, such as an
address on `claude.ai` for Claude. Then choose **Allow**. That trusts this
one client ID only. The member connects again from the app, and this time
they see kitp's consent page and pick an agent.

The Claude apps (web, desktop and mobile) don't publish their client ID in
advance. The first member to connect from claude.ai creates this request,
and an admin allows it once.

## Other actions

- **+ Allow a client** adds a client ID before anyone asks. An address
  ending in `/`, such as `https://mcp.example.com/oauth/`, trusts every
  client published under it. Use a prefix only for an address where nobody
  but that company can publish files: anyone who can put a file under it
  can pose as a trusted app.
- **Stop allowing** refuses new sign-ins from the client. Connections
  already made through it end at their next refresh, within the hour.
- **Delete** removes the row. The client is then untrusted again, and a
  member can ask for it again.

To see or end a single member's connection, open that member's agent under
**Agents**: each connection is one of the agent's tokens, named after the
app.
