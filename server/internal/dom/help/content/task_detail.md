# Task detail

Everything about one task lives here: title, description, attributes, transitions, links, comments, comms, related tasks, attachments, and the per-card activity log.

## Layout

The page is split into a main column and a right-hand attribute rail.

| Area               | What it owns                                                       |
| ------------------ | ------------------------------------------------------------------ |
| **Header**         | Title editor (pencil), the `#id`, the **Transition bar**, kebab menu (Move, Purge, …). |
| **Description**    | Markdown body. The pencil button opens the editor; Mod+Enter saves, Esc cancels. |
| **Related tasks**  | Parent / child pickers — set a parent, open a sub-task quick entry, or add an existing card as a child. |
| **Attachments**    | Drop or pick files; CAS-uploaded out-of-batch then linked. |
| **Links**          | Code changes, issues, or any URL tied to this task. Each shows its source (e.g. a Gerrit CL), its state (open / reviewed / approved / merged / abandoned) and when it last changed. **+ Add link** pastes a URL; a code forge adds and updates its own links automatically. Linking a URL that's already here updates it instead of adding a duplicate. |
| **Comms**          | Comm threads tied to this card. Each message shows who it's from and when (local date + time). Each thread carries its `#thread_id` chip. Use **+ Start comm** to spawn a new thread. |
| **Add comment**    | The composer at the top of the comments section. Mod+Enter posts. |
| **Comments**       | Inline markdown bodies, newest-first, each stamped with its local date + time. Pencil on your own comment opens the inline editor; edits write an audit row to the activity log. |
| **Activity**       | The full audit stream — one line per event, including `commented` and `edited a comment` rows that point at `c<id>`. |
| **Right rail**     | Per-attribute side panel (status, assignee, milestone, tags, originator, due date, …). Click any row to open its picker. |

## Editing your own comments

The pencil only appears on comments you authored. Saving an edit writes one `comment_edit` activity row that points at `c<id>` so the audit trail stays intact — the original posting + every later edit are both visible in the Activity stream.

## Links from a code forge

A forge integration (see `integrations/gerrit` for Gerrit) links a change to every task its description mentions — for Gerrit, a `task #123` (or `kitp #123`, `Task: 123`) mention in the commit message — and keeps the link's state current as the change is reviewed, approved, merged, or abandoned. Agents can do the same through the `link.set` tool; it is idempotent, so re-sending a link only updates it.

## Navigation lists

When you arrive here by clicking a row in Inbox / Grid / Kanban / Project, that source list seeds the prev/next buttons. When you cold-load `/task/123`, the nav controls hide cleanly — there's no list to step through.

## Originator vs Assignee

- **Originator** — who reported / created the work. Can be any person, including contacts (email correspondents who reported the issue).
- **Assignee** — who is currently doing the work. Must be a member (assignable person); contacts are filtered out of this dropdown.

## Move / delete

The kebab menu in the header exposes **Move to project…** (re-classify status / milestone / component / tags in the destination) and **Delete forever…** (type-to-confirm purge — irreversible).
