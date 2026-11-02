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

## Settings

| Setting | What it does |
| ------- | ------------ |
| **New mail** | What a message that isn't a reply to a thread becomes: *creates a task and a thread*, *creates a thread only* (a thread on its own in the project, to answer, attach to a task later, or not), or *is ignored* (only replies to existing threads come in). An account saved before this setting keeps what it did: a task when it has a new task status, else ignored. |
| **New task status** | The status a task created from new mail starts in; blank uses the project's task flow default. |
| **Quoting in replies** | Whether a reply carries the conversation below it: *off*, *last message* (the default) or *whole conversation*. Each earlier message is quoted as `On 2026-11-02 Mon, Name <address> wrote:` with `> ` lines, dates in UTC. kitp stores and shows the reply alone; the quote is added when the mail is sent. |
| **Reply signature** | What is appended to replies: nothing, the account's name, or the sender's name. |

## Inbound mail flow

The inbound poller checks the mailbox at a fixed interval and files each new message:

1. A reply to a thread lands on that thread — matched by the `X-Kitp-Thread-Id` header, the `[#id]` in the subject, or the `Ref:` line kitp puts at the bottom of every mail.
2. Anything else follows the account's **New mail** setting.

Senders join the thread's recipients. Attachments are stored with the thread's task, or with the thread itself when it isn't on a task. A received reply usually repeats the earlier messages (the sender's mail program quoted them); kitp keeps it as received and shows the quoted part folded behind **Show quoted text**.

## Outbound mail flow

A reply written in kitp is queued and sent by the account's SMTP side, with the signature, the quote (per **Quoting in replies**) and the `Task:` / `Ref:` lines last, so the answer comes back to the same thread. A thread that isn't on a task has no `Task:` line.

## Threads that aren't on a task

The Comms screen lists them first, labelled *Not on a task*; each opens on its own page, where **Attach to task…** moves it onto a task in the project and **Make a task** creates one from it. **Detach** on a task's thread moves it back. Attaching needs the Tasks area; without it, the project is a shared inbox.

## Related admin pages

- **Comm log** — read-only stream of every comm event (inbound, outbound, fault). The first stop when debugging a channel that's not delivering.
- **Activity sinks** — different direction: push activity rows *out* to a Teams channel rather than route email *in*.
