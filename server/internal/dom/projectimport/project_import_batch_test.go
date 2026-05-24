// Direct PL/pgSQL tests for the four project.import.* batch
// functions (Phase 4 of docs/UNIFIED_HANDLER_PLAN.md). These exercise
// the SQL functions over `pool.Query` — separate from the dispatcher-
// driven integration tests in projectimport_test.go / commit_test.go,
// which still run unchanged and validate the PreRun hook + SQLFunc
// wiring end-to-end.
package projectimport_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

// resultRow mirrors the function's RETURNS TABLE shape.
type resultRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callBatch(t *testing.T, pool *pgxpool.Pool, funcName string, actorID int64, inputs any) []resultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	q := fmt.Sprintf(`SELECT idx, ok, code, message, result
	                  FROM %s($1::bigint, $2::jsonb) ORDER BY idx`, funcName)
	rows, err := pool.Query(context.Background(), q, actorID, body)
	if err != nil {
		t.Fatalf("query %s: %v", funcName, err)
	}
	defer rows.Close()
	var out []resultRow
	for rows.Next() {
		var r resultRow
		var resJSON []byte
		if err := rows.Scan(&r.Idx, &r.OK, &r.Code, &r.Message, &resJSON); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if len(resJSON) > 0 {
			r.Result = json.RawMessage(append([]byte(nil), resJSON...))
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows.Err: %v", err)
	}
	return out
}

// seedProject builds a project card directly via card_insert_batch so
// the PL/pgSQL tests can stand up the surface they need without
// pulling in the full dispatcher / domain setup. Returns the new
// project's card id.
func seedProject(t *testing.T, pool *pgxpool.Pool, title string) int64 {
	t.Helper()
	rows := callBatch(t, pool, "card_insert_batch", auth.SystemUserID,
		[]map[string]any{{"card_type_name": "project", "title": title}})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("seed project %q: %+v", title, rows)
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rows[0].Result, &out); err != nil {
		t.Fatalf("decode project id: %v", err)
	}
	var id int64
	if _, err := fmt.Sscanf(out.ID, "%d", &id); err != nil {
		t.Fatalf("parse project id %q: %v", out.ID, err)
	}
	// Seed a status under the project so subsequent task inserts have
	// somewhere to land (mirrors makeProject in projectimport_test.go).
	srows := callBatch(t, pool, "card_insert_batch", auth.SystemUserID,
		[]map[string]any{{
			"card_type_name": "status",
			"parent_card_id": out.ID,
			"title":          "Todo",
		}})
	if len(srows) != 1 || !srows[0].OK {
		t.Fatalf("seed status: %+v", srows)
	}
	return id
}

// seedImportJob writes an import_job row directly so the SQL function
// tests don't need to round-trip through project_import_upload_batch
// (those are exercised in their own test). Returns the job id.
func seedImportJob(t *testing.T, pool *pgxpool.Pool, projectID int64, status string, mapping map[string]string, resolution map[string]any) int64 {
	t.Helper()
	mb, _ := json.Marshal(mapping)
	rb, _ := json.Marshal(resolution)
	if mapping == nil {
		mb = []byte("null")
	}
	if resolution == nil {
		rb = []byte("null")
	}
	var id int64
	err := pool.QueryRow(context.Background(), `
		INSERT INTO import_job (project_id, file_id, status, mapping, resolution, created_by)
		VALUES ($1, 0, $2, $3::jsonb, $4::jsonb, $5)
		RETURNING id
	`, projectID, status, mb, rb, auth.SystemUserID).Scan(&id)
	if err != nil {
		// file_id has an FK on file.id; insert a placeholder file row
		// when the FK rejects 0. We deliberately use a real file row
		// because preview / commit batches never read CSV bytes
		// (PreRun hook does that on the Go side).
		var fid int64
		if err2 := pool.QueryRow(context.Background(), `
			INSERT INTO file (filename, size_bytes, mime_type, created_by, sha256)
			VALUES ('placeholder.csv', 0, 'text/csv', $1, NULL)
			RETURNING id
		`, auth.SystemUserID).Scan(&fid); err2 != nil {
			t.Fatalf("seed file: %v", err2)
		}
		if err2 := pool.QueryRow(context.Background(), `
			INSERT INTO import_job (project_id, file_id, status, mapping, resolution, created_by)
			VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
			RETURNING id
		`, projectID, fid, status, mb, rb, auth.SystemUserID).Scan(&id); err2 != nil {
			t.Fatalf("seed import_job: %v", err2)
		}
		return id
	}
	return id
}

/* -------------------------------------------------------------------------- */
/* project_import_upload_batch                                                */
/* -------------------------------------------------------------------------- */

// TestProjectImportUploadBatch_Happy — happy path: the function
// accepts pre-parsed CSV fields and inserts an import_job row.
func TestProjectImportUploadBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_project_import_upload_happy")
	pid := seedProject(t, pool, "U Demo")
	// Build a placeholder file row so file_id has something real.
	var fid int64
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO file (filename, size_bytes, mime_type, created_by)
		VALUES ('a.csv', 5, 'text/csv', $1) RETURNING id
	`, auth.SystemUserID).Scan(&fid); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	rows := callBatch(t, pool, "project_import_upload_batch", auth.SystemUserID,
		[]map[string]any{{
			"project_id":           fmt.Sprintf("%d", pid),
			"file_id":              fmt.Sprintf("%d", fid),
			"_parsed_headers":      []string{"title", "milestone"},
			"_parsed_preview_rows": [][]string{{"A", "M1"}, {"B", "M2"}},
			"_parsed_row_count":    2,
		}})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	r := rows[0]
	if !r.OK {
		t.Fatalf("want ok; got code=%q msg=%q", r.Code, r.Message)
	}
	var out struct {
		JobID       string     `json:"job_id"`
		Headers     []string   `json:"headers"`
		PreviewRows [][]string `json:"preview_rows"`
		RowCount    int        `json:"row_count"`
	}
	if err := json.Unmarshal(r.Result, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.JobID == "" || out.RowCount != 2 || len(out.Headers) != 2 {
		t.Errorf("result fields wrong: %+v", out)
	}
}

// TestProjectImportUploadBatch_MissingProject — project_id pointing at
// a non-existent card surfaces code=project_not_found.
func TestProjectImportUploadBatch_MissingProject(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_project_import_upload_missing")
	rows := callBatch(t, pool, "project_import_upload_batch", auth.SystemUserID,
		[]map[string]any{{
			"project_id": "999999999",
			"file_id":    "1",
		}})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want one failed row: %+v", rows)
	}
	if rows[0].Code != "project_not_found" {
		t.Errorf("code=%q, want project_not_found", rows[0].Code)
	}
}

// TestProjectImportUploadBatch_Validation — missing project_id or
// file_id surfaces code=validation.
func TestProjectImportUploadBatch_Validation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_project_import_upload_validation")
	rows := callBatch(t, pool, "project_import_upload_batch", auth.SystemUserID,
		[]map[string]any{{"project_id": "0", "file_id": "0"}})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want failed: %+v", rows)
	}
	if rows[0].Code != "validation" {
		t.Errorf("code=%q, want validation", rows[0].Code)
	}
}

/* -------------------------------------------------------------------------- */
/* project_import_set_mapping_batch                                           */
/* -------------------------------------------------------------------------- */

// TestProjectImportSetMappingBatch_Happy — UPDATE advances status
// from 'uploaded' to 'mapped' and writes the JSONB.
func TestProjectImportSetMappingBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_project_import_set_mapping_happy")
	pid := seedProject(t, pool, "SM Happy")
	jobID := seedImportJob(t, pool, pid, "uploaded", nil, nil)
	rows := callBatch(t, pool, "project_import_set_mapping_batch", auth.SystemUserID,
		[]map[string]any{{
			"job_id":  fmt.Sprintf("%d", jobID),
			"mapping": map[string]string{"title": "title"},
		}})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("want ok: %+v", rows)
	}
	var out struct {
		OK     bool   `json:"ok"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(rows[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Status != "mapped" {
		t.Errorf("status=%q, want mapped", out.Status)
	}
	// Verify the JSONB landed on the row.
	var stored string
	if err := pool.QueryRow(context.Background(),
		`SELECT mapping::text FROM import_job WHERE id = $1`, jobID,
	).Scan(&stored); err != nil {
		t.Fatalf("read mapping: %v", err)
	}
	if !strings.Contains(stored, `"title": "title"`) {
		t.Errorf("mapping stored: %q", stored)
	}
}

// TestProjectImportSetMappingBatch_NotFound — unknown job_id surfaces
// code=job_not_found.
func TestProjectImportSetMappingBatch_NotFound(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_project_import_set_mapping_notfound")
	rows := callBatch(t, pool, "project_import_set_mapping_batch", auth.SystemUserID,
		[]map[string]any{{
			"job_id":  "999999999",
			"mapping": map[string]string{"title": "title"},
		}})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want failed: %+v", rows)
	}
	if rows[0].Code != "job_not_found" {
		t.Errorf("code=%q, want job_not_found", rows[0].Code)
	}
}

// TestProjectImportSetMappingBatch_PreservesPostMapStatus — status
// already past 'mapped' holds; only the mapping changes.
func TestProjectImportSetMappingBatch_PreservesPostMapStatus(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_project_import_set_mapping_post")
	pid := seedProject(t, pool, "SM Post")
	jobID := seedImportJob(t, pool, pid, "previewed",
		map[string]string{"title": "title"}, nil)
	rows := callBatch(t, pool, "project_import_set_mapping_batch", auth.SystemUserID,
		[]map[string]any{{
			"job_id":  fmt.Sprintf("%d", jobID),
			"mapping": map[string]string{"title": "title", "x": "_ignore_"},
		}})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("want ok: %+v", rows)
	}
	var out struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(rows[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Status != "previewed" {
		t.Errorf("status=%q, want previewed (not overwritten)", out.Status)
	}
}

/* -------------------------------------------------------------------------- */
/* project_import_preview_batch                                               */
/* -------------------------------------------------------------------------- */

// TestProjectImportPreviewBatch_Happy — preview a single-row CSV
// with match_existing for milestones; the row's milestone is unknown
// so the error log carries one entry. Status is 'previewed'.
func TestProjectImportPreviewBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_project_import_preview_happy")
	pid := seedProject(t, pool, "PV Happy")
	jobID := seedImportJob(t, pool, pid, "mapped",
		map[string]string{"title": "title", "milestone": "milestone"}, nil)
	rows := callBatch(t, pool, "project_import_preview_batch", auth.SystemUserID,
		[]map[string]any{{
			"job_id":         fmt.Sprintf("%d", jobID),
			"resolution":     map[string]any{"milestones": "match_existing"},
			"_parsed_header": []string{"title", "milestone"},
			"_parsed_rows":   [][]string{{"Task", "Sprint A"}},
		}})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("want ok: %+v", rows)
	}
	var out struct {
		WouldCreate struct {
			Tasks int `json:"tasks"`
		} `json:"would_create"`
		Errors []struct {
			Row     int    `json:"row"`
			Column  string `json:"column"`
			Message string `json:"message"`
		} `json:"errors"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(rows[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Status != "previewed" {
		t.Errorf("status=%q, want previewed", out.Status)
	}
	if len(out.Errors) == 0 {
		t.Errorf("expected unknown-milestone error; got %+v", out.Errors)
	}
}

// TestProjectImportPreviewBatch_SkipMode — components mode=skip
// drops the row but doesn't surface an error.
func TestProjectImportPreviewBatch_SkipMode(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_project_import_preview_skip")
	pid := seedProject(t, pool, "PV Skip")
	jobID := seedImportJob(t, pool, pid, "mapped",
		map[string]string{"title": "title", "component": "component"}, nil)
	rows := callBatch(t, pool, "project_import_preview_batch", auth.SystemUserID,
		[]map[string]any{{
			"job_id":         fmt.Sprintf("%d", jobID),
			"resolution":     map[string]any{"components": "skip"},
			"_parsed_header": []string{"title", "component"},
			"_parsed_rows":   [][]string{{"Keep", ""}, {"Drop", "Frontend"}, {"Keep2", ""}},
		}})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("want ok: %+v", rows)
	}
	var out struct {
		WouldCreate struct {
			Tasks int `json:"tasks"`
		} `json:"would_create"`
		SkippedRows int `json:"skipped_rows"`
	}
	if err := json.Unmarshal(rows[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.WouldCreate.Tasks != 2 || out.SkippedRows != 1 {
		t.Errorf("would_create.tasks=%d skipped=%d; want 2/1", out.WouldCreate.Tasks, out.SkippedRows)
	}
}

// TestProjectImportPreviewBatch_NoMapping — mapping=NULL fails with
// code=no_mapping.
func TestProjectImportPreviewBatch_NoMapping(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_project_import_preview_nomap")
	pid := seedProject(t, pool, "PV NoMap")
	jobID := seedImportJob(t, pool, pid, "uploaded", nil, nil)
	rows := callBatch(t, pool, "project_import_preview_batch", auth.SystemUserID,
		[]map[string]any{{
			"job_id":         fmt.Sprintf("%d", jobID),
			"resolution":     map[string]any{},
			"_parsed_header": []string{"title"},
			"_parsed_rows":   [][]string{{"X"}},
		}})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want failed: %+v", rows)
	}
	if rows[0].Code != "no_mapping" {
		t.Errorf("code=%q, want no_mapping", rows[0].Code)
	}
}

/* -------------------------------------------------------------------------- */
/* project_import_commit_batch                                                */
/* -------------------------------------------------------------------------- */

// TestProjectImportCommitBatch_Happy — single-row commit lands a
// task and marks the job 'completed'.
func TestProjectImportCommitBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_project_import_commit_happy")
	pid := seedProject(t, pool, "C Happy")
	jobID := seedImportJob(t, pool, pid, "previewed",
		map[string]string{"title": "title"},
		map[string]any{})
	rows := callBatch(t, pool, "project_import_commit_batch", auth.SystemUserID,
		[]map[string]any{{
			"job_id":         fmt.Sprintf("%d", jobID),
			"_parsed_header": []string{"title"},
			"_parsed_rows":   [][]string{{"One row"}},
		}})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("want ok: %+v", rows)
	}
	var out struct {
		Created struct {
			Tasks int `json:"tasks"`
		} `json:"created"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(rows[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Created.Tasks != 1 || out.Status != "completed" {
		t.Errorf("created.tasks=%d status=%q; want 1/completed", out.Created.Tasks, out.Status)
	}
	// Job row matches.
	var jobStatus string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM import_job WHERE id = $1`, jobID,
	).Scan(&jobStatus); err != nil {
		t.Fatalf("read job: %v", err)
	}
	if jobStatus != "completed" {
		t.Errorf("job status=%q, want completed", jobStatus)
	}
}

// TestProjectImportCommitBatch_MultiRow — three rows, all happy:
// three tasks created.
func TestProjectImportCommitBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_project_import_commit_multi")
	pid := seedProject(t, pool, "C Multi")
	jobID := seedImportJob(t, pool, pid, "previewed",
		map[string]string{"title": "title"},
		map[string]any{})
	rows := callBatch(t, pool, "project_import_commit_batch", auth.SystemUserID,
		[]map[string]any{{
			"job_id":         fmt.Sprintf("%d", jobID),
			"_parsed_header": []string{"title"},
			"_parsed_rows":   [][]string{{"T1"}, {"T2"}, {"T3"}},
		}})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("want ok: %+v", rows)
	}
	var out struct {
		Created struct {
			Tasks int `json:"tasks"`
		} `json:"created"`
	}
	if err := json.Unmarshal(rows[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Created.Tasks != 3 {
		t.Errorf("created.tasks=%d, want 3", out.Created.Tasks)
	}
}

// TestProjectImportCommitBatch_BadRowAborts — one row references an
// unknown milestone under match_existing; the whole commit aborts
// with code=import_validation. No tasks land.
func TestProjectImportCommitBatch_BadRowAborts(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_project_import_commit_bad")
	pid := seedProject(t, pool, "C Bad")
	jobID := seedImportJob(t, pool, pid, "previewed",
		map[string]string{"title": "title", "milestone": "milestone"},
		map[string]any{"milestones": "match_existing"})
	rows := callBatch(t, pool, "project_import_commit_batch", auth.SystemUserID,
		[]map[string]any{{
			"job_id":         fmt.Sprintf("%d", jobID),
			"_parsed_header": []string{"title", "milestone"},
			"_parsed_rows":   [][]string{{"OK", ""}, {"BAD", "nonexistent"}},
		}})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want failed: %+v", rows)
	}
	if rows[0].Code != "import_validation" {
		t.Errorf("code=%q, want import_validation", rows[0].Code)
	}
	// Confirm no tasks landed.
	var n int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'task'
		WHERE c.parent_card_id = $1
	`, pid).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Errorf("tasks landed before abort: %d", n)
	}
}

// TestProjectImportCommitBatch_AlreadyCompleted — re-committing a
// completed job returns code=already_committed.
func TestProjectImportCommitBatch_AlreadyCompleted(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_project_import_commit_rerun")
	pid := seedProject(t, pool, "C Rerun")
	jobID := seedImportJob(t, pool, pid, "completed",
		map[string]string{"title": "title"},
		map[string]any{})
	rows := callBatch(t, pool, "project_import_commit_batch", auth.SystemUserID,
		[]map[string]any{{
			"job_id":         fmt.Sprintf("%d", jobID),
			"_parsed_header": []string{"title"},
			"_parsed_rows":   [][]string{{"One"}},
		}})
	if len(rows) != 1 || rows[0].OK {
		t.Fatalf("want failed: %+v", rows)
	}
	if rows[0].Code != "already_committed" {
		t.Errorf("code=%q, want already_committed", rows[0].Code)
	}
}
