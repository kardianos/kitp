package projectexport_test

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/xuri/excelize/v2"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/card"
)

// seedTwoMilestoneTasks builds a project with two distinct milestones
// and one task pointing at each. Returns the project id, the milestone
// ids by title, and the task ids by title — enough to write filter
// assertions ("only the task with milestone X").
type twoMilestoneSeed struct {
	ProjectID    int64
	MilestoneIDs map[string]int64
	TaskIDs      map[string]int64
}

func seedTwoMilestoneTasks(t *testing.T, srv *api.Server) twoMilestoneSeed {
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
	pid := insert("p", `{"card_type_name":"project","title":"Filter Demo"}`)
	sid := insert("s", fmt.Sprintf(
		`{"card_type_name":"status","parent_card_id":"%d","title":"Todo"}`, pid))
	mOne := insert("m1", fmt.Sprintf(
		`{"card_type_name":"milestone","parent_card_id":"%d","title":"Alpha"}`, pid))
	mTwo := insert("m2", fmt.Sprintf(
		`{"card_type_name":"milestone","parent_card_id":"%d","title":"Beta"}`, pid))
	tOne := insert("t1", fmt.Sprintf(`{
		"card_type_name":"task","parent_card_id":"%d","title":"In Alpha",
		"attributes":{"status":"%d","milestone_ref":"%d"}
	}`, pid, sid, mOne))
	tTwo := insert("t2", fmt.Sprintf(`{
		"card_type_name":"task","parent_card_id":"%d","title":"In Beta",
		"attributes":{"status":"%d","milestone_ref":"%d"}
	}`, pid, sid, mTwo))
	return twoMilestoneSeed{
		ProjectID:    pid,
		MilestoneIDs: map[string]int64{"Alpha": mOne, "Beta": mTwo},
		TaskIDs:      map[string]int64{"In Alpha": tOne, "In Beta": tTwo},
	}
}

// fetchExport drives a single GET against the export route with the
// supplied query string and returns the raw bytes (plus status +
// headers).
func fetchExport(t *testing.T, handler http.Handler, suffix string, query url.Values) (int, http.Header, []byte) {
	t.Helper()
	u := "/api/v1/project/" + query.Get("__pid") + "/export." + suffix
	q := url.Values{}
	for k, v := range query {
		if k == "__pid" {
			continue
		}
		q[k] = v
	}
	if encoded := q.Encode(); encoded != "" {
		u += "?" + encoded
	}
	req := httptest.NewRequest("GET", u, nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	body, _ := io.ReadAll(rr.Body)
	return rr.Code, rr.Header(), body
}

// TestExportCSV_TreeFilter confirms the `tree` query param narrows
// the exported task set to rows matching the predicate. Uses a
// milestone_ref equality leaf to pick one of two seeded tasks.
func TestExportCSV_TreeFilter(t *testing.T) {
	handler, srv := setup(t, "kitp_test_export_tree_csv")
	s := seedTwoMilestoneTasks(t, srv)

	// `milestone_ref = <Alpha id>` — should leave only "In Alpha".
	tree := fmt.Sprintf(
		`{"connective":"and","children":[{"attr":"milestone_ref","op":"=","values":["%d"]}]}`,
		s.MilestoneIDs["Alpha"])
	q := url.Values{}
	q.Set("__pid", fmt.Sprintf("%d", s.ProjectID))
	q.Set("tree", tree)
	code, _, body := fetchExport(t, handler, "csv", q)
	if code != http.StatusOK {
		t.Fatalf("status: got %d (body=%s)", code, body)
	}

	cr := csv.NewReader(strings.NewReader(string(body)))
	cr.FieldsPerRecord = -1
	records, err := cr.ReadAll()
	if err != nil {
		t.Fatalf("parse csv: %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("rows: got %d, want 2 (header + 1 task); body=%s", len(records), body)
	}
	// records[0] is the header; records[1] is the matching task. Column 1
	// is the title.
	if records[1][1] != "In Alpha" {
		t.Errorf("title: got %q, want %q (full row=%v)", records[1][1], "In Alpha", records[1])
	}
}

// TestExportCSV_BadTree confirms an invalid `tree` payload surfaces as
// a 400 instead of silently exporting unfiltered rows.
func TestExportCSV_BadTree(t *testing.T) {
	handler, srv := setup(t, "kitp_test_export_bad_tree")
	s := seedTwoMilestoneTasks(t, srv)
	q := url.Values{}
	q.Set("__pid", fmt.Sprintf("%d", s.ProjectID))
	q.Set("tree", "not-json")
	code, _, body := fetchExport(t, handler, "csv", q)
	if code != http.StatusBadRequest {
		t.Fatalf("status: got %d, want 400 (body=%s)", code, body)
	}
}

// TestExportXLSX_Populated exercises the .xlsx route end-to-end:
// status 200, Content-Type, single "Tasks" sheet, header row, and
// one data row per seeded task.
func TestExportXLSX_Populated(t *testing.T) {
	handler, srv := setup(t, "kitp_test_export_xlsx_pop")
	s := seedTwoMilestoneTasks(t, srv)
	q := url.Values{}
	q.Set("__pid", fmt.Sprintf("%d", s.ProjectID))
	code, hdr, body := fetchExport(t, handler, "xlsx", q)
	if code != http.StatusOK {
		t.Fatalf("status: got %d (body=%s)", code, body)
	}
	const wantCT = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	if ct := hdr.Get("Content-Type"); ct != wantCT {
		t.Errorf("Content-Type: got %q, want %q", ct, wantCT)
	}
	if !strings.Contains(hdr.Get("Content-Disposition"), "filter-demo") {
		t.Errorf("Content-Disposition: missing slug; got %q", hdr.Get("Content-Disposition"))
	}

	f, err := excelize.OpenReader(strings.NewReader(string(body)))
	if err != nil {
		t.Fatalf("open xlsx: %v", err)
	}
	defer func() { _ = f.Close() }()
	sheets := f.GetSheetList()
	if len(sheets) != 1 || sheets[0] != "Tasks" {
		t.Fatalf("sheets: got %v, want [Tasks]", sheets)
	}
	rows, err := f.GetRows("Tasks")
	if err != nil {
		t.Fatalf("get rows: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3 (header + 2 tasks)", len(rows))
	}
	if rows[0][0] != "id" || rows[0][1] != "title" {
		t.Errorf("header row mismatch: %v", rows[0])
	}
}

// TestExportXLSX_TreeFilter confirms the `tree` param applies to the
// xlsx route too (same code path as the CSV — verified via a row
// count).
func TestExportXLSX_TreeFilter(t *testing.T) {
	handler, srv := setup(t, "kitp_test_export_xlsx_tree")
	s := seedTwoMilestoneTasks(t, srv)
	tree := fmt.Sprintf(
		`{"connective":"and","children":[{"attr":"milestone_ref","op":"=","values":["%d"]}]}`,
		s.MilestoneIDs["Beta"])
	q := url.Values{}
	q.Set("__pid", fmt.Sprintf("%d", s.ProjectID))
	q.Set("tree", tree)
	code, _, body := fetchExport(t, handler, "xlsx", q)
	if code != http.StatusOK {
		t.Fatalf("status: got %d (body=%s)", code, body)
	}
	f, err := excelize.OpenReader(strings.NewReader(string(body)))
	if err != nil {
		t.Fatalf("open xlsx: %v", err)
	}
	defer func() { _ = f.Close() }()
	rows, err := f.GetRows("Tasks")
	if err != nil {
		t.Fatalf("get rows: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows: got %d, want 2 (header + 1 task)", len(rows))
	}
	if rows[1][1] != "In Beta" {
		t.Errorf("title: got %q, want %q", rows[1][1], "In Beta")
	}
}

// keep the unused-import lint quiet by referencing card transitively
// (the test relies on its registration in setup()).
var _ = card.InsertOutput{}
