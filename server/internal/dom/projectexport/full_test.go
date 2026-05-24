package projectexport_test

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/attachment"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/comment"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/file"
	"github.com/kitp/kitp/server/internal/dom/projectexport"
	"github.com/kitp/kitp/server/internal/dom/tag"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// setupFull is the heavier setup: registers every handler the full
// export touches, plus the CAS HTTP route (chunk upload) and the
// attachment download route — both are needed so the attachment seed
// can flow through the same paths the production server uses.
func setupFull(t *testing.T, schemaName string) (http.Handler, *api.Server) {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schemaName)
	sp := store.NewPool(pool)
	echo.Register()
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	activity.Register(sp)
	comment.Register(sp)
	tag.Register(sp)
	attachment.Register(sp)
	file.Register(sp)

	srv := api.NewServer(sp)
	user, err := auth.NewSystemUser(context.Background(), pool, "dev", auth.ModeOff)
	if err != nil {
		t.Fatalf("system user: %v", err)
	}

	storage := cas.New(cas.NewPgBackend(pool))
	rt := api.NewTestRouter(user)
	cas.Mount(rt, cas.HTTPConfig{Pool: sp, Storage: storage, MaxBytes: 4 * 1024 * 1024})
	attachment.Mount(rt, attachment.Config{Pool: sp, Storage: storage})
	projectexport.Mount(rt, projectexport.Config{Pool: sp, Storage: storage})
	srv.MountBatch(rt)

	mux := http.NewServeMux()
	mux.Handle("/api/", rt.Mux())
	return mux, srv
}

// fetchZip downloads the ZIP and returns the parsed archive entries
// keyed by name, plus the raw response status and headers.
func fetchZip(t *testing.T, handler http.Handler, projectID int64, query string) (int, http.Header, map[string][]byte) {
	t.Helper()
	url := fmt.Sprintf("/api/v1/project/%d/export.zip", projectID)
	if query != "" {
		url += "?" + query
	}
	req := httptest.NewRequest("GET", url, nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	body, _ := io.ReadAll(rr.Body)
	if rr.Code != http.StatusOK {
		return rr.Code, rr.Header(), map[string][]byte{"_err": body}
	}
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("parse zip: %v (body=%d bytes)", err, len(body))
	}
	out := map[string][]byte{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open %s: %v", f.Name, err)
		}
		buf, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatalf("read %s: %v", f.Name, err)
		}
		out[f.Name] = buf
	}
	return rr.Code, rr.Header(), out
}

// parseCSV is a one-liner test helper.
func parseCSV(t *testing.T, name string, body []byte) [][]string {
	t.Helper()
	cr := csv.NewReader(bytes.NewReader(body))
	cr.FieldsPerRecord = -1
	rows, err := cr.ReadAll()
	if err != nil {
		t.Fatalf("parse %s: %v", name, err)
	}
	return rows
}

// uploadChunk POSTs a single chunk through the multipart CAS route.
func uploadChunk(t *testing.T, handler http.Handler, body []byte) struct {
	Address   string `json:"address"`
	SizeBytes int64  `json:"size_bytes"`
} {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/v1/cas/chunk", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/octet-stream")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("chunk upload: %d: %s", rr.Code, rr.Body.String())
	}
	var out struct {
		Address   string `json:"address"`
		SizeBytes int64  `json:"size_bytes"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode chunk: %v", err)
	}
	return out
}

// attachOne uploads `body` as a single-chunk file and creates an
// attachment on cardID. Returns the attachment id.
func attachOne(t *testing.T, handler http.Handler, srv *api.Server, cardID int64, filename string, body []byte) int64 {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())
	c := uploadChunk(t, handler, body)
	fileReq, _ := json.Marshal(map[string]any{
		"filename":  filename,
		"mime_type": "text/plain",
		"chunks":    []map[string]any{{"address": c.Address, "size_bytes": c.SizeBytes}},
	})
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "f", Endpoint: "file", Action: "create", Data: fileReq},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("file.create: %+v", resp.Subresponses[0])
	}
	var fOut file.CreateOutput
	b, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(b, &fOut)

	attReq, _ := json.Marshal(struct {
		CardID int64 `json:"card_id,string"`
		FileID int64 `json:"file_id,string"`
	}{CardID: cardID, FileID: fOut.ID})
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "a", Endpoint: "attachment", Action: "create", Data: attReq},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("attachment.create: %+v", resp.Subresponses[0])
	}
	var aOut attachment.CreateOutput
	b, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(b, &aOut)
	return aOut.ID
}

// TestExportZIP_PopulatedNoExtras: the default toggles (no
// attachments, no activity) produce the seven baseline CSVs.
func TestExportZIP_PopulatedNoExtras(t *testing.T) {
	handler, srv := setupFull(t, "kitp_test_export_zip_basic")
	s := seedSimpleProject(t, srv)
	code, hdr, files := fetchZip(t, handler, s.ProjectID, "")
	if code != http.StatusOK {
		t.Fatalf("status: %d", code)
	}
	if ct := hdr.Get("Content-Type"); ct != "application/zip" {
		t.Errorf("Content-Type %q", ct)
	}
	// Baseline file set.
	want := []string{
		"project.csv", "tasks.csv", "comments.csv",
		"milestones.csv", "components.csv", "tags.csv",
		"persons.csv", "attachments.csv",
	}
	for _, n := range want {
		if _, ok := files[n]; !ok {
			t.Errorf("missing %s", n)
		}
	}
	if _, ok := files["activity.csv"]; ok {
		t.Errorf("activity.csv should be absent when include_activity is off")
	}
	for n := range files {
		if strings.HasPrefix(n, "attachments/") {
			t.Errorf("attachments/* should be absent when include_attachments is off; got %s", n)
		}
	}

	// project.csv has 1 row + header.
	rows := parseCSV(t, "project.csv", files["project.csv"])
	if len(rows) != 2 {
		t.Fatalf("project.csv rows: got %d, want 2", len(rows))
	}
	if rows[1][0] != fmt.Sprintf("%d", s.ProjectID) {
		t.Errorf("project id: %q", rows[1][0])
	}
	if rows[1][1] != "Demo Project" {
		t.Errorf("project title: %q", rows[1][1])
	}

	// tasks.csv has 1 task row, no comments column.
	tRows := parseCSV(t, "tasks.csv", files["tasks.csv"])
	if len(tRows) != 2 {
		t.Fatalf("tasks rows: %d", len(tRows))
	}
	wantTaskHeader := []string{
		"id", "title", "assignee_email", "assignee_name",
		"milestone", "component", "tags", "description", "sort_order",
		"created_at", "deleted_at",
	}
	for i, h := range wantTaskHeader {
		if tRows[0][i] != h {
			t.Fatalf("tasks header[%d] = %q, want %q", i, tRows[0][i], h)
		}
	}

	// comments.csv: one comment (from the seed).
	cRows := parseCSV(t, "comments.csv", files["comments.csv"])
	if len(cRows) != 2 {
		t.Fatalf("comments rows: %d", len(cRows))
	}
	if cRows[1][2] != "first pass looks good" {
		t.Errorf("comment body: %q", cRows[1][2])
	}

	// milestones / components / tags: each has 1 row plus header.
	for _, n := range []string{"milestones.csv", "components.csv", "tags.csv"} {
		if got := len(parseCSV(t, n, files[n])); got != 2 {
			t.Errorf("%s rows: %d, want 2", n, got)
		}
	}
	// persons.csv: only the assignees we touched (the System person).
	pRows := parseCSV(t, "persons.csv", files["persons.csv"])
	if len(pRows) != 2 {
		t.Fatalf("persons rows: %d", len(pRows))
	}
	if pRows[1][3] != "true" {
		t.Errorf("persons has_login = %q, want true", pRows[1][3])
	}
	// attachments.csv: just the header (no attachments in this seed).
	aRows := parseCSV(t, "attachments.csv", files["attachments.csv"])
	if len(aRows) != 1 {
		t.Errorf("attachments rows: %d, want 1 (header only)", len(aRows))
	}
}

// TestExportZIP_IncludeActivity flips the activity toggle and asserts
// activity.csv is present with at least one row.
func TestExportZIP_IncludeActivity(t *testing.T) {
	handler, srv := setupFull(t, "kitp_test_export_zip_activity")
	s := seedSimpleProject(t, srv)
	_, _, files := fetchZip(t, handler, s.ProjectID, "include_activity=1")
	body, ok := files["activity.csv"]
	if !ok {
		t.Fatalf("activity.csv missing")
	}
	rows := parseCSV(t, "activity.csv", body)
	// header + at least the task's card_create + initial attrs + 1 comment.
	if len(rows) < 3 {
		t.Errorf("activity rows: %d, want >= 3", len(rows))
	}
	// Last column is created_at — verify it parses as RFC3339-ish.
	got := rows[1][len(rows[1])-1]
	if !strings.Contains(got, "T") || !strings.Contains(got, "Z") {
		t.Errorf("activity created_at: %q, want RFC3339-like", got)
	}
}

// TestExportZIP_IncludeAttachments uploads one attachment and asserts
// the bytes flow into attachments/<id>-<filename> plus the sha256
// column populates with the file digest.
func TestExportZIP_IncludeAttachments(t *testing.T) {
	handler, srv := setupFull(t, "kitp_test_export_zip_atts")
	s := seedSimpleProject(t, srv)

	body := []byte("the quick brown fox jumps over the lazy dog\n")
	attID := attachOne(t, handler, srv, s.TaskID, "notes.txt", body)

	_, _, files := fetchZip(t, handler, s.ProjectID, "include_attachments=1")
	wantPath := fmt.Sprintf("attachments/%d-notes.txt", attID)
	gotBytes, ok := files[wantPath]
	if !ok {
		t.Fatalf("missing %s in zip; have: %v", wantPath, keysOf(files))
	}
	if !bytes.Equal(gotBytes, body) {
		t.Errorf("attachment bytes mismatch (%d vs %d)", len(gotBytes), len(body))
	}

	rows := parseCSV(t, "attachments.csv", files["attachments.csv"])
	if len(rows) != 2 {
		t.Fatalf("attachments.csv rows: %d", len(rows))
	}
	wantSHA := hex.EncodeToString(func() []byte { s := sha256.Sum256(body); return s[:] }())
	if rows[1][3] != wantSHA {
		t.Errorf("sha256 column: got %q, want %q", rows[1][3], wantSHA)
	}
	if rows[1][1] != fmt.Sprintf("%d", s.TaskID) {
		t.Errorf("task_id column: %q", rows[1][1])
	}
	if rows[1][2] != "notes.txt" {
		t.Errorf("filename column: %q", rows[1][2])
	}
}

// TestExportZIP_EmptyProject: a brand-new project still produces a
// valid ZIP with header-only CSVs.
func TestExportZIP_EmptyProject(t *testing.T) {
	handler, srv := setupFull(t, "kitp_test_export_zip_empty")
	ctx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"Empty"}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("project: %+v", resp.Subresponses[0].Error)
	}
	var o card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &o)

	code, _, files := fetchZip(t, handler, o.ID, "")
	if code != http.StatusOK {
		t.Fatalf("status: %d", code)
	}
	for _, n := range []string{"project.csv", "tasks.csv", "comments.csv",
		"milestones.csv", "components.csv", "tags.csv", "persons.csv", "attachments.csv"} {
		body, ok := files[n]
		if !ok {
			t.Errorf("missing %s", n)
			continue
		}
		rows := parseCSV(t, n, body)
		if n == "project.csv" {
			// project.csv has 1 data row.
			if len(rows) != 2 {
				t.Errorf("project.csv rows: %d, want 2", len(rows))
			}
		} else if len(rows) != 1 {
			t.Errorf("%s rows: %d, want 1 (header only)", n, len(rows))
		}
	}
}

// TestExportZIP_NotFound: a non-existent project returns 404.
func TestExportZIP_NotFound(t *testing.T) {
	handler, _ := setupFull(t, "kitp_test_export_zip_404")
	code, _, _ := fetchZip(t, handler, 999_999_999, "")
	if code != http.StatusNotFound {
		t.Errorf("status: %d, want 404", code)
	}
}

func keysOf(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
