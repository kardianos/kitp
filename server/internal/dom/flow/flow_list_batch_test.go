// Direct PL/pgSQL test for flow_list_batch — Phase 5 of
// docs/UNIFIED_HANDLER_PLAN.md.
package flow_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

func callFlowListBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []resultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM flow_list_batch($1::bigint, $2::jsonb)
		ORDER BY idx
	`, actorID, body)
	if err != nil {
		t.Fatalf("query: %v", err)
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

// listPayload mirrors the result JSON shape so tests can read row count
// + first-row fields without dragging in the package's full ListRow
// definition (which the Go-side handler is no longer responsible for
// decoding from SQL).
type listPayload struct {
	Rows []struct {
		ID                       string `json:"id"`
		Name                     string `json:"name"`
		Doc                      string `json:"doc"`
		AttributeDefID           string `json:"attribute_def_id"`
		AttributeDefName         string `json:"attribute_def_name"`
		AttributeDefCardTypeName string `json:"attribute_def_card_type_name"`
		ScopeCardID              string `json:"scope_card_id"`
		DefaultCreateStatusID    string `json:"default_create_status_id"`
		CreatedAt                string `json:"created_at"`
	} `json:"rows"`
}

func TestFlowListBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_list_batch_happy")
	f := seedFlowBatchFixture(t, pool)
	flowID := seedFlowRow(t, f, "Standard")

	rows := callFlowListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"scope_card_id": jsonInt(f.projectID)},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("happy: %+v", rows)
	}
	var got listPayload
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Rows) != 1 {
		t.Fatalf("got %d rows, want 1: %+v", len(got.Rows), got.Rows)
	}
	r := got.Rows[0]
	if r.Name != "Standard" {
		t.Errorf("name=%q", r.Name)
	}
	if r.AttributeDefName != "status" {
		t.Errorf("attr=%q", r.AttributeDefName)
	}
	// The governed `status` attribute_def is bound to the `task` card_type — the
	// card_type the screen lists, which the client scopes its filter bar to.
	if r.AttributeDefCardTypeName != "task" {
		t.Errorf("attr_card_type=%q want %q", r.AttributeDefCardTypeName, "task")
	}
	if r.ID != jsonInt(flowID) {
		t.Errorf("id=%q want %q", r.ID, jsonInt(flowID))
	}
}

// The card_type derivation must prefer the REQUIRED binding (the entity whose
// lifecycle the status governs) over a merely-lower card_type id. `status` is
// is_required on `task`; we add an OPTIONAL binding to `project` (a lower
// card_type id) so a naive ORDER BY ct.id would mis-pick `project`.
func TestFlowListBatch_CardTypePrefersRequiredBinding(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_list_batch_cardtype")
	f := seedFlowBatchFixture(t, pool)
	_ = seedFlowRow(t, f, "Standard")

	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO edge (card_type_id, attribute_def_id, is_required, ordering)
		SELECT (SELECT id FROM card_type WHERE name='project'), $1, false, 9
		ON CONFLICT (card_type_id, attribute_def_id) DO NOTHING
	`, f.statusAttrID); err != nil {
		t.Fatalf("optional project edge: %v", err)
	}

	rows := callFlowListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"scope_card_id": jsonInt(f.projectID)},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("list: %+v", rows)
	}
	var got listPayload
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Rows) != 1 {
		t.Fatalf("got %d rows, want 1: %+v", len(got.Rows), got.Rows)
	}
	if got.Rows[0].AttributeDefCardTypeName != "task" {
		t.Errorf("attr_card_type=%q want %q (required binding must win over lower ct.id)",
			got.Rows[0].AttributeDefCardTypeName, "task")
	}
}

func TestFlowListBatch_EmptyAndNoFilter(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_list_batch_empty")
	f := seedFlowBatchFixture(t, pool)

	// No filter, no flows → empty array (NOT null).
	// The seed template project may carry a flow; we only assert the
	// project-scoped query returns 0 rows.
	rows := callFlowListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"scope_card_id": jsonInt(f.projectID)},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("empty: %+v", rows)
	}
	var got listPayload
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Rows) != 0 {
		t.Errorf("expected 0 rows, got %d: %+v", len(got.Rows), got.Rows)
	}
}

func TestFlowListBatch_MultiInput(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_list_batch_multi")
	f := seedFlowBatchFixture(t, pool)
	_ = seedFlowRow(t, f, "A")
	// Two flows on the same (attribute_def, scope_card) collide on the
	// unique key — seed a second attribute_def of card_ref type so a
	// distinct flow can sit alongside the first under the same project.
	ctx := context.Background()
	var secondAttr int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO attribute_def (name, value_type, target_card_type_id)
		SELECT 'second_attr_list_multi', 'card_ref', (SELECT id FROM card_type WHERE name='status')
		RETURNING id
	`).Scan(&secondAttr); err != nil {
		t.Fatalf("second attr: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO flow (name, attribute_def_id, scope_card_id) VALUES ('B', $1, $2)
	`, secondAttr, f.projectID); err != nil {
		t.Fatalf("flow B: %v", err)
	}

	rows := callFlowListBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"scope_card_id": jsonInt(f.projectID)},
		{}, // no filter — global snapshot includes both rows + seed
		{"attribute_def_id": jsonInt(f.statusAttrID)},
	})
	if len(rows) != 3 {
		t.Fatalf("rows: got %d", len(rows))
	}
	for i, r := range rows {
		if !r.OK {
			t.Errorf("row %d: %+v", i, r)
		}
		if r.Idx != i {
			t.Errorf("row %d: idx=%d want %d", i, r.Idx, i)
		}
	}
	// First input: scoped to fixture project → exactly 2 rows.
	var first listPayload
	if err := json.Unmarshal(rows[0].Result, &first); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(first.Rows) != 2 {
		t.Errorf("first input got %d, want 2: %+v", len(first.Rows), first.Rows)
	}
}
