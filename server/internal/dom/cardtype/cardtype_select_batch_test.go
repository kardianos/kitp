// Direct PL/pgSQL test for card_type_select_batch — Phase 5 of
// docs/UNIFIED_HANDLER_PLAN.md.
package cardtype_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

type resultRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callCardTypeSelectBatch(t *testing.T, pool *pgxpool.Pool, actorID int64, inputs any) []resultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(), `
		SELECT idx, ok, code, message, result
		FROM card_type_select_batch($1::bigint, $2::jsonb)
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

type ctPayload struct {
	Rows []struct {
		ID                string  `json:"id"`
		Name              string  `json:"name"`
		ParentCardTypeID  *string `json:"parent_card_type_id"`
		AllowSelfParent   bool    `json:"allow_self_parent"`
		IsBuiltIn         bool    `json:"is_built_in"`
		UsesPhase         bool    `json:"uses_phase"`
	} `json:"rows"`
}

func TestCardTypeSelectBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_type_select_batch_happy")

	rows := callCardTypeSelectBatch(t, pool, auth.SystemUserID, []map[string]any{{}})
	if len(rows) != 1 || !rows[0].OK {
		t.Fatalf("happy: %+v", rows)
	}
	var got ctPayload
	if err := json.Unmarshal(rows[0].Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Rows) == 0 {
		t.Fatalf("expected at least one card_type row")
	}
	// Sanity: 'project' must be present, and is_built_in must be true. uses_phase
	// distinguishes flow-bound value types (status) from the rest (project) — the
	// signal the Manage Values screen reads to show a per-value phase control.
	var sawProject, sawStatus bool
	for _, r := range got.Rows {
		if r.Name == "project" {
			sawProject = true
			if !r.IsBuiltIn {
				t.Errorf("project is_built_in=false; expected true")
			}
			if r.UsesPhase {
				t.Errorf("project uses_phase=true; expected false")
			}
		}
		if r.Name == "status" {
			sawStatus = true
			if !r.UsesPhase {
				t.Errorf("status uses_phase=false; expected true (flow-bound value type)")
			}
		}
	}
	if !sawProject {
		t.Errorf("'project' card_type missing from snapshot")
	}
	if !sawStatus {
		t.Errorf("'status' card_type missing from snapshot")
	}
}

func TestCardTypeSelectBatch_EmptyInputArray(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_type_select_batch_empty")

	// Empty inputs array → zero result rows. The function FOR loop
	// iterates over jsonb_array_elements; an empty array yields no
	// iterations.
	rows := callCardTypeSelectBatch(t, pool, auth.SystemUserID, []map[string]any{})
	if len(rows) != 0 {
		t.Errorf("expected 0 result rows for empty input, got %d", len(rows))
	}
}

func TestCardTypeSelectBatch_MultiInput(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_card_type_select_batch_multi")

	rows := callCardTypeSelectBatch(t, pool, auth.SystemUserID, []map[string]any{{}, {}, {}})
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}
	// Every input gets the same snapshot.
	var first ctPayload
	if err := json.Unmarshal(rows[0].Result, &first); err != nil {
		t.Fatalf("unmarshal 0: %v", err)
	}
	for i, r := range rows {
		if !r.OK {
			t.Errorf("row %d: %+v", i, r)
		}
		if r.Idx != i {
			t.Errorf("row %d: idx=%d want %d", i, r.Idx, i)
		}
		var got ctPayload
		if err := json.Unmarshal(r.Result, &got); err != nil {
			t.Fatalf("unmarshal %d: %v", i, err)
		}
		if len(got.Rows) != len(first.Rows) {
			t.Errorf("row %d count diff: %d vs %d", i, len(got.Rows), len(first.Rows))
		}
	}
}
