# Areas

A project is split into **areas**, and each can be switched on or off:

| Area | Holds |
| ---- | ----- |
| Tasks | tasks, their screens (Inbox, Grid, Kanban …) and links |
| Conversations | email threads, on tasks or on their own, and the mail accounts behind them |
| Approvals | requests to approve a task's status change, and the votes |
| Content | pages: the page tree, its status flow and the Pages screen |

A project's areas are switched on its **Areas** screen: the sidebar's **PROJECT → Areas**, for the project you're in. Projects with an overview screen show the same switches in **Edit properties**, section AREAS.

**Sites** — portals, themes, public hosts and sites shown in kitp — is switched for the whole workspace, on **WORKSPACE → Areas**.

## Off means hidden

Switching an area off hides everything in it **from everyone, admins included**: its items vanish from lists, search, the activity feed, exports and agents (with Approvals off, votes go too; with Conversations off, the messages of its threads); its screens leave the sidebar; changes to it are refused; and it stops working — no mail is fetched or sent for Conversations (replies waiting on its threads go once it's back on), no pages are published or served for Content, and with Sites off no site is built or served. With Tasks off, a mail account that files new mail as tasks files it as threads on their own instead. Use it for data that must not be seen, not only for tidying.

Nothing is deleted. Switching the area back on restores it as it was — items, screens, published sites.

## Who can switch

- **Off:** a manager or an admin of the project (Sites: an admin).
- **On:** an admin only, because it reveals what the area holds (adding a starting point to a project is an admin's too).

An area that others need can't be switched off while they're on: Approvals needs Tasks. Conversations doesn't, so a shared inbox can run with Tasks off. Switching an area on also switches on what it needs.

## Setting an area up

An area a project doesn't have yet shows **Not set up**. A project copied from a template, or made before areas existed, already has the areas its statuses and screens belong to (usually Tasks and Conversations), so those show **On**. Setting an area up copies in its starting point (statuses, screens, starter pages) — the project's own from then on, to change as you like. A new project picks its areas in the new-project dialog (**Start from → Choose areas…**; the shortcuts tick the usual combinations).

A project's switches are recorded in its activity. Each area here also says when it was last switched, and by whom — the workspace's Sites too, which has no project to record it on.
