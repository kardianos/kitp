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
	portal.Register(sp)
	storage := cas.New(cas.NewPgBackend(pool))
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
	if !strings.Contains(hdr.Get("Content-Security-Policy"), "default-src 'none'") || hdr.Get("ETag") == "" {
		t.Errorf("PROD headers: %v", hdr)
	}
	if code, _, hdr := get(t, pub, "docs.example.test", "/getting-started"); code != http.StatusMovedPermanently || hdr.Get("Location") != "/getting-started/" {
		t.Errorf("slashless page: %d → %q, want 301 to /getting-started/", code, hdr.Get("Location"))
	}
	if code, body, _ := get(t, pub, "docs.example.test", "/getting-started/"); code != 200 || !strings.Contains(body, `href="../site.css"`) {
		t.Errorf("PROD child page: %d", code)
	}
	if code, body, _ := get(t, pub, "docs.example.test", "/nope/"); code != 404 || !strings.Contains(body, `href="/site.css"`) {
		t.Errorf("PROD 404: %d, links rooted? %v", code, strings.Contains(body, `href="/site.css"`))
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
	if !strings.HasPrefix(hdr.Get("Content-Security-Policy"), "sandbox") {
		t.Errorf("preview CSP = %q, want sandbox", hdr.Get("Content-Security-Policy"))
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
