# Feature bundles and portals

Status: first slice, on branch `bundles-portals`. Authored 2026-11-01.

Two related pieces of work:

1. **Feature bundles** — a project is composed from named features (task
   tracking, conversations, publishing) instead of copied from one
   template, and features can be added later. Presets name common
   combinations ("Issue tracker", "Help desk", "Shared inbox", "Content
   management").
2. **Portals** — pages written in kitp, moved through a status flow, and
   published as static sites. A status names the portals a page goes to
   when it enters that status, so one status can feed QA and the next QA
   and PROD.

Both are opt-in: a project without the publishing feature has no pages
screen or page flow; an install without portals publishes nothing.

## Feature bundles

### What a bundle is

A bundle is an hcsv file in `db/schema/bundles/` that reads like
`demo.hcsv`: one project card (alias `bundle_src`, `is_template=true`,
`bundle_key=<key>`) and the cards, flows and flow steps under it — status
value cards, screens, filters, predicate snippets, starter pages.

```
# bundle | key=publishing | title="Publishing" | sort=30 | doc="…"
## table card | alias=bundle_src
### rows
card_type_id, title, is_template, bundle_key
$card_type.project, "Bundle: Publishing", true, publishing
## table card | under=bundle_src
…
```

`presets.hcsv` lists presets: a key, a title, and the features applied in
order.

| preset          | features                   |
|-----------------|----------------------------|
| `issue_tracker` | tracker                    |
| `help_desk`     | helpdesk, conversations    |
| `shared_inbox`  | conversations              |
| `content`       | tracker, publishing        |

(`customer_care` — tracker + conversations — became `help_desk` and
`shared_inbox`; see [CONVERSATIONS.md](CONVERSATIONS.md).)

### How bundles reach the database

`store.ApplySchema` gained a fourth tier after the forward migrations:

| tier | what | re-applied |
|------|------|------------|
| DDL  | tables, indexes, functions | every boot |
| seed | built-in rows | never (first boot only) |
| migrations | data fixes for existing installs | once each |
| **bundles** | each bundle's hidden source project + the `bundle` catalog | **when the bundle file changes** |

Each bundle's source project is code-owned, like DDL: when the rendered
SQL's checksum differs from the `bundle` row, the old source is purged
(`bundle_source_purge`) and rebuilt from the file. Changing a built-in
bundle therefore needs no forward migration — the install seed's
"never re-runs" rule (see CLAUDE.md) doesn't apply to bundles.

Source projects are `is_template=true` (hidden from project lists) and
carry `bundle_key` (excluded from the template picker and from
`card.insert`'s default auto-stamp). They are code-owned: `bundle_key` is
set only by bundle files (attribute.update / card.insert refuse it), the
dispatcher refuses any write inside a source project, project.stamp
won't copy one, and boot rebuilds a source by the id the catalog records.

### Applying a bundle

`bundle.apply {project_id, keys}` and `project.compose {name, preset?,
features?}` both go through `bundle_apply`, which merge-copies the
source into the project with `copy_project_template_merge` — the same
graph copy `project.stamp` uses (card id remap, flow / flow step copy,
predicate-tree remap), extended with an *origin*:

- every source card gets an **item key**, its `card_type:title` path
  below the source (`screen:Inbox/filter:Waiting on my vote`);
- a copied card records `card_origin (card_id, project_id, bundle_key,
  item_key)`;
- an item the project already holds is **mapped, not copied**: new
  children and card refs still resolve to it, and its values are left
  alone. A renamed card keeps its origin; a deleted one stays deleted.

Rules:

- **Features add, they never modify.** A feature whose flow would bind an
  attribute the project already drives with a flow of its own is refused
  (`bundle_conflict`) rather than half-applied. Example: `conversations`
  on a project stamped from the Standard Project Template, which carries
  a comm flow.
- **Re-applying is safe.** It adds only items the project lacks — the way
  a newer bundle version reaches an existing project. A flow step is added
  only when it touches a status the re-apply added; one the project deleted
  between its own statuses stays deleted.
- **Enabled = has origin rows.** `bundle.list {project_id}` reports a
  feature as enabled when any card in the project came from it, and gives
  the conflict reason for features that can't be added.

### UI

- New-project dialog: "Choose areas…" ticks the project's areas, with the
  presets as shortcuts (→ `project.compose` with each ticked area's
  starting point and `areas_off`), or a template (→ `project.stamp`,
  unchanged). See [AREAS.md](AREAS.md).
- Project properties: an AREAS section that switches areas on and off and
  sets up the ones a project never used (→ `area.set`, which applies the
  area's starting point through `bundle_apply`). `bundle.apply` stays as
  the API for adding a bundle directly.

## Portals

### Model

| piece | what |
|-------|------|
| `page` card | title, markdown `description` (the body), `slug`, `sort_order`, `publish_status`. Parent: a project or another page — the card tree is the site tree. |
| `publish_status` flow | Draft (triage) → In review → Published (active) → Archived (terminal), from the publishing bundle. Includes a Published → Published "Publish changes" step. |
| `publishes_to` on status | the portals a page is published to when it **enters** that status. |
| `portal` card (global) | title, `portal_root` (the home page; a page in a live, non-template project), `portal_host`, `portal_public`. |
| `publication` | what one portal shows for one page: a snapshot. |
| `portal_state` / `portal_build` / `portal_build_file` | the active build pointer, each build, and its files (CAS blobs). |

### Publishing rules

`attribute.update` calls `publication_after_write` after every write;
for a page's `publish_status` it runs `publication_sync`:

- entering a status whose `publishes_to` names portals **snapshots** the
  page onto each (title, body, slug, order, parent, nav flags, newest
  activity id);
- entering a **triage** status (Draft: not live) also withdraws it from
  every other portal — that is "Unpublish" / "Back to draft";
- entering a **terminal** status withdraws it from every portal;
- entering an **active** status (In review, Published) leaves the other
  portals alone.

So what a portal shows is **pinned** while a page stays live. Editing a
live page doesn't change PROD; sending it back to review updates QA only;
"Publish changes" or "Publish" updates both; Unpublish takes it down.
`card.delete` takes a page (and every page under a deleted card) off its
portals but keeps its publications, so `card.undelete` brings it back as it
was published (review 2026-11-03 round 2 #19). Moving a published page, or a
card above one, rebuilds the portals it is on; a page no longer under a
portal's root is neither built (so the site doesn't link it) nor served
(round 3 #21, round 4 #14).
(Migration 0017 applied the Draft rule to pages already in Draft, and
renamed the flow's old "Unpublish edits" step, which had kept the live
copy, to "Unpublish".)

Example: `In review → [QA]`, `Published → [QA, PROD]`.

| action | QA shows | PROD shows |
|--------|----------|------------|
| Draft → In review | rev 1 | — |
| In review → Published | rev 1 | rev 1 |
| edit body | rev 1 | rev 1 |
| Published → In review | rev 2 | rev 1 |
| In review → Published | rev 2 | rev 2 |
| Published → Draft (Unpublish) | — | — |
| Draft → Published | rev 3 | rev 3 |
| Published → Archived | — | — |

### Building

`portal.build` is a scheduler job (`KITP_PORTAL_BUILD_TICK_SEC`, default
5s). Every change to a portal's publications or settings marks it dirty;
the job renders each dirty portal:

- **Render** (pure Go): the page tree under the root, one
  `<path>/index.html` per page, `site.css`, `404.html`. Markdown via
  goldmark (Hugo's renderer; GitHub flavour; raw HTML dropped). All links
  are **relative**, so one build works at `/` on its public host and
  under the preview prefix.
- **Store**: each file as a CAS blob (unchanged files dedupe), listed in
  `portal_build_file`. The CAS reaper counts these references.
- **Flip**: `portal_state.active_build_id` switches to the new build in
  one transaction, and builds beyond the newest five are pruned. The
  dirty flag clears only if nothing changed mid-build.

Publishing is atomic (a site never serves a half-written build) and
rollback is a pointer change.

Placeholders, borrowed from Hugo shortcodes:

| placeholder | expands to |
|-------------|------------|
| `{{< children >}}` | a list of the page's child pages |
| `{{< nav >}}` | the whole site tree |
| `{{< toc >}}` | the page's level-2/3 headings |

A placeholder inside a code span or code block is left as written; that
is how a page shows one literally.

The page detail's editor has an **Insert** menu of these (the page
detail profile's `placeholders`; tasks have none), which adds one as a
top-level paragraph so a list never lands inside a list item. Under the
body, a box lists placeholder mistakes as you type (debounced) and while
reading: an unknown name with a near-miss suggestion, braces written
another way (`{{ children }}`, `{{< Children >}}`), and the retired
`{{< ref >}}`. The check parses the body with the editor's markdown parser
and skips code, as the build does. The list lives in
`web/src/bundles/placeholders.ts` and mirrors `expandPlaceholders` in
`render.go`.

Links between pages use a `ref:` link target, resolved to a relative URL:

| link | points at |
|------|-----------|
| `[Install](ref:guide/install)` | the page at that path |
| `[Install](ref:42)` | page 42 |
| `[Home](ref:)` | the root page |
| `[Setup](ref:guide#setup)` | a heading on another page |

Why not Hugo's `{{< ref "a/b" >}}` inside the link? A placeholder isn't a
valid markdown link target (spaces, `<`), so the rich-text editor reads
`[text]({{< ref … >}})` as plain text and, on the next save, escapes the
brackets (`\[text\](…)`) and the link is lost. A `ref:` link is an
ordinary link: the editor shows it as one and saves it unchanged. The
renderer warns if it meets the old placeholder.

In the page detail, the editor's **Link** button opens a link bar: paste
a URL, or search the project's pages and pick one, which inserts
`ref:<id>` (an id survives renames and moves; a path doesn't). The
search matches every typed word against the page's path ("Home › Guide ›
Install") and its number, and lists pages whose own title matches first.
The list scrolls and renders at most 50 rows, with a count of the rest.

A `ref:` link to a page that isn't on this portal renders as `#` with a
build warning, so QA can link to a page PROD doesn't have yet without a
broken URL. Pages that aren't reachable from the root, and sibling slug
collisions, are build warnings too (shown on the Portals screen). A root
that isn't published here is named in its warning (`"Home" in "Docs"`),
followed by the published pages outside it.

What one page can make is capped, so a page can't stop a portal's
builds or take kitpd past its memory (`render.go`, `mdlimits.go`). Each
cap answers with a build warning naming the page, and the build goes
through:

| cap | past it |
|-----|---------|
| a table: 64 columns; the page's tables: 50,000 cells | the table shows as the text it was written as |
| the page's text: 1 MB, or 2 MB once its placeholders are expanded | the page is published without its text |
| the page's text as HTML (`{{< toc >}}` included): 4 MB | the page is published without its text |
| the site's text as HTML: 128 MB | the pages past it are published without their text |
| one page with its theme: 8 MB | published without its text; if it's too large even then, the theme (or the site's navigation) is at fault and the build fails |

A GFM table pads every row to its header's width, so a few KB of text
could make a million cells; the cell count is bounded before goldmark
builds the table. Writes refuse a page text over 512 KB. The build stops
between pages when its tick's deadline passes.

### Serving

Builds are served from kitp's own store, not written to disk or pushed
to a bucket:

- **Public listener** (`KITP_PORTAL_ADDR`, e.g. `:18081`): a separate
  `http.Server` that serves only public portals, chosen by the `Host`
  header (`portal_host`). It mounts no `/api` and reads no session
  cookie — domain separation is structural. Non-public portals are never
  served there.
- **Preview** (`/api/v1/portal/{id}/preview/…` on the app): any signed-in
  user who can see the portal's root page can view its active build,
  public or not. This is how a QA portal stays internal. Responses carry
  `Content-Security-Policy: sandbox allow-same-origin …` without
  `allow-scripts`: no script runs, so keeping the app's origin (which the
  page's own stylesheets and links need, see Show in kitp) gives the page
  nothing to use the session with.

Both send a strict CSP (no script), `ETag` = content hash (cheap 304s),
and `no-cache` on HTML so a publish shows up on the next request.

**Why not object storage?** Serving straight from a bucket gives up
atomic publishes (uploads land file by file), access control for QA,
clean URLs / 404s / headers, and needs a CDN for TLS on a custom domain
anyway. Serving from the CAS keeps publishes atomic and rollback cheap,
works across replicas without shared disk, and a CDN can sit in front of
the public listener (the ETag is the content hash). Exporting a build to
a bucket could be added as an optional target later.

### Themes

What a site looks like is a **theme** (`server/internal/dom/portal/theme.go`).
The server compiles in seven base themes (`portal/themes/<key>/`, each
`theme.json` + `page.html` + `site.css`): Side menu (the default), Top
menu (CSS-only drop-downs), Newspaper (lead story + multi-column stories,
paged, newest first; story text in CSS columns), Book (numbered contents,
previous / next chapter), Help center (section cards, a section sidebar),
Blog (posts newest first, paged) and Reference (three columns with "On
this page").

A `theme` card (global, admin-only, like a portal) names a base
(`theme_base`) and sets `theme_nav`, `theme_accent` and `theme_footer`
(markdown); a portal points at one with `portal_theme` (none = Side
menu). Its own files are `theme_file` rows (path → one CAS blob), written
by `theme.file_put` and listed / read by `theme.list` / `theme.file_get`;
the base's files are read-only through `theme.bases` / `theme.base_file`.
A theme's own file at a base file's path overrides it — that is the fork.

- `*.html` files are one `html/template` set, `page.html` first and the
  rest by path, so a file of `{{define}}` blocks overrides `{{block}}`s.
  Templates are never published. The data every template gets is the
  `view` struct in `render.go`, documented in `admin_themes.md` and at the
  top of the Side menu `page.html`.
- `theme.json` merges over the base's: `nav` (full / section /
  collapsible), `paginate` (child pages per list page) and `order` (site /
  newest).
- Everything else is published under `_theme/`. `custom.css` is written
  as `_theme/custom.css` = `:root { --accent }` + the theme's custom.css,
  so every template links `{{.Theme}}site.css` then `{{.Theme}}custom.css`
  unconditionally. `logo.*` / `favicon.*` set `.Site.Logo` / `.Site.Icon`.
- `theme.file_put` (Go PreRun) checks the path (lower-case, no dot files,
  an allowed extension — no scripts), caps a file at 5 MB, and for a
  template or `theme.json` resolves the theme with it and renders a sample
  site (sections, a hidden page, a paged list); a failure is refused as
  `template_error` with file and line. `theme.file_delete` checks the same
  without the file. A build whose theme no longer renders fails, so the
  portal keeps its last good build and shows the error.
- Any theme change marks every portal using it dirty
  (`theme_mark_portals_dirty`).

**Navigation.** The renderer builds `.Nav` per page: `full` keeps every
branch, `section` keeps the top level plus the branch down to the current
page (`HasChildren` still says a closed item has children), `collapsible`
keeps everything and marks `Open` only along the current page (themes draw
`<details>`). A page's `nav_hidden` drops it and its subtree from `.Nav`,
`{{< nav >}}`, the theme's `.Children` lists and the reading order (it is
still published and `{{< children >}}` still lists it); `nav_hide_children`
keeps the page but not its children. Both flags are part of the
publication snapshot.

**Lists and paging.** `.Children` is a page's children (not hidden), with
a plain-text summary (first paragraph) and first image, in the theme's
order. With `paginate` N and more than N children, pages 2… are written
to `<page>/page/<k>/index.html` (links climb from that depth) and `.Pager`
links them; the body (`.Content`) is on page 1 only.

**Pictures.** An image or link to an attachment
(`/api/v1/attachment/<id>/view|download|thumb`, or `attachment:<id>`) that
is attached to a page placed in the site (under the portal's root) is
copied into the build at `_files/<id>/<name>` (≤ 25 MB) and rewritten; any
other attachment is `#` with a warning, so a page can't publish another
project's file. A status only publishes to portals rooted in its own
project, and only a workspace admin sets `publishes_to`. Pictures, PDFs,
fonts and plain text are served as what they are; any other type as
`application/octet-stream`, a download. `_files` are sandboxed. The page
editor's Insert menu offers the page's attached pictures.

Links to other sites get `target="_blank" rel="noopener noreferrer"`.

### Show in kitp

`portal_internal` lists a portal in kitp's sidebar (SITES, from
`portal.list`) and shows it at `/site/<id>`: a header and an iframe of
`/api/v1/portal/<id>/site/`. That route serves the active build to people
who can see the root page (as the preview does) only when the switch is
on, under `sandbox allow-same-origin allow-popups
allow-popups-to-escape-sandbox` and `frame-ancestors 'self'`: no scripts,
forms or top-level navigation, and external links open outside the
sandbox. The page keeps kitp's origin on purpose — with an opaque origin
every request it makes is cross-site, the SameSite=Lax session cookie
stays behind, and its stylesheets and links get 401s. Without script,
the origin gives the page nothing to act with. The preview uses the same
sandbox (and `frame-ancestors 'none'`); the iframe repeats it. The kitp URL doesn't follow clicks inside the frame.

### Local try-out

```
make run KITP_PORTAL_ADDR=:18081      # or export it before make demo
```

1. Create a project from the **Content management** preset.
2. Admin → Portals: create `QA` (root: *your project* › Home, not
   public) and `PROD` (same root, host `prod.localhost`, public).
3. Admin → Values → statuses: In review → publishes to QA; Published →
   QA and PROD.
4. Move Home and Getting started through review and publish them.
5. Preview from a page's PUBLISHED ON section, or open
   `http://prod.localhost:18081/` (browsers resolve `*.localhost` to
   loopback).

The Pages screen is `g w`; a page opens at `/page/<id>` with its status
flow in the transition bar, a PLACE IN SITE section (its trail, Under …
to move it, child pages with ↑ / ↓, + Child page, Hide from navigation)
and a PUBLISHED ON section listing each portal it is on, whether that
copy is current, and a preview link. Themes are Admin → Themes; a portal
picks one, and "Show in kitp" adds it to the sidebar.

## Known rough edges

- The Values admin offers a *publishes to* picker on every status, task
  statuses included — the task and page flows share the `status` card
  type. Only page statuses act on it.
- Inside kitp (the page's own view), a `ref:` link isn't resolved: it
  only works on the built site.
- Bundle source projects are visible to global-role users through the
  generic card reads (like templates); the client filters them out of
  every project and template list (`bundle_key` not exists). The Portals
  root-page picker uses `portal.root_pages`, which leaves out template
  projects' pages, and `portal.set` refuses one (`root_in_template`), so a
  portal can't be pointed at a bundle's own starter Home page.

## Deferred

Areas ([AREAS.md](AREAS.md)) are built: features are switchable areas,
bundles their starting points and presets their shortcuts. Still to do
there: the Pages screen as a movable tree.

- **Customer portal** (sign-in for contacts, submit / follow tickets):
  needs a second identity kind and visibility rule; a separate design.
- **Explicit menu cards** (a hand-ordered nav document at a root);
  today nav is the page tree ordered by `sort_order`.
- **Slug history / redirects** when a page moves.
- **Scripts in themes** (an "Allow scripts" theme switch); none today.
- **Theme previews** before a portal uses the theme (today: point a QA
  portal at it).
- **Following clicks** inside a site shown in kitp in kitp's own URL.
- **System-level mail accounts** routed to projects by address, and a
  setup wizard step for project members.
- **Exporting builds** to a directory or bucket.
- **Bundle update notices** ("publishing v3 adds a Review screen —
  re-apply?").
- A `portal` activity-sink kind, so portal builds run on the sink pump.
  The build job is a plain scheduler job for now.
