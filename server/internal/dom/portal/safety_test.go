package portal

// Review fixes, area 5 (docs/REVIEW_FIXES.md): theme template safety and
// the page size cap (A20), published attachment types (A19), what a failed
// build records (A17) and one builder per portal (A28).

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/store"
)

func TestTemplateSafety(t *testing.T) {
	page := func(body string) map[string][]byte {
		return map[string][]byte{"page.html": []byte(`<html><body>` + body + `</body></html>`)}
	}
	for _, c := range []struct{ name, body, want string }{
		{"script", `<script>alert(1)</script>`, "<script>"},
		{"script with space", `< SCRIPT src="x.js"></script>`, "<script>"},
		{"handler", `<img src="x.png" onerror="alert(1)">`, "event handlers"},
		{"javascript url", `<a href="javascript:alert(1)">x</a>`, "javascript:"},
		{"huge range", `{{range 1000000000}}x{{end}}`, "{{range}}"},
		{"huge range in an if", `{{if true}}{{range $i := 99999}}x{{end}}{{end}}`, "{{range}}"},
	} {
		t.Run(c.name, func(t *testing.T) {
			_, err := parseTemplates(page(c.body))
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Errorf("parseTemplates = %v, want an error naming %q", err, c.want)
			}
		})
	}
	if _, err := parseTemplates(page(`{{range 10}}x{{end}}<a href="{{.Page.URL}}">ok</a>`)); err != nil {
		t.Errorf("a small range and an ordinary link: %v", err)
	}
}

func TestPageSizeCap(t *testing.T) {
	w := &capWriter{max: 10}
	if _, err := w.Write([]byte("12345")); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("123456")); err == nil {
		t.Error("writing past the cap should fail")
	}
}

func TestPublishedMIME(t *testing.T) {
	for in, want := range map[string]string{
		"image/png":                "image/png",
		"IMAGE/JPEG; charset=x":    "image/jpeg",
		"application/pdf":          "application/pdf",
		"text/html":                "application/octet-stream",
		"image/svg+xml":            "application/octet-stream",
		"application/x-javascript": "application/octet-stream",
		"":                         "application/octet-stream",
	} {
		if got := PublishedMIME(in); got != want {
			t.Errorf("PublishedMIME(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestBuildErrorsAndLock: portal.list shows a theme's own template problem
// as it is and anything else as a pointer to the log (A17); one builder
// per portal at a time (A28).
func TestBuildErrorsAndLock(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_portal_errors_lock")
	ctx := context.Background()
	b := &Builder{Pool: pool, Storage: cas.New(cas.NewPgBackend(pool))}
	var portalID int64
	if err := pool.QueryRow(ctx, `INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'portal' RETURNING id`).Scan(&portalID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO portal_state (portal_id) VALUES ($1)`, portalID); err != nil {
		t.Fatal(err)
	}
	lastError := func() (string, int) {
		var msg string
		var n int
		if err := pool.QueryRow(ctx, `SELECT COALESCE(last_error, ''), fail_count FROM portal_state WHERE portal_id = $1`, portalID).Scan(&msg, &n); err != nil {
			t.Fatal(err)
		}
		return msg, n
	}
	// A try is counted before the build (markAttempt); recordError says
	// what went wrong.
	if err := b.markAttempt(ctx, portalID); err != nil {
		t.Fatal(err)
	}
	if err := b.recordError(ctx, portalID, errors.New(`insert files: ERROR: duplicate key value violates "portal_build_file_pkey"`)); err != nil {
		t.Fatal(err)
	}
	if msg, n := lastError(); strings.Contains(msg, "pkey") || !strings.Contains(msg, "server log") || n != 1 {
		t.Errorf("an internal error recorded as %q (fail_count %d)", msg, n)
	}
	if err := b.markAttempt(ctx, portalID); err != nil {
		t.Fatal(err)
	}
	if err := b.recordError(ctx, portalID, &TemplateProblem{errors.New("page.html:3: unexpected EOF")}); err != nil {
		t.Fatal(err)
	}
	if msg, n := lastError(); msg != "page.html:3: unexpected EOF" || n != 2 {
		t.Errorf("a template problem recorded as %q (fail_count %d)", msg, n)
	}

	release, ok, err := b.lockPortal(ctx, portalID)
	if err != nil || !ok {
		t.Fatalf("first lock: %v %v", ok, err)
	}
	if _, ok2, err := b.lockPortal(ctx, portalID); err != nil || ok2 {
		t.Errorf("a second builder got the lock (%v, %v)", ok2, err)
	}
	release()
	release2, ok3, err := b.lockPortal(ctx, portalID)
	if err != nil || !ok3 {
		t.Errorf("after release: %v %v", ok3, err)
	} else {
		release2()
	}
}

// TestAutolinksOpenANewTab: a bare URL in the text opens in a new tab like
// any link to another site (inside the kitp frame it would otherwise
// navigate the frame).
func TestAutolinksOpenANewTab(t *testing.T) {
	res, err := Render(context.Background(), Site{Title: "Links", RootID: 1, Pages: []Page{
		{ID: 1, Title: "Home", Body: "See https://example.com/docs for more."},
	}})
	if err != nil {
		t.Fatal(err)
	}
	got := files(t, res)["index.html"]
	if !strings.Contains(got, `<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">https://example.com/docs</a>`) {
		t.Errorf("autolink:\n%s", got)
	}
}

// TestUnplacedPagesLendNoFiles (A6): an attachment on a page published to
// the portal but not placed in its tree isn't published from a placed
// page's body.
func TestUnplacedPagesLendNoFiles(t *testing.T) {
	res, err := Render(context.Background(), Site{Title: "Files", RootID: 1, Pages: []Page{
		{ID: 1, Title: "Home", Body: "![Elsewhere](attachment:9)"},
		{ID: 5, Title: "Not placed", Body: "x"}, // no parent under the root
	}, Files: map[int64]SiteFile{9: {ID: 9, CardID: 5, Name: "secret.png", MIME: "image/png", Size: 10}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Attachments) != 0 {
		t.Errorf("an unplaced page's attachment was published: %+v", res.Attachments)
	}
}
