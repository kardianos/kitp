# Comm log

What the active project's mail accounts received, sent, refused or couldn't read — newest first. It is the first place to look when mail isn't arriving, isn't going out, or lands somewhere unexpected.

## Filters

| Filter | What it does |
| ------ | ------------ |
| **Account** | One mail account, or all of them. |
| **Route** | With an account picked: one of its inbound routes (a POST URL or SMTP address), or all. |
| **Kind** | One kind of event (below), or any. |
| **Since** | The last hour, 24 hours (the default), 7 days or 30 days. |

The filters are part of the page address (`/admin/comm_log?channel=…&route=…&kind=…&window=…`), so a view can be bookmarked or sent to someone. **View log** on a route or account in Comm Channels opens the log already filtered to it.

Each row reads as a sentence — who it was from, the subject, what it became or why it was refused. **Open thread** goes to the thread a message became; **Only this route** narrows to the route a row came through; **Details** shows the whole record.

## Kinds

| Kind | Meaning |
| ---- | ------- |
| `received` | A message was filed. Its outcome: *a reply on its thread*, *a new task and thread*, *a new thread*, or *nothing* (the account's New mail is set to ignore). Details name the transport (IMAP, POST or SMTP) and, for POST / SMTP, the route. |
| `duplicate` | A copy of a message already filed in this project — another copy of the same Message-ID, from any account or route. It isn't filed again; Open thread goes to where the first copy went. |
| `inbound_refused` | A route's filter turned a message away. `check` says which (`sources`, `require_tls`, `sender_hosts`, `envelope_from`, `header_from`, `dkim`, `signature` for Mailgun, `raw_email` for Postmark, `size`, `body`) and `reason` why. |
| `unmatched_thread` | New mail on an account whose New mail is *is ignored*: only replies to existing threads come in. |
| `parse_error` | The message couldn't be read as mail. POST and SMTP log it and drop it (retrying can't help); IMAP marks it read and leaves it in the mailbox. |
| `dkim_result` | DKIM in *record only* mode: which signatures checked out. Nothing is refused. |
| `dkim_failed` | DKIM required, the signature didn't check out, and the route files it anyway (*on failure: file*). |
| `notification_reply` | A reply to a notification digest; dropped, so answering a digest never files a task. |
| `attachments_dropped` | A message filed without its files, because the account's **Attachments from email** is *not kept*. Details give how many and their names. |
| `relay_queued` | A reply that reached only the account was sent on to the thread's other people (**Emailed replies**). `to` lists them; the copy's own `send_ok` / `send_fail` follows. |
| `relay_skipped` | A reply that wasn't sent on. `reason`: `auto_submitted`, `precedence`, `auto_reply`, `mailing_list`, `report` (a delivery or read report), `bounce`, `notification_reply`, `own_address` (from the account itself) or `no_from_address` (the account has none to send from). |
| `poll` | An IMAP poll and how many messages it fetched — the account is alive. |
| `imap_auth_fail` | IMAP refused the sign-in. After a credential failure the account is set to *fault* until fixed. |
| `send_ok` / `send_bounce` / `send_fail` | A reply kitp sent: accepted, refused by the receiving server (5xx), or failed (a connection or other error). A bounced or failed reply isn't sent again; it shows as such on its thread. |
| `notify_ok` / `notify_bounce` / `notify_fail` | The same for notification digests. |

## Troubleshooting

- **Nothing at all for a POST or SMTP route:** the provider isn't reaching kitp. For POST, check the URL in the provider and that it gets 200 back. For SMTP, check the MX record and port 25 (Admin → Mail intake), and its *Recent refusals*: an unknown address, a client that spoke before the greeting or an untrusted PROXY header are refused before reaching any account, so they show there, not here.
- **`inbound_refused`:** the route's filters are stricter than the sender. The reason says which value didn't match; loosen or fix the filter on the route.
- **`duplicate` where you expected a new thread:** that Message-ID was already filed in this project (perhaps through another account). Dedupe remembers a message for 14 days after its last copy (`KITP_COMM_DEDUPE_DAYS`).
- **`unmatched_thread`:** set the account's New mail to create a task or a thread.
- **Someone on a thread didn't get a reply that was sent on:** look for `relay_queued` (who it went to) and the copy's `send_fail` / `send_bounce`. No row means nobody was left to send to — everyone was on the reply already, or the rest are kitp users, who aren't sent copies.

Rows are kept 30 days (`KITP_COMM_LOG_RETENTION_DAYS`).
