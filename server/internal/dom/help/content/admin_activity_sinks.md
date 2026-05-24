# Activity sinks

An **activity sink** is a project-scoped destination that mirrors a slice of the project's activity stream into an external system. Today the only sink kind is `msgraph_teams`, which posts new activity rows into a Microsoft Teams channel via the Graph API.

The sink runs as a background pump on the server: one goroutine per enabled sink scans new activity rows past its last-pushed pointer, evaluates the stored filter against each row, and posts every match downstream. State (the pointer plus the last error reported by the push) lives on a sidecar table — it never writes back into the activity stream it is reading from.

## What lives on a sink

| Attribute              | Purpose                                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| `name`                 | Human-readable label shown in the admin list and used as the card title. |
| `sink_kind`            | Sink type. v1 supports `msgraph_teams` only.                             |
| `msgraph_tenant_id`    | Azure AD tenant the Graph app is registered in.                          |
| `msgraph_client_id`    | Azure app registration client id.                                        |
| `msgraph_client_secret`| Azure app client secret. Stored encrypted via pgcrypto and never read back over the wire. Leave blank on edit to keep the stored value. |
| `msgraph_team_id`      | Teams team (group) id to post into.                                      |
| `msgraph_channel_id`   | Teams channel id within the team.                                        |
| `activity_filter`      | JSON predicate restricting which rows are pushed. Empty = push everything. |
| `channel_status`       | `enabled`, `disabled-admin` (Pause), or `disabled-fault` (set by the pump). |

## The activity filter

The filter is a tree of AND / OR groups around `kind_in` / `attr_in` / `actor_in` leaves (and their `*_not_in` inverses). The **Visual builder** button on the edit pane authors it without writing JSON by hand:

| Operator       | Matches when                                                       |
| -------------- | ------------------------------------------------------------------ |
| `kind in`      | The activity row's kind is in the chosen list.                     |
| `kind not in`  | Inverse of `kind in`.                                              |
| `attribute in` | Row is an `attr_update` and the changed attribute is in the list.  |
| `attribute not in` | Row is **not** an `attr_update` for any of the listed attributes. Non-`attr_update` rows pass through. |
| `actor in`     | The user that performed the change is in the chosen list.          |
| `actor not in` | Inverse of `actor in`.                                             |

An empty filter (no JSON, or an empty top-level AND group) pushes every row downstream. An unknown op fails closed server-side so a typo cannot silently flood a channel.

## Status and faults

`channel_status` is tri-state:

- **Enabled** — the pump runs.
- **Paused** — the pump skips this sink. Use this when you need to temporarily quiet a noisy channel without losing the configuration.
- **Fault** — the pump itself flipped the sink off because a push failed (auth expired, channel id rotated, filter unparseable). `channel_fault_reason` carries the diagnostic; re-enabling the sink clears it.

The **Last push** column shows the most recent successful push timestamp and cumulative pushed-row count. **Pointer** is the activity id the pump last consumed; rows below the pointer are never re-pushed even if you change the filter.

## Related admin pages

- **Comm channels** — outbound email/IMAP channels (different kind of destination; not driven by the activity stream).
- **Comm log** — read-only view of comm channel activity, useful as a debugging companion when investigating sink faults.
