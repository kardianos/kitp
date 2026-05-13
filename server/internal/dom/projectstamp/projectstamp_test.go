// Tests for project.stamp (Gate 10 of FLOW_AND_SCREEN_KERNEL.md).
//
// The fixture builds a template project with:
//   - 1 status value-card ("Todo" / phase=active)
//   - 1 milestone value-card ("v1")
//   - 1 flow row scoped to the template, default_create_status pointing
//     at "Todo"
//   - 2 flow_step rows under that flow (Todo↔Todo for shape; the real
//     content doesn't matter beyond from/to remap testing)
//   - 1 screen card with flow_ref → flow id and default_filter → its
//     filter child
//   - 1 filter card with a predicate JSON referencing the status id
//
// Tests stamp the template into a new project and assert the structural
// invariants: new project exists, all children copied with new ids,
// references rewritten, no tasks copied.
package projectstamp_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/flow"
	"github.com/kitp/kitp/server/internal/dom/projectstamp"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

type fixture struct {
	srv         *api.Server
	pgPool      *pgxpool.Pool
	sp          *store.Pool
	ctx         context.Context
	adminID     int64
	templateID  int64
	statusCTID  int64
	statusID    int64 // "Todo" status under the template
	milestoneID int64
	flowID      int64
	step1ID     int64
	step2ID     int64
	screenID    int64
	filterID    int64
}

func setup(t *testing.T, schemaName string) *fixture {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schemaName)
	sp := store.NewPool(pool)
	echo.Register()
	cardtype.Register()
	card.Register(sp)
	flow.Register(sp)
	projectstamp.Register(sp)
	srv := api.NewServer(sp)

	ctx := context.Background()

	// Admin user.
	var uid int64
	if err := sp.P.QueryRow(ctx, `INSERT INTO user_account (display_name) VALUES ('stamp-admin') RETURNING id`).Scan(&uid); err != nil {
		t.Fatalf("admin user: %v", err)
	}
	if _, err := sp.P.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name = 'admin'
	`, uid); err != nil {
		t.Fatalf("admin grant: %v", err)
	}

	return &fixture{srv: srv, pgPool: pool, sp: sp, adminID: uid,
		ctx: auth.WithUser(ctx, &auth.UserCtx{ID: uid, DisplayName: "stamp-admin"})}
}

// seedTemplate builds the standard template described in the file
// header. Side-effect: populates every fixture id field.
func (f *fixture) seedTemplate(t *testing.T) {
	t.Helper()
	ctx := f.ctx

	var statusCTID, screenCTID, filterCTID, milestoneCTID, projectCTID int64
	rowQuery(t, f, `SELECT id FROM card_type WHERE name='status'`, &statusCTID)
	rowQuery(t, f, `SELECT id FROM card_type WHERE name='screen'`, &screenCTID)
	rowQuery(t, f, `SELECT id FROM card_type WHERE name='filter'`, &filterCTID)
	rowQuery(t, f, `SELECT id FROM card_type WHERE name='milestone'`, &milestoneCTID)
	rowQuery(t, f, `SELECT id FROM card_type WHERE name='project'`, &projectCTID)
	f.statusCTID = statusCTID

	var statusAttrID, titleAttrID, layoutAttrID, slugAttrID, hotkeyAttrID,
		predicateAttrID, defaultFilterAttrID, flowRefAttrID,
		isTemplateAttrID, sortOrderAttrID int64
	rowQuery(t, f, `SELECT id FROM attribute_def WHERE name='status'`, &statusAttrID)
	rowQuery(t, f, `SELECT id FROM attribute_def WHERE name='title'`, &titleAttrID)
	rowQuery(t, f, `SELECT id FROM attribute_def WHERE name='layout'`, &layoutAttrID)
	rowQuery(t, f, `SELECT id FROM attribute_def WHERE name='slug'`, &slugAttrID)
	rowQuery(t, f, `SELECT id FROM attribute_def WHERE name='hotkey'`, &hotkeyAttrID)
	rowQuery(t, f, `SELECT id FROM attribute_def WHERE name='predicate'`, &predicateAttrID)
	rowQuery(t, f, `SELECT id FROM attribute_def WHERE name='default_filter'`, &defaultFilterAttrID)
	rowQuery(t, f, `SELECT id FROM attribute_def WHERE name='flow_ref'`, &flowRefAttrID)
	rowQuery(t, f, `SELECT id FROM attribute_def WHERE name='is_template'`, &isTemplateAttrID)
	rowQuery(t, f, `SELECT id FROM attribute_def WHERE name='sort_order'`, &sortOrderAttrID)

	// Template project (skip auto-screen seed by inserting directly).
	var projectID int64
	if err := f.sp.P.QueryRow(ctx, `
		INSERT INTO card (card_type_id) VALUES ($1) RETURNING id
	`, projectCTID).Scan(&projectID); err != nil {
		t.Fatalf("project insert: %v", err)
	}
	f.templateID = projectID
	writeAV(t, f, projectID, titleAttrID, mustJSON(t, "Template"))
	writeAV(t, f, projectID, isTemplateAttrID, mustJSON(t, true))

	// Status value-card.
	var statusID int64
	if err := f.sp.P.QueryRow(ctx, `
		INSERT INTO card (card_type_id, parent_card_id, phase) VALUES ($1, $2, 'active') RETURNING id
	`, statusCTID, projectID).Scan(&statusID); err != nil {
		t.Fatalf("status insert: %v", err)
	}
	f.statusID = statusID
	writeAV(t, f, statusID, titleAttrID, mustJSON(t, "Todo"))
	writeAV(t, f, statusID, sortOrderAttrID, mustJSON(t, 1))

	// Milestone value-card.
	var milestoneID int64
	if err := f.sp.P.QueryRow(ctx, `
		INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id
	`, milestoneCTID, projectID).Scan(&milestoneID); err != nil {
		t.Fatalf("milestone insert: %v", err)
	}
	f.milestoneID = milestoneID
	writeAV(t, f, milestoneID, titleAttrID, mustJSON(t, "v1"))

	// Flow row scoped to template, default_create_status -> Todo.
	var flowID int64
	if err := f.sp.P.QueryRow(ctx, `
		INSERT INTO flow (name, attribute_def_id, scope_card_id, default_create_status_id)
		VALUES ($1, $2, $3, $4) RETURNING id
	`, "Standard", statusAttrID, projectID, statusID).Scan(&flowID); err != nil {
		t.Fatalf("flow insert: %v", err)
	}
	f.flowID = flowID

	// Two flow_step rows (Todo -> Todo, twice — content doesn't matter
	// beyond from/to remap shape).
	if err := f.sp.P.QueryRow(ctx, `
		INSERT INTO flow_step (flow_id, from_card_id, to_card_id, label, sort_order) VALUES ($1, $2, $3, 'Step1', 1) RETURNING id
	`, flowID, statusID, statusID).Scan(&f.step1ID); err != nil {
		t.Fatalf("flow_step 1: %v", err)
	}
	if err := f.sp.P.QueryRow(ctx, `
		INSERT INTO flow_step (flow_id, from_card_id, to_card_id, label, sort_order) VALUES ($1, $2, $3, 'Step2', 2) RETURNING id
	`, flowID, statusID, statusID).Scan(&f.step2ID); err != nil {
		t.Fatalf("flow_step 2: %v", err)
	}

	// Screen card with flow_ref and a child filter card.
	var screenID int64
	if err := f.sp.P.QueryRow(ctx, `
		INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id
	`, screenCTID, projectID).Scan(&screenID); err != nil {
		t.Fatalf("screen insert: %v", err)
	}
	f.screenID = screenID
	writeAV(t, f, screenID, titleAttrID, mustJSON(t, "Inbox"))
	writeAV(t, f, screenID, layoutAttrID, mustJSON(t, "list"))
	writeAV(t, f, screenID, slugAttrID, mustJSON(t, "inbox"))
	writeAV(t, f, screenID, hotkeyAttrID, mustJSON(t, "i"))
	writeAV(t, f, screenID, flowRefAttrID, mustJSON(t, flowID))

	var filterID int64
	if err := f.sp.P.QueryRow(ctx, `
		INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id
	`, filterCTID, screenID).Scan(&filterID); err != nil {
		t.Fatalf("filter insert: %v", err)
	}
	f.filterID = filterID
	writeAV(t, f, filterID, titleAttrID, mustJSON(t, "Default"))
	predicate := fmt.Sprintf(`{"attr":"status","op":"=","values":[%d]}`, statusID)
	writeAV(t, f, filterID, predicateAttrID, mustJSON(t, predicate))

	// Screen.default_filter points at the filter card.
	writeAV(t, f, screenID, defaultFilterAttrID, mustJSON(t, filterID))
}

// addTemplateTasks adds n task cards under the template so the
// "tasks_not_copied" test can verify they're excluded.
func (f *fixture) addTemplateTasks(t *testing.T, n int) []int64 {
	t.Helper()
	ctx := f.ctx
	var taskCTID, titleAttrID, statusAttrID int64
	rowQuery(t, f, `SELECT id FROM card_type WHERE name='task'`, &taskCTID)
	rowQuery(t, f, `SELECT id FROM attribute_def WHERE name='title'`, &titleAttrID)
	rowQuery(t, f, `SELECT id FROM attribute_def WHERE name='status'`, &statusAttrID)
	ids := make([]int64, n)
	for i := 0; i < n; i++ {
		var tid int64
		if err := f.sp.P.QueryRow(ctx, `
			INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id
		`, taskCTID, f.templateID).Scan(&tid); err != nil {
			t.Fatalf("task insert: %v", err)
		}
		writeAV(t, f, tid, titleAttrID, mustJSON(t, fmt.Sprintf("task %d", i)))
		writeAV(t, f, tid, statusAttrID, mustJSON(t, f.statusID))
		ids[i] = tid
	}
	return ids
}

func rowQuery(t *testing.T, f *fixture, q string, v *int64) {
	t.Helper()
	if err := f.sp.P.QueryRow(f.ctx, q).Scan(v); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
}

func writeAV(t *testing.T, f *fixture, cardID, defID int64, value json.RawMessage) {
	t.Helper()
	var actID int64
	if err := f.sp.P.QueryRow(f.ctx, `
		INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
		VALUES ($1, 'attr_update', $2, NULL, $3::jsonb, $4) RETURNING id
	`, cardID, defID, value, f.adminID).Scan(&actID); err != nil {
		t.Fatalf("activity: %v", err)
	}
	if _, err := f.sp.P.Exec(f.ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
		VALUES ($1, $2, $3::jsonb, $4)
	`, cardID, defID, value, actID); err != nil {
		t.Fatalf("attribute_value: %v", err)
	}
}

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

// stamp invokes project.stamp and returns the new project id (or fails
// the test on error). Errors during stamping fail the test loudly.
func stamp(t *testing.T, f *fixture, templateID int64, name string) projectstamp.StampOutput {
	t.Helper()
	body := json.RawMessage(fmt.Sprintf(`{"template_project_id":"%d","name":%q}`, templateID, name))
	resp := f.srv.Dispatch(f.ctx, api.BatchRequest{Subrequests: []api.SubRequest{{
		ID: "s", Endpoint: "project", Action: "stamp", Data: body,
	}}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("project.stamp: %+v", resp.Subresponses[0])
	}
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	var out projectstamp.StampOutput
	if err := json.Unmarshal(buf, &out); err != nil {
		t.Fatalf("decode stamp output: %v", err)
	}
	return out
}

// ---- tests ----

// TestStampRoundTrip is the central invariant: stamping produces a new
// project with the full structural copy + remapped references.
func TestStampRoundTrip(t *testing.T) {
	f := setup(t, "kitp_test_projectstamp_roundtrip")
	f.seedTemplate(t)

	out := stamp(t, f, f.templateID, "Stamped Project")
	if out.NewProjectID == 0 {
		t.Fatalf("new_project_id is 0")
	}
	if out.NewProjectID == f.templateID {
		t.Fatalf("new project id %d equals template id %d", out.NewProjectID, f.templateID)
	}

	// New project's title.
	var newTitle string
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT av.value #>> '{}'
		FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'title'
	`, out.NewProjectID).Scan(&newTitle); err != nil {
		t.Fatalf("new project title: %v", err)
	}
	if newTitle != "Stamped Project" {
		t.Errorf("new project title = %q, want %q", newTitle, "Stamped Project")
	}

	// Descendant counts under new project: one status, one milestone,
	// one screen, one filter (under the screen).
	for _, tc := range []struct {
		typ  string
		want int
	}{
		{"status", 1},
		{"milestone", 1},
		{"screen", 1},
		{"filter", 1},
	} {
		var n int
		if err := f.sp.P.QueryRow(f.ctx, `
			WITH RECURSIVE walk AS (
				SELECT id, card_type_id, parent_card_id FROM card WHERE parent_card_id = $1 AND deleted_at IS NULL
				UNION ALL
				SELECT c.id, c.card_type_id, c.parent_card_id
				FROM card c JOIN walk w ON w.id = c.parent_card_id
				WHERE c.deleted_at IS NULL
			)
			SELECT count(*) FROM walk w JOIN card_type ct ON ct.id = w.card_type_id WHERE ct.name = $2
		`, out.NewProjectID, tc.typ).Scan(&n); err != nil {
			t.Fatalf("count %s: %v", tc.typ, err)
		}
		if n != tc.want {
			t.Errorf("descendant count for %s = %d, want %d", tc.typ, n, tc.want)
		}
	}

	// New project's ids differ from template's.
	for _, oldID := range []int64{f.statusID, f.milestoneID, f.screenID, f.filterID} {
		var n int
		if err := f.sp.P.QueryRow(f.ctx, `
			SELECT count(*) FROM card WHERE id = $1
		`, oldID).Scan(&n); err != nil {
			t.Fatalf("template id check: %v", err)
		}
		if n == 0 {
			t.Errorf("template card %d disappeared after stamp", oldID)
		}
	}

	// Flow + flow_step remap.
	var newFlowID int64
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT id FROM flow WHERE scope_card_id = $1
	`, out.NewProjectID).Scan(&newFlowID); err != nil {
		t.Fatalf("new flow: %v", err)
	}
	if newFlowID == f.flowID {
		t.Errorf("new flow id %d equals template flow id %d", newFlowID, f.flowID)
	}

	// New flow's default_create_status_id must point at the new status.
	var newStatusID int64
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT c.id FROM card c JOIN card_type ct ON ct.id = c.card_type_id
		WHERE c.parent_card_id = $1 AND ct.name = 'status'
	`, out.NewProjectID).Scan(&newStatusID); err != nil {
		t.Fatalf("new status: %v", err)
	}
	var newDefault *int64
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT default_create_status_id FROM flow WHERE id = $1
	`, newFlowID).Scan(&newDefault); err != nil {
		t.Fatalf("new flow default: %v", err)
	}
	if newDefault == nil || *newDefault != newStatusID {
		t.Errorf("new flow default_create_status_id = %v, want %d", newDefault, newStatusID)
	}

	// flow_step from/to remap (2 steps).
	var stepCount int
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT count(*) FROM flow_step WHERE flow_id = $1
	`, newFlowID).Scan(&stepCount); err != nil {
		t.Fatalf("new flow steps: %v", err)
	}
	if stepCount != 2 {
		t.Errorf("new flow step count = %d, want 2", stepCount)
	}
	stepRows, err := f.sp.P.Query(f.ctx, `
		SELECT from_card_id, to_card_id FROM flow_step WHERE flow_id = $1
	`, newFlowID)
	if err != nil {
		t.Fatalf("step rows: %v", err)
	}
	defer stepRows.Close()
	for stepRows.Next() {
		var from, to int64
		stepRows.Scan(&from, &to)
		if from != newStatusID {
			t.Errorf("step from = %d, want %d", from, newStatusID)
		}
		if to != newStatusID {
			t.Errorf("step to = %d, want %d", to, newStatusID)
		}
	}

	// Screen's flow_ref → new flow id, default_filter → new filter id.
	var newScreenID int64
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT c.id FROM card c JOIN card_type ct ON ct.id = c.card_type_id
		WHERE c.parent_card_id = $1 AND ct.name = 'screen'
	`, out.NewProjectID).Scan(&newScreenID); err != nil {
		t.Fatalf("new screen: %v", err)
	}
	var newFlowRef int64
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT (av.value)::text::bigint FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'flow_ref'
	`, newScreenID).Scan(&newFlowRef); err != nil {
		t.Fatalf("new screen flow_ref: %v", err)
	}
	if newFlowRef != newFlowID {
		t.Errorf("new screen flow_ref = %d, want %d (new flow id)", newFlowRef, newFlowID)
	}

	var newFilterID int64
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT c.id FROM card c JOIN card_type ct ON ct.id = c.card_type_id
		WHERE c.parent_card_id = $1 AND ct.name = 'filter'
	`, newScreenID).Scan(&newFilterID); err != nil {
		t.Fatalf("new filter: %v", err)
	}
	var newDefaultFilter int64
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT (av.value)::text::bigint FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'default_filter'
	`, newScreenID).Scan(&newDefaultFilter); err != nil {
		t.Fatalf("new screen default_filter: %v", err)
	}
	if newDefaultFilter != newFilterID {
		t.Errorf("new screen default_filter = %d, want %d (new filter id)", newDefaultFilter, newFilterID)
	}

	// Filter card's predicate references the new status id (not the old).
	var newPredicate string
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT av.value #>> '{}' FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'predicate'
	`, newFilterID).Scan(&newPredicate); err != nil {
		t.Fatalf("new filter predicate: %v", err)
	}
	oldRef := fmt.Sprintf("%d", f.statusID)
	newRef := fmt.Sprintf("%d", newStatusID)
	if strings.Contains(newPredicate, oldRef) {
		t.Errorf("new predicate still references old status id %d: %s", f.statusID, newPredicate)
	}
	if !strings.Contains(newPredicate, newRef) {
		t.Errorf("new predicate doesn't reference new status id %d: %s", newStatusID, newPredicate)
	}
}

// TestStampTasksNotCopied asserts task cards under the template are
// excluded from the stamp.
func TestStampTasksNotCopied(t *testing.T) {
	f := setup(t, "kitp_test_projectstamp_tasks")
	f.seedTemplate(t)
	f.addTemplateTasks(t, 3)

	// Confirm template has 3 tasks.
	var oldTasks int
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT count(*) FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id
		WHERE c.parent_card_id = $1 AND ct.name = 'task'
	`, f.templateID).Scan(&oldTasks); err != nil {
		t.Fatalf("count old tasks: %v", err)
	}
	if oldTasks != 3 {
		t.Fatalf("template task count = %d, want 3", oldTasks)
	}

	out := stamp(t, f, f.templateID, "Stamped no-tasks")
	var newTasks int
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT count(*) FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id
		WHERE c.parent_card_id = $1 AND ct.name = 'task'
	`, out.NewProjectID).Scan(&newTasks); err != nil {
		t.Fatalf("count new tasks: %v", err)
	}
	if newTasks != 0 {
		t.Errorf("new project task count = %d, want 0", newTasks)
	}
}

// TestStampEmptyTemplate handles the V24 edge case: template with no
// flows / screens / value cards. Stamp succeeds with a warning.
func TestStampEmptyTemplate(t *testing.T) {
	f := setup(t, "kitp_test_projectstamp_empty")
	// Build a bare-bones template — just the project card and its title.
	var projectCTID, titleAttrID, isTemplateAttrID int64
	rowQuery(t, f, `SELECT id FROM card_type WHERE name='project'`, &projectCTID)
	rowQuery(t, f, `SELECT id FROM attribute_def WHERE name='title'`, &titleAttrID)
	rowQuery(t, f, `SELECT id FROM attribute_def WHERE name='is_template'`, &isTemplateAttrID)
	var projectID int64
	if err := f.sp.P.QueryRow(f.ctx, `INSERT INTO card (card_type_id) VALUES ($1) RETURNING id`, projectCTID).Scan(&projectID); err != nil {
		t.Fatalf("project insert: %v", err)
	}
	writeAV(t, f, projectID, titleAttrID, mustJSON(t, "Empty template"))
	writeAV(t, f, projectID, isTemplateAttrID, mustJSON(t, true))

	out := stamp(t, f, projectID, "From empty")
	if out.NewProjectID == 0 {
		t.Fatalf("new_project_id is 0")
	}
	if len(out.Warnings) == 0 {
		t.Errorf("expected a V24 warning on empty template; got none")
	}

	// New project has just one descendant: nothing.
	var n int
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT count(*) FROM card WHERE parent_card_id = $1
	`, out.NewProjectID).Scan(&n); err != nil {
		t.Fatalf("count children: %v", err)
	}
	if n != 0 {
		t.Errorf("new project child count = %d, want 0", n)
	}

	// Title is set.
	var title string
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT av.value #>> '{}' FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'title'
	`, out.NewProjectID).Scan(&title); err != nil {
		t.Fatalf("title: %v", err)
	}
	if title != "From empty" {
		t.Errorf("title = %q, want %q", title, "From empty")
	}
}

// TestValueCardDeleteWithFlowStepBlocker covers V8: deleting a status
// card that's referenced by a flow_step row must reject with
// value_referenced_by_flow and a structured blocked_by detail.
func TestValueCardDeleteWithFlowStepBlocker(t *testing.T) {
	f := setup(t, "kitp_test_value_card_delete_blocker")
	f.seedTemplate(t) // template has a status card referenced by 2 flow_steps

	body := json.RawMessage(fmt.Sprintf(`{"card_id":"%d"}`, f.statusID))
	resp := f.srv.Dispatch(f.ctx, api.BatchRequest{Subrequests: []api.SubRequest{{
		ID: "d", Endpoint: "card", Action: "delete", Data: body,
	}}})
	sub := resp.Subresponses[0]
	if sub.OK {
		t.Fatalf("expected delete to be rejected; got OK: %+v", sub)
	}
	if sub.Error == nil {
		t.Fatalf("missing error envelope: %+v", sub)
	}
	if sub.Error.Code != "value_referenced_by_flow" {
		t.Errorf("error code = %q, want value_referenced_by_flow", sub.Error.Code)
	}
	if sub.Error.Detail == nil {
		t.Fatalf("missing detail")
	}
	buf, _ := json.Marshal(sub.Error.Detail)
	var detail struct {
		CardID    int64                     `json:"card_id"`
		BlockedBy []map[string]any          `json:"blocked_by"`
	}
	if err := json.Unmarshal(buf, &detail); err != nil {
		t.Fatalf("decode detail: %v", err)
	}
	if detail.CardID != f.statusID {
		t.Errorf("detail.card_id = %d, want %d", detail.CardID, f.statusID)
	}
	// Two flow_steps reference the status (as from_card_id of step1 and
	// step2 — both from=to=status). Each step shows up once in the
	// blocked_by list.
	if len(detail.BlockedBy) != 2 {
		t.Errorf("blocked_by length = %d, want 2; payload: %+v", len(detail.BlockedBy), detail.BlockedBy)
	}
	// Spot-check a blocker carries the metadata the admin UI needs.
	first := detail.BlockedBy[0]
	for _, k := range []string{"flow_step_id", "flow_id", "flow_name", "role", "from_label", "to_label", "step_label"} {
		if _, ok := first[k]; !ok {
			t.Errorf("blocker missing key %q: %+v", k, first)
		}
	}

	// Confirm the card is still alive.
	var deletedAt *string
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT deleted_at::text FROM card WHERE id = $1
	`, f.statusID).Scan(&deletedAt); err != nil {
		t.Fatalf("post-reject card lookup: %v", err)
	}
	if deletedAt != nil {
		t.Errorf("card was soft-deleted despite rejection: deleted_at=%v", *deletedAt)
	}
}

// TestPredicateRemap is a focused assertion on the V25 case: a filter
// card's predicate JSON containing a card_ref id must reference the
// new status id after stamping.
func TestPredicateRemap(t *testing.T) {
	f := setup(t, "kitp_test_projectstamp_predicate")
	f.seedTemplate(t)
	out := stamp(t, f, f.templateID, "Predicate test")
	var newStatusID int64
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT c.id FROM card c JOIN card_type ct ON ct.id = c.card_type_id
		WHERE c.parent_card_id = $1 AND ct.name = 'status'
	`, out.NewProjectID).Scan(&newStatusID); err != nil {
		t.Fatalf("new status: %v", err)
	}
	var newScreenID int64
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT c.id FROM card c JOIN card_type ct ON ct.id = c.card_type_id
		WHERE c.parent_card_id = $1 AND ct.name = 'screen'
	`, out.NewProjectID).Scan(&newScreenID); err != nil {
		t.Fatalf("new screen: %v", err)
	}
	var newFilterID int64
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT c.id FROM card c JOIN card_type ct ON ct.id = c.card_type_id
		WHERE c.parent_card_id = $1 AND ct.name = 'filter'
	`, newScreenID).Scan(&newFilterID); err != nil {
		t.Fatalf("new filter: %v", err)
	}
	var predicate string
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT av.value #>> '{}' FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'predicate'
	`, newFilterID).Scan(&predicate); err != nil {
		t.Fatalf("predicate: %v", err)
	}
	// Parse the predicate JSON and assert the values array contains
	// newStatusID, not f.statusID.
	var node map[string]any
	if err := json.Unmarshal([]byte(predicate), &node); err != nil {
		t.Fatalf("predicate parse: %v (raw=%s)", err, predicate)
	}
	values, _ := node["values"].([]any)
	if len(values) != 1 {
		t.Fatalf("expected 1 value, got %d: %+v", len(values), values)
	}
	got := int64(values[0].(float64))
	if got == f.statusID {
		t.Errorf("predicate value = %d (old template status id); should be remapped", got)
	}
	if got != newStatusID {
		t.Errorf("predicate value = %d, want %d (new status id)", got, newStatusID)
	}
}

// TestStampPermissionWorker covers V26: workers cannot stamp projects.
func TestStampPermissionWorker(t *testing.T) {
	f := setup(t, "kitp_test_projectstamp_permission")
	f.seedTemplate(t)

	// Create a worker user, no manager / admin role.
	var workerID int64
	if err := f.sp.P.QueryRow(f.ctx, `INSERT INTO user_account (display_name) VALUES ('stamp-worker') RETURNING id`).Scan(&workerID); err != nil {
		t.Fatalf("worker user: %v", err)
	}
	if _, err := f.sp.P.Exec(f.ctx, `
		INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE name = 'worker'
	`, workerID); err != nil {
		t.Fatalf("worker grant: %v", err)
	}
	workerCtx := auth.WithUser(context.Background(), &auth.UserCtx{ID: workerID, DisplayName: "stamp-worker"})

	body := json.RawMessage(fmt.Sprintf(`{"template_project_id":"%d","name":"nope"}`, f.templateID))
	resp := f.srv.Dispatch(workerCtx, api.BatchRequest{Subrequests: []api.SubRequest{{
		ID: "s", Endpoint: "project", Action: "stamp", Data: body,
	}}})
	sub := resp.Subresponses[0]
	if sub.OK {
		t.Fatalf("expected worker stamp to be rejected; got OK: %+v", sub)
	}
	if sub.Error == nil || sub.Error.Code != "unauthorized" {
		t.Errorf("error = %+v, want code=unauthorized", sub.Error)
	}
}

// TestStampFromInstallSeedTemplate exercises Gate 11: the install seed
// creates a 'Standard Project Template' project (is_template=true)
// carrying 6 task-status value-cards, 3 comm-status value-cards (Gate 2
// of email_comm_spec), 7 screens (6 original + Comms from Gate 7 of
// email_comm_spec), 1 filter card ("Comms attached", child of the
// Comms screen), 2 flows (status + comm), 12+3=15 flow_steps. Stamping
// from that template should produce a fresh project with the same
// shape (independent ids).
func TestStampFromInstallSeedTemplate(t *testing.T) {
	f := setup(t, "kitp_test_projectstamp_install_seed")
	// Don't seedTemplate — use the seeded one.

	var seededTemplateID int64
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT c.id FROM card c
		JOIN attribute_value av ON av.card_id = c.id
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE ad.name = 'is_template' AND av.value = to_jsonb(TRUE)
		LIMIT 1
	`).Scan(&seededTemplateID); err != nil {
		t.Fatalf("lookup seeded template: %v", err)
	}
	if seededTemplateID == 0 {
		t.Fatal("no seeded template project found — Gate 11 should have created one")
	}

	out := stamp(t, f, seededTemplateID, "Stamped from install seed")
	if out.NewProjectID == 0 {
		t.Fatal("expected a new project id; got 0")
	}

	// Descendant counts under the new project. Nine status cards
	// (6 task statuses + 3 comm statuses from Gate 2 of
	// email_comm_spec), seven screens (6 original + the Comms screen
	// from Gate 7 of email_comm_spec), one filter ("Comms attached",
	// the child of the Comms screen — no other seeded screen carries
	// a filter card); no milestones / components / tags in the
	// install-seed template.
	type want struct {
		typ string
		n   int
	}
	for _, w := range []want{{"status", 9}, {"screen", 7}, {"milestone", 0}, {"filter", 1}} {
		var got int
		if err := f.sp.P.QueryRow(f.ctx, `
			WITH RECURSIVE walk AS (
				SELECT id, card_type_id, parent_card_id FROM card WHERE parent_card_id = $1 AND deleted_at IS NULL
				UNION ALL
				SELECT c.id, c.card_type_id, c.parent_card_id
				FROM card c JOIN walk w ON w.id = c.parent_card_id
				WHERE c.deleted_at IS NULL
			)
			SELECT count(*) FROM walk w JOIN card_type ct ON ct.id = w.card_type_id WHERE ct.name = $2
		`, out.NewProjectID, w.typ).Scan(&got); err != nil {
			t.Fatalf("count %s: %v", w.typ, err)
		}
		if got != w.n {
			t.Errorf("new project %s count = %d, want %d", w.typ, got, w.n)
		}
	}

	// Flow count: 2 (status flow + comm flow, both stamped from the
	// template). flow_step total: 12 (status) + 3 (comm) = 15.
	var flowN int
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT count(*) FROM flow WHERE scope_card_id = $1
	`, out.NewProjectID).Scan(&flowN); err != nil {
		t.Fatalf("flow count: %v", err)
	}
	if flowN != 2 {
		t.Errorf("new flow count = %d, want 2 (status + comm)", flowN)
	}

	var statusFlowID int64
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT f.id FROM flow f
		JOIN attribute_def ad ON ad.id = f.attribute_def_id
		WHERE f.scope_card_id = $1 AND ad.name = 'status'
	`, out.NewProjectID).Scan(&statusFlowID); err != nil {
		t.Fatalf("status flow lookup: %v", err)
	}
	var statusStepN int
	if err := f.sp.P.QueryRow(f.ctx,
		`SELECT count(*) FROM flow_step WHERE flow_id = $1`, statusFlowID).Scan(&statusStepN); err != nil {
		t.Fatalf("status flow_step count: %v", err)
	}
	if statusStepN != 12 {
		t.Errorf("new status flow_step count = %d, want 12", statusStepN)
	}

	// The new project is NOT marked is_template (the attribute simply
	// isn't copied, so the default false applies via attribute absence).
	var n int
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT count(*) FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'is_template'
	`, out.NewProjectID).Scan(&n); err != nil {
		t.Fatalf("is_template count: %v", err)
	}
	if n != 0 {
		t.Errorf("new project has is_template attribute rows (got %d); should not be copied", n)
	}
}

// TestStampedProjectHasCommsScreen exercises Gate 7 of email_comm_spec:
// the install-seed template carries a "Comms" screen card (slug=comms,
// layout=list, hotkey=c) with flow_ref pointing at the template's comm
// flow, default_create_status pointing at the "Open" comm status, and
// a "Comms attached" filter child carrying predicate {op:"exists",
// attr:"comms"}. Stamping the template must reproduce all of those —
// with flow_ref / default_create_status remapped to the new project's
// own comm flow + Open status card, and the predicate's `comms`
// attribute name passing through unchanged.
func TestStampedProjectHasCommsScreen(t *testing.T) {
	f := setup(t, "kitp_test_projectstamp_comms_screen")

	var seededTemplateID int64
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT c.id FROM card c
		JOIN attribute_value av ON av.card_id = c.id
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE ad.name = 'is_template' AND av.value = to_jsonb(TRUE)
		LIMIT 1
	`).Scan(&seededTemplateID); err != nil {
		t.Fatalf("lookup seeded template: %v", err)
	}

	out := stamp(t, f, seededTemplateID, "Stamped with comms screen")
	if out.NewProjectID == 0 {
		t.Fatal("expected a new project id; got 0")
	}

	// Locate the Comms screen under the new project (by slug).
	var commsScreenID int64
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT c.id
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id
		JOIN attribute_value av ON av.card_id = c.id
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE c.parent_card_id = $1
		  AND ct.name = 'screen'
		  AND ad.name = 'slug'
		  AND av.value = to_jsonb('comms'::text)
	`, out.NewProjectID).Scan(&commsScreenID); err != nil {
		t.Fatalf("locate stamped Comms screen (slug=comms): %v", err)
	}

	// Confirm the screen's layout + hotkey.
	for _, c := range []struct {
		attr string
		want string
	}{
		{"layout", "list"},
		{"hotkey", "c"},
	} {
		var got string
		if err := f.sp.P.QueryRow(f.ctx, `
			SELECT av.value #>> '{}' FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = $1 AND ad.name = $2
		`, commsScreenID, c.attr).Scan(&got); err != nil {
			t.Fatalf("comms screen %s: %v", c.attr, err)
		}
		if got != c.want {
			t.Errorf("comms screen %s = %q, want %q", c.attr, got, c.want)
		}
	}

	// Locate the new project's comm flow (by attribute_def name).
	var commFlowID int64
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT f.id FROM flow f
		JOIN attribute_def ad ON ad.id = f.attribute_def_id
		WHERE f.scope_card_id = $1 AND ad.name = 'comm_status'
	`, out.NewProjectID).Scan(&commFlowID); err != nil {
		t.Fatalf("comm flow lookup: %v", err)
	}

	// The screen's flow_ref must point at the new project's comm flow,
	// NOT the template's comm flow id.
	var flowRef int64
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT (av.value)::text::bigint FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'flow_ref'
	`, commsScreenID).Scan(&flowRef); err != nil {
		t.Fatalf("comms screen flow_ref: %v", err)
	}
	if flowRef != commFlowID {
		t.Errorf("comms screen flow_ref = %d, want %d (new comm flow id)", flowRef, commFlowID)
	}

	// Locate the new project's "Open" comm status card.
	var openStatusID int64
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT c.id
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id
		JOIN attribute_value av ON av.card_id = c.id
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE c.parent_card_id = $1
		  AND ct.name = 'status'
		  AND ad.name = 'title'
		  AND av.value = to_jsonb('Open'::text)
	`, out.NewProjectID).Scan(&openStatusID); err != nil {
		t.Fatalf("locate stamped 'Open' comm status card: %v", err)
	}

	// The screen's default_create_status must point at the new project's
	// "Open" comm status card.
	var defaultCreate int64
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT (av.value)::text::bigint FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = 'default_create_status'
	`, commsScreenID).Scan(&defaultCreate); err != nil {
		t.Fatalf("comms screen default_create_status: %v", err)
	}
	if defaultCreate != openStatusID {
		t.Errorf("comms screen default_create_status = %d, want %d (new 'Open' status id)", defaultCreate, openStatusID)
	}

	// Locate the "Comms attached" filter child under the Comms screen
	// (by predicate carrying op:'exists' on the comms attribute).
	var filterID int64
	var filterTitle string
	var predicate string
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT c.id,
		       (SELECT av.value #>> '{}' FROM attribute_value av
		        JOIN attribute_def ad ON ad.id = av.attribute_def_id
		        WHERE av.card_id = c.id AND ad.name = 'title'),
		       (SELECT av.value #>> '{}' FROM attribute_value av
		        JOIN attribute_def ad ON ad.id = av.attribute_def_id
		        WHERE av.card_id = c.id AND ad.name = 'predicate')
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id
		WHERE c.parent_card_id = $1
		  AND ct.name = 'filter'
	`, commsScreenID).Scan(&filterID, &filterTitle, &predicate); err != nil {
		t.Fatalf("locate Comms attached filter under the stamped Comms screen: %v", err)
	}
	if filterTitle != "Comms attached" {
		t.Errorf("filter title = %q, want %q", filterTitle, "Comms attached")
	}
	// Parse the predicate JSON and check op + attr.
	var pnode map[string]any
	if err := json.Unmarshal([]byte(predicate), &pnode); err != nil {
		t.Fatalf("predicate parse: %v (raw=%s)", err, predicate)
	}
	if op, _ := pnode["op"].(string); op != "exists" {
		t.Errorf("predicate op = %q, want %q (V10 spelling; is_set was dropped)", op, "exists")
	}
	if attr, _ := pnode["attr"].(string); attr != "comms" {
		t.Errorf("predicate attr = %q, want %q", attr, "comms")
	}
}

// TestStampedProjectHasCommFlow exercises Gate 2 of email_comm_spec:
// the install-seed template carries a "Standard comm flow" bound to
// the `comm_status` attribute with three open→in-progress→resolved
// transitions. Stamping must copy the comm flow + its three flow_steps
// alongside the standard task status flow, and the new comm flow's
// default_create_status_id must point at the new project's "Open" card.
func TestStampedProjectHasCommFlow(t *testing.T) {
	f := setup(t, "kitp_test_projectstamp_comm_flow")

	var seededTemplateID int64
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT c.id FROM card c
		JOIN attribute_value av ON av.card_id = c.id
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE ad.name = 'is_template' AND av.value = to_jsonb(TRUE)
		LIMIT 1
	`).Scan(&seededTemplateID); err != nil {
		t.Fatalf("lookup seeded template: %v", err)
	}

	out := stamp(t, f, seededTemplateID, "Stamped with comm flow")
	if out.NewProjectID == 0 {
		t.Fatal("expected a new project id; got 0")
	}

	// Two flows under the new project: the status flow and the comm flow.
	var flowN int
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT count(*) FROM flow WHERE scope_card_id = $1
	`, out.NewProjectID).Scan(&flowN); err != nil {
		t.Fatalf("flow count: %v", err)
	}
	if flowN != 2 {
		t.Errorf("new project flow count = %d, want 2 (status + comm)", flowN)
	}

	// Locate the comm flow by its attribute_def (comm_status).
	var commFlowID int64
	var defaultCreate *int64
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT f.id, f.default_create_status_id FROM flow f
		JOIN attribute_def ad ON ad.id = f.attribute_def_id
		WHERE f.scope_card_id = $1 AND ad.name = 'comm_status'
	`, out.NewProjectID).Scan(&commFlowID, &defaultCreate); err != nil {
		t.Fatalf("comm flow lookup (a fresh project should have a comm flow): %v", err)
	}
	if defaultCreate == nil {
		t.Fatal("comm flow default_create_status_id is NULL; want a stamped 'Open' status card id")
	}

	// The comm flow's default_create_status_id must point at the new
	// "Open" comm-status card (not the template's).
	var openID int64
	var openTitle string
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT c.id, av.value #>> '{}'
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id
		JOIN attribute_value av ON av.card_id = c.id
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE c.parent_card_id = $1
		  AND ct.name = 'status'
		  AND ad.name = 'title'
		  AND av.value = to_jsonb('Open'::text)
	`, out.NewProjectID).Scan(&openID, &openTitle); err != nil {
		t.Fatalf("locate stamped 'Open' comm status card: %v", err)
	}
	if *defaultCreate != openID {
		t.Errorf("comm flow default_create_status_id = %d, want %d (the stamped 'Open' card)", *defaultCreate, openID)
	}

	// Three flow_step rows under the stamped comm flow.
	var commStepN int
	if err := f.sp.P.QueryRow(f.ctx,
		`SELECT count(*) FROM flow_step WHERE flow_id = $1`, commFlowID).Scan(&commStepN); err != nil {
		t.Fatalf("comm flow_step count: %v", err)
	}
	if commStepN != 3 {
		t.Errorf("comm flow_step count = %d, want 3 (open→progress, progress→resolved, resolved→open)", commStepN)
	}

	// All comm flow_step from/to references resolve to status cards
	// under the stamped project (no leftover template ids).
	rows, err := f.sp.P.Query(f.ctx, `
		SELECT fs.from_card_id, fs.to_card_id, fs.label,
		       fc.parent_card_id, tc.parent_card_id
		FROM flow_step fs
		JOIN card fc ON fc.id = fs.from_card_id
		JOIN card tc ON tc.id = fs.to_card_id
		WHERE fs.flow_id = $1
		ORDER BY fs.label
	`, commFlowID)
	if err != nil {
		t.Fatalf("comm flow_step rows: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var fromID, toID, fromParent, toParent int64
		var label string
		if err := rows.Scan(&fromID, &toID, &label, &fromParent, &toParent); err != nil {
			t.Fatalf("scan flow_step: %v", err)
		}
		if fromParent != out.NewProjectID {
			t.Errorf("flow_step %q from_card parent = %d, want %d (new project)", label, fromParent, out.NewProjectID)
		}
		if toParent != out.NewProjectID {
			t.Errorf("flow_step %q to_card parent = %d, want %d (new project)", label, toParent, out.NewProjectID)
		}
	}
}
