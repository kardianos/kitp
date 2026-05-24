package projectimport_test

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

// setup builds a fresh schema with every handler the import wizard
// touches, plus the CAS HTTP route so the tests can upload CSV bytes
// the same way the production client does.
func setup(t *testing.T) (http.Handler, *api.Server, *store.Pool) {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, "kitp_test_projectimport")
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

	srv := api.NewServer(sp)
	user, err := auth.NewSystemUser(context.Background(), pool, "dev", auth.ModeOff)
	if err != nil {
		t.Fatalf("system user: %v", err)
	}

	// Build an apiRouter pre-resolved to the System user so the
	// batch + cas chunk routes both see an authenticated actor.
	// Mirrors the production wiring without standing up a session
	// Manager.
	rt := api.NewTestRouter(user)
	cas.Mount(rt, cas.HTTPConfig{Pool: sp, Storage: storage, MaxBytes: 4 * 1024 * 1024})
	srv.MountBatch(rt)

	mux := http.NewServeMux()
	mux.Handle("/api/", rt.Mux())
	return mux, srv, sp
}

// uploadCSV uploads `body` as a single-chunk file and returns the
// file_id ready to feed into project.import.upload.
func uploadCSV(t *testing.T, handler http.Handler, srv *api.Server, body []byte) int64 {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())
	req := httptest.NewRequest("POST", "/api/v1/cas/chunk", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/octet-stream")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("chunk upload: %d: %s", rr.Code, rr.Body.String())
	}
	var c struct {
		Address   string `json:"address"`
		SizeBytes int64  `json:"size_bytes"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &c); err != nil {
		t.Fatalf("decode chunk: %v", err)
	}
	fileReq, _ := json.Marshal(map[string]any{
		"filename":  "import.csv",
		"mime_type": "text/csv",
		"chunks":    []map[string]any{{"address": c.Address, "size_bytes": c.SizeBytes}},
	})
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "f", Endpoint: "file", Action: "create", Data: fileReq},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("file.create: %+v", resp.Subresponses[0].Error)
	}
	var fOut file.CreateOutput
	b, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(b, &fOut)
	return fOut.ID
}

// makeProject returns a fresh project id, plus seeds a same-project
// status card so subsequent task inserts (whether by the test itself
// or by project.import's commit) satisfy Gate 6's (task, status)
// required-edge check. The status id is not returned; callers that
// need it look it up explicitly via card.select_with_attributes.
func makeProject(t *testing.T, srv *api.Server, title string) int64 {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"project","title":%q}`, title))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("project: %+v", resp.Subresponses[0].Error)
	}
	var o card.InsertOutput
	b, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(b, &o)
	// Seed one status under this project so Gate 6's required-edge
	// check accepts task inserts on the import path.
	sResp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"status","parent_card_id":"%d","title":"Todo"}`, o.ID))},
	}})
	if !sResp.Subresponses[0].OK {
		t.Fatalf("project status seed: %+v", sResp.Subresponses[0].Error)
	}
	return o.ID
}

// dispatch wraps the JSON batch dispatcher for one sub-request.
func dispatch(t *testing.T, srv *api.Server, id, endpoint, action, data string) api.SubResponse {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: id, Endpoint: endpoint, Action: action, Data: json.RawMessage(data)},
	}})
	return resp.Subresponses[0]
}

// TestUpload_HeaderAndPreview: a clean CSV uploads, returns the header
// + first N rows + total row count, and the import_job row is in
// status='uploaded'.
func TestUpload_HeaderAndPreview(t *testing.T) {
	handler, srv, _ := setup(t)
	pid := makeProject(t, srv, "Import Demo")

	csv := []byte("title,milestone,description\nFirst,M1,Hello\nSecond,M2,World\n")
	fid := uploadCSV(t, handler, srv, csv)

	sr := dispatch(t, srv, "u", "project.import", "upload",
		fmt.Sprintf(`{"project_id":"%d","file_id":"%d"}`, pid, fid))
	if !sr.OK {
		t.Fatalf("upload: %+v", sr.Error)
	}
	var out projectimport.UploadOutput
	b, _ := json.Marshal(sr.Data)
	_ = json.Unmarshal(b, &out)

	if out.JobID == 0 {
		t.Error("JobID = 0")
	}
	wantHeaders := []string{"title", "milestone", "description"}
	if len(out.Headers) != 3 || out.Headers[0] != wantHeaders[0] {
		t.Errorf("headers: got %v, want %v", out.Headers, wantHeaders)
	}
	if out.RowCount != 2 {
		t.Errorf("row_count: got %d, want 2", out.RowCount)
	}
	if len(out.PreviewRows) != 2 {
		t.Errorf("preview rows: got %d, want 2", len(out.PreviewRows))
	}
}

// TestUpload_MissingFile: passing a file_id that doesn't exist surfaces
// a csv_read error (the chunk lookup returns no rows).
func TestUpload_MissingFile(t *testing.T) {
	_, srv, _ := setup(t)
	pid := makeProject(t, srv, "Missing file")
	sr := dispatch(t, srv, "u", "project.import", "upload",
		fmt.Sprintf(`{"project_id":"%d","file_id":"999999999"}`, pid))
	if sr.OK {
		t.Fatalf("expected csv_read error; got OK")
	}
	if sr.Error == nil || sr.Error.Code != "csv_read" {
		t.Errorf("error code: %+v, want csv_read", sr.Error)
	}
}

// TestSetMapping_PersistsAndAdvances: writing a mapping moves status
// from 'uploaded' to 'mapped' and stores the JSON.
func TestSetMapping_PersistsAndAdvances(t *testing.T) {
	handler, srv, sp := setup(t)
	pid := makeProject(t, srv, "Map It")
	fid := uploadCSV(t, handler, srv, []byte("title,milestone\nA,M1\n"))
	sr := dispatch(t, srv, "u", "project.import", "upload",
		fmt.Sprintf(`{"project_id":"%d","file_id":"%d"}`, pid, fid))
	if !sr.OK {
		t.Fatalf("upload: %+v", sr.Error)
	}
	var up projectimport.UploadOutput
	b, _ := json.Marshal(sr.Data)
	_ = json.Unmarshal(b, &up)

	sr = dispatch(t, srv, "m", "project.import", "set_mapping",
		fmt.Sprintf(`{"job_id":"%d","mapping":{"title":"title","milestone":"milestone"}}`, up.JobID))
	if !sr.OK {
		t.Fatalf("set_mapping: %+v", sr.Error)
	}
	var sm projectimport.SetMappingOutput
	b, _ = json.Marshal(sr.Data)
	_ = json.Unmarshal(b, &sm)
	if sm.Status != "mapped" {
		t.Errorf("status: %q, want mapped", sm.Status)
	}

	// Verify the row carries the JSON mapping.
	var stored string
	if err := sp.P.QueryRow(context.Background(),
		`SELECT mapping::text FROM import_job WHERE id = $1`, up.JobID,
	).Scan(&stored); err != nil {
		t.Fatalf("read job: %v", err)
	}
	if !strings.Contains(stored, `"title": "title"`) {
		t.Errorf("mapping stored: %q", stored)
	}
}

// TestPreview_Matrix covers every resolution mode × category we
// support. A single CSV row + lookup matrix exercises:
//   - milestone auto_create (counts add up)
//   - component skip (row gets dropped)
//   - tag leave_blank (accept, no error)
//   - person auto_create
func TestPreview_Matrix(t *testing.T) {
	handler, srv, _ := setup(t)
	pid := makeProject(t, srv, "Matrix")

	// Seed one existing milestone so the lookup distinguishes
	// "known" from "auto-create".
	if r := dispatch(t, srv, "ms", "card", "insert",
		fmt.Sprintf(`{"card_type_name":"milestone","parent_card_id":"%d","title":"Existing"}`, pid),
	); !r.OK {
		t.Fatalf("seed milestone: %+v", r.Error)
	}

	// Emails deliberately unseeded so auto_create kicks in. The demo
	// seed already has alice/bob/.../eve, so we pick fresh names.
	csv := []byte(strings.Join([]string{
		"title,milestone,component,tags,assignee_email,assignee_name",
		"Task 1,Existing,Frontend,priority/high,new1@example.invalid,New1",
		"Task 2,New M,Frontend,,new2@example.invalid,New2",
		"Task 3,Existing,,priority/low,new3@example.invalid,New3",
	}, "\n") + "\n")
	fid := uploadCSV(t, handler, srv, csv)

	sr := dispatch(t, srv, "u", "project.import", "upload",
		fmt.Sprintf(`{"project_id":"%d","file_id":"%d"}`, pid, fid))
	if !sr.OK {
		t.Fatalf("upload: %+v", sr.Error)
	}
	var up projectimport.UploadOutput
	b, _ := json.Marshal(sr.Data)
	_ = json.Unmarshal(b, &up)

	// Mapping: every column maps to its same-named target attr.
	mapping := map[string]string{
		"title":     "title",
		"milestone": "milestone", "component": "component", "tags": "tags",
		"assignee_email": "assignee_email", "assignee_name": "assignee_name",
	}
	mapJSON, _ := json.Marshal(mapping)
	sr = dispatch(t, srv, "m", "project.import", "set_mapping",
		fmt.Sprintf(`{"job_id":"%d","mapping":%s}`, up.JobID, mapJSON))
	if !sr.OK {
		t.Fatalf("set_mapping: %+v", sr.Error)
	}

	// Resolution: milestone/person auto-create; component skip;
	// tag leave_blank.
	res := projectimport.ResolutionConfig{
		Persons:    "auto_create",
		Milestones: "auto_create",
		Components: "skip",
		Tags:       "leave_blank",
	}
	resJSON, _ := json.Marshal(res)
	sr = dispatch(t, srv, "p", "project.import", "preview",
		fmt.Sprintf(`{"job_id":"%d","resolution":%s}`, up.JobID, resJSON))
	if !sr.OK {
		t.Fatalf("preview: %+v", sr.Error)
	}
	var pv projectimport.PreviewOutput
	b, _ = json.Marshal(sr.Data)
	_ = json.Unmarshal(b, &pv)

	// Component=Frontend doesn't exist → skip is applied. Both rows 1
	// and 2 reference Frontend → both skipped. Row 3 has no component
	// cell → passes; its tag is unknown but mode=leave_blank → no error.
	if pv.SkippedRows != 2 {
		t.Errorf("skipped: got %d, want 2 (rows referencing Frontend)", pv.SkippedRows)
	}
	if pv.WouldCreate.Tasks != 1 {
		t.Errorf("would_create.tasks: got %d, want 1 (only Task 3 survives)", pv.WouldCreate.Tasks)
	}
	if pv.WouldCreate.Persons < 1 {
		t.Errorf("would_create.persons: got %d, want >= 1 (Task 3's new person)", pv.WouldCreate.Persons)
	}
	if pv.Status != "previewed" {
		t.Errorf("status: %q, want previewed", pv.Status)
	}
}

// TestPreview_RoundTripFromExport: the simple-csv export of a project
// imports cleanly into another project with `match_existing` for
// every category (after auto-creating the persons / milestones /
// components / tags). Verifies the column names line up between the
// two endpoints.
func TestPreview_RoundTripFromExport(t *testing.T) {
	handler, srv, _ := setup(t)
	src := makeProject(t, srv, "Source")
	mid := dispatch(t, srv, "ms", "card", "insert",
		fmt.Sprintf(`{"card_type_name":"milestone","parent_card_id":"%d","title":"M1"}`, src))
	if !mid.OK {
		t.Fatalf("seed milestone: %+v", mid.Error)
	}
	cid := dispatch(t, srv, "co", "card", "insert",
		fmt.Sprintf(`{"card_type_name":"component","parent_card_id":"%d","title":"FE"}`, src))
	if !cid.OK {
		t.Fatalf("seed component: %+v", cid.Error)
	}
	tgid := dispatch(t, srv, "tg", "card", "insert",
		fmt.Sprintf(`{"card_type_name":"tag","parent_card_id":"%d","title":"priority/high","attributes":{"path":"priority/high"}}`, src))
	if !tgid.OK {
		t.Fatalf("seed tag: %+v", tgid.Error)
	}
	var mOut, cOut, tOut card.InsertOutput
	b, _ := json.Marshal(mid.Data)
	_ = json.Unmarshal(b, &mOut)
	b, _ = json.Marshal(cid.Data)
	_ = json.Unmarshal(b, &cOut)
	b, _ = json.Marshal(tgid.Data)
	_ = json.Unmarshal(b, &tOut)

	// Status under the source project for the task's (task, status)
	// required-edge check.
	srcStatus := dispatch(t, srv, "src_s", "card", "insert", fmt.Sprintf(
		`{"card_type_name":"status","parent_card_id":"%d","title":"Todo"}`, src))
	if !srcStatus.OK {
		t.Fatalf("seed src status: %+v", srcStatus.Error)
	}
	var ssOut card.InsertOutput
	bSS, _ := json.Marshal(srcStatus.Data)
	_ = json.Unmarshal(bSS, &ssOut)

	// One task that references milestone / component / tags.
	taskBody := fmt.Sprintf(`{
		"card_type_name":"task","parent_card_id":"%d","title":"T1",
		"attributes":{"milestone_ref":"%d","component_ref":"%d","tags":["%d"],"status":"%d"}
	}`, src, mOut.ID, cOut.ID, tOut.ID, ssOut.ID)
	if r := dispatch(t, srv, "tk", "card", "insert", taskBody); !r.OK {
		t.Fatalf("seed task: %+v", r.Error)
	}

	// Build a CSV that mirrors the export shape and feed it into a
	// fresh project. (Generating it inline keeps this test independent
	// of the export package's import path.)
	csv := []byte(strings.Join([]string{
		"id,title,assignee_email,assignee_name,milestone,component,tags,description,sort_order,created_at,deleted_at,comments",
		"1,T1,,,M1,FE,priority/high,,,2026-05-11T00:00:00Z,,",
	}, "\n") + "\n")

	dst := makeProject(t, srv, "Destination")
	// Pre-seed the same value-cards under the destination so
	// match_existing succeeds.
	for _, tt := range []struct{ kind, title, extra string }{
		{"milestone", "M1", ""},
		{"component", "FE", ""},
		{"tag", "priority/high", `,"attributes":{"path":"priority/high"}`},
	} {
		body := fmt.Sprintf(`{"card_type_name":%q,"parent_card_id":"%d","title":%q%s}`,
			tt.kind, dst, tt.title, tt.extra)
		if r := dispatch(t, srv, tt.kind, "card", "insert", body); !r.OK {
			t.Fatalf("seed %s: %+v", tt.kind, r.Error)
		}
	}

	fid := uploadCSV(t, handler, srv, csv)
	sr := dispatch(t, srv, "u", "project.import", "upload",
		fmt.Sprintf(`{"project_id":"%d","file_id":"%d"}`, dst, fid))
	if !sr.OK {
		t.Fatalf("upload: %+v", sr.Error)
	}
	var up projectimport.UploadOutput
	b, _ = json.Marshal(sr.Data)
	_ = json.Unmarshal(b, &up)

	mapping := map[string]string{
		"id": "_ignore_", "title": "title",
		"assignee_email": "assignee_email", "assignee_name": "assignee_name",
		"milestone": "milestone", "component": "component", "tags": "tags",
		"description": "description", "sort_order": "sort_order",
		"created_at": "_ignore_", "deleted_at": "_ignore_", "comments": "_ignore_",
	}
	mb, _ := json.Marshal(mapping)
	sr = dispatch(t, srv, "m", "project.import", "set_mapping",
		fmt.Sprintf(`{"job_id":"%d","mapping":%s}`, up.JobID, mb))
	if !sr.OK {
		t.Fatalf("set_mapping: %+v", sr.Error)
	}

	res := projectimport.ResolutionConfig{
		Persons:    "leave_blank",
		Milestones: "match_existing",
		Components: "match_existing",
		Tags:       "match_existing",
	}
	rb, _ := json.Marshal(res)
	sr = dispatch(t, srv, "p", "project.import", "preview",
		fmt.Sprintf(`{"job_id":"%d","resolution":%s}`, up.JobID, rb))
	if !sr.OK {
		t.Fatalf("preview: %+v", sr.Error)
	}
	var pv projectimport.PreviewOutput
	b, _ = json.Marshal(sr.Data)
	_ = json.Unmarshal(b, &pv)

	if len(pv.Errors) != 0 {
		t.Errorf("expected no errors on clean round-trip; got %+v", pv.Errors)
	}
	if pv.WouldCreate.Tasks != 1 {
		t.Errorf("would_create.tasks: got %d, want 1", pv.WouldCreate.Tasks)
	}
}
