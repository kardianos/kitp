package card_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/card"
)

// ---- fixtures ----

type moveFixture struct {
	srv               *api.Server
	srcProjectID      int64
	destProjectID     int64
	srcStatusID       int64
	destStatusOpen    int64
	destStatusDone    int64
	destMilestoneID   int64
	destComponentID   int64
	destTagID         int64
	taskID            int64
}

// seedMoveScene builds two projects, each with the value-cards the
// tested task references, plus one parent task in the source project.
// Returns the ids the tests need to drive task.move and assert.
func seedMoveScene(t *testing.T, schema string) moveFixture {
	t.Helper()
	srv, _ := setupAttr(t, schema)
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

	f := moveFixture{srv: srv}
	f.srcProjectID = insert("ps", `{"card_type_name":"project","title":"Source"}`)
	f.destProjectID = insert("pd", `{"card_type_name":"project","title":"Destination"}`)
	f.srcStatusID = insert("sss", fmt.Sprintf(
		`{"card_type_name":"status","parent_card_id":"%d","title":"SrcOpen"}`, f.srcProjectID))
	f.destStatusOpen = insert("dso", fmt.Sprintf(
		`{"card_type_name":"status","parent_card_id":"%d","title":"DestOpen"}`, f.destProjectID))
	f.destStatusDone = insert("dsd", fmt.Sprintf(
		`{"card_type_name":"status","parent_card_id":"%d","title":"DestDone"}`, f.destProjectID))
	f.destMilestoneID = insert("dm", fmt.Sprintf(
		`{"card_type_name":"milestone","parent_card_id":"%d","title":"DestMilestone"}`, f.destProjectID))
	f.destComponentID = insert("dc", fmt.Sprintf(
		`{"card_type_name":"component","parent_card_id":"%d","title":"DestComponent"}`, f.destProjectID))
	f.destTagID = insert("dt", fmt.Sprintf(
		`{"card_type_name":"tag","parent_card_id":"%d","title":"a/b","attributes":{"path":"a/b"}}`, f.destProjectID))

	// Source-project milestone + component + tag so the original task
	// has every project-scoped attribute populated.
	srcMilestoneID := insert("sm", fmt.Sprintf(
		`{"card_type_name":"milestone","parent_card_id":"%d","title":"SrcMilestone"}`, f.srcProjectID))
	srcComponentID := insert("sc", fmt.Sprintf(
		`{"card_type_name":"component","parent_card_id":"%d","title":"SrcComponent"}`, f.srcProjectID))
	srcTagID := insert("st", fmt.Sprintf(
		`{"card_type_name":"tag","parent_card_id":"%d","title":"x/y","attributes":{"path":"x/y"}}`, f.srcProjectID))

	f.taskID = insert("t", fmt.Sprintf(`{
		"card_type_name":"task","parent_card_id":"%d","title":"Move me",
		"attributes":{
			"status":"%d","milestone_ref":"%d","component_ref":"%d","tags":["%d"],
			"description":"keep this body"
		}
	}`, f.srcProjectID, f.srcStatusID, srcMilestoneID, srcComponentID, srcTagID))

	return f
}

// dispatchMove runs one task.move sub-request and returns the
// decoded output (or fails the test with the surfaced error).
func dispatchMove(t *testing.T, srv *api.Server, body string) card.TaskMoveOutput {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "mv", Endpoint: "task", Action: "move", Data: json.RawMessage(body)},
	}})
	sr := resp.Subresponses[0]
	if !sr.OK {
		t.Fatalf("task.move: %+v\nbody=%s", sr.Error, body)
	}
	var out card.TaskMoveOutput
	buf, _ := json.Marshal(sr.Data)
	if err := json.Unmarshal(buf, &out); err != nil {
		t.Fatalf("decode out: %v", err)
	}
	return out
}

// dispatchMoveErr expects the move to fail and returns the error
// code so the caller can assert against it.
func dispatchMoveErr(t *testing.T, srv *api.Server, body string) (string, string) {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "mv", Endpoint: "task", Action: "move", Data: json.RawMessage(body)},
	}})
	sr := resp.Subresponses[0]
	if sr.OK {
		t.Fatalf("expected task.move to fail, got OK: %+v", sr)
	}
	if sr.Error == nil {
		return "", ""
	}
	return sr.Error.Code, sr.Error.Message
}

// attrValue returns the JSON-encoded attribute_value for (cardID, name)
// or "" when absent. Tests use this to assert re-classification.
func attrValue(t *testing.T, srv *api.Server, cardID int64, name string) string {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"task"}`))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("select: %+v", resp.Subresponses[0])
	}
	var out card.SelectWithAttributesOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &out)
	for _, r := range out.Rows {
		if r.ID == cardID {
			if raw, ok := r.Attributes[name]; ok {
				b, _ := json.Marshal(raw)
				return string(b)
			}
			return ""
		}
	}
	return ""
}

// projectIDOf returns the parent_card_id (the project) of the task.
func projectIDOf(t *testing.T, srv *api.Server, cardID int64) int64 {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(`{"card_type_name":"task"}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("select: %+v", resp.Subresponses[0])
	}
	var out card.SelectWithAttributesOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &out)
	for _, r := range out.Rows {
		if r.ID == cardID && r.ParentCardID != nil {
			return *r.ParentCardID
		}
	}
	return 0
}

// ---- tests ----

// TestTaskMove_HappyPath covers the standard explicit-status flow:
// the task re-parents to the destination project, status flips to the
// caller's pick, and every per-project attr (milestone / component /
// tags) is cleared so the user re-classifies in the destination.
// Description and other non-project attrs are preserved.
func TestTaskMove_HappyPath(t *testing.T) {
	f := seedMoveScene(t, "kitp_test_task_move_happy")
	out := dispatchMove(t, f.srv, fmt.Sprintf(
		`{"card_id":"%d","new_project_id":"%d","new_status_id":"%d"}`,
		f.taskID, f.destProjectID, f.destStatusDone))

	if got := projectIDOf(t, f.srv, f.taskID); got != f.destProjectID {
		t.Errorf("parent_card_id: got %d, want %d", got, f.destProjectID)
	}
	// Status canonicalises to a JSON number on storage (the
	// dispatcher stringifies it for the wire, but the schema layer
	// normalises card-ref values back to numbers before they hit
	// attribute_value). Match either shape so the assertion survives
	// a future canonicalisation tweak.
	wantNum := fmt.Sprintf(`%d`, f.destStatusDone)
	wantStr := fmt.Sprintf(`"%d"`, f.destStatusDone)
	if v := attrValue(t, f.srv, f.taskID, "status"); v != wantNum && v != wantStr {
		t.Errorf("status attr: got %q, want %q or %q", v, wantNum, wantStr)
	}
	if v := attrValue(t, f.srv, f.taskID, "milestone_ref"); v != "" {
		t.Errorf("milestone_ref: expected cleared, got %q", v)
	}
	if v := attrValue(t, f.srv, f.taskID, "component_ref"); v != "" {
		t.Errorf("component_ref: expected cleared, got %q", v)
	}
	if v := attrValue(t, f.srv, f.taskID, "tags"); v != "" {
		t.Errorf("tags: expected cleared, got %q", v)
	}
	if v := attrValue(t, f.srv, f.taskID, "description"); v == "" {
		t.Errorf("description: expected preserved, got empty")
	}
	if got := out.ResolvedStatusID; got != f.destStatusDone {
		t.Errorf("ResolvedStatusID: got %d, want %d", got, f.destStatusDone)
	}
	if len(out.MovedCardIDs) != 1 || out.MovedCardIDs[0] != f.taskID {
		t.Errorf("MovedCardIDs: got %v, want [%d]", out.MovedCardIDs, f.taskID)
	}
}

// TestTaskMove_DefaultIntakeStatus omits new_status_id and asserts
// the server picks the destination project's lowest-sort-order
// triage-phase status. After Phase 2 of UNIFIED_HANDLER_PLAN.md the
// destination project is graph-copied from the standard template
// (is_template=true), which seeds a "New idea" triage status with
// sort_order=5. That wins over the test's DestOpen/DestDone (no
// sort_order assigned, so they tie-break on id and lose). We assert
// only that the resolution lands on SOME triage status under the
// destination project.
func TestTaskMove_DefaultIntakeStatus(t *testing.T) {
	f := seedMoveScene(t, "kitp_test_task_move_intake")
	out := dispatchMove(t, f.srv, fmt.Sprintf(
		`{"card_id":"%d","new_project_id":"%d"}`,
		f.taskID, f.destProjectID))

	if out.ResolvedStatusID == 0 {
		t.Fatalf("ResolvedStatusID: server didn't pick a default")
	}
	// Confirm the resolved status is a triage-phase status card
	// under the destination project.
	var phase string
	var parentID int64
	if err := f.srv.Pool.P.QueryRow(context.Background(), `
		SELECT c.phase, c.parent_card_id
		FROM card c
		WHERE c.id = $1
	`, out.ResolvedStatusID).Scan(&phase, &parentID); err != nil {
		t.Fatalf("lookup resolved status: %v", err)
	}
	if parentID != f.destProjectID {
		t.Errorf("ResolvedStatusID: parent_card_id = %d, want %d (destination project)",
			parentID, f.destProjectID)
	}
	if phase != "triage" {
		t.Errorf("ResolvedStatusID: phase = %q, want %q", phase, "triage")
	}
}

// TestTaskMove_CascadeSubtree confirms a sub-task moves alongside
// its parent under cascade strategy. The child also loses its
// per-project attrs and gains the new ones.
func TestTaskMove_CascadeSubtree(t *testing.T) {
	f := seedMoveScene(t, "kitp_test_task_move_cascade")
	ctx := auth.WithSystemUser(context.Background())
	// Seed a child task pointing at the moved task via parent_task.
	resp := f.srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "ct", Endpoint: "card", Action: "insert", Data: json.RawMessage(fmt.Sprintf(`{
			"card_type_name":"task","parent_card_id":"%d","title":"child",
			"attributes":{"status":"%d","parent_task":"%d"}
		}`, f.srcProjectID, f.srcStatusID, f.taskID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("seed child: %+v", resp.Subresponses[0].Error)
	}
	var ct card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &ct)

	out := dispatchMove(t, f.srv, fmt.Sprintf(
		`{"card_id":"%d","new_project_id":"%d","new_status_id":"%d","subtask_strategy":"cascade"}`,
		f.taskID, f.destProjectID, f.destStatusOpen))

	if len(out.MovedCardIDs) != 2 {
		t.Fatalf("MovedCardIDs: got %v, want 2 ids (parent + child)", out.MovedCardIDs)
	}
	if got := projectIDOf(t, f.srv, ct.ID); got != f.destProjectID {
		t.Errorf("child parent_card_id: got %d, want %d", got, f.destProjectID)
	}
	wantOpenNum := fmt.Sprintf(`%d`, f.destStatusOpen)
	wantOpenStr := fmt.Sprintf(`"%d"`, f.destStatusOpen)
	if v := attrValue(t, f.srv, ct.ID, "status"); v != wantOpenNum && v != wantOpenStr {
		t.Errorf("child status: got %q, want %q or %q", v, wantOpenNum, wantOpenStr)
	}
	if v := attrValue(t, f.srv, ct.ID, "parent_task"); v == "" {
		t.Errorf("child parent_task: expected preserved (still points at parent), got empty")
	}
}

// TestTaskMove_BreakStrategy leaves the child in the source project
// but clears its parent_task pointer so the chain doesn't dangle
// across projects.
func TestTaskMove_BreakStrategy(t *testing.T) {
	f := seedMoveScene(t, "kitp_test_task_move_break")
	ctx := auth.WithSystemUser(context.Background())
	resp := f.srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "ct", Endpoint: "card", Action: "insert", Data: json.RawMessage(fmt.Sprintf(`{
			"card_type_name":"task","parent_card_id":"%d","title":"child",
			"attributes":{"status":"%d","parent_task":"%d","parent_relationship":"subtask"}
		}`, f.srcProjectID, f.srcStatusID, f.taskID))},
	}})
	var ct card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &ct)

	out := dispatchMove(t, f.srv, fmt.Sprintf(
		`{"card_id":"%d","new_project_id":"%d","new_status_id":"%d","subtask_strategy":"break"}`,
		f.taskID, f.destProjectID, f.destStatusOpen))

	if len(out.MovedCardIDs) != 1 {
		t.Fatalf("MovedCardIDs: got %v, want 1 (only the parent moved)", out.MovedCardIDs)
	}
	if got := projectIDOf(t, f.srv, ct.ID); got != f.srcProjectID {
		t.Errorf("child should stay in source project; got %d", got)
	}
	if v := attrValue(t, f.srv, ct.ID, "parent_task"); v != "" {
		t.Errorf("child parent_task: expected cleared, got %q", v)
	}
	if v := attrValue(t, f.srv, ct.ID, "parent_relationship"); v != "" {
		t.Errorf("child parent_relationship: expected cleared, got %q", v)
	}
	if len(out.BrokenChildIDs) != 1 || out.BrokenChildIDs[0] != ct.ID {
		t.Errorf("BrokenChildIDs: got %v, want [%d]", out.BrokenChildIDs, ct.ID)
	}
}

// TestTaskMove_RejectsSameProject confirms the no-op move is
// surfaced as an error so the caller can correct the form.
func TestTaskMove_RejectsSameProject(t *testing.T) {
	f := seedMoveScene(t, "kitp_test_task_move_same")
	code, _ := dispatchMoveErr(t, f.srv, fmt.Sprintf(
		`{"card_id":"%d","new_project_id":"%d","new_status_id":"%d"}`,
		f.taskID, f.srcProjectID, f.srcStatusID))
	if code != "same_project" {
		t.Errorf("error code: got %q, want same_project", code)
	}
}

// TestTaskMove_RejectsStatusFromOtherProject confirms the status
// validator catches the very mistake the dialog exists to avoid:
// the caller picked a status card that lives in some unrelated
// project.
func TestTaskMove_RejectsStatusFromOtherProject(t *testing.T) {
	f := seedMoveScene(t, "kitp_test_task_move_bad_status")
	code, _ := dispatchMoveErr(t, f.srv, fmt.Sprintf(
		`{"card_id":"%d","new_project_id":"%d","new_status_id":"%d"}`,
		f.taskID, f.destProjectID, f.srcStatusID))
	if code != "bad_status" {
		t.Errorf("error code: got %q, want bad_status", code)
	}
}

// TestTaskMove_RejectsNonTaskCard confirms the handler refuses to
// run on a card that isn't a task — a milestone passed in by id
// would be silently destructive otherwise.
func TestTaskMove_RejectsNonTaskCard(t *testing.T) {
	f := seedMoveScene(t, "kitp_test_task_move_non_task")
	code, _ := dispatchMoveErr(t, f.srv, fmt.Sprintf(
		`{"card_id":"%d","new_project_id":"%d","new_status_id":"%d"}`,
		f.destMilestoneID, f.destProjectID, f.destStatusOpen))
	if code != "wrong_card_type" {
		t.Errorf("error code: got %q, want wrong_card_type", code)
	}
}

// TestTaskMove_ActivityRecorded confirms an audit row is written
// per moved card so the project move is visible in the activity
// stream.
func TestTaskMove_ActivityRecorded(t *testing.T) {
	f := seedMoveScene(t, "kitp_test_task_move_activity")
	_ = dispatchMove(t, f.srv, fmt.Sprintf(
		`{"card_id":"%d","new_project_id":"%d","new_status_id":"%d"}`,
		f.taskID, f.destProjectID, f.destStatusOpen))

	// One activity row of kind='task_move' on the moved card.
	srv := f.srv
	ctx := auth.WithSystemUser(context.Background())
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "a", Endpoint: "activity", Action: "select", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d"}`, f.taskID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("activity.select: %+v", resp.Subresponses[0])
	}
	raw, _ := json.Marshal(resp.Subresponses[0].Data)
	var listOut struct {
		Rows []struct {
			Kind string `json:"kind"`
		} `json:"rows"`
	}
	if err := json.Unmarshal(raw, &listOut); err != nil {
		t.Fatalf("decode activity: %v", err)
	}
	var foundMove bool
	for _, r := range listOut.Rows {
		if r.Kind == "task_move" {
			foundMove = true
			break
		}
	}
	if !foundMove {
		t.Errorf("no task_move activity row found among %d rows", len(listOut.Rows))
	}
}
