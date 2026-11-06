# Mail intake, message dedupe, calendar feeds, and strict dates

Status: designed and built 2026-11-03 on branch `bundles-portals`, with a second round (files from
email, the attachments setting, sending replies on) near the end.
This file is the source of truth for the work: read it before touching
any of the pieces below, and tick the build checklist at the end as
parts land. If the code has to differ from what is written here, change
this file in the same edit.

## Overview

Eight pieces, in build order:

| # | Piece | One line |
|---|-------|----------|
| 1 | **Strict dates** | Every date entering kitp is `YYYY-MM-DD` (a real day); every timestamp is RFC 3339. Six inputs are checked; a migration repairs stored due dates. |
| 2 | **Secrets out of logs** | `logpath.Of` replaces the URL path with a fixed placeholder for routes that carry a secret in the path; used by every log line that prints a path. |
| 3 | **Shared filing step** | The IMAP poller's "file this message" code becomes `comm.Intake`, which IMAP, POST and SMTP all call. |
| 4 | **Message dedupe** | A message is filed at most once per project (Message-ID, or a hash when there is none). Rows live 14 days after the last copy arrives. |
| 5 | **Secret routes table** | `card_access`: one table for calendar URLs and inbound mail routes — a random token stored hashed, a comment, last use, per-route settings. |
| 6 | **POST intake** | `POST /api/v1/comm/inbound/<token>` for `raw` (Cloudflare Worker, SES via Lambda, scripts), `mailgun` and `postmark`. Trusted proxies give the real client IP. |
| 7 | **SMTP listener** | An optional receive-only SMTP server: a secret address per route, STARTTLS, PROXY protocol by sniffing, per-route filters (IP, TLS, sender host, envelope and header From allow lists, DKIM), in-memory rate limits. |
| 8 | **Calendar feeds** | Per-person `calendar` cards, each with its own filter and window, and any number of secret `.ics` URLs (each with a comment). Built by a live query on every fetch. |

Second round, same day (see "Second round" near the end): files from
email live on the thread, with **Add to task**; a mail account can drop
them; and an emailed reply that reached only the account is sent on to the
thread's other people.

Plus, for every page these touch: short instructions on the page, a
detailed help topic in the `?` overlay, and links straight to the
relevant log entries.

Not part of this work (considered and dropped): native SES/SNS intake,
Exchange via Microsoft Graph, contact forms, Atom feeds, chat.

## Decisions

Each line is a decision the user made (2026-11-03). Detail sections
below expand them.

### Dates
- D1. Validate **all** dates on ingress, not just `due_date`.
- D2. Dates are strictly `YYYY-MM-DD` and must be a real calendar day.
  Timestamps are strictly RFC 3339 (`T`, seconds, `Z` or `±hh:mm`).
  Postgres keywords (`today`, `now`, `epoch`, `infinity`, …) and
  locale-ordered forms (`03/11/2026`) are refused.
- D3. Stored `due_date` values that aren't dates: timestamps become
  their date part; anything else is **cleared**, with the old value kept
  in the task's history (an activity row).
- D4. CSV import accepts ISO dates only; the preview lists bad rows.

### Logs
- D5. Mark path prefixes as sensitive; matching is a prefix check that
  allocates nothing. All six sites that log a path use it.

### Dedupe
- D6. Dedupe **per project** (not per mail account).
- D7. Retention: 14 days after the last copy arrived (pruned by last
  seen, so a message that keeps being re-delivered stays deduped). "More
  than enough."

### POST intake
- D8. Providers are named per route: `raw`, `mailgun`, `postmark`.
  No auto-detection. **No native SES** (SES goes through `raw` with S3 +
  a Lambda).
- D9. Every POST route has a secret: a random token in the URL path.
  Several tokens per account, each with a comment.
- D10. Trusted proxies apply to POST now (X-Forwarded-For).
- D11. Cloudflare needs no Lambda: either a small Email Worker that
  POSTs to the `raw` route, or Email Routing forwarding to the SMTP
  listener.

### SMTP listener
- D12. Build it, using `emersion/go-smtp`.
- D13. PROXY protocol by **sniffing** (no switch to turn it on). A PROXY
  header is believed only from a private or loopback peer (not
  100.64/10, carrier-grade NAT and Tailscale space, where clients
  connect from); if `KITP_TRUSTED_PROXIES` is set, only from those CIDRs,
  which must themselves be private (100.64/10 may be named). The same
  trust rule covers X-Forwarded-For, whose hops may carry a port
  (`203.0.113.7:4711`, `[2001:db8::1]:443`).
- D14. Optional per-route filters, first version: source IP allowlist,
  require TLS, sender host name (forward-confirmed reverse DNS suffix),
  envelope sender allow list, header From allow list (both by address or
  by domain), DKIM.
- D15. DKIM is optional and flexible: off (default) / record only /
  require (listed domains, exact or with subdomains; on failure refuse or
  file-with-a-note).
- D16. Rate limits are generous and **in memory only** (no counters in
  the database). Misses (unknown address, bad token, failed check) count
  extra. Also an optional install-wide source IP allowlist.
- D17. SPF and DMARC are deferred.

### Shared
- D18. One table for calendar URLs and inbound routes.
- D19. `KITP_TRUSTED_PROXIES` is an environment variable (like every
  other listener setting), shown read-only on the Mail intake page. A
  public CIDR in it is refused at startup.

### Calendars
- D20. A person can have several calendars, each with its own filter
  (the same card-filter tree subscriptions use; `@me` = the owner) and
  window (default 30 days back, 365 ahead).
- D21. Each calendar has any number of random URLs, each with a comment,
  stored hashed and shown once. **No derived secrets.**
- D22. No cache: every fetch runs the query. The due-date range must use
  an index.
- D23. Each event links to the full task.

### Pages, help and logs
- D24. Every page these touch has short instructions on the page **and**
  a detailed page-specific help topic.
- D25. Logs are easy to reach from the settings pages: each route row
  shows its last message / refusal and links to the Comm log filtered to
  it.

## Detail

### 1. Strict dates

**Rules** (one implementation each, used everywhere):

| | SQL | Go |
|---|---|---|
| date | `iso_date_ok(text) RETURNS boolean` — `^\d{4}-\d{2}-\d{2}$` and `make_date` succeeds | `isodate.ValidDate(s)` / `isodate.ParseDate(s)` |
| timestamp | `iso_timestamp_ok(text) RETURNS boolean` — `^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$` and the cast succeeds | `isodate.ParseTimestamp(s)` (`time.RFC3339Nano`) |

Package: `server/internal/isodate`. SQL helpers:
`db/schema/functions/iso_date_ok.sql`, `iso_timestamp_ok.sql` (declared
`IMMUTABLE`; the exception block lives inside).

**Inputs checked:**

| Input | Before | After |
|---|---|---|
| `attribute.update` on a `date` attribute (`due_date`) | stored as given | not a valid date → `validation` |
| `card.insert` attributes of type `date` (also CSV import commit, MCP) | stored as given | same |
| CSV import | had no date column | a new `due_date` target, YYYY-MM-DD only: the preview lists each bad row, the commit refuses it |
| `activity.select` `from_date` / `to_date` | lenient `::date`; bad → silently unset | strict date; bad → `validation` |
| `comm_log.list` `since` | lenient `::timestamptz`; bad → the batch errors | strict RFC 3339; bad → `validation` |
| `user_token.create` `expires_at` | lenient `::timestamptz` (accepted `infinity`) | strict RFC 3339 |
| card filters: `=` / `!=` / `in` against a `date` attribute | not checked | `card.CompileTree` refuses a value that isn't a date |

Relative filter ops (`before_today`, `within_days N`, `within_last_days N`)
take a day count and are unchanged.

**Migration `0023_due_date_iso`:** for every `due_date` value:
- a valid ISO date → unchanged;
- a string starting with a valid ISO date followed by `T`/space (a
  timestamp) → replaced by the date part, with an `attr_update` activity
  row (old → new) by the system user;
- anything else → the value row is deleted, with an `attr_update`
  activity row (old → null) by the system user.
Idempotent: a second run finds only valid dates.

### 2. Secrets out of logs

Package `server/internal/obs/logpath` (not `obs` itself: `obs` imports
`api`, so `api` couldn't use it). `logpath.Mark(prefix)` registers a
prefix at startup (the calendar and inbound routes call it from their
`Mount`). `logpath.Of(path) string` returns `prefix + "…"` (precomputed when the
prefix was registered) for a match, else `path` itself — no allocation
either way. The registry is an `atomic.Pointer` to an immutable slice
(copy-on-write on registration), so reads take no lock.

Sites (all six use `logpath.Of`): `obs/logger.go` (request log) and
`api/router.go` (auth failure, token scope, panic, 4xx/5xx error logs).
`scripts/check-log-paths.sh` (run by `make lint`) fails on a log call that
passes `URL.Path` without `logpath.Of`; it runs with the other lint scripts. A test
asserts `testing.AllocsPerRun(…) == 0` for both a match and a miss.

The SMTP listener never logs an address: it logs the route id.

### 3. Shared filing step

`comm.Intake` (in `server/internal/dom/comm/intake.go`):

```
type Intake struct { Pool *store.Pool; Logger *slog.Logger }
func (in *Intake) File(ctx, channelID int64, transport string, routeID int64, m InboundMessage) (Filed, error)
type Filed struct { Outcome string; CardID int64; Duplicate bool }
```

`File` loads the channel's project / intake status / mode (one short
query), then does what `IMAPPoller.processOne` did: dedupe (§4), thread
match, reply / new task / new thread / ignore / notification-reply, all
in one transaction, and a `received` (or `duplicate`) Comm log row.
`IMAPPoller.processOne` becomes a call to `File`. Transport names:
`imap`, `post`, `smtp`.

A paused channel (not `enabled`): `File` returns `ErrChannelPaused`
(POST answers 503, SMTP 451). Unparseable input: `ErrUnparseable` (POST
200 + `parse_error` row; SMTP 250 + `parse_error`; IMAP logs `parse_error`
and marks it read, leaving it in the mailbox — before, it filed an empty
message, and with dedupe every empty message would share one key).

Size and shape (review 2026-11-03 rounds 3 and 4, #1).
- One IMAP poll lists at most 50 unseen messages, oldest first, with each
  one's `RFC822.SIZE` and nothing else (`ListUnseen`). It then fetches,
  files and marks seen one message at a time, so a poll holds one message,
  not the batch. A message over 50 MB (`IMAPMaxMessageBytes`, the POST
  route's default cap) is logged as `parse_error` and marked read without
  being fetched.
- Messages are fetched with `BODY.PEEK[]`, which leaves them unseen: kitp
  marks a message seen once it is filed, or can never be (unreadable,
  unfileable, too large, set aside). A plain `BODY[]` marked it seen as it
  was read, so a message whose filing failed for a passing reason was lost.
- A message is recorded in `comm_imap_inflight` while it is read and filed.
  A record still there when the next poll starts means kitpd stopped while
  reading it; after two such starts the message is set aside: logged as
  `parse_error` ("set aside") and marked read, left in the mailbox, rather
  than ending kitpd on every poll.
- Every IMAP command has a deadline (the poll's own, or 2 minutes), and the
  connection is closed when the poll's context ends; an SMTP conversation
  has one deadline (5 minutes, or the caller's). A server that stops
  answering can't hold up the other accounts' polls.
- Parsing reads nested multiparts as a stream, at most 8 levels deep and
  500 parts in all (`walkMultipart`); a part's transfer encoding, nested or
  not, is undone as it is read. Before, each level copied the rest of the
  message: a 224 KB message of nested parts took 600 MB.
- A message kitp can never file (unreadable, too large, set aside,
  unfileable) is marked read and then moved out of INBOX to the
  `kitp-set-aside` folder (`KITP_COMM_IMAP_SET_ASIDE_FOLDER`; empty leaves
  it in INBOX): `UID MOVE` where the server has MOVE, else `UID COPY` +
  `\Deleted` + `UID EXPUNGE` with UIDPLUS; a server with neither leaves it
  read in INBOX, since a plain EXPUNGE would also remove what other
  clients deleted.
- Inbound SMTP connections last at most 15 minutes from accept however
  they are spent, EHLO or not (NOOP kept one open for good).
- Outgoing mail is claimed before it is sent (`comm_send_attempt`), and a
  message is claimed only while its status is still pending, so two
  replicas don't both send it; a failure that may pass (4xx, a dropped
  connection, a timeout) keeps it pending and retries after 1, 5, 15, 60
  and 180 minutes (`send_retry` in the Comm log) before it fails. Each
  send has its own 75-second budget, and its result is recorded however
  long it took.
- One replica at a time polls an IMAP account, and one pumps a digest or
  Teams sink (a Postgres advisory lock held for the tick).
- **Threading.** Each message keeps its Message-ID (`reply_message_id` on
  the reply_body: intake writes an incoming one, if it is a plain
  `<left@right>` and not shaped like a kitp notification's, which would
  make every reply on the thread read as a reply to a notification and
  never be sent on; the sender writes its own once the message is sent).
  A message kitp sends names the thread's earlier messages: In-Reply-To
  the latest that isn't a copy kitp sent on to someone else (`relay_of`),
  References up to 20 — the first and the latest — so it lands in the
  recipient's thread rather than on its own. Messages from before this
  (migration 0040) have no id, so an older thread threads from its next
  message on.
- **A refused recipient.** A recipient the mail server refuses for good
  (5xx at RCPT TO) is left off, and the rest get the message: it is
  `sent`, with who was refused on the message (`reply_refused`, migration
  0042), which the thread shows ("sent, but refused for …"); its
  `send_ok` names them too, and each refused address has a `send_bounce`
  of its own. Only a message every recipient is refused for bounces. A
  passing refusal (4xx) still retries the whole message, since nobody has
  it yet.
- A message the IMAP server refuses to fetch is skipped for the others,
  and set aside after two refusals.
- A message that fails to file for a passing reason (anything but a
  database limit it breaks, which sets it aside at once) is recorded in
  `comm_imap_file_failure` with the path it failed on (reply, new task,
  new thread, …), logged once in the Comm log (`file_retry`; POST and
  SMTP intake log one per attempt, the sender being told to try again),
  and listed and tried after the poll's other mail, so failing messages
  never fill a poll's 50. It doesn't count against the account's fault
  switch. Once it has failed for a day, three times or more, while fresh
  mail down the same path filed (a duplicate doesn't count), it gets a
  last try, and is set aside (`file_error`, "set aside") if that fails
  too. A failure that hits every message, or every message of one path —
  a kitp bug, the database — sets nothing aside: the mail waits in the
  inbox until filing works again. A poll in which messages failed and
  none filed backs the account off (up to 10 minutes) without counting
  toward the fault switch, and its `poll` row counts the failures.
- A poll has 2 minutes. One that runs out files what it reached and leaves
  the rest for the next; that isn't the account failing. A message that
  was cut off with less than half the time left isn't charged for it.
- A thread has at most 100 recipients; inbound mail adds nobody past that.
- At most 4 POSTed messages are filed at once
  (`KITP_COMM_INBOUND_MAX_CONCURRENT`), and twice that read; one route has
  at most 2 bodies being read, each within 60 seconds, so slow uploads
  with one route's token hold only that route. More answer 503 and the
  provider retries.

### 4. Message dedupe

Table `comm_inbound_seen` (DDL tier; new table, no migration):

| column | |
|---|---|
| `project_id` bigint | PK part |
| `message_key` text | PK part |
| `channel_id` bigint | first account it arrived on |
| `transport` text | `imap` / `post` / `smtp` |
| `message_id` text | the header as received (may be '') |
| `card_id` bigint null | the thread / reply / task it became |
| `first_seen_at`, `last_seen_at` timestamptz | |

Index `(last_seen_at)` for the prune.

Key: `mid:` + the Message-ID with surrounding whitespace and `<>`
removed (case kept); one longer than 900 bytes is `midh:` + its SHA-256
hex (whole, it overflowed the primary key's index — review 2026-11-03 #7).
No Message-ID → `h:` + SHA-256 hex of From, To, Date, Subject and the body
text joined with `\n`.

A filing failure no retry can fix — a data exception (22xxx), a program
limit (54xxx), a NOT NULL / CHECK violation — is `ErrUnfileable`: logged
as `file_error` (the message and the database's reason code, not its
text) and dropped like unreadable mail (IMAP marks it seen, POST 200
`unfileable`, SMTP 250). Mail for an account whose project has
Conversations off waits (`ErrChannelPaused`: POST 503, SMTP 451), as IMAP
does by not polling it.

In `File`'s transaction, first: `INSERT … ON CONFLICT DO NOTHING
RETURNING`. No row → a duplicate: `UPDATE … SET last_seen_at = now()`,
a `duplicate` Comm log row naming the original card, commit, return
`Duplicate: true` (IMAP marks it seen; POST 200; SMTP 250). A failure
rolls the row back with everything else, so the message can be retried.
A concurrent second copy waits on the first's row and then sees the
conflict.

Prune: `comm.LogPruner` also deletes rows whose `last_seen_at` is older
than `KITP_COMM_DEDUPE_DAYS` (default 14).

Scope consequences: new mail sent to two accounts of one project is
filed once — the copy that arrives first decides task vs thread. A
reply that CCs both is added once.

Known limits: a message that reuses another's Message-ID is taken for a
copy and dropped (Message-IDs aren't secret, but a sender would have to
know one before the real message arrives; replaying an old one only
drops the replay). The fallback key for mail without a Message-ID
ignores attachments, so two such messages identical but for their
attachments count as one.

### 5. Secret routes table

Table `card_access` (DDL tier):

| column | |
|---|---|
| `id` bigserial PK | |
| `card_id` bigint → card, on delete cascade | the calendar or comm_channel |
| `purpose` text | `calendar` / `inbound_post` / `inbound_smtp` |
| `token_hash` text unique | `auth.HashSecret(token)` |
| `comment` text | the user's label ("iPhone", "Mailgun route") |
| `provider` text | `inbound_post`: `raw` / `mailgun` / `postmark` |
| `policy` jsonb | per-route filters (§7) |
| `signing_key` bytea | Mailgun's webhook signing key, `pgp_sym_encrypt` with `app.comm_secret_key` |
| `created_by` bigint, `created_at` | |
| `last_used_at`, `last_client` | last fetch / message; client = User-Agent (calendar), IP (POST/SMTP) |
| `last_error`, `last_error_at` | last refusal / failure, shown on the page |

Token: 20 random bytes as 40 lowercase hex characters (made in SQL by
`card_access_mint`, `gen_random_bytes`). Lowercase because mail systems
may lower-case an address's local part. A `hint` column keeps its first 6
characters so lists can tell routes apart. Shown once when created; a lost one is replaced by adding
another and deleting the old one.

Handlers (SQL functions, admin-only for mail routes, owner-only for
calendar URLs):

| handler | who |
|---|---|
| `comm_route.list {channel_id}` / `.create {channel_id, purpose, provider, comment, policy, signing_key}` / `.update {id, …}` / `.delete {id}` | admin (the channel's project) |
| `calendar_url.create {calendar_id, comment}` / `.update {id, comment}` / `.delete {id}` | the calendar's owner |

`create` returns the token once, plus the path (`/api/v1/comm/inbound/<t>`,
`/api/v1/calendar/<t>.ics`) or the address (`<t>@KITP_SMTP_DOMAIN`).
Policies are validated and normalised in Go (`PreRun`) before the SQL
function stores them.

### 6. POST intake

Routes (public, no session; registered with `logpath.Mark`):

```
POST /api/v1/comm/inbound/{token}
POST /api/v1/comm/inbound/{token}/mime      (Mailgun posts raw MIME only to a URL ending in "mime")
```

Order of work per request: rate limit (client IP) → body cap
(`KITP_COMM_INBOUND_MAX_BYTES`, default 50 MB) → token lookup (miss: 404,
counted as a miss) → route policy `sources` → provider decode → header
From / DKIM checks → `Intake.File`.

| provider | request | check |
|---|---|---|
| `raw` | the body is the RFC 5322 message (any content type) | the token |
| `mailgun` | `multipart/form-data`; the message is the `body-mime` field | the token + Mailgun's signature: HMAC-SHA256(signing key, `timestamp`+`token`) = `signature`, timestamp within 15 minutes, token not seen before (in-memory, 15 minutes) |
| `postmark` | JSON; the message is `RawEmail` ("Include raw email content" must be on) | the token (Postmark doesn't sign); optional `sources` allowlist |

Responses:

| status | when |
|---|---|
| 200 `{"status":"filed"\|"duplicate"\|"ignored"\|"unparseable"}` | committed, a duplicate, or unparseable (logged; retrying won't help) |
| 404 | unknown token |
| 413 | over the cap |
| 403 (Mailgun: 406, which Mailgun doesn't retry) | a filter refused it, or a bad Mailgun signature; logged as `inbound_refused` |
| 429 + `Retry-After` | rate limited |
| 503 | the account is paused, or the database is unavailable (the provider retries) |

**Client IP** (`netx.ClientIP(r)`): the TCP peer, unless the peer is a
trusted proxy (§7); then X-Forwarded-For is read from the right,
skipping trusted hops, and the first untrusted address is the client.

Cloudflare Worker (shipped in the help topic):

```js
export default {
  async email(message, env) {
    // KITP_URL: the route's URL, stored as a Worker secret.
    const res = await fetch(env.KITP_URL, { method: "POST", body: message.raw,
      headers: { "Content-Type": "message/rfc822" } });
    // Anything but 200 is refused, so the sender gets a bounce rather than
    // the mail vanishing.
    if (!res.ok) message.setReject(`kitp answered ${res.status}`);
  },
};
```

### 7. SMTP listener

Off unless `KITP_SMTP_ADDR` is set.

| env | default | |
|---|---|---|
| `KITP_SMTP_ADDR` | — | listen address, e.g. `:2525` (put port 25 in front of it) |
| `KITP_SMTP_DOMAIN` | — (required with ADDR) | the domain of route addresses; mail for any other domain is refused (no relay) |
| `KITP_SMTP_HOSTNAME` | the domain | the greeting / EHLO name |
| `KITP_SMTP_TLS_CERT`, `KITP_SMTP_TLS_KEY` | — | PEM files; STARTTLS is offered only when set; re-read when the files change (cert-manager renewals) |
| `KITP_SMTP_MAX_BYTES` | 40 MB | message size (SIZE extension) |
| `KITP_SMTP_ALLOW` | — | optional install-wide source CIDR allowlist |
| `KITP_TRUSTED_PROXIES` | private + loopback, not 100.64/10 | proxies whose PROXY header (SMTP) / X-Forwarded-For (HTTP) is believed; must be private ranges (100.64/10 included) |

**PROXY protocol by sniffing** (`server/internal/netx/proxyproto.go`).
Every accepted connection is sniffed in its own goroutine (wrapped in
`job.Protect`) before go-smtp sees it, so go-smtp's `RemoteAddr` is
already the real client:

1. Wait up to 500 ms for bytes, before the greeting.
2. Nothing arrives → a direct client; use the TCP peer.
3. Bytes start with `PROXY ` (v1) or the v2 signature
   `\r\n\r\n\x00\r\nQUIT\n`:
   - peer trusted → read the header (2 s deadline), use its source
     address;
   - peer not trusted → close; recorded as a refusal.
4. Anything else first → the client spoke before the greeting (a spam
   signal) → close; recorded.

"Private" = 10/8, 172.16/12, 192.168/16, 100.64/10, 127/8, ::1, fc00::/7.
Trusted by default: the same but 100.64/10.

**Session** (go-smtp backend):

| step | check | refusal |
|---|---|---|
| connect | `KITP_SMTP_ALLOW`; rate limit per source | 554 / 421 |
| `MAIL FROM` | remember the envelope sender | — |
| `RCPT TO` | domain = `KITP_SMTP_DOMAIN`; local part → route (`inbound_smtp`); then the route's pre-DATA filters (below); the channel enabled | 550 5.1.1 unknown (a miss); 550 5.7.1 filter; 530 5.7.0 TLS required; 451 4.7.0 paused |
| `DATA` | size; then per accepted route: header From and DKIM filters, then `Intake.File` | 250 when at least one route filed it; 550 5.7.1 when every route refused; 451 on a transient error (the sender retries; dedupe makes the retry safe) |

At most 20 recipients per message.

**Per-route policy** (`card_access.policy`, every key optional):

```json
{
  "sources":      ["40.92.0.0/15"],
  "require_tls":  true,
  "sender_hosts": [".outbound.protection.outlook.com"],
  "envelope_from":["@example.com", "ops@example.org"],
  "header_from":  ["example.com", ".example.com", "ceo@example.net"],
  "dkim": {"mode": "off|record|require", "domains": ["example.com", ".example.com"], "on_fail": "refuse|file"}
}
```

Address/domain list syntax (both From lists and DKIM domains):
`a@b.com` = that address; `b.com` or `@b.com` = that domain exactly;
`.b.com` = any subdomain of b.com. Case-insensitive.

| filter | applies to | checked |
|---|---|---|
| `sources` | SMTP (peer) and POST (client IP) | RCPT / request |
| `require_tls` | SMTP | RCPT |
| `sender_hosts` | SMTP | RCPT: the peer's PTR names, kept only if they resolve back to the peer (forward-confirmed), must end with a listed suffix; looked up once per session, 3 s timeout |
| `envelope_from` | SMTP | RCPT (an Exchange forward's envelope is `bounces+SRS=…@<your domain>`) |
| `header_from` | SMTP and POST | after DATA. The From must be exactly one address; a list or one that doesn't parse is refused |
| `dkim` | SMTP and POST | after DATA (`emersion/go-msgauth/dkim`, 5 s DNS timeout). `record`: verify and log `dkim_result`, never refuse. `require`: a valid signature from a listed domain (or any, when the list is empty); on failure `refuse` (550 / 403) or `file` (filed, with a `dkim_failed` log row). With `header_from` set too and no DKIM domains listed (any signer), the signature must also come from the From address's domain (or a parent / subdomain of it) — a listed signer vouches for the From itself |

With either `header_from` or `dkim` set, a message with more than one
From, Sender, Reply-To, To, Cc, Subject, Message-ID, Date, In-Reply-To or
References header is refused: kitp reads the first, DKIM verifies the
last, so a second From in front of a genuinely signed message passed both
filters (review 2026-11-03 #9).

**Rate limits** (`server/internal/netx/ratelimit.go`, in memory, reset on
restart): token buckets keyed by source address (IPv6 grouped by /64),
and per route. Defaults (constants): per source 120 connections or
requests per minute (burst 240), 240 messages per minute; per route 600
messages per minute. A miss costs 10. An SMTP session that has five
recipients refused, or whose source has spent its bucket, gets 421 and is
closed. At most 64 concurrent SMTP connections per source, 1000 in all. The table holds at most 100 000
keys; the oldest go first.

**Mail intake status** (in memory): the last 200 connection-level
refusals (untrusted PROXY header, early talker, install allowlist,
throttled, unknown address) and the currently throttled sources —
`mail_intake.status` (admin, a `Run` handler: no database).

### 8. Calendar feeds

Card type `calendar` (global, like `portal`; parent none). Edges:
`title` (required), `subscriber` (required — the owner's person card),
`predicate` (card filter), `past_days`, `future_days` (new `number`
attribute_defs). Seed + migration `0024_calendars` (card type, two
attribute_defs, five edges, admin `card.*` grants for clean-up).

Handlers (AllowedRoles `$authenticated`; the SQL function enforces owner
= the caller's person card via `user_account_person`):

| handler | |
|---|---|
| `calendar.list {}` | the caller's calendars, each with its URLs (id, comment, created, last fetched, last client, last error) |
| `calendar.set {id?, title, predicate, past_days, future_days}` | create / update; days 0–3650, defaults 30 / 365 |
| `calendar.delete {id}` | deletes the card; its URLs go with it (cascade) |
| `calendar_url.create / .update / .delete` | §5 |

**Feed:** `GET /api/v1/calendar/{token}.ics` (also without `.ics`),
public, sensitive path. Token → `card_access` (`calendar`) → calendar →
owner person → user account (none / disabled → 404). One query:

```
tasks, not deleted, visible to the owner (schema.VisibilityClause — off
areas included), matching the calendar's predicate (card.CompileTree,
@me = the owner), with
  av.attribute_def_id = <due_date> AND av.value_type_id < 50
  AND av.value >= to_jsonb(<from>::text) AND av.value <= to_jsonb(<to>::text)
```

The literal `value_type_id < 50` matches the partial index
`attribute_value_def_value (attribute_def_id, value) WHERE value_type_id
< 50` (scalars only, since migration 0034), so the range is an index scan;
ISO date strings sort in date order. At most 5000 events.

Each event (`text/calendar`, CRLF, lines folded at 75 octets, TEXT
escaped):

```
UID:task-<id>@<host>
DTSTAMP:<now UTC>
DTSTART;VALUE=DATE:<due>          DTEND;VALUE=DATE:<due + 1 day>
SUMMARY:#<id> <title>             (✓ in front when its status is in a terminal phase)
URL:<base>/task/<id>
DESCRIPTION:<project> · <status>\n<base>/task/<id>
TRANSP:TRANSPARENT
```

Calendar: `X-WR-CALNAME:<title>`, `REFRESH-INTERVAL;VALUE=DURATION:PT1H`,
`X-PUBLISHED-TTL:PT1H`. `<base>` = `KITP_PUBLIC_URL`, else the request's
scheme and host. Each fetch updates the URL's `last_used_at` and
`last_client` (User-Agent, 200 chars); a failure (a filter that no
longer compiles) answers 500 so the calendar app keeps its old copy, and
is stored in `last_error`.

### Comm log additions

`comm_log` gains a `route_id` column and indexes `(channel_id, at desc)`,
`(route_id, at desc)`. The column is added by `preDDL` in `migrate.go`, not
a migration: the generated index DDL runs before migrations and needs it. `comm_log.list` gains optional
`channel_id` and `route_id` filters.

New kinds (all with `transport` and, for POST/SMTP, `route_id` in the
detail):

| kind | |
|---|---|
| `received` | a message was filed: outcome (`reply` / `task` / `thread` / `ignored` / `notification_reply`), card, from, subject |
| `duplicate` | a copy of a message already filed in this project, with the original card |
| `inbound_refused` | a route filter refused it: `check` (sources / require_tls / sender_hosts / envelope_from / header_from / dkim / signature), and why |
| `dkim_result` | DKIM in `record` mode: what verified |
| `dkim_failed` | DKIM `require` + `on_fail: file`: filed anyway |
| `file_retry` | a passing failure to file it (in words that don't quote the message): IMAP logs a message's first one and tries it again on later polls; POST and SMTP log each, the sender being told to try again |
| `file_error` | it can never be filed, or (IMAP) it was set aside after failing for a day |

`parse_error` (mail that couldn't be read) gains `transport` / `route_id`.
An IMAP `poll` row counts the messages listed (`message_count`) and those
that failed to file (`failed`).

### Pages, help and logs

| page | on the page | help topic (`?`) | logs |
|---|---|---|---|
| Project → Comm Channels | "Receiving mail" section: IMAP, POST routes, SMTP routes, each with one line; the add-route dialog shows the chosen provider's steps; each filter has a one-line explanation | `admin_comm_channels.md` + receiving: every provider (Cloudflare Worker / forward, Mailgun, Postmark, SES via S3 + Lambda, Exchange **Redirect** rule, Gmail forward), what each filter proves, troubleshooting by log kind | each route row: last message, last refusal, **View log** (Comm log filtered to the route); the account: **View log** |
| Admin → Comm log | account and route filters; filters live in the URL so links land filtered | `admin_comm_log.md` rewritten to the kinds the code writes | rows link to the card they became; a duplicate to the original |
| Admin → Mail intake (new) | listener status, TLS certificate and expiry, proxy trust in effect, limits, which env var sets what | `admin_mail_intake.md`: MX + port 25, certificates, proxy setups (Traefik `proxyProtocol: {version: 2}`, HAProxy `send-proxy-v2`, nginx `proxy_protocol on`, AWS NLB) | recent connection-level refusals and throttled sources (memory) |
| Account (Calendars section) | per calendar: the filter, the window; under each URL: how to add it to Google / Outlook / Apple; privacy note | `account.md`: profile, notifications, calendars (each app's steps, refresh delays, what an event holds, revoking) | per URL: last fetched, by which app, last error |
| CSV import wizard | the date column says "YYYY-MM-DD only" | the import topic: date rules | the preview's per-row errors |

The help overlay maps `/account` to the `account` topic (account pages
have none today).

## As built

| Piece | Where |
|---|---|
| Strict dates | `server/internal/isodate`; `db/schema/functions/iso_date_ok.sql`, `iso_timestamp_ok.sql`; checks in `attribute_update_batch.sql`, `card_insert_batch.sql`, `activity_select_batch.sql`, `comm_log_list_batch.sql`, `user_token_create_batch.sql`, `project_import_{preview,commit}_batch.sql`, `card_compile_predicate.sql`, `internal/dom/card/where.go` (`checkDateValues`); migration `0023_due_date_iso` |
| Secrets out of logs | `server/internal/obs/logpath`; sites in `obs/logger.go`, `api/router.go`; `scripts/check-log-paths.sh` |
| Shared filing step, dedupe | `server/internal/dom/comm/intake.go` (`Intake.FileRaw`, `filer`, `messageKey`, `claimMessage`); `imap.go` `processOne`; table `comm_inbound_seen`; prune in `retention.go` |
| Secret routes | table `card_access`; `card_access_mint.sql`; `comm_route_{list,create,update,delete}_batch.sql`; `calendar_url_{create,update,delete}_batch.sql` |
| POST intake | `server/internal/dom/mailin/post.go`, `route.go`, `policy.go`, `dkim.go` |
| SMTP listener | `server/internal/dom/mailin/smtpd.go`; PROXY sniffing `server/internal/netx/proxyproto.go`; client IP + trusted proxies `netx/trusted.go`; limits `netx/ratelimit.go` |
| Mail intake status | `server/internal/dom/mailin/status.go` (`mail_intake.status`) |
| Calendars | `server/internal/dom/calendar` (`calendar.go`, `feed.go`, `ics.go`); `calendar_{owned_by,list,set,delete}*.sql`; migration `0024_calendars` |
| Wiring | `server/cmd/kitpd/main.go` (env vars listed at the top) |
| Web | `web/src/mailin/`: `specs.ts`, `comm-routes.ts` (Comm Channels' RECEIVING MAIL panel), `comm-log.ts` (the Comm log screen), `mail-intake.ts` (Admin → Mail intake), `calendars.ts` (Account → Calendars); `web/test/mailin.test.mjs` |
| Tests | `internal/isodate`, `internal/dom/attribute/strict_dates_test.go`, `projectimport` (`TestProjectImportDueDates`), `store` (0023 / 0024), `obs/logpath`, `comm/dedupe_test.go`, `netx`, `mailin` (POST, SMTP), `calendar` |

## Second round: files from email, and sending replies on

Raised by the user during the build (2026-11-03), decided the same day and
built. Three pieces.

### Decisions

| # | Decision |
| - | -------- |
| R1 | Both new settings sit on the **mail account** (comm_channel), beside New mail and Quoting in replies — not on each thread. |
| R2 | **Emailed replies** (`relay_replies`: `on` / `off`). A new account is created `on`; an account from before the setting has no value, which reads as `off` — nothing a running account does changes until an admin switches it. |
| R3 | Copies never go to **kitp users** (a person linked to a login): they see the reply in kitp, and their notification subscriptions cover email. |
| R4 | **Attachments from email** (`email_attachments`: `keep` / `drop`); unset = `keep`, as before. |
| R5 | Files on incoming mail **live on the thread** (the comm card), never on its task — whether or not the thread is on one. Attach / Detach move no files. |
| R6 | **Add to task** *moves* the file (the attachment row's card becomes the task); the messages keep their link (`reply_body_attachment`), so the thread still shows it. Not a second row: kitp never stores the same file twice. |
| R7 | **No duplicates, either way**: an incoming file whose bytes (sha256) kitp already holds for the thread — on it, on its task, or linked from any of its messages — is linked, not stored. Add to task for a file the task already has merges into the task's copy. Cheap: files already carry their hash. |
| R8 | Files already moved onto tasks before this change stay where they are (no migration). |
| R9 | A reply written in kitp can carry the task's files or the thread's own. |

### Files from email

```
any thread:        email file ──▶ stored on the thread, linked to its message
the same bytes:    ──▶ linked to the copy kitp has (thread, task, or a message's)
Attach / Detach:   nothing moves
Add to task:       the file moves onto the task; the message keeps showing it
```

- Intake (`imap.go` `appendReceivedReply` → `ingestInboundAttachments`):
  the host is always the comm; `findThreadFile` looks for the bytes among
  the comm's and its task's attachments and those linked from the thread's
  messages. Ingest runs in a savepoint, so a file that fails to land
  doesn't lose the message (before, a failed statement aborted the whole
  message's transaction despite the "keep going" comment). The
  `KITP_COMM_SAVE_RAW_EMAIL` `.eml` also lands on the comm, and is kept
  even on a *drop* account (an operator's debugging switch).
- **drop**: the message is filed without its files, its
  `attachments_left_off` counts them, and an `attachments_dropped` Comm
  log row names them.
- `comm.attachment_to_task {comm_id, attachment_id}` →
  `{attachment_id, task_id}` (`comm_attachment_to_task_batch.sql`): the
  thread must be on a task (`not_on_task`), Tasks on (`area_off`), the file
  on this thread (`not_on_thread`), the caller holding task `card.update`
  (`forbidden`; the dispatcher gates comm `card.update`). Writes an
  `attachment_create` activity on the task (`from_comm_id`), so the feed
  reads "attached invoice.pdf". A merge soft-deletes the thread's row,
  repoints the messages and writes `attachment_delete` (`merged_into`) on
  the comm. Already on the task → ok, no writes.
- `comm.attach` no longer moves the thread's files.
- `reply.post` accepts attachment ids on the thread or its task.
- `comm.list_for_task`: each message has `attachments` (`id`, `filename`,
  `mime_type`, `size_bytes`, `on_thread`) and `attachments_left_off`.
- The conversation lists a message's files (download links); on a task's
  threads a file that is still the thread's has **Add to task**, and a
  moved one says *on the task*. The task's Attachments reload after a move.

### Sending replies on

```
Ada ──reply──▶ support@ ──▶ filed on the thread
                              └─▶ copy, From: "Ada Lovelace via Support" <support@…>
                                  To: the thread's people, minus Ada, minus anyone
                                  on her To/Cc, minus support@, minus kitp users
```

- Who (review 2026-11-03 #3, #10, round 2 #1, round 3 #5, #8). The
  thread's own account (its `channel_ref`) decides whether replies are
  sent on, and its address and name go on the copy, whichever account the
  reply came in on. Only the thread's *confirmed* people take part, and
  only kitp confirms anyone — nothing a received message says (its From,
  To and Cc aren't authenticated): the people a person in kitp added to the
  thread (`comm.create`'s recipients; `comm.set_recipients`, the people it
  adds) and the person who started the thread by mail, kept in
  `comm.comm_confirmed` (`comm_confirm`, kitp-set only). A staff reply
  confirms nobody: `reply.post` writes to everyone on the thread, including
  whoever a received message put there.

  Mail whose From is a kitp user's (a login's email, or the primary or a
  verified address of a person with a login) is never sent on
  (`sender_is_user`): kitp users write in kitp (R3), and an unauthenticated
  From could otherwise go out as "Carol via Support" from the account's own
  address (review 2026-11-06 #8). It is filed as usual.

  The sender must be confirmed (`sender_unconfirmed`) and on the thread
  before this message (`sender_not_on_thread`; `processOne` reads the
  recipients before filing); the copy goes to the confirmed people on the
  thread. Someone a correspondent Cc'd joins the thread and gets staff
  replies, but no copies until staff add them (take them off and add them
  again). Someone staff take off loses their confirmation and is kept in
  `comm.comm_removed` (`comm_remove`, kitp-set only): their later mail is
  filed but doesn't put them back on the thread. Threads filed before 0032
  have no `comm_confirmed`: their people take part once staff add them. At
  most 20 recipients (`too_many_recipients`), and at most 20 copies per
  thread in an hour (`rate_limited`); a From with other than one
  address is `no_sender`. Copies carry `X-Loop` (the account's address),
  and mail carrying `X-Loop` is never sent on. Route addresses (`…@KITP_SMTP_DOMAIN`) never
  join a thread, and one message puts at most 50 addresses on it
  (`MaxSyncPeople`). An address with a quoted local part or a domain
  literal (`"a@b, c"@d`, `x@[1.2.3.4]`) is refused wherever kitp parses
  one (`comm.PlainAddress`), and left off a To list (`email_plain`).
  A relay failure is logged and leaves the message filed.
- `relay.go` `relayReply`, called by `processOne` after a reply is filed
  on an existing thread (a new thread has nobody else on it). The copy is
  a pending `reply_body` on the thread (so it is visible, purged and sent
  like any message kitp sends) with `relay_of` = the original:
  `reply_to` the recipients, `reply_from` the display From, the inbound
  subject and body, the original's files linked (not copied) unless
  together they exceed `MaxReplyAttachmentBytes` (20 MB) — then none, an
  `attachments_left_off` count, and a line in the body saying so. The raw
  `.eml` kept with `KITP_COMM_SAVE_RAW_EMAIL` is never on a copy.
- Never sent on (`relay_skipped`, with `reason`): `AutoKind` set at parse
  (`automaticKind`: `Auto-Submitted` ≠ no, `Precedence` bulk / junk /
  list / auto_reply, `X-Autoreply` / `X-Autorespond`, `List-Id`,
  `multipart/report`, `Return-Path: <>`, From MAILER-DAEMON / postmaster),
  a notification reply, mail from the account's own address, or an account
  with no From address. Nobody left to send to is not logged.
- A copy that is queued logs `relay_queued` (`reply_id`, `copy_id`, `to`).
- The SMTP sender, for a copy (`relay_of` ≠ 0): no signature, quote or deep
  link; `Auto-Submitted: auto-forwarded` (RFC 3834 — so an out-of-office
  reply to it isn't sent on again, which also bounds any loop to one hop);
  the envelope sender is the bare address. Quoting (`loadEarlier`) skips
  copies.
- `comm.list_for_task` doesn't list a copy as a message; it is the
  original's `relay` (`id`, `to`, `delivery_status`,
  `attachments_left_off`), shown as *Sent on to bob@… · sent*. The approval
  list's message count skips copies too.
- Hardening found on the way: `buildMIME` turns line breaks in header
  values into spaces. A subject or name from mail (a decoded `=?…?=` word
  can carry CR LF) could otherwise have started a header of the sender's
  choosing — task titles from mail reached outbound subjects before this.

### Schema

- attribute_defs `relay_replies`, `email_attachments` (text, on
  comm_channel), `relay_of`, `attachments_left_off` (number, on
  reply_body); seed + migration `0025_relay_and_email_attachments`;
  stable counts 97 / 146.
- `comm_channel.set` / `.list` carry both settings (`on`/`off`,
  `keep`/`drop`; anything else is `validation`); `.set` writes `on` for a
  new account that doesn't say.

### Pages and help

- Comm Channels: **Emailed replies** and **Attachments from email**, each
  with a caption on the form; help `admin_comm_channels.md` (Files from
  email, Sending replies on), `admin_comm_log.md` (the three kinds and a
  troubleshooting line), `task_detail.md` (Files that came by email).
- Comm log: kinds `attachments_dropped`, `relay_queued`, `relay_skipped`,
  each summarised as a sentence.

### As built (second round)

| Piece | Where |
| ----- | ----- |
| Settings | `comm_channel_set_batch.sql`, `comm_channel_list_batch.sql`; `comm.go` `ChannelSetInput` / `ChannelRow`; `imap.go` `ResolveRelay`, `ResolveKeepAttachments`, `channelIntake`; `intake.go` `loadIntake` |
| Files on the thread | `imap.go` `appendReceivedReply`, `ingestInboundAttachments`, `findThreadFile`, `leaveFilesOff`, `withSavepoint`, `threadTask` |
| Add to task | `comm_attachment_to_task_batch.sql`; `comm_attach.go` (`comm.attachment_to_task`); `comm_attach_batch.sql` (moves nothing) |
| Replies | `reply_post_batch.sql` (thread or task files) |
| Relay | `relay.go` (`relayReply`, `automaticKind`, `relayRecipients`, `queueRelayCopy`); `smtp.go` (`relayOf`, `mimeHeader`, `oneLine`, `loadEarlier`) |
| Listing | `comm_list_for_task_batch.sql` (`attachments`, `attachments_left_off`, `relay`); `approval_list_batch.sql` (message count) |
| Web | `admin/comm-channel-form.ts`, `admin/nested-editor.ts` (draft + options); `task-detail/comm-specs.ts` (decode, `comm.attachment_to_task`); `task-detail/task-comm-threads.ts` (files, Add to task, `relayText`, `leftOffText`); `task-detail/task-detail.ts` (`onFilesChanged`); `mailin/comm-log.ts` (kinds) |
| Tests | `comm/files_relay_test.go`; `attachment_test.go`, `conversations_test.go` (files stay on the thread); `store` 0025; `web/test/email-files-relay.test.mjs`, `mailin.test.mjs` |

### Files in the conversation (third round)

Asked for 2026-11-03 after the second round: see, pick and view the files
replies carry.

- Each message file: an image / PDF / markdown file opens in the viewer
  the task's Attachments uses — now one shared helper,
  `web/src/task-detail/file-gallery.ts` (`FileGallery`), which pages
  through the thread's files; every file has **Download**; Add to task as
  before. `comm.list_for_task` gives each file its `kind`
  (`attachment_kind`).
- The reply box: **Attach files** opens a picker of the thread's files and
  the task's (`attachment.list` on each; a thread's own page lists only
  its own), plus **Upload from your computer…**, which uploads onto the
  thread (`uploadFile`, `attachment.create` gated on comm `card.update`)
  and ticks the file. Chosen files show as chips with their count and
  total; over `MAX_REPLY_FILE_BYTES` (20 MB, the sender's limit) the reply
  is held with its text kept. Sent as `reply.post` `attachment_ids` —
  links, never copies.
- Tests: `web/test/email-files-relay.test.mjs` (viewer, picker, the limit,
  a thread's own page, upload); `attachments-section.test.mjs` covers the
  section on the shared viewer.

### Also done during the build

- Ctrl+Enter (⌘+Enter on a Mac) sends from the approval boxes: in a vote's
  reason box it sends the vote (approve — the box opens before a side is
  picked; confirmed with the user 2026-11-03), in "Ask for a vote" it asks. The shortcut is
  one shared helper, `web/src/ui/submit-shortcut.ts`
  (`bindSubmitShortcut`, `isSubmitShortcut`, `submitShortcutHint`), which
  the comm reply composer and editable fields now use too; each box's
  placeholder names it.

## Build checklist

- [x] 1 Strict dates: `isodate` + SQL helpers; attribute.update; card.insert; import preview; activity.select; comm_log.list; user_token.create; CompileTree; migration 0023; tests
- [x] 2 `logpath.Of` + six sites + lint script + alloc test
- [x] 3 `comm.Intake` (IMAP moved onto it)
- [x] 4 `comm_inbound_seen` + dedupe + prune + tests
- [x] 5 `card_access` + `comm_route.*` + tests
- [x] 6 POST intake (raw / mailgun / postmark) + `netx.ClientIP` + rate limits + tests
- [x] 7 SMTP listener + PROXY sniff + policies + DKIM + `mail_intake.status` + tests
- [x] 8 Calendars: card type + migration 0024 + handlers + `calendar_url.*` + feed + tests (incl. EXPLAIN uses the index)
- [x] Comm log: `route_id` (preDDL), filters, new kinds
- [x] Web: Comm Channels receiving section; Comm log filters + URL; Mail intake page; Account calendars; import note
- [x] Help topics: comm channels (receiving mail, every provider, filters, answers, troubleshooting), comm log (rewritten to the kinds the code writes), mail intake, account (`/account` now maps to it); the import wizard's are folded into its mapping step (a dialog the route-based overlay can't point at)
- [x] CLAUDE.md: date rule, LogPath rule, the shared filing step; docs cross-links (CONVERSATIONS, email_comm, README)
- [x] Full Go suite (all packages; store and the packages changed late re-run), web suite (1159), tsgo, vet, both lints; an end-to-end smoke run of the built kitpd (POST, SMTP, filters, Comm log, calendar feed, no tokens in the log)

Second round:

- [x] R: settings `relay_replies` / `email_attachments` (seed, 0025, set / list, web form + captions)
- [x] R: files on the thread, dedupe against thread + task + messages, savepoint, drop path + `attachments_dropped`
- [x] R: `comm.attachment_to_task` (move, merge, refusals); `comm.attach` moves nothing; `reply.post` takes thread or task files
- [x] R: relay (`relay.go`), `AutoKind`, SMTP sender copy handling, quoting skips copies, listing folds copies, approval message count
- [x] R: header line-break hardening in `buildMIME`
- [x] R: help (comm channels, comm log, task detail), docs (CONVERSATIONS, email_comm, CLAUDE.md)
- [x] R: full Go suite (51 packages; cmd/kitpd after its golden update and the card bench test re-run alone), web suite (1173), tsgo, vet, both lints; a smoke run of the built kitpd (19 checks: settings, files on the thread, linked repeats, relay to Bob only and sent, auto-reply skipped, Attach moves nothing, Add to task, drop; no tokens in the log)
