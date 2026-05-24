package attribute_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/flow"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// setupFlow extends setupScope with the flow handler so tests can drive
// flow.set / flow_step.set as well as attribute.update.
func setupFlow(t *testing.T, schemaName string) (*api.Server, *store.Pool) {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schemaName)
	sp := store.NewPool(pool)
	echo.Register()
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	activity.Register(sp)
	flow.Register(sp)
	return api.NewServer(sp), sp
}

// flowFixture is the minimum shape every gate-5 test wants:
//
//   - one project with a status flow bound to (status, project)
//   - three value-cards Triage / Doing / Done (phases triage/active/terminal)
//   - one task already at status=Doing
//   - admin / worker / manager users + project-scoped variants for the
//     role-gating cases
//
// Tests then call addStep / dispatchUpdate to drive the flow gate.
type flowFixture struct {
	srv          *api.Server
	sp           *store.Pool
	ctx          context.Context // admin actor
	adminID      int64
	projectID    int64
	statusAttrID int64
	statusCTID   int64
	taskCTID     int64
	titleAttrID  int64

	triageID int64
	doingID  int64
	doneID   int64

	flowID int64

	taskID int64

	managerRoleID int64
	workerRoleID  int64
	adminRoleID   int64
}

// makeFlowFixture wires everything up. The fixture deliberately uses
// raw INSERTs for cards/values so it doesn't depend on card.insert
// honouring required attributes — Gate 6 lands required-on-insert; we
// don't need it here. Bypassing the handler is fine because the gate
// under test is attribute.update.validate, not card.insert.
func makeFlowFixture(t *testing.T, srv *api.Server, sp *store.Pool) *flowFixture {
	t.Helper()
	ctx := context.Background()

	var adminUID int64
	if err := sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ('flow-attr-admin') RETURNING id`).Scan(&adminUID); err != nil {
		t.Fatalf("admin user: %v", err)
	}
	if _, err := sp.P.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name = 'admin'
	`, adminUID); err != nil {
		t.Fatalf("admin grant: %v", err)
	}
	adminCtx := auth.WithUser(ctx, &auth.UserCtx{ID: adminUID, DisplayName: "flow-attr-admin"})

	var statusAttrID, statusCTID, projectCTID, taskCTID, titleAttrID int64
	if err := sp.P.QueryRow(ctx, `SELECT id FROM attribute_def WHERE name = 'status'`).Scan(&statusAttrID); err != nil {
		t.Fatalf("attribute_def.status: %v", err)
	}
	if err := sp.P.QueryRow(ctx, `SELECT id FROM card_type WHERE name = 'status'`).Scan(&statusCTID); err != nil {
		t.Fatalf("card_type.status: %v", err)
	}
	if err := sp.P.QueryRow(ctx, `SELECT id FROM card_type WHERE name = 'project'`).Scan(&projectCTID); err != nil {
		t.Fatalf("card_type.project: %v", err)
	}
	if err := sp.P.QueryRow(ctx, `SELECT id FROM card_type WHERE name = 'task'`).Scan(&taskCTID); err != nil {
		t.Fatalf("card_type.task: %v", err)
	}
	if err := sp.P.QueryRow(ctx, `SELECT id FROM attribute_def WHERE name = 'title'`).Scan(&titleAttrID); err != nil {
		t.Fatalf("attribute_def.title: %v", err)
	}

	// Project card.
	var projectID int64
	if err := sp.P.QueryRow(ctx, `
		INSERT INTO card (card_type_id, phase) VALUES ($1, 'triage') RETURNING id
	`, projectCTID).Scan(&projectID); err != nil {
		t.Fatalf("project card: %v", err)
	}

	// Value cards (Triage/Doing/Done) with phase + title.
	mkStatus := func(label, phase string) int64 {
		var id int64
		if err := sp.P.QueryRow(ctx, `
			INSERT INTO card (card_type_id, parent_card_id, phase) VALUES ($1, $2, $3) RETURNING id
		`, statusCTID, projectID, phase).Scan(&id); err != nil {
			t.Fatalf("status %s: %v", label, err)
		}
		if _, err := sp.P.Exec(ctx, `
			INSERT INTO attribute_value (card_id, attribute_def_id, value) VALUES ($1, $2, to_jsonb($3::text))
		`, id, titleAttrID, label); err != nil {
			t.Fatalf("status title %s: %v", label, err)
		}
		return id
	}
	triageID := mkStatus("Triage", "triage")
	doingID := mkStatus("Doing", "active")
	doneID := mkStatus("Done", "terminal")

	// Resolve role ids.
	var managerRoleID, workerRoleID, adminRoleID int64
	if err := sp.P.QueryRow(ctx, `SELECT id FROM role WHERE name='manager'`).Scan(&managerRoleID); err != nil {
		t.Fatalf("role.manager: %v", err)
	}
	if err := sp.P.QueryRow(ctx, `SELECT id FROM role WHERE name='worker'`).Scan(&workerRoleID); err != nil {
		t.Fatalf("role.worker: %v", err)
	}
	if err := sp.P.QueryRow(ctx, `SELECT id FROM role WHERE name='admin'`).Scan(&adminRoleID); err != nil {
		t.Fatalf("role.admin: %v", err)
	}

	// Task with status=Doing already set.
	var taskID int64
	if err := sp.P.QueryRow(ctx, `
		INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id
	`, taskCTID, projectID).Scan(&taskID); err != nil {
		t.Fatalf("task: %v", err)
	}
	if _, err := sp.P.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value) VALUES ($1, $2, to_jsonb($3::text))
	`, taskID, titleAttrID, "T"); err != nil {
		t.Fatalf("task title: %v", err)
	}
	if _, err := sp.P.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value) VALUES ($1, $2, to_jsonb($3::bigint))
	`, taskID, statusAttrID, doingID); err != nil {
		t.Fatalf("task status: %v", err)
	}

	// Flow on (status, project).
	flowID := int64(0)
	if err := sp.P.QueryRow(ctx, `
		INSERT INTO flow (name, attribute_def_id, scope_card_id) VALUES ('Standard task', $1, $2) RETURNING id
	`, statusAttrID, projectID).Scan(&flowID); err != nil {
		t.Fatalf("flow: %v", err)
	}

	return &flowFixture{
		srv:           srv,
		sp:            sp,
		ctx:           adminCtx,
		adminID:       adminUID,
		projectID:     projectID,
		statusAttrID:  statusAttrID,
		statusCTID:    statusCTID,
		taskCTID:      taskCTID,
		titleAttrID:   titleAttrID,
		triageID:      triageID,
		doingID:       doingID,
		doneID:        doneID,
		flowID:        flowID,
		taskID:        taskID,
		managerRoleID: managerRoleID,
		workerRoleID:  workerRoleID,
		adminRoleID:   adminRoleID,
	}
}

// addStep inserts one flow_step row directly (bypassing the handler so
// we don't need to drive the admin user through every test).
// requiresRoleID = 0 means no role gate.
func (f *flowFixture) addStep(t *testing.T, fromID, toID int64, label string, requiresRoleID int64) int64 {
	t.Helper()
	var stepID int64
	var role *int64
	if requiresRoleID != 0 {
		v := requiresRoleID
		role = &v
	}
	if err := f.sp.P.QueryRow(context.Background(), `
		INSERT INTO flow_step (flow_id, from_card_id, to_card_id, label, requires_role_id, sort_order)
		VALUES ($1, $2, $3, $4, $5, 0) RETURNING id
	`, f.flowID, fromID, toID, label, role).Scan(&stepID); err != nil {
		t.Fatalf("addStep %s: %v", label, err)
	}
	return stepID
}

// addUserWithRole creates a fresh user_account and attaches roleID
// (scoped to scopeID — pass 0 for a global grant). Returns the user
// id and an actor ctx for that user.
func (f *flowFixture) addUserWithRole(t *testing.T, name string, roleID, scopeID int64) (int64, context.Context) {
	t.Helper()
	ctx := context.Background()
	var uid int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, name).Scan(&uid); err != nil {
		t.Fatalf("user %s: %v", name, err)
	}
	if scopeID == 0 {
		if _, err := f.sp.P.Exec(ctx,
			`INSERT INTO user_role (user_id, role_id, scope_card_id) VALUES ($1, $2, NULL)`, uid, roleID); err != nil {
			t.Fatalf("user_role %s: %v", name, err)
		}
	} else {
		if _, err := f.sp.P.Exec(ctx,
			`INSERT INTO user_role (user_id, role_id, scope_card_id) VALUES ($1, $2, $3)`, uid, roleID, scopeID); err != nil {
			t.Fatalf("user_role %s: %v", name, err)
		}
	}
	return uid, auth.WithUser(ctx, &auth.UserCtx{ID: uid, DisplayName: name})
}

// updateStatus drives one attribute.update on (taskID, status) =
// newStatusID and returns the SubResponse. The role_grant gate
// for card.update on task is open to worker/manager/admin (seeded
// in seed.hcsv).
func (f *flowFixture) updateStatus(actorCtx context.Context, taskID, newStatusID int64) api.SubResponse {
	resp := f.srv.Dispatch(actorCtx, api.BatchRequest{Subrequests: []api.SubRequest{{
		ID:       "u",
		Endpoint: "attribute",
		Action:   "update",
		Data: json.RawMessage(fmt.Sprintf(`{"card_id":"%d","attribute_name":"status","value":"%d"}`,
			taskID, newStatusID)),
	}}})
	return resp.Subresponses[0]
}

// TestFlow_NoFlow: with no flow row for (status, project), attribute.update
// goes through unchanged — Gate 5 must be a no-op when no flow applies.
// This is the regression test the spec calls for.
func TestFlow_NoFlow(t *testing.T) {
	srv, sp := setupFlow(t, "kitp_test_flow_nogate")
	// Build a minimal fixture without a flow row.
	ctx := context.Background()
	var statusAttrID, statusCTID, projectCTID, taskCTID, titleAttrID int64
	for _, kv := range []struct {
		q   string
		out *int64
	}{
		{`SELECT id FROM attribute_def WHERE name='status'`, &statusAttrID},
		{`SELECT id FROM card_type WHERE name='status'`, &statusCTID},
		{`SELECT id FROM card_type WHERE name='project'`, &projectCTID},
		{`SELECT id FROM card_type WHERE name='task'`, &taskCTID},
		{`SELECT id FROM attribute_def WHERE name='title'`, &titleAttrID},
	} {
		if err := sp.P.QueryRow(ctx, kv.q).Scan(kv.out); err != nil {
			t.Fatalf("%s: %v", kv.q, err)
		}
	}

	// Project + two statuses + task with status=Triage.
	var pid, triage, doing, taskID int64
	if err := sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id, phase) VALUES ($1, 'triage') RETURNING id`,
		projectCTID).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	for _, kv := range []struct {
		out   *int64
		phase string
	}{{&triage, "triage"}, {&doing, "active"}} {
		if err := sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id, parent_card_id, phase) VALUES ($1, $2, $3) RETURNING id`,
			statusCTID, pid, kv.phase).Scan(kv.out); err != nil {
			t.Fatal(err)
		}
	}
	if err := sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id`,
		taskCTID, pid).Scan(&taskID); err != nil {
		t.Fatal(err)
	}
	if _, err := sp.P.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value) VALUES
			($1, $2, to_jsonb($3::text)),
			($1, $4, to_jsonb($5::bigint))
	`, taskID, titleAttrID, "T", statusAttrID, triage); err != nil {
		t.Fatal(err)
	}

	systemCtx := auth.WithSystemUser(ctx)
	resp := srv.Dispatch(systemCtx, api.BatchRequest{Subrequests: []api.SubRequest{{
		ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","attribute_name":"status","value":"%d"}`, taskID, doing)),
	}}})
	sr := resp.Subresponses[0]
	if !sr.OK {
		t.Fatalf("expected OK without flow row; got %+v", sr.Error)
	}
}

// TestFlow_DisallowedTransition_StructuredEnvelope: with a flow row
// and one step (Doing→Done) but no step for Doing→Triage, attempting
// Doing→Triage rejects with code 'flow_disallowed' and a structured
// Detail payload matching V13.
func TestFlow_DisallowedTransition_StructuredEnvelope(t *testing.T) {
	srv, sp := setupFlow(t, "kitp_test_flow_disallowed")
	f := makeFlowFixture(t, srv, sp)
	f.addStep(t, f.doingID, f.doneID, "Complete", 0)

	systemCtx := auth.WithSystemUser(context.Background())
	sr := f.updateStatus(systemCtx, f.taskID, f.triageID)
	if sr.OK {
		t.Fatalf("expected flow_disallowed; got OK")
	}
	if sr.Error == nil || sr.Error.Code != "flow_disallowed" {
		t.Fatalf("expected flow_disallowed; got %+v", sr.Error)
	}
	// Confirm the structured envelope round-trips through JSON.
	buf, err := json.Marshal(sr.Error)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	t.Logf("rejection envelope: %s", string(buf))
	var env struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Detail  struct {
			From struct {
				ID    string `json:"id"`
				Label string `json:"label"`
				Phase string `json:"phase"`
			} `json:"from"`
			AttemptedTo struct {
				ID    string `json:"id"`
				Label string `json:"label"`
				Phase string `json:"phase"`
			} `json:"attempted_to"`
			Available []struct {
				StepID string `json:"step_id"`
				To     struct {
					ID    string `json:"id"`
					Label string `json:"label"`
					Phase string `json:"phase"`
				} `json:"to"`
				Label          string  `json:"label"`
				YourRoleAllows bool    `json:"your_role_allows"`
				RequiresRole   *string `json:"requires_role"`
			} `json:"available"`
		} `json:"detail"`
	}
	if err := json.Unmarshal(buf, &env); err != nil {
		t.Fatalf("decode: %v", err)
	}

	// Expected: from is Doing (active), attempted_to is Triage (triage).
	if env.Detail.From.ID != fmt.Sprintf("%d", f.doingID) {
		t.Errorf("from.id = %q, want %d", env.Detail.From.ID, f.doingID)
	}
	if env.Detail.From.Label != "Doing" {
		t.Errorf("from.label = %q, want Doing", env.Detail.From.Label)
	}
	if env.Detail.From.Phase != "active" {
		t.Errorf("from.phase = %q, want active", env.Detail.From.Phase)
	}
	if env.Detail.AttemptedTo.ID != fmt.Sprintf("%d", f.triageID) {
		t.Errorf("attempted_to.id = %q, want %d", env.Detail.AttemptedTo.ID, f.triageID)
	}
	if env.Detail.AttemptedTo.Label != "Triage" {
		t.Errorf("attempted_to.label = %q, want Triage", env.Detail.AttemptedTo.Label)
	}
	if env.Detail.AttemptedTo.Phase != "triage" {
		t.Errorf("attempted_to.phase = %q, want triage", env.Detail.AttemptedTo.Phase)
	}

	// available[] should include Doing→Done (Complete) with allowed=true.
	if len(env.Detail.Available) != 1 {
		t.Fatalf("expected 1 available transition, got %d: %+v", len(env.Detail.Available), env.Detail.Available)
	}
	av := env.Detail.Available[0]
	if av.To.ID != fmt.Sprintf("%d", f.doneID) {
		t.Errorf("available[0].to.id = %q, want %d", av.To.ID, f.doneID)
	}
	if av.Label != "Complete" {
		t.Errorf("available[0].label = %q, want Complete", av.Label)
	}
	if !av.YourRoleAllows {
		t.Errorf("available[0].your_role_allows = false, want true (no role gate; system actor)")
	}
	if av.RequiresRole != nil {
		t.Errorf("available[0].requires_role = %v, want nil", av.RequiresRole)
	}
}

// TestFlow_AllowedTransition_GoesThrough: a write that matches an
// existing flow_step (and carries no role gate) succeeds normally.
func TestFlow_AllowedTransition_GoesThrough(t *testing.T) {
	srv, sp := setupFlow(t, "kitp_test_flow_allowed")
	f := makeFlowFixture(t, srv, sp)
	f.addStep(t, f.doingID, f.doneID, "Complete", 0)

	systemCtx := auth.WithSystemUser(context.Background())
	sr := f.updateStatus(systemCtx, f.taskID, f.doneID)
	if !sr.OK {
		t.Fatalf("expected OK; got %+v", sr.Error)
	}

	// Verify the new value landed.
	var got int64
	if err := sp.P.QueryRow(context.Background(), `
		SELECT (value)::text::bigint FROM attribute_value
		WHERE card_id = $1 AND attribute_def_id = $2
	`, f.taskID, f.statusAttrID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != f.doneID {
		t.Errorf("status = %d, want %d", got, f.doneID)
	}
}

// TestFlow_RoleGated_DeniedForWorker: flow_step Doing→Done requires
// manager. A worker actor's attribute.update rejects with code
// 'flow_role_required' and the rejection envelope's available[]
// includes the gated step flagged your_role_allows=false +
// requires_role='manager'.
func TestFlow_RoleGated_DeniedForWorker(t *testing.T) {
	srv, sp := setupFlow(t, "kitp_test_flow_role_worker")
	f := makeFlowFixture(t, srv, sp)
	f.addStep(t, f.doingID, f.doneID, "Complete", f.managerRoleID)

	_, workerCtx := f.addUserWithRole(t, "flow-worker", f.workerRoleID, 0)
	sr := f.updateStatus(workerCtx, f.taskID, f.doneID)
	if sr.OK {
		t.Fatalf("expected flow_role_required; got OK")
	}
	if sr.Error == nil || sr.Error.Code != "flow_role_required" {
		t.Fatalf("expected flow_role_required; got %+v", sr.Error)
	}
	buf, _ := json.Marshal(sr.Error)
	var env struct {
		Detail struct {
			Available []struct {
				Label          string  `json:"label"`
				YourRoleAllows bool    `json:"your_role_allows"`
				RequiresRole   *string `json:"requires_role"`
			} `json:"available"`
		} `json:"detail"`
	}
	if err := json.Unmarshal(buf, &env); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(env.Detail.Available) != 1 {
		t.Fatalf("expected 1 available, got %d: %+v", len(env.Detail.Available), env.Detail.Available)
	}
	av := env.Detail.Available[0]
	if av.Label != "Complete" {
		t.Errorf("available[0].label = %q, want Complete", av.Label)
	}
	if av.YourRoleAllows {
		t.Errorf("available[0].your_role_allows = true, want false for worker against manager-only step")
	}
	if av.RequiresRole == nil || *av.RequiresRole != "manager" {
		t.Errorf("available[0].requires_role = %v, want \"manager\"", av.RequiresRole)
	}
}

// TestFlow_RoleGated_AllowedForManager: same setup; with a manager actor
// the write goes through.
func TestFlow_RoleGated_AllowedForManager(t *testing.T) {
	srv, sp := setupFlow(t, "kitp_test_flow_role_manager")
	f := makeFlowFixture(t, srv, sp)
	f.addStep(t, f.doingID, f.doneID, "Complete", f.managerRoleID)

	_, managerCtx := f.addUserWithRole(t, "flow-manager", f.managerRoleID, 0)
	sr := f.updateStatus(managerCtx, f.taskID, f.doneID)
	if !sr.OK {
		t.Fatalf("expected OK for manager; got %+v", sr.Error)
	}
}

// TestFlow_RoleGated_AllowedForProjectScopedManager: actor holds the
// manager role scoped to the task's project. The role check accepts
// either a global (scope_card_id IS NULL) or a matching project-scoped
// grant.
func TestFlow_RoleGated_AllowedForProjectScopedManager(t *testing.T) {
	srv, sp := setupFlow(t, "kitp_test_flow_role_scoped_mgr")
	f := makeFlowFixture(t, srv, sp)
	f.addStep(t, f.doingID, f.doneID, "Complete", f.managerRoleID)

	_, scopedCtx := f.addUserWithRole(t, "flow-manager-scoped", f.managerRoleID, f.projectID)
	sr := f.updateStatus(scopedCtx, f.taskID, f.doneID)
	if !sr.OK {
		t.Fatalf("expected OK for project-scoped manager; got %+v", sr.Error)
	}
}

// TestFlow_SystemBypassesRoleGate: the seeded System User holds
// admin + manager + worker globally, so every flow_step requires_role
// resolves through one of those grants. No wildcard short-circuit
// anymore — System passes by literal role match.
func TestFlow_SystemBypassesRoleGate(t *testing.T) {
	srv, sp := setupFlow(t, "kitp_test_flow_system_bypass")
	f := makeFlowFixture(t, srv, sp)
	f.addStep(t, f.doingID, f.doneID, "Complete", f.managerRoleID)

	systemCtx := auth.WithSystemUser(context.Background())
	sr := f.updateStatus(systemCtx, f.taskID, f.doneID)
	if !sr.OK {
		t.Fatalf("expected OK for system bypass; got %+v", sr.Error)
	}
}

// TestFlow_ProjectScopeIsolation: a flow scoped to project A does not
// gate writes on tasks in project B, even if the task in B holds the
// same status value-card id.
func TestFlow_ProjectScopeIsolation(t *testing.T) {
	srv, sp := setupFlow(t, "kitp_test_flow_proj_scope")
	f := makeFlowFixture(t, srv, sp)
	// Tight flow on project A: only Doing→Done.
	f.addStep(t, f.doingID, f.doneID, "Complete", 0)

	// Second project with its own task, also holding status=Doing
	// (same value-card id, but the flow is scoped to projectA).
	ctx := context.Background()
	var projB, taskB int64
	if err := sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id, phase) VALUES ($1, 'triage') RETURNING id`,
		mustQueryInt(t, sp, ctx, `SELECT id FROM card_type WHERE name='project'`)).Scan(&projB); err != nil {
		t.Fatal(err)
	}
	if err := sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id`,
		f.taskCTID, projB).Scan(&taskB); err != nil {
		t.Fatal(err)
	}
	// Note: writing the value-card id (which lives under projectA) on
	// taskB would normally fail the project-scope check. We bypass it
	// with a raw INSERT to set the seed state.
	if _, err := sp.P.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value) VALUES
			($1, $2, to_jsonb($3::text)),
			($1, $4, to_jsonb($5::bigint))
	`, taskB, f.titleAttrID, "T", f.statusAttrID, f.doingID); err != nil {
		t.Fatal(err)
	}

	// Try to set status=Triage on taskB. Because no flow is scoped to
	// projectB, the flow gate is a no-op and the write should succeed
	// at the flow layer.
	//
	// (The project-scope check on the value-card still flags the cross-
	// project ref. We exercise just the flow branch here by writing
	// taskB's status to the projectB-local triage value-card.)
	//
	// Materialise a triage value-card under projectB.
	var triageB int64
	if err := sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id, parent_card_id, phase) VALUES ($1, $2, 'triage') RETURNING id`,
		f.statusCTID, projB).Scan(&triageB); err != nil {
		t.Fatal(err)
	}
	if _, err := sp.P.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value) VALUES ($1, $2, to_jsonb($3::text))
	`, triageB, f.titleAttrID, "Triage-B"); err != nil {
		t.Fatal(err)
	}
	// Reset status on taskB to point at triageB so the project-scope
	// pre-check stays happy when we do the test write below.
	if _, err := sp.P.Exec(ctx, `
		UPDATE attribute_value SET value = to_jsonb($3::bigint)
		WHERE card_id = $1 AND attribute_def_id = $2
	`, taskB, f.statusAttrID, triageB); err != nil {
		t.Fatal(err)
	}

	// Now write any new value-card-of-status under projectB. We'll
	// stamp another status card under projectB and transition to it —
	// no flow gates this.
	var doingB int64
	if err := sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id, parent_card_id, phase) VALUES ($1, $2, 'active') RETURNING id`,
		f.statusCTID, projB).Scan(&doingB); err != nil {
		t.Fatal(err)
	}

	systemCtx := auth.WithSystemUser(ctx)
	sr := f.updateStatus(systemCtx, taskB, doingB)
	if !sr.OK {
		t.Fatalf("expected OK on taskB (no flow in projectB scope); got %+v", sr.Error)
	}
}

// TestFlow_AvailableExcludesSameSourceFromOtherCard: confirms the
// rejection envelope's available[] is filtered to transitions out of
// the card's *current* value (not every flow_step under the flow).
func TestFlow_AvailableExcludesSameSourceFromOtherCard(t *testing.T) {
	srv, sp := setupFlow(t, "kitp_test_flow_avail_filter")
	f := makeFlowFixture(t, srv, sp)
	// Steps out of Doing (the task's current value).
	f.addStep(t, f.doingID, f.doneID, "Complete", 0)
	// Step out of Triage (the task is NOT here; this step must not
	// appear in available[]).
	f.addStep(t, f.triageID, f.doingID, "Start", 0)

	systemCtx := auth.WithSystemUser(context.Background())
	sr := f.updateStatus(systemCtx, f.taskID, f.triageID) // disallowed: no Doing→Triage step
	if sr.OK {
		t.Fatalf("expected flow_disallowed; got OK")
	}
	buf, _ := json.Marshal(sr.Error)
	var env struct {
		Detail struct {
			Available []struct {
				Label string `json:"label"`
			} `json:"available"`
		} `json:"detail"`
	}
	if err := json.Unmarshal(buf, &env); err != nil {
		t.Fatal(err)
	}
	if len(env.Detail.Available) != 1 {
		t.Fatalf("expected 1 available (Doing→Done only), got %d: %+v",
			len(env.Detail.Available), env.Detail.Available)
	}
	if env.Detail.Available[0].Label != "Complete" {
		t.Errorf("available[0].label = %q, want Complete", env.Detail.Available[0].Label)
	}
}

// TestFlow_SameValueIsNoop: writing the same value the card already
// holds is a no-op for the flow gate — UPSERT still runs, lands a
// fresh activity row, but no flow_step is needed to "transition" prev
// to itself. Verifies the early-return for newID == prevID.
func TestFlow_SameValueIsNoop(t *testing.T) {
	srv, sp := setupFlow(t, "kitp_test_flow_same_value")
	f := makeFlowFixture(t, srv, sp)
	// Add only Doing→Done. Writing status=Doing (already current)
	// must NOT need a step.
	f.addStep(t, f.doingID, f.doneID, "Complete", 0)

	systemCtx := auth.WithSystemUser(context.Background())
	sr := f.updateStatus(systemCtx, f.taskID, f.doingID)
	if !sr.OK {
		t.Fatalf("expected OK on no-op write; got %+v", sr.Error)
	}
}

// mustQueryInt is a fixture-local helper for one-off scalar queries
// that should never fail.
func mustQueryInt(t *testing.T, sp *store.Pool, ctx context.Context, q string, args ...any) int64 {
	t.Helper()
	var n int64
	if err := sp.P.QueryRow(ctx, q, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
	return n
}
