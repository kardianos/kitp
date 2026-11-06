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
- **Sign-in starts are limited:** 20 a minute per address (bursts of 40);
  past that, 429. There is no overall limit: a start writes nothing to the
  database (its state is sealed in a cookie), and the overall budget let
  anyone stop every new sign-in (review 2026-11-06 #3). A sign-in started
  before a restart of a kitpd without `KITP_LINK_SECRET` starts again;
  with two or more kitpd without it, a callback that reaches another one
  than the start fails (about half of them with two). A deep link that
  would make the state cookie larger than 3,800 bytes signs in to "/".
- **`activity.select` with neither a card nor a project** covers the last
  30 days by default and at most 92.
- **Unfileable mail goes to the IMAP folder `kitp-set-aside`.** Name
  another with `KITP_COMM_IMAP_SET_ASIDE_FOLDER`, or set it empty to leave
  such mail in the inbox.
- **A passing send failure is retried** 6 times over about 4 h 20 min
  (Comm log `send_retry`) before the message is failed; each send has 75
  seconds, and its result is recorded however long it took. Every try
  carries the same Message-ID, so a retry after a lost answer can be
  dropped as a copy. A webhook's 401, 403 and 404 are retried; only its
  400 and 422 bounce.
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

## Security review 2026-11-06

A dedicated security review (outsiders and signed-in users going beyond
their rights) covered d33a010, 5e9ad58, 823f78e and the whole
application. Its 23 findings are fixed in the commits after `823f78e`,
except as noted below.

### Left open

- **Default proxy trust (L8).** With `KITP_TRUSTED_PROXIES` unset, any
  private or loopback peer is believed in `X-Forwarded-For` and PROXY
  headers, so a client on the same private network (a pod, the VPN, the
  LAN) can choose the address its sign-in and logout limits count. kitp
  keeps the default because production relies on it (Traefik's pod
  address). **Set `KITP_TRUSTED_PROXIES` to the proxy's own range** — the
  Traefik pods' CIDR — and the rest of the private network stops being
  believed.
- **Outgoing-server error text.** A failed SMTP or IMAP connection's error,
  the server's first line included, is stored in the Comm log. Only
  workspace admins see it, and only they set the servers now.
- **Not fixed, worth knowing:**
  - `KITP_INIT_ADMIN_EMAIL` stays set in production. At a boot with no
    live workspace admin, recovery makes a login for that email that the
    IdP's holder of the address can attach to. Unset it once an admin
    exists.
  - Traefik runs `--api.insecure=true` on `NODE_IP:9000`: an
    unauthenticated dashboard where it can be reached (outside kitp).
  - The owner / agent upload hand-over is 7 days (823f78e; it was 1): an
    agent reads files its owner uploaded and never attached for that long.
  - PDFs are shown inline on the app origin without a sandbox (exposure to
    PDF-viewer bugs); `_files` responses carry two `sandbox` directives.
  - Portal builds hold every rendered page in memory (a few thousand
    pages is a lot), bounded by 128 MB of page text over the site;
    `POST /api/v1/cas/chunk` has no per-account quota before the reaper's
    grace runs out.
  - The MS Graph token cache is keyed by tenant and client, not the
    secret; the ZIP export names every actor's login email; a batch has
    no cap on sub-requests (which is also what let a caller stretch round
    8's #1 and #4 windows to the handler timeout; both are closed).
  - Front-channel logout's `sid` is the same for every app in the
    browser's Entra session: another app's operator holding the user's ID
    token can sign them out of kitp (how the spec works).

### Deploying the fixes

- **Sign-in state is a sealed cookie** (AES-GCM; key from
  `KITP_LINK_SECRET`, else per process). A sign-in in flight across the
  deploy starts again. `oidc_state` gets no new rows; the reaper empties
  it.
- **A write aimed at a card that didn't exist when it was checked** fails
  its batch if the card exists by the time its handler runs, or right
  after the handler's statement, before any PostRun (`card_not_found`,
  "send it again"): made in between by someone else, or by an earlier
  sub-request of the same batch or group (round 8 #1: the first fix
  looked only before the statement). One still missing gets the handler's
  own answer (`task_not_found` for the forge link hook, as before).
  `attachment.delete` and `attachment.download_url` find their card
  through the attachment, so they ask the grant in SQL as well (round 8
  #4).
- **Mail accounts and activity sinks are workspace-admin only** through
  every generic write (`attribute.update`, `card.insert` / `delete` /
  `undelete` / `merge` / `move`), as their own screens already were.
- **Naming a person** on a task (originator, assignee) or a thread
  (recipients) needs them to be someone you can see, a member of the
  project, or already named in it. Workspace-wide roles see everyone, so
  nothing changes for them. approval.set's refusal names only such people
  (anyone else is "person N"), and an import matches assignee emails only
  against them — another person's address reads as unknown (with
  `auto_create`, the import makes a new contact). Filed mail matches a
  person's verified second addresses only for its sender: a Cc of one is
  a contact, not the user.
- **A page is capped by what it renders to:** a table of more than 64
  columns, or past 50,000 cells on the page, shows as its text; a page
  past 1 MB of text (2 MB with its placeholders), 4 MB as HTML (its
  `{{< toc >}}`s included), or past the site's 128 MB is published without
  its text; one over 8 MB with its theme goes out without its text, and
  the build fails only if it is too large even then (the theme's fault).
  Writes refuse a page text over 512 KB, and a title over 500 characters
  on any card (an import reports one as a row error; filing cuts a long
  subject). Each cap leaves a build warning. A portal build counts as
  failed until it finishes (so a build that dies backs off), has 2
  minutes, and stops between pages when they run out.
- **Email addresses:** codes are HMAC'd (pending codes from before the
  deploy stop working; send a new one), counted per send, and sent only
  while the account-emails mailbox is enabled. A send is counted on its
  own connection before the mail goes out, and requests for one person or
  one address are taken one at a time, so a batch that fails after
  sending, or batches sent at once, don't get past the limits (round 8
  #5). Migration `0043_person_email_orphans` removes the addresses of
  deleted people and of people with no live login.
- **Mail from a kitp user's address is never sent on** (`relay_skipped`
  `sender_is_user`); staff write in kitp. A copy names its sender as kitp
  knows them (their contact's name, or their address), never as the
  received From's display name says (round 8 #6).
- **`dev-login`** (`AUTH_MODE=off` only) answers on localhost, loopback
  and the hosts of `KITP_PUBLIC_URL` / `KITP_TRUSTED_ORIGINS`.

## Review round 8 (2026-11-06)

A fresh review of the commits after `823f78e` and the mail-account send
methods, plus a race sweep (30 findings: 3 high, 8 medium, 19 low). All
are fixed in the commits after `50c12e9`, except as noted.

### Left open

- `activity.poll` and `comm.unseen_count` keep their id cursors: a row
  whose transaction commits after a later one's shows a refresh late
  (UI only). The activity-sink pump reads in transaction order (below).
- An Idempotency-Key answer is kept when the client hangs up after the
  commit, but not when `Commit` itself reports an error after the server
  committed: that needs the answer stored in the request transaction.
- A moved task's approvals still name the source project's statuses
  (`approval_from` / `approval_to`); its threads take the destination's
  comm state of the same phase.
- `card.insert` of a screen doesn't check its slug or hotkey;
  `attribute.update` does, under an advisory lock.
- Postmark's 406 (an inactive recipient) bounces a whole multi-recipient
  message.
- `person_email.add` for an address verified on someone else sends
  nothing, so it can't fail to send and answers a little sooner than a
  free address does. The per-address limit (5 a day) is shared by everyone
  who asks, so anyone can use it up and keep the owner from verifying that
  address for a day.
- Two concurrent `person_email.add` of one person, or a write that waits
  behind a `task.move` past `lock_timeout` (5 s), now fail with an error
  where they used to pass the limits or corrupt data. Rarely, batches that
  update and move the same cards in opposite orders get Postgres's
  "deadlock; retry".
- A worker's template stamp still makes copies of a template's mail
  accounts, sinks and subscriptions (without their secrets).
- `send_url` and `send_domain` are readable by every project member through
  `card.select_with_attributes`, like `smtp_host`; the webhook's secret
  still guards the endpoint.

### Deploying the fixes

- **Migrations** `0045_cross_project_parent_task` drops stored
  cross-project `parent_task` / `parent_relationship` links (no history
  rows). The boot adds `activity.txid` (existing rows stay NULL, read as
  0) and `activity_sink_state.last_txid`, and builds `idx_activity_txid_id`
  (not CONCURRENTLY: writes to `activity` wait for it briefly).
- **Activity sinks read the stream in transaction order:** a digest waits
  for transactions still open in kitp's database, so a long import holds
  digests back until it ends, but nothing is skipped. This reads
  `pg_stat_activity.backend_xid`, which kitp's sessions see because they
  share its role.
- **A held IdP signing key stays valid for up to 24 h while the keys
  endpoint can't be reached;** a refetch that drops it ends it at once.
- **Threads' lists take a lock** (`card_list_lock`): mail filed while
  staff reply, two replies at once, or a recipient change during filing
  wait for one another instead of losing a message.
- **task.move carries only subtasks of the task's own project;** a
  subtask elsewhere keeps its link and stays. `card.undelete` drops a
  `parent_task` now in another project and refuses a card whose other
  values moved away (`cross_project_ref`). Writes that name a card hold it
  FOR SHARE, and moves lock what they move.
- **Mail accounts:** one with no IMAP host isn't polled (it was faulted
  within the hour). A receive-only one takes no first message
  (`comm.create`: `cannot_send`) and sends nothing on. `send_secret: ""`
  clears the secret; an unknown `send_method` reads as none. Test sends
  share 40 seconds.
- **Card lists and search** check for a deleted ancestor on the
  visibility walk they already make (they had doubled in cost).

