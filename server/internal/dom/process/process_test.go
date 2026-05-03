package process_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/comment"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/process"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

func setup(t *testing.T, schema string) (*api.Server, *store.Pool) {
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
	process.Register(sp)
	return api.NewServer(sp), sp
}

// TestUpdateWithCommentProcess: invoking the seeded process
// task.update_with_comment expands to two steps (attribute.update +
// comment.insert) inside one tx.
func TestUpdateWithCommentProcess(t *testing.T) {
	srv, _ := setup(t, "kitp_test_proc_uwc")
	ctx := context.Background()

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("project: %+v", resp.Subresponses[0])
	}
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "t", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"task","parent_card_id":%d,"title":"T"}`, pOut.ID))},
	}})
	var tOut card.InsertOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &tOut)

	// Invoke process: data is the union of attribute.update + comment.insert inputs.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "uwc", Endpoint: "task", Action: "update_with_comment", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d,"attribute_name":"status","value":"open","body":"setting status"}`, tOut.ID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("process: %+v", resp.Subresponses[0])
	}

	// Activity should now contain: card_create, attr_update title (from
	// insert), attr_update status, comment.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "a", Endpoint: "activity", Action: "select", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d}`, tOut.ID))},
	}})
	var aOut activity.SelectOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &aOut)

	wantKinds := []string{"card_create", "attr_update", "attr_update", "comment"}
	if len(aOut.Rows) != len(wantKinds) {
		t.Fatalf("activity rows: %d want %d: %+v", len(aOut.Rows), len(wantKinds), aOut.Rows)
	}
	for i, k := range wantKinds {
		if aOut.Rows[i].Kind != k {
			t.Errorf("row %d kind: %q want %q", i, aOut.Rows[i].Kind, k)
		}
	}
}

// TestProcessRollback: a 3-step process where step 2 fails rolls back step 1.
func TestProcessRollback(t *testing.T) {
	srv, _ := setup(t, "kitp_test_proc_roll")
	ctx := context.Background()

	// Custom process for the test: 3 steps — card.insert + attribute.update + attribute.update.
	// We add it directly to the DB.
	pgxPool := srv.Pool.P
	if _, err := pgxPool.Exec(ctx, `
		INSERT INTO process (name) VALUES ('task.test_workflow') ON CONFLICT DO NOTHING
	`); err != nil {
		t.Fatalf("insert process: %v", err)
	}
	if _, err := pgxPool.Exec(ctx, `
		INSERT INTO process_step (process_id, ordinal, endpoint, action)
		SELECT id, 1, 'card', 'insert' FROM process WHERE name='task.test_workflow' ON CONFLICT DO NOTHING;
		INSERT INTO process_step (process_id, ordinal, endpoint, action)
		SELECT id, 2, 'attribute', 'update' FROM process WHERE name='task.test_workflow' ON CONFLICT DO NOTHING;
		INSERT INTO process_step (process_id, ordinal, endpoint, action)
		SELECT id, 3, 'attribute', 'update' FROM process WHERE name='task.test_workflow' ON CONFLICT DO NOTHING;
	`); err != nil {
		t.Fatalf("insert steps: %v", err)
	}

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)

	// Pre-create a task so we have a valid card_id for the attribute.update steps.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "t", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"task","parent_card_id":%d,"title":"T"}`, pOut.ID))},
	}})
	var tOut card.InsertOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &tOut)

	// The process: step 1 inserts a project. Step 2's input has
	// attribute_name="not_a_real_attr" — this fails Validate at decode time.
	// Step 3 never runs. Step 1 must be rolled back.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "wf", Endpoint: "task", Action: "test_workflow", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"project","title":"new_proj_should_be_rolled_back","card_id":%d,"attribute_name":"not_a_real_attr","value":"x"}`, tOut.ID))},
	}})
	if resp.Subresponses[0].OK {
		t.Fatalf("expected failure, got %+v", resp.Subresponses[0])
	}

	// Verify no project named "new_proj_should_be_rolled_back" exists.
	var count int
	row := pgxPool.QueryRow(ctx, `
		SELECT count(*)
		FROM card c
		JOIN attribute_value av ON av.card_id = c.id
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE ad.name = 'title' AND av.value::text = '"new_proj_should_be_rolled_back"'
	`)
	if err := row.Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 0 {
		t.Errorf("rollback failed: project still present (count=%d)", count)
	}
}

// TestAuthDeny: revoke the system role's grant on (task, card.update),
// then try to invoke a process that needs it. Batch should be aborted with
// an "unauthorized" code.
func TestAuthDeny(t *testing.T) {
	srv, _ := setup(t, "kitp_test_proc_auth")
	ctx := context.Background()
	pgxPool := srv.Pool.P

	// Project + task.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "t", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"task","parent_card_id":%d,"title":"T"}`, pOut.ID))},
	}})
	var tOut card.InsertOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &tOut)

	// Revoke the system role's grant on (task, card.update).
	if _, err := pgxPool.Exec(ctx, `
		DELETE FROM role_grant
		WHERE role_id   = (SELECT id FROM role        WHERE name='system')
		  AND card_type_id = (SELECT id FROM card_type WHERE name='task')
		  AND process_id  = (SELECT id FROM process    WHERE name='card.update')
	`); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	// Try attribute.update on the task — should fail with unauthorized.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d,"attribute_name":"status","value":"open"}`, tOut.ID))},
	}})
	if resp.Subresponses[0].OK {
		t.Fatalf("expected unauthorized, got %+v", resp.Subresponses[0])
	}
	if resp.Subresponses[0].Error == nil || resp.Subresponses[0].Error.Code != "unauthorized" {
		t.Errorf("error code: %+v", resp.Subresponses[0].Error)
	}
}
