package portal_test

// Review fixes, area 5 (docs/REVIEW_FIXES.md): serving re-checks pages
// (A7), publishes_to (A6), build backoff (A7), caching (A18) and
// attachment headers (A19).

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/bundle"
)

// publicSite publishes Home and Getting started to a public portal and
// builds it.
func publicSite(t *testing.T, f fixture) (int64, http.Handler) {
	t.Helper()
	prod := newPortal(t, f, fmt.Sprintf(`{"title":"PROD","root_page_id":"%d","public":true,"host":"docs.example.test"}`, f.home))
	setAttr(t, f, f.status["Published"], "publishes_to", []string{fmt.Sprint(prod)})
	move(t, f, f.home, "Published")
	move(t, f, f.guide, "Published")
	build(t, f)
	return prod, f.server.PublicHandler()
}

// TestServingRechecksPages (A7): a page withdrawn from a portal, or in an
// area switched off, is gone from the site at once — not at the next
// successful build.
func TestServingRechecksPages(t *testing.T) {
	f := setup(t, "kitp_test_portal_recheck")
	prod, pub := publicSite(t, f)
	ctx := context.Background()
	if code, _, _ := get(t, pub, "docs.example.test", "/getting-started/"); code != 200 {
		t.Fatalf("published page: %d", code)
	}
	// Withdrawn, and the rebuild hasn't happened (or keeps failing).
	if _, err := f.sp.P.Exec(ctx, `DELETE FROM publication WHERE portal_id = $1 AND card_id = $2`, prod, f.guide); err != nil {
		t.Fatal(err)
	}
	if code, _, _ := get(t, pub, "docs.example.test", "/getting-started/"); code != http.StatusNotFound {
		t.Errorf("a withdrawn page is still served: %d", code)
	}
	if code, _, _ := get(t, pub, "docs.example.test", "/"); code != 200 {
		t.Errorf("the home page, still published: %d", code)
	}
	// Content switched off: nothing of it is served.
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO project_area (project_id, area_key, state) VALUES ($1, 'content', 'off')`, f.project); err != nil {
		t.Fatal(err)
	}
	if code, _, _ := get(t, pub, "docs.example.test", "/"); code != http.StatusNotFound {
		t.Errorf("a page of a switched-off Content is still served: %d", code)
	}
}

// TestPublishesToRules (A6): only a workspace admin chooses where a status
// publishes, and a status never sends pages to a portal rooted in another
// project.
func TestPublishesToRules(t *testing.T) {
	f := setup(t, "kitp_test_portal_publishes_to")
	ctx := context.Background()
	var other bundle.ComposeOutput
	decode(t, call(f, sysCtx(), "project", "compose", `{"name":"Other","features":["publishing"]}`), &other)
	var otherHome int64
	if err := f.sp.P.QueryRow(ctx, `
		SELECT c.id FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'page'
		JOIN attribute_value av ON av.card_id = c.id AND av.value = to_jsonb('Home'::text)
		JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'title'
		WHERE card_enclosing_project(c.id) = $1`, other.NewProjectID).Scan(&otherHome); err != nil {
		t.Fatal(err)
	}
	theirs := newPortal(t, f, fmt.Sprintf(`{"title":"Theirs","root_page_id":"%d"}`, otherHome))

	// A project manager: refused.
	var mgr int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ('mgr') RETURNING id`).Scan(&mgr); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name IN ('worker', 'manager')`, mgr, f.project); err != nil {
		t.Fatal(err)
	}
	r := call(f, auth.WithUser(ctx, &auth.UserCtx{ID: mgr, DisplayName: "mgr"}), "attribute", "update",
		fmt.Sprintf(`{"card_id":"%d","attribute_name":"publishes_to","value":["%d"]}`, f.status["In review"], theirs))
	if r.OK || r.Error == nil || r.Error.Code != "forbidden" {
		t.Errorf("a manager set publishes_to: %+v", r.Error)
	}

	// The admin can point a status at another project's portal, but no
	// page of this project goes there.
	setAttr(t, f, f.status["In review"], "publishes_to", []string{fmt.Sprint(theirs)})
	move(t, f, f.home, "In review")
	if n := pubCount(t, f, theirs); n != 0 {
		t.Errorf("%d pages of this project were published to another project's portal", n)
	}
}

// TestBuildBackoff (A7): a portal whose build failed waits before the next
// try, and builds again once the wait is over.
func TestBuildBackoff(t *testing.T) {
	f := setup(t, "kitp_test_portal_backoff")
	prod, _ := publicSite(t, f)
	ctx := context.Background()
	active := func() int64 {
		var id int64
		if err := f.sp.P.QueryRow(ctx, `SELECT COALESCE(active_build_id, 0) FROM portal_state WHERE portal_id = $1`, prod).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	before := active()
	if _, err := f.sp.P.Exec(ctx, `UPDATE portal_state SET dirty_since = now(), fail_count = 3, failed_at = now() WHERE portal_id = $1`, prod); err != nil {
		t.Fatal(err)
	}
	if err := f.builder.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if active() != before {
		t.Error("a portal that just failed was rebuilt without waiting")
	}
	if _, err := f.sp.P.Exec(ctx, `UPDATE portal_state SET failed_at = now() - interval '2 hours' WHERE portal_id = $1`, prod); err != nil {
		t.Fatal(err)
	}
	build(t, f)
	if active() == before {
		t.Error("the portal didn't build once its wait was over")
	}
	var fails int
	if err := f.sp.P.QueryRow(ctx, `SELECT fail_count FROM portal_state WHERE portal_id = $1`, prod).Scan(&fails); err != nil || fails != 0 {
		t.Errorf("fail_count after a good build = %d (%v), want 0", fails, err)
	}
}

// TestFileHeaders (A18, A19): an attachment file is sandboxed, one of a
// type a build doesn't serve as itself is a download, and the signed-in
// routes mark files private.
func TestFileHeaders(t *testing.T) {
	f := setup(t, "kitp_test_portal_file_headers")
	prod, pub := publicSite(t, f)
	ctx := context.Background()
	addr, err := f.storage.Put(ctx, "application/octet-stream", []byte("<script>alert(1)</script>"))
	if err != nil {
		t.Fatal(err)
	}
	// A real (live) attachment: a _files/<id>/ path is served only while
	// its attachment is (review 2026-11-03 #17).
	var att int64
	if err := f.sp.P.QueryRow(ctx, `
		WITH fl AS (INSERT INTO file (filename, size_bytes, mime_type, created_by)
		            VALUES ('evil.html', 26, 'application/octet-stream', 1) RETURNING id)
		INSERT INTO attachment (card_id, file_id) SELECT $1, id FROM fl RETURNING id`, f.home).Scan(&att); err != nil {
		t.Fatal(err)
	}
	filePath := fmt.Sprintf("_files/%d/evil.html", att)
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO portal_build_file (build_id, path, cas_address, mime_type, size_bytes, card_id)
		SELECT active_build_id, $4, $2, 'application/octet-stream', 26, $3
		FROM portal_state WHERE portal_id = $1`, prod, addr, f.home, filePath); err != nil {
		t.Fatal(err)
	}
	code, _, hdr := get(t, pub, "docs.example.test", "/"+filePath)
	if code != 200 {
		t.Fatalf("file: %d", code)
	}
	if !strings.Contains(hdr.Get("Content-Security-Policy"), "sandbox") {
		t.Errorf("file CSP = %q, want a sandbox", hdr.Get("Content-Security-Policy"))
	}
	if hdr.Get("Content-Disposition") != "attachment" {
		t.Errorf("an octet-stream file isn't a download: %q", hdr.Get("Content-Disposition"))
	}
	if hdr.Get("Cache-Control") != "public, max-age=300" {
		t.Errorf("public file Cache-Control = %q", hdr.Get("Cache-Control"))
	}

	rt := api.NewRouter(api.RouterConfig{
		SessionResolver: func(*http.Request) (*auth.UserCtx, error) { return &auth.UserCtx{ID: auth.SystemUserID}, nil },
	})
	f.server.Mount(rt)
	_, _, hdr = get(t, rt.Mux(), "app.example.test", fmt.Sprintf("/api/v1/portal/%d/preview/%s", prod, filePath))
	if hdr.Get("Cache-Control") != "private, max-age=300" {
		t.Errorf("preview file Cache-Control = %q, want private", hdr.Get("Cache-Control"))
	}
}

// TestSiteForScopedUsers (review test gap): a site shown in kitp opens for
// a member of its root page's project and not for a member of another
// project; a site not shown in kitp opens for neither.
func TestSiteForScopedUsers(t *testing.T) {
	f := setup(t, "kitp_test_portal_site_scoped")
	ctx := context.Background()
	shown := newPortal(t, f, fmt.Sprintf(`{"title":"Handbook","root_page_id":"%d","internal":true}`, f.home))
	hidden := newPortal(t, f, fmt.Sprintf(`{"title":"Docs","root_page_id":"%d"}`, f.home))
	setAttr(t, f, f.status["Published"], "publishes_to", []string{fmt.Sprint(shown), fmt.Sprint(hidden)})
	move(t, f, f.home, "Published")
	move(t, f, f.guide, "Published")
	build(t, f)

	var other int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'project' RETURNING id`).Scan(&other); err != nil {
		t.Fatal(err)
	}
	worker := func(name string, project int64) int64 {
		var id int64
		if err := f.sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name).Scan(&id); err != nil {
			t.Fatal(err)
		}
		if _, err := f.sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = 'worker'`, id, project); err != nil {
			t.Fatal(err)
		}
		return id
	}
	member, outsider := worker("member", f.project), worker("outsider", other)

	var user int64
	rt := api.NewRouter(api.RouterConfig{
		SessionResolver: func(*http.Request) (*auth.UserCtx, error) { return &auth.UserCtx{ID: user}, nil },
	})
	f.server.Mount(rt)
	for _, c := range []struct {
		name   string
		user   int64
		portal int64
		want   int
	}{
		{"a member, a site shown in kitp", member, shown, http.StatusOK},
		{"a member of another project", outsider, shown, http.StatusNotFound},
		{"a member, a site not shown in kitp", member, hidden, http.StatusNotFound},
	} {
		user = c.user
		if code, _, _ := get(t, rt.Mux(), "app.example.test", fmt.Sprintf("/api/v1/portal/%d/site/getting-started/", c.portal)); code != c.want {
			t.Errorf("%s: %d, want %d", c.name, code, c.want)
		}
	}
}
