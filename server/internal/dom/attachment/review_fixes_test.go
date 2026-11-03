package attachment_test

// Review fixes, area 6 (docs/REVIEW_FIXES.md): attachment headers (B2),
// list / create visibility (B4), file sizes (B5) and request caps (B12).

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/dom/file"
	"github.com/kitp/kitp/server/internal/store"
)

// TestViewHeaders (B2): the uploader names the type, so only a type that
// can't carry script is shown inline; everything else is a download of
// opaque bytes, and every response is nosniff and (but for PDF) sandboxed.
func TestViewHeaders(t *testing.T) {
	handler, srv, _ := setup(t, "kitp_test_attachment_view_headers")
	pid := makeProject(t, srv)
	cases := []struct {
		name, filename, mime string
		wantType             string
		wantInline, wantCSP  bool
	}{
		{"html", "x.html", "text/html", "application/octet-stream", false, true},
		{"svg", "x.svg", "image/svg+xml", "application/octet-stream", false, true},
		{"xhtml", "x.xhtml", "application/xhtml+xml", "application/octet-stream", false, true},
		{"plain text", "notes.txt", "text/plain", "text/plain", true, true},
		{"text with a charset", "notes.txt", "text/plain; charset=utf-8", "text/plain; charset=utf-8", true, true},
		{"png", "a.png", "image/png", "image/png", true, true},
		{"pdf", "a.pdf", "application/pdf", "application/pdf", true, false},
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			body := []byte(fmt.Sprintf("<script>alert(%d)</script>", i))
			att := createAttachment(t, srv, pid, c.filename, c.mime, []chunkResp{uploadChunk(t, handler, body)})
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, httptest.NewRequest("GET", fmt.Sprintf("/api/v1/attachment/%d/view", att.ID), nil))
			if rr.Code != 200 {
				t.Fatalf("view: %d %s", rr.Code, rr.Body.String())
			}
			h := rr.Header()
			if got := h.Get("Content-Type"); got != c.wantType {
				t.Errorf("Content-Type = %q, want %q", got, c.wantType)
			}
			if inline := strings.HasPrefix(h.Get("Content-Disposition"), "inline"); inline != c.wantInline {
				t.Errorf("Content-Disposition = %q, want inline %v", h.Get("Content-Disposition"), c.wantInline)
			}
			if h.Get("X-Content-Type-Options") != "nosniff" {
				t.Errorf("no nosniff: %q", h.Get("X-Content-Type-Options"))
			}
			if csp := strings.Contains(h.Get("Content-Security-Policy"), "sandbox"); csp != c.wantCSP {
				t.Errorf("Content-Security-Policy = %q, want sandbox %v", h.Get("Content-Security-Policy"), c.wantCSP)
			}
		})
	}
}

// member adds a user holding worker on one project.
func member(t *testing.T, sp *store.Pool, name string, project int64) context.Context {
	t.Helper()
	ctx := context.Background()
	var id int64
	if err := sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err := sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = 'worker'`, id, project); err != nil {
		t.Fatal(err)
	}
	return auth.WithUser(ctx, &auth.UserCtx{ID: id, DisplayName: name})
}

func dispatch(srv *api.Server, ctx context.Context, endpoint, action string, data any) api.SubResponse {
	b, err := json.Marshal(data)
	if err != nil {
		panic(err)
	}
	return srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "x", Endpoint: endpoint, Action: action, Data: b},
	}}).Subresponses[0]
}

type idRef struct {
	CardID string `json:"card_id"`
	FileID string `json:"file_id,omitempty"`
}

// TestListAndCreateNeedVisibility (B4): a member of one project can't
// list another project's attachments, nor take another project's file by
// attaching its id to a card of their own.
func TestListAndCreateNeedVisibility(t *testing.T) {
	handler, srv, sp := setup(t, "kitp_test_attachment_visibility")
	theirs := makeProject(t, srv)
	secret := createAttachment(t, srv, theirs, "secret.txt", "text/plain", []chunkResp{uploadChunk(t, handler, []byte("the secret"))})
	mine := makeProject(t, srv)
	me := member(t, sp, "worker-b4", mine)

	if r := dispatch(srv, me, "attachment", "list", idRef{CardID: fmt.Sprint(theirs)}); r.OK || r.Error == nil || r.Error.Code != "not_found" {
		t.Errorf("listed another project's attachments: ok=%v %+v", r.OK, r.Error)
	}
	if r := dispatch(srv, me, "attachment", "list", idRef{CardID: fmt.Sprint(mine)}); !r.OK {
		t.Errorf("listing my own project: %+v", r.Error)
	}
	if r := dispatch(srv, me, "attachment", "create", idRef{CardID: fmt.Sprint(mine), FileID: fmt.Sprint(secret.FileID)}); r.OK || r.Error == nil || r.Error.Code != "not_found" {
		t.Errorf("attached another project's file: ok=%v %+v", r.OK, r.Error)
	}

	// My own upload attaches; and a file on a card I can see can go on
	// another card of mine.
	chunk := uploadChunk(t, handler, []byte("my notes"))
	f := dispatch(srv, me, "file", "create", map[string]any{
		"filename": "mine.txt", "mime_type": "text/plain",
		"chunks": []map[string]any{{"address": chunk.Address, "size_bytes": chunk.SizeBytes}},
	})
	if !f.OK {
		t.Fatalf("file.create: %+v", f.Error)
	}
	var fOut file.CreateOutput
	reencode(t, f.Data, &fOut)
	if r := dispatch(srv, me, "attachment", "create", idRef{CardID: fmt.Sprint(mine), FileID: fmt.Sprint(fOut.ID)}); !r.OK {
		t.Errorf("attaching my own file: %+v", r.Error)
	}
	shared := createAttachment(t, srv, mine, "shared.txt", "text/plain", []chunkResp{uploadChunk(t, handler, []byte("shared"))})
	if r := dispatch(srv, me, "attachment", "create", idRef{CardID: fmt.Sprint(mine), FileID: fmt.Sprint(shared.FileID)}); !r.OK {
		t.Errorf("re-attaching a file I can see: %+v", r.Error)
	}
}

func reencode(t *testing.T, from, to any) {
	t.Helper()
	b, err := json.Marshal(from)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, to); err != nil {
		t.Fatal(err)
	}
}

// TestFileSizesAreStored (B5): a file's size is what was uploaded, not
// what the request says; an unknown chunk is refused; and a file can't
// pass the size limit, however its chunks are listed.
func TestFileSizesAreStored(t *testing.T) {
	handler, srv, _ := setup(t, "kitp_test_file_sizes")
	ctx := auth.WithSystemUser(context.Background())
	chunk := uploadChunk(t, handler, bytes.Repeat([]byte("x"), 4096))
	create := func(chunks ...map[string]any) api.SubResponse {
		return dispatch(srv, ctx, "file", "create", map[string]any{
			"filename": "f.bin", "mime_type": "application/octet-stream", "chunks": chunks,
		})
	}

	r := create(map[string]any{"address": chunk.Address, "size_bytes": 1})
	if !r.OK {
		t.Fatalf("file.create: %+v", r.Error)
	}
	var out file.CreateOutput
	reencode(t, r.Data, &out)
	if out.SizeBytes != 4096 {
		t.Errorf("size = %d, want the stored 4096 (the request said 1)", out.SizeBytes)
	}

	missing := cas.AddressOf([]byte("never uploaded"))
	if r := create(map[string]any{"address": missing, "size_bytes": 10}); r.OK || r.Error == nil || r.Error.Code != "validation" {
		t.Errorf("a chunk that was never uploaded: ok=%v %+v", r.OK, r.Error)
	}

	file.SetMaxBytes(64 << 10)
	t.Cleanup(func() { file.SetMaxBytes(250 << 20) })
	var many []map[string]any
	for range 20 { // 20 × 4 KB = 80 KB, past 64 KB
		many = append(many, map[string]any{"address": chunk.Address, "size_bytes": 1})
	}
	if r := create(many...); r.OK || r.Error == nil || r.Error.Code != "too_large" {
		t.Errorf("one chunk listed past the limit: ok=%v %+v", r.OK, r.Error)
	}
	if r := create(many[:10]...); !r.OK {
		t.Errorf("40 KB under a 64 KB limit: %+v", r.Error)
	}
}

// TestRequestCaps (B12): storing bytes needs a role, and a batch body is
// capped.
func TestRequestCaps(t *testing.T) {
	handler, srv, sp := setup(t, "kitp_test_attachment_request_caps")
	ctx := context.Background()
	var nobody int64
	if err := sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ('no-role') RETURNING id`).Scan(&nobody); err != nil {
		t.Fatal(err)
	}
	pid := makeProject(t, srv)
	worker, _ := auth.FromContext(member(t, sp, "chunk-worker", pid))

	for _, c := range []struct {
		name string
		user *auth.UserCtx
		want int
	}{
		{"no role", &auth.UserCtx{ID: nobody, DisplayName: "no-role"}, http.StatusForbidden},
		{"a project worker", worker, http.StatusOK},
	} {
		t.Run(c.name, func(t *testing.T) {
			rt := api.NewRouter(api.RouterConfig{
				SessionResolver: func(*http.Request) (*auth.UserCtx, error) { return c.user, nil },
			})
			cas.Mount(rt, cas.HTTPConfig{Pool: sp, Storage: cas.New(cas.NewPgBackend(sp.P))})
			req := httptest.NewRequest("POST", "/api/v1/cas/chunk", bytes.NewReader([]byte("chunk of "+c.name)))
			req.Header.Set("Content-Type", "application/octet-stream")
			rr := httptest.NewRecorder()
			rt.Mux().ServeHTTP(rr, req)
			if rr.Code != c.want {
				t.Errorf("chunk upload: %d, want %d: %s", rr.Code, c.want, rr.Body.String())
			}
		})
	}

	// A batch past the cap is refused as too large, not read in full.
	big := append([]byte(`{"subrequests":[{"id":"`), bytes.Repeat([]byte("a"), api.MaxBatchBytes)...)
	big = append(big, `"}]}`...)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, httptest.NewRequest("POST", "/api/v1/batch", bytes.NewReader(big)))
	if rr.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("an oversized batch: %d, want 413", rr.Code)
	}
}
