# Comm log

A read-only stream of comm-channel events for debugging and audit. Every message the runtime fetches from IMAP, hands off to SMTP, or refuses with an error lands here as a row in the ring buffer.

The log is project-scoped, but the title-bar **all** option fans out into one `comm_log.list` per project the admin can see and merges results into a single stream.

## Header controls

| Control      | Behavior                                                                |
| ------------ | ----------------------------------------------------------------------- |
| **Project**  | Filter to one project, or `all` for the union across every visible project. |
| **Kind**     | Chip row that toggles individual event kinds. "Any" clears the filter.  |
| **Window**   | Time window — `1h`, `24h`, `7d`, or a custom range. Default is 24h, matching the server's fallback when no `since` is given. |

## Event kinds

| Kind                | Meaning                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| `inbound_received`  | An IMAP message was fetched and parsed successfully.                     |
| `inbound_routed`    | The parsed message was routed to a domain handler (new task / reply / refused). |
| `inbound_refused`   | A message hit a refusal — unknown sender, missing required header, blocklist. |
| `outbound_queued`   | A handler enqueued a message for SMTP.                                   |
| `outbound_sent`     | SMTP accepted the message and the runtime moved the row to "sent".       |
| `outbound_bounced`  | SMTP rejected the message or a bounce returned later.                    |
| `channel_fault`     | The poller / sender flipped the channel into `disabled-fault`. `detail` carries the diagnostic. |
| `channel_recovered` | A previously faulted channel reconnected cleanly.                        |

## Reading a row

Each row renders:

- **Time** — UTC timestamp of the event.
- **Kind chip** — colour-coded by family (inbound / outbound / control).
- **Channel** — the channel name (or "system" when no channel was involved).
- **Detail** — kind-specific structured content. Inbound rows show sender + subject; outbound rows show recipient + subject; fault rows show the error string. The renderer lives in `admin_comm_log_helpers.ts` so the formatting is unit-testable.

## Retention

The log is a per-project ring buffer (a fixed window of rows kept in `comm_log`; older rows are pruned by a background job). It's a debugging surface — long-term audit lives in the activity stream, not here.

## Related admin pages

- **Comm channels** — author and pause the channels whose events surface here.
- **Activity sinks** — push the *system* activity stream outbound. Comm log is the inverse: incoming comm events landing on the inbound side.
