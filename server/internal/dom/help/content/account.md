# Your account

Your profile, your email addresses, the email notifications you subscribe to, and your calendar feeds, on one page. The menu on the left jumps to each section; under it are links (🔗) to your **Watch lists**, **My screens** and **My Agents**, which have pages of their own.

## Notifications

Each subscription picks which events and tasks to include and how often to send a roll-up, through a project's notification mailbox. Replies to a digest are dropped, never filed.

## Calendars

A calendar shows the tasks **you can see** that have a due date in a window around today, as all-day events that link to the task. A task with a start date too spans its days, from the start to the due date; a task with a start date but no due date isn't listed. Make as many as you like — say *My due dates* (assigned to me) and *Releases* (one project).

| Setting | What it does |
| ------- | ------------ |
| **Name** | What calendar apps call it. |
| **Tasks** | *Every task I can see*, *Assigned to me*, *Assigned to me, not done*, or *Custom filter…*, which opens the same filter builder as a screen's **Advanced** panel, starting from the preset you had picked. *Me* is you. Statuses belong to one project, so to span projects use **Status → has phase** (*Triage*, *Active*); **Project** narrows it to some projects. |
| **Days back / Days ahead** | The window: tasks whose days fall between this many days ago and this many days ahead (0–3650; defaults 30 and 365) — a long task running through the window counts. |

Each event's title is `#123 Title` (✓ in front once the task is done); its description names the project and status and links to the task. Events are marked *free*, so tasks don't block your day.

### URLs

A calendar is reached by secret URLs ending in `.ics`. Give each app or device its own (**+ New URL**, with a comment like *iPhone*), so you can revoke one without touching the others. A URL is shown **once**: kitp keeps only a fingerprint. Lost it? Make a new one and revoke the old.

Under each URL: when it was last fetched, by which app (its User-Agent), and the last error — a filter that no longer works, for instance; the app then keeps its last copy.

### Adding it to an app

| App | How |
| --- | --- |
| Google Calendar | Other calendars → **+** → **From URL** → paste. Google refreshes it every few hours, sometimes a day. |
| Outlook | **Add calendar** → **Subscribe from web** → paste. |
| Apple Calendar | **File → New Calendar Subscription** → paste, or open the *webcal://* link on an iPhone or Mac. |

### Privacy

Calendar services fetch the feed from their own servers, so task titles, project names and statuses are sent to them, and anyone holding a URL can read the feed. Revoke URLs you no longer use. Leaving a project removes its tasks from your calendars on the next fetch; deleting a calendar stops all its URLs.
