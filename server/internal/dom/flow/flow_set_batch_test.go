// Direct PL/pgSQL test for flow_set_batch — Phase 3 of
// docs/UNIFIED_HANDLER_PLAN.md. Exercises the function via tx.Query so
// the test stays independent of the dispatcher-driven integration
// tests in flow_test.go.
package flow_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

// resultRow mirrors the function's RETURNS TABLE shape.
type resultRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callFlowSetBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []resultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM flow_set_batch($1::bigint, $2::jsonb)
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

// flowBatchFixture captures the per-test rows the flow_*_batch tests
// share — one project card, the seeded `status` attribute_def + a
// `status` value-card (triage). Mirrors the integration fixture but
// touches the DB directly so we don't pull the dispatcher in.
type flowBatchFixture struct {
	pool         *pgxpool.Pool
	projectID    int64
	statusAttrID int64
	triageID     int64
	doingID      int64
}

func seedFlowBatchFixture(t *testing.T, pool *pgxpool.Pool) *flowBatchFixture {
	t.Helper()
	ctx := context.Background()
	var statusAttrID, statusCTID, projectCTID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM attribute_def WHERE name='status'`).Scan(&statusAttrID); err != nil {
		t.Fatalf("status attr: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT id FROM card_type WHERE name='status'`).Scan(&statusCTID); err != nil {
		t.Fatalf("status ct: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT id FROM card_type WHERE name='project'`).Scan(&projectCTID); err != nil {
		t.Fatalf("project ct: %v", err)
	}
	var projectID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO card (card_type_id, phase) VALUES ($1, 'triage') RETURNING id
	`, projectCTID).Scan(&projectID); err != nil {
		t.Fatalf("project: %v", err)
	}
	mkStatus := func(phase string) int64 {
		var id int64
		if err := pool.QueryRow(ctx, `
			INSERT INTO card (card_type_id, parent_card_id, phase) VALUES ($1, $2, $3) RETURNING id
		`, statusCTID, projectID, phase).Scan(&id); err != nil {
			t.Fatalf("status card: %v", err)
		}
		return id
	}
	return &flowBatchFixture{
		pool:         pool,
		projectID:    projectID,
		statusAttrID: statusAttrID,
		triageID:     mkStatus("triage"),
		doingID:      mkStatus("active"),
	}
}

func TestFlowSetBatch_HappyInsertAndUpdate(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_set_batch_happy")
	f := seedFlowBatchFixture(t, pool)

	rows := callFlowSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"name":                     "Standard",
			"doc":                      "primary flow",
			"attribute_def_id":         jsonInt(f.statusAttrID),
			"scope_card_id":            jsonInt(f.projectID),
			"default_create_status_id": jsonInt(f.triageID),
		},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("happy insert: %+v", rows)
	}
	var got struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.ID == "" {
		t.Fatal("missing id")
	}

	// Update by id — rename.
	rows = callFlowSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		{
			"id":               got.ID,
			"name":             "Renamed",
			"attribute_def_id": jsonInt(f.statusAttrID),
			"scope_card_id":    jsonInt(f.projectID),
		},
	})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("happy update: %+v", rows)
	}
	var name string
	if err := pool.QueryRow(context.Background(),
		`SELECT name FROM flow WHERE id = $1::bigint`, got.ID).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "Renamed" {
		t.Errorf("name=%q want Renamed", name)
	}
}

func TestFlowSetBatch_MultiRow(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_set_batch_multi")
	f := seedFlowBatchFixture(t, pool)

	// Two flows on the same attribute_def must hit the unique constraint.
	// To get two ok rows in one call we need two different attribute_defs;
	// seed a second one of card_ref type.
	var secondAttr int64
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO attribute_def (name, value_type, target_card_type_id)
		SELECT 'second_attr_for_test', 'card_ref', (SELECT id FROM card_type WHERE name='status')
		RETURNING id
	`).Scan(&secondAttr); err != nil {
		t.Fatalf("second attr: %v", err)
	}

	rows := callFlowSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		{"name": "A", "attribute_def_id": jsonInt(f.statusAttrID), "scope_card_id": jsonInt(f.projectID)},
		{"name": "B", "attribute_def_id": jsonInt(secondAttr), "scope_card_id": jsonInt(f.projectID)},
	})
	if len(rows) != 2 {
		t.Fatalf("rows: got %d, want 2", len(rows))
	}
	for i, r := range rows {
		if !r.OK {
			t.Errorf("row %d: %+v", i, r)
		}
		if r.Idx != i {
			t.Errorf("row %d: idx=%d want %d", i, r.Idx, i)
		}
	}
}

func TestFlowSetBatch_PerRowValidation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_set_batch_validation")
	f := seedFlowBatchFixture(t, pool)

	rows := callFlowSetBatch(t, pool, auth.SystemUserID, []map[string]any{
		// row 0: ok
		{"name": "OK", "attribute_def_id": jsonInt(f.statusAttrID), "scope_card_id": jsonInt(f.projectID)},
		// row 1: empty name
		{"name": "", "attribute_def_id": jsonInt(f.statusAttrID), "scope_card_id": jsonInt(f.projectID)},
		// row 2: scope_card_id points at a status card, not a project
		{"name": "X", "attribute_def_id": jsonInt(f.statusAttrID), "scope_card_id": jsonInt(f.triageID)},
	})
	if len(rows) != 3 {
		t.Fatalf("rows: got %d", len(rows))
	}
	if !rows[0].OK {
		t.Errorf("row 0 should ok: %+v", rows[0])
	}
	if rows[1].OK || rows[1].Code != "validation" {
		t.Errorf("row 1: %+v", rows[1])
	}
	if !strings.Contains(rows[1].Message, "name is required") {
		t.Errorf("row 1 msg=%q", rows[1].Message)
	}
	if rows[2].OK || rows[2].Code != "scope_not_project" {
		t.Errorf("row 2: %+v", rows[2])
	}
}

func TestFlowSetBatch_DuplicateScope(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_flow_set_batch_dup")
	f := seedFlowBatchFixture(t, pool)

	body := map[string]any{
		"name": "A", "attribute_def_id": jsonInt(f.statusAttrID), "scope_card_id": jsonInt(f.projectID),
	}
	rows := callFlowSetBatch(t, pool, auth.SystemUserID, []map[string]any{body})
	if !rows[0].OK {
		t.Fatalf("first insert: %+v", rows[0])
	}
	rows = callFlowSetBatch(t, pool, auth.SystemUserID, []map[string]any{body})
	if rows[0].OK {
		t.Fatal("second insert should refuse")
	}
	if rows[0].Code != "flow_duplicate_scope" {
		t.Errorf("code=%q want flow_duplicate_scope: %+v", rows[0].Code, rows[0])
	}
}

// jsonInt formats an int64 as a decimal string (matches the dispatcher's
// `json:",string"` wire convention for 64-bit ids).
func jsonInt(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
