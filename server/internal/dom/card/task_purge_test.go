package card_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/store"
)

// purgeFixture is the small per-test state for task.purge cases. Each
// test calls seedPurgeScene to materialise a project + status + task,
// then drives task.purge through the dispatcher.
type purgeFixture struct {
	srv       *api.Server
	sp        *store.Pool
	projectID int64
	statusID  int64
	taskID    int64
}

func seedPurgeScene(t *testing.T, schemaName string) purgeFixture {
	t.Helper()
	srv, sp := setupAttr(t, schemaName)
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
	f := purgeFixture{srv: srv, sp: sp}
	f.projectID = insert("p", `{"card_type_name":"project","title":"P"}`)
	f.statusID = insert("s", fmt.Sprintf(
		`{"card_type_name":"status","parent_card_id":"%d","title":"Open"}`, f.projectID))
	f.taskID = insert("t", fmt.Sprintf(`{
		"card_type_name":"task","parent_card_id":"%d","title":"To purge",
		"attributes":{"status":"%d","description":"body"}
	}`, f.projectID, f.statusID))
	return f
}

// dispatchPurge drives one happy-path task.purge.
func dispatchPurge(t *testing.T, srv *api.Server, body string) card.TaskPurgeOutput {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "pg", Endpoint: "task", Action: "purge", Data: json.RawMessage(body)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("task.purge: %+v\nbody=%s", resp.Subresponses[0].Error, body)
	}
	var out card.TaskPurgeOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &out)
	return out
}

// dispatchPurgeErr expects the operation to fail and returns the
// surfaced error code.
func dispatchPurgeErr(t *testing.T, srv *api.Server, body string) string {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "pg", Endpoint: "task", Action: "purge", Data: json.RawMessage(body)},
	}})
	if resp.Subresponses[0].OK {
		t.Fatalf("expected task.purge to fail; got OK: %+v", resp.Subresponses[0])
	}
	if resp.Subresponses[0].Error == nil {
		return ""
	}
	return resp.Subresponses[0].Error.Code
}

// countOn returns SELECT COUNT(*) for a small assertion query.
func countOn(t *testing.T, sp *store.Pool, query string, args ...any) int {
	t.Helper()
	var n int
	if err := sp.P.QueryRow(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

// TestTaskPurge_HappyPath confirms the row is gone, every dependent
// row on the task is gone, and the returned id list trails with the
// purged task's id.
func TestTaskPurge_HappyPath(t *testing.T) {
	f := seedPurgeScene(t, "kitp_test_task_purge_happy")
	// Seed one attachment via direct SQL — the public path needs
	// chunk upload + file.create which is overkill for an existence
	// assertion. The cascade should strip it.
	if _, err := f.sp.P.Exec(context.Background(), `
		INSERT INTO cas_blob (address, size_bytes, mime_type, storage_kind)
		VALUES ('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 4, 'text/plain', 'pg')
		ON CONFLICT DO NOTHING
	`); err != nil {
		t.Fatalf("cas_blob: %v", err)
	}
	var fileID int64
	if err := f.sp.P.QueryRow(context.Background(), `
		INSERT INTO file (filename, size_bytes, mime_type, created_by, sha256)
		VALUES ('x.txt', 4, 'text/plain', 1,
		        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
		RETURNING id
	`).Scan(&fileID); err != nil {
		t.Fatalf("file: %v", err)
	}
	if _, err := f.sp.P.Exec(context.Background(), `
		INSERT INTO file_chunk (file_id, seq, cas_address, chunk_size)
		VALUES ($1, 0, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 4)
	`, fileID); err != nil {
		t.Fatalf("file_chunk: %v", err)
	}
	if _, err := f.sp.P.Exec(context.Background(), `
		INSERT INTO attachment (card_id, file_id) VALUES ($1, $2)
	`, f.taskID, fileID); err != nil {
		t.Fatalf("attachment: %v", err)
	}

	out := dispatchPurge(t, f.srv, fmt.Sprintf(`{"card_id":"%d"}`, f.taskID))
	if !out.OK {
		t.Fatalf("out.OK: %+v", out)
	}
	if len(out.PurgedCardIDs) == 0 ||
		out.PurgedCardIDs[len(out.PurgedCardIDs)-1] != f.taskID {
		t.Fatalf("PurgedCardIDs %v: should end with task id %d",
			out.PurgedCardIDs, f.taskID)
	}

	if got := countOn(t, f.sp, `SELECT count(*) FROM card WHERE id = $1`, f.taskID); got != 0 {
		t.Errorf("card row remains: %d", got)
	}
	if got := countOn(t, f.sp, `SELECT count(*) FROM attribute_value WHERE card_id = $1`, f.taskID); got != 0 {
		t.Errorf("attribute_value rows remain: %d", got)
	}
	if got := countOn(t, f.sp, `SELECT count(*) FROM activity WHERE card_id = $1`, f.taskID); got != 0 {
		t.Errorf("activity rows remain: %d", got)
	}
	if got := countOn(t, f.sp, `SELECT count(*) FROM attachment WHERE card_id = $1`, f.taskID); got != 0 {
		t.Errorf("attachment rows remain: %d", got)
	}
}

// TestTaskPurge_RefusesNonTask confirms the handler refuses to wipe
// non-task cards (a project/status passed in by id would otherwise
// be destructive).
func TestTaskPurge_RefusesNonTask(t *testing.T) {
	f := seedPurgeScene(t, "kitp_test_task_purge_non_task")
	code := dispatchPurgeErr(t, f.srv, fmt.Sprintf(`{"card_id":"%d"}`, f.projectID))
	if code != "wrong_card_type" {
		t.Errorf("code: got %q, want wrong_card_type", code)
	}
}

// TestTaskPurge_RefusesLiveSubtasks confirms the "clean up children
// first" gate when a sub-task points at the target via parent_task.
func TestTaskPurge_RefusesLiveSubtasks(t *testing.T) {
	f := seedPurgeScene(t, "kitp_test_task_purge_subtasks")
	ctx := auth.WithSystemUser(context.Background())
	resp := f.srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "child", Endpoint: "card", Action: "insert", Data: json.RawMessage(fmt.Sprintf(`{
			"card_type_name":"task","parent_card_id":"%d","title":"child",
			"attributes":{"status":"%d","parent_task":"%d"}
		}`, f.projectID, f.statusID, f.taskID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("seed child: %+v", resp.Subresponses[0].Error)
	}
	code := dispatchPurgeErr(t, f.srv, fmt.Sprintf(`{"card_id":"%d"}`, f.taskID))
	if code != "has_live_subtasks" {
		t.Errorf("code: got %q, want has_live_subtasks", code)
	}
}

// TestTaskPurge_RefusesWorker confirms the role gate. Workers can
// soft-delete via card.delete but should not be able to purge.
func TestTaskPurge_RefusesWorker(t *testing.T) {
	f := seedPurgeScene(t, "kitp_test_task_purge_worker")
	ctx := context.Background()
	var workerID int64
	if err := f.sp.P.QueryRow(ctx, `
		INSERT INTO user_account (display_name) VALUES ('worker-1') RETURNING id
	`).Scan(&workerID); err != nil {
		t.Fatalf("worker user: %v", err)
	}
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name='worker'
	`, workerID); err != nil {
		t.Fatalf("worker grant: %v", err)
	}
	workerCtx := auth.WithUser(ctx, &auth.UserCtx{ID: workerID, DisplayName: "worker-1"})
	resp := f.srv.Dispatch(workerCtx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "pg", Endpoint: "task", Action: "purge", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d"}`, f.taskID))},
	}})
	if resp.Subresponses[0].OK {
		t.Fatal("worker should be unauthorized for task.purge")
	}
}
