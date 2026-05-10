package workflowdef_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/gate"
	"github.com/kitp/kitp/server/internal/dom/workflowdef"
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
	workflowdef.Register(sp)
	gate.Register(sp)
	return api.NewServer(sp), sp
}

func mustOK(t *testing.T, sr api.SubResponse) {
	t.Helper()
	if !sr.OK {
		t.Fatalf("sub %s failed: %+v", sr.ID, sr.Error)
	}
}

func insertCard(t *testing.T, srv *api.Server, ctx context.Context, in card.InsertInput) int64 {
	t.Helper()
	data, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	resp := srv.Dispatch(ctx, api.BatchRequest{
		Subrequests: []api.SubRequest{
			{ID: "ins", Endpoint: "card", Action: "insert", Data: data},
		},
	})
	mustOK(t, resp.Subresponses[0])
	buf, err := json.Marshal(resp.Subresponses[0].Data)
	if err != nil {
		t.Fatal(err)
	}
	var out card.InsertOutput
	if err := json.Unmarshal(buf, &out); err != nil {
		t.Fatal(err)
	}
	return out.ID
}

// TestClassifySpawnsGates is the end-to-end check that classifying a task
// also materialises the workflow's gate sub-cards in the same tx (the
// classify→spawn gap that 0030 unblocked authz for and that workflowdef
// wires together inline via gate.SpawnFor).
func TestClassifySpawnsGates(t *testing.T) {
	srv, sp := setup(t, "kitp_test_classify_spawn")
	ctx := auth.WithSystemUser(context.Background())

	// 1. Project.
	projectID := insertCard(t, srv, ctx, card.InsertInput{
		CardTypeName: "project",
		Title:        "Acme",
	})

	// 2. workflow_def under the project, with states + initial_state.
	states, _ := json.Marshal(`["todo","done"]`)
	initial, _ := json.Marshal("todo")
	wfID := insertCard(t, srv, ctx, card.InsertInput{
		CardTypeName: "workflow_def",
		ParentCardID: &projectID,
		Title:        "Release",
		Attributes: map[string]json.RawMessage{
			"states":        states,
			"initial_state": initial,
		},
	})

	// 3. Two gate_template children under the workflow_def.
	signoffKind, _ := json.Marshal("signoff")
	required, _ := json.Marshal(`["done"]`)
	gateTplA := insertCard(t, srv, ctx, card.InsertInput{
		CardTypeName: "gate_template",
		ParentCardID: &wfID,
		Title:        "QA signoff",
		Attributes: map[string]json.RawMessage{
			"gate_kind":          signoffKind,
			"required_in_states": required,
		},
	})
	gateTplB := insertCard(t, srv, ctx, card.InsertInput{
		CardTypeName: "gate_template",
		ParentCardID: &wfID,
		Title:        "PM signoff",
		Attributes: map[string]json.RawMessage{
			"gate_kind":          signoffKind,
			"required_in_states": required,
		},
	})

	// 4. Task under the project.
	taskID := insertCard(t, srv, ctx, card.InsertInput{
		CardTypeName: "task",
		ParentCardID: &projectID,
		Title:        "Ship v1",
	})

	// 5. Classify the task with the workflow.
	classifyData, _ := json.Marshal(workflowdef.ClassifyInput{
		CardID:        taskID,
		WorkflowDefID: wfID,
	})
	resp := srv.Dispatch(ctx, api.BatchRequest{
		Subrequests: []api.SubRequest{
			{ID: "cls", Endpoint: "card", Action: "classify", Data: classifyData},
		},
	})
	mustOK(t, resp.Subresponses[0])

	// 6. Two runtime gate cards now live under the task, one per template,
	// each with gate_template_ref pointing at its source.
	var n int
	if err := sp.P.QueryRow(ctx, `
		SELECT count(*) FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id
		WHERE c.parent_card_id = $1 AND ct.name = 'gate' AND c.deleted_at IS NULL
	`, taskID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("expected 2 gate sub-cards under task, got %d", n)
	}

	gotRefs := map[int64]bool{}
	rows, err := sp.P.Query(ctx, `
		SELECT (av.value)::text::bigint
		FROM card g
		JOIN card_type ct ON ct.id = g.card_type_id
		JOIN attribute_value av ON av.card_id = g.id
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE g.parent_card_id = $1 AND ct.name = 'gate' AND g.deleted_at IS NULL
		  AND ad.name = 'gate_template_ref'
	`, taskID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var ref int64
		if err := rows.Scan(&ref); err != nil {
			t.Fatal(err)
		}
		gotRefs[ref] = true
	}
	rows.Close()
	if !gotRefs[gateTplA] || !gotRefs[gateTplB] {
		t.Fatalf("expected gate_template_ref for both templates (%d, %d), got %v",
			gateTplA, gateTplB, gotRefs)
	}

	// 7. Re-classify is idempotent: gate count stays at 2.
	resp = srv.Dispatch(ctx, api.BatchRequest{
		Subrequests: []api.SubRequest{
			{ID: "cls2", Endpoint: "card", Action: "classify", Data: classifyData},
		},
	})
	mustOK(t, resp.Subresponses[0])
	if err := sp.P.QueryRow(ctx, `
		SELECT count(*) FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id
		WHERE c.parent_card_id = $1 AND ct.name = 'gate' AND c.deleted_at IS NULL
	`, taskID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("reclassify duplicated gates: now %d", n)
	}
}
