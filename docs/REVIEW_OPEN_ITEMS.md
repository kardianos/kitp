# Open items after the 2026-11-03 review

The 2026-11-03 review ran five rounds on `bundles-portals`, then a final
check of the fixes. Rounds 1–4 were fixed in their own commits; the items
left after round 4 in `4b143db..503efe6`; and the final check's findings in
`70f3c77..` (accounts, mail, writes, files, HTTP). This note lists what is
still open, and what a deployment of those commits needs to know.

## Known limits (left as they are)

- **Logins revoked under the round-2 code had their identity cleared.**
  Revoking then cleared the login's OIDC subject and email. Such a login
  can't be matched any more, so it can't be blocked when its person
  signs in again.
- **Odd addresses already stored on person cards stay.** Addresses kitp
  doesn't send to (`email_plain` false: display names, comments, quoted
  local parts) are skipped when mail is sent, not cleaned out of the
  cards.
- **Migrations 0034, 0037, 0038 and 0039 run inside the boot
  transaction.** On a large database the first boot after them holds its
  locks for as long as they take.
- **Roles from the identity provider are reconciled only at sign-in.**
  Someone the IdP removes keeps their OIDC-granted roles in kitp until
  they sign in again. Their sessions end within
  `KITP_SESSION_ABSOLUTE_DAYS` (default 45), but their own API tokens and
  their agents' keep working with those roles until the tokens expire:
  at most `KITP_TOKEN_MAX_DAYS` (default 365) for tokens minted now, never
  for tokens minted before the cap without an expiry. Leavers are revoked
  in kitp (People → revoke login), which ends their sessions and tokens at
  once.
- **One IMAP poll can still create up to 2,500 people** (50 messages × 50
  addresses), on threads with room; a thread with 100 recipients adds
  nobody.
- **Set-aside mail moves only on servers with MOVE or UIDPLUS.** Elsewhere
  a message that can never be filed is logged and marked read in INBOX.
- **A replayed token or link batch mints again.** A batch that mints a
  token or a signed link isn't kept for Idempotency-Key replay. A retry
  with the same key makes a second token, and the first stays valid until
  it is revoked or expires.
- **A rolling deploy from before `0728c8c` can send a message twice:**
  pods running older code don't claim outgoing mail.
- **A running `kitpd mcp` checks its token only at start.** Revoking or
  expiring the token doesn't stop a process already running (it holds
  database credentials anyway).
- **Not done from the final check's "worth a look" list:** person reuse at
  sign-in takes the lowest-id person with the email; `user.unlink_person`
  then a grant to the same person gives the old login's private cards to
  the new one; an agent can read its owner's files that were never
  attached; a message that always fails to file for a passing reason
  fails every poll; outgoing mail carries no In-Reply-To / References, and
  a 5xx for one recipient bounces the whole message; a request naming
  someone who can no longer vote stays open in the tally; personal views
  are open to viewers; writes to your own private cards skip the
  bundle-source and area checks.

## Still open (could be done later)

- **Two indexes are built at boot without `CONCURRENTLY`:**
  `idx_activity_created_at` and `user_account_parent_user_id`. On a large
  `activity` table, writes to it wait while the first builds (once).

## Deploying `4b143db..`

- **Entra ID and email.** kitp trusts an email claim only with
  `email_verified: true` or — Entra ID's way — `xms_edov: true`. Add the
  optional claim `xms_edov` to the app registration's ID token (Token
  configuration → Add optional claim → ID), or set
  `KITP_OIDC_TRUST_UNVERIFIED_EMAIL=1` if the tenant's emails are
  admin-managed. Without either, logins keep the emails they hold but new
  ones store none, and `KITP_INIT_ADMIN_EMAIL` recovery reaches only a
  login that holds the email.
- **The ID token's `aud` is checked against `OIDC_CLIENT_ID`** when
  `OIDC_AUDIENCE` is unset.
- **Tokens expire.** New tokens default to 365 days and can't be set
  past `KITP_TOKEN_MAX_DAYS` (default 365; a value outside 0–36500
  refuses startup). Forge (Gerrit) tokens need rotating within that time.
- **`kitpd mcp` needs `KITP_TOKEN`,** or `KITP_MCP_AS_SYSTEM=1` to run as
  the System user; its attachment links need `KITP_LINK_SECRET` (the
  server's own).
- **100.64.0.0/10 isn't trusted as a proxy by default** (carrier-grade
  NAT, Tailscale). For HTTP only POST mail intake reads the client
  address, so behind a proxy there every sender looks like the proxy. For
  SMTP, a PROXY header from an untrusted peer is refused: an SMTP load
  balancer in 100.64/10 that sends PROXY headers stops SMTP intake until
  it is named in `KITP_TRUSTED_PROXIES`.
- **The cross-origin check is on in every mode,** `AUTH_MODE=off` and CORS
  included. A dev app served from another origin goes in
  `KITP_TRUSTED_ORIGINS`.
- **Sign-in starts are limited:** 20 a minute per address (bursts of 40)
  and 1,200 a minute overall; past that, 429.
- **`activity.select` with neither a card nor a project** covers the last
  30 days by default and at most 92.
- **Unfileable mail goes to the IMAP folder `kitp-set-aside`.** Name
  another with `KITP_COMM_IMAP_SET_ASIDE_FOLDER`, or set it empty to leave
  such mail in the inbox.
- **A passing send failure is retried** 6 times over about 4 h 20 min
  (Comm log `send_retry`) before the message is failed; each send has 75
  seconds, and its result is recorded however long it took.
- **Threads over 100 recipients** (from before the caps) refuse staff
  replies until trimmed to 100, which the thread's recipient chips now
  allow one at a time.
- **Caps now enforced:** a file has at most 100,000 chunks; people
  already past a personal cap (200 screens, 200 watch lists, 50
  calendars, 500 personal views) keep their cards but can't add more.
- **A card its project uses stays put:** a flow's starting state can't be
  deleted, merged or moved to another project, nor can a card other cards
  of its project point at (change them first).
- **POST mail intake** reads at most 2 bodies per route at once, each
  within 60 seconds.
