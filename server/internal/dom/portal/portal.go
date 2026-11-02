// Package portal publishes pages as static sites.
//
// A PORTAL is a global `portal` card: a site with a root page, an optional
// public host name, and a public flag. Which pages it shows is decided by
// the publish_status flow: a status's publishes_to names the portals a page
// is snapshotted onto when it enters that status (publication_sync), so one
// status can feed a QA portal and the next feed QA and PROD. The snapshot is
// pinned — editing a live page changes no portal until the page re-enters a
// publishing status ("Publish changes", or another trip through review).
//
// Three parts, all in this package:
//
//   - Render (render.go) — pure: a Site (title, root, published pages) →
//     static files. Markdown via goldmark with Hugo-style placeholders
//     ({{< children >}}, {{< nav >}}, {{< toc >}}) and ref: links to
//     other pages ([Install](ref:guide/install)); relative links only, so
//     a build works at any URL prefix.
//   - Builder (build.go) — the `portal.build` job: renders every dirty
//     portal, stores the files as CAS blobs listed in portal_build_file,
//     and flips portal_state.active_build_id in one transaction.
//   - Server (serve.go) — serves the active build: publicly by host name on
//     a separate listener (KITP_PORTAL_ADDR; no /api, no session), and to
//     signed-in users through the sandboxed preview route on the app.
//
// Dispatcher endpoints: portal.set / portal.list / portal.rebuild /
// portal.root_pages (the Portals admin screen), page.publications (where a
// page is live) and the theme.* endpoints (theme_handlers.go: the Themes
// admin screen). Themes are described in theme.go.
package portal

import (
	"reflect"

	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// Config wires the portal handlers: Storage holds theme files (theme.*
// reads and writes them as CAS blobs).
type Config struct {
	Pool    *store.Pool
	Storage *cas.Storage
}

// SetInput creates (no id) or updates a portal. Pointer fields: absent =
// leave unchanged.
type SetInput struct {
	ID         int64   `json:"id,string,omitempty" mcp:"desc=portal card id to update; omit to create a portal"`
	Title      *string `json:"title,omitempty" mcp:"desc=site name (required when creating)"`
	Host       *string `json:"host,omitempty" mcp:"desc=host name the public listener serves the site on, e.g. 'docs.example.com'; '' for none"`
	RootPageID *int64  `json:"root_page_id,string,omitempty" mcp:"desc=page whose tree the site publishes (its home page); '0' clears"`
	Public     *bool   `json:"public,omitempty" mcp:"desc=serve on the public listener; false keeps the portal preview-only (e.g. QA)"`
	ThemeID    *int64  `json:"theme_id,string,omitempty" mcp:"desc=theme card the site is built with (theme.list); '0' = the built-in Side menu theme"`
	Internal   *bool   `json:"internal,omitempty" mcp:"desc=show in kitp: list the site in kitp's sidebar and show it inside kitp to people who can see its root page"`
}

// SetOutput reports the portal and what the call did.
type SetOutput struct {
	ID      int64 `json:"id,string" mcp:"desc=portal card id"`
	Created bool  `json:"created" mcp:"desc=true when this call created the portal"`
	Changed bool  `json:"changed" mcp:"desc=true when anything was written"`
}

// ListInput takes no arguments.
type ListInput struct{}

// Row is one portal with its build state.
type Row struct {
	ID            int64    `json:"id,string" mcp:"desc=portal card id"`
	Title         string   `json:"title" mcp:"desc=site name"`
	Host          string   `json:"host" mcp:"desc=public host name; empty for none"`
	Public        bool     `json:"public" mcp:"desc=served on the public listener"`
	Internal      bool     `json:"internal" mcp:"desc=shown inside kitp (sidebar + content area)"`
	ThemeID       int64    `json:"theme_id,string" mcp:"desc=theme card id; 0 = the built-in Side menu theme"`
	ThemeTitle    string   `json:"theme_title" mcp:"desc=theme name; empty for the built-in default"`
	RootPageID    int64    `json:"root_page_id,string" mcp:"desc=root page id; 0 when unset"`
	RootTitle     string   `json:"root_title" mcp:"desc=root page title"`
	RootLabel     string   `json:"root_label" mcp:"desc=root page with its project, 'Project › Home'; empty when unset"`
	RootProjectID int64    `json:"root_project_id,string" mcp:"desc=project the root page belongs to"`
	Statuses      []string `json:"statuses" mcp:"desc=statuses that publish to this portal, as 'Project › Status'"`
	PageCount     int      `json:"page_count" mcp:"desc=pages in the active build"`
	BuiltAt       string   `json:"built_at" mcp:"desc=RFC3339 time of the active build; empty when never built"`
	ActiveBuildID int64    `json:"active_build_id,string" mcp:"desc=active build id; 0 when never built"`
	Warnings      []string `json:"warnings" mcp:"desc=warnings from the active build (unreachable pages, broken refs, …)"`
	Dirty         bool     `json:"dirty" mcp:"desc=a rebuild is pending"`
	LastError     string   `json:"last_error" mcp:"desc=why the last build failed; empty when it didn't"`
}

// ListOutput wraps the rows.
type ListOutput struct {
	Rows []Row `json:"rows" mcp:"desc=live portals, by title"`
}

// RebuildInput names a portal.
type RebuildInput struct {
	ID int64 `json:"id,string" mcp:"required,desc=portal card id"`
}

// RebuildOutput acknowledges the request.
type RebuildOutput struct {
	Queued bool `json:"queued" mcp:"desc=true once the portal is queued for the next build"`
}

// RootPagesInput takes no arguments.
type RootPagesInput struct{}

// RootPage is one page a portal may use as its root.
type RootPage struct {
	ID        int64  `json:"id,string" mcp:"desc=page card id"`
	Label     string `json:"label" mcp:"desc=the page with its project and parent pages, 'Project › Home › Guide'"`
	ProjectID int64  `json:"project_id,string" mcp:"desc=project the page belongs to"`
}

// RootPagesOutput wraps the rows.
type RootPagesOutput struct {
	Rows []RootPage `json:"rows" mcp:"desc=candidate root pages, by label"`
}

// PublicationsInput names a page.
type PublicationsInput struct {
	PageID int64 `json:"page_id,string" mcp:"required,desc=page card id"`
}

// Publication is one portal a page is live on.
type Publication struct {
	PortalID    int64  `json:"portal_id,string" mcp:"desc=portal card id"`
	PortalTitle string `json:"portal_title" mcp:"desc=portal name"`
	Host        string `json:"host" mcp:"desc=portal's public host; empty for none"`
	Public      bool   `json:"public" mcp:"desc=portal is served publicly"`
	PublishedAt string `json:"published_at" mcp:"desc=RFC3339 time this snapshot was taken"`
	PublishedBy string `json:"published_by" mcp:"desc=who moved the page into the publishing status"`
	Current     bool   `json:"current" mcp:"desc=the snapshot matches the page as it is now; false = the page has edits this portal doesn't show"`
	Path        string `json:"path" mcp:"desc=file path of the page in the portal's active build, e.g. 'guide/index.html'; empty until built"`
}

// PublicationsOutput wraps the rows.
type PublicationsOutput struct {
	Rows []Publication `json:"rows" mcp:"desc=portals the page is published to"`
}

// Register installs portal.set / portal.list / portal.rebuild /
// portal.root_pages / page.publications and the theme.* handlers.
func Register(cfg Config) {
	registerThemes(cfg.Storage)
	reg.Register(reg.Handler{
		Endpoint:     "portal",
		Action:       "set",
		Doc:          "Create or update a portal (a published site): its title, root page, public host name, whether it is served publicly or only as a signed-in preview, whether it shows inside kitp, and its theme. Which pages it shows is set on statuses (publishes_to). Admin only.",
		InputType:    reflect.TypeFor[SetInput](),
		OutputType:   reflect.TypeFor[SetOutput](),
		AllowedRoles: []string{"admin"},
		SQLFunc:      "portal_set_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "portal",
		Action:       "list",
		Doc:          "List portals with their root page, host, theme, whether they show inside kitp, the statuses that publish to them, and their build state (pages, built at, warnings, pending rebuild, last error).",
		InputType:    reflect.TypeFor[ListInput](),
		OutputType:   reflect.TypeFor[ListOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		IsRead:       true,
		SQLFunc:      "portal_list_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "portal",
		Action:       "rebuild",
		Doc:          "Queue a portal for rebuilding (builds otherwise follow publication changes). Admin only.",
		InputType:    reflect.TypeFor[RebuildInput](),
		OutputType:   reflect.TypeFor[RebuildOutput](),
		AllowedRoles: []string{"admin"},
		SQLFunc:      "portal_rebuild_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "portal",
		Action:       "root_pages",
		Doc:          "List the pages a portal can use as its root: live pages in projects that aren't templates, each labelled with its project and parent pages ('Docs › Home › Guide'). Feeds the Portals screen's root-page picker. Admin only.",
		InputType:    reflect.TypeFor[RootPagesInput](),
		OutputType:   reflect.TypeFor[RootPagesOutput](),
		AllowedRoles: []string{"admin"},
		IsRead:       true,
		SQLFunc:      "portal_root_pages_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "page",
		Action:       "publications",
		Doc:          "List the portals a page is published to: when, by whom, whether that copy is current, and its path in the portal's active build.",
		InputType:    reflect.TypeFor[PublicationsInput](),
		OutputType:   reflect.TypeFor[PublicationsOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		IsRead:       true,
		SQLFunc:      "page_publications_batch",
	})
}
