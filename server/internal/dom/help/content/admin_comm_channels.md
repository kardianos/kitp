# Comm channels

A **comm channel** configures one external messaging system for a project. In v1 a channel is an email account — IMAP for inbound, SMTP for outbound — and tasks created from email arrive via the channel's inbound side.

Channels are project-scoped: pick the project in the title-bar picker before authoring or editing.

## What lives on a channel

| Group              | Fields                                                                  |
| ------------------ | ----------------------------------------------------------------------- |
| Identity           | `name`, `channel_kind` (v1: `email`).                                   |
| Inbound (IMAP)     | host, port, username, password, mailbox, TLS settings.                  |
| Outbound (SMTP)    | host, port, username, password, TLS settings.                           |
| Operational        | `channel_status`, `channel_fault_reason` (set by the runtime on failure). |

Password fields are **write-only**. The list endpoint returns `has_inbound_password` / `has_outbound_password` booleans so the form can show "configured" without ever revealing the encrypted bytes. Leaving a password input blank on edit keeps the stored value; submit an explicit empty string only when you want to clear it.

## Status

`channel_status` is tri-state:

- **Enabled** — both pollers and the outbound sender are active.
- **Paused** — the channel is suspended administratively. Use this when you need to take an account offline for maintenance.
- **Fault** — the runtime flipped the channel off because a connect/auth failed. `channel_fault_reason` carries the diagnostic. Re-enabling clears it; the next poll cycle will reattempt.

## Inbound mail flow

The inbound poller checks the configured mailbox at a fixed interval, fetches new messages, and routes each to a domain handler:

1. If the message replies to a previous outbound (it carries the in-reply-to header we minted), the body lands as a `comment` on the original task.
2. Otherwise, the message body becomes a new `task` in the channel's project. The sender is upserted as a `person` card and bound to the task via `created_by`.

Attachments are stored in the CAS and linked to the resulting task / comment.

## Outbound mail flow

When a card surfaces an outbound mail action (a comment with a recipient list, a custom flow step that emits mail), the SMTP side of the channel is the transport. The runtime stamps an in-reply-to header so any reply lands back on the same card.

## Related admin pages

- **Comm log** — read-only stream of every comm event (inbound, outbound, fault). The first stop when debugging a channel that's not delivering.
- **Activity sinks** — different direction: push activity rows *out* to a Teams channel rather than route email *in*.
