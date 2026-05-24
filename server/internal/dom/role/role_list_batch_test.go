// Direct PL/pgSQL test for role_list_batch — Phase 5 of
// docs/UNIFIED_HANDLER_PLAN.md. Calls the function over pool.Query and
// asserts per-row outputs, independent of the dispatcher-driven
// integration tests in role_test.go.
package role_test

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

type batchRow struct {
	Idx     int
	OK      bool
	Code    string
	Message string
	Result  json.RawMessage
}

func callBatch(t *testing.T, pool *pgxpool.Pool, fn string, actorID int64, inputs any) []batchRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(),
		`SELECT idx, ok, code, message, result FROM `+fn+`($1::bigint, $2::jsonb) ORDER BY idx`,
		actorID, body)
	if err != nil {
		t.Fatalf("query %s: %v", fn, err)
	}
	defer rows.Close()
	var out []batchRow
	for rows.Next() {
		var r batchRow
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

// roleRow / grant / listOut mirror the result JSON shape so tests can
// assert on parsed structs rather than raw JSON.
type listGrant struct {
	CardType string `json:"card_type"`
	Process  string `json:"process"`
}
type listRoleRow struct {
	ID     string      `json:"id"`
	Name   string      `json:"name"`
	Doc    string      `json:"doc"`
	Grants []listGrant `json:"grants"`
}
type listOut struct {
	Rows []listRoleRow `json:"rows"`
}

func TestRoleListBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_role_list_batch_happy")
	rows := callBatch(t, pool, "role_list_batch", auth.SystemUserID, []map[string]any{{}})
	if len(rows) != 1 {
		t.Fatalf("rows: got %d, want 1", len(rows))
	}
	if !rows[0].OK {
		t.Fatalf("want ok=true; got %+v", rows[0])
	}
	var out listOut
	if err := json.Unmarshal(rows[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	want := []string{"viewer", "commenter", "worker", "manager", "admin"}
	got := []string{}
	for _, r := range out.Rows {
		got = append(got, r.Name)
	}
	for _, w := range want {
		if !slices.Contains(got, w) {
			t.Errorf("missing role %q in %v", w, got)
		}
	}
	// Worker should carry at least one (task, card.update) grant.
	for _, r := range out.Rows {
		if r.Name != "worker" {
			continue
		}
		found := false
		for _, g := range r.Grants {
			if g.CardType == "task" && g.Process == "card.update" {
				found = true
			}
		}
		if !found {
			t.Errorf("worker missing (task, card.update) grant; got %+v", r.Grants)
		}
	}
}

func TestRoleListBatch_EmptyWhenNoRoles(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_role_list_batch_empty")
	// Strip every role + everything that FKs at it so the function
	// returns an empty array (not null) for the rows field.
	ctx := context.Background()
	for _, q := range []string{
		`DELETE FROM user_role`,
		`DELETE FROM role_grant`,
		`DELETE FROM role_mapping`,
		`DELETE FROM role`,
	} {
		if _, err := pool.Exec(ctx, q); err != nil {
			t.Fatalf("seed clear (%s): %v", q, err)
		}
	}
	rows := callBatch(t, pool, "role_list_batch", auth.SystemUserID, []map[string]any{{}})
	if !rows[0].OK {
		t.Fatalf("want ok=true; got %+v", rows[0])
	}
	var out listOut
	if err := json.Unmarshal(rows[0].Result, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Rows == nil {
		t.Errorf("rows should be [] (empty array), not null")
	}
	if len(out.Rows) != 0 {
		t.Errorf("rows: got %d, want 0", len(out.Rows))
	}
}

func TestRoleListBatch_MultiInput(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_role_list_batch_multi")
	rows := callBatch(t, pool, "role_list_batch", auth.SystemUserID,
		[]map[string]any{{}, {}, {}})
	if len(rows) != 3 {
		t.Fatalf("rows: got %d, want 3", len(rows))
	}
	for i, r := range rows {
		if !r.OK {
			t.Errorf("row %d: ok=false code=%q msg=%q", i, r.Code, r.Message)
		}
	}
	// Every result row carries the same snapshot.
	var a, b listOut
	_ = json.Unmarshal(rows[0].Result, &a)
	_ = json.Unmarshal(rows[2].Result, &b)
	if len(a.Rows) != len(b.Rows) {
		t.Errorf("row counts differ: %d vs %d", len(a.Rows), len(b.Rows))
	}
}
