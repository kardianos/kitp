package flow_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/flow"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// fixture captures the per-test rows we lean on across cases:
//
//   - one project card
//   - the seeded attribute_def 'status'
//   - the seeded card_type 'status' (target of the status attribute_def)
//   - three value cards (Triage / Doing / Done) with phases triage / active / terminal
//
// Tests build their flow + flow_step under these so the validation
// hooks (target_card_type, phase counts) all see realistic data.
type fixture struct {
	srv          *api.Server
	sp           *store.Pool
	ctx          context.Context
	adminID      int64
	projectID    int64
	statusAttrID int64
	statusCTID   int64
	triageID     int64
	doingID      int64
	doneID       int64
}

// setup spins a fresh schema, installs flow + echo + cardtype handlers,
// promotes one user to admin, and seeds the fixture cards described
// above.
func setup(t *testing.T, schema string) *fixture {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schema)
	sp := store.NewPool(pool)
	echo.Register()
	cardtype.Register()
	flow.Register(sp)
	srv := api.NewServer(sp)

	ctx := context.Background()

	// Admin user.
	var uid int64
	row := sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ('flow-admin') RETURNING id`)
	if err := row.Scan(&uid); err != nil {
		t.Fatalf("admin user: %v", err)
	}
	if _, err := sp.P.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name = 'admin'
	`, uid); err != nil {
		t.Fatalf("admin grant: %v", err)
	}

	// Resolve seeded ids.
	var statusAttrID, statusCTID, projectCTID int64
	if err := sp.P.QueryRow(ctx, `SELECT id FROM attribute_def WHERE name = 'status'`).Scan(&statusAttrID); err != nil {
		t.Fatalf("attribute_def.status: %v", err)
	}
	if err := sp.P.QueryRow(ctx, `SELECT id FROM card_type WHERE name = 'status'`).Scan(&statusCTID); err != nil {
		t.Fatalf("card_type.status: %v", err)
	}
	if err := sp.P.QueryRow(ctx, `SELECT id FROM card_type WHERE name = 'project'`).Scan(&projectCTID); err != nil {
		t.Fatalf("card_type.project: %v", err)
	}

	// Project card.
	var projectID int64
	if err := sp.P.QueryRow(ctx, `
		INSERT INTO card (card_type_id, phase) VALUES ($1, 'triage') RETURNING id
	`, projectCTID).Scan(&projectID); err != nil {
		t.Fatalf("project card: %v", err)
	}

	mkStatus := func(name, phase string) int64 {
		var id int64
		if err := sp.P.QueryRow(ctx, `
			INSERT INTO card (card_type_id, parent_card_id, phase) VALUES ($1, $2, $3) RETURNING id
		`, statusCTID, projectID, phase).Scan(&id); err != nil {
			t.Fatalf("status card %s: %v", name, err)
		}
		return id
	}
	triageID := mkStatus("Triage", "triage")
	doingID := mkStatus("Doing", "active")
	doneID := mkStatus("Done", "terminal")

	return &fixture{
		srv:          srv,
		sp:           sp,
		ctx:          auth.WithUser(ctx, &auth.UserCtx{ID: uid, DisplayName: "flow-admin"}),
		adminID:      uid,
		projectID:    projectID,
		statusAttrID: statusAttrID,
		statusCTID:   statusCTID,
		triageID:     triageID,
		doingID:      doingID,
		doneID:       doneID,
	}
}

// dispatch runs one sub-request and decodes the payload into v. Calls
// t.Fatalf if the sub-response is not OK.
func dispatch(t *testing.T, f *fixture, sub api.SubRequest, v any) {
	t.Helper()
	resp := f.srv.Dispatch(f.ctx, api.BatchRequest{Subrequests: []api.SubRequest{sub}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("%s.%s: %+v", sub.Endpoint, sub.Action, resp.Subresponses[0])
	}
	if v != nil {
		buf, _ := json.Marshal(resp.Subresponses[0].Data)
		if err := json.Unmarshal(buf, v); err != nil {
			t.Fatalf("decode %s.%s: %v", sub.Endpoint, sub.Action, err)
		}
	}
}

// dispatchExpectErr is the negative variant.
func dispatchExpectErr(t *testing.T, f *fixture, sub api.SubRequest) *api.ErrorEnvelope {
	t.Helper()
	resp := f.srv.Dispatch(f.ctx, api.BatchRequest{Subrequests: []api.SubRequest{sub}})
	if resp.Subresponses[0].OK {
		t.Fatalf("%s.%s: expected error, got OK: %+v", sub.Endpoint, sub.Action, resp.Subresponses[0])
	}
	if resp.Subresponses[0].Error == nil {
		t.Fatalf("%s.%s: error envelope missing", sub.Endpoint, sub.Action)
	}
	return resp.Subresponses[0].Error
}

// ---- flow.set / list / delete ----

func TestFlowSetAndList(t *testing.T) {
	f := setup(t, "kitp_test_flow_set_list")

	// Insert.
	var setOut flow.SetOutput
	dispatch(t, f, api.SubRequest{
		ID: "s", Endpoint: "flow", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"name":"Standard task","doc":"primary flow","attribute_def_id":"%d","scope_card_id":"%d","default_create_status_id":"%d"}`,
				f.statusAttrID, f.projectID, f.triageID)),
	}, &setOut)
	if setOut.ID == 0 {
		t.Fatalf("expected flow id > 0; got 0")
	}

	// List filtered by scope returns it.
	var listOut flow.ListOutput
	dispatch(t, f, api.SubRequest{
		ID: "l", Endpoint: "flow", Action: "list", Data: json.RawMessage(
			fmt.Sprintf(`{"scope_card_id":"%d"}`, f.projectID)),
	}, &listOut)
	if len(listOut.Rows) != 1 {
		t.Fatalf("expected 1 row, got %d: %+v", len(listOut.Rows), listOut.Rows)
	}
	row := listOut.Rows[0]
	if row.ID != setOut.ID {
		t.Errorf("row.ID=%d, want %d", row.ID, setOut.ID)
	}
	if row.Name != "Standard task" {
		t.Errorf("row.Name=%q, want %q", row.Name, "Standard task")
	}
	if row.AttributeDefName != "status" {
		t.Errorf("row.AttributeDefName=%q, want status", row.AttributeDefName)
	}
	if row.DefaultCreateStatusID != f.triageID {
		t.Errorf("row.DefaultCreateStatusID=%d, want %d", row.DefaultCreateStatusID, f.triageID)
	}

	// Update existing by id (rename).
	dispatch(t, f, api.SubRequest{
		ID: "u", Endpoint: "flow", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"id":"%d","name":"Standard task v2","attribute_def_id":"%d","scope_card_id":"%d"}`,
				setOut.ID, f.statusAttrID, f.projectID)),
	}, nil)
	// Scope to f.projectID so the install-seed template's flow (Gate 11)
	// doesn't pollute the list — global flow.list also returns that row.
	var listOut2 flow.ListOutput
	dispatch(t, f, api.SubRequest{
		ID: "l2", Endpoint: "flow", Action: "list", Data: json.RawMessage(
			fmt.Sprintf(`{"scope_card_id":"%d"}`, f.projectID)),
	}, &listOut2)
	if len(listOut2.Rows) != 1 || listOut2.Rows[0].Name != "Standard task v2" {
		t.Errorf("rename failed: %+v", listOut2.Rows)
	}
}

func TestFlowDuplicateScopeRejected(t *testing.T) {
	f := setup(t, "kitp_test_flow_dup")
	body := json.RawMessage(fmt.Sprintf(
		`{"name":"A","attribute_def_id":"%d","scope_card_id":"%d"}`, f.statusAttrID, f.projectID))

	dispatch(t, f, api.SubRequest{ID: "1", Endpoint: "flow", Action: "set", Data: body}, nil)
	errEnv := dispatchExpectErr(t, f, api.SubRequest{ID: "2", Endpoint: "flow", Action: "set",
		Data: json.RawMessage(fmt.Sprintf(
			`{"name":"B","attribute_def_id":"%d","scope_card_id":"%d"}`, f.statusAttrID, f.projectID))})
	if errEnv.Code != "flow_duplicate_scope" {
		t.Errorf("expected flow_duplicate_scope, got %q: %s", errEnv.Code, errEnv.Message)
	}
}

func TestFlowSetValidation(t *testing.T) {
	f := setup(t, "kitp_test_flow_validation")

	// scope_card_id must be a project (use the triage status card,
	// which has card_type 'status', not 'project').
	errEnv := dispatchExpectErr(t, f, api.SubRequest{
		ID: "1", Endpoint: "flow", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"name":"X","attribute_def_id":"%d","scope_card_id":"%d"}`,
				f.statusAttrID, f.triageID)),
	})
	if errEnv.Code != "scope_not_project" {
		t.Errorf("scope_not_project expected, got %q", errEnv.Code)
	}

	// default_create_status_id must be card_type=status (use the
	// project card, which has card_type 'project').
	errEnv = dispatchExpectErr(t, f, api.SubRequest{
		ID: "2", Endpoint: "flow", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"name":"X","attribute_def_id":"%d","scope_card_id":"%d","default_create_status_id":"%d"}`,
				f.statusAttrID, f.projectID, f.projectID)),
	})
	if errEnv.Code != "default_status_wrong_type" {
		t.Errorf("default_status_wrong_type expected, got %q", errEnv.Code)
	}

	// Empty name.
	errEnv = dispatchExpectErr(t, f, api.SubRequest{
		ID: "3", Endpoint: "flow", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"name":"","attribute_def_id":"%d","scope_card_id":"%d"}`,
				f.statusAttrID, f.projectID)),
	})
	if errEnv.Code != "validation" {
		t.Errorf("validation expected, got %q", errEnv.Code)
	}
}

// TestFlowDeleteBlockedByFlowSteps verifies the new flow_delete_batch
// contract: a flow is only deletable when no flow_step references it.
// The legacy Go-side body cascaded via ON DELETE CASCADE; the unified
// handler now refuses with code='flow_disallowed' and a structured
// {blockers[], count} payload so the admin UI can render the offender
// list before letting the user explicitly clear the steps.
func TestFlowDeleteBlockedByFlowSteps(t *testing.T) {
	f := setup(t, "kitp_test_flow_blockers")

	// Create flow + 2 flow_steps.
	var setOut flow.SetOutput
	dispatch(t, f, api.SubRequest{
		ID: "f", Endpoint: "flow", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"name":"Casc","attribute_def_id":"%d","scope_card_id":"%d"}`,
				f.statusAttrID, f.projectID)),
	}, &setOut)
	for i, lbl := range []string{"Accept", "Close"} {
		dispatch(t, f, api.SubRequest{
			ID: fmt.Sprintf("st%d", i), Endpoint: "flow_step", Action: "set", Data: json.RawMessage(
				fmt.Sprintf(`{"flow_id":"%d","from_card_id":"%d","to_card_id":"%d","label":"%s"}`,
					setOut.ID, f.triageID, f.doingID, lbl)),
		}, nil)
	}

	// Delete must refuse with the blocker payload.
	errEnv := dispatchExpectErr(t, f, api.SubRequest{
		ID: "d", Endpoint: "flow", Action: "delete", Data: json.RawMessage(
			fmt.Sprintf(`{"flow_id":"%d"}`, setOut.ID)),
	})
	if errEnv.Code != "flow_disallowed" {
		t.Fatalf("flow_disallowed expected, got %q: %s", errEnv.Code, errEnv.Message)
	}
	// Detail carries the structured blocker list.
	detail, ok := errEnv.Detail.(map[string]any)
	if !ok || detail == nil {
		t.Fatalf("detail missing or not an object: %#v", errEnv.Detail)
	}
	if c, _ := detail["count"].(float64); int(c) != 2 {
		t.Errorf("count=%v want 2", detail["count"])
	}
	blockers, _ := detail["blockers"].([]any)
	if len(blockers) != 2 {
		t.Fatalf("blockers len=%d want 2: %#v", len(blockers), blockers)
	}

	// Both flow_step rows still exist; the flow itself is still present.
	var n int
	if err := f.sp.P.QueryRow(context.Background(), `SELECT count(*) FROM flow_step WHERE flow_id = $1`, setOut.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Errorf("expected 2 flow_step rows after refused delete, got %d", n)
	}

	// After clearing steps, the same flow.delete now succeeds.
	if _, err := f.sp.P.Exec(context.Background(), `DELETE FROM flow_step WHERE flow_id = $1`, setOut.ID); err != nil {
		t.Fatalf("clear steps: %v", err)
	}
	var delOut flow.DeleteOutput
	dispatch(t, f, api.SubRequest{
		ID: "d2", Endpoint: "flow", Action: "delete", Data: json.RawMessage(
			fmt.Sprintf(`{"flow_id":"%d"}`, setOut.ID)),
	}, &delOut)
	if !delOut.OK || delOut.Deleted != 1 {
		t.Errorf("delete after clear: %+v", delOut)
	}
}

// ---- flow_step.set / list ----

func TestFlowStepSetAndList(t *testing.T) {
	f := setup(t, "kitp_test_flow_step_list")
	var setOut flow.SetOutput
	dispatch(t, f, api.SubRequest{
		ID: "f", Endpoint: "flow", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"name":"Std","attribute_def_id":"%d","scope_card_id":"%d"}`,
				f.statusAttrID, f.projectID)),
	}, &setOut)

	cases := []struct {
		from, to int64
		label    string
		sort     int32
	}{
		{f.triageID, f.doingID, "Start", 10},
		{f.doingID, f.doneID, "Complete", 20},
		{f.doingID, f.triageID, "Re-triage", 30},
	}
	for i, c := range cases {
		dispatch(t, f, api.SubRequest{
			ID: fmt.Sprintf("st%d", i), Endpoint: "flow_step", Action: "set", Data: json.RawMessage(
				fmt.Sprintf(`{"flow_id":"%d","from_card_id":"%d","to_card_id":"%d","label":"%s","sort_order":%d}`,
					setOut.ID, c.from, c.to, c.label, c.sort)),
		}, nil)
	}

	var listOut flow.StepListOutput
	dispatch(t, f, api.SubRequest{
		ID: "l", Endpoint: "flow_step", Action: "list", Data: json.RawMessage(
			fmt.Sprintf(`{"flow_id":"%d"}`, setOut.ID)),
	}, &listOut)
	if len(listOut.Rows) != 3 {
		t.Fatalf("expected 3 rows, got %d: %+v", len(listOut.Rows), listOut.Rows)
	}
	// First row should be sort_order=10 ("Start").
	if listOut.Rows[0].Label != "Start" || listOut.Rows[0].SortOrder != 10 {
		t.Errorf("row[0] = %+v; want Start sort_order=10", listOut.Rows[0])
	}
}

func TestFlowStepWrongCardType(t *testing.T) {
	f := setup(t, "kitp_test_flow_step_wrong_type")

	var setOut flow.SetOutput
	dispatch(t, f, api.SubRequest{
		ID: "f", Endpoint: "flow", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"name":"Std","attribute_def_id":"%d","scope_card_id":"%d"}`,
				f.statusAttrID, f.projectID)),
	}, &setOut)

	// from_card_id is the project card; status attribute targets card_type=status.
	errEnv := dispatchExpectErr(t, f, api.SubRequest{
		ID: "bad", Endpoint: "flow_step", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"flow_id":"%d","from_card_id":"%d","to_card_id":"%d","label":"X"}`,
				setOut.ID, f.projectID, f.doingID)),
	})
	if errEnv.Code != "card_wrong_type" {
		t.Errorf("card_wrong_type expected, got %q: %s", errEnv.Code, errEnv.Message)
	}
}

func TestFlowStepDuplicate(t *testing.T) {
	f := setup(t, "kitp_test_flow_step_dup")
	var setOut flow.SetOutput
	dispatch(t, f, api.SubRequest{
		ID: "f", Endpoint: "flow", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"name":"Std","attribute_def_id":"%d","scope_card_id":"%d"}`,
				f.statusAttrID, f.projectID)),
	}, &setOut)
	body := json.RawMessage(fmt.Sprintf(
		`{"flow_id":"%d","from_card_id":"%d","to_card_id":"%d","label":"Once"}`,
		setOut.ID, f.triageID, f.doingID))
	dispatch(t, f, api.SubRequest{ID: "1", Endpoint: "flow_step", Action: "set", Data: body}, nil)
	errEnv := dispatchExpectErr(t, f, api.SubRequest{ID: "2", Endpoint: "flow_step", Action: "set", Data: body})
	if errEnv.Code != "flow_step_duplicate" {
		t.Errorf("flow_step_duplicate expected, got %q: %s", errEnv.Code, errEnv.Message)
	}
}

func TestFlowStepDelete(t *testing.T) {
	f := setup(t, "kitp_test_flow_step_delete")
	var setOut flow.SetOutput
	dispatch(t, f, api.SubRequest{
		ID: "f", Endpoint: "flow", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"name":"Std","attribute_def_id":"%d","scope_card_id":"%d"}`,
				f.statusAttrID, f.projectID)),
	}, &setOut)
	var stepOut flow.StepSetOutput
	dispatch(t, f, api.SubRequest{
		ID: "s", Endpoint: "flow_step", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"flow_id":"%d","from_card_id":"%d","to_card_id":"%d","label":"X"}`,
				setOut.ID, f.triageID, f.doingID)),
	}, &stepOut)

	var delOut flow.StepDeleteOutput
	dispatch(t, f, api.SubRequest{
		ID: "d", Endpoint: "flow_step", Action: "delete", Data: json.RawMessage(
			fmt.Sprintf(`{"flow_step_id":"%d"}`, stepOut.ID)),
	}, &delOut)
	if !delOut.OK || delOut.Deleted != 1 {
		t.Errorf("delete: %+v", delOut)
	}
}

// ---- flow.preview_delete ----

func TestFlowPreviewDeleteShape(t *testing.T) {
	f := setup(t, "kitp_test_flow_preview")

	// Build a flow with 2 steps.
	var setOut flow.SetOutput
	dispatch(t, f, api.SubRequest{
		ID: "f", Endpoint: "flow", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"name":"Standard task","attribute_def_id":"%d","scope_card_id":"%d"}`,
				f.statusAttrID, f.projectID)),
	}, &setOut)
	for i, lbl := range []string{"Accept", "Reject", "Start", "Close"} {
		dispatch(t, f, api.SubRequest{
			ID: fmt.Sprintf("st%d", i), Endpoint: "flow_step", Action: "set", Data: json.RawMessage(
				fmt.Sprintf(`{"flow_id":"%d","from_card_id":"%d","to_card_id":"%d","label":"%s","sort_order":%d}`,
					setOut.ID, f.triageID, f.doingID, lbl, (i+1)*10)),
		}, nil)
	}

	// Seed a few tasks holding triage / active / terminal value-cards.
	taskCTID := int64(0)
	if err := f.sp.P.QueryRow(context.Background(), `SELECT id FROM card_type WHERE name='task'`).Scan(&taskCTID); err != nil {
		t.Fatalf("card_type.task: %v", err)
	}
	mkTaskAt := func(statusCardID int64) {
		var taskID int64
		if err := f.sp.P.QueryRow(context.Background(), `
			INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id
		`, taskCTID, f.projectID).Scan(&taskID); err != nil {
			t.Fatalf("task: %v", err)
		}
		if _, err := f.sp.P.Exec(context.Background(), `
			INSERT INTO attribute_value (card_id, attribute_def_id, value) VALUES ($1, $2, to_jsonb($3::bigint))
		`, taskID, f.statusAttrID, statusCardID); err != nil {
			t.Fatalf("av: %v", err)
		}
	}
	// 2 tasks on triage, 3 on doing, 1 on done.
	for range 2 {
		mkTaskAt(f.triageID)
	}
	for range 3 {
		mkTaskAt(f.doingID)
	}
	mkTaskAt(f.doneID)

	var out flow.PreviewDeleteOutput
	dispatch(t, f, api.SubRequest{
		ID: "pd", Endpoint: "flow", Action: "preview_delete", Data: json.RawMessage(
			fmt.Sprintf(`{"flow_id":"%d"}`, setOut.ID)),
	}, &out)

	if out.FlowID != setOut.ID {
		t.Errorf("FlowID=%d, want %d", out.FlowID, setOut.ID)
	}
	if out.FlowName != "Standard task" {
		t.Errorf("FlowName=%q, want %q", out.FlowName, "Standard task")
	}
	if out.StepCount != 4 {
		t.Errorf("StepCount=%d, want 4", out.StepCount)
	}
	// Flow gates triage and doing (both appear in flow_step). Tasks on
	// done are NOT gated by this flow because done doesn't appear in
	// any step. So tasks_currently_in_flow_states = 2 (triage) + 3
	// (doing) = 5.
	if out.TasksCurrentlyInFlowStates != 5 {
		t.Errorf("TasksCurrentlyInFlowStates=%d, want 5", out.TasksCurrentlyInFlowStates)
	}
	if out.TasksByPhase.Triage != 2 || out.TasksByPhase.Active != 3 || out.TasksByPhase.Terminal != 0 {
		t.Errorf("TasksByPhase=%+v; want triage=2 active=3 terminal=0", out.TasksByPhase)
	}
	if len(out.SampleStepLabels) != 4 {
		t.Errorf("SampleStepLabels len=%d, want 4: %+v", len(out.SampleStepLabels), out.SampleStepLabels)
	}
	wantOrder := []string{"Accept", "Reject", "Start", "Close"}
	for i, w := range wantOrder {
		if out.SampleStepLabels[i] != w {
			t.Errorf("SampleStepLabels[%d]=%q, want %q", i, out.SampleStepLabels[i], w)
		}
	}
}

// ---- authz ----

func TestFlowSetRequiresAdmin(t *testing.T) {
	f := setup(t, "kitp_test_flow_authz")
	// Worker user, not admin.
	var uid int64
	row := f.sp.P.QueryRow(context.Background(), `INSERT INTO user_account (display_name) VALUES ('flow-worker') RETURNING id`)
	if err := row.Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(context.Background(), `
		INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name = 'worker'
	`, uid); err != nil {
		t.Fatal(err)
	}
	workerCtx := auth.WithUser(context.Background(), &auth.UserCtx{ID: uid, DisplayName: "flow-worker"})

	resp := f.srv.Dispatch(workerCtx, api.BatchRequest{Subrequests: []api.SubRequest{{
		ID: "x", Endpoint: "flow", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"name":"X","attribute_def_id":"%d","scope_card_id":"%d"}`,
				f.statusAttrID, f.projectID)),
	}}})
	if resp.Subresponses[0].OK {
		t.Fatalf("expected unauthorized")
	}
	if resp.Subresponses[0].Error == nil || resp.Subresponses[0].Error.Code != "unauthorized" {
		t.Errorf("expected unauthorized, got %+v", resp.Subresponses[0].Error)
	}
}

func TestFlowListAuthenticated(t *testing.T) {
	f := setup(t, "kitp_test_flow_list_anyone")
	// Create one flow as admin.
	dispatch(t, f, api.SubRequest{
		ID: "f", Endpoint: "flow", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"name":"Std","attribute_def_id":"%d","scope_card_id":"%d"}`,
				f.statusAttrID, f.projectID)),
	}, nil)

	// Worker user can read.
	var uid int64
	row := f.sp.P.QueryRow(context.Background(), `INSERT INTO user_account (display_name) VALUES ('flow-w2') RETURNING id`)
	if err := row.Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(context.Background(), `
		INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name = 'worker'
	`, uid); err != nil {
		t.Fatal(err)
	}
	workerCtx := auth.WithUser(context.Background(), &auth.UserCtx{ID: uid, DisplayName: "flow-w2"})

	resp := f.srv.Dispatch(workerCtx, api.BatchRequest{Subrequests: []api.SubRequest{{
		ID: "l", Endpoint: "flow", Action: "list", Data: json.RawMessage(`{}`),
	}}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("worker should read flow.list: %+v", resp.Subresponses[0])
	}
}

// ---- flow_step.list_for_card ----

// listForCardFixture extends the base fixture with a task card carrying
// a status value, plus helpers to seed flow_steps and to call
// flow_step.list_for_card under different actor contexts.
type listForCardFixture struct {
	*fixture
	taskCTID int64
	flowID   int64
	titleID  int64
	// Pre-existing roles seeded with `system` (admin user) and `worker`,
	// `manager`. Tests stamp ids by name as needed.
	managerRoleID int64
	workerRoleID  int64
}

func setupListForCard(t *testing.T, schema string) *listForCardFixture {
	t.Helper()
	f := setup(t, schema)
	ctx := context.Background()

	var taskCTID int64
	if err := f.sp.P.QueryRow(ctx, `SELECT id FROM card_type WHERE name='task'`).Scan(&taskCTID); err != nil {
		t.Fatalf("card_type.task: %v", err)
	}
	var titleID int64
	if err := f.sp.P.QueryRow(ctx, `SELECT id FROM attribute_def WHERE name='title'`).Scan(&titleID); err != nil {
		t.Fatalf("attribute_def.title: %v", err)
	}

	// One flow on status, scoped to the fixture's project.
	var flowOut flow.SetOutput
	dispatch(t, f, api.SubRequest{
		ID: "f", Endpoint: "flow", Action: "set", Data: json.RawMessage(
			fmt.Sprintf(`{"name":"Standard task","attribute_def_id":"%d","scope_card_id":"%d"}`,
				f.statusAttrID, f.projectID)),
	}, &flowOut)

	// Title the value cards so from_label / to_label propagate through
	// the affordance query.
	for _, pair := range []struct {
		id   int64
		text string
	}{{f.triageID, "Triage"}, {f.doingID, "Doing"}, {f.doneID, "Done"}} {
		if _, err := f.sp.P.Exec(ctx, `
			INSERT INTO attribute_value (card_id, attribute_def_id, value) VALUES ($1, $2, to_jsonb($3::text))
		`, pair.id, titleID, pair.text); err != nil {
			t.Fatalf("title value-card %s: %v", pair.text, err)
		}
	}

	var managerRoleID, workerRoleID int64
	if err := f.sp.P.QueryRow(ctx, `SELECT id FROM role WHERE name='manager'`).Scan(&managerRoleID); err != nil {
		t.Fatalf("role.manager: %v", err)
	}
	if err := f.sp.P.QueryRow(ctx, `SELECT id FROM role WHERE name='worker'`).Scan(&workerRoleID); err != nil {
		t.Fatalf("role.worker: %v", err)
	}

	return &listForCardFixture{
		fixture:       f,
		taskCTID:      taskCTID,
		flowID:        flowOut.ID,
		titleID:       titleID,
		managerRoleID: managerRoleID,
		workerRoleID:  workerRoleID,
	}
}

// newTaskWithStatus inserts one task card under the fixture's project
// and stamps its status attribute to the supplied value-card id.
func (lf *listForCardFixture) newTaskWithStatus(t *testing.T, statusID int64) int64 {
	t.Helper()
	var taskID int64
	if err := lf.sp.P.QueryRow(context.Background(), `
		INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id
	`, lf.taskCTID, lf.projectID).Scan(&taskID); err != nil {
		t.Fatalf("task card: %v", err)
	}
	if _, err := lf.sp.P.Exec(context.Background(), `
		INSERT INTO attribute_value (card_id, attribute_def_id, value) VALUES ($1, $2, to_jsonb($3::bigint))
	`, taskID, lf.statusAttrID, statusID); err != nil {
		t.Fatalf("status av: %v", err)
	}
	return taskID
}

// addStep adds a flow_step via the registered handler. requiresRoleID = 0
// for no role gate.
func (lf *listForCardFixture) addStep(t *testing.T, fromID, toID int64, label string, requiresRoleID int64, sort int32) {
	t.Helper()
	body := fmt.Sprintf(`{"flow_id":"%d","from_card_id":"%d","to_card_id":"%d","label":"%s","sort_order":%d`,
		lf.flowID, fromID, toID, label, sort)
	if requiresRoleID != 0 {
		body += fmt.Sprintf(`,"requires_role_id":"%d"`, requiresRoleID)
	}
	body += `}`
	dispatch(t, lf.fixture, api.SubRequest{
		ID: "step:" + label, Endpoint: "flow_step", Action: "set",
		Data: json.RawMessage(body),
	}, nil)
}

// makeUserWithRole inserts a fresh user_account, attaches roleID, and
// returns the auth context for that user. Pass scopeID = 0 for a
// global (scope_card_id IS NULL) grant.
func (lf *listForCardFixture) makeUserWithRole(t *testing.T, displayName string, roleID, scopeID int64) (int64, context.Context) {
	t.Helper()
	ctx := context.Background()
	var uid int64
	if err := lf.sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`,
		displayName).Scan(&uid); err != nil {
		t.Fatalf("user %s: %v", displayName, err)
	}
	if scopeID == 0 {
		if _, err := lf.sp.P.Exec(ctx,
			`INSERT INTO user_role (user_id, role_id, scope_card_id) VALUES ($1, $2, NULL)`, uid, roleID); err != nil {
			t.Fatalf("user_role %s: %v", displayName, err)
		}
	} else {
		if _, err := lf.sp.P.Exec(ctx,
			`INSERT INTO user_role (user_id, role_id, scope_card_id) VALUES ($1, $2, $3)`, uid, roleID, scopeID); err != nil {
			t.Fatalf("user_role %s: %v", displayName, err)
		}
	}
	return uid, auth.WithUser(ctx, &auth.UserCtx{ID: uid, DisplayName: displayName})
}

// listForCard runs flow_step.list_for_card under the supplied ctx (=
// actor identity) and returns the rows.
func (lf *listForCardFixture) listForCard(t *testing.T, actorCtx context.Context, cardID int64) []flow.AvailableTransition {
	t.Helper()
	resp := lf.srv.Dispatch(actorCtx, api.BatchRequest{Subrequests: []api.SubRequest{{
		ID: "lfc", Endpoint: "flow_step", Action: "list_for_card", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d"}`, cardID)),
	}}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("flow_step.list_for_card: %+v", resp.Subresponses[0])
	}
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	var out flow.ListForCardOutput
	if err := json.Unmarshal(buf, &out); err != nil {
		t.Fatalf("decode list_for_card: %v", err)
	}
	return out.Rows
}

// TestListForCard_EmptyFlow exercises a card with a status value but no
// flow_step rows pointing at that status — the affordance query must
// return zero rows.
func TestListForCard_EmptyFlow(t *testing.T) {
	lf := setupListForCard(t, "kitp_test_lfc_empty")
	// No flow_step rows at all.
	taskID := lf.newTaskWithStatus(t, lf.triageID)
	rows := lf.listForCard(t, lf.ctx, taskID)
	if len(rows) != 0 {
		t.Errorf("expected 0 rows on empty flow, got %d: %+v", len(rows), rows)
	}
}

// TestListForCard_SingleTransition seeds one flow_step (Triage→Doing,
// no role gate) and asserts the row comes back with from_phase /
// to_phase / labels populated and allowed=true.
func TestListForCard_SingleTransition(t *testing.T) {
	lf := setupListForCard(t, "kitp_test_lfc_single")
	lf.addStep(t, lf.triageID, lf.doingID, "Start", 0, 10)
	taskID := lf.newTaskWithStatus(t, lf.triageID)

	rows := lf.listForCard(t, lf.ctx, taskID)
	if len(rows) != 1 {
		t.Fatalf("expected 1 row, got %d: %+v", len(rows), rows)
	}
	r := rows[0]
	if r.Label != "Start" {
		t.Errorf("Label=%q, want Start", r.Label)
	}
	if r.AttributeDefName != "status" {
		t.Errorf("AttributeDefName=%q, want status", r.AttributeDefName)
	}
	if r.FromCardID != lf.triageID || r.ToCardID != lf.doingID {
		t.Errorf("from/to = %d/%d, want %d/%d", r.FromCardID, r.ToCardID, lf.triageID, lf.doingID)
	}
	if r.FromPhase != "triage" || r.ToPhase != "active" {
		t.Errorf("phases = %s/%s, want triage/active", r.FromPhase, r.ToPhase)
	}
	if r.FromLabel != "Triage" || r.ToLabel != "Doing" {
		t.Errorf("labels = %q/%q, want Triage/Doing", r.FromLabel, r.ToLabel)
	}
	if !r.Allowed {
		t.Errorf("allowed=false, want true for no-role-gate transition")
	}
	if r.RequiresRoleID != 0 || r.RequiresRoleName != "" {
		t.Errorf("requires_role = %d/%q, want 0/empty", r.RequiresRoleID, r.RequiresRoleName)
	}
	if r.FlowID != lf.flowID {
		t.Errorf("FlowID=%d, want %d", r.FlowID, lf.flowID)
	}
}

// TestListForCard_RoleGated covers the four actor cases for a
// role-gated transition (Doing→Done, requires manager):
//
//   - worker: row appears but allowed=false (table-driven check).
//   - admin (only): allowed=false — `admin` does not satisfy a
//     manager-only gate. Admins are not implicitly every-role.
//   - manager: allowed=true.
//   - system role holder (the seeded System User): allowed=true
//     (system bypass per F-ROLE auth model).
func TestListForCard_RoleGated(t *testing.T) {
	lf := setupListForCard(t, "kitp_test_lfc_role")
	lf.addStep(t, lf.doingID, lf.doneID, "Complete", lf.managerRoleID, 20)
	taskID := lf.newTaskWithStatus(t, lf.doingID)

	_, workerCtx := lf.makeUserWithRole(t, "lfc-worker", lf.workerRoleID, 0)
	_, managerCtx := lf.makeUserWithRole(t, "lfc-manager", lf.managerRoleID, 0)
	systemCtx := auth.WithSystemUser(context.Background())

	cases := []struct {
		name    string
		ctx     context.Context
		allowed bool
	}{
		{"worker", workerCtx, false},
		{"admin-only", lf.ctx, false}, // fixture admin user has only the admin role
		{"manager-global", managerCtx, true},
		{"system-user", systemCtx, true}, // seeded System User holds the 'system' role
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rows := lf.listForCard(t, c.ctx, taskID)
			if len(rows) != 1 {
				t.Fatalf("expected 1 row, got %d: %+v", len(rows), rows)
			}
			r := rows[0]
			if r.RequiresRoleID != lf.managerRoleID {
				t.Errorf("requires_role_id=%d, want %d", r.RequiresRoleID, lf.managerRoleID)
			}
			if r.RequiresRoleName != "manager" {
				t.Errorf("requires_role_name=%q, want manager", r.RequiresRoleName)
			}
			if r.Allowed != c.allowed {
				t.Errorf("allowed=%v, want %v", r.Allowed, c.allowed)
			}
		})
	}
}

// TestListForCard_RoleGated_ProjectScopedManager covers the
// project-scoped user_role row case: a manager grant that's scoped
// to the project where the card lives should satisfy the role gate;
// a manager grant scoped to a different project must not.
func TestListForCard_RoleGated_ProjectScopedManager(t *testing.T) {
	lf := setupListForCard(t, "kitp_test_lfc_role_scoped")
	lf.addStep(t, lf.doingID, lf.doneID, "Complete", lf.managerRoleID, 20)
	taskID := lf.newTaskWithStatus(t, lf.doingID)

	// A second project we'll scope a manager grant under so it
	// does NOT cover our task's project.
	ctx := context.Background()
	var projectCTID, otherProjectID int64
	if err := lf.sp.P.QueryRow(ctx, `SELECT id FROM card_type WHERE name='project'`).Scan(&projectCTID); err != nil {
		t.Fatal(err)
	}
	if err := lf.sp.P.QueryRow(ctx,
		`INSERT INTO card (card_type_id, phase) VALUES ($1, 'triage') RETURNING id`, projectCTID).Scan(&otherProjectID); err != nil {
		t.Fatal(err)
	}

	_, scopedOK := lf.makeUserWithRole(t, "lfc-mgr-scope-ok", lf.managerRoleID, lf.projectID)
	_, scopedNo := lf.makeUserWithRole(t, "lfc-mgr-scope-no", lf.managerRoleID, otherProjectID)

	for _, c := range []struct {
		name    string
		ctx     context.Context
		allowed bool
	}{
		{"scoped-to-this-project", scopedOK, true},
		{"scoped-to-other-project", scopedNo, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			rows := lf.listForCard(t, c.ctx, taskID)
			if len(rows) != 1 {
				t.Fatalf("expected 1 row, got %d", len(rows))
			}
			if rows[0].Allowed != c.allowed {
				t.Errorf("allowed=%v, want %v", rows[0].Allowed, c.allowed)
			}
		})
	}
}

// TestListForCard_DifferentProjectScope confirms project isolation:
// a flow scoped to project A doesn't surface transitions for a task
// in project B even if that task holds a status value-card the flow
// gates. (Today value-cards are project-scoped via parent_card_id so
// the same-value-card-in-two-projects scenario is contrived, but we
// build it via raw inserts to verify the scope_card_id filter is
// load-bearing.)
func TestListForCard_DifferentProjectScope(t *testing.T) {
	lf := setupListForCard(t, "kitp_test_lfc_scope")
	lf.addStep(t, lf.triageID, lf.doingID, "Start", 0, 10)

	// A second project with its own task. We deliberately give the
	// task a status value pointing at lf.triageID — the flow_step
	// from_card_id matches, but the flow's scope_card_id = lf.projectID
	// (not the second project) must filter it out.
	ctx := context.Background()
	var projectCTID, otherProjectID int64
	if err := lf.sp.P.QueryRow(ctx, `SELECT id FROM card_type WHERE name='project'`).Scan(&projectCTID); err != nil {
		t.Fatal(err)
	}
	if err := lf.sp.P.QueryRow(ctx,
		`INSERT INTO card (card_type_id, phase) VALUES ($1, 'triage') RETURNING id`, projectCTID).Scan(&otherProjectID); err != nil {
		t.Fatal(err)
	}
	var taskID int64
	if err := lf.sp.P.QueryRow(ctx,
		`INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id`,
		lf.taskCTID, otherProjectID).Scan(&taskID); err != nil {
		t.Fatal(err)
	}
	if _, err := lf.sp.P.Exec(ctx,
		`INSERT INTO attribute_value (card_id, attribute_def_id, value) VALUES ($1, $2, to_jsonb($3::bigint))`,
		taskID, lf.statusAttrID, lf.triageID); err != nil {
		t.Fatal(err)
	}

	rows := lf.listForCard(t, lf.ctx, taskID)
	if len(rows) != 0 {
		t.Errorf("expected 0 rows for cross-project task, got %d: %+v", len(rows), rows)
	}
}

// TestListForCard_OrderingAndMultipleFroms exercises the ORDER BY
// (attribute_def_name, sort_order, label) contract and confirms that
// transitions originating from the card's *current* value appear,
// while transitions whose from_card_id is some *other* value (Doing,
// not Triage) do not.
func TestListForCard_OrderingAndMultipleFroms(t *testing.T) {
	lf := setupListForCard(t, "kitp_test_lfc_order")
	// Two transitions out of Triage, plus one out of Doing the task
	// must NOT see.
	lf.addStep(t, lf.triageID, lf.doingID, "Start", 0, 10)
	lf.addStep(t, lf.triageID, lf.doneID, "Drop", 0, 20)
	lf.addStep(t, lf.doingID, lf.doneID, "Complete", 0, 30)

	taskID := lf.newTaskWithStatus(t, lf.triageID)
	rows := lf.listForCard(t, lf.ctx, taskID)
	if len(rows) != 2 {
		t.Fatalf("expected 2 rows, got %d: %+v", len(rows), rows)
	}
	if rows[0].Label != "Start" || rows[0].SortOrder != 10 {
		t.Errorf("rows[0]=%+v, want Start sort=10", rows[0])
	}
	if rows[1].Label != "Drop" || rows[1].SortOrder != 20 {
		t.Errorf("rows[1]=%+v, want Drop sort=20", rows[1])
	}
}

// TestListForCard_NoProjectAncestor builds a card with no project
// ancestor (root card) and asserts the handler returns an empty list
// rather than an error — there are no project-scoped flows to apply.
func TestListForCard_NoProjectAncestor(t *testing.T) {
	lf := setupListForCard(t, "kitp_test_lfc_no_project")
	// person is a global card_type (not under project). Insert one.
	var personCTID int64
	if err := lf.sp.P.QueryRow(context.Background(),
		`SELECT id FROM card_type WHERE name='person'`).Scan(&personCTID); err != nil {
		t.Fatal(err)
	}
	var rootID int64
	if err := lf.sp.P.QueryRow(context.Background(),
		`INSERT INTO card (card_type_id) VALUES ($1) RETURNING id`, personCTID).Scan(&rootID); err != nil {
		t.Fatal(err)
	}
	rows := lf.listForCard(t, lf.ctx, rootID)
	if len(rows) != 0 {
		t.Errorf("expected 0 rows for card without project ancestor, got %d: %+v", len(rows), rows)
	}
}

// TestListForCard_ValidationCardIDRequired guards the obvious input
// validation path.
func TestListForCard_ValidationCardIDRequired(t *testing.T) {
	lf := setupListForCard(t, "kitp_test_lfc_validation")
	errEnv := dispatchExpectErr(t, lf.fixture, api.SubRequest{
		ID: "v", Endpoint: "flow_step", Action: "list_for_card",
		Data: json.RawMessage(`{}`),
	})
	if errEnv.Code != "validation" {
		t.Errorf("expected validation, got %q: %s", errEnv.Code, errEnv.Message)
	}
}
