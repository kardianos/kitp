package card_test

// Round-8 #11: task.move and the writes that name the moved task. The move
// locks the task (and each subtask it carries) before it reads anything;
// attribute.update holds its card, and card.insert / attribute.update hold
// every card they name, FOR SHARE. A write that comes during the move waits
// for it and then checks against where the task is now.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
)

// r9WaitBlocked waits until some backend is blocked behind pid.
func r9WaitBlocked(t *testing.T, pool *pgxpool.Pool, pid int32, want int) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		var n int
		if err := pool.QueryRow(context.Background(),
			`SELECT count(*) FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))`, pid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n >= want {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("fewer than %d blocked on pid %d", want, pid)
}

func TestWritesDuringATaskMoveSeeWhereItWent(t *testing.T) {
	f := seedMoveScene(t, "kitp_test_r9_move_race")
	pool := f.srv.Pool.P
	ctx := context.Background()
	sys := auth.WithSystemUser(ctx)

	var srcNext int64 // a status the source flow allows from Todo
	if err := pool.QueryRow(ctx, `
		SELECT fs.to_card_id FROM flow_step fs JOIN flow fl ON fl.id = fs.flow_id
		JOIN attribute_def ad ON ad.id = fl.attribute_def_id AND ad.name = 'status'
		WHERE fl.scope_card_id = $1 AND fs.from_card_id = $2 ORDER BY fs.id LIMIT 1`,
		f.srcProjectID, f.srcStatusID).Scan(&srcNext); err != nil {
		t.Fatal(err)
	}
	statusOf := func(id int64) int64 {
		var s int64
		if err := pool.QueryRow(ctx, `SELECT (av.value)::text::bigint FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = $1 AND ad.name = 'status'`, id).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}

	// The move runs in a transaction held open ...
	mv, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := mv.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Logf("rollback: %v", err)
		}
	}()
	var mvPID int32
	if err := mv.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&mvPID); err != nil {
		t.Fatal(err)
	}
	var ok bool
	var code, msg string
	if err := mv.QueryRow(ctx, `SELECT ok, code, message FROM task_move_batch($1, $2::jsonb)`, auth.SystemUserID,
		fmt.Sprintf(`[{"card_id":"%d","new_project_id":"%d","new_status_id":"%d"}]`, f.taskID, f.destProjectID, f.destStatusOpen)).Scan(&ok, &code, &msg); err != nil || !ok {
		t.Fatalf("task.move: ok=%v %s %s %v", ok, code, msg, err)
	}

	// ... while one person adds a subtask to it in the source project and
	// another moves its status on the source's board.
	dispatch := func(sub api.SubRequest) <-chan api.SubResponse {
		ch := make(chan api.SubResponse, 1)
		go func() {
			r := f.srv.Dispatch(sys, api.BatchRequest{Subrequests: []api.SubRequest{sub}})
			ch <- r.Subresponses[0]
		}()
		return ch
	}
	ins := dispatch(api.SubRequest{ID: "s", Endpoint: "card", Action: "insert", Data: json.RawMessage(fmt.Sprintf(
		`{"card_type_name":"task","parent_card_id":"%d","title":"new subtask","parent_task":"%d","attributes":{"status":"%d"}}`,
		f.srcProjectID, f.taskID, f.srcStatusID))})
	upd := dispatch(api.SubRequest{ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(fmt.Sprintf(
		`{"card_id":"%d","attribute_name":"status","value":"%d"}`, f.taskID, srcNext))})
	r9WaitBlocked(t, pool, mvPID, 2)
	if err := mv.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if r := <-ins; r.OK || r.Error == nil || r.Error.Code != "cross_project_ref" {
		t.Errorf("a subtask added in the source while its parent moved: %+v, want cross_project_ref", r)
	}
	if r := <-upd; r.OK || r.Error == nil || r.Error.Code != "cross_project_ref" {
		t.Errorf("a source status set while the task moved: %+v, want cross_project_ref", r)
	}
	if s := statusOf(f.taskID); s != f.destStatusOpen {
		t.Errorf("the moved task's status is %d, want the destination's %d", s, f.destStatusOpen)
	}
	var strays int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'parent_task'
		JOIN card c ON c.id = av.card_id
		WHERE jsonb_typeof(av.value) = 'number' AND (av.value)::text::bigint = $1 AND c.parent_card_id <> $2`,
		f.taskID, f.destProjectID).Scan(&strays); err != nil {
		t.Fatal(err)
	}
	if strays != 0 {
		t.Errorf("%d subtasks of the moved task were left outside the destination", strays)
	}
}

// TestASubtaskAddedFirstRidesAlong: the other order — the insert holds the
// parent first, the move waits for it, then carries the new subtask too.
func TestASubtaskAddedFirstRidesAlong(t *testing.T) {
	f := seedMoveScene(t, "kitp_test_r9_move_race_first")
	pool := f.srv.Pool.P
	ctx := context.Background()

	ins, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := ins.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Logf("rollback: %v", err)
		}
	}()
	var insPID int32
	if err := ins.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&insPID); err != nil {
		t.Fatal(err)
	}
	var ok bool
	var code, msg string
	var res []byte
	if err := ins.QueryRow(ctx, `SELECT ok, code, message, result FROM card_insert_batch($1, $2::jsonb)`, auth.SystemUserID,
		fmt.Sprintf(`[{"card_type_name":"task","parent_card_id":"%d","title":"early subtask","parent_task":"%d","attributes":{"status":"%d"}}]`,
			f.srcProjectID, f.taskID, f.srcStatusID)).Scan(&ok, &code, &msg, &res); err != nil || !ok {
		t.Fatalf("card.insert: ok=%v %s %s %v", ok, code, msg, err)
	}
	var made struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(res, &made); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		ctx := auth.WithSystemUser(context.Background())
		r := f.srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{{ID: "mv", Endpoint: "task", Action: "move",
			Data: json.RawMessage(fmt.Sprintf(`{"card_id":"%d","new_project_id":"%d","new_status_id":"%d"}`, f.taskID, f.destProjectID, f.destStatusOpen))}}})
		if !r.Subresponses[0].OK {
			done <- fmt.Errorf("task.move: %+v", r.Subresponses[0].Error)
			return
		}
		done <- nil
	}()
	r9WaitBlocked(t, pool, insPID, 1)
	if err := ins.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	var proj int64
	if err := pool.QueryRow(ctx, `SELECT parent_card_id FROM card WHERE id = $1::bigint`, made.ID).Scan(&proj); err != nil {
		t.Fatal(err)
	}
	if proj != f.destProjectID {
		t.Errorf("the subtask added just before the move is in %d, want the destination %d", proj, f.destProjectID)
	}
}

// TestAMovedTasksThreadsTakeTheDestinationsCommStatus (round 8): a thread
// moved with its task held a state of the source project's comm flow, which
// no step of the destination's leaves. It takes the destination's state of
// the same phase: a resolved thread stays resolved.
func TestAMovedTasksThreadsTakeTheDestinationsCommStatus(t *testing.T) {
	f := seedMoveScene(t, "kitp_test_r9_move_comm_status")
	pool := f.srv.Pool.P
	ctx := context.Background()
	commState := func(project int64, phase string) int64 {
		t.Helper()
		var id int64
		if err := pool.QueryRow(ctx, `
			SELECT s.id FROM flow fl JOIN attribute_def ad ON ad.id = fl.attribute_def_id AND ad.name = 'comm_status'
			JOIN card s ON s.id = ANY(flow_state_ids(fl.id)) AND s.phase = $2
			WHERE fl.scope_card_id = $1 ORDER BY s.id LIMIT 1`, project, phase).Scan(&id); err != nil {
			t.Fatalf("comm state %s of %d: %v", phase, project, err)
		}
		return id
	}
	srcResolved, destResolved := commState(f.srcProjectID, "terminal"), commState(f.destProjectID, "terminal")
	var thread int64
	if err := pool.QueryRow(ctx, `
		WITH c AS (INSERT INTO card (card_type_id, parent_card_id) SELECT id, $1 FROM card_type WHERE name = 'comm' RETURNING id)
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT c.id, ad.id, to_jsonb($2::bigint) FROM c, attribute_def ad WHERE ad.name = 'comm_status'
		RETURNING card_id`, f.taskID, srcResolved).Scan(&thread); err != nil {
		t.Fatal(err)
	}
	dispatchMove(t, f.srv, fmt.Sprintf(`{"card_id":"%d","new_project_id":"%d","new_status_id":"%d"}`, f.taskID, f.destProjectID, f.destStatusOpen))
	var got int64
	if err := pool.QueryRow(ctx, `
		SELECT (av.value)::text::bigint FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'comm_status'
		WHERE av.card_id = $1`, thread).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != destResolved {
		t.Errorf("the moved thread's comm_status is %d, want the destination's resolved state %d (source's was %d)", got, destResolved, srcResolved)
	}
}
