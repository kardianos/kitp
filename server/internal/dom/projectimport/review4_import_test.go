package projectimport_test

// Regression tests for the import findings of the fourth 2026-11-03
// review (#3, #10).

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/comment"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/file"
	"github.com/kitp/kitp/server/internal/dom/projectimport"
	"github.com/kitp/kitp/server/internal/dom/tag"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

type r4Fix struct {
	srv     *api.Server
	sp      *store.Pool
	storage *cas.Storage
}

func r4Setup(t *testing.T, schema string) r4Fix {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schema)
	sp := store.NewPool(pool)
	echo.Register()
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	activity.Register(sp)
	comment.Register(sp)
	tag.Register(sp)
	file.Register(sp)
	storage := cas.New(cas.NewPgBackend(pool))
	projectimport.Register(projectimport.ImportConfig{Pool: sp, Storage: storage})
	return r4Fix{srv: api.NewServer(sp), sp: sp, storage: storage}
}

func (f r4Fix) user(t *testing.T, name string, project int64) int64 {
	t.Helper()
	ctx := context.Background()
	var id int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO user_role (user_id, role_id, scope_card_id) SELECT $1, id, $2 FROM role WHERE name = 'worker'`, id, project); err != nil {
		t.Fatal(err)
	}
	return id
}

func r4Ctx(id int64) context.Context {
	return auth.WithUser(context.Background(), &auth.UserCtx{ID: id, DisplayName: fmt.Sprint(id)})
}

func (f r4Fix) upload(t *testing.T, uid int64, body []byte) string {
	t.Helper()
	rt := api.NewTestRouter(&auth.UserCtx{ID: uid})
	cas.Mount(rt, cas.HTTPConfig{Pool: f.sp, Storage: f.storage, MaxBytes: 4 << 20})
	var chunks []map[string]any
	for off := 0; off < len(body); off += 4 << 20 {
		end := min(off+(4<<20), len(body))
		req := httptest.NewRequest("POST", "/api/v1/cas/chunk", bytes.NewReader(body[off:end]))
		req.Header.Set("Content-Type", "text/csv")
		rr := httptest.NewRecorder()
		rt.Mux().ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("chunk: %d %s", rr.Code, rr.Body.String())
		}
		var c struct {
			Address   string `json:"address"`
			SizeBytes int64  `json:"size_bytes"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &c); err != nil {
			t.Fatal(err)
		}
		chunks = append(chunks, map[string]any{"address": c.Address, "size_bytes": c.SizeBytes})
	}
	cb, err := json.Marshal(chunks)
	if err != nil {
		t.Fatal(err)
	}
	sr := dispatchAs(f.srv, r4Ctx(uid), "file", "create", fmt.Sprintf(`{"filename":"i.csv","mime_type":"text/csv","chunks":%s}`, cb))
	if !sr.OK {
		t.Fatalf("file.create: %+v", sr.Error)
	}
	var o struct {
		ID string `json:"id"`
	}
	r4Decode(t, sr, &o)
	return o.ID
}

func (f r4Fix) job(t *testing.T, uid, pid int64, fileID string, mapping string) string {
	t.Helper()
	sr := dispatchAs(f.srv, r4Ctx(uid), "project.import", "upload", fmt.Sprintf(`{"project_id":"%d","file_id":%q}`, pid, fileID))
	if !sr.OK {
		t.Fatalf("import upload: %+v", sr.Error)
	}
	var o struct {
		JobID string `json:"job_id"`
	}
	r4Decode(t, sr, &o)
	if r := dispatchAs(f.srv, r4Ctx(uid), "project.import", "set_mapping", fmt.Sprintf(`{"job_id":%q,"mapping":%s}`, o.JobID, mapping)); !r.OK {
		t.Fatalf("map: %+v", r.Error)
	}
	return o.JobID
}

func r4Decode(t *testing.T, sr api.SubResponse, v any) {
	t.Helper()
	b, err := json.Marshal(sr.Data)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatal(err)
	}
}

// TestOneImportPerRequest (round 4 #10): two import previews in one batch
// are refused wherever they sit, not only side by side.
func TestOneImportPerRequest(t *testing.T) {
	f := r4Setup(t, "kitp_test_r4_import_one")
	pid := makeProject(t, f.srv, "Big")
	w := f.user(t, "w", pid)
	job := f.job(t, w, pid, f.upload(t, w, []byte("title\nA\nB\n")), `{"title":"title"}`)
	preview := api.SubRequest{Endpoint: "project.import", Action: "preview", Data: json.RawMessage(fmt.Sprintf(`{"job_id":%q,"resolution":{}}`, job))}
	ping := api.SubRequest{Endpoint: "echo", Action: "ping", Data: json.RawMessage(`{"message":"x"}`)}
	p1, p2 := preview, preview
	p1.ID, p2.ID, ping.ID = "p1", "p2", "e"
	resp := f.srv.Dispatch(r4Ctx(w), api.BatchRequest{Subrequests: []api.SubRequest{p1, ping, p2}})
	for _, sr := range resp.Subresponses {
		if sr.OK {
			t.Errorf("%s ran in a batch with two imports", sr.ID)
		}
	}
	if sr := resp.Subresponses[2]; sr.Error == nil || sr.Error.Code != "validation" {
		t.Errorf("second preview: %+v, want validation", sr.Error)
	}
	if sr := f.srv.Dispatch(r4Ctx(w), api.BatchRequest{Subrequests: []api.SubRequest{p1, ping}}).Subresponses[0]; !sr.OK {
		t.Errorf("one preview with a ping: %+v", sr.Error)
	}
}

// TestImportScalesLinearly (round 4 #3): a preview whose every row is an
// error and a commit of thousands of rows finish well inside their
// timeouts; the preview lists the first 1000 errors and counts them all.
func TestImportScalesLinearly(t *testing.T) {
	f := r4Setup(t, "kitp_test_r4_import_scale")
	pid := makeProject(t, f.srv, "Big")
	w := f.user(t, "w", pid)
	var eb strings.Builder
	eb.WriteString("title,milestone\n")
	for i := range 10000 {
		fmt.Fprintf(&eb, "t%d,unknown milestone number %d\n", i, i)
	}
	ejob := f.job(t, w, pid, f.upload(t, w, []byte(eb.String())), `{"title":"title","milestone":"milestone"}`)
	start := time.Now()
	sr := dispatchAs(f.srv, r4Ctx(w), "project.import", "preview", fmt.Sprintf(`{"job_id":%q,"resolution":{}}`, ejob))
	took := time.Since(start)
	if !sr.OK {
		t.Fatalf("preview of 10,000 error rows: %+v (after %s)", sr.Error, took)
	}
	var pv projectimport.PreviewOutput
	r4Decode(t, sr, &pv)
	if pv.ErrorCount != 10000 || len(pv.Errors) != 1000 {
		t.Errorf("preview errors: %d listed, %d counted; want 1000 and 10000", len(pv.Errors), pv.ErrorCount)
	}
	if took > 20*time.Second {
		t.Errorf("preview of 10,000 error rows took %s", took)
	}

	var cb strings.Builder
	cb.WriteString("title\n")
	for i := range 8000 {
		fmt.Fprintf(&cb, "task %d\n", i)
	}
	job := f.job(t, w, pid, f.upload(t, w, []byte(cb.String())), `{"title":"title"}`)
	start = time.Now()
	c := dispatchAs(f.srv, r4Ctx(w), "project.import", "commit", fmt.Sprintf(`{"job_id":%q}`, job))
	took = time.Since(start)
	if !c.OK {
		t.Fatalf("commit of 8,000 rows: %+v (after %s)", c.Error, took)
	}
	t.Logf("commit of 8,000 rows took %s", took)
	var left int
	if err := f.sp.P.QueryRow(context.Background(), `SELECT count(*) FROM import_job_row`).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 0 {
		t.Errorf("%d import rows left behind", left)
	}
}
