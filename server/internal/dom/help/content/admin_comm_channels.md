# Comm channels

A **comm channel** (mail account) configures one email account for a project: how mail comes in — IMAP polling and/or **routes** (below) — and how replies go out (SMTP).

Channels are project-scoped: pick the project in the title-bar picker before authoring or editing.

## What lives on a channel

| Group              | Fields                                                                  |
| ------------------ | ----------------------------------------------------------------------- |
| Identity           | `name`, `channel_type` (`email`).                                       |
| Inbound (IMAP)     | host, port, username, password, mailbox, TLS settings.                  |
| Outbound (SMTP)    | host, port, username, password, TLS settings.                           |
| Operational        | `channel_status`, `channel_fault_reason` (set by the runtime on failure). |

Password fields are **write-only**. The list endpoint returns `has_imap_password` / `has_smtp_password` booleans so the form can show "configured" without ever revealing the encrypted bytes. Leaving a password input blank on edit keeps the stored value; submit an explicit empty string only when you want to clear it.

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
| **Emailed replies** | *Are sent on to the rest of the thread* (a new account's default) or *are only filed in kitp* (the default for an account saved before this setting). See **Sending replies on**, below. |
| **Attachments from email** | *Kept on the thread* (the default) or *not kept*. A message whose files aren't kept is filed without them and says how many were left off; the Comm log's `attachments_dropped` row names them. |

## Inbound mail flow

The inbound poller checks the mailbox at a fixed interval and files each new message:

1. A reply to a thread lands on that thread — matched by the `X-Kitp-Thread-Id` header, the `[#id]` in the subject, or the `Ref:` line kitp puts at the bottom of every mail.
2. Anything else follows the account's **New mail** setting.

Senders join the thread's recipients. A received reply usually repeats the earlier messages (the sender's mail program quoted them); kitp keeps it as received and shows the quoted part folded behind **Show quoted text**.

### Files from email

A file on incoming mail is stored on the **thread**, under the message it came with, whether or not the thread is on a task. It reaches the task's Attachments only when someone clicks **Add to task** next to it in the conversation: the file moves onto the task and the message keeps showing it. Attaching or detaching a thread moves no files.

kitp never stores the same file twice. A file whose bytes it already holds for the thread — on the thread, on its task, or carried by an earlier message — is linked, not stored again: the same PDF sent twice, or a file you sent from the task that comes back quoted in a reply. **Add to task** for a file the task already has links the messages to the task's copy.

A reply written in kitp can carry the task's files or the thread's own.

### Sending replies on

With **Emailed replies** set to *are sent on*, a reply someone sent to this address alone is emailed on to the thread's other people, so nobody depends on the sender using Reply-All:

```
Ada ──reply──▶ support@ ──▶ filed on the thread
                              └─▶ copy to Bob
                                  From: "Ada Lovelace via Support" <support@…>
```

- **Who gets it:** the thread's recipients, minus the sender, minus anyone already on the reply's To or Cc, minus this address, and minus **kitp users** — they see the reply in kitp, and their notification subscriptions cover email. At most 20 people.
- **Only people the thread knows:** the sender must already be on the thread. Someone who joined only because an email named them in To or Cc gets no copies (and their own messages aren't sent on) until they write to the thread or someone replies to them from kitp; people you add to the thread in kitp count from the start. Otherwise anyone could Cc addresses onto a thread and have them emailed from this address.
- **Which account:** the thread's own mail account decides whether replies are sent on and sends the copy, even when the reply arrived through another account of the project.
- **What it is:** the sender's words as received (no signature, no quote of ours), with the files kitp kept from it, the `[#id]` subject and the `Ref:` line, so an answer comes back to the thread. Files over 20 MB together are left off the copy, which says so. It carries `Auto-Submitted: auto-forwarded`, so an out-of-office reply to it isn't sent on again.
- **Never sent on:** auto-replies and anything else marked automatic (`Auto-Submitted`, `Precedence: bulk`, `X-Autoreply`), mailing-list posts (`List-Id`), delivery and read reports, bounces, replies to notification email, and mail from this address itself. Each is filed as usual and logged `relay_skipped` with the reason.
- **Where to see it:** the message shows *Sent on to bob@… · sent* (or *queued*, *not sent*, *bounced*); the Comm log has `relay_queued`, then the copy's `send_ok` / `send_fail`. The copy isn't a message of its own in the conversation, and replies don't quote it.
- New mail that starts a thread is never sent on: everyone on a new thread was on that message.

## Receiving mail: routes

Besides polling an IMAP mailbox, an account can take mail **pushed** to kitp. Each way in is a **route** with its own secret, listed under RECEIVING MAIL:

| Route | What it is | Use it for |
| ----- | ---------- | ---------- |
| **POST URL** | A URL a provider sends each message to. | Cloudflare Email Routing, Mailgun, Postmark, Amazon SES, your own script. |
| **SMTP address** | An address on kitp's own SMTP listener (Admin → Mail intake). | Forwarding a mailbox — Exchange / Microsoft 365, Gmail, anything that can forward. |

Make one route per sender, so each can be revoked alone; a route's secret is shown **once** when it is made (kitp keeps only a fingerprint — lost it? add another route and delete the old one). Several routes and IMAP polling can all be on at once: a message that arrives more than once — say through IMAP and a forward while you switch over — is filed once (dedupe by Message-ID, per project, for 14 days after its last copy).

Each route row shows its kind, comment, the secret's first characters, its filters, when its last message came and from where, and its last refusal. **View log** opens the Comm log filtered to that route.

### Setting up each provider

**Cloudflare (Email Routing).** Two ways:

1. *Email Worker → POST URL (raw).* Make a POST route with provider *Raw message*. In Cloudflare: Workers → create a Worker with this code, store the route's URL as its secret `KITP_URL`, and in Email Routing send the address to the Worker:

   ```js
   export default {
     async email(message, env) {
       const res = await fetch(env.KITP_URL, { method: "POST", body: message.raw,
         headers: { "Content-Type": "message/rfc822" } });
       // Anything but 200 is refused, so the sender gets a bounce.
       if (!res.ok) message.setReject(`kitp answered ${res.status}`);
     },
   };
   ```

2. *Forward → SMTP address.* Make an SMTP route and add its address as a destination in Email Routing. Cloudflare first mails a confirmation link to it; set the account's **New mail** to *creates a thread only* while you do, so the confirmation is filed and you can click it.

**Mailgun.** Make a POST route with provider *Mailgun* and paste your **HTTP webhook signing key** (Mailgun → Settings → Webhooks). In Receiving → Create route, set the action `forward("<the route URL>")` — the URL ends in `/mime`, which makes Mailgun send the raw message. kitp checks every request's signature and refuses replays and requests more than 15 minutes old.

**Postmark.** Make a POST route with provider *Postmark*. In your server's Default Inbound Stream → Settings, set the webhook to the URL and turn on **Include raw email content in JSON payload** — kitp files the raw message and refuses requests without it. Postmark doesn't sign requests; consider a **Sources** filter with Postmark's published sending addresses.

**Amazon SES.** Use a POST route with provider *Raw message*: an SES receipt rule stores the message in S3 and a small Lambda POSTs the object's bytes to the URL with `Content-Type: message/rfc822`. (SES's own SNS action caps messages at 150 KB, so kitp doesn't take it directly.)

**Exchange / Microsoft 365.** Make an SMTP route. Then, in Exchange, forward the mailbox to its address:

- the mailbox's **Email forwarding** setting in the Exchange admin center, or an Inbox rule's **Redirect to** — *not* **Forward to**, which re-sends the mail as the mailbox, so kitp would see the mailbox as the sender instead of the customer;
- allow **automatic external forwarding** for that mailbox (it is blocked by default by the outbound spam policy).

Exchange rewrites the envelope sender to `bounces+SRS=…@<your domain>` and keeps the customer in From:, so threads and replies go to the customer. Good filters for this route: **Sender hosts** `.outbound.protection.outlook.com`, **Require TLS**, and optionally **Envelope sender** `<your domain>`.

**Gmail.** Settings → Forwarding → add the SMTP address. Gmail mails a confirmation code to it first — as with Cloudflare, set **New mail** to *creates a thread only* so it is filed and you can read the code.

### Filters

Every filter is optional; a message one refuses is logged on the route (`inbound_refused`) and shown as its last refusal. Lists take one entry per line: `a@b.com` is that address, `b.com` that domain, `.b.com` any subdomain of b.com.

| Filter | Routes | What it proves |
| ------ | ------ | -------------- |
| **Sources** | both | The connection comes from these networks (the real client, through trusted proxies). For Exchange Online this is every Microsoft 365 tenant — they share addresses. |
| **Require TLS** | SMTP | The sender used STARTTLS; mail crosses the internet encrypted. |
| **Sender hosts** | SMTP | The sender's reverse DNS name — checked to resolve back to its address, so it can't be faked — ends with one of these. Unlike an address list, it doesn't go stale when the provider adds ranges. |
| **Envelope sender** | SMTP | MAIL FROM is on the list. Only a claim on its own; useful to say "forwarded by my tenant" (`bounces+SRS=…@your domain`). |
| **From (header)** | both | The From: line is on the list — for a closed route (only staff may write). Only a claim without DKIM. |
| **DKIM** | both | *Record only*: verify signatures and log what checked out, never refuse — try this first, since forwarding can break the original sender's signature. *Require*: a valid signature from a listed domain (or any, when none is listed); on failure refuse it, or file it with a `dkim_failed` note. |

### Answers senders get

| Situation | POST | SMTP |
| --------- | ---- | ---- |
| Filed, or a duplicate | 200 | 250 |
| Unknown route | 404 | 550 at RCPT |
| A filter refused it | 403 (Mailgun: 406, which it doesn't retry) | 550, or 530 for Require TLS |
| Too large | 413 | 552 |
| Not mail | 200, logged `parse_error` | 250, logged |
| Account paused, or kitp briefly unavailable | 503 — the provider retries | 451 — the sender retries |
| Too many requests | 429 | 421 / 450 |

### Troubleshooting

Open **View log** on the route:

- *Nothing at all* — the provider never reached kitp: check the URL in the provider (or, for SMTP, the MX record and Admin → Mail intake's recent refusals).
- `inbound_refused` — a filter is stricter than the sender; the reason names the value that didn't match.
- `duplicate` — that Message-ID was already filed in this project, perhaps through another account or route.
- `unmatched_thread` — the account's **New mail** ignores new mail.
- `relay_skipped` — a reply wasn't sent on to the rest of the thread; the reason says why (an auto-reply, a bounce, …).
- `attachments_dropped` — the account doesn't keep files from email.

## Outbound mail flow

A reply written in kitp is queued and sent by the account's SMTP side, with the signature, the quote (per **Quoting in replies**) and the `Task:` / `Ref:` lines last, so the answer comes back to the same thread. A thread that isn't on a task has no `Task:` line.

## Threads that aren't on a task

The Comms screen lists them first, labelled *Not on a task*; each opens on its own page, where **Attach to task…** moves it onto a task in the project and **Make a task** creates one from it. **Detach** on a task's thread moves it back. Attaching needs the Tasks area; without it, the project is a shared inbox.

## Related admin pages

- **Comm log** — every message received, sent, refused or unreadable, filterable by account and route. The first stop when debugging an account that's not delivering.
- **Mail intake** — the SMTP listener, trusted proxies, rate limits and refusals that happened before reaching any account.
- **Activity sinks** — different direction: push activity rows *out* to a Teams channel rather than route email *in*.
