# Portals

A **portal** is a published site: a tree of pages rendered as static HTML. Portals are workspace-wide — one portal can publish a project's pages to QA and another the same pages to PROD.

## What lives on a portal

| Field        | Meaning |
| ------------ | ------- |
| Name         | The site's title, shown in its header. |
| Root page    | The site's home page, listed as *Project › Page*. Every page under it (its children, their children, …) is part of the site. Pages in template projects aren't offered. |
| Host name    | The host the public listener serves the site on, e.g. `docs.example.com`. Leave it empty for a preview-only portal. |
| Public       | Off keeps the portal off the public listener entirely — signed-in people can still preview it. Use this for QA. |
| Show in kitp | Lists the site in kitp's sidebar (**Sites**) and shows it inside kitp to people who can see its root page. Works with or without Public. |
| Theme        | How the site looks: a theme from **Admin → Themes**. None uses the built-in Side menu theme. |

## Which pages appear

A portal doesn't pick its pages. **Statuses do.** In **Values → statuses**, give a page status a *Publishes to* list. When a page **enters** that status it is copied onto each of those portals.

Typical setup:

- **In review** publishes to **QA**.
- **Published** publishes to **QA** and **PROD**.

Moving a page back to **Draft** (**Unpublish**, **Back to draft**) takes it off every portal Draft doesn't publish to: a draft isn't live. **Archived** takes it off every portal. Moving between live statuses (In review, Published) leaves the other portals alone: editing a live page, or sending it back to review, doesn't change what PROD shows until the page is published again (**Publish changes**, or back through review).

## Builds

Each change queues a rebuild. A build renders every page, stores the files, and switches the portal to the new build in one step, so a site never shows a half-finished publish. The list shows the active build's page count, when it was built, and any **warnings**:

- a page links (`ref:…`) to a page that isn't on this portal;
- the root page isn't published here yet, with the pages that are published but sit outside it (a portal pointed at the wrong project's *Home*, for example);
- a published page isn't reachable from the root (its parent isn't published here);
- two sibling pages share a path.

**Rebuild** queues a build by hand — after fixing a failed one, for example. **Preview** opens the active build inside kitp.

## Serving

Public portals are served on a separate listener (`KITP_PORTAL_ADDR`), by host name. Point the host's DNS at kitp's portal listener (or a CDN in front of it). Previews and sites shown in kitp are served by kitp itself, sandboxed so a page can't act as you. Inside kitp, links to other sites open in a new tab.

Files attached to a page in the site and used in its body are published with it: pictures, PDFs, fonts and plain text as they are, anything else as a download. A file attached to a page that isn't in the site (not under its root) isn't published.
