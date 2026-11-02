package portal_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/bundle"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/portal"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

type fixture struct {
	srv     *api.Server
	sp      *store.Pool
	storage *cas.Storage
	builder *portal.Builder
	server  *portal.Server
	project int64
	home    int64
	guide   int64
	status  map[string]int64 // publish status title → id
}

func setup(t *testing.T, schemaName string) fixture {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schemaName)
	sp := store.NewPool(pool)
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	bundle.Register(sp)
	storage := cas.New(cas.NewPgBackend(pool))
	portal.Register(portal.Config{Pool: sp, Storage: storage})
	f := fixture{
		srv:     api.NewServer(sp),
		sp:      sp,
		storage: storage,
		builder: &portal.Builder{Pool: pool, Storage: storage},
		server:  &portal.Server{Pool: pool, Storage: storage},
		status:  map[string]int64{},
	}
	var out bundle.ComposeOutput
	decode(t, call(f, sysCtx(), "project", "compose", `{"name":"Docs","features":["publishing"]}`), &out)
	f.project = out.NewProjectID
	f.home = pageID(t, f, "Home")
	f.guide = pageID(t, f, "Getting started")
	for _, s := range []string{"Draft", "In review", "Published", "Archived"} {
		f.status[s] = store.TemplateStatusID(t, pool, f.project, s)
	}
	return f
}

func sysCtx() context.Context { return auth.WithSystemUser(context.Background()) }

func call(f fixture, ctx context.Context, endpoint, action, data string) api.SubResponse {
	resp := f.srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "x", Endpoint: endpoint, Action: action, Data: json.RawMessage(data)},
	}})
	return resp.Subresponses[0]
}

func decode(t *testing.T, sr api.SubResponse, out any) {
	t.Helper()
	if !sr.OK {
		t.Fatalf("want OK; got %+v", sr.Error)
	}
	raw, err := json.Marshal(sr.Data)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		t.Fatalf("unmarshal %s: %v", raw, err)
	}
}

func pageID(t *testing.T, f fixture, title string) int64 {
	t.Helper()
	var id int64
	err := f.sp.P.QueryRow(context.Background(), `
		SELECT c.id FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'page'
		JOIN attribute_value av ON av.card_id = c.id AND av.value = to_jsonb($2::text)
		JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'title'
		WHERE card_enclosing_project(c.id) = $1 AND c.deleted_at IS NULL`, f.project, title).Scan(&id)
	if err != nil {
		t.Fatalf("page %q: %v", title, err)
	}
	return id
}

func setAttr(t *testing.T, f fixture, cardID int64, name string, value any) {
	t.Helper()
	v, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var o attribute.UpdateOutput
	decode(t, call(f, sysCtx(), "attribute", "update",
		fmt.Sprintf(`{"card_id":"%d","attribute_name":%q,"value":%s}`, cardID, name, v)), &o)
}

func move(t *testing.T, f fixture, page int64, status string) {
	t.Helper()
	setAttr(t, f, page, "publish_status", fmt.Sprint(f.status[status]))
}

func newPortal(t *testing.T, f fixture, data string) int64 {
	t.Helper()
	var o portal.SetOutput
	decode(t, call(f, sysCtx(), "portal", "set", data), &o)
	return o.ID
}

// build runs the builder until no portal is dirty.
func build(t *testing.T, f fixture) {
	t.Helper()
	if err := f.builder.RunOnce(context.Background()); err != nil {
		t.Fatalf("build: %v", err)
	}
	var dirty int64
	if err := f.sp.P.QueryRow(context.Background(),
		`SELECT count(*) FROM portal_state WHERE dirty_since IS NOT NULL`).Scan(&dirty); err != nil {
		t.Fatal(err)
	}
	if dirty != 0 {
		t.Fatalf("%d portals still dirty after a build", dirty)
	}
}

func get(t *testing.T, h http.Handler, host, path string) (int, string, http.Header) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Host = host
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	body, err := io.ReadAll(rec.Result().Body)
	if err != nil {
		t.Fatal(err)
	}
	return rec.Code, string(body), rec.Result().Header
}

// TestPublishQAThenProd walks the QA/PROD story end to end through the
// real handlers, builder and public listener:
//
//	In review → QA, Published → QA + PROD; QA is preview-only.
func TestPublishQAThenProd(t *testing.T) {
	f := setup(t, "kitp_test_portal_story")
	qa := newPortal(t, f, fmt.Sprintf(`{"title":"Docs QA","root_page_id":"%d","host":"qa.example.test","public":false}`, f.home))
	prod := newPortal(t, f, fmt.Sprintf(`{"title":"Docs","root_page_id":"%d","host":"docs.example.test","public":true}`, f.home))
	setAttr(t, f, f.status["In review"], "publishes_to", []string{fmt.Sprint(qa)})
	setAttr(t, f, f.status["Published"], "publishes_to", []string{fmt.Sprint(qa), fmt.Sprint(prod)})
	pub := f.server.PublicHandler()

	// Nothing published: PROD serves its placeholder build.
	build(t, f)
	if code, body, _ := get(t, pub, "docs.example.test", "/"); code != 200 || !strings.Contains(body, "Nothing has been published") {
		t.Fatalf("empty PROD: %d %s", code, body)
	}

	// Review: QA gets the pages, PROD still doesn't.
	move(t, f, f.home, "In review")
	move(t, f, f.guide, "In review")
	build(t, f)
	if n := pubCount(t, f, qa); n != 2 {
		t.Fatalf("QA holds %d pages, want 2", n)
	}
	if n := pubCount(t, f, prod); n != 0 {
		t.Fatalf("PROD holds %d pages, want 0", n)
	}
	// QA is not public: the public listener refuses its host outright.
	if code, _, _ := get(t, pub, "qa.example.test", "/"); code != http.StatusNotFound {
		t.Fatalf("QA on the public listener: %d, want 404", code)
	}

	// Publish: both portals get them; PROD serves the tree.
	move(t, f, f.home, "Published")
	move(t, f, f.guide, "Published")
	build(t, f)
	code, body, hdr := get(t, pub, "docs.example.test:18081", "/")
	if code != 200 || !strings.Contains(body, "<h1>Home</h1>") || !strings.Contains(body, `href="getting-started/"`) {
		t.Fatalf("PROD home: %d %s", code, body)
	}
	// The starter pages' ref: links resolve, and placeholders in backticks
	// stay literal.
	if !strings.Contains(body, `<a href="getting-started/">Getting started</a> for how pages`) {
		t.Errorf("PROD home: the ref: link didn't resolve: %s", body)
	}
	if _, gs, _ := get(t, pub, "docs.example.test", "/getting-started/"); !strings.Contains(gs, `<a href="../">this link</a>`) ||
		!strings.Contains(gs, `<code>{{&lt; children &gt;}}</code>`) || !strings.Contains(gs, `<a href="#links-and-placeholders">`) {
		t.Errorf("PROD getting started: ref: link / literal placeholder / toc missing: %s", gs)
	}
	if !strings.Contains(hdr.Get("Content-Security-Policy"), "default-src 'none'") || hdr.Get("ETag") == "" {
		t.Errorf("PROD headers: %v", hdr)
	}
	if code, _, hdr := get(t, pub, "docs.example.test", "/getting-started"); code != http.StatusMovedPermanently || hdr.Get("Location") != "/getting-started/" {
		t.Errorf("slashless page: %d → %q, want 301 to /getting-started/", code, hdr.Get("Location"))
	}
	if code, body, _ := get(t, pub, "docs.example.test", "/getting-started/"); code != 200 || !strings.Contains(body, `href="../_theme/site.css"`) {
		t.Errorf("PROD child page: %d", code)
	}
	if code, body, _ := get(t, pub, "docs.example.test", "/nope/"); code != 404 || !strings.Contains(body, `href="/_theme/site.css"`) {
		t.Errorf("PROD 404: %d, links rooted? %v", code, strings.Contains(body, `href="/_theme/site.css"`))
	}

	// Edit the live page: nothing changes anywhere until it re-enters a
	// publishing status — and page.publications says so.
	setAttr(t, f, f.guide, "description", "Rewritten for v2.")
	build(t, f)
	if _, body, _ := get(t, pub, "docs.example.test", "/getting-started/"); strings.Contains(body, "Rewritten for v2") {
		t.Fatal("an edit reached PROD without a publish")
	}
	var pubs portal.PublicationsOutput
	decode(t, call(f, sysCtx(), "page", "publications", fmt.Sprintf(`{"page_id":"%d"}`, f.guide)), &pubs)
	if len(pubs.Rows) != 2 || pubs.Rows[0].Current || pubs.Rows[1].Current {
		t.Fatalf("publications after edit = %+v, want two stale rows", pubs.Rows)
	}
	if pubs.Rows[0].Path != "getting-started/index.html" {
		t.Errorf("path = %q", pubs.Rows[0].Path)
	}

	// Back to review: QA shows the edit, PROD keeps the old revision.
	move(t, f, f.guide, "In review")
	build(t, f)
	if !strings.Contains(snapshotBody(t, f, qa, f.guide), "Rewritten for v2") {
		t.Error("QA didn't pick up the reviewed edit")
	}
	if strings.Contains(snapshotBody(t, f, prod, f.guide), "Rewritten for v2") {
		t.Error("PROD picked up an edit that's only in review")
	}

	// Publish changes reaches PROD.
	move(t, f, f.guide, "Published")
	build(t, f)
	if _, body, _ := get(t, pub, "docs.example.test", "/getting-started/"); !strings.Contains(body, "Rewritten for v2") {
		t.Fatal("published edit missing from PROD")
	}

	// Archive withdraws it from both, and the home page's children list
	// loses it on the next build.
	move(t, f, f.guide, "Archived")
	build(t, f)
	if n := pubCount(t, f, qa) + pubCount(t, f, prod); n != 2 {
		t.Fatalf("after archive: %d publications, want 2 (Home on QA + PROD)", n)
	}
	if code, _, _ := get(t, pub, "docs.example.test", "/getting-started/"); code != 404 {
		t.Errorf("archived page still served: %d", code)
	}

	// portal.list reports the build and who publishes to each portal.
	var list portal.ListOutput
	decode(t, call(f, sysCtx(), "portal", "list", `{}`), &list)
	byTitle := map[string]portal.Row{}
	for _, r := range list.Rows {
		byTitle[r.Title] = r
	}
	if r := byTitle["Docs"]; r.PageCount != 1 || r.Dirty || !r.Public || len(r.Statuses) != 1 || r.Statuses[0] != "Docs › Published" {
		t.Errorf("PROD row = %+v", r)
	}
	if r := byTitle["Docs QA"]; len(r.Statuses) != 2 {
		t.Errorf("QA row statuses = %v", r.Statuses)
	}
}

// TestPreviewRoute serves a non-public portal to a signed-in user under
// the app's router, sandboxed, and refuses a user who can't see its root.
func TestPreviewRoute(t *testing.T) {
	f := setup(t, "kitp_test_portal_preview")
	qa := newPortal(t, f, fmt.Sprintf(`{"title":"QA","root_page_id":"%d"}`, f.home))
	setAttr(t, f, f.status["In review"], "publishes_to", []string{fmt.Sprint(qa)})
	move(t, f, f.home, "In review")
	move(t, f, f.guide, "In review")
	build(t, f)

	var stranger int64
	if err := f.sp.P.QueryRow(context.Background(),
		`INSERT INTO user_account (display_name, email) VALUES ('Stranger', 's@example.test') RETURNING id`).Scan(&stranger); err != nil {
		t.Fatal(err)
	}
	user := int64(1) // System: global roles
	rt := api.NewRouter(api.RouterConfig{
		SessionResolver: func(*http.Request) (*auth.UserCtx, error) { return &auth.UserCtx{ID: user}, nil },
	})
	f.server.Mount(rt)
	mux := rt.Mux()

	base := fmt.Sprintf("/api/v1/portal/%d/preview", qa)
	if code, _, hdr := get(t, mux, "app.example.test", base); code != http.StatusMovedPermanently || hdr.Get("Location") != base+"/" {
		t.Errorf("bare preview: %d → %q", code, hdr.Get("Location"))
	}
	code, body, hdr := get(t, mux, "app.example.test", base+"/getting-started/")
	if code != 200 || !strings.Contains(body, "<h1>Getting started</h1>") {
		t.Fatalf("preview page: %d %s", code, body)
	}
	if csp := hdr.Get("Content-Security-Policy"); !strings.HasPrefix(csp, "sandbox allow-same-origin") ||
		strings.Contains(csp, "allow-scripts") || !strings.Contains(csp, "frame-ancestors 'none'") {
		t.Errorf("preview CSP = %q, want a script-less same-origin sandbox", csp)
	}
	if code, _, hdr := get(t, mux, "app.example.test", base+"/getting-started"); code != http.StatusMovedPermanently ||
		hdr.Get("Location") != base+"/getting-started/" {
		t.Errorf("preview slashless: %d → %q", code, hdr.Get("Location"))
	}

	user = stranger
	if code, _, _ := get(t, mux, "app.example.test", base+"/"); code != http.StatusNotFound {
		t.Errorf("stranger preview: %d, want 404", code)
	}
}

// TestBuildAtomicAndPruned: a change landing mid-build keeps the portal
// dirty; old builds beyond Keep are pruned and their files go with them.
func TestBuildAtomicAndPruned(t *testing.T) {
	f := setup(t, "kitp_test_portal_builds")
	p := newPortal(t, f, fmt.Sprintf(`{"title":"P","root_page_id":"%d","public":true,"host":"p.example.test"}`, f.home))
	setAttr(t, f, f.status["Published"], "publishes_to", []string{fmt.Sprint(p)})
	move(t, f, f.home, "Published")

	ctx := context.Background()
	var since time.Time
	if err := f.sp.P.QueryRow(ctx, `SELECT dirty_since FROM portal_state WHERE portal_id = $1`, p).Scan(&since); err != nil {
		t.Fatal(err)
	}
	// A publish lands after the builder read dirty_since…
	move(t, f, f.home, "Published")
	if _, err := f.builder.Build(ctx, p, since); err != nil {
		t.Fatal(err)
	}
	var stillDirty bool
	if err := f.sp.P.QueryRow(ctx, `SELECT dirty_since IS NOT NULL FROM portal_state WHERE portal_id = $1`, p).Scan(&stillDirty); err != nil {
		t.Fatal(err)
	}
	if !stillDirty {
		t.Fatal("a change made during the build was lost: portal is clean")
	}

	f.builder.Keep = 2
	for range 4 {
		if sr := call(f, sysCtx(), "portal", "rebuild", fmt.Sprintf(`{"id":"%d"}`, p)); !sr.OK {
			t.Fatalf("rebuild: %+v", sr.Error)
		}
		build(t, f)
	}
	var builds, orphanFiles int64
	if err := f.sp.P.QueryRow(ctx, `SELECT count(*) FROM portal_build WHERE portal_id = $1`, p).Scan(&builds); err != nil {
		t.Fatal(err)
	}
	if builds != 2 {
		t.Errorf("builds kept = %d, want 2", builds)
	}
	if err := f.sp.P.QueryRow(ctx, `
		SELECT count(*) FROM portal_build_file f
		WHERE NOT EXISTS (SELECT 1 FROM portal_build b WHERE b.id = f.build_id)`).Scan(&orphanFiles); err != nil {
		t.Fatal(err)
	}
	if orphanFiles != 0 {
		t.Errorf("%d files outlived their build", orphanFiles)
	}
}

// bundleHome is the publishing bundle's own starter "Home" page: it lives
// in the hidden source project, a template, and must never be a root.
func bundleHome(t *testing.T, f fixture) int64 {
	t.Helper()
	var id int64
	err := f.sp.P.QueryRow(context.Background(), `
		SELECT c.id FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'page'
		JOIN attribute_value av ON av.card_id = c.id AND av.value = to_jsonb('Home'::text)
		JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'title'
		JOIN bundle b ON b.source_project_id = card_enclosing_project(c.id)
		WHERE b.key = 'publishing'`).Scan(&id)
	if err != nil {
		t.Fatalf("bundle home: %v", err)
	}
	return id
}

// TestRootPages: the root-page picker offers the project's pages labelled
// with project and path, and never the bundle source's same-named pages.
func TestRootPages(t *testing.T) {
	f := setup(t, "kitp_test_portal_roots")
	var out portal.RootPagesOutput
	decode(t, call(f, sysCtx(), "portal", "root_pages", `{}`), &out)
	got := map[int64]string{}
	for _, r := range out.Rows {
		got[r.ID] = r.Label
		if r.ProjectID != f.project {
			t.Errorf("row %+v: project = %d, want %d", r, r.ProjectID, f.project)
		}
	}
	want := map[int64]string{f.home: "Docs › Home", f.guide: "Docs › Home › Getting started"}
	if len(got) != len(want) || got[f.home] != want[f.home] || got[f.guide] != want[f.guide] {
		t.Errorf("root pages = %v, want %v", got, want)
	}
	if _, ok := got[bundleHome(t, f)]; ok {
		t.Error("the bundle source's Home is offered as a root")
	}
}

// TestRootWarningNamesThePage: a portal whose root isn't published names
// that page (and its project) in the build warning, and portal.list labels
// the root with its project.
func TestRootWarningNamesThePage(t *testing.T) {
	f := setup(t, "kitp_test_portal_rootwarn")
	newPortal(t, f, fmt.Sprintf(`{"title":"Docs","root_page_id":"%d"}`, f.home))
	build(t, f)
	var list portal.ListOutput
	decode(t, call(f, sysCtx(), "portal", "list", `{}`), &list)
	if len(list.Rows) != 1 {
		t.Fatalf("rows = %+v", list.Rows)
	}
	r := list.Rows[0]
	if r.RootLabel != "Docs › Home" {
		t.Errorf("root label = %q", r.RootLabel)
	}
	want := `The root page, "Home" in "Docs", isn't published to this portal yet.`
	if len(r.Warnings) != 1 || r.Warnings[0] != want {
		t.Errorf("warnings = %q, want [%q]", r.Warnings, want)
	}
}

// TestPortalSetRejects is portal.set's validation table.
func TestPortalSetRejects(t *testing.T) {
	f := setup(t, "kitp_test_portal_set")
	newPortal(t, f, `{"title":"A","host":"a.example.test"}`)
	cases := []struct {
		name, data, code string
	}{
		{"no title on create", `{"host":"b.example.test"}`, "validation"},
		{"blank title", `{"title":"  "}`, "validation"},
		{"bad host", `{"title":"B","host":"https://b.example.test/x"}`, "validation"},
		{"host taken", `{"title":"B","host":"A.EXAMPLE.TEST"}`, "host_taken"},
		{"root not a page", fmt.Sprintf(`{"title":"B","root_page_id":"%d"}`, f.project), "validation"},
		{"root in a template", fmt.Sprintf(`{"title":"B","root_page_id":"%d"}`, bundleHome(t, f)), "root_in_template"},
		{"unknown portal", `{"id":"999999","title":"B"}`, "portal_not_found"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			sr := call(f, sysCtx(), "portal", "set", c.data)
			if sr.OK || sr.Error == nil || sr.Error.Code != c.code {
				t.Fatalf("want %s; got ok=%v %+v", c.code, sr.OK, sr.Error)
			}
		})
	}
}

func pubCount(t *testing.T, f fixture, portalID int64) int64 {
	t.Helper()
	var n int64
	if err := f.sp.P.QueryRow(context.Background(),
		`SELECT count(*) FROM publication WHERE portal_id = $1`, portalID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func snapshotBody(t *testing.T, f fixture, portalID, page int64) string {
	t.Helper()
	var body string
	if err := f.sp.P.QueryRow(context.Background(),
		`SELECT body FROM publication WHERE portal_id = $1 AND card_id = $2`, portalID, page).Scan(&body); err != nil {
		t.Fatal(err)
	}
	return body
}

func fail(t *testing.T, sr api.SubResponse, code, msgPart string) {
	t.Helper()
	if sr.OK || sr.Error == nil || sr.Error.Code != code || !strings.Contains(sr.Error.Message, msgPart) {
		t.Errorf("want error %s (%q); got ok=%v %+v", code, msgPart, sr.OK, sr.Error)
	}
}

// TestThemes walks a theme from the built-in list to a live site: list
// the bases and read one's files, create a theme on Newspaper, put a
// portal on it (and in kitp), add custom.css and a logo, refuse a broken
// template, and check the PROD site and the in-kitp route.
func TestThemes(t *testing.T) {
	f := setup(t, "kitp_test_portal_themes")

	var bases portal.ThemeBasesOutput
	decode(t, call(f, sysCtx(), "theme", "bases", `{}`), &bases)
	var keys []string
	for _, b := range bases.Rows {
		keys = append(keys, b.Key)
	}
	if strings.Join(keys, ",") != "sidebar,topbar,newspaper,book,helpcenter,blog,reference" {
		t.Fatalf("bases = %v", keys)
	}
	var baseFile portal.ThemeFileContent
	decode(t, call(f, sysCtx(), "theme", "base_file", `{"key":"newspaper","path":"page.html"}`), &baseFile)
	if !baseFile.IsText || !strings.Contains(baseFile.Text, "Newspaper") {
		t.Errorf("newspaper page.html = %+v", baseFile)
	}
	fail(t, call(f, sysCtx(), "theme", "base_file", `{"key":"nope","path":"page.html"}`), "theme_not_found", "nope")

	fail(t, call(f, sysCtx(), "theme", "set", `{"title":"X","base":"tabloid"}`), "bad_base", "tabloid")
	fail(t, call(f, sysCtx(), "theme", "set", `{"title":"X","base":"blog","accent":"red"}`), "bad_accent", "red")
	fail(t, call(f, sysCtx(), "theme", "set", `{"title":"X","base":"blog","nav":"sideways"}`), "validation", "sideways")
	fail(t, call(f, sysCtx(), "theme", "set", `{"title":"X"}`), "validation", "base theme")
	var ts portal.ThemeSetOutput
	decode(t, call(f, sysCtx(), "theme", "set", `{"title":"Paper","base":"newspaper","accent":"#AA0000","footer":"© **Docs**"}`), &ts)
	theme := ts.ID

	prod := newPortal(t, f, fmt.Sprintf(`{"title":"Docs","root_page_id":"%d","host":"docs.example.test","public":true,"theme_id":"%d","internal":true}`, f.home, theme))
	fail(t, call(f, sysCtx(), "portal", "set", fmt.Sprintf(`{"id":"%d","theme_id":"%d"}`, prod, f.home)), "theme_not_found", "not a theme")
	var list portal.ListOutput
	decode(t, call(f, sysCtx(), "portal", "list", `{}`), &list)
	if len(list.Rows) != 1 || list.Rows[0].ThemeID != theme || list.Rows[0].ThemeTitle != "Paper" || !list.Rows[0].Internal {
		t.Errorf("portal row = %+v", list.Rows)
	}

	put := func(data string) api.SubResponse {
		return call(f, sysCtx(), "theme", "file_put", data)
	}
	var fp portal.ThemeFilePutOutput
	decode(t, put(fmt.Sprintf(`{"theme_id":"%d","path":"custom.css","text":".story h2 { color: teal; }"}`, theme)), &fp)
	if !fp.Changed || fp.SizeBytes != 26 {
		t.Errorf("custom.css put = %+v", fp)
	}
	decode(t, put(fmt.Sprintf(`{"theme_id":"%d","path":"custom.css","text":".story h2 { color: teal; }"}`, theme)), &fp)
	if fp.Changed {
		t.Error("putting the same bytes again reported a change")
	}
	decode(t, put(fmt.Sprintf(`{"theme_id":"%d","path":"logo.png","content_base64":"iVBORw0KGgo="}`, theme)), &fp)
	fail(t, put(fmt.Sprintf(`{"theme_id":"%d","path":"page.html","text":"<p>{{if .Page.Title}}oops</p>"}`, theme)), "template_error", "page.html:1")
	fail(t, put(fmt.Sprintf(`{"theme_id":"%d","path":"page.html","text":"<p>{{.Page.Nope}}</p>"}`, theme)), "template_error", "Nope")
	fail(t, put(fmt.Sprintf(`{"theme_id":"%d","path":"app.js","text":"alert(1)"}`, theme)), "bad_path", ".js")
	fail(t, put(fmt.Sprintf(`{"theme_id":"%d","path":"theme.json","text":"{\"order\":\"random\"}"}`, theme)), "template_error", "random")

	var got portal.ThemeFileContent
	decode(t, call(f, sysCtx(), "theme", "file_get", fmt.Sprintf(`{"theme_id":"%d","path":"custom.css"}`, theme)), &got)
	if !got.IsText || got.Text != ".story h2 { color: teal; }" || got.CASAddress != "" {
		t.Errorf("file_get = %+v", got)
	}
	var themes portal.ThemeListOutput
	decode(t, call(f, sysCtx(), "theme", "list", `{}`), &themes)
	if len(themes.Rows) != 1 || len(themes.Rows[0].Files) != 2 || themes.Rows[0].Files[0].Path != "custom.css" ||
		strings.Join(themes.Rows[0].Portals, ",") != "Docs" || themes.Rows[0].Accent != "#aa0000" {
		t.Errorf("theme.list = %+v", themes.Rows)
	}

	setAttr(t, f, f.status["Published"], "publishes_to", []string{fmt.Sprint(prod)})
	move(t, f, f.home, "Published")
	move(t, f, f.guide, "Published")
	build(t, f)
	pub := f.server.PublicHandler()
	if _, body, _ := get(t, pub, "docs.example.test", "/"); !strings.Contains(body, `class="masthead"`) ||
		!strings.Contains(body, `<img src="_theme/logo.png"`) || !strings.Contains(body, "© <strong>Docs</strong>") {
		t.Errorf("PROD home isn't the Newspaper theme with the logo and footer: %s", body)
	}
	if _, css, _ := get(t, pub, "docs.example.test", "/_theme/custom.css"); !strings.Contains(css, ":root { --accent: #aa0000; }\n.story h2 { color: teal; }") {
		t.Errorf("custom.css = %s", css)
	}
	if code, _, hdr := get(t, pub, "docs.example.test", "/_theme/logo.png"); code != 200 || hdr.Get("Content-Type") != "image/png" {
		t.Errorf("logo: %d %v", code, hdr)
	}
	// Theme files keep their paths across theme changes, so browsers must
	// revalidate them (a cheap 304 by ETag) rather than reuse a stale copy.
	for _, p := range []string{"/_theme/site.css", "/_theme/custom.css", "/_theme/logo.png"} {
		if _, _, hdr := get(t, pub, "docs.example.test", p); hdr.Get("Cache-Control") != "no-cache" || hdr.Get("ETag") == "" {
			t.Errorf("%s: Cache-Control %q, ETag %q; want no-cache with an ETag", p, hdr.Get("Cache-Control"), hdr.Get("ETag"))
		}
	}

	// A theme change rebuilds the portals using it.
	decode(t, call(f, sysCtx(), "theme", "set", fmt.Sprintf(`{"id":"%d","base":"book"}`, theme)), &ts)
	build(t, f)
	if _, body, _ := get(t, pub, "docs.example.test", "/"); !strings.Contains(body, `class="toc-full"`) {
		t.Errorf("after switching to Book, the home page lacks its contents: %s", body)
	}
	var del portal.ThemeFileDeleteOutput
	decode(t, call(f, sysCtx(), "theme", "file_delete", fmt.Sprintf(`{"theme_id":"%d","path":"logo.png"}`, theme)), &del)
	if !del.Deleted {
		t.Error("logo.png wasn't deleted")
	}
	build(t, f)
	if _, body, _ := get(t, pub, "docs.example.test", "/"); strings.Contains(body, "logo.png") {
		t.Error("the logo is still on the site after deleting it")
	}

	// Show in kitp: the site route frames the build under a sandbox; a
	// portal with Show in kitp off isn't served there.
	rt := api.NewRouter(api.RouterConfig{
		SessionResolver: func(*http.Request) (*auth.UserCtx, error) { return &auth.UserCtx{ID: 1}, nil },
	})
	f.server.Mount(rt)
	mux := rt.Mux()
	site := fmt.Sprintf("/api/v1/portal/%d/site/", prod)
	code, body, hdr := get(t, mux, "app.example.test", site+"getting-started/")
	if code != 200 || !strings.Contains(body, "Getting started") {
		t.Fatalf("in-kitp page: %d %s", code, body)
	}
	// Sandboxed without scripts, but same-origin: the page's own stylesheet
	// and link requests must carry the SameSite=Lax session cookie.
	if csp := hdr.Get("Content-Security-Policy"); !strings.HasPrefix(csp, "sandbox allow-same-origin allow-popups") ||
		strings.Contains(csp, "allow-scripts") || strings.Contains(csp, "script-src") || !strings.Contains(csp, "frame-ancestors 'self'") {
		t.Errorf("in-kitp CSP = %q", csp)
	}
	decode(t, call(f, sysCtx(), "portal", "set", fmt.Sprintf(`{"id":"%d","internal":false}`, prod)), &portal.SetOutput{})
	if code, _, _ := get(t, mux, "app.example.test", site); code != http.StatusNotFound {
		t.Errorf("Show in kitp off: %d, want 404", code)
	}
}

// TestNavFlagsArePublished: Hide from navigation is part of the snapshot,
// so it reaches the site only when the page is published again.
func TestNavFlagsArePublished(t *testing.T) {
	f := setup(t, "kitp_test_portal_navflags")
	prod := newPortal(t, f, fmt.Sprintf(`{"title":"Docs","root_page_id":"%d","host":"docs.example.test","public":true}`, f.home))
	setAttr(t, f, f.status["Published"], "publishes_to", []string{fmt.Sprint(prod)})
	move(t, f, f.home, "Published")
	move(t, f, f.guide, "Published")
	build(t, f)
	pub := f.server.PublicHandler()
	navOf := func() string {
		_, body, _ := get(t, pub, "docs.example.test", "/")
		return body[strings.Index(body, `<nav class="site-nav"`):strings.Index(body, "</nav>")]
	}
	if !strings.Contains(navOf(), "getting-started/") {
		t.Fatal("Getting started isn't in the navigation")
	}
	setAttr(t, f, f.guide, "nav_hidden", true)
	build(t, f)
	if !strings.Contains(navOf(), "getting-started/") {
		t.Error("hiding a live page changed the site before it was published again")
	}
	move(t, f, f.guide, "In review")
	move(t, f, f.guide, "Published")
	build(t, f)
	if strings.Contains(navOf(), "getting-started/") {
		t.Error("a page hidden from navigation is still in the navigation")
	}
	if code, _, _ := get(t, pub, "docs.example.test", "/getting-started/"); code != 200 {
		t.Errorf("a page hidden from navigation isn't published: %d", code)
	}
}

// TestUnpublish: a page that enters Draft (triage: not live) comes off
// every portal its status doesn't publish to — "Unpublish", "Back to
// draft" — while a live status (In review) leaves the other portals
// pinned, and Archived takes it off everything.
func TestUnpublish(t *testing.T) {
	f := setup(t, "kitp_test_portal_unpublish")
	qa := newPortal(t, f, fmt.Sprintf(`{"title":"QA","root_page_id":"%d"}`, f.home))
	prod := newPortal(t, f, fmt.Sprintf(`{"title":"PROD","root_page_id":"%d","host":"docs.example.test","public":true}`, f.home))
	setAttr(t, f, f.status["In review"], "publishes_to", []string{fmt.Sprint(qa)})
	setAttr(t, f, f.status["Published"], "publishes_to", []string{fmt.Sprint(qa), fmt.Sprint(prod)})
	on := func(page int64) string {
		var got []string
		for _, p := range []struct {
			name string
			id   int64
		}{{"QA", qa}, {"PROD", prod}} {
			var n int
			if err := f.sp.P.QueryRow(context.Background(),
				`SELECT count(*) FROM publication WHERE portal_id = $1 AND card_id = $2`, p.id, page).Scan(&n); err != nil {
				t.Fatal(err)
			}
			if n > 0 {
				got = append(got, p.name)
			}
		}
		return strings.Join(got, "+")
	}
	move(t, f, f.home, "Published")
	move(t, f, f.guide, "Published")
	if on(f.guide) != "QA+PROD" {
		t.Fatalf("published guide is on %q", on(f.guide))
	}

	move(t, f, f.guide, "Draft") // the flow's "Unpublish"
	if got := on(f.guide); got != "" {
		t.Errorf("after Unpublish the guide is still on %q", got)
	}
	build(t, f)
	if code, _, _ := get(t, f.server.PublicHandler(), "docs.example.test", "/getting-started/"); code != http.StatusNotFound {
		t.Errorf("an unpublished page is still served: %d", code)
	}

	move(t, f, f.home, "In review") // live: PROD keeps its copy
	if got := on(f.home); got != "QA+PROD" {
		t.Errorf("sending a live page to review left it on %q, want QA+PROD", got)
	}
	move(t, f, f.home, "Draft") // "Back to draft"
	if got := on(f.home); got != "" {
		t.Errorf("back to draft left it on %q", got)
	}

	// A draft status may still publish somewhere (a draft-preview portal):
	// it publishes there and comes off the rest.
	move(t, f, f.guide, "Published")
	setAttr(t, f, f.status["Draft"], "publishes_to", []string{fmt.Sprint(qa)})
	move(t, f, f.guide, "Draft")
	if got := on(f.guide); got != "QA" {
		t.Errorf("a draft status that publishes to QA left the guide on %q, want QA", got)
	}
	move(t, f, f.guide, "Archived")
	if got := on(f.guide); got != "" {
		t.Errorf("archived guide still on %q", got)
	}
}
