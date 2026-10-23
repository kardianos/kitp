# Task detail

Everything about one task lives here: title, description, attributes, transitions, approvals, links, comments, comms, related tasks, attachments, and the per-card activity log.

## Layout

The page is split into a main column and a right-hand attribute rail.

| Area               | What it owns                                                       |
| ------------------ | ------------------------------------------------------------------ |
| **Header**         | Title editor (pencil), the `#id`, the **Transition bar**, kebab menu (Move, Purge, …). |
| **Description**    | Markdown body. The pencil button opens the editor; Mod+Enter saves, Esc cancels. |
| **Related tasks**  | Parent / child pickers — set a parent, open a sub-task quick entry, or add an existing card as a child. |
| **Attachments**    | Drop or pick files; CAS-uploaded out-of-batch then linked. |
| **Approval votes** | Who has been asked to vote on which status step, and every vote. See [Approval votes](#approval-votes) below. |
| **Links**          | Code changes, issues, or any URL tied to this task. Each shows its source (e.g. a Gerrit CL), its state (open / reviewed / approved / merged / abandoned) and when it last changed. **+ Add link** pastes a URL; a code forge adds and updates its own links automatically. Linking a URL that's already here updates it instead of adding a duplicate. |
| **Comms**          | Comm threads tied to this card. Each message shows who it's from and when (local date + time). Each thread carries its `#thread_id` chip. Use **+ Start comm** to spawn a new thread. A thread started by asking for a vote by email names the vote (**Vote request: …**). |
| **Add comment**    | The composer at the top of the comments section. Mod+Enter posts. |
| **Comments**       | Inline markdown bodies, newest-first, each stamped with its local date + time. Pencil on your own comment opens the inline editor; edits write an audit row to the activity log. |
| **Activity**       | The full audit stream — one line per event, including `commented` and `edited a comment` rows that point at `c<id>`. |
| **Right rail**     | Per-attribute side panel (status, assignee, milestone, tags, originator, due date, …). Click any row to open its picker. |

## Editing your own comments

The pencil only appears on comments you authored. Saving an edit writes one `comment_edit` activity row that points at `c<id>` so the audit trail stays intact — the original posting + every later edit are both visible in the Activity stream.

## Approval votes

An approval vote is a record of sign-off on a status step — it never blocks or moves the task, and a **Vote approve** is not the workflow's own *Approve*: only the status bar changes the status. A vote belongs to the step itself (an **edge**: the task moving from one specific status to another, such as *Review → Done (Approve)*), and a request asks named people to vote on one.

- **+ Ask for a vote** picks the status step, the people to ask (**+ person**: anyone on the project with a login, the same picker as a comm's recipients) and an optional note. Asking, changing who's asked and removing a request are all recorded.
- **Email** (on the ask form) also emails the people asked through one of the project's channels. The note becomes the email's message, so it's required, and the form names anyone without an email address, who won't get the email. The email starts an ordinary thread under **Comms**, linked both ways: the request shows **Emailed: …** and the thread shows **Vote request: …**. From then on the two are separate: replies land in the thread, removing the request leaves the thread, and voting still happens only here, never by replying.
- **Vote approve / Vote reject** records your vote on a step — whether you were asked or not. **Add a reason** first to attach one; it also shows in the comments, where you can edit its wording. Voting again replaces your earlier vote (reject now, approve later); both stay in the history. **Vote…** votes on a step nobody asked about.
- An agent can vote too (through MCP); it's shown with its owner, e.g. *claude (for Dana)*, but never answers a request for a person.
- When the task reaches the status a request is about, the request is **settled**: it drops out of the task's Approvals column and the *Waiting on my vote* view, and stays here marked *Reached*. A closed (done or cancelled) task has no open requests either. Coming back to the same step later starts a new round of votes. A vote given before the task moved somewhere else is shown crossed out.

This is the only place to vote. Elsewhere a screen can show a task's **Approvals** column — ✓ 2/2, … 1/2, ✕, plus *your vote* when one waits on you — and filter or sort by its approvals (*Vote needed from*, *Approval votes*, *Approval asked*); see the Screens admin help.

## Links from a code forge

A forge integration (see `integrations/gerrit` for Gerrit) links a change to every task its description mentions — for Gerrit, a `task #123` (or `kitp #123`, `Task: 123`) mention in the commit message — and keeps the link's state current as the change is reviewed, approved, merged, or abandoned. Agents can do the same through the `link.set` tool; it is idempotent, so re-sending a link only updates it.

## Navigation lists

When you arrive here by clicking a row in Inbox / Grid / Kanban / Project, that source list seeds the prev/next buttons. When you cold-load `/task/123`, the nav controls hide cleanly — there's no list to step through.

## Originator vs Assignee

- **Originator** — who reported / created the work. Can be any person, including contacts (email correspondents who reported the issue).
- **Assignee** — who is currently doing the work. Must be a member (assignable person); contacts are filtered out of this dropdown.

## Move / delete

The kebab menu in the header exposes **Move to project…** (re-classify status / milestone / component / tags in the destination) and **Delete forever…** (type-to-confirm purge — irreversible).
