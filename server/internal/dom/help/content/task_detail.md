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
| **Approvals**      | Who has been asked to approve which status change, and every vote. See [Approvals](#approvals) below. |
| **Links**          | Code changes, issues, or any URL tied to this task. Each shows its source (e.g. a Gerrit CL), its state (open / reviewed / approved / merged / abandoned) and when it last changed. **+ Add link** pastes a URL; a code forge adds and updates its own links automatically. Linking a URL that's already here updates it instead of adding a duplicate. |
| **Comms**          | Comm threads tied to this card. Each message shows who it's from and when (local date + time). Each thread carries its `#thread_id` chip. Use **+ Start comm** to spawn a new thread. |
| **Add comment**    | The composer at the top of the comments section. Mod+Enter posts. |
| **Comments**       | Inline markdown bodies, newest-first, each stamped with its local date + time. Pencil on your own comment opens the inline editor; edits write an audit row to the activity log. |
| **Activity**       | The full audit stream — one line per event, including `commented` and `edited a comment` rows that point at `c<id>`. |
| **Right rail**     | Per-attribute side panel (status, assignee, milestone, tags, originator, due date, …). Click any row to open its picker. |

## Editing your own comments

The pencil only appears on comments you authored. Saving an edit writes one `comment_edit` activity row that points at `c<id>` so the audit trail stays intact — the original posting + every later edit are both visible in the Activity stream.

## Approvals

An approval is a record of sign-off on a status change — it never blocks or moves the task. A vote belongs to the change itself (an **edge**: the task moving from one specific status to another, such as *Approve: Review → Done*), and a request asks named people to vote on one.

- **+ Ask for approval** picks the status change, the people to ask (anyone on the project with a login) and an optional note. Asking, changing who's asked and removing a request are all recorded.
- **Approve / Reject** records your vote on a status change — whether you were asked or not. **Add a reason** first to attach one; it also shows in the comments, where you can edit its wording. Voting again replaces your earlier vote (reject now, approve later); both stay in the history. **Vote…** votes on a change nobody asked about.
- An agent can vote too (through MCP); it's shown with its owner, e.g. *claude (for Dana)*, but never answers a request for a person.
- When the task reaches the status a request is about, the request is **settled**: it leaves the list badges and the Inbox's *Waiting on you*, and stays here marked *Reached*. Coming back to the same change later starts a new round of votes. A vote given before the task moved somewhere else is shown crossed out.

Task rows (Inbox, Grid, Kanban) carry a small badge — ✓ 2/2, … 1/2, ✕ — for their open requests.

## Links from a code forge

A forge integration (see `integrations/gerrit` for Gerrit) links a change to every task its description mentions — for Gerrit, a `task #123` (or `kitp #123`, `Task: 123`) mention in the commit message — and keeps the link's state current as the change is reviewed, approved, merged, or abandoned. Agents can do the same through the `link.set` tool; it is idempotent, so re-sending a link only updates it.

## Navigation lists

When you arrive here by clicking a row in Inbox / Grid / Kanban / Project, that source list seeds the prev/next buttons. When you cold-load `/task/123`, the nav controls hide cleanly — there's no list to step through.

## Originator vs Assignee

- **Originator** — who reported / created the work. Can be any person, including contacts (email correspondents who reported the issue).
- **Assignee** — who is currently doing the work. Must be a member (assignable person); contacts are filtered out of this dropdown.

## Move / delete

The kebab menu in the header exposes **Move to project…** (re-classify status / milestone / component / tags in the destination) and **Delete forever…** (type-to-confirm purge — irreversible).
