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
	var listOut2 flow.ListOutput
	dispatch(t, f, api.SubRequest{
		ID: "l2", Endpoint: "flow", Action: "list",
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

func TestFlowDeleteCascadesSteps(t *testing.T) {
	f := setup(t, "kitp_test_flow_cascade")

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

	// Verify steps exist.
	var listOut flow.StepListOutput
	dispatch(t, f, api.SubRequest{
		ID: "l1", Endpoint: "flow_step", Action: "list", Data: json.RawMessage(
			fmt.Sprintf(`{"flow_id":"%d"}`, setOut.ID)),
	}, &listOut)
	if len(listOut.Rows) != 2 {
		t.Fatalf("expected 2 steps before delete, got %d", len(listOut.Rows))
	}

	// Delete flow.
	var delOut flow.DeleteOutput
	dispatch(t, f, api.SubRequest{
		ID: "d", Endpoint: "flow", Action: "delete", Data: json.RawMessage(
			fmt.Sprintf(`{"flow_id":"%d"}`, setOut.ID)),
	}, &delOut)
	if !delOut.OK || delOut.Deleted != 1 {
		t.Errorf("delete: %+v", delOut)
	}

	// Both flow_step rows are gone.
	var n int
	if err := f.sp.P.QueryRow(context.Background(), `SELECT count(*) FROM flow_step WHERE flow_id = $1`, setOut.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("expected 0 flow_step rows after cascade, got %d", n)
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
