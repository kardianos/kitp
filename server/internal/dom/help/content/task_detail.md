# Task detail

Everything about one task lives here: title, description, attributes, transitions, comments, comms, related tasks, attachments, and the per-card activity log.

## Layout

The page is split into a main column and a right-hand attribute rail.

| Area               | What it owns                                                       |
| ------------------ | ------------------------------------------------------------------ |
| **Header**         | Title editor (pencil), the `#id`, the **Transition bar**, kebab menu (Move, Purge, …). |
| **Description**    | Markdown body. Pencil button or `e d` opens the editor; Mod+Enter saves, Esc cancels. |
| **Related tasks**  | Parent / child pickers. `e p` sets parent; `e s` opens a sub-task quick entry; `e a` adds an existing card as a child. |
| **Attachments**    | Drop or pick files; CAS-uploaded out-of-batch then linked. |
| **Comms**          | Read-only list of comm threads tied to this card. Each carries its `m<id>` and `#thread_id` chips. Use **+ Start comm** to spawn a new thread. |
| **Comments**       | Inline markdown bodies, newest-first. Each carries its `c<id>`. Pencil on your own comment opens the inline editor; edits write an audit row to the activity log. |
| **Add comment**    | The composer below the comments list. Mod+Enter posts. |
| **Activity**       | The full audit stream — one line per event, including `commented` and `edited a comment` rows that point at `c<id>`. |
| **Right rail**     | Per-attribute side panel (status, assignee, milestone, tags, originator, due date, …). Click any row to open its picker. |

## Keyboard

| Chord    | Action                                              |
| -------- | --------------------------------------------------- |
| `e t`    | Edit title                                          |
| `e d`    | Edit description                                    |
| `e c`    | Focus a comment to edit                             |
| `e p`    | Set parent                                          |
| `e s`    | New sub-task                                        |
| `e a`    | Add existing card as child                          |
| `t`      | Toggle tag picker                                   |
| `c`      | Fire the first transition in the "close" bucket    |
| `j` / `]`| Next task in the navigation list                    |
| `k` / `[`| Previous task in the navigation list                |
| `Esc` / `q` | Back to the previous screen (preserving filters) |

## Editing your own comments

The pencil only appears on comments you authored. Saving an edit writes one `comment_edit` activity row that points at `c<id>` so the audit trail stays intact — the original posting + every later edit are both visible in the Activity stream.

## Navigation lists

When you arrive here by clicking a row in Inbox / Grid / Kanban / Project, that source list seeds the prev/next buttons (and `j`/`k`). When you cold-load `/task/123`, the nav controls hide cleanly — there's no list to step through.

## Originator vs Assignee

- **Originator** — who reported / created the work. Can be any person, including contacts (email correspondents who reported the issue).
- **Assignee** — who is currently doing the work. Must be a member (assignable person); contacts are filtered out of this dropdown.

## Move / delete

The kebab menu in the header exposes **Move to project…** (re-classify status / milestone / component / tags in the destination) and **Delete forever…** (type-to-confirm purge — irreversible).
