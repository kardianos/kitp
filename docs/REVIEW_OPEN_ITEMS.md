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
  signs in again. That code never reached production.
- **Odd addresses already stored on person cards stay.** Addresses kitp
  doesn't send to (`email_plain` false: display names, comments, quoted
  local parts) are skipped when mail is sent, not cleaned out of the
  cards.
- **Migrations run inside the boot transaction.** On a large database
  the first boot after one holds its locks for as long as it takes.
  Production (2026-11-05: 791 cards, 7,387 activity rows, 90 MB) takes
  well under a second for 0015–0040.
- **Roles from the identity provider are reconciled only at sign-in,**
  and only when the ID token carries the role claim: Entra ID leaves
  `roles` out for someone with no app roles, so taking away their last
  one changes nothing in kitp. Someone the IdP removes keeps their roles
  until then; their sessions end within `KITP_SESSION_ABSOLUTE_DAYS`
  (default 45), and their API tokens keep working until they expire. With
  `OIDC_ROLE_CLAIM=none` (production's choice, 2026-11-05) kitp manages
  roles and none of this applies; leavers are blocked in the IdP and
  revoked in kitp (People → revoke login), which ends their sessions and
  tokens at once.
- **kitp hears of a sign-out at the IdP, not of an admin action there.**
  Front- and back-channel logout end the kitp sessions of an IdP sign-out
  (README, "Sign-out at the IdP"); Entra ID offers front-channel only, and
  only for a browser that signs out there. "Revoke sessions" in Entra ID,
  or a disabled account, tells kitp nothing: a kitp session runs until it
  is idle 7 days (`KITP_SESSION_IDLE_HOURS`) or 45 days old. Revoke the
  login in kitp to end it.
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
  pods running older code don't claim outgoing mail. Not in production:
  one replica, as a StatefulSet that stops the old pod first.
- **A running `kitpd mcp` checks its token only at start.** Revoking or
  expiring the token doesn't stop a process already running (it holds
  database credentials anyway).
- **Left as designed from the final check's "worth a look" list:**
  `user.unlink_person` then a grant to the same person gives the old
  login's private cards to the new one (private cards belong to the
  person); personal views are open to viewers (their own saved views).

- **Two indexes are built at boot without `CONCURRENTLY`:**
  `idx_activity_created_at` and `user_account_parent_user_id`. On a large
  `activity` table, writes to it wait while the first builds (once); in
  production, a moment.

## Deploying `4b143db..`

- **Emails are trusted by default.** An email claim links a first
  sign-in to the account or person an admin set up with it, unless the
  ID token marks it `email_verified: false` (`KITP_OIDC_TRUST_UNVERIFIED_EMAIL`
  unset; `0` restores verified-only, `1` trusts every claim). Entra ID
  sends no verification claim, so under the old verified-only default
  those people got a second account: production has two such pairs (an
  account an admin set up, never signed in, and the login its person
  made). The new default doesn't merge them; give the signed-in login the
  set-up account's roles and remove the set-up one.
- **Email addresses** (docs/EMAIL_ADDRESSES.md): migration 0041 puts each
  signed-in login's email on its person's list. People can add their own
  only after an admin picks the mail account that sends codes (People →
  "Account emails from"). A user's `email` is no longer editable by
  others; it is the primary they choose.
- **Roles: set `OIDC_ROLE_CLAIM=none`** to have kitp manage them. The
  first boot with it makes the 19 grants earlier Entra ID sign-ins brought
  kitp's (logged), so nobody loses access; the 3 role mappings are then
  ignored. That is one way: switching back to a claim later leaves those
  grants kitp's, never reconciled with the IdP again, until an admin
  removes them. Entra app-role assignment still decides who may sign in if the
  enterprise app has "Assignment required" on.
- **Sign-out at Entra ID ends kitp sessions** once the app registration's
  Front-channel logout URL is
  `https://task.dev.kashilab.com/api/v1/auth/oidc/frontchannel-logout`
  (Authentication), and only if Entra ID sends `sid`, both in the ID token
  and in the logout request: kitp matches sessions on it alone. After the
  deploy, check that new sessions get `session.oidc_sid` (if not, add the
  `sid` optional claim under Token configuration; kitp logs "the ID token
  has no sid" at each such sign-in) and that a sign-out at Entra ID logs
  `oidc: front-channel logout` with `sessions_ended` above 0. Sessions
  started before the deploy carry no IdP `sid` and aren't reached.
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
- **A message that keeps failing to file** waits in the inbox and is
  logged once (`file_retry`). After a day of failing while fresh mail down
  the same filing path (reply, new task, new thread) files, and a last try
  that fails too, it goes to the set-aside folder (`file_error`). A poll
  in which nothing filed backs the account off but never faults it, so
  when all of an account's mail fails, the Comm log (`file_retry`, the
  `poll` row's failed count) and the kitpd log are where it shows.
- **Outgoing mail threads** (In-Reply-To / References) from the first
  message after the deploy; a recipient the server refuses is left off
  while the rest get the message, and the thread shows the message as
  "sent, but refused for …" (`reply_refused`).
