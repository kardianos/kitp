# Open items after the 2026-11-03 review

The 2026-11-03 review ran five rounds on `bundles-portals`. Rounds 1–4
were fixed in their own commits. The items left open after round 4 were
fixed in five area commits, `4b143db..503efe6`: mail, accounts, files,
writes and HTTP. This note lists what is still open, and what a
deployment of those commits needs to know.

## Known limits (left as they are)

- **Logins revoked under the round-2 code had their identity cleared.**
  Revoking then cleared the login's OIDC subject and email. Such a login
  can't be matched any more, so it can't be blocked when its person
  signs in again.
- **Odd addresses already stored on person cards stay.** Addresses kitp
  doesn't send to (`email_plain` false: display names, comments, quoted
  local parts) are skipped when mail is sent, not cleaned out of the
  cards.
- **Migrations 0034, 0037 and 0038 run inside the boot transaction.** On
  a large database the first boot after them holds its locks for as long
  as they take.
- **OIDC roles are checked only at sign-in.** A role the identity
  provider takes away applies at the next sign-in, at most
  `KITP_SESSION_ABSOLUTE_DAYS` (default 45) later. Revoking the login in
  kitp applies at once.
- **One IMAP poll can create up to 2,500 people** (50 messages × 50
  people a message).
- **Set-aside mail moves only on servers with MOVE or UIDPLUS.** Elsewhere
  a message that can never be filed is logged and left where it is.
- **A replayed token or link batch mints again.** A batch that mints a
  token or a signed link isn't kept for Idempotency-Key replay. A retry
  with the same key makes a second token, and the first stays valid until
  it is revoked or expires.

## Still open (could be done later)

- **Per-project `activity.select` checks every activity row.** For each
  row in the workspace it walks the card's ancestors, unless the request
  carries a date range, which can use `idx_activity_created_at`.
  Selecting the project's cards first and joining activity on
  `(card_id, created_at)` would bound it. The Activity page's default
  range wasn't checked.
- **`idx_activity_created_at` is built at boot without `CONCURRENTLY`.**
  On a large table, writes to `activity` wait while it builds (once).

## Deploying `4b143db..503efe6`

- **Tokens expire.** New tokens default to 365 days and can't be set
  past `KITP_TOKEN_MAX_DAYS` (default 365). Forge (Gerrit) tokens need
  rotating within that time.
- **`kitpd mcp` needs `KITP_TOKEN`,** or `KITP_MCP_AS_SYSTEM=1` to run as
  the System user.
- **100.64.0.0/10 isn't trusted as a proxy by default** (carrier-grade
  NAT, Tailscale). If the ingress sits there, name it in
  `KITP_TRUSTED_PROXIES`, or every client is seen as the proxy's address.
- **The cross-origin check is on whenever logins are** (anything but
  `AUTH_MODE=off`), CORS or not. A dev app served from another origin
  against real logins goes in `KITP_TRUSTED_ORIGINS`.
- **`activity.select` with neither a card nor a project** covers the last
  30 days by default and at most 92.
- **Unfileable mail goes to the IMAP folder `kitp-set-aside`.** Name
  another with `KITP_COMM_IMAP_SET_ASIDE_FOLDER`, or set it empty to leave
  such mail in the inbox.
- **A passing send failure is retried** 6 times over about 4 h 20 min
  (Comm log `send_retry`) before the message is failed.
