# Email communication

## Blocked by

Flow & screen kernel (`docs/FLOW_AND_SCREEN_KERNEL.md`). Comms attach to tasks and have their own status flow — both require the kernel to be in place.

## Description

It should be possible to specify email inboxes (IMAP) and outgoing mailers (SMTP) per project. Incoming messages get assigned configurable intake values (status, etc.), defaulting to a triage state.

```
Subject     → Title
Body        → Description (plain text; see MIME rule below)
Attachments → Attachments
```

**MIME decoding rule.** Multipart messages: prefer the `text/plain` part if present; otherwise convert the `text/html` part to plain text by stripping tags. No markdown conversion — plain text only, keep it simple.

**Per-project configuration.** Each project independently configures its inbox(es), outbox(es), and intake defaults. A project with no comm channel configured doesn't poll mail or accept replies.

**A comm is its own card.** A `comm` is a card_type. Each comm refers to exactly one task; tasks are independent and don't need a comm, but a task can have a comm attached. A comm carries its own status flow (open → in-progress → resolved, for example) which is independent of the underlying task's status. A closed task with an unresolved comm still appears on the Comms screen until the comm itself is resolved.

**Two comment kinds, separated by data type.** Tasks (the card view) accept only internal **comments**. The Comms screen (filtered to cards with comms attached) accepts only **replies** — outbound messages to the original sender. These are distinct attribute types: a `comments` attribute holds internal comment refs; a `replies` attribute holds reply refs. Both views can *see* both kinds; the difference is which kind of post each view *creates*. A reply carries a structured header (To: name &lt;email&gt;, From: project mailer, in-reply-to chain) prepended to the body.

**Comm direction is implicit in the channel type.** Attaching an "email box" comm channel implies the task can receive and send mail through that account. A future "slack" or "webform" channel might be intake-only or have different required fields. The "direction" property doesn't need to be modeled explicitly — it falls out of the comm channel's card_type and its required attributes (an email channel requires a `to` field; a webform channel doesn't).

**Comms are explicit.** Replies are only sent when an operator clicks "Reply" on the Comms screen. There is no auto-batched outbound update on status changes or comments. Internal comments stay internal; status changes don't automatically notify the original sender. (The previous draft of this doc described a 5-minute coalesced auto-send; that's removed.)

**Threading.** Inbound replies are matched to an existing comm by short thread id, in three places:

1. Custom MIME header `X-Kitp-Thread-Id: <id>` (preferred when present)
2. Subject suffix `[#<id>]`
3. Body trailer (e.g., a quoted line `Ref: <id>` appended to outbound replies)

The id is a short random token (e.g. `xInfdU385` — base62, ~10 chars, ~58 bits of entropy). The scanner tries each location in order; first match wins. No match means the message becomes a new comm (creates a new task or attaches to a configurable default-intake project).

**Bounces and delivery failures.** SMTP failures, IMAP authentication errors, malformed messages, attachment-too-large rejections, and similar surface in a dedicated admin "Comm log" area. Failed sends do not appear on the comm itself except as a small status indicator; the operator goes to the admin log to see why. This keeps task views clean of infrastructure noise.

See `email_comm_spec.md` for the tentative spec (card_types, attribute_defs, handlers, IMAP/SMTP wiring, threading details).
