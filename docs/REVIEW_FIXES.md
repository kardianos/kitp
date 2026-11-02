# Review fixes — 2026-11-02

The fix list for the review of branch `bundles-portals` (at 347131a) and
the rest of the project. IDs are the review's: **A** = the branch,
**B** = the rest of the project. Each item is checked before it is fixed
(the reviewer marked some *suspected*), gets a test that fails first where
it can, and is ticked when its area is committed. Worked through by area,
in this order.

Legend: `[ ]` open · `[x]` fixed · `[~]` checked, not a bug / no change (with why).

## 1. Roles and authorization

- [x] **B1** (critical) An agent's parent can grant the agent any role at any scope; visibility and grant loading use the agent's own rows, not the intersection with the parent. → user_role.set: the parent must hold that role at that scope, never admin; visibility, card_visible_to, loadActorGrants and user_select's admin check use the intersection.
- [x] **B3** The role gate ignores scope: a project-scoped admin passes `AllowedRoles: admin` handlers with no global Authz (person.create / grant_account / merge, user.list_with_roles / unlink_person / set_display_name, …). → admin-only handlers need a global admin.
- [x] **A10** Same gap for portal.set / rebuild / root_pages and theme.* (covered by the B3 fix; check each).
- [x] **B15c** user_select_batch.sql:52 checks admin from raw user_role rows.
- [x] **B6** task.move / card.move never authorize the destination project.
- [x] **B7** project.stamp: GlobalScope, workers allowed, no check the source is a template or visible.
- [x] **A11** bundle.apply open to workers (bypasses admin-only switch-on); no guard against template / bundle-source targets.
- [x] **B16** flow.list returns every project's title to anyone signed in.

Done (area 1): an agent **sees** what its owner sees (`user_role_visible`) and **acts** only with granted roles its owner also holds (`user_role_effective`); user_role.set refuses the rest whoever grants. The role gate takes a workspace admin for admin-only handlers with no project to check. Every admin check is `auth.IsGlobalAdmin` / `user_is_global_admin`. Moves check the destination's grant, visibility and area (A16 too). project.stamp copies only a visible template. bundle.apply is admin-only (templates still allowed: that's how an admin extends one) and never targets a bundle source. flow.list is filtered by visibility.

## 2. Bundles

- [x] **A1** Bundle SQL finds its source project by title (LIMIT 1, no bundle_key / deleted_at): a user project with that title gets the source's rows, or boot fails.
- [x] **A2** bundle_key (and is_template on sources) writable by workers; boot purges whatever carries the key, failing boot or hard-deleting a subtree. → server-owned; sources tracked by id; a failed purge doesn't stop boot.
- [x] **A21** Re-applying a bundle restores flow steps the project deleted.
- [~] Admin Projects screen lists bundle source projects (docs say hidden). — the web lists already exclude them (templates query filters bundle_key; the project picker excludes templates); source projects are now read-only server-side (A2).

Done (area 2): bundle SQL lookups match the source on bundle_key, skip deleted cards and take the newest; bundle_key is refused by attribute.update / card.insert and migration 0019 strips it from non-sources; the dispatcher refuses writes into a source project; boot purges only the recorded source, inside a savepoint, and keeps the old source (logging) if a rebuild fails. A re-apply copies only flow steps that touch a status it added.

## 3. Conversations and mail

- [x] **A3** Mail in areas that are off: task-mode intake with Tasks off creates hidden tasks; findCommByThreadID matches across projects and into hidden threads; SMTP loadPending sends queued replies on hidden threads (and quotes hidden history).
- [x] **A5** SplitQuoted is quadratic (Go and web): linear pass + input cap.
- [x] **A12** Thread page loads every comm card in the install to show one.
- [x] **A13** A thread's comments vanish from the UI after it is attached to a task.
- [x] **A15** comm.attach: area_off branch unreachable; no row locks (concurrent attaches); detach doesn't check the old task's grant.
- [x] **A23** Make a task: two requests (a failed attach leaves an empty task); offered when Tasks is unused.
- [x] **A24** Positional `$N` in new/modified imap.go queries; stale comments in recipients.go:68, comm_ack.go:10.
- [x] **A27** RFC 2047 sender names not decoded in quotes.

Done (area 3): a task-mode account's new mail becomes a thread on its own while Tasks is off; a reply's thread id matches only a visible thread in the account's own project, else it's new mail there; the SMTP sender holds replies on threads in an area that is off. SplitQuoted is linear (Go and web) with a 512 KB cap. card.select_with_attributes takes `ids`, and the detail loads its one card (pages still load their siblings). activity.select's `with_thread_comments` puts a task's thread comments (and their edits) on the task, labelled "on thread …". comm.attach checks the area before visibility, locks the thread and its tasks, needs the task grant to leave a task, and makes a task itself (`new_task_title`, one transaction); the TASK section shows only while Tasks is on. imap.go uses named parameters throughout; subjects and sender names are decoded (any charset x/text knows).

## 4. Areas

- [ ] **A8** Approvals off neither hides nor blocks approvals (handlers gate on the task type; list / summary / state / waiting_on / activity unfiltered).
- [ ] **A9** reply_body cards have no parent, so card_in_off_area never hides a hidden thread's messages.
- [ ] **A14** card_in_off_area's fast path is install-wide: one off row makes every read pay a second walk.
- [x] **A16** checkArea checks only the source: moving a card into an off area succeeds.
- [ ] **A22** Switching Sites writes no activity row.
- [ ] **A26** Pages deeper than 15 never reach the project in the depth-16 walk (escape Content-off).

## 5. Portals and sites

- [ ] **A4** Public listener: CAS GetAll streams with rows open on the shared pool; no Write/Idle timeouts → slow readers exhaust the pool.
- [ ] **A6** Any worker can point a status's publishes_to at any portal; other projects' attachments reach Site.Files.
- [ ] **A7** Withdrawn / hidden content stays public while builds fail; builds retry every 5 s without backoff, holding every attachment in memory.
- [ ] **A17** Raw error text on the wire (portal last_error, theme handler messages).
- [ ] **A18** `_files/` on signed-in preview / site routes sent `Cache-Control: public`.
- [ ] **A19** Published attachments keep the uploader's MIME type (HTML on the docs domain); no CSP sandbox.
- [ ] **A20** Theme templates: `<script>` allowed (CSP-only), and `{{range 1000000000}}` passes the sample render.
- [ ] **A25** CAS Put doesn't refresh created_at for an existing blob (reaper race).
- [ ] **A28** Two replicas can build the same portal at once.

## 6. Attachments and files

- [ ] **B2** Stored XSS via attachment `/view` (client-chosen MIME inline, no nosniff).
- [ ] **B4** attachment.list has no visibility check; attachment.create accepts any file_id (take another project's file).
- [ ] **B5** file.create: no total-size cap, a chunk repeatable; thumbnails decode without DecodeConfig → OOM.
- [ ] **B12** Batch / authed bodies read without a size cap; /api/v1/cas/chunk needs only a session.
- [ ] **B13** Reaper dropBytes outside the row's transaction.
- [ ] **B14** requireAttachmentAccess assumes the parent is the project (403 for nested pages, comms).

## 7. Platform

- [ ] **B8** OIDC login CSRF: state not bound to the browser; no nonce.
- [ ] **B9** No recover() in the server, jobs or worker pools.
- [ ] **B10** Session and token ids stored as the raw secrets.
- [ ] **B11** Idempotency: check-then-store lets concurrent retries both run.
- [ ] **B15a** attribute/scope.go:209 recursive CTE without `depth < 16`; the lint doesn't scan Go.
- [ ] **B15b** cas/chunk_http.go:67 compares err.Error() text.

## 8. Tests

- [ ] auth_audit: mount the portal routes (preview / site) so they're in auth_audit.csv.
- [~] Migration 0018 has a forward-migration test — it does (TestForwardMigration0018CommChannelModes); the review missed it.
- [ ] The per-area gaps the review lists are covered by the tests added above.

## 9. Docs

- [ ] README: "no mail fetched or sent" (A3); "only admins switch on" (A11).
- [ ] AREAS.md: starting point names; agents / emails / gated-write claims (A8, A9, A3); "Hidden item" label; "next build" (A7); "every switch writes an activity row" (A22); "re-apply is safe" (A21); admin-only switch-on (A11).
- [ ] admin_areas.md: same claims.
- [ ] BUNDLES_AND_PORTALS.md: sources hidden (Projects screen); preview origin; another project's file (A6); Areas listed as Deferred; re-apply; target=_blank for autolinks.
- [ ] serve.go comment and admin_themes.md: "themes can't hold scripts".
- [ ] admin_portals.md: which attachments are published.
- [ ] CONVERSATIONS.md / conversations.hcsv: "Admin → Comm Channels"; area_off promise; "history intact" (A13).
- [x] admin_agents.md / admin_users.md: agent role rule (B1).
- [ ] CLAUDE.md: the fourth (bundle) tier of ApplySchema.
