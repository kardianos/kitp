# Activity notifications

Outbound notifications reuse the **activity sink** pump. Admins configure
sinks per project; project members opt in with personal subscriptions.

## Model

```
project
 └─ activity_sink             admin: output + transport (+ optional filters)
     └─ activity_subscription user: subscriber, event filter, card filter, rollup
```

| sink_kind       | Delivers to                         | Who it's for | Filters / rollup live on |
|-----------------|-------------------------------------|--------------|--------------------------|
| `msgraph_teams` | one Teams channel (MS Graph)        | broadcast    | the sink                 |
| `email`         | each subscriber's email, sent through the sink's `comm_channel` (`channel_ref`) | personal | each subscription; the sink's filters are an admin ceiling ANDed in |

Creating an email sink is the admin's opt-in for that project mailbox.
Members subscribe from **Account → Notifications**; a Teams sink takes no
subscriptions.

### Subscription card (`activity_subscription`)

| attribute             | meaning |
|-----------------------|---------|
| `title`               | display name |
| `subscriber`          | card_ref → the caller's person card (always the caller; never on the wire) |
| `activity_filter`     | event filter JSON — `dom/activitysink/predicate.go` (`kind_in`, `attr_in`, `actor_not_in` …; `"@me"` = the subscriber in actor leaves) |
| `predicate`           | card filter JSON — the screen-filter tree, compiled by `card.CompileTree`; `"@me"` = the subscriber's person |
| `rollup_minutes`      | 0–1440; 0 = next pump tick |
| `channel_status`      | `enabled` / `disabled-admin` (paused) / `disabled-fault` (bounce, no address, bad filter) |

Ownership: every tier (viewer … admin) holds the dedicated
`activity_subscription.set` / `.delete` processes on this card type; the SQL
functions enforce subscriber = caller (admins exempt). Generic `card.*` on the
card type stays admin-only, so `attribute.update` can't edit someone else's
subscription. Subscription cards are visible to the project like any card, and
their edits write normal activity rows (only changed attributes).

## Pump

One worker per **delivery unit** (a Teams sink, or a subscription under an
email sink), driven by the `activitysink.pump` job
(`KITP_ACTIVITY_SINK_TICK_SEC`, default 30s). Per tick:

1. Skip unless the sink, the subscription and (email) the comm channel are
   `enabled` — a paused unit keeps its position and resumes later.
2. Hold while `pending_since + rollup_minutes` is in the future.
3. Scan the project's activity rows past `activity_sink_state.last_activity_id`.
4. Keep rows passing the event filters and whose **subject card** (nearest task
   ancestor-or-self — a comm's activity belongs to its task) passes the card
   filters. A subscription also requires the subscriber to still see the
   project (DI-6); otherwise the scanned rows are dropped.
5. First match younger than the rollup → park just before it and start the
   clock (`pending_since` = its `created_at`). Otherwise deliver every match as
   one digest and advance.
6. Delivery errors keep the position for a retry; permanent ones (SMTP 5xx,
   Teams 4xx, no recipient address, invalid filter) fault the unit.

A new subscription starts at the current `max(activity.id)` — it never replays
history.

## Digest

Grouped by task, in first-seen order; each group is `#<id> <title, ~60
chars>`, the task link (`KITP_PUBLIC_URL/task/<id>`, when configured), then
its changes. Repeated changes to one attribute roll up to `first old → last
new (N changes)`; comments (with their text), attachments and lifecycle events
stay one line each. Email is plain text (quoted-printable) with a footer
linking `/account`; Teams gets the same structure as HTML.

Email is marked — Message-ID `<kitp-notify.<unit>.<rand>@domain>`,
`X-Kitp-Notification`, `Auto-Submitted: auto-generated` — and the IMAP poller
drops inbound mail whose `In-Reply-To` / `References` point at one
(`comm_log` kind `notification_reply`), so replying to a digest never files an
intake task. Sends are audited in `comm_log` as `notify_ok` / `notify_bounce`
/ `notify_fail`. `KITP_ACTIVITY_SINK_DRY_RUN=1` or `KITP_COMM_SMTP_DRY_RUN=1`
logs the would-be digest instead of sending.

## Comm reply emails

Unrelated to subscriptions but shipped alongside: every outbound comm reply now
carries a `Task: <id>` line directly above the `Ref: <thread>` trailer, link or
not.
