# Feature bundles and portals

Status: first slice, on branch `bundles-portals`. Authored 2026-11-01.

Two related pieces of work:

1. **Feature bundles** — a project is composed from named features (task
   tracking, conversations, publishing) instead of copied from one
   template, and features can be added later. Presets name common
   combinations ("Issue tracker", "Customer care", "Content management").
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
| `customer_care` | tracker, conversations     |
| `content`       | tracker, publishing        |

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
`card.insert`'s default auto-stamp).

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
- **Re-applying is safe.** It adds only items (and flow steps) the project
  lacks — the way a newer bundle version reaches an existing project.
- **Enabled = has origin rows.** `bundle.list {project_id}` reports a
  feature as enabled when any card in the project came from it, and gives
  the conflict reason for features that can't be added.

### UI

- New-project dialog: choose a preset (→ `project.compose`) or a template
  (→ `project.stamp`, unchanged).
- Project properties: a Features section listing enabled features and an
  Add button for the others (→ `bundle.apply`).

## Portals

### Model

| piece | what |
|-------|------|
| `page` card | title, markdown `description` (the body), `slug`, `sort_order`, `publish_status`. Parent: a project or another page — the card tree is the site tree. |
| `publish_status` flow | Draft (triage) → In review → Published (active) → Archived (terminal), from the publishing bundle. Includes a Published → Published "Publish changes" step. |
| `publishes_to` on status | the portals a page is published to when it **enters** that status. |
| `portal` card (global) | title, `portal_root` (the home page), `portal_host`, `portal_public`. |
| `publication` | what one portal shows for one page: a snapshot. |
| `portal_state` / `portal_build` / `portal_build_file` | the active build pointer, each build, and its files (CAS blobs). |

### Publishing rules

`attribute.update` calls `publication_after_write` after every write;
for a page's `publish_status` it runs `publication_sync`:

- entering a status whose `publishes_to` names portals **snapshots** the
  page onto each (title, body, slug, order, parent, newest activity id);
- entering a **terminal** status withdraws it from every portal;
- entering any other status changes nothing.

So what a portal shows is **pinned**. Editing a live page doesn't change
PROD; sending it back to review updates QA only; "Publish changes" or
"Publish" updates both. `card.delete` withdraws a page; restoring it
doesn't republish it.

Example: `In review → [QA]`, `Published → [QA, PROD]`.

| action | QA shows | PROD shows |
|--------|----------|------------|
| Draft → In review | rev 1 | — |
| In review → Published | rev 1 | rev 1 |
| edit body | rev 1 | rev 1 |
| Published → In review | rev 2 | rev 1 |
| In review → Published | rev 2 | rev 2 |
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
| `{{< ref "a/b" >}}` / `{{< ref 42 >}}` | the relative URL of a page, by path or id |
| `{{</* … */>}}` | the placeholder, literally |

A `ref` to a page that isn't on this portal renders as `#` with a build
warning, so QA can link to a page PROD doesn't have yet without a broken
URL. Pages that aren't reachable from the root, and sibling slug
collisions, are build warnings too (shown on the Portals screen).

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
  `Content-Security-Policy: sandbox …`, so the page runs in an opaque
  origin and can't use the app's session.

Both send a strict CSP (no script), `ETag` = content hash (cheap 304s),
and `no-cache` on HTML so a publish shows up on the next request.

**Why not object storage?** Serving straight from a bucket gives up
atomic publishes (uploads land file by file), access control for QA,
clean URLs / 404s / headers, and needs a CDN for TLS on a custom domain
anyway. Serving from the CAS keeps publishes atomic and rollback cheap,
works across replicas without shared disk, and a CDN can sit in front of
the public listener (the ETag is the content hash). Exporting a build to
a bucket could be added as an optional target later.

### Local try-out

```
make run KITP_PORTAL_ADDR=:18081      # or export it before make demo
```

1. Create a project from the **Content management** preset.
2. Admin → Portals: create `QA` (root: Home, not public) and `PROD`
   (root: Home, host `prod.localhost`, public).
3. Admin → Values → statuses: In review → publishes to QA; Published →
   QA and PROD.
4. Move Home and Getting started through review and publish them.
5. Preview from a page's PUBLISHED ON section, or open
   `http://prod.localhost:18081/` (browsers resolve `*.localhost` to
   loopback).

The Pages screen is `g w`; a page opens at `/page/<id>` with its status
flow in the transition bar and a PUBLISHED ON section listing each portal
it is on, whether that copy is current, and a preview link.

## Known rough edges

- The Values admin offers a *publishes to* picker on every status, task
  statuses included — the task and page flows share the `status` card
  type. Only page statuses act on it.
- The Portals root-page picker labels pages by title only, so two
  projects' "Home" pages look alike.
- Bundle source projects are visible to global-role users through the
  generic card reads (like templates); the client filters them out of
  every project and template list (`bundle_key` not exists).

## Deferred

- **Customer portal** (sign-in for contacts, submit / follow tickets):
  needs a second identity kind and visibility rule; a separate design.
- **Explicit menu cards** (a hand-ordered nav document at a root);
  today nav is the page tree ordered by `sort_order`.
- **Slug history / redirects** when a page moves.
- **Per-portal themes and layouts**; one built-in layout today.
- **Images and attachments in published pages** (copy published
  attachments into the build).
- **System-level mail accounts** routed to projects by address, and a
  setup wizard step for project members.
- **Exporting builds** to a directory or bucket.
- **Bundle update notices** ("publishing v3 adds a Review screen —
  re-apply?").
- A `portal` activity-sink kind, so portal builds run on the sink pump.
  The build job is a plain scheduler job for now.
