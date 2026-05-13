# Email communication — tentative spec

Status: draft, not yet implemented. Authored 2026-05-13. Companion to `docs/email_comm.md` (concept) and `docs/FLOW_AND_SCREEN_KERNEL.md` (prerequisite).

This doc specifies the data model, server-side handlers, the IMAP poller / SMTP sender, the Comms screen, and the admin Comm-log area. It does **not** ship features beyond v1; multi-channel (Slack, webform) and other future generalizations are flagged inline but deferred.

## Vocabulary

- **Comm channel** — a configured connection to an external system. v1: email only (IMAP for inbound + SMTP for outbound, one card per channel).
- **Comm** — a single conversation, threaded by short id. Always attached to exactly one task. A comm has its own status independent of the task's.
- **Reply** — an outbound message on a comm. The operator authors replies on the Comms screen; the SMTP sender ships them.
- **Internal comment** — the existing `comment` mechanism, unchanged. Lives only inside the system.
- **Comm log** — a per-project, admin-only stream of channel-level events: poll cycles, send attempts, bounces, parse errors. Decoupled from comm cards.

## Data model

Every new entity is a card or attached card-style data. No new top-level tables that don't fit the existing kernel pattern.

### New card_types (seed.hcsv additions)

| name | parent_card_type_id | allow_self_parent | doc |
|---|---|---|---|
| `comm_channel` | `project` | false | Configured external account (email box, slack workspace, …). One channel can serve many comms. |
| `comm` | `task` | false | A single conversation thread attached to a task. Has its own flow status. |
| `reply_body` | (global) | false | Outbound message text + envelope. Mirrors `comment_body` structurally but separately so internal vs outbound stay distinct in queries and storage. |

Tasks gain a single new attribute referencing comm cards (see below). They do **not** become children of comms.

### New attribute_defs (seed.hcsv additions)

| name | value_type | required | doc |
|---|---|---|---|
| `comms` | `card_ref[]` | no (on `task`) | List of comm cards attached to this task. |
| `channel_type` | `text` | yes (on `comm_channel`) | Closed set today: `email`. Future: `slack`, `webform`. |
| `imap_host` | `text` | no (on `comm_channel`) | IMAP server hostname. |
| `imap_port` | `number` | no (on `comm_channel`) | IMAP server port; defaults 993. |
| `imap_username` | `text` | no (on `comm_channel`) | IMAP login. |
| `smtp_host` | `text` | no (on `comm_channel`) | SMTP server hostname. |
| `smtp_port` | `number` | no (on `comm_channel`) | SMTP server port; defaults 587. |
| `smtp_username` | `text` | no (on `comm_channel`) | SMTP login. |
| `from_address` | `text` | no (on `comm_channel`) | Outbound `From:` envelope. |
| `intake_status` | `card_ref` | no (on `comm_channel`) | Status assigned to new tasks created from inbound mail. Falls back to the project flow's triage default. |
| `channel_ref` | `card_ref` | yes (on `comm`) | The `comm_channel` this comm belongs to. Determines which inbox/outbox handle it. |
| `thread_id` | `text` | yes (on `comm`) | Short random token (~10 chars base62) used for matching inbound replies to the comm. Globally unique within the install. |
| `replies` | `card_ref[]` | no (on `comm`) | List of `reply_body` rows on this comm. The comms screen renders these. |
| `comm_status` | `card_ref` | yes (on `comm`) | Comm's own flow status (e.g. open / waiting-on-customer / resolved). The comm's flow is separate from the task's flow. |
| `reply_to` | `text` | yes (on `reply_body`) | Outbound `To:` envelope. Free text; in v1 always an email address. |
| `reply_from` | `text` | yes (on `reply_body`) | Outbound `From:` (typically copied from the channel's `from_address`). |
| `reply_subject` | `text` | yes (on `reply_body`) | Subject line; the threading suffix `[#<thread_id>]` is appended at send time. |
| `reply_body_text` | `text` | yes (on `reply_body`) | Plain-text body. Renamed from the original draft's `reply_body` to avoid name collision with the `reply_body` card_type — attribute_def.name must be unique across the install. |
| `delivery_status` | `text` | yes (on `reply_body`) | Closed set: `pending` / `sent` / `bounced` / `failed` / `received`. Set by the SMTP sender; `pending` at create time. `received` covers inbound message bodies materialised on the comm's replies list. |

### Gate 1 seeded counts

After Gate 1 lands, the install-seed counts go from:

- `card_type`: 10 → 13 (+ `comm_channel`, `comm`, `reply_body`).
- `attribute_def`: 24 → 43 (+ the 19 new defs above).
- `edge`: 47 → 68 (+ 21: 10 on `comm_channel`, 5 on `comm`, 5 on `reply_body`, 1 on `task` for `comms`).

The `migrate_test.go` row-count assertions in `server/internal/store/` are updated to match.

### New table — `comm_secret`

The only data we can't store in `attribute_value` is the IMAP/SMTP password — secret at rest, retrieved per-poll, never displayed once saved. Everything else (host, port, username, addresses) is plain `attribute_value` JSONb.

```
table comm_secret
  channel_card_id  bigint PK FK card(id) ON DELETE CASCADE
  imap_password    bytea (encrypted-at-rest, pgcrypto sym_encrypt with KEY_FROM_ENV)
  smtp_password    bytea (same)
  updated_at       timestamptz not null default now()
```

One row per `comm_channel` card. The encryption key comes from the `KITP_COMM_SECRET_KEY` env var on the kitpd process; rotation is out of scope for v1 (set once, never rotate). The admin UI offers a "Set password" form; once set, the form shows "configured" and offers re-set, never reveals the plaintext.

### New table — `comm_log`

Per-project ring buffer of channel-level events. Decoupled from cards because (a) the volume is high and (b) a parse error before we can identify a comm has no card to attach to.

```
table comm_log
  id            bigserial PK
  project_id    bigint NOT NULL FK card(id)
  channel_id    bigint NULL FK card(id)        -- null if pre-identification (e.g. IMAP auth failure)
  kind          text NOT NULL                  -- 'poll', 'send_ok', 'send_bounce', 'send_fail',
                                               --  'imap_auth_fail', 'parse_error', 'unmatched_thread',
                                               --  'attachment_too_large'
  detail        jsonb                          -- kind-specific structured detail (recipient, error
                                               --  text, original message-id, etc.)
  at            timestamptz NOT NULL DEFAULT now()
  index (project_id, at desc)
  index (project_id, kind, at desc)
```

Retention: TTL via a periodic prune (e.g. anything older than 30 days), gated by a `KITP_COMM_LOG_RETENTION_DAYS` env var.

## Server-side handlers

### Read

- `comm_channel.list { project_id }` — list configured channels for a project (admin only).
- `comm.list_for_task { task_id }` — list comms attached to a task.
- `comm_log.list { project_id, kind?, since?, limit? }` — admin only; pagination via `since` + `limit`.

### Write

- `comm_channel.set` — create or update a `comm_channel` card and the associated `comm_secret` row in one tx. Password fields are optional on update (leaving them out leaves them unchanged).
- `comm.create { task_id, channel_id, subject, initial_message? }` — create a comm card attached to a task. Generates a `thread_id`. Optionally captures the inbound message that prompted this comm (if creating from an inbound).
- `reply.post { comm_id, to, subject, body }` — author an outbound reply. Inserts a `reply_body` card with `delivery_status='pending'`, appends to the comm's `replies` attribute, and enqueues for the SMTP sender (in v1 this is just "the row exists; the sender picks it up on its next tick").

All write handlers go through the standard `attribute.update` / `card.insert` machinery — flow gating, role_grants, edge validation all apply. The kernel's flow infrastructure governs comm status transitions (the comm has its own flow).

## IMAP poller and SMTP sender

A long-running goroutine pair (one per channel) inside `server/internal/comm/` (new package).

### IMAP poller (per channel)

Loop body (~60 sec tick by default, configurable per channel):

1. Decrypt the channel's `imap_password` via `comm_secret`.
2. Open IMAP connection, select INBOX.
3. List unseen messages.
4. For each message:
   - Parse envelope + body.
   - Extract thread id (header → subject → body trailer, first match wins).
   - If matched: append a new entry to the matched comm's `replies` list, with the inbound text in `reply_body` and `delivery_status='received'`.
   - If unmatched and the channel has `intake_status` set: create a new task in the project with `subject` → `title`, `body` → `description`, status → `intake_status`. Create a new comm card attached to that task; record the inbound message as the comm's first entry.
   - Log a `comm_log` entry on success or any parse failure.
   - Mark the message seen (or move to an archive folder, configurable per channel).
5. Close the connection. Sleep until next tick.

Concurrency: one poller goroutine per channel; never two pollers for the same channel.

Backoff: exponential on IMAP failures; log to `comm_log`.

### SMTP sender (per channel)

Periodically (~10 sec tick), scan for `reply_body` rows with `delivery_status='pending'` whose comm's channel is this one. For each:

1. Build the MIME message: `From`, `To`, `Subject` (with `[#<thread_id>]` suffix), `X-Kitp-Thread-Id` header, body, footer trailer `Ref: <thread_id>`.
2. Decrypt SMTP password, connect, AUTH, send.
3. On success: set `delivery_status='sent'`. Log `comm_log` entry.
4. On bounce / failure: set `delivery_status` accordingly. Log entry with structured detail.

## Comms screen

A new seeded screen card (per project, comes from the project template) with:

- `slug='comms'`
- `layout='list'`
- `hotkey='c'` (subject to per-project uniqueness; admins can rename)
- `flow_ref` → the project's `comm` flow (the kernel handles the flow registration; comm's flow is per-project just like status's flow).
- `phase_scope` toggle group with the comm flow's phases.
- A filter card "Comms attached" with predicate `{op:'is_set', attr:'comms'}` (or whichever exact predicate-op spelling lands).
- `default_create_status` → triage status of the comm flow.

The Comms screen's `<TaskRow>` variant renders comm-specific affordances: a "Reply" button that opens an inline composer (writes to `reply.post`), a list of recent replies inline, and the comm status (separate from task status).

When the project flow's status is updated (via the kernel's `attribute.update`), no comm reply is sent — comms are explicit. The operator goes to the Comms screen to author replies.

### What about the Task detail view?

Task detail shows: internal comments (existing), attached comms (new), and the reply history of each comm (read-only on this screen). The "Reply" action is *not* available on Task detail; the user navigates to the Comms screen to post a reply. This keeps the boundary clean.

## Comm log admin area

New admin route `/admin/comm-log` (admin role only). Three controls:

- Per-project filter (defaults to all projects the admin has access to).
- Kind filter (poll / send_ok / send_bounce / send_fail / imap_auth_fail / parse_error / unmatched_thread / attachment_too_large).
- Time-window filter (defaults to last 24 hours).

Each log row shows: time, kind, channel, structured detail (rendered per-kind). Bounces show recipient + bounce code. Parse errors show the original message id + a short snippet. Auto-refresh is opt-in (a toggle in the header), default off.

## Threading details

The short id format: 10 base62 characters (`[0-9A-Za-z]`), ~58 bits. Generated by reading `crypto/rand` and base62-encoding 8 random bytes. Stored case-sensitively. Globally unique within an install — we maintain a unique index on `attribute_value.value` for the `thread_id` attribute, or app-level uniqueness check at insert.

Three lookup locations on inbound mail, in priority order:

1. **MIME header `X-Kitp-Thread-Id`.** Our outbound mail always sets this. Users / mail clients rarely strip custom headers, so this is the most reliable.
2. **Subject suffix `[#<id>]`.** Outbound subjects always end in this. Survives most reply chains since most clients prepend `Re:` rather than rewriting the subject.
3. **Body trailer line `Ref: <id>`.** Last-ditch: parse the last ~20 lines of the body looking for `^Ref: ([0-9A-Za-z]{10})$`. Useful if both header and subject got mangled.

If none match: the inbound becomes a new comm (channel-default intake path).

False-positive risk on body-trailer matching: 58 bits is enough entropy that a random match is essentially impossible. We'll log a warning if the id matches a comm whose channel doesn't match the inbound message's channel (e.g., a thread id from one project showed up via another's inbox).

## Storage and security notes

- **Passwords at rest**: `bytea` columns encrypted with pgcrypto's `sym_encrypt` / `sym_decrypt`; key from `KITP_COMM_SECRET_KEY` env var. Loss of the env var = loss of access to comm channels until re-set.
- **Outbound TLS**: SMTP always uses STARTTLS (or implicit TLS on port 465). No plaintext SMTP.
- **Inbound TLS**: IMAP always uses IMAPS (port 993) or STARTTLS. No plaintext IMAP.
- **Attachment storage**: inbound attachments stream into the existing CAS (`server/internal/cas/`); the comm row references them via the standard `attachment` mechanism. Size limit applies (existing config); over-limit attachments produce a `comm_log` entry and are not stored.

## What v1 explicitly defers

- Slack / webform / SMS channels. The channel_type closed set is `email` only in v1; future channels add new types + new required attributes.
- Auto-batched outbound updates on status change. Removed from the design; replies are always explicit operator actions.
- Markdown rendering of inbound text. Plain text only.
- Threading by mailer's `In-Reply-To` header. The short-id-in-three-places approach is preferred because it's robust to mid-thread subject rewrites and works across non-RFC822-compliant senders. Native In-Reply-To threading is a future enhancement.
- HTML signature stripping. Inbound text may include the sender's quoted-reply chain and signature. v1 keeps it verbatim; v2 might strip via heuristics.
- Multi-recipient replies (CC, BCC). v1 supports single-recipient outbound only.
- Reply templates / canned responses. v1 has only the free-text composer.
- Rate limits / throttles. v1 trusts the SMTP server to enforce.

## Implementation gates (mirrors the kernel's gate pattern)

Each gate is a single agent dispatch with build + tests passing before the next is authorized.

1. **Schema additions.** Add the new card_types, attribute_defs, and the `comm_secret` + `comm_log` tables to `schema.hcsv` and `seed.hcsv`. No handlers yet. Tests: schema applies cleanly; seed counts update appropriately.
2. **`comm` flow seeded.** Define the default `comm` flow (open → in-progress → resolved) and its status value-cards as part of the template's seed. Tests: a fresh project has a comm flow.
3. **CRUD handlers.** `comm_channel.set / list`, `comm.create`, `comm_log.list`. No IMAP/SMTP wiring yet — handlers manipulate rows only. Tests: create channel, create comm, list comm.
4. **Reply authoring.** `reply.post` handler. Inserts `reply_body` row with `delivery_status='pending'`. Tests: reply created; appears in `comm.replies`.
5. **SMTP sender goroutine.** Long-running worker per channel; polls for pending replies, sends, updates status. Tests: integration test against a mock SMTP server (use `smtpmock` or a small in-process listener).
6. **IMAP poller goroutine.** One per channel; polls inbox, parses, threads, creates/appends. Tests: integration against a fake IMAP using `go-imap-server` or an in-process mock.
7. **Comms screen seed.** Add the comms screen card to the project template (with the right slug, hotkey, flow_ref, predicate filter). Tests: stamping a new project produces a comms screen.
8. **Client UI.** TaskRow variant for comm rows on the Comms screen; reply composer; comm status indicator on Task detail. Tests: unit-level for the composer + integration for the reply flow.
9. **Admin comm-log view.** New `/admin/comm-log` route with filters. Tests: filter combinations return expected rows.
10. **Retention prune.** Daily job that prunes `comm_log` older than configured retention. Tests: prune leaves recent rows untouched.

Total estimated effort: ~3–4× the kernel's work because of the external I/O (IMAP/SMTP), integration testing complexity, and the new admin surface.

## Open questions for review

- **Channel ownership**: is a `comm_channel` always per-project, or can a single channel serve multiple projects? V1 says per-project. Multi-project shared channels are future.
- **Reply attribution**: when an operator replies, who is the "From" — the channel's `from_address` always, or the operator's email? V1 uses the channel address (cleaner threading; operator identity appears in the body header).
- **Comm flow shape**: open → in-progress → resolved is one choice. Should it instead be open → waiting-on-customer → waiting-on-us → resolved (matches helpdesk conventions)? Let project admins choose by editing the flow.
- **Re-opening a resolved comm**: an inbound on a resolved thread — does it auto-reopen, or create a new comm? V1: auto-reopen (set comm_status back to open, append the inbound). Configurable later.
- **Spam handling**: bypass via channel-level rules (denylist, sender-domain filter)? Future.
- **Confidence on "first match wins" threading**: should we log when two threading mechanisms disagree (e.g., header says one id, subject says another)? Probably yes — that's a sign of a mailer corruption issue worth surfacing.
