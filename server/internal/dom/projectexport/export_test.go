package projectexport_test

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/comment"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/projectexport"
	"github.com/kitp/kitp/server/internal/dom/tag"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// setup builds a fresh schema, registers every handler the export
// endpoint indirectly depends on (the export does its own SQL, but
// the test seeds data via the dispatcher), and mounts the export
// HTTP route. The System User middleware fronts the lot so requests
// flow through as actor_id=1 (which holds the seed-installed
// `system` role and therefore card.update on every card_type).
func setup(t *testing.T, schemaName string) (http.Handler, *api.Server) {
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
	srv := api.NewServer(sp)

	mux := http.NewServeMux()
	srv.Mount(mux, "")
	projectexport.RegisterHTTP(mux, projectexport.Config{Pool: sp})

	user, err := auth.NewSystemUser(context.Background(), pool, "dev", auth.ModeOff)
	if err != nil {
		t.Fatalf("system user: %v", err)
	}
	handler := auth.Middleware(user)(mux)
	return handler, srv
}

// seedSimpleProject builds a project with one milestone, one component,
// one tag, and one task that references all three. The task also
// carries a description, sort_order, assignee (System person card),
// and one comment. Returns the project id.
type simpleSeed struct {
	ProjectID   int64
	TaskID      int64
	MilestoneID int64
	ComponentID int64
	TagID       int64
}

func seedSimpleProject(t *testing.T, srv *api.Server) simpleSeed {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())

	insert := func(id, payload string) int64 {
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: id, Endpoint: "card", Action: "insert", Data: json.RawMessage(payload)},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("insert %s: %+v", id, resp.Subresponses[0].Error)
		}
		var o card.InsertOutput
		buf, _ := json.Marshal(resp.Subresponses[0].Data)
		_ = json.Unmarshal(buf, &o)
		return o.ID
	}

	pid := insert("p", `{"card_type_name":"project","title":"Demo Project"}`)
	mid := insert("m", fmt.Sprintf(`{"card_type_name":"milestone","parent_card_id":"%d","title":"M1"}`, pid))
	cid := insert("c", fmt.Sprintf(`{"card_type_name":"component","parent_card_id":"%d","title":"Frontend"}`, pid))
	sid := insert("s", fmt.Sprintf(`{"card_type_name":"status","parent_card_id":"%d","title":"Todo"}`, pid))
	tagID := insert("tg", fmt.Sprintf(
		`{"card_type_name":"tag","parent_card_id":"%d","title":"priority/high","attributes":{"path":"priority/high"}}`, pid))

	// The seeded `system` person card is id=1 (see declarative.toml's
	// $persons section); referencing it keeps assignee email/name
	// columns deterministic without seeding an additional person.
	tid := insert("t", fmt.Sprintf(`{
		"card_type_name":"task","parent_card_id":"%d","title":"Wire pickers",
		"attributes":{
			"assignee":"1",
			"milestone_ref":"%d","component_ref":"%d","tags":["%d"],
			"status":"%d",
			"description":"Replace ad-hoc pickers","sort_order":100
		}
	}`, pid, mid, cid, tagID, sid))

	// One comment.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "cm", Endpoint: "comment", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","body":"first pass looks good"}`, tid))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("comment: %+v", resp.Subresponses[0].Error)
	}

	return simpleSeed{ProjectID: pid, TaskID: tid, MilestoneID: mid, ComponentID: cid, TagID: tagID}
}

// fetchCSV calls the export endpoint and returns the parsed rows
// (including the header).
func fetchCSV(t *testing.T, handler http.Handler, projectID int64, includeDeleted bool) (int, http.Header, [][]string) {
	t.Helper()
	url := fmt.Sprintf("/api/v1/project/%d/export.csv", projectID)
	if includeDeleted {
		url += "?include_deleted=1"
	}
	req := httptest.NewRequest("GET", url, nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	body, _ := io.ReadAll(rr.Body)
	if rr.Code != http.StatusOK {
		return rr.Code, rr.Header(), [][]string{{string(body)}}
	}
	cr := csv.NewReader(strings.NewReader(string(body)))
	cr.FieldsPerRecord = -1
	records, err := cr.ReadAll()
	if err != nil {
		t.Fatalf("parse csv: %v (body=%q)", err, body)
	}
	return rr.Code, rr.Header(), records
}

// TestExportCSV_PopulatedProject covers the happy-path columns.
func TestExportCSV_PopulatedProject(t *testing.T) {
	handler, srv := setup(t, "kitp_test_export_pop")
	s := seedSimpleProject(t, srv)

	code, hdr, records := fetchCSV(t, handler, s.ProjectID, false)
	if code != http.StatusOK {
		t.Fatalf("status: got %d, want 200; body=%v", code, records)
	}
	if ct := hdr.Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Errorf("Content-Type: got %q", ct)
	}
	if !strings.Contains(hdr.Get("Content-Disposition"), "demo-project") {
		t.Errorf("Content-Disposition: missing slug; got %q", hdr.Get("Content-Disposition"))
	}
	if len(records) != 2 {
		t.Fatalf("rows: got %d, want 2 (header + 1 task)", len(records))
	}
	wantHeader := []string{
		"id", "title", "assignee_email", "assignee_name",
		"milestone", "component", "tags", "description", "sort_order",
		"created_at", "deleted_at", "comments",
	}
	if !equalSlices(records[0], wantHeader) {
		t.Fatalf("header: got %v, want %v", records[0], wantHeader)
	}
	row := records[1]
	if row[0] != fmt.Sprintf("%d", s.TaskID) {
		t.Errorf("id: got %q, want %d", row[0], s.TaskID)
	}
	if row[1] != "Wire pickers" {
		t.Errorf("title: got %q", row[1])
	}
	// System person's title is "System" with NULL email; the column
	// should render as the title and an empty email.
	if row[2] != "" {
		t.Errorf("assignee_email: got %q, want empty", row[2])
	}
	if row[3] != "System" {
		t.Errorf("assignee_name: got %q, want System", row[3])
	}
	if row[4] != "M1" {
		t.Errorf("milestone: got %q", row[4])
	}
	if row[5] != "Frontend" {
		t.Errorf("component: got %q", row[5])
	}
	if row[6] != "priority/high" {
		t.Errorf("tags: got %q", row[6])
	}
	if row[7] != "Replace ad-hoc pickers" {
		t.Errorf("description: got %q", row[7])
	}
	if row[8] != "100" {
		t.Errorf("sort_order: got %q, want 100", row[8])
	}
	if row[9] == "" {
		t.Errorf("created_at: missing")
	}
	if row[10] != "" {
		t.Errorf("deleted_at: got %q, want empty (task is live)", row[10])
	}
	if row[11] != "first pass looks good" {
		t.Errorf("comments: got %q", row[11])
	}
}

// TestExportCSV_EmptyProject: the response is well-formed (header
// only) when the project has no tasks.
func TestExportCSV_EmptyProject(t *testing.T) {
	handler, srv := setup(t, "kitp_test_export_empty")
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

	code, _, records := fetchCSV(t, handler, o.ID, false)
	if code != http.StatusOK {
		t.Fatalf("status: %d", code)
	}
	if len(records) != 1 {
		t.Fatalf("rows: got %d, want 1 (header only)", len(records))
	}
}

// TestExportCSV_DeletedToggle: soft-deleted tasks are excluded by
// default and included when ?include_deleted=1.
func TestExportCSV_DeletedToggle(t *testing.T) {
	handler, srv := setup(t, "kitp_test_export_del")
	ctx := auth.WithSystemUser(context.Background())
	s := seedSimpleProject(t, srv)

	// Soft-delete the task.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "d", Endpoint: "card", Action: "delete", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d"}`, s.TaskID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("delete: %+v", resp.Subresponses[0].Error)
	}

	// Default: deleted tasks excluded -> 1 row (header).
	code, _, records := fetchCSV(t, handler, s.ProjectID, false)
	if code != http.StatusOK || len(records) != 1 {
		t.Fatalf("default excl: code=%d rows=%d", code, len(records))
	}

	// include_deleted=1 -> 2 rows; the deleted_at column should be
	// non-empty for the soft-deleted row.
	code, _, records = fetchCSV(t, handler, s.ProjectID, true)
	if code != http.StatusOK || len(records) != 2 {
		t.Fatalf("include: code=%d rows=%d", code, len(records))
	}
	if records[1][11] == "" {
		t.Errorf("deleted_at: expected non-empty for soft-deleted task")
	}
}

// TestExportCSV_NotFound: a non-existent project returns 404.
func TestExportCSV_NotFound(t *testing.T) {
	handler, _ := setup(t, "kitp_test_export_404")
	code, _, body := fetchCSV(t, handler, 999_999_999, false)
	if code != http.StatusNotFound {
		t.Fatalf("status: got %d, want 404 (body=%v)", code, body)
	}
}

// TestExportCSV_MultipleComments: multiple comments on a single task
// join into one cell separated by `\n---\n`.
func TestExportCSV_MultipleComments(t *testing.T) {
	handler, srv := setup(t, "kitp_test_export_cmts")
	ctx := auth.WithSystemUser(context.Background())
	s := seedSimpleProject(t, srv)

	for _, body := range []string{"second", "third"} {
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "cm", Endpoint: "comment", Action: "insert", Data: json.RawMessage(
				fmt.Sprintf(`{"card_id":"%d","body":%q}`, s.TaskID, body))},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("comment: %+v", resp.Subresponses[0].Error)
		}
	}
	_, _, records := fetchCSV(t, handler, s.ProjectID, false)
	if len(records) != 2 {
		t.Fatalf("rows: %d", len(records))
	}
	got := records[1][11]
	want := "first pass looks good\n---\nsecond\n---\nthird"
	if got != want {
		t.Errorf("comments: got %q, want %q", got, want)
	}
}

func equalSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
