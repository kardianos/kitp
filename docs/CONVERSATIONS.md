# Conversations, threads on their own, and the help desk

Status: built. Follows [AREAS.md](AREAS.md).

A help desk isn't a separate area or item type. It is Tasks and
Conversations with a few choices made: what new mail does, whether
replies quote the conversation, and a ticket-shaped starting point for
Tasks. A shared inbox is Conversations on its own.

## Mail account settings

Two settings on each mail account (PROJECT → Comm Channels), so one
project can have `support@` filing tickets and `billing@` collecting
threads:

| Setting | Values | Default |
| ------- | ------ | ------- |
| **New mail** (`intake_mode`) | *creates a task and a thread* (`task`), *creates a thread only* (`thread`), *is ignored* (`ignore`: only replies to existing threads come in) | `task` when the account has an intake status, else `ignore` — what accounts did before the setting |
| **Quoting in replies** (`reply_quote`) | *off*, *last message* (`last`), *whole conversation* (`all`) | `last` |

A thread is always matched first (the `X-Kitp-Thread-Id` header, the
`[#id]` subject suffix, the `Ref:` line); the New mail setting only
decides what an unmatched message becomes. *Creates a task and a thread*
uses the account's intake status, or the project's task flow default
when there is none.

### Quoting

kitp sends plain text. With quoting on, a reply carries the earlier
messages below the signature, each as

```
On 2026-11-02 Mon, Ada Lovelace <ada@example.com> wrote:
> the earlier message,
> line by line
```

— *last message* quotes the one before; *whole conversation* quotes
every earlier message, newest first. Dates are `YYYY-MM-DD DoW` in UTC.
The thread's `Task:` / `Ref:` lines stay last, where the inbound parser
looks for them. What kitp stores and shows is the reply alone; the quote
is added when the mail is sent.

### Trimming received replies

A customer's mail program quotes the earlier messages too, so a stored
reply repeats the thread above it. kitp keeps the original as received
and **shows** it trimmed: the quoted tail — `>` lines, an "On … wrote:"
header, a "-----Original Message-----" or Outlook "From: … Sent: …"
block, kitp's own `Ref:` trailer — folds behind **Show quoted text**.
Trimming guesses where the history starts, so it is display only.

## Threads on their own

A thread (a `comm` card) can sit directly in its project instead of under
a task:

- *creates a thread only* files new mail that way;
- **Attach to task…** moves a thread under a task, history intact: its
  messages and attachments go with it, and its comments show on the
  task's page, labelled "on thread …" (`comm.attach {comm_id, task_id}`;
  `activity.select` `with_thread_comments`); **Detach** moves it back to
  the project (`task_id` 0); **Make a task** creates a task from the
  thread (its subject as the title) and attaches it, in one request
  (`comm.attach {comm_id, new_task_title}`). With Tasks switched off these
  answer `area_off`, and the TASK section shows only while Tasks is on;
- a thread has its own page, `/thread/:id`: the detail view with a
  `comm` profile — its status flow, the conversation, comments,
  attachments, and Attach / Make a task. A thread under a task opens on
  its task, as before;
- the Comms screen lists threads that aren't on a task first, labelled
  "Not on a task", and opens them on their page.

Code that read "a comm's parent is its task" now asks whether the parent
*is* a task: reply.post (the subject's title, and where a reply's
attachments must live) and the mail sender (the `Task:` line and deep
link), the unread count (which finds the project through
`card_enclosing_project`), the activity feed (a thread on its own groups
under itself), inbound attachments (always stored on the thread; Attach
moves none — **Add to task** moves one file onto the task, see
[MAIL_INTAKE_AND_CALENDARS.md](MAIL_INTAKE_AND_CALENDARS.md), "Second
round"), and the permission checks of reply,
ACK and recipient writes, which check the task grant for a thread on a
task and the comm grant (worker / manager hold `card.update` on comm) for
a thread on its own.

Because threads can stand alone, **Conversations no longer needs Tasks**
(areas.hcsv): on its own it is a shared inbox. Attach and Make a task
are hidden while Tasks is off.

## The help desk

- **Help desk** — a second starting point of the Tasks area
  (`db/schema/bundles/helpdesk.hcsv`), the alternative to Task tracking:
  tickets move New → Open → Waiting on customer → Solved → Closed, with
  screens Unassigned (open tickets nobody has), My tickets, Board (a
  kanban by status) and All tickets.
- Shortcuts in the new-project dialog (presets.hcsv): **Help desk**
  (Tasks from Help desk + Conversations) and **Shared inbox**
  (Conversations only).

A mail account is added after the project exists (it needs credentials);
its New mail setting defaults to *creates a task and a thread* in the
form. For a public knowledge base, add Content and Sites with the Help
center theme.

## Files from email, and replies sent on

A file on incoming mail stays on the thread, under its message; **Add to
task** moves it into the task's Attachments. A mail account can drop such
files instead (**Attachments from email**), and can send an emailed reply
that reached only the account on to the thread's other people (**Emailed
replies**). See [MAIL_INTAKE_AND_CALENDARS.md](MAIL_INTAKE_AND_CALENDARS.md),
"Second round".

## Other ways in, dedupe

Besides IMAP polling, a mail account can take mail POSTed by a provider
(Cloudflare, Mailgun, Postmark, SES via Lambda) or sent to kitp's own SMTP
listener, through secret routes with optional filters; every copy of a
message is filed once per project. See
[MAIL_INTAKE_AND_CALENDARS.md](MAIL_INTAKE_AND_CALENDARS.md).

## As built

| Piece | Where |
| ----- | ----- |
| Settings | `intake_mode`, `reply_quote` on `comm_channel` (seed + migration `0018_comm_channel_modes`); `comm_channel.set` / `.list`; PROJECT → Comm Channels *New mail*, *Quoting in replies* |
| Intake | `imap.go` `processOne` → `createTaskAndComm` / `createComm` by `ResolveIntakeMode` |
| Quoting | `quote.go` (`SplitQuoted`, `formatQuote`), `smtp.go` `loadEarlier` + `buildMIME` |
| Trimming | `web/src/task-detail/comm-quoted.ts` (`splitQuoted`, the same rules), CommThreads *Show quoted text* |
| Attach | `comm.attach {comm_id, task_id \| new_task_title}` (`comm_attach_batch.sql`): same project, Tasks on (`area_off`), task `card.update` (and `card.create` to make one); locks the thread and its tasks; moves no files; `comm.list_for_task {comm_id}` loads one thread |
| Files from email | on the thread; `comm.attachment_to_task` (Add to task) moves one onto the task — MAIL_INTAKE_AND_CALENDARS.md |
| Thread page | `/thread/:id` → TaskDetail with the `comm` profile (detail-profiles.ts); ThreadPlacement (TASK section); Detach in a task's COMMS |
| Comms screen | CardListBody `orphan: {label, route}` (screen-resolve.ts) |
| Help desk | `db/schema/bundles/helpdesk.hcsv`; presets `help_desk`, `shared_inbox` |
