// Direct PL/pgSQL tests for role_mapping_set_batch and
// role_mapping_delete_batch — Phase 3 of docs/UNIFIED_HANDLER_PLAN.md.
package rolemapping_test

import (
	"context"
	"encoding/json"
	"strings"
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

func callBatch(t *testing.T, pool *pgxpool.Pool, fn string, actorID int64, inputs any) []resultRow {
	t.Helper()
	body, err := json.Marshal(inputs)
	if err != nil {
		t.Fatalf("marshal inputs: %v", err)
	}
	rows, err := pool.Query(context.Background(),
		`SELECT idx, ok, code, message, result FROM `+fn+`($1::bigint, $2::jsonb) ORDER BY idx`,
		actorID, body)
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

func TestRoleMappingSetBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_role_mapping_set_happy")
	rows := callBatch(t, pool, "role_mapping_set_batch", auth.SystemUserID, []map[string]any{
		{"claim_value": "kitp.worker", "role_name": "worker"},
	})
	if !rows[0].OK {
		t.Fatalf("want ok: %+v", rows[0])
	}
	// Verify row landed.
	var name string
	if err := pool.QueryRow(context.Background(), `
		SELECT r.name FROM role_mapping rm JOIN role r ON r.id = rm.role_id
		WHERE rm.claim_value = 'kitp.worker'
	`).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "worker" {
		t.Errorf("role: got %q, want worker", name)
	}
}

func TestRoleMappingSetBatch_Upsert(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_role_mapping_set_upsert")
	// First: kitp.x -> worker.
	if r := callBatch(t, pool, "role_mapping_set_batch", auth.SystemUserID, []map[string]any{
		{"claim_value": "kitp.x", "role_name": "worker"},
	}); !r[0].OK {
		t.Fatalf("first: %+v", r[0])
	}
	// Second: kitp.x -> manager (upsert).
	if r := callBatch(t, pool, "role_mapping_set_batch", auth.SystemUserID, []map[string]any{
		{"claim_value": "kitp.x", "role_name": "manager"},
	}); !r[0].OK {
		t.Fatalf("upsert: %+v", r[0])
	}
	// Verify it changed.
	var name string
	if err := pool.QueryRow(context.Background(), `
		SELECT r.name FROM role_mapping rm JOIN role r ON r.id = rm.role_id
		WHERE rm.claim_value = 'kitp.x'
	`).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "manager" {
		t.Errorf("after upsert: got %q, want manager", name)
	}
}

func TestRoleMappingSetBatch_PerRowValidation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_role_mapping_set_validation")
	inputs := []map[string]any{
		{"claim_value": "kitp.ok", "role_name": "worker"},
		{"claim_value": "", "role_name": "worker"},      // missing claim_value
		{"claim_value": "kitp.bad", "role_name": "nope"}, // unknown role
	}
	rows := callBatch(t, pool, "role_mapping_set_batch", auth.SystemUserID, inputs)
	if !rows[0].OK {
		t.Errorf("row 0: %+v", rows[0])
	}
	if rows[1].OK || rows[1].Code != "validation" {
		t.Errorf("row 1: %+v", rows[1])
	}
	if rows[2].OK || rows[2].Code != "validation" {
		t.Errorf("row 2 unknown role: %+v", rows[2])
	}
	if !strings.Contains(rows[2].Message, "not found") {
		t.Errorf("row 2 message=%q", rows[2].Message)
	}
}

func TestRoleMappingDeleteBatch_Happy(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_role_mapping_delete_happy")
	// Seed a row.
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO role_mapping (claim_value, role_id)
		SELECT 'kitp.gone', id FROM role WHERE name = 'worker'
	`); err != nil {
		t.Fatal(err)
	}
	rows := callBatch(t, pool, "role_mapping_delete_batch", auth.SystemUserID, []map[string]any{
		{"claim_value": "kitp.gone"},
	})
	if !rows[0].OK {
		t.Fatalf("want ok: %+v", rows[0])
	}
	var got struct {
		OK      bool `json:"ok"`
		Deleted int  `json:"deleted"`
	}
	_ = json.Unmarshal(rows[0].Result, &got)
	if !got.OK || got.Deleted != 1 {
		t.Errorf("result: %+v", got)
	}
}

func TestRoleMappingDeleteBatch_IdempotentAbsent(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_role_mapping_delete_absent")
	rows := callBatch(t, pool, "role_mapping_delete_batch", auth.SystemUserID, []map[string]any{
		{"claim_value": "kitp.no-such"},
	})
	if !rows[0].OK {
		t.Fatalf("call should ok: %+v", rows[0])
	}
	var got struct {
		OK      bool `json:"ok"`
		Deleted int  `json:"deleted"`
	}
	_ = json.Unmarshal(rows[0].Result, &got)
	if got.OK || got.Deleted != 0 {
		t.Errorf("expected ok=false deleted=0, got %+v", got)
	}
}

func TestRoleMappingDeleteBatch_PerRowValidation(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_role_mapping_delete_validation")
	rows := callBatch(t, pool, "role_mapping_delete_batch", auth.SystemUserID, []map[string]any{
		{}, // missing claim_value
	})
	if rows[0].OK {
		t.Fatal("row should fail")
	}
	if rows[0].Code != "validation" {
		t.Errorf("code=%q", rows[0].Code)
	}
}

func TestRoleMappingDeleteBatch_MultiRowAccurateCounts(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_role_mapping_delete_multi")
	// Seed two rows.
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO role_mapping (claim_value, role_id)
		SELECT v, id FROM role JOIN (VALUES ('a-claim'), ('b-claim')) AS t(v) ON role.name = 'worker'
	`); err != nil {
		t.Fatal(err)
	}
	inputs := []map[string]any{
		{"claim_value": "a-claim"},
		{"claim_value": "no-such"},
		{"claim_value": "b-claim"},
	}
	rows := callBatch(t, pool, "role_mapping_delete_batch", auth.SystemUserID, inputs)
	if len(rows) != 3 {
		t.Fatalf("rows: got %d", len(rows))
	}
	expect := []int{1, 0, 1}
	for i, want := range expect {
		var got struct {
			Deleted int `json:"deleted"`
		}
		_ = json.Unmarshal(rows[i].Result, &got)
		if got.Deleted != want {
			t.Errorf("row %d: deleted=%d, want %d", i, got.Deleted, want)
		}
	}
}
